/**
 * @codepilot/llm — Ollama provider (local runtime).
 *
 * Speaks the Ollama `/api/chat` protocol directly:
 * - request: `{ model, messages, tools?, stream: true, options }`
 * - NDJSON lines: `{ message: { role, content, tool_calls? }, done }`
 * - tool calls: each entry is a COMPLETE call —
 *   `{ id?, function: { index?, name, arguments } }` with `arguments` as a
 *   finished OBJECT (never partial fragments). Verified live against Ollama
 *   0.34.0 / qwen3:8b: parallel calls of the same tool arrive as separate
 *   entries with distinct `function.index` values (0, 1, ...) and distinct
 *   server `id`s. Calls are therefore keyed by `index ?? ordinal` — NEVER
 *   by name, which would merge same-name parallel calls.
 * - completion: `{ done: true, prompt_eval_count?, eval_count? }`
 * - discovery: `GET /api/tags` → `{ models: [{ name }] }`
 *
 * qwen-style `<think>…</think>` spans inside content are split into
 * `reasoning` chunks so the agent loop can surface thinking tokens as
 * status (never as chat text) — same observable behavior as before.
 */

import type {
  LlmChunk,
  LlmListedModel,
  LlmMessage,
  LlmProvider,
  LlmProviderOptions,
  LlmRequest,
  LlmToolCall,
} from "../types.js";
import { postStreamText, safeJsonParse } from "./http.js";

export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";

interface OllamaToolCallWire {
  id?: unknown;
  function?: { index?: unknown; name?: unknown; arguments?: unknown };
}

interface OllamaMessageWire {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
}

function normalizeBaseUrl(baseUrl?: string): string {
  const raw = (baseUrl ?? OLLAMA_DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(raw)) {
    throw new Error("Ollama baseUrl must be an http(s) URL");
  }
  return raw;
}

function toWireContent(content: LlmMessage["content"]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "tool_use") {
      parts.push(
        `[tool_use ${block.name} id=${block.id}] ${JSON.stringify(block.input).slice(0, 4000)}`,
      );
    } else if (block.type === "tool_result") {
      parts.push(
        `[tool_result ${block.name ?? block.tool_use_id}${block.is_error ? " ERROR" : ""}] ${block.content.slice(0, 6000)}`,
      );
    } else if (block.type === "image") {
      // Simplified text path: mark the image explicitly so it is never
      // silently dropped (native providers carry the real bytes).
      parts.push(`[image ${block.mime}]`);
    }
  }
  return parts.join("\n");
}

function toWireMessages(request: LlmRequest): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (request.systemPrompt) {
    out.push({ role: "system", content: request.systemPrompt });
  }
  for (const m of request.messages) {
    out.push({ role: m.role, content: toWireContent(m.content) });
  }
  return out;
}

function toWireTools(
  request: LlmRequest,
): Array<Record<string, unknown>> | undefined {
  if (!request.tools || request.tools.length === 0) return undefined;
  return request.tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.inputSchema ?? { type: "object", properties: {} },
    },
  }));
}

