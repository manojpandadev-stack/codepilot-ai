/**
 * @codepilot/llm — OpenAI-compatible chat-completions provider.
 *
 * Speaks `POST {baseUrl}/chat/completions` with SSE streaming:
 * - request: `{ model, messages, tools?, tool_choice?, stream: true,
 *   temperature?, max_tokens? }`
 * - events: `data: { choices: [{ delta: { content?, tool_calls? },
 *   finish_reason? }], usage? }`, terminated by `data: [DONE]`
 * - tool deltas accumulate per `index`; missing call ids are synthesized
 *   deterministically (`call-<index+1>`) so downstream pairing is stable.
 *
 * Used directly for OpenAI-compatible endpoints (incl. LM Studio) and as
 * the shared wire implementation for the OpenAI-native and OpenRouter
 * adapters (different defaults/headers only).
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

export interface OpenAICompatibleOptions extends LlmProviderOptions {
  /** Extra headers (e.g. OpenRouter referral). Never logged. */
  extraHeaders?: Record<string, string>;
  /** Max output tokens hint (provider-specific default when absent). */
  maxTokens?: number;
}

interface AccumulatedCall {
  id: string;
  name: string;
  args: string;
  hasName: boolean;
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

export class OpenAICompatibleProvider implements LlmProvider {
  readonly providerId: string;
  readonly modelId: string;
  protected readonly baseUrl: string;
  protected readonly apiKey?: string;
  protected readonly extraHeaders: Record<string, string>;
  protected readonly defaultMaxTokens?: number;

  constructor(options: OpenAICompatibleOptions) {
    if (!options.modelId) throw new Error("provider requires modelId");
    const base = (options.baseUrl ?? "").trim().replace(/\/+$/, "");
    if (!base || !/^https?:\/\//i.test(base)) {
      throw new Error(
        `provider "${options.providerId}" requires an http(s) baseUrl`,
      );
    }
    this.providerId = options.providerId;
    this.modelId = options.modelId;
    this.baseUrl = base;
    this.apiKey = options.apiKey;
    this.extraHeaders = options.extraHeaders ?? {};
    this.defaultMaxTokens = options.maxTokens;
  }

  protected buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { ...this.extraHeaders };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
    return headers;
  }

  protected endpoint(): string {
    return `${this.baseUrl}/chat/completions`;
  }

  /** Hook for subclasses (Anthropic-style errors, Gemini envelopes, …). */
  protected interpretDone(
    _finishReason: string | null,
  ): { type: "done"; success: boolean; error?: string; stopReason?: string } {
    return { type: "done", success: true, stopReason: "completed" };
  }

  async *completeStream(request: LlmRequest): AsyncIterable<LlmChunk> {
    const body: Record<string, unknown> = {
      model: this.modelId,
      messages: toWireMessages(request),
      stream: true,
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
      ...(request.maxTokens !== undefined
        ? { max_tokens: request.maxTokens }
        : this.defaultMaxTokens !== undefined
          ? { max_tokens: this.defaultMaxTokens }
          : {}),
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description ?? "",
          parameters: t.inputSchema ?? { type: "object", properties: {} },
        },
      }));
      body.tool_choice = "auto";
    }

    const calls = new Map<number, AccumulatedCall>();
    let usage: { inputTokens: number; outputTokens: number } | null = null;
    let finishReason: string | null = null;

    let lines: AsyncIterable<string>;
    try {
      lines = postStreamText(this.endpoint(), body, {
        headers: this.buildHeaders(),
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
        const data = parseSseData(line);
        if (data === null) continue;
        const parsed = safeJsonParse(data) as {
          choices?: Array<{
            delta?: {
              content?: unknown;
              tool_calls?: Array<{
                index?: unknown;
                id?: unknown;
                function?: { name?: unknown; arguments?: unknown };
              }>;
            };
            finish_reason?: unknown;
          }>;
          usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
        } | null;
        if (!parsed || typeof parsed !== "object") continue;
        const choice = Array.isArray(parsed.choices)
          ? parsed.choices[0]
          : undefined;
        const delta = choice?.delta;
        if (delta && typeof delta === "object") {
          if (typeof delta.content === "string" && delta.content) {
            yield { type: "text", text: delta.content };
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const index =
                typeof tc?.index === "number" && tc.index >= 0 ? tc.index : 0;
              let acc = calls.get(index);
              if (!acc) {
                acc = {
                  id: `call-${index + 1}`,
                  name: "",
                  args: "",
                  hasName: false,
                };
                calls.set(index, acc);
              }
              if (typeof tc?.id === "string" && tc.id && !acc.hasName) {
                acc.id = tc.id;
              }
              const fnName = tc?.function?.name;
              if (typeof fnName === "string" && fnName) {
                acc.name = fnName;
                acc.hasName = true;
              }
              const fnArgs = tc?.function?.arguments;
              if (typeof fnArgs === "string") acc.args += fnArgs;
            }
          }
        }
        if (typeof choice?.finish_reason === "string") {
          finishReason = choice.finish_reason;
        }
        const usageRaw = parsed.usage;
        if (usageRaw && typeof usageRaw === "object") {
          usage = {
            inputTokens:
              typeof usageRaw.prompt_tokens === "number"
                ? usageRaw.prompt_tokens
                : 0,
            outputTokens:
              typeof usageRaw.completion_tokens === "number"
                ? usageRaw.completion_tokens
                : 0,
          };
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        yield { type: "done", success: false, error: "aborted" };
        return;
      }
      throw err;
    }

    for (const index of [...calls.keys()].sort((a, b) => a - b)) {
      const acc = calls.get(index)!;
      if (!acc.name) continue; // incomplete fragment without a name: drop
      let input: Record<string, unknown> = {};
      try {
        const parsedArgs = JSON.parse(acc.args || "{}") as unknown;
        if (parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)) {
          input = parsedArgs as Record<string, unknown>;
        }
      } catch {
        input = { _raw: acc.args.slice(0, 4000) };
      }
      const toolCall: LlmToolCall = { id: acc.id, name: acc.name, input };
      yield { type: "toolcall", toolCall };
    }
    if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
      yield {
        type: "usage",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      };
    }
    yield this.interpretDone(finishReason);
  }

  async listModels(signal?: AbortSignal): Promise<LlmListedModel[]> {
    const headers = this.buildHeaders();
    const res = await fetch(`${this.baseUrl}/models`, {
      headers,
      signal,
    });
    if (!res.ok) {
      throw new Error(`model list failed: HTTP ${res.status}`);
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
      const headers = this.buildHeaders();
      const res = await fetch(`${this.baseUrl}/models`, {
        headers,
        signal,
      });
      if (!res.ok) return { ok: false };
      await res.arrayBuffer().catch(() => null);
      return { ok: true, latencyMs: Date.now() - started };
    } catch {
      return { ok: false };
    }
  }
}
