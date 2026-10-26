// ============================================================================
// Task status strip — persistent control-center header for the Chat tab.
//
// Answers the five operator questions from REAL state only:
//   what the agent is doing   → phase + the host's own status message
//   what it changed           → active file-change count (opens Changes)
//   what it waits for         → pending approval count / review flag
//   how much it cost          → status bar (tokens/cost live there already)
//   whether the result is verified
//     → honest verification row: real signals render as counts, signals the
//       backend never reports render as "—" (never a fabricated checkmark).
// ============================================================================

import { useEffect, useState, type ReactNode } from "react";
import {
  healingNextActionLabel,
  healingPhaseLabel,
  deriveTaskPhase,
  isTerminalToolName,
  type HealingStatusState,
  type TaskPhase,
} from "../lib/messages.js";
import {
  deriveControlCenterPhase,
  controlCenterPhaseLabel,
  controlCenterPhaseTone,
  type ControlCenterPhase,
} from "../lib/controlcenter";
import { Badge, StatusDot, formatDuration, type Tone } from "../lib/ui";
import type { ToolEvent } from "../types";

const PHASE_META: Record<TaskPhase, { label: string; tone: Tone }> = {
  idle: { label: "Ready", tone: "muted" },
  working: { label: "Working", tone: "info" },
  thinking: { label: "Thinking", tone: "info" },
  generating: { label: "Generating", tone: "info" },
  reading: { label: "Reading files", tone: "info" },
  editing: { label: "Editing", tone: "info" },
  command: { label: "Running command", tone: "info" },
  searching: { label: "Searching", tone: "info" },
  git: { label: "Git", tone: "info" },
  web: { label: "Web", tone: "info" },
  planning: { label: "Planning", tone: "info" },
  approval: { label: "Waiting for approval", tone: "warning" },
  healing: { label: "Self-healing", tone: "warning" },
  completed: { label: "Completed", tone: "success" },
  stopped: { label: "Stopped", tone: "neutral" },
  paused: { label: "Paused", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
};

const RUNNING_PHASES = new Set<TaskPhase>([
  "working",
  "thinking",
  "generating",
  "reading",
  "editing",
  "command",
  "searching",
  "git",
  "web",
  "planning",
]);

/** Live elapsed seconds for the active turn (client-measured, real). */
function useElapsed(active: boolean, resetKey: string): number {
  const [start, setStart] = useState<number | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) {
      setStart(null);
      return;
    }
    setStart(Date.now());
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
    // resetKey restarts the timer when a new turn begins
  }, [active, resetKey]);
  return start !== null ? Date.now() - start : 0;
}

/**
 * The host message usually repeats the phase ("Waiting for approval…",
 * "Completed · …"); strip the shared prefix so only the extra information
 * ("· 12→340 tok") remains as detail text. "Idle" is a placeholder the App
 * falls back to when the host sent no message — it never adds information,
 * so it is dropped rather than shown next to a more specific badge.
 */
function messageTail(label: string, statusMessage: string): string {
  if (!statusMessage) return "";
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[.…:]+$/, "")
      .trim();
  const l = norm(label);
  const m = norm(statusMessage);
  if (m === "idle" && l !== "ready") return "";
  if (m === l) return "";
  if (m.startsWith(l)) {
    return statusMessage
      .slice(label.length)
      .trim()
      .replace(/^[-—:·]\s*/, "");
  }
  return statusMessage;
}

export interface TaskStatusStripProps {
  isRunning: boolean;
  statusMessage: string;
  toolEvents: ToolEvent[];
  /** Active (added/modified/deleted) file changes for the current set. */
  fileChangeCount: number;
  /** True while a staged ChangeSet awaits accept/reject review. */
  reviewPending: boolean;
  /** Pending M4 + MCP approval cards. */
  pendingApprovals: number;
  /** Latest Problems count from a real diagnostics pull, null = not checked. */
  problemsCount: number | null;
  healing: HealingStatusState | null;
  outcome: "completed" | "stopped" | "paused" | "failed" | null;
  /** CONTROL CENTER — true when the turn settled without a final answer. */
  turnIncomplete: boolean;
  /** Identifies the current turn — restarts the elapsed timer. */
  requestId: string | null;
  onOpenChanges: () => void;
  /** CONTROL CENTER — panels rendered between the strip and the transcript. */
  verificationPanel?: ReactNode;
  activityPanel?: ReactNode;
}

