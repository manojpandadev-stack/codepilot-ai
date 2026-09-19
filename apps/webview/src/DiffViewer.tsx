import { useState } from "react";
import { computeDiffStats, type FileChange } from "./lib/messages.js";
import { IconCheck, IconX } from "./lib/icons";
import { Button, EmptyState } from "./lib/ui";

// Re-export for existing consumers
export type { FileChange } from "./lib/messages.js";

interface DiffViewerProps {
  changes: FileChange[];
  onAccept: (path: string) => void;
  onReject: (path: string) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onRollback?: (path: string) => void;
  pendingApproval: boolean;
}

const STATUS_META: Record<
  FileChange["status"],
  { letter: string; label: string; cls: string }
> = {
  added: { letter: "A", label: "added", cls: "text-vscode-success-fg" },
  modified: { letter: "M", label: "modified", cls: "text-vscode-warning-fg" },
  deleted: { letter: "D", label: "deleted", cls: "text-vscode-error-fg" },
  applied: { letter: "✓", label: "applied", cls: "text-vscode-text-link" },
  rolled_back: { letter: "↩", label: "rolled back", cls: "text-vscode-desc" },
};

function DiffLine({ line, n }: { line: string; n?: number }) {
  let cls = "whitespace-pre";
  let tone = "text-vscode-fg/85";
  let marker = " ";
  let bg = "";
  if (line.startsWith("+")) {
    marker = "+";
    tone = "text-vscode-success-fg";
    bg = "bg-vscode-success-fg/10";
  } else if (line.startsWith("-")) {
    marker = "−";
    tone = "text-vscode-error-fg";
    bg = "bg-vscode-error-fg/10";
  } else if (line.startsWith("@@")) {
    tone = "text-vscode-text-link";
    bg = "bg-vscode-text-link/5";
  } else {
    tone = "text-vscode-desc";
  }
  return (
    <div className={`flex font-mono text-[11px] leading-5 ${bg}`}>
      <span className="w-9 flex-shrink-0 text-right pr-2 select-none text-vscode-desc/50">
        {n ?? ""}
      </span>
      <span className={`w-3 flex-shrink-0 text-center ${tone}`}>{marker}</span>
      <span className={`pr-3 flex-1 ${tone} ${cls}`}>{line || " "}</span>
    </div>
  );
}

/** Split a unified diff into hunks for cleaner rendering. */
function splitHunks(diff: string): string[][] {
  const lines = diff.split("\n");
  const hunks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (current) hunks.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) hunks.push(current);
  return hunks.length > 0
    ? hunks
    : [lines.filter((l) => !l.startsWith("---") && !l.startsWith("+++"))];
}

