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
import { nodeHttpFetch } from "./node-http-fetch.js";
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
  /**
   * Ollama model residency after a completed request (Go duration string).
   * Default "10m" keeps the model warm across consecutive turns. Ollama's
   * built-in default (5m) unloads the model between turns, forcing a full
   * reload (20-60s+ on CPU) before the next prompt's prefill even begins —
   * measured live on qwen3:8b/CPU. Pass "0" to restore server-default
   * unload behavior.
   */
  keepAlive?: string;
  /**
   * Ollama `num_ctx`: context window size for the model. BUG 4 — the VS Code
   * setting `codepilot.localAI.ollama.contextLength` previously never
   * reached the wire. Undefined → key omitted (server/model default).
   */
  numCtx?: number;
  /**
   * Ollama `num_predict`: maximum tokens to predict. BUG 4 — the VS Code
   * setting `codepilot.localAI.ollama.numPredict` previously never reached
   * the wire. Undefined → key omitted (server/model default).
   */
  numPredict?: number;
  /**
   * Ollama `think` control for reasoning models (qwen3 etc.). Three-state:
   * undefined → key omitted (server/model default — NO blind disabling);
   * true → request thinking output; false → request no thinking. The chat
   * UX already surfaces real thinking spans as "Thinking…" from actual
   * reasoning_delta events, so the user always sees reasoning time.
   */
  think?: boolean;
  /**
   * Inactivity window for the FIRST stream chunk in milliseconds. A local
   * CPU prefill can be legitimately silent for minutes before the first
   * byte (measured: >420s for a warm ~4k-token prompt on qwen3:8b), so the
   * initial window must be more generous than the steady-stream inactivity
   * window. Only a genuinely dead connection trips it.
   * Defaults to 900_000 (15m) when unset.
   */
  firstTokenTimeoutMs?: number;
  baseUrl?: string;
  /**
   * `fetch` redirect mode. `"manual"` surfaces a 3xx instead of following it,
   * which Local Only requires: the privacy policy can only validate the
   * CONFIGURED endpoint, so following `302 Location: https://...` would send
   * the prompt to a destination it never inspected. Omitted => default (follow).
   */
  redirect?: "follow" | "manual";
  fetchImpl?: typeof fetch;
  /**
   * Transport selection. DEFAULT "fetch" = Node's global fetch (undici) —
   * the documented test/embedding seam (vi.stubGlobal("fetch")). Optional
   * "node-http" = the zero-transport-timeout adapter (node-http-fetch.ts):
   * undici enforces a default 300s HEADERS timeout that kills a legitimate
   * slow CPU prefill (measured on live qwen3:8b) before this provider's
   * 15-minute first-token inactivity window can apply. Ignored when an
   * explicit fetchImpl is injected.
   */
  transport?: "fetch" | "node-http";
  /** Per-request INACTIVITY timeout in ms (default 300_000): aborts when no
   *  bytes arrive for this long. A wall-clock cap would kill healthy local
   *  generations (cold model load ≈145s plus long thinking spans stream for
   *  many minutes while making steady progress); silence is the failure
   *  signal, not duration. */
  timeoutMs?: number;
}

/**
 * Convert the user-facing keepAlive MINUTES setting into a Go duration
 * string Ollama accepts. Never returns a malformed value: whole minutes →
 * "5m", 0 → "0" (server-default unload), fractional minutes → seconds
 * ("0.5" → "30s"), anything non-finite/negative → undefined (omit the key).
 */
export function keepAliveMinutesToDuration(
  minutes: number,
): string | undefined {
  if (!Number.isFinite(minutes) || minutes < 0) return undefined;
  if (minutes === 0) return "0";
  if (Number.isInteger(minutes)) return `${minutes}m`;
  const seconds = Math.round(minutes * 60);
  return seconds > 0 ? `${seconds}s` : undefined;
}

