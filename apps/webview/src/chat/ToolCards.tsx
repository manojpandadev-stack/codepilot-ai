// ============================================================================
// Tool execution cards + approval cards (chat stream)
// ============================================================================

import { useState } from "react";
import {
  IconBolt,
  IconChevron,
  IconCheck,
  IconShield,
  IconTerminal,
  IconWarning,
  IconX,
} from "../lib/icons";
import { Badge, Button, formatDuration, type Tone } from "../lib/ui";
import { isTerminalToolName } from "../lib/messages";
import type { M4ApprovalRequest, ToolEvent } from "../types";

// ---------------------------------------------------------------------------
// Tool execution card
// ---------------------------------------------------------------------------

const TOOL_TONE: Record<ToolEvent["status"], Tone> = {
  started: "info",
  completed: "success",
  error: "danger",
};

function statusGlyph(status: ToolEvent["status"]) {
  if (status === "completed") return <IconCheck size={12} />;
  if (status === "error") return <IconX size={12} />;
  return <IconBolt size={12} className="cp-pulse" />;
}

export function ToolCard({ event }: { event: ToolEvent }) {
  const [open, setOpen] = useState(false);
  const isCommand = isTerminalToolName(event.name);
  const tone = TOOL_TONE[event.status];
  // Single live-output node: the host appends to ONE string (bounded), so
  // thousands of chunks never become thousands of React nodes.
  const liveOutput = isCommand ? (event.output ?? "") : "";

  const body = (
    <>
      <span
        className={`flex-shrink-0 ${
          tone === "success"
            ? "text-vscode-success-fg"
            : tone === "danger"
              ? "text-vscode-error-fg"
              : "text-vscode-text-link"
        }`}
      >
        {statusGlyph(event.status)}
      </span>
      <span className="font-mono text-[11px] text-vscode-fg font-medium truncate">
        {event.name}
      </span>
      {event.detail && !open && (
        <span className="text-[10px] text-vscode-desc truncate hidden sm:inline">
          {event.detail}
        </span>
      )}
      <span className="ml-auto flex items-center gap-2 flex-shrink-0">
        {event.status === "started" && (
          <span className="text-[10px] text-vscode-desc">running…</span>
        )}
        {event.durationMs != null && (
          <span className="text-[10px] font-mono text-vscode-desc">
            {formatDuration(event.durationMs)}
          </span>
        )}
      </span>
    </>
  );

  return (
    <div className="rounded-md border border-vscode-border bg-vscode-panel/70 overflow-hidden cp-fade-up">
      {event.detail ? (
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-vscode-list-hover transition-colors text-left"
        >
          <IconChevron
            size={11}
            className={`text-vscode-desc flex-shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          />
          {body}
        </button>
      ) : (
        <div className="flex items-center gap-2 px-2.5 py-1.5 pl-[22px]">
          {body}
        </div>
      )}
      {open && event.detail && (
        <div className="px-3 pb-2 -mt-0.5">
          <pre className="text-[10px] font-mono text-vscode-desc whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
            {event.detail}
          </pre>
        </div>
      )}
      {isCommand && liveOutput.length > 0 && (
        <div className="px-3 py-1.5 border-t border-vscode-border/60">
          <div className="text-[9px] uppercase tracking-wider text-vscode-desc mb-1">
            {event.status === "started" ? "live output" : "output"}
            {event.outputTruncated ? " (truncated)" : ""}
          </div>
          <pre
            aria-live="off"
            className="text-[10px] font-mono text-vscode-fg whitespace-pre-wrap break-words max-h-48 overflow-y-auto bg-vscode-input-bg/50 rounded px-2 py-1"
          >
            {liveOutput}
          </pre>
        </div>
      )}
      {isCommand && event.status === "completed" && (
        <div className="px-3 py-1 border-t border-vscode-border/60 text-[10px] text-vscode-success-fg flex items-center gap-1.5">
          <IconCheck size={10} /> command finished
        </div>
      )}
    </div>
  );
}

export function ToolEventList({ events }: { events: ToolEvent[] }) {
  return (
    <div className="space-y-1">
      {events.map((evt) => (
        <ToolCard key={evt.id} event={evt} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// M4 approval card
// ---------------------------------------------------------------------------

function riskTone(riskLevel: string): Tone {
  const r = riskLevel.toLowerCase();
  if (r === "critical") return "danger";
  if (r === "high") return "warning";
  if (r === "medium") return "info";
  return "muted";
}

export function M4ApprovalCard({
  request,
  onDecision,
}: {
  request: M4ApprovalRequest;
  onDecision: (
    approvalId: string,
    decision: "allow" | "deny",
    scope?: "once" | "session" | "task",
  ) => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const tone = riskTone(request.riskLevel);
  const critical = tone === "danger";
  const isCommand =
    request.action === "execute_command" || request.action === "run_command";

  return (
    <div
      role="alertdialog"
      aria-label={`Approval required for ${request.toolId}`}
      className={`rounded-md border overflow-hidden cp-fade-up ${
        critical
          ? "border-vscode-error-fg/50 bg-vscode-error-fg/5"
          : tone === "warning"
            ? "border-vscode-warning-fg/50 bg-vscode-warning-fg/5"
            : "border-vscode-border bg-vscode-panel/70"
      }`}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
        {critical ? (
          <IconWarning
            size={14}
            className="text-vscode-error-fg flex-shrink-0"
          />
        ) : (
          <IconShield
            size={14}
            className="text-vscode-warning-fg flex-shrink-0"
          />
        )}
        <span className="text-[11px] font-semibold text-vscode-fg flex-shrink-0">
          Approval required
        </span>
        <Badge tone={tone} title={`Risk level: ${request.riskLevel}`}>
          {request.riskLevel} risk
        </Badge>
        {isCommand && <IconTerminal size={12} className="text-vscode-desc" />}
      </div>

      <div className="px-3 pb-1 space-y-1">
        <div className="text-[11px] font-mono text-vscode-fg break-all">
          {request.toolId}
          {request.action ? ` — ${request.action}` : ""}
        </div>
        {request.description && (
          <div className="text-[11px] text-vscode-desc break-words">
            {request.description}
          </div>
        )}
        {request.preview && (
          <pre className="text-[10px] font-mono text-vscode-fg bg-vscode-input-bg border border-vscode-border rounded px-2 py-1.5 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
            {request.preview}
          </pre>
        )}
        {showDetails && (
          <div className="text-[10px] text-vscode-desc space-y-0.5 cp-fade-up">
            {request.riskReasons && request.riskReasons.length > 0 && (
              <div>
                <span className="font-semibold">Risk reasons: </span>
                {request.riskReasons.join("; ")}
              </div>
            )}
            {request.workingDirectory && (
              <div className="font-mono break-all">
                cwd: {request.workingDirectory}
              </div>
            )}
            <div className="font-mono break-all">
              execution: {request.executionId}
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
        <Button
          variant="primary"
          onClick={() => onDecision(request.approvalId, "allow")}
          aria-label={`Allow ${request.toolId}`}
        >
          Allow
        </Button>
        {request.allowSession && (
          <Button
            onClick={() => onDecision(request.approvalId, "allow", "session")}
            aria-label={`Allow ${request.toolId} for this session`}
          >
            Allow for session
          </Button>
        )}
        <Button
          variant="danger"
          onClick={() => onDecision(request.approvalId, "deny")}
          aria-label={`Deny ${request.toolId}`}
        >
          Deny
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowDetails((d) => !d)}
          aria-expanded={showDetails}
        >
          {showDetails ? "Hide details" : "Details"}
        </Button>
        <span className="ml-auto text-[9px] text-vscode-desc hidden sm:inline">
          resolves the live M4 permission request
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MCP approval card
// ---------------------------------------------------------------------------

export interface McpApprovalView {
  requestId: string;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  riskLevel: string;
}

export function McpApprovalCard({
  approval,
  onDecision,
}: {
  approval: McpApprovalView;
  onDecision: (requestId: string, decision: "approve" | "reject") => void;
}) {
  const tone = riskTone(approval.riskLevel);
  const argKeys = Object.keys(approval.arguments);
  return (
    <div
      role="alertdialog"
      aria-label={`MCP tool request from ${approval.serverName}`}
      className={`rounded-md border overflow-hidden cp-fade-up ${
        tone === "danger"
          ? "border-vscode-error-fg/50 bg-vscode-error-fg/5"
          : "border-vscode-warning-fg/50 bg-vscode-warning-fg/5"
      }`}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
        <IconShield
          size={14}
          className="text-vscode-warning-fg flex-shrink-0"
        />
        <span className="text-[11px] font-semibold text-vscode-fg flex-shrink-0">
          MCP tool request
        </span>
        <Badge tone={tone}>{approval.riskLevel} risk</Badge>
      </div>
      <div className="px-3 pb-1 space-y-0.5 text-[11px]">
        <div className="font-mono text-vscode-fg break-all">
          {approval.serverName} · {approval.toolName}
        </div>
        {argKeys.length > 0 && (
          <pre className="text-[10px] font-mono text-vscode-desc bg-vscode-input-bg border border-vscode-border rounded px-2 py-1.5 whitespace-pre-wrap break-words max-h-28 overflow-y-auto">
            {JSON.stringify(approval.arguments, null, 2)}
          </pre>
        )}
      </div>
      <div className="flex gap-1.5 px-3 py-2">
        <Button
          variant="primary"
          onClick={() => onDecision(approval.requestId, "approve")}
          aria-label={`Approve ${approval.toolName}`}
        >
          Approve
        </Button>
        <Button
          variant="danger"
          onClick={() => onDecision(approval.requestId, "reject")}
          aria-label={`Reject ${approval.toolName}`}
        >
          Reject
        </Button>
      </div>
    </div>
  );
}
