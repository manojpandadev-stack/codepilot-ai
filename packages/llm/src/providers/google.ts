/**
 * @codepilot/llm — Google Gemini provider.
 *
 * Speaks `POST {baseUrl}/v1beta/models/{model}:streamGenerateContent?alt=sse`:
 * - body `{ system_instruction?, contents, tools?, generationConfig? }`
 * - SSE `data:` envelopes `{ candidates: [{ content: { parts },
 *   finishReason? }], usageMetadata? }`
 * - text parts `{ text }`, function calls `{ functionCall: { name, args } }`
 * - multiple function calls accumulate in call order and flush at stream end.
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

export const GOOGLE_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

function toWireContent(
  content: LlmMessage["content"],
): Array<Record<string, unknown>> {
  if (typeof content === "string") return [{ text: content }];
  const parts: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (block.type === "text") parts.push({ text: block.text });
    else if (block.type === "tool_use") {
      parts.push({
        functionCall: { name: block.name, args: block.input },
      });
    } else if (block.type === "tool_result") {
      parts.push({
        functionResponse: {
          name: block.name ?? block.tool_use_id,
          response: { output: block.content.slice(0, 6000) },
        },
      });
    }
  }
  return parts.length > 0 ? parts : [{ text: "" }];
}

export class GoogleProvider implements LlmProvider {
  readonly providerId: string;
  readonly modelId: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(options: LlmProviderOptions) {
    if (!options.modelId) throw new Error("provider requires modelId");
    this.providerId = options.providerId;
    this.modelId = options.modelId;
    const base = (options.baseUrl ?? GOOGLE_DEFAULT_BASE_URL)
      .trim()
      .replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) {
      throw new Error(`provider "${options.providerId}" requires an http(s) baseUrl`);
    }
    this.baseUrl = base;
    this.apiKey = options.apiKey;
  }

  private url(): string {
    const key = this.apiKey ? `?key=${encodeURIComponent(this.apiKey)}&alt=sse` : "?alt=sse";
    return `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.modelId)}:streamGenerateContent${key}`;
  }

  async *completeStream(request: LlmRequest): AsyncIterable<LlmChunk> {
    const body: Record<string, unknown> = {
      contents: request.messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: toWireContent(m.content),
      })),
      generationConfig: {
        ...(request.temperature !== undefined
          ? { temperature: request.temperature }
          : {}),
        ...(request.maxTokens !== undefined
          ? { maxOutputTokens: request.maxTokens }
          : {}),
      },
    };
    if (request.systemPrompt) {
      body.system_instruction = { parts: [{ text: request.systemPrompt }] };
    }
    if (request.tools && request.tools.length > 0) {
      body.tools = [
        {
          function_declarations: request.tools.map((t) => ({
            name: t.name,
            description: t.description ?? "",
            parameters: t.inputSchema ?? { type: "object", properties: {} },
          })),
        },
      ];
    }

    let lines: AsyncIterable<string>;
    try {
      lines = postStreamText(this.url(), body, { signal: request.signal });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        yield { type: "done", success: false, error: "aborted" };
        return;
      }
      throw err;
    }

    const calls: LlmToolCall[] = [];
    let usage: { inputTokens: number; outputTokens: number } | null = null;
    let failed: string | null = null;
    let callIndex = 0;

    try {
      for await (const line of lines) {
        if (request.signal?.aborted) {
          yield { type: "done", success: false, error: "aborted" };
          return;
        }
        const data = parseSseData(line);
        if (data === null) continue;
        const parsed = safeJsonParse(data) as {
          candidates?: Array<{
            content?: { parts?: Array<Record<string, unknown>> };
            finishReason?: unknown;
          }>;
          usageMetadata?: {
            promptTokenCount?: unknown;
            candidatesTokenCount?: unknown;
          };
          error?: { message?: unknown };
        } | null;
        if (!parsed || typeof parsed !== "object") continue;
        if (parsed.error && typeof parsed.error === "object") {
          const message = (parsed.error as { message?: unknown }).message;
          failed = typeof message === "string" ? message.slice(0, 500) : "google stream error";
          break;
        }
        for (const candidate of parsed.candidates ?? []) {
          for (const part of candidate.content?.parts ?? []) {
            if (typeof part.text === "string" && part.text) {
              yield { type: "text", text: part.text as string };
            }
            const fn = part.functionCall as
              | { name?: unknown; args?: unknown }
              | undefined;
            if (fn && typeof fn.name === "string" && fn.name) {
              callIndex += 1;
              const input =
                fn.args && typeof fn.args === "object" && !Array.isArray(fn.args)
                  ? (fn.args as Record<string, unknown>)
                  : {};
              calls.push({ id: `call-${callIndex}`, name: fn.name, input });
            }
          }
        }
        const meta = parsed.usageMetadata;
        if (meta && typeof meta === "object") {
          usage = {
            inputTokens:
              typeof meta.promptTokenCount === "number" ? meta.promptTokenCount : 0,
            outputTokens:
              typeof meta.candidatesTokenCount === "number"
                ? meta.candidatesTokenCount
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

    if (failed) {
      yield { type: "done", success: false, error: failed };
      return;
    }
    for (const toolCall of calls) {
      yield { type: "toolcall", toolCall };
    }
    if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
      yield {
        type: "usage",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      };
    }
    yield { type: "done", success: true, stopReason: "completed" };
  }

  async listModels(_signal?: AbortSignal): Promise<LlmListedModel[]> {
    // No public unauthenticated model catalogue; discovery is unsupported.
    return [];
  }

  async checkHealth(
    _signal?: AbortSignal,
  ): Promise<{ ok: boolean; latencyMs?: number }> {
    // No cheap unauthenticated probe exists for API-key Gemini; report
    // unavailable rather than burning a keyed call from a health check.
    return { ok: false };
  }
}
