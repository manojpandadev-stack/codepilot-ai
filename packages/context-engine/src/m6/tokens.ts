/**
 * M6 — Token estimation (documented deterministic approximation).
 *
 * CodePilot uses a chars/4 approximation (≈4 characters per token for code
 * and English prose). When an exact tokenizer becomes available for the
 * selected provider/model it should replace this in budget calculation only;
 * the approximation intentionally errs on the safe side for budgeting.
 */

export const CHARS_PER_TOKEN = 4;

/** Estimate token count for text. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Estimate tokens for a structured object (JSON serialization). */
export function estimateObjectTokens(obj: unknown): number {
  const serialized = JSON.stringify(obj);
  return estimateTokens(serialized);
}

/**
 * Deterministic query tokenizer used by ranking and RAG: lowercase, splits
 * camelCase/snake_case identifiers, drops 1-char tokens and pure numbers.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  // Split camelCase/snake_case identifiers BEFORE lowercasing so boundary
  // detection actually sees the case transitions.
  const segments = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_$]+/);
  for (const raw of segments) {
    if (!raw || /^\d+$/.test(raw) || raw.length < 2) continue;
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}
