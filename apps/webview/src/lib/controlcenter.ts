// ============================================================================
// Control Center — pure derivation + view-state helpers (frontend only)
//
// EVERYTHING here is derived from data the host already sends: tool events,
// approvals, ChangeSet entries, provider/usage payloads, problems counts.
// Nothing invents runtime facts: a signal the backend does not emit renders
// as an explicit "Not available" state instead of a fabricated value.
//
// Status is never conveyed by color alone: every helper emits a text label.
// ============================================================================

import {
  computeDiffStats,
  isTerminalToolName,
  type FileChange,
} from "./messages.js";
import type { ToolEvent } from "../types";

// ---------------------------------------------------------------------------
// Run phases — the complete autonomous-workflow lifecycle
// ---------------------------------------------------------------------------

/**
 * The primary-screen run states. Extends the existing TaskPhase set with the
 * two terminal states the workflow can reach that the backend does not yet
 * distinguish: CANCELLED (the user pressed stop) and INCOMPLETE (the turn
 * ended without a final answer, e.g. max-iterations).
 */
export type ControlCenterPhase =
  | "idle"
  | "planning"
  | "executing"
  | "approval"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled"
  | "incomplete";

export interface ControlCenterPhaseInput {
  isRunning: boolean;
  statusMessage: string;
  runningToolName?: string;
  pendingApprovals: number;
  /** An explicit user stop is in flight (agent/stop sent, host not yet idle). */
  cancelRequested: boolean;
  /** Real verification work is in flight (e.g. self-healing re-check). */
  verifying: boolean;
  /**
   * Local heuristic: the model kept calling tools until the iteration budget
   * ended. Derived only from REAL host text — never fabricated.
   */
  endedWithoutFinalAnswer: boolean;
  /** Settled outcome for the turn: completed | failed | stopped | null. */
  outcome: "completed" | "stopped" | "paused" | "failed" | null;
}

const PHASE_LABELS: Record<ControlCenterPhase, string> = {
  idle: "Ready",
  planning: "Planning",
  executing: "Executing",
  approval: "Waiting for approval",
  verifying: "Verifying",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  incomplete: "Incomplete",
};

const PHASE_TONES: Record<
  ControlCenterPhase,
  "muted" | "info" | "warning" | "success" | "danger" | "neutral"
> = {
  idle: "muted",
  planning: "info",
  executing: "info",
  approval: "warning",
  verifying: "info",
  completed: "success",
  failed: "danger",
  cancelled: "neutral",
  incomplete: "warning",
};

export function controlCenterPhaseLabel(phase: ControlCenterPhase): string {
  return PHASE_LABELS[phase];
}

export function controlCenterPhaseTone(
  phase: ControlCenterPhase,
): "muted" | "info" | "warning" | "success" | "danger" | "neutral" {
  return PHASE_TONES[phase];
}

/** Host phrases that map honestly onto PLANNING while a run is active. */
const PLANNING_MARKERS = [
  "plan",
  "planning",
  "analyzing",
  "inspecting",
  "exploring",
  "reviewing",
];

/**
 * Derive the Control Center phase. Priority mirrors what actually blocks or
 * settles a run: a requested cancel wins, then approvals (the agent is
 * literally waiting), then verification evidence, then the active tool, then
 * planning markers, then the settled outcome, then idle.
 */
export function deriveControlCenterPhase(
  input: ControlCenterPhaseInput,
): ControlCenterPhase {
  if (input.cancelRequested) return "cancelled";
  if (input.pendingApprovals > 0) return "approval";
  if (input.isRunning) {
    if (input.runningToolName) {
      return "executing";
    }
    if (input.verifying) {
      return "verifying";
    }
    const msg = input.statusMessage.toLowerCase();
    if (PLANNING_MARKERS.some((m) => msg.includes(m))) return "planning";
    return "executing";
  }
  if (input.endedWithoutFinalAnswer) return "incomplete";
  switch (input.outcome) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
      return "cancelled";
    case "paused":
      return "cancelled";
    default:
      return "idle";
  }
}

// ---------------------------------------------------------------------------
// Activity timeline rows — derived from real ToolEvents
// ---------------------------------------------------------------------------

export type ActivityKind =
  "tool" | "approval" | "failure" | "retry" | "verification" | "completion";

