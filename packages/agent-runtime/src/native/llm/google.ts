/**
 * CodePilot LLM — Google Gemini adapter.
 *
 * Independently written client for the public Gemini generateContent wire
 * protocol:
 *
 *   POST {base}/v1beta/models/{model}:streamGenerateContent?alt=sse&key=…
 *
 * Streaming semantics:
 *   SSE `data:` lines each carry a GenerateContentResponse with
 *   `candidates[0].content.parts[]` where part.text is incremental content;
 *   parts may also arrive as `functionCall: {name, args}` (complete objects,
 *   no partial assembly needed). `usageMetadata` carries
 *   promptTokenCount/candidatesTokenCount. Aborted via AbortSignal.
 */

import type { AgentMessage, AgentTool } from "../types.js";
import {
  LlmError,
  type LlmProvider,
  type LlmRequest,
  type LlmStreamEvent,
} from "./types.js";

export interface GoogleLlmOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const GOOGLE_DEFAULT_BASE = "https://generativelanguage.googleapis.com";

interface WirePart {
  text?: string;
  thought?: boolean;
  functionCall?: { name?: string; args?: Record<string, unknown> };
}

interface WireResponse {
  candidates?: Array<{
    content?: { parts?: WirePart[]; role?: string };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  error?: { message?: string };
}

export function toGeminiContents(messages: AgentMessage[]): {
  system?: string;
  contents: Array<Record<string, unknown>>;
} {
  let system: string | undefined;
  const contents: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      if (
        contents.length === 0 &&
        msg.role === "user" &&
        !system &&
        msg.content.length === 0
      )
        continue;
      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }],
      });
      continue;
    }
    if (msg.role === "assistant") {
      const parts: Array<Record<string, unknown>> = [];
      for (const b of msg.content) {
        if (b.type === "text") parts.push({ text: b.text });
        else if (b.type === "image") {
          throw new Error("image blocks are only supported in user messages");
        } else if (b.type === "tool_use") {
          parts.push({ functionCall: { name: b.name, args: b.input } });
        }
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
      continue;
    }
    // user: text + images (inlineData parts) + tool results (functionResponse parts).
    // Text is always emitted before images (deterministic ordering).
    const parts: Array<Record<string, unknown>> = [];
    for (const b of msg.content) {
      if (b.type === "text") parts.push({ text: b.text });
    }
    for (const b of msg.content) {
      if (b.type === "image") {
        if (typeof b.dataBase64 !== "string" || b.dataBase64.length === 0) {
          throw new Error(
            "image block has no inline bytes (fileRef-only blocks must be resolved to bytes by the host before the provider request)",
          );
        }
        parts.push({
          inlineData: {
            mimeType: b.mime ?? "image/png",
            data: b.dataBase64,
          },
        });
      } else if (b.type === "tool_result") {
        parts.push({
          functionResponse: {
            name: b.name,
            response: b.is_error ? { error: b.content } : { result: b.content },
          },
        });
      }
    }
    if (parts.length > 0) contents.push({ role: "user", parts });
  }
  return { system, contents };
}

export class GoogleLlmProvider implements LlmProvider {
  readonly id = "google";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: GoogleLlmOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? GOOGLE_DEFAULT_BASE).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 180_000;
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const tools = request.tools ?? [];
    const { contents } = toGeminiContents(request.messages);
    const body: Record<string, unknown> = {
      contents,
      ...(request.systemPrompt
        ? { systemInstruction: { parts: [{ text: request.systemPrompt }] } }
        : {}),
      ...(request.temperature !== undefined
        ? { generationConfig: { temperature: request.temperature } }
        : {}),
      ...(tools.length > 0
        ? {
            tools: [
              {
                functionDeclarations: tools.map((tool: AgentTool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                })),
              },
            ],
          }
        : {}),
    };

    const url =
      `${this.baseUrl}/v1beta/models/${encodeURIComponent(request.modelId)}` +
      `:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`;

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) controller.abort();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      // Never include the key in errors — the URL is not echoed.
      throw new LlmError(
        this.id,
        `generateContent failed ${response.status}: ${detail.slice(0, 300)}`,
        {
          status: response.status,
        },
      );
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let abortRequested = false;

    function cleanup(): void {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
    }

    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const rawLine = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (rawLine.length === 0 || !rawLine.startsWith("data:")) continue;
          const payload = rawLine.slice(5).trim();
          if (payload.length === 0 || payload === "[DONE]") continue;
          let evt: WireResponse;
          try {
            evt = JSON.parse(payload) as WireResponse;
          } catch {
            continue;
          }
          if (evt.error) {
            throw new LlmError(this.id, evt.error.message ?? "stream error");
          }
          const parts = evt.candidates?.[0]?.content?.parts ?? [];
          for (const part of parts) {
            if (typeof part.text === "string" && part.text.length > 0) {
              if (part.thought === true) {
                yield { type: "reasoning-delta", text: part.text };
              } else {
                yield { type: "text-delta", text: part.text };
              }
            }
            if (part.functionCall?.name) {
              yield {
                type: "tool-call",
                call: {
                  toolCallId: `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                  toolName: part.functionCall.name,
                  argumentsText: JSON.stringify(part.functionCall.args ?? {}),
                },
              };
            }
          }
          if (evt.usageMetadata) {
            inputTokens = evt.usageMetadata.promptTokenCount ?? inputTokens;
            outputTokens =
              (evt.usageMetadata.candidatesTokenCount ?? 0) +
              (evt.usageMetadata.thoughtsTokenCount ?? 0);
          }
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
      yield { type: "finish", reason: abortRequested ? "aborted" : "complete" };
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
