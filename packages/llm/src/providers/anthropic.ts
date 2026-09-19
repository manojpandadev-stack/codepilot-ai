/**
 * @codepilot/llm — Anthropic Messages API provider.
 *
 * Speaks `POST {baseUrl}/v1/messages` with SSE streaming:
 * - headers `x-api-key` + `anthropic-version: 2023-06-01`
 * - body `{ model, max_tokens, system?, messages, tools?, stream: true }`
 * - events: message_start / content_block_start / content_block_delta
 *   (text_delta | input_json_delta) / content_block_stop / message_delta /
 *   message_stop / error
 * - tool input JSON accumulates per content-block index and is emitted as a
 *   complete `toolcall` chunk at stream end (with per-block-stop flush for
 *   promptness — ids/names/args are complete by then per the protocol).
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
import { parseSseData, postStreamText, safeJsonParse } from "./http.js";

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;

function toWireContent(
  content: LlmMessage["content"],
): string | Array<Record<string, unknown>> {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "tool_use") {
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
    }
    return {
      type: "tool_result",
      tool_use_id: block.tool_use_id,
      content: block.content,
      ...(block.is_error ? { is_error: true } : {}),
    };
  });
}

interface AccumulatedTool {
  id: string;
  name: string;
  args: string;
  emitted: boolean;
}

export class AnthropicProvider implements LlmProvider {
  readonly providerId: string;
  readonly modelId: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(options: LlmProviderOptions) {
    if (!options.modelId) throw new Error("provider requires modelId");
    this.providerId = options.providerId;
    this.modelId = options.modelId;
    const base = (options.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL)
      .trim()
      .replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) {
      throw new Error(`provider "${options.providerId}" requires an http(s) baseUrl`);
    }
    this.baseUrl = base;
    this.apiKey = options.apiKey;
  }

  private headers(): Record<string, string> {
    return {
      ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
      "anthropic-version": ANTHROPIC_VERSION,
    };
  }

  async *completeStream(request: LlmRequest): AsyncIterable<LlmChunk> {
    const body: Record<string, unknown> = {
      model: this.modelId,
      max_tokens: request.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: toWireContent(m.content),
      })),
      stream: true,
      ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        input_schema: t.inputSchema ?? { type: "object", properties: {} },
      }));
    }

    let lines: AsyncIterable<string>;
    try {
      lines = postStreamText(`${this.baseUrl}/v1/messages`, body, {
        headers: this.headers(),
        signal: request.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        yield { type: "done", success: false, error: "aborted" };
        return;
      }
      throw err;
    }

    const tools = new Map<number, AccumulatedTool>();
    let inputTokens = 0;
    let outputTokens = 0;
    let currentEvent = "";
    let failed: string | null = null;

    const flushReady = function* (
      uptoIndex?: number,
    ): Generator<LlmChunk, void, void> {
      for (const [index, acc] of [...tools.entries()].sort((a, b) => a[0] - b[0])) {
        if (uptoIndex !== undefined && index > uptoIndex) continue;
        if (acc.emitted || !acc.name) continue;
        acc.emitted = true;
        let input: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(acc.args || "{}") as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
          }
        } catch {
          input = { _raw: acc.args.slice(0, 4000) };
        }
        const toolCall: LlmToolCall = { id: acc.id, name: acc.name, input };
        yield { type: "toolcall", toolCall };
      }
    };

    try {
      for await (const line of lines) {
        if (request.signal?.aborted) {
          yield { type: "done", success: false, error: "aborted" };
          return;
        }
        if (line.startsWith("event:")) {
          currentEvent = line.slice("event:".length).trim();
          continue;
        }
        const data = parseSseData(line);
        if (data === null) continue;
        const parsed = safeJsonParse(data) as Record<string, unknown> | null;
        if (!parsed || typeof parsed !== "object") continue;

        switch (currentEvent) {
          case "message_start": {
            const msg = parsed.message as
              | { usage?: { input_tokens?: unknown } }
              | undefined;
            if (typeof msg?.usage?.input_tokens === "number") {
              inputTokens = msg.usage.input_tokens;
            }
            break;
          }
          case "content_block_start": {
            const index =
              typeof parsed.index === "number" ? parsed.index : tools.size;
            const block = (parsed.content_block ?? {}) as {
              type?: unknown;
              id?: unknown;
              name?: unknown;
            };
            if (block.type === "tool_use") {
              tools.set(index, {
                id: typeof block.id === "string" ? block.id : `call-${index + 1}`,
                name: typeof block.name === "string" ? block.name : "",
                args: "",
                emitted: false,
              });
            }
            break;
          }
          case "content_block_delta": {
            const index =
              typeof parsed.index === "number" ? parsed.index : 0;
            const delta = (parsed.delta ?? {}) as {
              type?: unknown;
              text?: unknown;
              partial_json?: unknown;
            };
            if (delta.type === "text_delta" && typeof delta.text === "string") {
              yield { type: "text", text: delta.text };
            } else if (
              delta.type === "input_json_delta" &&
              typeof delta.partial_json === "string"
            ) {
              const acc = tools.get(index);
              if (acc) acc.args += delta.partial_json;
            }
            break;
          }
          case "content_block_stop": {
            const index =
              typeof parsed.index === "number" ? parsed.index : 0;
            yield* flushReady(index);
            break;
          }
          case "message_delta": {
            const usage = (parsed.usage ?? {}) as { output_tokens?: unknown };
            if (typeof usage.output_tokens === "number") {
              outputTokens = usage.output_tokens;
            }
            break;
          }
          case "error": {
            const message = parsed as { message?: unknown; error?: unknown };
            const text =
              typeof message.message === "string"
                ? message.message
                : typeof message.error === "string"
                  ? message.error
                  : "anthropic stream error";
            failed = text.slice(0, 500);
            break;
          }
          default:
            break;
        }
        if (failed) break;
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        yield { type: "done", success: false, error: "aborted" };
        return;
      }
      throw err;
    }

    if (failed) {
      yield { type: "done", success: false, error: failed };
      return;
    }
    yield* flushReady();
    if (inputTokens > 0 || outputTokens > 0) {
      yield { type: "usage", inputTokens, outputTokens };
    }
    yield { type: "done", success: true, stopReason: "completed" };
  }

  async listModels(signal?: AbortSignal): Promise<LlmListedModel[]> {
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      headers: this.headers(),
      signal,
    });
    if (!res.ok) {
      throw new Error(`Anthropic model list failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(data.data)) return [];
    return data.data
      .filter((m) => typeof m?.id === "string" && (m.id as string).length > 0)
      .map((m) => ({ id: m.id as string }));
  }

  async checkHealth(
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; latencyMs?: number }> {
    const started = Date.now();
    try {
      // No unauthenticated probe exists; a 401 still proves reachability,
      // but report only true 2xx as healthy to stay honest.
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        headers: this.headers(),
        signal,
      });
      await res.arrayBuffer().catch(() => null);
      if (!res.ok) return { ok: false };
      return { ok: true, latencyMs: Date.now() - started };
    } catch {
      return { ok: false };
    }
  }
}