export interface ActivityRowView {
  id: string;
  kind: ActivityKind;
  /** Text label — status is never conveyed by color alone. */
  label: string;
  detail?: string;
  durationMs?: number;
  state: "running" | "ok" | "error" | "done";
}

/**
 * Map real ToolEvents to timeline rows. No timestamps exist on ToolEvent, so
 * rows keep the transcript's chronological order instead of inventing times.
 */
export function buildActivityRows(events: ToolEvent[]): ActivityRowView[] {
  return events.map((e) => {
    if (e.status === "error") {
      return {
        id: e.id,
        kind: "failure",
        label: e.name,
        detail: e.detail,
        durationMs: e.durationMs,
        state: "error",
      };
    }
    const command = isTerminalToolName(e.name);
    return {
      id: e.id,
      kind: "tool",
      label: e.name,
      detail: e.detail,
      durationMs: e.durationMs,
      state: e.status === "started" ? "running" : "ok",
      ...(command && e.status !== "started"
        ? { kind: "verification" as const }
        : {}),
    };
  });
}

/**
 * "Retries" are visible when the same tool produced an error and then ran
 * again (a real, observable pattern in the event stream).
 */
export function countRetries(events: ToolEvent[]): number {
  let retries = 0;
  const failed = new Set<string>();
  for (const e of events) {
    if (e.status === "error") {
      failed.add(e.name);
    } else if (e.status === "completed" && failed.has(e.name)) {
      retries += 1;
      failed.delete(e.name);
    }
  }
  return retries;
}

// ---------------------------------------------------------------------------
// Verification — five explicit, honest states
// ---------------------------------------------------------------------------

export type VerificationStatus =
  "not-verified" | "verifying" | "verified" | "failed" | "not-available";

export interface VerificationView {
  status: VerificationStatus;
  label: string;
  /** Human explanation of WHY this state holds (never invented). */
  detail: string;
}

export const VERIFICATION_COPY: Record<VerificationStatus, string> = {
  "not-verified": "Not verified",
  verifying: "Verifying…",
  verified: "Verified",
  failed: "Verification failed",
  "not-available": "Verification not available",
};

export function verificationLabel(status: VerificationStatus): string {
  return VERIFICATION_COPY[status];
}

/**
 * Derive the turn's verification state from real signals only.
 *
 * `not-verified` is the default after a completed turn: the agent finishing
 * is NOT evidence that anything was verified. `not-available` marks signals
 * the backend does not emit (build/tests/typecheck/security results).
 */
export function deriveVerificationState(input: {
  outcome: "completed" | "stopped" | "paused" | "failed" | null;
  problemsCount: number | null;
  failedCommands: number;
  okCommands: number;
  healingActive: boolean;
  healingSucceeded: boolean | null;
}): VerificationView {
  if (input.healingActive) {
    return {
      status: "verifying",
      label: VERIFICATION_COPY.verifying,
      detail: "Self-healing is re-checking the workspace after a failure.",
    };
  }
  if (input.outcome !== "completed") {
    return {
      status: "not-verified",
      label: VERIFICATION_COPY["not-verified"],
      detail:
        "The turn did not complete, so nothing was verified in this workflow.",
    };
  }
  if (input.failedCommands > 0) {
    return {
      status: "failed",
      label: VERIFICATION_COPY.failed,
      detail: `${input.failedCommands} command${input.failedCommands === 1 ? "" : "s"} failed during the run — verification failed.`,
    };
  }
  if (input.okCommands > 0 && input.problemsCount === 0) {
    return {
      status: "verified",
      label: VERIFICATION_COPY.verified,
      detail: `${input.okCommands} command${input.okCommands === 1 ? "" : "s"} succeeded and the workspace reports no problems.`,
    };
  }
  if (input.okCommands > 0) {
    return {
      status: "verifying",
      label: VERIFICATION_COPY.verifying,
      detail: `Commands succeeded (${input.okCommands}); ${input.problemsCount} problem${input.problemsCount === 1 ? "" : "s"} still reported — check Problems before trusting the result.`,
    };
  }
  return {
    status: "not-verified",
    label: VERIFICATION_COPY["not-verified"],
    detail:
      "The agent completed without running any verification evidence (no commands were executed).",
  };
}

/** One evidence row in the verification panel. */
export interface VerificationEvidenceRow {
  key: string;
  label: string;
  value: string;
  /** "unavailable" rows render explicitly as "Not available". */
  kind: "evidence" | "unavailable";
}

