/**
 * @codepilot/tool-engine — M3 tool contract
 *
 * Strongly-typed tool system contracts. Every tool execution has a unique
 * executionId and carries full correlation (eventId/sessionId/taskId).
 */

// ============================================================================
// Categories & permissions
// ============================================================================

export type ToolCategory =
  "filesystem" | "search" | "command" | "git" | "interaction" | "analysis";

/** Permission level a tool requires. Ordered by escalating privilege. */
export type ToolPermissionLevel =
  "read" | "write" | "destructive" | "execute" | "network" | "interaction";

export interface ToolPermission {
  /** Escalating privilege level of the tool. */
  level: ToolPermissionLevel;
  /** Whether the tool requires explicit user approval by default. */
  requiresApproval: boolean;
  /** Human-readable rationale shown in approval dialogs. */
  rationale: string;
}

// ============================================================================
// Schemas (JSON-Schema subset — validated structurally, no dependency)
// ============================================================================

export interface ToolSchema {
  type: "object";
  properties: Record<string, ToolSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolSchemaProperty {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  enum?: string[];
  items?: ToolSchemaProperty;
  default?: unknown;
}

// ============================================================================
// Progress
// ============================================================================

export interface ToolProgress {
  message?: string;
  /** 0–100 when determinable. */
  percent?: number;
}

// ============================================================================
// Errors
// ============================================================================

export type ToolErrorCode =
  | "VALIDATION"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "PATH_SECURITY"
  | "COMMAND_FAILED"
  | "PROCESS_FAILED"
  | "TIMEOUT"
  | "CANCELLED"
  | "IO_ERROR"
  | "INTERNAL"
  | "UNSUPPORTED";

export interface ToolError {
  code: ToolErrorCode;
  /** Same as code — kept for explicit category checks at call sites. */
  category: ToolErrorCode;
  message: string;
  recoverable: boolean;
  retryable: boolean;
  cancelled: boolean;
  timedOut: boolean;
  executionId: string;
  cause?: unknown;
}

export function toolError(
  code: ToolErrorCode,
  message: string,
  executionId: string,
  opts: Partial<
    Pick<
      ToolError,
      "recoverable" | "retryable" | "cancelled" | "timedOut" | "cause"
    >
  > = {},
): ToolError {
  return {
    code,
    category: code,
    message,
    recoverable: opts.recoverable ?? code !== "VALIDATION",
    retryable: opts.retryable ?? false,
    cancelled: opts.cancelled ?? code === "CANCELLED",
    timedOut: opts.timedOut ?? code === "TIMEOUT",
    executionId,
    cause: opts.cause,
  };
}

/** True when the thrown/rejected value is an abort/cancellation. */
export function isAbortLike(err: unknown): boolean {
  if (err instanceof Error) {
    const n = (err as NodeJS.ErrnoException).name ?? "";
    if (n === "AbortError" || n === "TimeoutError") return true;
    const m = err.message.toLowerCase();
    return (
      m.includes("abort") || m.includes("cancelled") || m.includes("canceled")
    );
  }
  return false;
}

// ============================================================================
// Execution context
// ============================================================================

export interface ApprovalRequest {
  toolId: string;
  executionId: string;
  summary: string;
}

export interface ApprovalDecision {
  approved: boolean;
  /** "once" (default) or "session" — persisted by the permission manager. */
  scope?: "once" | "session";
  reason?: string;
}

export interface ToolContext {
  /** Unique execution id (also the event correlation id for this execution). */
  executionId: string;
  eventId?: string;
  sessionId?: string;
  taskId?: string;
  /** Workspace root — all filesystem access is bounded to it. */
  cwd: string;
  /** Cancellation signal — every tool must observe it. */
  signal: AbortSignal;
  /** Emit a progress update (forwarded as tool.progress exactly once per call). */
  progress: (p: ToolProgress) => void;
  /** Approval callback for interactive tools (ask_user) — host-provided. */
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
}

// ============================================================================
// Tool definition
// ============================================================================

/**
 * A production tool. Input is validated against inputSchema before execute()
 * runs; output shape is documented by outputSchema for discovery purposes.
 */
export interface ToolDefinition<I = Record<string, unknown>, O = unknown> {
  id: string;
  name: string;
  description: string;
  category: ToolCategory;
  version: string;
  inputSchema: ToolSchema;
  outputSchema?: ToolSchema;
  /** Capability tags, e.g. ["streaming", "cancellable"]. */
  capabilities: string[];
  permission: ToolPermission;
  /** Only idempotent tools are eligible for automatic retry. */
  idempotent: boolean;
  /** Optional semantic validation beyond the schema. Return null when valid. */
  validate?(input: I, cwd: string): ToolError | null;
  execute(input: I, ctx: ToolContext): Promise<O>;
  /** Best-effort cancel of an in-flight execution. */
  cancel?(executionId: string): void;
  dispose?(): Promise<void>;
}
