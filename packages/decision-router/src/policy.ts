/**
 * CodePilot AI — Jev decision routing: workflow policy.
 *
 * Maps a validated RoutingDecision onto pre-existing CodePilot workflows.
 * This layer NEVER selects providers or models, never invents capability,
 * and never overrides an explicit user mode. The ONLY automatic behavior it
 * can produce requires two simultaneous opt-ins:
 *
 *   1. Jev routing enabled in assist mode (`codepilot.jev.mode: "assist"`), and
 *   2. the user dispatched the turn with agent mode "auto" (no explicit mode).
 *
 * Everything else resolves advisory metadata (workflow hint + reason) that is
 * recorded and displayed but changes nothing about the run.
 */

/** Pre-existing workflow buckets (no new agent loop). */
export type WorkflowHint =
  "fast" | "debug" | "test" | "capable" | "chat" | "default";

/**
 * Agent-mode hint for "auto" turns. `null` means "keep the user's mode" —
 * the only value used unless both assist opt-ins above hold.
 */
export type AssistMode = "ask" | "act" | null;

export interface ResolvedRouting {
  /** Which existing workflow bucket this turn belongs to. */
  workflow: WorkflowHint;
  /** Mode override for "auto" turns, or null to keep the user's mode. */
  assistMode: AssistMode;
  /** Human-readable, secret-free explanation for logs and status UI. */
  reason: string;
}

/** Intent → pre-existing workflow bucket. */
export function workflowForIntent(intent: string): WorkflowHint {
  switch (intent) {
    case "explain_code":
      return "fast";
    case "debug_error":
      return "debug";
    case "write_tests":
      return "test";
    case "refactor":
    case "generate_new_code":
      return "capable";
    case "general_chat":
      return "chat";
    case "uncertain":
    default:
      return "default";
  }
}

export interface ResolveRoutingOptions {
  /** True only when `codepilot.jev.mode` is "assist" (explicit opt-in). */
  assist: boolean;
  /** The agent mode the turn was dispatched with. */
  userMode: string;
  /** Minimum confidence to act on (defaults to the Jev 0.5 convention). */
  minConfidence?: number;
}

/**
 * Resolve a decision to a workflow hint plus an optional mode override.
 * Pure function — no I/O, no provider/model access.
 */
export function resolveRouting(
  decision: {
    intent: string;
    confidence: number;
    source: string;
  },
  options: ResolveRoutingOptions,
): ResolvedRouting {
  const workflow = workflowForIntent(decision.intent);
  const minConfidence =
    typeof options.minConfidence === "number" ? options.minConfidence : 0.5;

  if (
    !options.assist ||
    options.userMode !== "auto" ||
    decision.source === "uncertain" ||
    decision.intent === "uncertain" ||
    decision.confidence < minConfidence
  ) {
    const why =
      decision.intent === "uncertain" || decision.source === "uncertain"
        ? "uncertain classification — default routing preserved"
        : options.userMode !== "auto"
          ? `explicit mode "${options.userMode}" preserved`
          : "advisory routing — default behavior preserved";
    return { workflow, assistMode: null, reason: why };
  }

  // Assist + auto + confident: explanations and chat run lean (ask);
  // build/debug/test/refactor work runs the full agent (act).
  const assistMode: AssistMode =
    decision.intent === "explain_code" || decision.intent === "general_chat"
      ? "ask"
      : "act";
  return {
    workflow,
    assistMode,
    reason: `assist routing for auto mode: ${decision.intent} → ${assistMode}`,
  };
}