export function DiffViewer({
  changes,
  onAccept,
  onReject,
  onAcceptAll,
  onRejectAll,
  onRollback,
  pendingApproval,
}: DiffViewerProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(
    changes.length > 0 ? changes[0]!.path : null,
  );
  const selected =
    changes.find((c) => c.path === selectedPath) ?? changes[0] ?? null;

  const active = changes.filter(
    (c) =>
      c.status === "added" || c.status === "modified" || c.status === "deleted",
  );
  const totals = changes.reduce(
    (acc, c) => {
      const s = computeDiffStats(c.diff);
      acc.additions += s.additions;
      acc.deletions += s.deletions;
      return acc;
    },
    { additions: 0, deletions: 0 },
  );

  if (changes.length === 0) {
    return (
      <EmptyState
        title="No file changes to review"
        hint="File edits the agent proposes appear here as reviewable diffs before anything is written."
      />
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Summary bar */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-vscode-border flex-shrink-0 bg-vscode-bg">
        <span className="text-[12px] font-medium text-vscode-fg">
          {changes.length} file{changes.length !== 1 ? "s" : ""} changed
        </span>
        <span className="font-mono text-[11px]">
          <span className="text-vscode-success-fg">+{totals.additions}</span>{" "}
          <span className="text-vscode-error-fg">−{totals.deletions}</span>
        </span>
        {active.length < changes.length && (
          <span className="text-[10px] text-vscode-desc">
            ({active.length} pending)
          </span>
        )}
        <span className="flex-1" />
        {pendingApproval && active.length > 0 && (
          <>
            <Button
              variant="primary"
              onClick={onAcceptAll}
              aria-label="Accept all pending changes"
            >
              <IconCheck size={11} /> Accept all
            </Button>
            <Button
              variant="danger"
              onClick={onRejectAll}
              aria-label="Reject all pending changes"
            >
              <IconX size={11} /> Reject all
            </Button>
          </>
        )}
      </div>

      <div className="flex flex-1 overflow-hidden min-h-0 flex-col md:flex-row">
        {/* File list */}
        <div
          className="md:w-60 w-full border-b md:border-b-0 md:border-r border-vscode-border overflow-y-auto flex-shrink-0 max-h-40 md:max-h-none"
          role="listbox"
          aria-label="Changed files"
        >
          {changes.map((change) => {
            const meta = STATUS_META[change.status];
            const fileName = change.path.split(/[\\/]/).pop() ?? change.path;
            const stats = computeDiffStats(change.diff);
            const isSelected = selected?.path === change.path;
            return (
              <button
                key={`${change.changeSetId ?? "cs"}:${change.changeId ?? change.path}`}
                role="option"
                aria-selected={isSelected}
                onClick={() => setSelectedPath(change.path)}
                className={`w-full text-left px-3 py-1.5 border-b border-vscode-border/50 ${
                  isSelected
                    ? "bg-vscode-list-active text-vscode-list-active-fg"
                    : "hover:bg-vscode-list-hover"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={`font-mono text-[10px] font-bold ${meta.cls}`}
                  >
                    {meta.letter}
                  </span>
                  <span className="text-[11px] truncate flex-1">
                    {fileName}
                  </span>
                  {(stats.additions > 0 || stats.deletions > 0) && (
                    <span className="font-mono text-[9px] flex-shrink-0">
                      <span className="text-vscode-success-fg">
                        +{stats.additions}
                      </span>{" "}
                      <span className="text-vscode-error-fg">
                        −{stats.deletions}
                      </span>
                    </span>
                  )}
                </div>
                <div
                  className={`text-[9px] truncate ${isSelected ? "text-vscode-list-active-fg/70" : "text-vscode-desc"}`}
                >
                  {change.path}
                </div>
              </button>
            );
          })}
        </div>

        {/* Diff content */}
        <div className="flex-1 overflow-y-auto min-w-0">
          {selected ? (
            <>
              <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-vscode-border bg-vscode-panel/70 sticky top-0 z-10">
                <span className="text-[11px] font-mono text-vscode-fg break-all">
                  {selected.path}
                </span>
                <span
                  className={`text-[9px] uppercase font-semibold tracking-wide ${STATUS_META[selected.status].cls}`}
                >
                  {STATUS_META[selected.status].label}
                </span>
                <span className="flex-1" />
                {active.some((c) => c.path === selected.path) &&
                  pendingApproval && (
                    <>
                      <Button
                        variant="primary"
                        size="xs"
                        onClick={() => onAccept(selected.path)}
                        aria-label={`Accept changes to ${selected.path}`}
                      >
                        Accept
                      </Button>
                      <Button
                        variant="danger"
                        size="xs"
                        onClick={() => onReject(selected.path)}
                        aria-label={`Reject changes to ${selected.path}`}
                      >
                        Reject
                      </Button>
                    </>
                  )}
                {selected.status === "applied" && onRollback && (
                  <Button
                    size="xs"
                    onClick={() => onRollback(selected.path)}
                    aria-label={`Roll back ${selected.path}`}
                    title="Restore this file to its content before the agent's edit"
                  >
                    ↩ Rollback
                  </Button>
                )}
                {selected.status === "rolled_back" && (
                  <span className="text-[10px] text-vscode-desc">
                    restored to original
                  </span>
                )}
              </div>

              <div className="py-2">
                {selected.diff ? (
                  splitHunks(selected.diff).map((hunk, hi) => (
                    <div key={hi} className="mb-2">
                      {hunk.map((line, li) => (
                        <DiffLine key={li} line={line} />
                      ))}
                    </div>
                  ))
                ) : selected.newContent ? (
                  <pre className="px-3 py-2 text-[11px] font-mono text-vscode-fg whitespace-pre-wrap break-words">
                    {selected.newContent}
                  </pre>
                ) : selected.status === "deleted" && selected.oldContent ? (
                  <pre className="px-3 py-2 text-[11px] font-mono text-vscode-error-fg whitespace-pre-wrap break-words">
                    {selected.oldContent}
                  </pre>
                ) : (
                  <div className="px-3 py-4 text-[12px] text-vscode-desc text-center">
                    No diff content available.
                  </div>
                )}
              </div>
            </>
          ) : (
            <EmptyState title="Select a file to view changes" />
          )}
        </div>
      </div>
    </div>
  );
}