export function TaskStatusStrip({
  isRunning,
  statusMessage,
  toolEvents,
  fileChangeCount,
  reviewPending,
  pendingApprovals,
  problemsCount,
  healing,
  outcome,
  turnIncomplete,
  requestId,
  onOpenChanges,
  verificationPanel,
  activityPanel,
}: TaskStatusStripProps) {
  const healingActive = healing?.active ?? false;
  const elapsed = useElapsed(isRunning || healingActive, requestId ?? "");

  const runningTool = toolEvents.find((t) => t.status === "started");
  const phase = deriveTaskPhase({
    isRunning,
    statusMessage,
    runningToolName: runningTool?.name,
    pendingApprovals,
    healingActive,
    outcome,
  });
  // CONTROL CENTER — the primary-screen phase. Identical derivation rules
  // to the legacy phase plus the honest CANCELLED / INCOMPLETE refinements.
  const ccPhase: ControlCenterPhase = deriveControlCenterPhase({
    isRunning,
    statusMessage,
    runningToolName: runningTool?.name,
    pendingApprovals,
    cancelRequested: false,
    verifying: healingActive,
    endedWithoutFinalAnswer: outcome === "failed" && turnIncomplete,
    outcome,
  });
  const ccLabel = controlCenterPhaseLabel(ccPhase);
  const ccTone = controlCenterPhaseTone(ccPhase);
  // PHASE_META covers every TaskPhase by construction; the fallback only
  // satisfies noUncheckedIndexedAccess and can never render in practice.
  const legacyLabel = (PHASE_META[phase] ?? PHASE_META.idle).label;
  const detail = messageTail(
    ccLabel === legacyLabel ? ccLabel : legacyLabel,
    statusMessage,
  );
  const total = toolEvents.length;
  const done = toolEvents.filter((t) => t.status !== "started").length;
  const commandEvents = toolEvents.filter((t) => isTerminalToolName(t.name));
  const cmdOk = commandEvents.filter((t) => t.status === "completed").length;
  const cmdFailed = commandEvents.filter((t) => t.status === "error").length;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Task status and control center"
      className="flex-shrink-0 border-b border-vscode-border bg-vscode-panel/50 space-y-1"
    >
      <div className="px-3 py-1.5 cp-fade-up">
        {/* Row 1: Control-Center phase + the host's own words + real elapsed time */}
        <div className="flex items-center gap-2 min-w-0 text-[11px]">
          <StatusDot
            tone={ccTone}
            label={ccLabel}
            pulse={RUNNING_PHASES.has(phase) || healingActive}
            className="font-medium flex-shrink-0"
          />
          {detail && (
            <span className="truncate text-vscode-desc" title={detail}>
              {detail}
            </span>
          )}
          {(isRunning || healingActive) && (
            <span className="ml-auto font-mono text-vscode-desc flex-shrink-0">
              {formatDuration(elapsed)}
            </span>
          )}
        </div>

        {/* Row 2: real counters + honest verification (unknown → "—") */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-mono text-vscode-desc">
          {total > 0 && (
            <span title="Tool events for this turn">
              {done}/{total} tools
            </span>
          )}
          {fileChangeCount > 0 && (
            <button
              type="button"
              onClick={onOpenChanges}
              title="Open the Changes tab"
              className="rounded px-1 -mx-1 hover:bg-vscode-list-hover hover:text-vscode-fg transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focus-border"
            >
              {fileChangeCount} file{fileChangeCount === 1 ? "" : "s"}
              {reviewPending ? " · review" : ""}
            </button>
          )}
          {pendingApprovals > 0 && (
            <Badge
              tone="warning"
              title="Approve or deny in the transcript below"
            >
              {pendingApprovals} approval{pendingApprovals === 1 ? "" : "s"}{" "}
              pending
            </Badge>
          )}
          {cmdOk + cmdFailed > 0 && (
            <span title="Command tool outcomes for this turn">
              {cmdOk} ok{cmdFailed > 0 ? ` · ${cmdFailed} failed` : ""}
            </span>
          )}
          {problemsCount !== null && (
            <span title="VS Code Problems reported by the last diagnostics pull">
              {problemsCount} problem{problemsCount === 1 ? "" : "s"}
            </span>
          )}
          <span title="No build status is reported by the backend">
            build —
          </span>
          <span title="No test results are reported by the backend">
            tests —
          </span>
          {healingActive && (
            <span className="text-vscode-warning-fg" title="Self-healing phase">
              {healingPhaseLabel(healing!.phase)}
              {healingNextActionLabel(healing!.phase)
                ? ` · ${healingNextActionLabel(healing!.phase)}`
                : ""}{" "}
              (attempt {healing!.attempt}/{healing!.maxAttempts})
            </span>
          )}
        </div>
      </div>
      {/* CONTROL CENTER — honest verification + bounded activity timeline.
          Rendered inside the strip's wrapper so the Chat tab gets one
          contiguous status region instead of scattered bars. */}
      {verificationPanel}
      {activityPanel}
    </div>
  );
}
