/**
 * CodePilot LLM — Anthropic Messages API adapter.
 *
 * Independently written client for the public Anthropic Messages wire
 * protocol:
 *
 *   POST {baseUrl}/v1/messages   (SSE stream, `stream: true`)
 *   Headers: x-api-key, anthropic-version: 2023-06-01
 *
 * Streaming semantics:
 *   Event lines `event: <type>` + `data: <json>`:
 *     content_block_start  (content_block.type "text" | "thinking" |
 *                           "tool_use" with id+name)
 *     content_block_delta  (delta.type "text_delta" | "thinking_delta" |
 *                           "input_json_delta" — partial_json accumulates)
 *     content_block_stop
 *     message_delta        (stop_reason; usage.output_tokens cumulative)
 *     message_start        (usage.input_tokens)
 *     message_stop
 *   Tool calls are assembled from input_json_delta fragments and flushed at
 *   content_block_stop. Tool results ride back as user messages with
 *   tool_result blocks (translated in toAnthropicMessages).
 */

import type { AgentMessage, AgentTool } from "../types.js";
import {
  LlmError,
  type LlmProvider,
  type LlmRequest,
  type LlmStreamEvent,
} from "./types.js";

export interface AnthropicLlmOptions {
  apiKey: string;
  baseUrl?: string;
  /** Anthropic API version header (public default). */
  version?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com";

interface WireEvent {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { output_tokens?: number; input_tokens?: number };
  error?: { message?: string };
}

export function toAnthropicMessages(messages: AgentMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (msg.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = [];
      for (const b of msg.content) {
        if (b.type === "text") blocks.push({ type: "text", text: b.text });
        else if (b.type === "tool_use") {
          blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
        }
      }
      if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
      continue;
    }
    // user: text + tool_result blocks (tool_result blocks are top-level user content)
    const blocks: Array<Record<string, unknown>> = [];
    for (const b of msg.content) {
      if (b.type === "text") blocks.push({ type: "text", text: b.text });
      else if (b.type === "tool_result") {
        blocks.push({
          type: "tool_result",
          tool_use_id: b.tool_use_id,
          content: b.content,
          ...(b.is_error ? { is_error: true } : {}),
        });
      }
    }
    if (blocks.length > 0) out.push({ role: "user", content: blocks });
  }
  return out;
}

export class AnthropicLlmProvider implements LlmProvider {
  readonly id = "anthropic";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly version: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: AnthropicLlmOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? ANTHROPIC_DEFAULT_BASE).replace(/\/+$/, "");
    this.version = options.version ?? "2023-06-01";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 180_000;
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const tools = request.tools ?? [];
    const body: Record<string, unknown> = {
      model: request.modelId,
      max_tokens: request.maxTokens ?? 8_192,
      stream: true,
      messages: toAnthropicMessages(request.messages),
      ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(tools.length > 0
        ? {
            tools: tools.map((tool: AgentTool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema,
            })),
          }
        : {}),
    };

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) controller.abort();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": this.version,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      cleanup();
      if (request.signal?.aborted) {
        yield { type: "finish", reason: "aborted" };
        return;
      }
      throw new LlmError(this.id, `request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!response.ok || !response.body) {
      cleanup();
      const detail = await response.text().catch(() => "");
      throw new LlmError(this.id, `messages failed ${response.status}: ${detail.slice(0, 300)}`, {
        status: response.status,
      });
    }

    // Tool-call assembly state.
    const openTools = new Map<number, { id: string; name: string; json: string }>();
    let inputTokens = 0;
    let outputTokens = 0;
    let abortRequested = false;
    let finishReason: "complete" | "aborted" | "error" = "complete";

    function cleanup(): void {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
    }

    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sseDone = false;

      while (!sseDone) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE records: event:<name>\n data:<json>
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) >= 0) {
          const record = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const dataLine = record
            .split("\n")
            .find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const payload = dataLine.slice(5).trim();
          if (payload.length === 0 || payload === "[DONE]") continue;
          let evt: WireEvent;
          try {
            evt = JSON.parse(payload) as WireEvent;
          } catch {
            continue;
          }
          switch (evt.type) {
            case "message_start":
              inputTokens = evt.message?.usage?.input_tokens ?? inputTokens;
              break;
            case "content_block_start":
              if (evt.content_block?.type === "tool_use" && evt.content_block.id) {
                openTools.set(evt.index ?? openTools.size, {
                  id: evt.content_block.id,
                  name: evt.content_block.name ?? "",
                  json: "",
                });
              }
              break;
            case "content_block_delta":
              if (evt.delta?.type === "text_delta" && evt.delta.text) {
                yield { type: "text-delta", text: evt.delta.text };
              } else if (evt.delta?.type === "thinking_delta" && evt.delta.thinking) {
                yield { type: "reasoning-delta", text: evt.delta.thinking };
              } else if (evt.delta?.type === "input_json_delta" && evt.delta.partial_json) {
                const open = openTools.get(evt.index ?? 0);
                if (open) open.json += evt.delta.partial_json;
              }
              break;
            case "content_block_stop": {
              const open = openTools.get(evt.index ?? -1);
              if (open) {
                openTools.delete(evt.index ?? -1);
                yield {
                  type: "tool-call",
                  call: {
                    toolCallId: open.id,
                    toolName: open.name,
                    argumentsText: open.json,
                  },
                };
              }
              break;
            }
            case "message_delta":
              outputTokens = evt.usage?.output_tokens ?? outputTokens;
              if (evt.delta?.stop_reason === "max_tokens") {
                // treat as complete; the engine reports bounded truncation
                finishReason = "complete";
              }
              break;
            case "message_stop":
              sseDone = true;
              break;
            case "error":
              throw new LlmError(this.id, evt.error?.message ?? "stream error");
            case "ping":
            default:
              break;
          }
          if (sseDone) break;
        }
        if (request.signal?.aborted) {
          abortRequested = true;
          break;
        }
      }
      if (inputTokens > 0 || outputTokens > 0) {
        yield {
          type: "usage",
          usage: {
            inputTokens,
            outputTokens,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        };
      }
      yield { type: "finish", reason: abortRequested ? "aborted" : finishReason };
    } catch (err) {
      if (request.signal?.aborted) {
        yield { type: "finish", reason: "aborted" };
        return;
      }
      yield {
        type: "finish",
        reason: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      cleanup();
    }
  }
}
