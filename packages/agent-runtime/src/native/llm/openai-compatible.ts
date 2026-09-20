/**
 * CodePilot LLM — OpenAI Chat Completions adapter.
 *
 * Independently written client for the OpenAI Chat Completions wire protocol,
 * which is also spoken by OpenRouter, DeepSeek, Mistral, Groq, vLLM, LM
 * Studio and most OpenAI-compatible endpoints:
 *
 *   POST {baseUrl}/chat/completions   (SSE stream, `stream: true`)
 *
 * Streaming semantics:
 *   SSE `data:` lines carry JSON chunks: `choices[0].delta.content` (text),
 *   `.delta.reasoning_content` / `.delta.reasoning` (reasoning models),
 *   `.delta.tool_calls[]` with index-based incremental fragments
 *   (`id`, `function.name` on first sight of an index; `function.arguments`
 *   appended across chunks). `finish_reason` closes the stream; the final
 *   chunk (or `usage` when `stream_options.include_usage` is honored) maps
 *   to usage. `data: [DONE]` terminates the SSE stream.
 */

import type { AgentMessage, ImageBlock } from "../types.js";
import {
  LlmError,
  type LlmProvider,
  type LlmRequest,
  type LlmStreamEvent,
  type LlmToolCall,
} from "./types.js";

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  /** Extra headers (e.g. OpenRouter attribution). Never logged. */
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface WireToolCallFragment {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireChunk {
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: WireToolCallFragment[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
  error?: { message?: string } | string;
}

export function toOpenAiMessages(
  messages: AgentMessage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (msg.role === "assistant") {
      if (msg.content.some((b) => b.type === "image")) {
        throw new Error("image blocks are only supported in user messages");
      }
      const text = msg.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      const toolCalls = msg.content
        .filter(
          (
            b,
          ): b is {
            type: "tool_use";
            id: string;
            name: string;
            input: Record<string, unknown>;
          } => b.type === "tool_use",
        )
        .map((b) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }));
      out.push({
        role: "assistant",
        content: text.length > 0 ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    // user message: text + images as a content-part array, then tool
    // results as role:"tool". Text is always emitted before images
    // (deterministic ordering). Image parts use data URLs; fileRef-only
    // blocks are rejected loudly instead of being silently dropped.
    const textParts = msg.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text);
    const text = textParts.join("\n");
    const imageParts = msg.content
      .filter((b): b is ImageBlock => b.type === "image")
      .map((b) => {
        if (typeof b.dataBase64 !== "string" || b.dataBase64.length === 0) {
          throw new Error(
            "image block has no inline bytes (fileRef-only blocks must be resolved to bytes by the host before the provider request)",
          );
        }
        return {
          type: "image_url",
          image_url: {
            url: `data:${b.mime ?? "image/png"};base64,${b.dataBase64}`,
          },
        };
      });
    if (text.length > 0 || imageParts.length > 0) {
      out.push({
        role: "user",
        content:
          imageParts.length > 0
            ? [
                ...(text.length > 0 ? [{ type: "text", text }] : []),
                ...imageParts,
              ]
            : text,
      });
    }
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        out.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: block.content,
        });
      }
    }
  }
  return out;
}

export class OpenAiCompatibleLlmProvider implements LlmProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly headers?: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(id: string, options: OpenAiCompatibleOptions) {
    this.id = id;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.headers = options.headers;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 180_000;
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const tools = request.tools ?? [];
    const body: Record<string, unknown> = {
      model: request.modelId,
      messages: [
        ...(request.systemPrompt
          ? [{ role: "system", content: request.systemPrompt }]
          : []),
        ...toOpenAiMessages(request.messages),
      ],
      stream: true,
      ...(tools.length > 0
        ? {
            tools: tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
          }
        : {}),
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
      ...(request.maxTokens !== undefined
        ? { max_tokens: request.maxTokens }
        : {}),
    };

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) controller.abort();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          ...(this.headers ?? {}),
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
      throw new LlmError(
        this.id,
        `request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok || !response.body) {
      cleanup();
      const detail = await response.text().catch(() => "");
      throw new LlmError(
        this.id,
        `chat failed ${response.status}: ${detail.slice(0, 300)}`,
        { status: response.status },
      );
    }

    // Incremental tool-call assembly (OpenAI fragments by index).
    const pendingCalls = new Map<
      number,
      { id: string; name: string; args: string }
    >();
    let finished = false;
    let abortRequested = false;

    function cleanup(): void {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
    }

    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let usage: WireChunk["usage"] | undefined;

      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const rawLine = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (rawLine.length === 0 || !rawLine.startsWith("data:")) continue;
          const payload = rawLine.slice(5).trim();
          if (payload === "[DONE]") {
            finished = true;
            break;
          }
          let chunk: WireChunk;
          try {
            chunk = JSON.parse(payload) as WireChunk;
          } catch {
            continue;
          }
          if (chunk.error) {
            const message =
              typeof chunk.error === "string"
                ? chunk.error
                : (chunk.error.message ?? "provider error");
            throw new LlmError(this.id, message);
          }
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          if (delta?.reasoning_content) {
            yield { type: "reasoning-delta", text: delta.reasoning_content };
          } else if (delta?.reasoning) {
            yield { type: "reasoning-delta", text: delta.reasoning };
          }
          if (delta?.content) {
            yield { type: "text-delta", text: delta.content };
          }
          if (delta?.tool_calls) {
            for (const fragment of delta.tool_calls) {
              const idx = fragment.index ?? 0;
              let pending = pendingCalls.get(idx);
              if (!pending) {
                pending = {
                  id: fragment.id ?? `call_${idx}_${Date.now().toString(36)}`,
                  name: fragment.function?.name ?? "",
                  args: "",
                };
                pendingCalls.set(idx, pending);
              }
              if (fragment.id) pending.id = fragment.id;
              if (fragment.function?.name)
                pending.name += fragment.function.name;
              if (fragment.function?.arguments)
                pending.args += fragment.function.arguments;
            }
          }
          if (chunk.usage) usage = chunk.usage;
          if (choice?.finish_reason) {
            // Flush completed tool calls in index order.
            const ordered = [...pendingCalls.entries()].sort(
              (a, b) => a[0] - b[0],
            );
            for (const [, call] of ordered) {
              const toolCall: LlmToolCall = {
                toolCallId: call.id,
                toolName: call.name,
                argumentsText: call.args,
              };
              yield { type: "tool-call", call: toolCall };
            }
            pendingCalls.clear();
          }
        }
        if (request.signal?.aborted) {
          abortRequested = true;
          break;
        }
      }
      if (usage) {
        yield {
          type: "usage",
          usage: {
            inputTokens: usage.prompt_tokens ?? 0,
            outputTokens: usage.completion_tokens ?? 0,
            cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
            cacheWriteTokens: 0,
          },
        };
      }
      yield {
        type: "finish",
        reason: abortRequested ? "aborted" : "complete",
      };
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
