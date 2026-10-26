/**
 * CodePilot AI — Jev decision routing: the IntentRouter interface.
 *
 * A router turns a developer request into a validated RoutingDecision. It is
 * a pure classifier: implementations must not perform side effects (no tool
 * calls, no approvals, no file or network writes beyond their own single
 * classification request).
 */
import type { RoutingDecision } from "./intent.js";

/** Minimal classifier input — the user request plus its dispatch mode. */
export interface ClassifyInput {
  /**
   * Raw user request text. Callers MUST truncate before sending (the host
   * caps at JEV_STATE_MAX_CHARS); routers truncate defensively as well.
   */
  text: string;
  /** The agent mode the turn was sent with (advisory metadata only). */
  mode?: string;
  /** Correlates retries/dedup; never sent to any remote service. */
  taskId?: string;
}

/** Per-call controls. */
export interface ClassifyOptions {
  /** Cancellation signal — an aborted turn resolves uncertain, never late. */
  signal?: AbortSignal;
  /** Per-attempt timeout in milliseconds (router default when omitted). */
  timeoutMs?: number;
}

/**
 * Maximum characters of user text forwarded to a remote classifier.
 * Jev accepts text only; full source files are never uploaded to classify.
 */
export const JEV_STATE_MAX_CHARS = 2000;

/** A decision-layer classifier. */
export interface IntentRouter {
  /** Stable router name for metrics and status messages. */
  readonly name: string;
  /**
   * Classify one request. Resolves (never rejects on operational failures)
   * to a validated RoutingDecision; malformed, low-confidence, timed-out,
   * unavailable, and aborted outcomes all resolve "uncertain".
   */
  classify(
    input: ClassifyInput,
    options?: ClassifyOptions,
  ): Promise<RoutingDecision>;
}
