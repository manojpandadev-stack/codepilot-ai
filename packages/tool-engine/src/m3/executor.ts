/**
 * @codepilot/tool-engine — M3 ToolExecutionService (executor)
 *
 * Orchestrates the full tool execution lifecycle:
 *
 *   REQUESTED → VALIDATING → PERMISSION_CHECK → [AWAITING_APPROVAL]
 *             → RUNNING → COMPLETED
 *   variants: DENIED | FAILED | CANCELLED | TIMED_OUT
 *
 * Exactly-once events: each event type is emitted at most once per execution
 * and exactly one terminal event is always emitted. Retries are only attempted
 * for tools that declare themselves idempotent and for retryable errors.
 * Timeouts fire tool.cancel() and abort the context signal. Cancellation is
 * observed between every phase and inside the tool via ctx.signal.
 */

import type {
  ToolDefinition,
  ToolContext,
  ToolError,
  ToolProgress,
} from "./types.js";
import { toolError, isAbortLike } from "./types.js";
import type {
  ToolCorrelation,
  ToolEvent,
  ToolEventListener,
  ToolExecutionStatus,
  ToolResult,
} from "./lifecycle.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolPermissionManager } from "./permission-manager.js";
import type { ToolAuditLogger } from "./audit-logger.js";
import { redactSecrets } from "./audit-logger.js";
import type { M4PermissionPipeline } from "../m4/integration.js";

// ============================================================================
// Options
// ============================================================================

export interface ToolExecutorOptions {
  /** Default per-execution timeout in ms (default 120_000). */
  defaultTimeoutMs?: number;
  /** Max automatic retries for idempotent tools (default 2). */
  maxRetries?: number;
  /** Backoff base for retries in ms (default 250, exponential). */
  retryBackoffMs?: number;
}

export interface ExecuteOptions {
  eventId?: string;
  sessionId?: string;
  taskId?: string;
  /** Workspace root used for the tool context and semantic validation. */
  cwd?: string;
  /** Caller-owned cancellation. */
  signal?: AbortSignal;
  /** Override the default timeout for this execution. */
  timeoutMs?: number;
  /** Host-provided approval callback (M4 will route this to the WebView). */
  requestApproval?: ToolContext["requestApproval"];
  /** M4 permission action (e.g. "read_file", "write_file", "execute_command"). */
  action?: string;
}

interface InternalExecution {
  executionId: string;
  toolId: string;
  correlation: {
    executionId: string;
    eventId?: string;
    sessionId?: string;
    taskId?: string;
    toolId: string;
    timestamp: number;
  };
  status: ToolExecutionStatus;
  startedAt: number;
  retriesUsed: number;
  /** Set when the execution timer fired — turns abort into TIMED_OUT. */
  timedOut: boolean;
  permissionDecision?: string;
  emitted: Set<ToolEvent["type"]>;
  terminalEmitted: boolean;
  /** Guard so asResult() records exactly one audit entry per execution. */
  audited?: boolean;
  /** Effective timeout for this execution (set at creation). */
  timeoutMs: number;
  /** Dedup key of the last progress payload (no duplicate progress events). */
  lastProgressKey?: string;
  controller: AbortController;
  timer: NodeJS.Timeout | null;
}

const STATUS_BY_TERMINAL_EVENT: Partial<
  Record<ToolEvent["type"], ToolExecutionStatus>
> = {
  "tool.completed": "completed",
  "tool.denied": "denied",
  "tool.failed": "failed",
  "tool.cancelled": "cancelled",
  "tool.timed_out": "timed_out",
};

