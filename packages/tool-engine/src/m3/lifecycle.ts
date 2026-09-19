/**
 * @codepilot/tool-engine — M3 execution lifecycle
 *
 * Statuses: REQUESTED → VALIDATING → PERMISSION_CHECK → (AWAITING_APPROVAL)
 *           → RUNNING → COMPLETED
 * Terminal variants: DENIED | FAILED | CANCELLED | TIMED_OUT
 *
 * Exactly-once guarantee: for each execution the service emits each event type
 * at most once, and exactly one terminal event. Listeners are deduplicated by
 * (executionId, type).
 */

import type { ToolError, ToolProgress } from "./types.js";

export type ToolExecutionStatus =
  | "requested"
  | "validating"
  | "permission_check"
  | "awaiting_approval"
  | "running"
  | "completed"
  | "denied"
  | "failed"
  | "cancelled"
  | "timed_out";

export const TERMINAL_STATUSES: readonly ToolExecutionStatus[] = [
  "completed",
  "denied",
  "failed",
  "cancelled",
  "timed_out",
] as const;

export function isTerminal(status: ToolExecutionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Correlation carried by every tool event. */
export interface ToolCorrelation {
  executionId: string;
  eventId?: string;
  sessionId?: string;
  taskId?: string;
  toolId: string;
  timestamp: number;
}

export interface ToolExecution {
  executionId: string;
  toolId: string;
  status: ToolExecutionStatus;
  startedAt: number;
  completedAt?: number;
  /** Permission decision recorded for audit. */
  permissionDecision?:
    "allowed" | "denied" | "approved_once" | "approved_session" | "auto";
  retriesUsed: number;
}

export interface ToolResult<O = unknown> {
  executionId: string;
  toolId: string;
  status: ToolExecutionStatus;
  output?: O;
  error?: ToolError;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  retriesUsed: number;
}

// ============================================================================
// Lifecycle events (exactly-once per execution)
// ============================================================================

type ToolEventBase = ToolCorrelation;

export type ToolEvent =
  | ({ type: "tool.requested"; input: unknown } & ToolEventBase)
  | ({
      type: "tool.permission_required";
      reason: string;
      approvalId?: string;
    } & ToolEventBase)
  | ({ type: "tool.permission_granted"; approvalId?: string } & ToolEventBase)
  | ({ type: "tool.started" } & ToolEventBase)
  | ({ type: "tool.progress"; progress: ToolProgress } & ToolEventBase)
  | ({ type: "tool.output"; output: unknown } & ToolEventBase)
  | ({
      type: "tool.completed";
      output: unknown;
      durationMs: number;
    } & ToolEventBase)
  | ({ type: "tool.denied"; reason: string } & ToolEventBase)
  | ({
      type: "tool.failed";
      error: ToolError;
      durationMs: number;
    } & ToolEventBase)
  | ({
      type: "tool.cancelled";
      reason: string;
      durationMs: number;
    } & ToolEventBase)
  | ({
      type: "tool.timed_out";
      timeoutMs: number;
      durationMs: number;
    } & ToolEventBase);

export type ToolEventListener = (event: ToolEvent) => void;
