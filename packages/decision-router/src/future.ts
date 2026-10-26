/**
 * CodePilot AI — Jev decision routing: future extension points (Phase 7).
 *
 * Interfaces ONLY — nothing here is executed in this phase. They reserve
 * the shape for Score-based context relevance, Noul-based security signals,
 * and routing analytics WITHOUT implementing them.
 *
 * Hard rule carried into any future implementation: a probabilistic signal
 * must never authorize a dangerous operation and must never trigger
 * automatic deletion of context. Deterministic security checks and explicit
 * user approval stay authoritative; these signals may only ADVISE (route to
 * review, attach a warning, suggest keeping context).
 */
import type { RoutingDecision } from "./intent.js";

/**
 * A future Score-based context-relevance signal: "how relevant is this
 * context item to the request" on an ordered rubric. Advisory only.
 */
export interface ScoreContextSignal {
  /** Stable signal name (e.g. "context-relevance"). */
  name: string;
  /** Subject the score describes (file path, symbol id — never contents). */
  subject: string;
  /** Score value on the signal's own rubric. */
  score: number;
  /** Calibrated confidence in [0, 1]. */
  confidence: number;
}

/**
 * A future Noul-based security signal: probability that content is risky.
 * MAY route a turn to human review; MUST NOT approve, authorize, or execute
 * anything on its own.
 */
export interface NoulSecuritySignal {
  /** Stable signal name (e.g. "prompt-injection-risk"). */
  name: string;
  /** Probability the flagged condition holds, in [0, 1]. */
  probability: number;
  /** What a high probability means for reviewers (no contents). */
  description: string;
}

/**
 * A future routing-analytics sink: compares Jev routing against baseline
 * behavior over aggregate decisions. Receives decisions and outcomes only —
 * never prompts, files, or secrets.
 */
export interface RoutingAnalytics {
  /** Record one resolved routing outcome for aggregate comparison. */
  recordOutcome(entry: {
    decision: RoutingDecision;
    workflow: string;
    /** Milliseconds from dispatch to terminal turn state. */
    turnLatencyMs: number;
    /** Terminal state of the turn ("completed" | "stopped" | "failed"). */
    terminalState: string;
  }): void;
}