/** A ToolEvent minus the correlation fields added at emit time. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type ToolEventPayload = DistributiveOmit<ToolEvent, keyof ToolCorrelation>;

// ============================================================================
// ToolExecutionService
// ============================================================================

export class ToolExecutionService {
  private readonly registry: ToolRegistry;
  private readonly permissions: ToolPermissionManager;
  private readonly audit: ToolAuditLogger;
  private readonly m4: M4PermissionPipeline | undefined;
  private readonly listeners = new Set<ToolEventListener>();
  private readonly active = new Map<string, InternalExecution>();
  private readonly defaultTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private disposed = false;

  constructor(
    registry: ToolRegistry,
    permissions: ToolPermissionManager,
    audit: ToolAuditLogger,
    options: ToolExecutorOptions = {},
    m4Pipeline?: M4PermissionPipeline,
  ) {
    this.registry = registry;
    this.permissions = permissions;
    this.audit = audit;
    this.m4 = m4Pipeline;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBackoffMs = options.retryBackoffMs ?? 250;
  }

  // ---- Events ----

  /** Subscribe to tool lifecycle events. Returns an unsubscribe function. */
  subscribe(listener: ToolEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Number of active listeners (lifecycle introspection for tests). */
  listenerCount(): number {
    return this.listeners.size;
  }

  /** Snapshot of in-flight executions (for UI/status queries). */
  activeExecutions(): Array<
    Pick<
      InternalExecution,
      "executionId" | "toolId" | "status" | "startedAt" | "retriesUsed"
    >
  > {
    return [...this.active.values()].map((e) => ({
      executionId: e.executionId,
      toolId: e.toolId,
      status: e.status,
      startedAt: e.startedAt,
      retriesUsed: e.retriesUsed,
    }));
  }

  /** Best-effort cancel of a running execution by id. */
  cancel(executionId: string, reason = "Cancelled by caller"): boolean {
    const exec = this.active.get(executionId);
    if (!exec) return false;
    const tool = this.registry.get(exec.toolId);
    try {
      tool?.cancel?.(executionId);
    } catch {
      // cancel is best-effort; abort below is authoritative.
    }
    exec.controller.abort(reason);
    return true;
  }

  // ---- Execution ----

  async execute(
    toolId: string,
    input: unknown,
    options: ExecuteOptions = {},
  ): Promise<ToolResult> {
    if (this.disposed) {
      // Post-dispose execute() must not throw — return a failed result so the
      // caller always receives a well-formed ToolResult.
      const executionId = `tool-exec-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 10)}`;
      return {
        executionId,
        toolId,
        status: "failed",
        error: toolError(
          "INTERNAL",
          "ToolExecutionService has been disposed",
          executionId,
          { recoverable: false },
        ),
        startedAt: Date.now(),
        completedAt: Date.now(),
        durationMs: 0,
        retriesUsed: 0,
      };
    }
    const executionId = `tool-exec-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;

    const exec: InternalExecution = {
      executionId,
      toolId,
      correlation: {
        executionId,
        eventId: options.eventId,
        sessionId: options.sessionId,
        taskId: options.taskId,
        toolId,
        timestamp: Date.now(),
      },
      status: "requested",
      startedAt: Date.now(),
      retriesUsed: 0,
      timedOut: false,
      timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
      emitted: new Set(),
      terminalEmitted: false,
      controller: new AbortController(),
      timer: null,
    };
    this.active.set(executionId, exec);

    const callerSignal = options.signal;
    const onCallerAbort = () => exec.controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    const cwd = options.cwd ?? process.cwd();
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    try {
      // ---- REQUESTED ----
      exec.status = "requested";
      this.emit(exec, { type: "tool.requested", input });

      const tool = this.registry.get(toolId);
      if (!tool) {
        return this.finish(
          exec,
          toolError("NOT_FOUND", `Unknown tool: ${toolId}`, executionId, {
            recoverable: false,
          }),
          callerSignal,
        );
      }
      if (!this.registry.isEnabled(toolId)) {
        return this.finish(
          exec,
          toolError("UNSUPPORTED", `Tool '${toolId}' is disabled`, executionId),
          callerSignal,
        );
      }

      // ---- VALIDATING ----
      exec.status = "validating";
      if (callerSignal?.aborted) {
        return this.cancelled(
          exec,
          "Cancelled before validation",
          callerSignal,
        );
      }
      const validationError = this.registry.validateInput(
        toolId,
        input,
        executionId,
        cwd,
      );
      if (validationError) {
        return this.finish(exec, validationError, callerSignal);
      }

      // ---- PERMISSION_CHECK ----
      exec.status = "permission_check";
      if (callerSignal?.aborted) {
        return this.cancelled(
          exec,
          "Cancelled before permission check",
          callerSignal,
        );
      }

      // M4 pipeline: RiskEngine → PermissionPolicyEngine → ApprovalManager → SecurityValidator
      if (this.m4) {
        const m4Result = await this.m4.evaluate({
          toolId,
          executionId,
          sessionId: options.sessionId,
          taskId: options.taskId,
          input,
          cwd,
        });
        exec.permissionDecision = m4Result.decision;

        // Any deny decision (including deny_session) blocks execution
        if (
          m4Result.decision === "deny" ||
          m4Result.decision === "deny_session"
        ) {
          exec.status = "denied";
          this.emit(exec, {
            type: "tool.denied",
            reason: m4Result.reason,
          });
          return this.asResult(exec, undefined, {
            error: toolError(
              "PERMISSION_DENIED",
              m4Result.reason,
              executionId,
              {
                recoverable: false,
              },
            ),
          });
        }

        // Allow decisions require the approved flag to be true
        if (
          (m4Result.decision === "allow" ||
            m4Result.decision === "allow_session") &&
          m4Result.approved
        ) {
          this.emit(exec, {
            type: "tool.permission_granted",
            approvalId: m4Result.approvalId,
          });
        } else {
          // Not approved — deny
          exec.status = "denied";
          const reason = m4Result.reason || "Permission denied by policy";
          this.emit(exec, { type: "tool.denied", reason });
          return this.asResult(exec, undefined, {
            error: toolError("PERMISSION_DENIED", reason, executionId, {
              recoverable: false,
            }),
          });
        }
      } else {
        // Fallback to M3 permission system when M4 is not configured
        const decision = this.permissions.decide(
          toolId,
          tool.permission.level,
          executionId,
          options.taskId,
        );
        exec.permissionDecision = decision.type;

        if (decision.type === "deny") {
          exec.status = "denied";
          this.emit(exec, { type: "tool.denied", reason: decision.reason });
          return this.asResult(exec, undefined, {
            error: toolError(
              "PERMISSION_DENIED",
              decision.reason,
              executionId,
              {
                recoverable: false,
              },
            ),
          });
        }

        if (decision.type === "approve") {
          exec.status = "awaiting_approval";
          this.emit(exec, {
            type: "tool.permission_required",
            reason: tool.permission.rationale || decision.reason,
          });
          if (!options.requestApproval) {
            exec.status = "denied";
            const reason =
              "Approval required but no approval channel is available";
            this.emit(exec, { type: "tool.denied", reason });
            return this.asResult(exec, undefined, {
              error: toolError("PERMISSION_DENIED", reason, executionId, {
                recoverable: false,
              }),
            });
          }
          const approval = await options.requestApproval({
            toolId,
            executionId,
            summary: tool.permission.rationale || decision.reason,
          });
          if (callerSignal?.aborted || exec.controller.signal.aborted) {
            return this.cancelled(
              exec,
              "Cancelled while awaiting approval",
              callerSignal,
            );
          }
          if (!approval.approved) {
            this.permissions.recordDenial(toolId, approval.scope ?? "once");
            exec.status = "denied";
            const reason = approval.reason ?? "Denied by user";
            this.emit(exec, { type: "tool.denied", reason });
            return this.asResult(exec, undefined, {
              error: toolError("PERMISSION_DENIED", reason, executionId, {
                recoverable: false,
              }),
            });
          }
          this.permissions.recordApproval(toolId, approval.scope ?? "once");
          exec.permissionDecision =
            approval.scope === "session" ? "approved_session" : "approved_once";
        }
      }

      // ---- RUNNING (with retry loop for idempotent tools) ----
      const maxAttempts = tool.idempotent ? 1 + this.maxRetries : 1;
      let lastError: ToolError | null = null;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (callerSignal?.aborted || exec.controller.signal.aborted) {
          return this.cancelled(exec, "Cancelled", callerSignal);
        }
        if (attempt > 0) {
          exec.retriesUsed = attempt;
          lastError = null;
          const backoff = this.retryBackoffMs * 2 ** (attempt - 1);
          const aborted = await this.sleep(backoff, exec.controller.signal);
          if (aborted)
            return this.cancelled(
              exec,
              "Cancelled during retry backoff",
              callerSignal,
            );
        }

        exec.status = "running";
        this.emit(exec, { type: "tool.started" });

        // Progress forwarding: each progress() call maps to exactly one
        // tool.progress event (deduplicated further by emit()).
        const ctx: ToolContext = {
          executionId,
          eventId: options.eventId,
          sessionId: options.sessionId,
          taskId: options.taskId,
          cwd,
          signal: exec.controller.signal,
          progress: (p) =>
            this.emit(exec, { type: "tool.progress", progress: p }),
          requestApproval: options.requestApproval,
        };

        // Timeout: fires tool.cancel() then aborts the context signal.
        this.armTimer(exec, tool, timeoutMs);

        try {
          const output = await tool.execute(
            input as Record<string, unknown>,
            ctx,
          );
          this.disarmTimer(exec);
          // A tool that ignored its signal may still return late — treat any
          // completion after the timer fired as a timeout, never a success,
          // and any completion after abort (dispose/cancel) as a cancellation.
          if (exec.timedOut) break;
          if (exec.controller.signal.aborted) {
            return this.cancelled(
              exec,
              "Tool returned after cancellation",
              callerSignal,
            );
          }
          if (exec.status !== "running") break; // terminal transition already handled
          exec.status = "completed";
          this.emit(exec, {
            type: "tool.completed",
            output,
            durationMs: Date.now() - exec.startedAt,
          });
          return this.asResult(exec, output);
        } catch (err) {
          this.disarmTimer(exec);
          lastError = this.normalizeError(err, exec, timeoutMs);
          // Cancellation always wins — no retry, no timeout conversion.
          if (lastError.cancelled || callerSignal?.aborted) {
            return this.cancelled(exec, lastError.message, callerSignal);
          }
          // Retry only when attempts remain, the error is retryable, and the
          // tool declared itself idempotent (never for writes/deletes/commands).
          if (
            attempt + 1 < maxAttempts &&
            lastError.retryable &&
            tool.idempotent
          ) {
            continue;
          }
          break;
        }
      }

      return this.finish(
        exec,
        lastError ??
          (exec.timedOut
            ? toolError(
                "TIMEOUT",
                `Tool timed out after ${timeoutMs}ms`,
                executionId,
                { retryable: true },
              )
            : toolError(
                "INTERNAL",
                "Tool failed without an error",
                executionId,
              )),
        callerSignal,
      );
    } finally {
      callerSignal?.removeEventListener("abort", onCallerAbort);
      this.disarmTimer(exec);
      this.active.delete(executionId);
    }
  }

  // ========================================================================
  // Private helpers
  // ========================================================================

  /**
   * Emit one lifecycle event with full correlation. Exactly-once guarantees:
   *   - each event type is emitted at most once per execution
   *   - at most one terminal event (guarded twice: here and by callers)
   *   - duplicate consecutive identical progress payloads are dropped
   * Listener exceptions are contained — they must never break execution.
   */
  private emit(exec: InternalExecution, payload: ToolEventPayload): void {
    const type = payload.type;
    if (exec.emitted.has(type)) return;

    if (type === "tool.progress") {
      const key = JSON.stringify(
        (payload as { progress: ToolProgress }).progress,
      );
      if (exec.lastProgressKey === key) return;
      exec.lastProgressKey = key;
    }

    const isTerminalType = type in STATUS_BY_TERMINAL_EVENT;
    if (isTerminalType && exec.terminalEmitted) return;

    exec.emitted.add(type);
    if (isTerminalType) exec.terminalEmitted = true;

    const event = { ...payload, ...exec.correlation } as ToolEvent;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener errors are contained; execution continues.
      }
    }
  }

  /** Arm the execution timer: fire → tool.cancel() → abort context signal. */
  private armTimer(
    exec: InternalExecution,
    tool: ToolDefinition,
    timeoutMs: number,
  ): void {
    this.disarmTimer(exec);
    exec.timer = setTimeout(() => {
      exec.timedOut = true;
      try {
        tool.cancel?.(exec.executionId);
      } catch {
        // tool.cancel is best-effort; the abort below is authoritative.
      }
      exec.controller.abort(`Tool timed out after ${timeoutMs}ms`);
    }, timeoutMs);
  }

  private disarmTimer(exec: InternalExecution): void {
    if (exec.timer) {
      clearTimeout(exec.timer);
      exec.timer = null;
    }
  }

  /** Backoff sleep that resolves `true` when aborted. */
  private sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve(false);
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve(true);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Terminal failure path: emits tool.timed_out or tool.failed exactly once. */
  private finish(
    exec: InternalExecution,
    error: ToolError,
    _callerSignal?: AbortSignal,
  ): ToolResult {
    if (exec.timedOut) {
      exec.status = "timed_out";
      this.emit(exec, {
        type: "tool.timed_out",
        timeoutMs: exec.timeoutMs,
        durationMs: Date.now() - exec.startedAt,
      });
    } else {
      exec.status = "failed";
      this.emit(exec, {
        type: "tool.failed",
        error,
        durationMs: Date.now() - exec.startedAt,
      });
    }
    return this.asResult(exec, undefined, { error });
  }

  /** Terminal cancellation path: emits tool.cancelled exactly once. */
  private cancelled(
    exec: InternalExecution,
    message: string,
    _callerSignal?: AbortSignal,
  ): ToolResult {
    exec.status = "cancelled";
    this.emit(exec, {
      type: "tool.cancelled",
      reason: message,
      durationMs: Date.now() - exec.startedAt,
    });
    return this.asResult(exec, undefined, {
      error: toolError("CANCELLED", message, exec.executionId, {
        recoverable: false,
      }),
    });
  }

  /**
   * Build the immutable ToolResult and record exactly one audit entry per
   * execution (guard: exec.audited). Also removes the execution from the
   * active map (idempotent — execute()'s finally does the same).
   */
  private asResult(
    exec: InternalExecution,
    output?: unknown,
    extra?: { error?: ToolError },
  ): ToolResult {
    const completedAt = Date.now();
    const result: ToolResult = {
      executionId: exec.executionId,
      toolId: exec.toolId,
      status: exec.status,
      ...(output !== undefined ? { output } : {}),
      ...(extra?.error ? { error: extra.error } : {}),
      startedAt: exec.startedAt,
      completedAt,
      durationMs: completedAt - exec.startedAt,
      retriesUsed: exec.retriesUsed,
    };

    if (!exec.audited) {
      exec.audited = true;
      this.audit.record({
        executionId: exec.executionId,
        toolId: exec.toolId,
        sessionId: exec.correlation.sessionId,
        taskId: exec.correlation.taskId,
        startedAt: exec.startedAt,
        completedAt,
        durationMs: result.durationMs,
        status: exec.status,
        permissionDecision: exec.permissionDecision,
        errorCategory: extra?.error?.category,
        retries: exec.retriesUsed,
      });
    }

    this.active.delete(exec.executionId);
    return result;
  }

  /**
   * Normalize any thrown value into a structured ToolError. Order matters:
   * timeout wins over abort, abort wins over everything else, tool-produced
   * ToolErrors pass through (redacted), and the remainder are classified as
   * IO or internal errors. Messages are always secret-redacted.
   */
  private normalizeError(
    err: unknown,
    exec: InternalExecution,
    timeoutMs: number,
  ): ToolError {
    const message = err instanceof Error ? err.message : String(err);

    if (exec.timedOut || /timed? ?out/i.test(message)) {
      return toolError(
        "TIMEOUT",
        redactSecrets(`Tool timed out after ${timeoutMs}ms`),
        exec.executionId,
        { retryable: true, cause: err },
      );
    }
    if (exec.controller.signal.aborted || isAbortLike(err)) {
      return toolError(
        "CANCELLED",
        redactSecrets(message || "Execution cancelled"),
        exec.executionId,
        { recoverable: false, cause: err },
      );
    }
    // A ToolError produced by the tool itself — preserve its code/category.
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      "executionId" in err
    ) {
      const te = err as ToolError;
      return { ...te, message: redactSecrets(te.message) };
    }
    const isIo = /enoent|eacces|eperm|eisdir|enotdir|ebusy|enospc/i.test(
      message,
    );
    return toolError(
      isIo ? "IO_ERROR" : "INTERNAL",
      redactSecrets(message),
      exec.executionId,
      { recoverable: true, retryable: isIo, cause: err },
    );
  }

  /**
   * Dispose the service: abort all in-flight executions and drop listeners.
   * Does NOT dispose registry tools — the ToolRegistry owns that lifecycle.
   */
  /** Dispose the service: abort all in-flight executions and drop listeners.
   * Does NOT dispose registry tools — the ToolRegistry owns that lifecycle.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const exec of this.active.values()) {
      this.disarmTimer(exec);
      exec.controller.abort("ToolExecutionService disposed");
    }
    this.active.clear();
    this.listeners.clear();
  }
}
