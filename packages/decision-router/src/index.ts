/**
 * CodePilot AI — Jev decision routing (`@codepilot/decision-router`).
 *
 * Optional, isolated classification layer: Jev (TypeSafe AI System One)
 * intent + complexity decisions with strict schema validation, a
 * deterministic local fallback, an advisory-first workflow policy, and
 * content-free telemetry. See README-adjacent docs for the official SDK
 * verification record.
 */
export {
  INTENT_KINDS,
  isIntentKind,
  isValidConfidence,
  toComplexityLevel,
  uncertainDecision,
  type ComplexityLevel,
  type DecisionSource,
  type IntentKind,
  type RoutingDecision,
  type UncertainReason,
} from "./intent.js";
export {
  JEV_STATE_MAX_CHARS,
  type ClassifyInput,
  type ClassifyOptions,
  type IntentRouter,
} from "./router.js";
export { FallbackIntentRouter, FALLBACK_MIN_WEIGHT } from "./fallback.js";
export {
  JevIntentRouter,
  JEV_DEFAULT_CONFIDENCE_THRESHOLD,
  JEV_DEFAULT_MODEL,
  JEV_DEFAULT_TIMEOUT_MS,
  type JevRouterConfig,
  type JevSystemOneLike,
} from "./jev.js";
export {
  resolveRouting,
  workflowForIntent,
  type AssistMode,
  type ResolveRoutingOptions,
  type ResolvedRouting,
  type WorkflowHint,
} from "./policy.js";
export {
  RoutingMetrics,
  emptyRoutingMetrics,
  type RoutingMetricKind,
  type RoutingMetricsSnapshot,
} from "./metrics.js";
export {
  resolveTurnRouting,
  type JevHostDeps,
  type JevHostSettings,
  type TurnRouting,
  type TurnRoutingInput,
} from "./host.js";
export type {
  NoulSecuritySignal,
  RoutingAnalytics,
  ScoreContextSignal,
} from "./future.js";