export class OllamaLlmProvider implements LlmProvider {
  readonly id = "ollama";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  /** fetch redirect mode ("manual" under Local Only). Undefined => default. */
  private readonly redirect?: "follow" | "manual";
  /** True only when the zero-timeout node:http adapter was opted into. */
  readonly usesNodeHttpTransport: boolean;
  private readonly timeoutMs: number;
  private readonly firstTokenTimeoutMs: number;
  private readonly keepAlive: string;
  private readonly numCtx?: number;
  private readonly numPredict?: number;
  private readonly think?: boolean;

  constructor(options: OllamaLlmOptions = {}) {
    this.baseUrl = (options.baseUrl ?? OLLAMA_DEFAULT_HOST).replace(/\/+$/, "");
    // TRANSPORT SELECTION — an explicit fetchImpl (tests, embedding hosts)
    // always wins. Otherwise the DEFAULT is Node's global fetch (the
    // documented testable seam); "node-http" opts into the zero-timeout
    // adapter so a slow local CPU prefill is governed ONLY by the inactivity
    // windows below, never by undici's 300s HEADERS cap (measured, live
    // qwen3:8b — see node-http-fetch.ts and tests/ollama-perf-live.test.ts).
    this.usesNodeHttpTransport =
      options.fetchImpl === undefined && options.transport === "node-http";
    this.fetchImpl = (options.fetchImpl ??
      (this.usesNodeHttpTransport
        ? (nodeHttpFetch as unknown as typeof fetch)
        : fetch)) as typeof fetch;
    this.redirect = options.redirect;
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.firstTokenTimeoutMs = options.firstTokenTimeoutMs ?? 900_000;
    this.keepAlive = options.keepAlive ?? "10m";
    this.numCtx =
      options.numCtx !== undefined &&
      Number.isFinite(options.numCtx) &&
      options.numCtx > 0
        ? Math.floor(options.numCtx)
        : undefined;
    this.numPredict =
      options.numPredict !== undefined &&
      Number.isFinite(options.numPredict) &&
      options.numPredict > 0
        ? Math.floor(options.numPredict)
        : undefined;
    this.think = options.think;
  }

