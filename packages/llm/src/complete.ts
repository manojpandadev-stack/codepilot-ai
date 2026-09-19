/**
 * @codepilot/llm — one-shot text completion over any provider.
 *
 * Aggregates `text` chunks, ignores reasoning/tool chunks, and maps a
 * failed terminal chunk to a thrown error. Used by non-agent callers
 * (e.g. the compaction summarizer) that need plain text, never a loop.
 */

import type { LlmProvider, LlmRequest } from "./types.js";

export interface CompleteTextOptions {
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  metadata?: LlmRequest["metadata"];
}

/** Run one user turn and return the aggregated assistant text. */
export async function completeText(
  provider: LlmProvider,
  prompt: string,
  options: CompleteTextOptions = {},
): Promise<string> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
    const timeoutMs = options.timeoutMs;
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  try {
    let out = "";
    const stream = provider.completeStream({
      systemPrompt: options.systemPrompt,
      messages: [{ role: "user", content: prompt }],
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      signal: controller.signal,
      metadata: options.metadata,
    });
    for await (const chunk of stream) {
      if (options.signal?.aborted || controller.signal.aborted) {
        throw new Error("aborted");
      }
      if (chunk.type === "text") out += chunk.text;
      else if (chunk.type === "done" && !chunk.success) {
        throw new Error(chunk.error ?? "completion failed");
      }
    }
    return out;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
