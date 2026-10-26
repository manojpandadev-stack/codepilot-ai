// ============================================================================
// Activity timeline — the agent's action history for the current turn.
//
// Rows are derived ONLY from real runtime data: tool events (started /
// completed / error), pending approvals, and the settled turn outcome.
// Nothing is fabricated: no timestamps the backend does not send, no
// invented verification steps. The list is bounded (MAX_TIMELINE_ROWS) so
// long tool histories never flood the DOM; older rows collapse into a
// count with an explicit disclosure.
// ============================================================================

import { useMemo, useState } from "react";
import { IconCheck, IconBolt, IconX } from "../lib/icons";
import { Badge, formatDuration } from "../lib/ui";
import { countRetries, type ActivityRowView } from "../lib/controlcenter";
import { recoveryRowView, type RecoveryEventMsg } from "../lib/messages";
import type { ToolEvent } from "../types";

/** Max rows rendered before the oldest collapse behind a disclosure. */
const MAX_TIMELINE_ROWS = 60;

const KIND_LABEL: Record<ActivityRowView["kind"], string> = {
  tool: "tool call",
  approval: "approval",
  failure: "failure",
  retry: "retry",
  verification: "verification",
  completion: "completion",
};

function rowGlyph(row: ActivityRowView) {
  if (row.state === "running")
    return <IconBolt size={12} className="cp-pulse text-vscode-text-link" />;
  if (row.state === "error")
    return <IconX size={12} className="text-vscode-error-fg" />;
  if (row.kind === "verification")
    return <IconCheck size={12} className="text-vscode-success-fg" />;
  return <IconCheck size={12} className="text-vscode-desc" />;
}

function TimelineRow({ row }: { row: ActivityRowView }) {
  const glyph = rowGlyph(row);
  return (
    <li
      className="flex items-center gap-2 px-2.5 py-1 rounded hover:bg-vscode-list-hover/60 text-[11px]"
      title={
        row.detail
          ? `${row.label}: ${row.detail}`
          : `${KIND_LABEL[row.kind]}: ${row.label}`
      }
    >
      <span className="flex-shrink-0 w-4 flex items-center justify-center">
        {glyph}
      </span>
      <span className="font-mono font-medium text-vscode-fg truncate max-w-[40%]">
        {row.label}
      </span>
      <span className="text-[9px] uppercase tracking-wider text-vscode-desc flex-shrink-0">
        {KIND_LABEL[row.kind]}
      </span>
      {row.detail && (
        <span className="text-[10px] text-vscode-desc truncate">
          {row.detail}
        </span>
      )}
      {row.durationMs != null && (
        <span className="ml-auto font-mono text-[10px] text-vscode-desc flex-shrink-0">
          {formatDuration(row.durationMs)}
        </span>
      )}
    </li>
  );
}

export function ActivityTimeline({
  toolEvents,
  pendingApprovals,
  outcome,
  recovery,
}: {
  toolEvents: ToolEvent[];
  /** Pending M4 + MCP approval cards (real blocking state). */
  pendingApprovals: number;
  /** Settled outcome of the turn, if any. */
  outcome: "completed" | "stopped" | "paused" | "failed" | null;
  /** Recovery events from the autonomous debug engine (validated + bounded). */
  recovery?: RecoveryEventMsg[];
}) {
  const [showAll, setShowAll] = useState(false);

  const rows = useMemo(() => {
    const toolRows: Array<ActivityRowView> = toolEvents.map((e) => ({
      id: e.id,
      kind:
        e.status === "error"
          ? "failure"
          : e.status === "started"
            ? "tool"
            : "tool",
      label: e.name,
      detail: e.detail,
      durationMs: e.durationMs,
      state:
        e.status === "started"
          ? "running"
          : e.status === "error"
            ? "error"
            : "ok",
    }));
    // Pending approvals surface as blocking rows the user must resolve.
    const approvalRows: Array<ActivityRowView> = Array.from(
      { length: Math.min(pendingApprovals, 20) },
      (_, i) => ({
        id: `approval-pending-${i}`,
        kind: "approval" as const,
        label: "Approval required",
        detail: "Waiting for your decision",
        state: "running" as const,
      }),
    );
    // Completion row — only for real outcomes the runtime reported.
    const completionRows: Array<ActivityRowView> =
      outcome !== null
        ? [
            {
              id: "turn-outcome",
              kind: "completion" as const,
              label:
                outcome === "completed"
                  ? "Turn completed"
                  : outcome === "failed"
                    ? "Turn failed"
                    : outcome === "paused"
                      ? "Turn paused"
                      : "Turn stopped",
              state:
                outcome === "completed"
                  ? ("done" as const)
                  : ("error" as const),
            },
          ]
        : [];
    // Recovery rows (FAILURE_DETECTED → … → RECOVERY_COMPLETED) sit between
    // the tool history and the turn outcome — chronologically the recovery
    // cycle follows the failure the tools produced.
    const recoveryRows: Array<ActivityRowView> = (recovery ?? []).map(
      recoveryRowView,
    );
    return [...approvalRows, ...toolRows, ...recoveryRows, ...completionRows];
  }, [toolEvents, pendingApprovals, outcome, recovery]);

  const retries = useMemo(() => countRetries(toolEvents), [toolEvents]);
  const hidden = showAll ? 0 : Math.max(0, rows.length - MAX_TIMELINE_ROWS);
  const visible = showAll ? rows : rows.slice(rows.length - MAX_TIMELINE_ROWS);

  if (rows.length === 0 && retries === 0) {
    return (
      <section
        aria-label="Agent activity"
        className="flex-shrink-0 border-b border-vscode-border px-3 py-2"
      >
        <div className="text-[11px] font-semibold text-vscode-title mb-1">
          Activity
        </div>
        <p className="text-[10px] text-vscode-desc">
          No activity yet — tool calls, approvals, and results appear here as
          the agent works.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label="Agent activity"
      className="flex-shrink-0 border-b border-vscode-border px-3 py-2"
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[11px] font-semibold text-vscode-title">
          Activity
        </span>
        {retries > 0 && (
          <Badge tone="warning" title="A tool failed and then ran again">
            {retries} retr{retries === 1 ? "y" : "ies"}
          </Badge>
        )}
        <span className="ml-auto font-mono text-[10px] text-vscode-desc">
          {rows.length} event{rows.length === 1 ? "" : "s"}
        </span>
      </div>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          aria-label={`Show ${hidden} older activity entries`}
          className="w-full text-left text-[10px] text-vscode-text-link hover:underline px-2.5 py-0.5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focus-border"
        >
          + {hidden} older entr{hidden === 1 ? "y" : "ies"} hidden — show all
        </button>
      )}
      <ul className="space-y-px" aria-live="polite">
        {visible.map((row) => (
          <TimelineRow key={row.id} row={row} />
        ))}
      </ul>
    </section>
  );
}