/** Split `<think>…</think>` spans out of streamed content. */
export function splitThinking(
  text: string,
): Array<{ kind: "text"; text: string } | { kind: "reasoning"; text: string }> {
  const parts: Array<
    { kind: "text"; text: string } | { kind: "reasoning"; text: string }
  > = [];
  const re = /<think>([\s\S]*?)(<\/think>|$)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  for (;;) {
    match = re.exec(text);
    if (!match || match.index === undefined) break;
    if (match.index > last) {
      parts.push({ kind: "text", text: text.slice(last, match.index) });
    }
    parts.push({ kind: "reasoning", text: match[1] ?? "" });
    last = match.index + match[0].length;
    if (match[2] === "") break; // unclosed tail consumed to end
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts.filter((p) => p.text.length > 0);
}

export interface OllamaProviderConfig extends LlmProviderOptions {
  /** Model context window hint for `num_ctx` (default 32768). */
  numCtx?: number;
}

export class OllamaProvider implements LlmProvider {
  readonly providerId: string;
  readonly modelId: string;
  private readonly baseUrl: string;
  private readonly numCtx: number;

  constructor(options: OllamaProviderConfig) {
    if (!options.modelId) throw new Error("Ollama provider requires modelId");
    this.providerId = options.providerId;
    this.modelId = options.modelId;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.numCtx = options.numCtx ?? 32768;
  }

  async *completeStream(request: LlmRequest): AsyncIterable<LlmChunk> {
    const body: Record<string, unknown> = {
      model: this.modelId,
      messages: toWireMessages(request),
      stream: true,
      options: {
        num_ctx: this.numCtx,
        ...(request.temperature !== undefined
          ? { temperature: request.temperature }
          : {}),
      },
    };
    const tools = toWireTools(request);
    if (tools) body.tools = tools;

    // Ordered, index-keyed collection of tool calls seen this turn.
    // Key is `function.index` when present (server-side parallel-call
    // ordering), falling back to the arrival ordinal. Values keep the
    // server call id when the server generated one.
    const pendingCalls = new Map<
      number,
      { name: string; argsText: string; serverId: string }
    >();
    let usage: { inputTokens: number; outputTokens: number } | null = null;

    let lines: AsyncIterable<string>;
    try {
      lines = postStreamText(`${this.baseUrl}/api/chat`, body, {
        signal: request.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        yield { type: "done", success: false, error: "aborted" };
        return;
      }
      throw err;
    }

    try {
      for await (const line of lines) {
        if (request.signal?.aborted) {
          yield { type: "done", success: false, error: "aborted" };
          return;
        }
        const parsed = safeJsonParse(line) as {
          message?: OllamaMessageWire;
          done?: unknown;
          prompt_eval_count?: unknown;
          eval_count?: unknown;
          error?: unknown;
        } | null;
        if (!parsed) continue;
        if (typeof parsed.error === "string" && parsed.error) {
          yield {
            type: "done",
            success: false,
            error: parsed.error.slice(0, 500),
          };
          return;
        }
        const message = parsed.message;
        if (message && typeof message === "object") {
          if (typeof message.content === "string" && message.content) {
            for (const part of splitThinking(message.content)) {
              yield part.kind === "reasoning"
                ? { type: "reasoning", text: part.text }
                : { type: "text", text: part.text };
            }
          }
          if (Array.isArray(message.tool_calls)) {
            for (const raw of message.tool_calls) {
              const entry = raw as OllamaToolCallWire;
              const fn = entry?.function;
              const name = typeof fn?.name === "string" ? fn.name : "";
              if (!name) continue;
              // `arguments` is a complete object on the Ollama wire; a string
              // is accepted defensively for servers that stream it as text.
              const argsText =
                typeof fn?.arguments === "string"
                  ? fn.arguments
                  : JSON.stringify(fn?.arguments ?? {});
              const index =
                typeof fn?.index === "number" && Number.isInteger(fn.index)
                  ? fn.index
                  : pendingCalls.size;
              const serverId = typeof entry.id === "string" ? entry.id : "";
              const existing = pendingCalls.get(index);
              pendingCalls.set(index, {
                name,
                // Concatenation only matters for the defensive string case;
                // object arguments simply overwrite with the newest entry.
                argsText: existing ? existing.argsText + argsText : argsText,
                serverId: serverId || (existing?.serverId ?? ""),
              });
            }
          }
        }
        if (parsed.done === true) {
          const inputTokens =
            typeof parsed.prompt_eval_count === "number"
              ? parsed.prompt_eval_count
              : 0;
          const outputTokens =
            typeof parsed.eval_count === "number" ? parsed.eval_count : 0;
          usage = { inputTokens, outputTokens };
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        yield { type: "done", success: false, error: "aborted" };
        return;
      }
      throw err;
    }

    // Flush collected tool calls in index (== parallel-call) order.
    for (const [index, call] of pendingCalls) {
      let input: Record<string, unknown> = {};
      try {
        const parsedArgs = JSON.parse(call.argsText || "{}") as unknown;
        if (
          parsedArgs &&
          typeof parsedArgs === "object" &&
          !Array.isArray(parsedArgs)
        ) {
          input = parsedArgs as Record<string, unknown>;
        }
      } catch {
        input = { _raw: call.argsText.slice(0, 4000) };
      }
      const toolCall: LlmToolCall = {
        // Prefer the server-generated id verbatim; fall back to a stable
        // index-derived id only when the server did not send one.
        id: call.serverId || `call-${index + 1}`,
        name: call.name,
        input,
      };
      yield { type: "toolcall", toolCall };
    }
    if (usage) {
      yield {
        type: "usage",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      };
    }
    yield { type: "done", success: true, stopReason: "completed" };
  }

  async listModels(signal?: AbortSignal): Promise<LlmListedModel[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`, { signal });
    if (!res.ok) {
      throw new Error(`Ollama model list failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { models?: Array<{ name?: unknown }> };
    const models = Array.isArray(data.models) ? data.models : [];
    return models
      .filter(
        (m) => typeof m?.name === "string" && (m.name as string).length > 0,
      )
      .map((m) => ({ id: m.name as string, name: m.name as string }));
  }

  async checkHealth(
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; latencyMs?: number }> {
    const started = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal });
      if (!res.ok) return { ok: false };
      try {
        await res.arrayBuffer();
      } catch {
        return { ok: false };
      }
      return { ok: true, latencyMs: Date.now() - started };
    } catch {
      return { ok: false };
    }
  }
}
