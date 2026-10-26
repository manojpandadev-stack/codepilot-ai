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
import { extractProviderError, formatProviderError } from "./provider-error.js";

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  /** Extra headers (e.g. OpenRouter attribution). Never logged. */
  headers?: Record<string, string>;
  /**
   * `fetch` redirect mode. `"manual"` surfaces a 3xx instead of following it,
   * which Local Only requires: the privacy policy can only validate the
   * CONFIGURED endpoint, so following `302 Location: https://...` would send
   * the prompt and the stored credential to a destination it never inspected.
   * Omitted => fetch's default (follow).
   */
  redirect?: "follow" | "manual";
  fetchImpl?: typeof fetch;
  /**
   * Provider-bound abort context (e.g. a cancelled orchestration turn).
   * Combined with the per-request signal: either aborting aborts the
   * stream, and a pre-aborted context reports `aborted`, never success.
   */
  signal?: AbortSignal;
  /** Steady-stream INACTIVITY window (ms): aborts when no bytes arrive for
   *  this long after the first chunk. Silence is the failure signal, not
   *  duration — a wall-clock cap kills healthy slow generations. */
  timeoutMs?: number;
  /**
   * Inactivity window (ms) allowed before the FIRST stream chunk. Local
   * runtimes behind this adapter (e.g. LM Studio on CPU) can be legitimately
   * silent for minutes during model load + prompt prefill before the first
   * byte. Defaults to 900_000 (15m) when unset.
   */
  firstTokenTimeoutMs?: number;
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
  /** fetch redirect mode ("manual" under Local Only). Undefined => default. */
  private readonly redirect?: "follow" | "manual";
  private readonly signal?: AbortSignal;
  private readonly timeoutMs: number;
  private readonly firstTokenTimeoutMs: number;

  constructor(id: string, options: OpenAiCompatibleOptions) {
    this.id = id;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.headers = options.headers;
    this.fetchImpl = options.fetchImpl ?? fetch;
    // Local Only passes "manual": never follow an HTTP redirect off the machine.
    this.redirect = options.redirect;
    this.signal = options.signal;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.firstTokenTimeoutMs = options.firstTokenTimeoutMs ?? 900_000;
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const tools = request.tools ?? [];
    const offeredToolNames = new Set<string>();
    for (const tool of tools) {
      if (offeredToolNames.has(tool.name)) {
        throw new Error(`duplicate tool name: ${tool.name}`);
      }
      offeredToolNames.add(tool.name);
    }
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
    const boundSignal = this.signal;
    request.signal?.addEventListener("abort", onAbort, { once: true });
    boundSignal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted === true || this.signal?.aborted === true)
      controller.abort();
    // Two-phase inactivity timer (see OllamaLlmProvider): a generous window
    // for the silent model-load/prefill phase before the first byte, then the
    // steady-stream window re-armed on every received chunk. Never a
    // wall-clock cap — that kills healthy slow generations.
    let timedOut = false;
    let firstChunkSeen = false;
    const armTimeout = (ms: number): ReturnType<typeof setTimeout> =>
      setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, ms);
    let timeout = armTimeout(this.firstTokenTimeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        ...(this.redirect ? { redirect: this.redirect } : {}),
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
      if (request.signal?.aborted === true || this.signal?.aborted === true) {
        yield { type: "finish", reason: "aborted" };
        return;
      }
      if (timedOut) {
        throw new LlmError(
          this.id,
          `chat request timed out after ${firstChunkSeen ? this.timeoutMs : this.firstTokenTimeoutMs}ms of inactivity${firstChunkSeen ? "" : " before the first stream chunk (local model load or prompt prefill still running; raise firstTokenTimeoutMs for very large CPU prompts)"}`,
        );
      }
      throw new LlmError(
        this.id,
        `request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok || !response.body) {
      cleanup();
      const detail = await response.text().catch(() => "");
      const formatted = formatProviderError(
        extractProviderError(response.status, detail),
      );
      throw new LlmError(this.id, `chat failed (${formatted})`, {
        status: response.status,
      });
    }

    // Incremental tool-call assembly (OpenAI fragments by index).
    const pendingCalls = new Map<
      number,
      { id: string; name: string; args: string }
    >();
    let finished = false;
    let abortRequested = false;

    // Terminal-evidence tracking: a provider stream is only "complete" when
    // it emits an explicit finish_reason. An EOF or [DONE]-only end is
    // "incomplete" - never inferred as success.
    let providerFinishedCleanly = false;
    let pendingToolCallsOnEOF = 0;
    function cleanup(): void {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
      boundSignal?.removeEventListener("abort", onAbort);
    }

    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let usage: WireChunk["usage"] | undefined;

      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        firstChunkSeen = true;
        clearTimeout(timeout);
        timeout = armTimeout(this.timeoutMs);
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const rawLine = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (rawLine.length === 0 || !rawLine.startsWith("data:")) continue;
          const payload = rawLine.slice(5).trim();
          if (payload === "[DONE]") {
            pendingToolCallsOnEOF = pendingCalls.size;
            // Protocol terminator. Treat it as EOF, not as a successful
            // completion: without a provider `finish_reason` on a choices
            // block we have no terminal evidence (the model may have cut off
            // mid-stream, the connection may have dropped, or the body may
            // be truncated). Yield nothing here so the loop can distinguish
            // a clean provider finish from an incomplete/unknown end.
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
            const formatted = formatProviderError(
              extractProviderError(200, JSON.stringify(chunk)),
            );
            throw new LlmError(
              this.id,
              `chat failed mid-stream (${formatted})`,
            );
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
              // Providers may repeat a full name or stream it in fragments.
              // Join fragments only while they remain a prefix of a tool
              // offered in this request; repeated/cumulative names are
              // idempotent and conflicting names cannot corrupt the call.
              const nameFragment = fragment.function?.name;
              if (nameFragment) {
                if (!pending.name) {
                  pending.name = nameFragment;
                } else if (
                  nameFragment.startsWith(pending.name) &&
                  [...offeredToolNames].some((name) =>
                    name.startsWith(nameFragment),
                  )
                ) {
                  pending.name = nameFragment;
                } else if (!pending.name.startsWith(nameFragment)) {
                  const joined = pending.name + nameFragment;
                  if (
                    [...offeredToolNames].some((name) =>
                      name.startsWith(joined),
                    )
                  ) {
                    pending.name = joined;
                  }
                }
              }
              if (fragment.function?.arguments)
                pending.args += fragment.function.arguments;
            }
          }
          if (chunk.usage) usage = chunk.usage;
          if (choice?.finish_reason) {
            providerFinishedCleanly = true;
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
        if (request.signal?.aborted === true || this.signal?.aborted === true) {
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
      // Decide the terminal reason from actual provider evidence, not from
      // the fact that the SSE loop exited. A clean stop is only "complete"
      // when the provider emitted a finish_reason; an EOF/[DONE]-only end is
      // "incomplete" (the model may have cut off, the connection may have
      // dropped, or the body may be truncated). Cancellation is preserved as
      // "aborted" and never rewritten to "complete" or "error".
      //
      // A provider that ends while still holding unflushed tool-call
      // fragments (pendingToolCallsOnEOF > 0) did not finish describing a
      // tool call - that is also incomplete, never success.
      // Unfinished fragments are surfaced (never silently discarded),
      // but without a finish_reason the turn is still incomplete.
      if (!providerFinishedCleanly && pendingCalls.size > 0) {
        const ordered = [...pendingCalls.entries()].sort((a, b) => a[0] - b[0]);
        for (const [, call] of ordered) {
          yield {
            type: "tool-call",
            call: {
              toolCallId: call.id,
              toolName: call.name,
              argumentsText: call.args,
            },
          };
        }
        pendingCalls.clear();
      }
      let finishReason: "complete" | "aborted" | "incomplete";
      if (abortRequested) {
        finishReason = "aborted";
      } else if (providerFinishedCleanly) {
        finishReason = "complete";
      } else if (pendingToolCallsOnEOF > 0) {
        // The stream ended mid-tool-call (fragmented or cut-off).
        finishReason = "incomplete";
      } else {
        finishReason = "incomplete";
      }
      yield {
        type: "finish",
        reason: finishReason,
      };
    } catch (err) {
      if (request.signal?.aborted === true || this.signal?.aborted === true) {
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
