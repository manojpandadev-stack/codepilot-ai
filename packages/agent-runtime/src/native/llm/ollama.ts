/**
 * CodePilot LLM — Ollama adapter.
 *
 * Independently written client for Ollama's public HTTP API:
 *   POST /api/chat   — streaming chat (NDJSON lines) with native tool support
 *   GET  /api/tags   — installed models (discovery)
 *
 * Streaming semantics (Ollama ≥0.3 tool calling):
 *   Each NDJSON line is `{model, created_at, message: {...}, done, ...stats}`.
 *   Content accumulates in `message.content`; reasoning models emit
 *   `message.thinking`. Tool calls arrive as `message.tool_calls[]` entries
 *   with `{function: {name, arguments}}` where `arguments` is an OBJECT
 *   (Ollama parses args itself) — never partial, so they are forwarded whole.
 *   The final line has `done: true` plus token counts
 *   (`prompt_eval_count`/`eval_count`) → usage.
 */

import type { AgentMessage, AgentTool, ImageBlock } from "../types.js";
import {
  LlmError,
  type LlmProvider,
  type LlmRequest,
  type LlmStreamEvent,
  type LlmToolCall,
} from "./types.js";

export const OLLAMA_DEFAULT_HOST = "http://127.0.0.1:11434";

interface OllamaToolCallWire {
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

/** One NDJSON line of an Ollama `/api/chat` stream (also the test wire shape). */
export interface OllamaChatLine {
  model?: string;
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
    tool_calls?: OllamaToolCallWire[];
  };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/** Translate CodePilot wire messages into Ollama chat messages. */
export function toOllamaMessages(messages: AgentMessage[]): Array<{
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: unknown[];
  images?: string[];
}> {
  const out: Array<{
    role: "user" | "assistant" | "tool";
    content: string;
    tool_calls?: unknown[];
    images?: string[];
  }> = [];
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
        .map((b) => ({ function: { name: b.name, arguments: b.input } }));
      out.push({
        role: "assistant",
        content: text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    // user message: text blocks + tool_result blocks → role:"tool" messages.
    // Image blocks ride as Ollama `images: [base64]` on the user message.
    // Blocks carrying only a persistence `fileRef` (no inline bytes) are
    // rejected loudly — silently dropping user content is never acceptable.
    const text = msg.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const images = msg.content
      .filter((b): b is ImageBlock => b.type === "image")
      .map((b) => {
        if (typeof b.dataBase64 !== "string" || b.dataBase64.length === 0) {
          throw new Error(
            "image block has no inline bytes (fileRef-only blocks must be resolved to bytes by the host before the provider request)",
          );
        }
        return b.dataBase64;
      });
    if (text.length > 0 || images.length > 0) {
      out.push({
        role: "user",
        content: text,
        ...(images.length > 0 ? { images } : {}),
      });
    }
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        out.push({
          role: "tool",
          content: (block.is_error ? "[error] " : "") + block.content,
        });
      }
    }
  }
  return out;
}

export interface OllamaLlmOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Per-request INACTIVITY timeout in ms (default 300_000): aborts when no
   *  bytes arrive for this long. A wall-clock cap would kill healthy local
   *  generations (cold model load ≈145s plus long thinking spans stream for
   *  many minutes while making steady progress); silence is the failure
   *  signal, not duration. */
  timeoutMs?: number;
}