  async listInstalledModels(): Promise<Array<{ name: string; size?: number }>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
        ...(this.redirect ? { redirect: this.redirect } : {}),
      });
    } catch (err) {
      // Undici's global fetch rejects network failures with the opaque
      // "fetch failed" TypeError; unwrap the cause (e.g. "connect
      // ECONNREFUSED 127.0.0.1:11434") so health-check classification and
      // users see the real transport reason. baseUrl is configuration,
      // never a credential.
      const cause = (err as { cause?: unknown } | null)?.cause;
      const causeText =
        cause instanceof Error
          ? `${(cause as { code?: string }).code ?? ""} ${cause.message}`.trim()
          : "";
      throw new LlmError(
        this.id,
        `tags request to ${this.baseUrl}/api/tags failed: ${
          err instanceof Error ? err.message : String(err)
        }${causeText ? ` (${causeText})` : ""}`,
      );
    }
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
    // Phase 7: the agent loop's resolved output budget (min(configured cap,
    // remaining context)) is a HARD CEILING on num_predict — it must never
    // be exceeded when supplied. The VS Code `numPredict` setting stays a
    // preference BELOW that ceiling: deterministic precedence = the smaller
    // of the two positive values, whichever exists. Neither present → key
    // omitted (server/model default), exactly as before.
    const positiveInt = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : undefined;
    const budgetMaxTokens = positiveInt(request.maxTokens);
    const configuredNumPredict = this.numPredict;
    const effectiveNumPredict =
      budgetMaxTokens !== undefined && configuredNumPredict !== undefined
        ? Math.min(budgetMaxTokens, configuredNumPredict)
        : (budgetMaxTokens ?? configuredNumPredict);
    const body: Record<string, unknown> = {
      model: request.modelId,
      messages: [
        ...(request.systemPrompt
          ? [{ role: "system", content: request.systemPrompt }]
          : []),
        ...toOllamaMessages(request.messages),
      ],
      stream: true,
      // Pin model residency so consecutive turns do not each pay a full
      // model reload (Ollama's server default unloads after 5m idle).
      keep_alive: this.keepAlive,
      // Explicit thinking control — three-state: omitted = server default.
      ...(this.think !== undefined ? { think: this.think } : {}),
      ...(tools.length > 0 ? { tools: tools.map(ollamaToolSpec) } : {}),
      // BUG 4: num_ctx/num_predict from the VS Code localAI settings reach
      // the wire; temperature stays per-request. `options` is omitted
      // entirely when nothing is configured (never an empty/partial object).
      ...(this.numCtx !== undefined ||
      effectiveNumPredict !== undefined ||
      request.temperature !== undefined
        ? {
            options: {
              ...(this.numCtx !== undefined ? { num_ctx: this.numCtx } : {}),
              ...(effectiveNumPredict !== undefined
                ? { num_predict: effectiveNumPredict }
                : {}),
              ...(request.temperature !== undefined
                ? { temperature: request.temperature }
                : {}),
            },
          }
        : {}),
    };

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) controller.abort();
    // Inactivity timer, two phases. A local CPU prefill is legitimately
    // silent for minutes before the first byte (measured: >420s for a warm
    // ~4k-token prompt on qwen3:8b — model load + prompt evaluation emit
    // NOTHING until generation starts), so the window before the first
    // chunk is more generous (firstTokenTimeoutMs). Once bytes flow, the
    // window tightens to timeoutMs and re-arms on every chunk. Only a
    // genuinely silent connection (dead server, stalled stream) trips it.
    let timedOut = false;
    const armTimeout = (ms: number): ReturnType<typeof setTimeout> =>
      setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, ms);
    let timeout = armTimeout(this.firstTokenTimeoutMs);
    let firstChunkSeen = false;
    const rearmTimeout = (): void => {
      clearTimeout(timeout);
      timeout = armTimeout(
        firstChunkSeen ? this.timeoutMs : this.firstTokenTimeoutMs,
      );
    };

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
        ...(this.redirect ? { redirect: this.redirect } : {}),
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
          `chat request timed out after ${firstChunkSeen ? this.timeoutMs : this.firstTokenTimeoutMs}ms of inactivity${firstChunkSeen ? "" : " before the first stream chunk (local model load or prompt prefill still running; raise firstTokenTimeoutMs for very large CPU prompts)"}`,
        );
      }
      // MEASURED (live qwen3:8b, perf suite): undici's default 300s HEADERS
      // timeout (UND_ERR_HEADERS_TIMEOUT) fires BEFORE this provider's
      // designed first-token inactivity window when a CPU prefill stays
      // silent longer than 5 minutes. Surface the REAL cause and the fix —
      // never a generic "fetch failed".
      const cause = (err as { cause?: unknown } | null)?.cause;
      const causeCode =
        cause instanceof Error
          ? ((cause as { code?: string }).code ?? cause.message)
          : "";
      if (
        typeof causeCode === "string" &&
        causeCode.includes("HEADERS_TIMEOUT")
      ) {
        throw new LlmError(
          this.id,
          `chat request to ${this.baseUrl}/api/chat was dropped by the HTTP client's 300s headers timeout while the local model was still prefilling (no response headers yet). The provider's own first-token window (firstTokenTimeoutMs) is longer — raise it deliberately AND run the request on a transport without undici's headers cap, or reduce context/prompt size.`,
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
        }${cause instanceof Error ? `: ${cause.message}` : ""}`,
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
        firstChunkSeen = true;
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
      // No done:true seen means the stream was truncated (EOF without
      // terminal evidence) — never report it as a successful completion.
      yield { type: "finish", reason: done ? "complete" : "incomplete" };
    } catch (err) {
      if (request.signal?.aborted) {
        yield { type: "finish", reason: "aborted" };
        return;
      }
      yield {
        type: "finish",
        reason: "error",
        error: timedOut
          ? `chat stream timed out after ${firstChunkSeen ? this.timeoutMs : this.firstTokenTimeoutMs}ms of inactivity${firstChunkSeen ? "" : " before the first stream chunk"}`
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
