// ============================================================================
// Execution status — replaces "Thinking... (generation 1)" with a premium
// execution indicator driven by REAL runtime state only.
// ============================================================================

import { useEffect, useState } from "react";
import { IconBolt, IconShield, IconTools } from "../lib/icons";
import { formatDuration } from "../lib/ui";
import {
  healingNextActionLabel,
  healingPhaseLabel,
  type HealingStatusState,
} from "../lib/messages.js";
import type { ToolEvent } from "../types";

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
 * Live execution strip shown while the agent runs or heals.
 * - shows the host-provided phase message verbatim (never invented progress)
 * - counts REAL tool events (completed / total)
 * - elapsed seconds measured client-side from run start
 */
export function ExecutionStatus({
  isRunning,
  statusMessage,
  toolEvents,
  healing,
  requestId,
}: {
  isRunning: boolean;
  statusMessage: string;
  toolEvents: ToolEvent[];
  healing: HealingStatusState | null;
  requestId: string | null;
}) {
  const elapsed = useElapsed(
    isRunning || (healing?.active ?? false),
    requestId ?? "",
  );

  if (healing?.active) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 px-3 py-1.5 border-b border-vscode-border bg-vscode-warning-fg/5 text-[11px] flex-shrink-0"
      >
        <IconShield
          size={13}
          className="text-vscode-warning-fg flex-shrink-0"
        />
        <span className="text-vscode-warning-fg font-medium flex-shrink-0">
          Self-healing
        </span>
        <span className="text-vscode-desc truncate">
          {healingPhaseLabel(healing.phase)}
          {healingNextActionLabel(healing.phase)
            ? ` · ${healingNextActionLabel(healing.phase)}`
            : ""}{" "}
          (attempt {healing.attempt}/{healing.maxAttempts})
          {healing.failureDetail ? ` — ${healing.failureDetail}` : ""}
        </span>
        <span className="ml-auto font-mono text-vscode-desc flex-shrink-0">
          {formatDuration(elapsed)}
        </span>
      </div>
    );
  }

  if (!isRunning) return null;

  const completed = toolEvents.filter((t) => t.status !== "started").length;
  const runningTool = toolEvents.find((t) => t.status === "started");

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 px-3 py-1.5 border-b border-vscode-border text-[11px] flex-shrink-0 cp-fade-up"
    >
      <IconBolt
        size={13}
        className="text-vscode-text-link flex-shrink-0 cp-pulse"
      />
      <span className="text-vscode-fg font-medium flex-shrink-0">Working</span>
      <span className="text-vscode-desc truncate">
        {runningTool
          ? `running ${runningTool.name}…`
          : statusMessage || "understanding the request"}
        {toolEvents.length > 0 &&
          ` · ${completed}/${toolEvents.length} tool${toolEvents.length === 1 ? "" : "s"}`}
      </span>
      <span className="ml-auto font-mono text-vscode-desc flex-shrink-0">
        {formatDuration(elapsed)}
      </span>
      <IconTools size={12} className="text-vscode-desc/60 flex-shrink-0" />
    </div>
  );
}

/** Terminal (post-run) healing outcome line. */
export function HealingOutcome({ healing }: { healing: HealingStatusState }) {
  if (healing.active) return null;
  return (
    <div
      role="status"
      className={`flex items-center gap-2 px-3 py-1.5 border-b border-vscode-border text-[11px] flex-shrink-0 ${
        healing.success ? "text-vscode-success-fg" : "text-vscode-error-fg"
      }`}
    >
      <IconShield size={13} className="flex-shrink-0" />
      <span className="truncate">
        {healing.success ? "Self-healing succeeded" : "Self-healing failed"} —{" "}
        {healing.message}
        {healing.failureDetail ? ` (${healing.failureDetail})` : ""}
      </span>
    </div>
  );
}