export class OllamaLlmProvider implements LlmProvider {
  readonly id = "ollama";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OllamaLlmOptions = {}) {
    this.baseUrl = (options.baseUrl ?? OLLAMA_DEFAULT_HOST).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 300_000;
  }

  async listInstalledModels(): Promise<Array<{ name: string; size?: number }>> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/tags`);
    if (!res.ok) {
      throw new LlmError(this.id, `tags request failed: ${res.status}`, {
        status: res.status,
      });
    }
    const body = (await res.json()) as {
      models?: Array<{ name: string; size?: number }>;
    };
    return body.models ?? [];
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const tools = request.tools ?? [];
    const body: Record<string, unknown> = {
      model: request.modelId,
      messages: [
        ...(request.systemPrompt
          ? [{ role: "system", content: request.systemPrompt }]
          : []),
        ...toOllamaMessages(request.messages),
      ],
      stream: true,
      ...(tools.length > 0 ? { tools: tools.map(ollamaToolSpec) } : {}),
      ...(request.temperature !== undefined
        ? { options: { temperature: request.temperature } }
        : {}),
    };

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) controller.abort();
    // Inactivity timer: re-armed on every received chunk. Only a silent
    // connection (dead server, stalled stream) trips it.
    let timedOut = false;
    const armTimeout = (): ReturnType<typeof setTimeout> =>
      setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.timeoutMs);
    let timeout = armTimeout();
    const rearmTimeout = (): void => {
      clearTimeout(timeout);
      timeout = armTimeout();
    };

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
      if (request.signal?.aborted) {
        yield { type: "finish", reason: "aborted" };
        return;
      }
      if (timedOut) {
        throw new LlmError(
          this.id,
          `chat request timed out after ${this.timeoutMs}ms of inactivity`,
        );
      }
      throw new LlmError(
        this.id,
        // Name the endpoint: a connection failure to the wrong port/host is
        // undiagnosable from "fetch failed" alone. baseUrl is configuration,
        // never a credential. Append the undici cause (e.g. "connect
        // ECONNREFUSED 127.0.0.1:11499") so retry classification sees the
        // real transport pattern instead of the opaque "fetch failed".
        `chat request to ${this.baseUrl}/api/chat failed: ${
          err instanceof Error ? err.message : String(err)
        }${
          (err as { cause?: unknown } | null)?.cause instanceof Error
            ? `: ${(err as { cause: Error }).cause.message}`
            : ""
        }`,
      );
    }

    if (!response.ok || !response.body) {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
      const detail = await response.text().catch(() => "");
      throw new LlmError(
        this.id,
        `chat failed ${response.status}: ${detail.slice(0, 300)}`,
        { status: response.status },
      );
    }

    let sawToolCall = false;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;
      while (!done) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        rearmTimeout();
        buffer += decoder.decode(value, { stream: true });
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (line.length === 0) continue;
          let parsed: OllamaChatLine;
          try {
            parsed = JSON.parse(line) as OllamaChatLine;
          } catch {
            continue; // tolerate keep-alive noise
          }
          if (typeof parsed.error === "string") {
            throw new LlmError(this.id, parsed.error);
          }
          const msg = parsed.message;
          if (msg?.thinking) {
            yield { type: "reasoning-delta", text: msg.thinking };
          }
          if (msg?.content) {
            yield { type: "text-delta", text: msg.content };
          }
          if (msg?.tool_calls) {
            for (const call of msg.tool_calls) {
              const tc = normalizeOllamaToolCall(call);
              if (tc) {
                sawToolCall = true;
                yield { type: "tool-call", call: tc };
              }
            }
          }
          if (parsed.done) {
            if (
              typeof parsed.prompt_eval_count === "number" ||
              typeof parsed.eval_count === "number"
            ) {
              usage = {
                inputTokens: parsed.prompt_eval_count ?? 0,
                outputTokens: parsed.eval_count ?? 0,
              };
            }
            done = true;
            break;
          }
        }
      }
      if (usage) {
        yield {
          type: "usage",
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        };
      }
      yield { type: "finish", reason: "complete" };
    } catch (err) {
      if (request.signal?.aborted) {
        yield { type: "finish", reason: "aborted" };
        return;
      }
      yield {
        type: "finish",
        reason: "error",
        error: timedOut
          ? `chat stream timed out after ${this.timeoutMs}ms of inactivity`
          : err instanceof Error
            ? err.message
            : String(err),
      };
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
      void sawToolCall;
    }
  }
}

function ollamaToolSpec(tool: AgentTool): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function normalizeOllamaToolCall(
  call: OllamaToolCallWire,
): LlmToolCall | undefined {
  if (!call?.function?.name) return undefined;
  const args = call.function.arguments;
  const argumentsText =
    typeof args === "string" ? args : JSON.stringify(args ?? {});
  return {
    toolCallId: `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    toolName: call.function.name,
    argumentsText,
  };
}
