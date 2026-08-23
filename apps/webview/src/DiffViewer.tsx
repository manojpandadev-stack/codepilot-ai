import { useState } from "react";
import { computeDiffStats, type FileChange } from "./lib/messages.js";

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

const STATUS_STYLES: Record<FileChange["status"], string> = {
  added: "bg-green-900 text-green-300",
  modified: "bg-yellow-900 text-yellow-300",
  deleted: "bg-red-900 text-red-300",
  applied: "bg-blue-900 text-blue-300",
  rolled_back: "bg-gray-800 text-gray-300",
};

const FILE_ICONS: Record<FileChange["status"], { icon: string; color: string }> = {
  added: { icon: "A", color: "text-green-400" },
  deleted: { icon: "D", color: "text-red-400" },
  modified: { icon: "M", color: "text-yellow-400" },
  applied: { icon: "✓", color: "text-blue-400" },
  rolled_back: { icon: "↩", color: "text-gray-400" },
};

// ============================================================================
// Diff Line Renderer
// ============================================================================

function DiffLine({ line }: { line: string }) {
  let className = "px-3 py-0.5 font-mono text-[11px] whitespace-pre";
  if (line.startsWith("+")) {
    className += " bg-green-950 text-green-300";
  } else if (line.startsWith("-")) {
    className += " bg-red-950 text-red-300";
  } else if (line.startsWith("@@")) {
    className += " bg-blue-950 text-blue-300";
  } else {
    className += " text-vscode-desc";
  }
  return <div className={className}>{line || " "}</div>;
}

// ============================================================================
// DiffViewer
// ============================================================================

export function DiffViewer({
  changes,
  onAccept,
  onReject,
  onAcceptAll,
  onRejectAll,
  onRollback,
  pendingApproval,
}: DiffViewerProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(
    changes.length > 0 ? changes[0]!.path : null
  );

  // Keep the selection valid as the list shrinks/grows
  const selected = changes.find((c) => c.path === selectedFile) ?? changes[0];
  const activeCount = changes.filter(
    (c) => c.status === "added" || c.status === "modified" || c.status === "deleted"
  ).length;

  if (changes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-vscode-desc text-sm">
        No file changes to review.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Actions bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-vscode-border flex-shrink-0">
        <span className="text-[11px] font-semibold text-vscode-desc" aria-live="polite">
          {changes.length} file{changes.length !== 1 ? "s" : ""} changed
          {activeCount < changes.length ? ` (${activeCount} pending)` : ""}
        </span>
        <div className="flex-1" />
        {pendingApproval && activeCount > 0 && (
          <>
            <button
              onClick={onAcceptAll}
              aria-label="Accept all pending changes"
              className="text-[11px] px-2 py-1 rounded bg-green-900 text-green-300 hover:bg-green-800"
            >
              ✓ Accept All
            </button>
            <button
              onClick={onRejectAll}
              aria-label="Reject all pending changes"
              className="text-[11px] px-2 py-1 rounded bg-red-900 text-red-300 hover:bg-red-800"
            >
              ✗ Reject All
            </button>
          </>
        )}
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* File list */}
        <div className="w-56 border-r border-vscode-border overflow-y-auto flex-shrink-0" role="listbox" aria-label="Changed files">
          {changes.map((change) => {
            const { icon, color } = FILE_ICONS[change.status];
            const fileName = change.path.split(/[\\/]/).pop() ?? change.path;
            const stats = computeDiffStats(change.diff);
            return (
              <button
                key={`${change.changeSetId ?? "cs"}:${change.changeId ?? change.path}`}
                role="option"
                aria-selected={selected?.path === change.path}
                onClick={() => setSelectedFile(change.path)}
                className={`w-full text-left px-3 py-1.5 text-[11px] border-b border-vscode-border ${
                  selected?.path === change.path
                    ? "bg-vscode-editor-bg"
                    : "hover:bg-vscode-editor-bg"
                }`}
              >
                <span className={`font-mono font-semibold ${color} mr-1`}>
                  {icon}
                </span>
                <span className="text-vscode-fg">{fileName}</span>
                {(stats.additions > 0 || stats.deletions > 0) && (
                  <span className="ml-1 font-mono text-[9px]">
                    <span className="text-green-400">+{stats.additions}</span>{" "}
                    <span className="text-red-400">−{stats.deletions}</span>
                  </span>
                )}
                <div className="text-[9px] text-vscode-desc truncate">
                  {change.path}
                </div>
              </button>
            );
          })}
        </div>

        {/* Diff content */}
        <div className="flex-1 overflow-y-auto">
          {selected ? (
            <div>
              {/* File header */}
              <div className="flex items-center gap-2 px-3 py-2 bg-vscode-editor-bg border-b border-vscode-border sticky top-0">
                <span className="text-[11px] font-mono text-vscode-fg">
                  {selected.path}
                </span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_STYLES[selected.status]}`}>
                  {selected.status}
                </span>
                <div className="flex-1 flex justify-end gap-2">
                  {(selected.status === "added" || selected.status === "modified" || selected.status === "deleted") && pendingApproval && (
                    <>
                      <button
                        onClick={() => onAccept(selected.path)}
                        aria-label={`Accept changes to ${selected.path}`}
                        className="text-[10px] px-2 py-0.5 rounded bg-green-900 text-green-300 hover:bg-green-800"
                      >
                        ✓ Accept
                      </button>
                      <button
                        onClick={() => onReject(selected.path)}
                        aria-label={`Reject changes to ${selected.path}`}
                        className="text-[10px] px-2 py-0.5 rounded bg-red-900 text-red-300 hover:bg-red-800"
                      >
                        ✗ Reject
                      </button>
                    </>
                  )}
                  {selected.status === "applied" && onRollback && (
                    <button
                      onClick={() => onRollback(selected.path)}
                      aria-label={`Roll back ${selected.path} to its previous content`}
                      title="Restore this file to its content before the agent's edit"
                      className="text-[10px] px-2 py-0.5 rounded bg-orange-900 text-orange-300 hover:bg-orange-800"
                    >
                      ↩ Rollback
                    </button>
                  )}
                  {selected.status === "rolled_back" && (
                    <span className="text-[10px] text-vscode-desc">restored to original</span>
                  )}
                </div>
              </div>

              {/* Diff lines */}
              <div className="overflow-x-auto">
                {selected.diff ? (
                  selected.diff.split("\n").map((line, i) => (
                    <DiffLine key={i} line={line} />
                  ))
                ) : selected.newContent ? (
                  <pre className="px-3 py-2 text-[11px] font-mono text-vscode-fg whitespace-pre-wrap">
                    {selected.newContent}
                  </pre>
                ) : selected.status === "deleted" && selected.oldContent ? (
                  <pre className="px-3 py-2 text-[11px] font-mono text-red-300 whitespace-pre-wrap">
                    {selected.oldContent}
                  </pre>
                ) : (
                  <div className="px-3 py-4 text-sm text-vscode-desc text-center">
                    No diff content available.
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-vscode-desc text-sm">
              Select a file to view changes.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
