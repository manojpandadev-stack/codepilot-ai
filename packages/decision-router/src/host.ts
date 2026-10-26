/**
 * CodePilot AI — Jev decision routing: host-side turn composition.
 *
 * Pure orchestration (no VS Code, no network imports): decides WHETHER a
 * remote classification may run (enabled flag + Local-only privacy gate +
 * credential presence), composes Jev → deterministic fallback → default
 * behavior, dedupes concurrent requests for the same turn, discards late
 * results for cancelled turns, and records content-free metrics.
 *
 * The extension host supplies credentials, settings, and status plumbing;
 * unit tests supply mocks.
 */
import { FallbackIntentRouter } from "./fallback.js";
import type { ClassifyOptions, IntentRouter } from "./router.js";
import {
  resolveRouting,
  type AssistMode,
  type WorkflowHint,
} from "./policy.js";
import { RoutingMetrics } from "./metrics.js";
import type { RoutingDecision } from "./intent.js";

/** Jev-related host settings (mirrors codepilot.jev.* configuration). */
export interface JevHostSettings {
  /** Master switch (default false — routing changes nothing when off). */
  enabled: boolean;
  /** "assist" allows auto-mode workflow selection; "advisory" only records. */
  assist: boolean;
  /** Jev model id or alias (informational here; used by the router factory). */
  model: string;
  /** Per-call classifier timeout in milliseconds. */
  timeoutMs: number;
  /** Minimum confidence to accept a Jev verdict. */
  confidenceThreshold: number;
  /** Authoritative privacy mode ("local" fail-closes remote classification). */
  privacyMode: string;
}

export interface JevHostDeps {
  settings: JevHostSettings;
  /**
   * Build the remote (Jev) router, or null when no API key is stored.
   * The key itself never leaves this closure. May be async (SecretStorage).
   */
  createRemoteRouter: () => IntentRouter | null | Promise<IntentRouter | null>;
  fallback: FallbackIntentRouter;
  metrics: RoutingMetrics;
  /** Secret-free log sink (output channel). */
  log?: (message: string) => void;
  /** Secret-free status sink (transcript status line). */
  onStatus?: (message: string) => void;
  /** True when the turn was cancelled after classification finished. */
  isCancelled?: (requestId: string) => boolean;
}

export interface TurnRoutingInput {
  /** Correlates dedup + late-result discard. Never sent anywhere. */
  requestId: string;
  /** Raw user request text (truncated before any remote send). */
  text: string;
  /** Agent mode the turn was dispatched with. */
  mode: string;
  /** Cancellation signal for the classification call. */
  signal?: AbortSignal;
}

export interface TurnRouting {
  decision: RoutingDecision;
  workflow: WorkflowHint;
  /** Mode override for "auto" turns, or null to keep the user's mode. */
  assistMode: AssistMode;
  /** True when a remote Jev request was made. */
  remote: boolean;
  /** Human-readable, secret-free explanation. */
  reason: string;
}

/**
 * Resolve routing for one turn. Returns null when routing is disabled
 * (caller proceeds exactly as before) or when a late result must be
 * discarded. Never throws: every failure path resolves to fallback metadata
 * or null, never to a blocked run.
 */
export async function resolveTurnRouting(
  deps: JevHostDeps,
  input: TurnRoutingInput,
  inflight: Map<string, Promise<TurnRouting | null>>,
): Promise<TurnRouting | null> {
  const existing = inflight.get(input.requestId);
  if (existing) return existing;
  const task = resolveTurnRoutingInner(deps, input).catch(() => null);
  inflight.set(input.requestId, task);
  try {
    return await task;
  } finally {
    if (inflight.get(input.requestId) === task) {
      inflight.delete(input.requestId);
    }
  }
}

async function resolveTurnRoutingInner(
  deps: JevHostDeps,
  input: TurnRoutingInput,
): Promise<TurnRouting | null> {
  const { settings } = deps;
  if (!settings.enabled) return null;

  const classifyOptions: ClassifyOptions = {
    ...(input.signal ? { signal: input.signal } : {}),
    timeoutMs: settings.timeoutMs,
  };

  // Local Only: no remote classification, ever. The deterministic fallback
  // is fully local and safe to use.
  if (settings.privacyMode === "local") {
    const decision = await deps.fallback.classify(
      { text: input.text, mode: input.mode },
      classifyOptions,
    );
    return finish(deps, input, decision, false, "cancelled");
  }

  const remote = await deps.createRemoteRouter();
  if (remote === null) {
    // No key stored: fall back locally (never fabricate, never fail).
    const decision = await deps.fallback.classify(
      { text: input.text, mode: input.mode },
      classifyOptions,
    );
    return finish(deps, input, decision, false, "cancelled");
  }

  const decision = await remote.classify(
    { text: input.text, mode: input.mode },
    classifyOptions,
  );
  if (decision.source === "jev") {
    return finish(deps, input, decision, true, "cancelled");
  }
  // Jev uncertain (low-confidence, invalid, timeout, unavailable, aborted):
  // best-effort local fallback; the timeout/abort kind is still recorded.
  const timedOut = decision.reason === "timeout";
  const aborted = decision.reason === "aborted";
  const fallbackDecision = await deps.fallback.classify(
    { text: input.text, mode: input.mode },
    classifyOptions,
  );
  if (aborted) {
    return finish(deps, input, fallbackDecision, false, "cancelled");
  }
  if (timedOut) {
    return finish(deps, input, fallbackDecision, false, "timeout");
  }
  return finish(deps, input, fallbackDecision, false, "cancelled");
}

function finish(
  deps: JevHostDeps,
  input: TurnRoutingInput,
  decision: RoutingDecision,
  remote: boolean,
  cancelledKind: "cancelled" | "timeout",
): TurnRouting | null {
  // Late-result guard: a turn cancelled while classifying must not change.
  if (input.signal?.aborted || deps.isCancelled?.(input.requestId)) {
    deps.metrics.record("cancelled", decision.latencyMs ?? 0);
    return null;
  }
  const resolved = resolveRouting(decision, {
    assist: deps.settings.assist,
    userMode: input.mode,
    minConfidence: deps.settings.confidenceThreshold,
  });
  if (decision.source === "jev") {
    deps.metrics.record("jev-success", decision.latencyMs ?? 0);
  } else if (cancelledKind === "timeout") {
    // A remote timeout that fell back locally: the notable event is the
    // timeout (the fallback outcome itself rides along in the decision).
    deps.metrics.record("timeout", decision.latencyMs ?? 0);
  } else {
    deps.metrics.record("fallback", decision.latencyMs ?? 0);
  }
  const summary =
    `Routing: ${decision.intent} · ${decision.source}` +
    ` (confidence ${decision.confidence.toFixed(2)}) → ${resolved.workflow}` +
    (resolved.assistMode ? ` · mode ${resolved.assistMode}` : "");
  deps.log?.(`[Jev] ${summary}`);
  deps.onStatus?.(summary);
  return {
    decision,
    workflow: resolved.workflow,
    assistMode: resolved.assistMode,
    remote,
    reason: resolved.reason,
  };
}
