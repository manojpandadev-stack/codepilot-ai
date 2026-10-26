/**
 * CodePilot AI — Jev decision routing: typed intent contracts.
 *
 * The six supported developer-request intents plus the confidence /
 * complexity / decision envelope every router (Jev, deterministic fallback,
 * or future adapters) must produce. Validation is strict by design: a
 * classifier result that does not match this schema is treated as
 * "uncertain" by the caller and can never drive privileged behavior.
 */

/** Developer-request intents the router may report. */
export const INTENT_KINDS = [
  "generate_new_code",
  "debug_error",
  "write_tests",
  "explain_code",
  "refactor",
  "general_chat",
] as const;

/** One of the six supported intents. */
export type IntentKind = (typeof INTENT_KINDS)[number];

/**
 * Task complexity on the official 3-level rubric (mirrors the Jev Score
 * question: 0 = simple, 1 = moderate, 2 = complex).
 */
export type ComplexityLevel = 0 | 1 | 2;

/** Where a routing decision came from. */
export type DecisionSource = "jev" | "fallback" | "uncertain";

/**
 * Why an uncertain decision was produced. Never carries prompt contents —
 * safe to log and display.
 */
export type UncertainReason =
  | "low-confidence"
  | "invalid-response"
  | "timeout"
  | "unavailable"
  | "aborted"
  | "empty-input"
  | "not-configured";

/**
 * A validated routing decision. Advisory metadata ONLY: it selects among
 * pre-existing workflows and must never execute commands, approve edits,
 * bypass permissions, or invoke tools.
 */
export interface RoutingDecision {
  /** Classified intent, or "uncertain" when classification failed. */
  intent: IntentKind | "uncertain";
  /** Complexity level (0 = simple, 1 = moderate, 2 = complex). */
  complexity: ComplexityLevel;
  /** Calibrated confidence in [0, 1] (Jev) or heuristic score (fallback). */
  confidence: number;
  /** Which layer produced this decision. */
  source: DecisionSource;
  /** Present only when the Jev model itself answered (versioned model id). */
  modelId?: string;
  /** End-to-end classification latency in milliseconds. */
  latencyMs?: number;
  /** Present only on uncertain decisions. */
  reason?: UncertainReason;
}

/** True for exactly the six supported intent ids. */
export function isIntentKind(value: unknown): value is IntentKind {
  return (
    typeof value === "string" &&
    (INTENT_KINDS as readonly string[]).includes(value)
  );
}

/** True for a finite confidence number in [0, 1]. */
export function isValidConfidence(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

/** Clamp a raw score to a valid complexity level (rounds halves up). */
export function toComplexityLevel(value: number): ComplexityLevel {
  if (!Number.isFinite(value)) return 1;
  const rounded = Math.round(value);
  if (rounded <= 0) return 0;
  if (rounded >= 2) return 2;
  return 1;
}

/** Canonical uncertain decision. Never throws. */
export function uncertainDecision(
  reason: UncertainReason,
  latencyMs?: number,
): RoutingDecision {
  return {
    intent: "uncertain",
    complexity: 1,
    confidence: 0,
    source: "uncertain",
    reason,
    ...(latencyMs !== undefined ? { latencyMs } : {}),
  };
}
