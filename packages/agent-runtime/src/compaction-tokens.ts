/**
 * M12 — Context-size math for conversation compaction (pure functions).
 *
 * Token estimation uses the documented chars/4 approximation (same constant
 * as the M6 retrieval budgeter). Context-window resolution prefers the
 * ACTIVE MODEL's catalogue metadata and falls back conservatively when the
 * limit is unknown — an unknown limit must never let the conversation grow
 * unbounded, so the fallback is small on purpose.
 */

import type { PersistedConversationMessage } from "./m12-task-store.js";

/** Same documented approximation as the M6 budgeter. */
export const CHARS_PER_TOKEN = 4;

/** Conservative fallback when the model's context window is unknown. */
export const FALLBACK_CONTEXT_WINDOW_TOKENS = 32_768;

/**
 * Threshold zones (fraction of the model context window):
 *   < 60%  normal        — do nothing
 *   60–75% monitor       — do nothing yet (reported for observability)
 *   75–85% prepare       — compaction allowed but not forced
 *   > 85%  compact       — compact before continuing
 */
export const COMPACT_BELOW_RATIO = 0.85;
export const PREPARE_BELOW_RATIO = 0.75;
export const MONITOR_BELOW_RATIO = 0.6;

export type CompactionZone = "normal" | "monitor" | "prepare" | "compact";

export interface ContextPressure {
  estimatedTokens: number;
  contextWindowTokens: number;
  ratio: number;
  zone: CompactionZone;
  /** True when the context window came from the conservative fallback. */
  usedFallback: boolean;
}

/** Estimate tokens for one conversation entry (both content shapes). */
export function estimateEntryTokens(entry: PersistedConversationMessage): number {
  let chars = 0;
  if (entry.text !== undefined) chars += entry.text.length;
  if (entry.blocks !== undefined) {
    for (const b of entry.blocks) {
      if (b.type === "text") chars += b.text.length;
      else if (b.type === "tool_use") chars += (b.input?.length ?? 0) + b.name.length;
      else chars += b.content.length + b.name.length;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Estimate total tokens for a conversation. */
export function estimateConversationTokens(
  conversation: PersistedConversationMessage[],
): number {
  let total = 0;
  for (const entry of conversation) total += estimateEntryTokens(entry);
  return total;
}

/**
 * Resolve the context window for the active provider/model. Precedence:
 *   1. explicit override (host already looked it up per-model)
 *   2. catalogue model metadata (provider entry → model entry)
 *   3. catalogue provider-level typical window
 *   4. conservative fallback (unknown limit must still be bounded)
 */
export function resolveContextWindowTokens(input: {
  providerId: string;
  modelId: string;
  /** Per-model lookup supplied by the host (catalogue/discovery metadata). */
  lookupModelContextWindow?: (providerId: string, modelId: string) => number | undefined;
  /** Provider-level lookup (flagship typical window). */
  lookupProviderContextWindow?: (providerId: string) => number | undefined;
}): { contextWindowTokens: number; usedFallback: boolean } {
  const explicitModel = input.lookupModelContextWindow?.(input.providerId, input.modelId);
  if (typeof explicitModel === "number" && explicitModel > 0) {
    return { contextWindowTokens: explicitModel, usedFallback: false };
  }
  const providerLevel = input.lookupProviderContextWindow?.(input.providerId);
  if (typeof providerLevel === "number" && providerLevel > 0) {
    return { contextWindowTokens: providerLevel, usedFallback: false };
  }
  return { contextWindowTokens: FALLBACK_CONTEXT_WINDOW_TOKENS, usedFallback: true };
}

/** Classify the current context pressure into a zone. */
export function classifyContextPressure(
  estimatedTokens: number,
  contextWindowTokens: number,
): ContextPressure {
  const safeWindow = contextWindowTokens > 0 ? contextWindowTokens : FALLBACK_CONTEXT_WINDOW_TOKENS;
  // Budget headroom: the model's window also carries the system prompt,
  // tool definitions, and the upcoming response — compact well before the
  // raw window is full. 50% working margin is deliberately conservative.
  const usableTokens = Math.floor(safeWindow * 0.5);
  const ratio = usableTokens > 0 ? estimatedTokens / usableTokens : 1;
  const zone: CompactionZone =
    ratio >= COMPACT_BELOW_RATIO
      ? "compact"
      : ratio >= PREPARE_BELOW_RATIO
        ? "prepare"
        : ratio >= MONITOR_BELOW_RATIO
          ? "monitor"
          : "normal";
  return {
    estimatedTokens,
    contextWindowTokens: safeWindow,
    ratio,
    zone,
    usedFallback: false,
  };
}

/**
 * Evaluate whether compaction should run for a conversation. Pure — the
 * engine applies side effects only when this returns zone "compact".
 */
export function evaluateCompactionNeed(input: {
  conversation: PersistedConversationMessage[];
  providerId: string;
  modelId: string;
  lookupModelContextWindow?: (providerId: string, modelId: string) => number | undefined;
  lookupProviderContextWindow?: (providerId: string) => number | undefined;
}): ContextPressure & { shouldCompact: boolean } {
  const { contextWindowTokens, usedFallback } = resolveContextWindowTokens(input);
  const estimatedTokens = estimateConversationTokens(input.conversation);
  const pressure = classifyContextPressure(estimatedTokens, contextWindowTokens);
  return { ...pressure, usedFallback, shouldCompact: pressure.zone === "compact" };
}
