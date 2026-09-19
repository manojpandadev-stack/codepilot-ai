// ============================================================================
// Continuity bar — session-scoped conversation continuity (M12 v5 UX)
//
// Slim, non-distracting strip above the chat transcript:
// - active chain  → "Continuing conversation · N turns" (+ optimized badge)
// - empty chain   → "New conversation" idle state
// - expandable    → per-turn safe metadata (newest first), no tool I/O
// - New button    → confirm → host reset (history preserved, chain cleared)
// All data comes from validated `continuity/state` host snapshots; the bar
// never stores conversation text and never triggers compaction.
// ============================================================================

import { useState } from "react";
import { Badge, Button, ConfirmCard, type Tone } from "../lib/ui";
import { IconChat, IconChevron, IconHistory, IconPlus } from "../lib/icons";
import type { ContinuityStateView, ContinuityTurnView } from "../lib/messages";

function turnTone(status: string): Tone {
  switch (status) {
    case "completed":
      return "success";
    case "running":
      return "info";
    case "interrupted":
    case "cancelled":
      return "warning";
    case "failed":
      return "danger";
    default:
      return "muted";
  }
}

function TurnRow({ turn }: { turn: ContinuityTurnView }) {
  return (
    <div className="flex items-start gap-2 rounded border border-vscode-border bg-vscode-panel/50 px-2 py-1.5">
      <span className="font-mono text-[10px] text-vscode-desc flex-shrink-0 mt-px">
        #{turn.turn}
      </span>
      <div className="flex-1 min-w-0">
        <div
          className="text-[11px] text-vscode-fg truncate"
          title={turn.title || turn.taskId}
        >
          {turn.title || "(untitled turn)"}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[9px] text-vscode-desc">
          <span>{new Date(turn.createdAtMs).toLocaleString()}</span>
          {turn.compacted && (
            <Badge tone="info" title="Earlier context in this turn was compacted">
              optimized
            </Badge>
          )}
          {turn.trimmed && (
            <Badge
              tone="warning"
              title="An interrupted tool exchange from this turn was withheld from later model context"
            >
              partial
            </Badge>
          )}
          {(turn.status === "interrupted" || turn.status === "cancelled") && (
            <Badge tone="warning">interrupted</Badge>
          )}
          {turn.status === "failed" && <Badge tone="danger">failed</Badge>}
        </div>
      </div>
      <Badge tone={turnTone(turn.status)} className="flex-shrink-0">
        {turn.status}
      </Badge>
    </div>
  );
}

export interface ContinuityBarProps {
  /** Validated host snapshot; null before the first snapshot arrives. */
  state: ContinuityStateView | null;
  /** While a turn runs, reset is disabled (guarded, never surprising). */
  isRunning: boolean;
  onReset: () => void;
}

export function ContinuityBar({ state, isRunning, onReset }: ContinuityBarProps) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const turns = state?.turns ?? [];
  const chainLength = state?.chainLength ?? 0;
  const showCompacted = state?.compacted ?? false;

  return (
    <div className="flex-shrink-0 border-b border-vscode-border bg-vscode-bg">
      <div className="flex items-center gap-2 px-3 py-1">
        <IconHistory size={12} className="text-vscode-desc flex-shrink-0" />
        {chainLength === 0 ? (
          <span
            className="text-[11px] text-vscode-desc"
            title="No previous turns are being sent to the model. History stays available in the History tab."
          >
            New conversation
          </span>
        ) : (
          <button
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} conversation context chain`}
            title="Previous turns are provided to the model. Select to inspect which turns are included."
            className="flex items-center gap-1 text-[11px] text-vscode-fg hover:text-vscode-text-link min-w-0"
          >
            <span className="truncate">
              Continuing conversation · {chainLength} turn{chainLength === 1 ? "" : "s"}
            </span>
            <IconChevron
              size={11}
              className={`flex-shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          </button>
        )}
        {showCompacted && chainLength > 0 && (
          <Badge
            tone="info"
            title="Earlier context was compacted into a summary to fit the model context window. Original history is preserved."
          >
            Context optimized
          </Badge>
        )}
        <span className="flex-1" />
        <Button
          size="xs"
          variant="ghost"
          onClick={() => setConfirming(true)}
          disabled={isRunning || confirming}
          aria-label="Start a new conversation"
          title={
            isRunning
              ? "Unavailable while a turn is running"
              : "Start a new conversation (history is preserved)"
          }
        >
          <IconPlus size={10} /> New
        </Button>
      </div>

      {confirming && (
        <div className="px-3 pb-2">
          <ConfirmCard
            title="Start a new conversation?"
            detail="Previous turns will stay in history but will no longer be included in new prompts."
            confirmLabel="Start New Conversation"
            onConfirm={() => {
              setConfirming(false);
              setExpanded(false);
              onReset();
            }}
            onCancel={() => setConfirming(false)}
          />
        </div>
      )}

      {expanded && chainLength > 0 && (
        <div className="px-3 pb-2 space-y-1 max-h-[220px] overflow-y-auto">
          <div className="flex items-center gap-1 text-[10px] text-vscode-desc">
            <IconChat size={10} />
            <span>
              Current conversation — newest first. Compacted turns contribute
              summaries; interrupted turns contribute text only.
            </span>
          </div>
          {[...turns].reverse().map((turn) => (
            <TurnRow key={turn.taskId} turn={turn} />
          ))}
          {state?.truncated && (
            <div className="text-[10px] text-vscode-desc">
              Older turns beyond the context window are no longer included.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