/**
 * Evidence rows for the panel. Build/test/typecheck/security are flagged
 * unavailable: the backend does not emit dedicated results for them yet
 * (frontend blocked by missing runtime data).
 */
export function verificationEvidenceRows(input: {
  problemsCount: number | null;
  okCommands: number;
  failedCommands: number;
}): VerificationEvidenceRow[] {
  return [
    {
      key: "problems",
      label: "Problems",
      value:
        input.problemsCount === null
          ? "Not checked"
          : input.problemsCount === 0
            ? "0 — clean"
            : String(input.problemsCount),
      kind: input.problemsCount === null ? "unavailable" : "evidence",
    },
    {
      key: "commands",
      label: "Commands run",
      value:
        input.okCommands + input.failedCommands === 0
          ? "None"
          : `${input.okCommands} ok · ${input.failedCommands} failed`,
      kind: "evidence",
    },
    {
      key: "tests",
      label: "Tests",
      value: "Not available",
      kind: "unavailable",
    },
    {
      key: "build",
      label: "Build",
      value: "Not available",
      kind: "unavailable",
    },
    {
      key: "typecheck",
      label: "Typecheck",
      value: "Not available",
      kind: "unavailable",
    },
    {
      key: "security",
      label: "Security checks",
      value: "Not available",
      kind: "unavailable",
    },
  ];
}

// ---------------------------------------------------------------------------
// Cost / usage — display-only, honest about absence
// ---------------------------------------------------------------------------

export interface CostView {
  /** e.g. "1.2k → 340 tok" */
  tokens: string;
  /** Only when the provider actually reported a cost. */
  cost?: string;
  /** Explicit when the provider gave no cost figure. */
  costUnavailableReason: string;
  model: string;
  provider: string;
}

export function formatCostView(input: {
  inputTokens: number;
  outputTokens: number;
  totalCost?: number;
  model: string;
  provider: string;
}): CostView {
  const k = (n: number): string =>
    n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  return {
    tokens: `${k(input.inputTokens)} → ${k(input.outputTokens)} tok`,
    ...(input.totalCost != null && input.totalCost > 0
      ? { cost: `$${input.totalCost.toFixed(4)}` }
      : {}),
    costUnavailableReason:
      input.totalCost == null || input.totalCost <= 0
        ? `Estimated cost not available — ${input.provider} did not report pricing for this run.`
        : "",
    model: input.model,
    provider: input.provider,
  };
}

// ---------------------------------------------------------------------------
// ChangeSet summary — reuses the existing FileChange view model
// ---------------------------------------------------------------------------

export interface ChangeSetSummary {
  total: number;
  added: number;
  modified: number;
  deleted: number;
  /** Files already applied to disk (real host status). */
  applied: number;
  /** Files rolled back by the user (real host status). */
  rolledBack: number;
  /** +N −N when the host supplied diff stats; otherwise null (never guessed). */
  additions: number | null;
  deletions: number | null;
}

/**
 * Summarize the current ChangeSet from the existing FileChange view model.
 * Status values come from the host (added/modified/deleted/applied/
 * rolled_back); diff stats are summed only when the host actually supplied
 * them — never estimated from content.
 */
export function summarizeChanges(changes: FileChange[]): ChangeSetSummary {
  const summary: ChangeSetSummary = {
    total: changes.length,
    added: 0,
    modified: 0,
    deleted: 0,
    applied: 0,
    rolledBack: 0,
    additions: null,
    deletions: null,
  };
  let sawStats = false;
  for (const c of changes) {
    if (c.status === "added") summary.added += 1;
    else if (c.status === "modified") summary.modified += 1;
    else if (c.status === "deleted") summary.deleted += 1;
    else if (c.status === "applied") summary.applied += 1;
    else if (c.status === "rolled_back") summary.rolledBack += 1;
    // Diff stats are real only when the change carries the host's diff text;
    // they are computed by the existing, unit-tested line counter.
    if (c.diff) {
      sawStats = true;
      const s = computeDiffStats(c.diff);
      summary.additions = (summary.additions ?? 0) + s.additions;
      summary.deletions = (summary.deletions ?? 0) + s.deletions;
    }
  }
  if (!sawStats) {
    summary.additions = null;
    summary.deletions = null;
  }
  return summary;
}
