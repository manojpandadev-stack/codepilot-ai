/**
 * @codepilot/tool-engine — M4 ApprovalManager
 *
 * Manages the lifecycle of pending approval requests. When a tool execution
 * requires user approval (policy decision = ASK), the executor calls
 * requestApproval() which returns a Promise<ApprovalResult>. The host
 * (VS Code extension / WebView) resolves the promise through approve() /
 * reject() / cancel() / timeout().
 *
 * Exactly-once semantics: an approval request can be resolved exactly once.
 * Subsequent calls to approve/reject/cancel/timeout for the same approvalId
 * are idempotent no-ops that return the already-resolved result.
 *
 * Pending approvals support timeout. When the timeout fires, the request is
 * resolved as 'expired' and the promise rejects.
 *
 * Dispose resolves any still-pending approvals as 'cancelled' so that no
 * promise is left dangling.
 */

import type {
  ApprovalRequest,
  ApprovalResult,
  PermissionAction,
  PermissionScope,
  RiskAssessment,
} from "./permission-types.js";

// ============================================================================
// Internal state
// ============================================================================

interface PendingRequest {
  request: ApprovalRequest;
  resolve: (result: ApprovalResult) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

// ============================================================================
// Options
// ============================================================================

export interface ApprovalManagerOptions {
  /** Default timeout in milliseconds for pending approvals. */
  defaultTimeoutMs?: number;
  /** Called when an approval is requested — used to surface UI. */
  onApprovalRequested?: (request: ApprovalRequest) => void;
  /**
   * Called when a request reaches a terminal state by any path (user,
   * timeout, cancel, dispose). Used by hosts to retire the UI card even
   * when the user did not click Allow/Deny. Never throws into the caller.
   */
  onApprovalResolved?: (result: ApprovalResult) => void;
  /**
   * F-12: Maximum number of resolved approvals to retain.
   * Prevents unbounded growth during long-running sessions.
   * Default: 1000 entries.
   */
  maxResolvedEntries?: number;
}

// ============================================================================
// ApprovalManager
// ============================================================================

export class ApprovalManager {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly resolved = new Map<string, ApprovalResult>();
  private readonly defaultTimeoutMs: number;
  private readonly onApprovalRequested?: (request: ApprovalRequest) => void;
  private readonly onApprovalResolved?: (result: ApprovalResult) => void;
  private readonly maxResolvedEntries: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly cleanupIntervalMs: number;

  constructor(options: ApprovalManagerOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
    this.onApprovalRequested = options.onApprovalRequested;
    this.onApprovalResolved = options.onApprovalResolved;
    
    // F-12: Bounded retention to prevent unbounded growth
    this.maxResolvedEntries = options.maxResolvedEntries ?? 1000;
    this.cleanupIntervalMs = 60_000; // Cleanup every 60 seconds
  }

  /**
   * Start periodic cleanup if not already running.
   */
  private startCleanupIfNeeded(): void {
    if (this.cleanupTimer === null) {
      this.cleanupTimer = setInterval(() => {
        this.cleanupOldResolvedEntries();
      }, this.cleanupIntervalMs);
      // Never hold the event loop open; lifecycle-safe if dispose() is missed.
      const t = this.cleanupTimer as unknown as { unref?: () => void };
      t.unref?.();
    }
  }

  /**
   * F-12: Clean up old resolved entries to prevent unbounded growth.
   * Removes oldest entries beyond maxResolvedEntries limit.
   */
  private cleanupOldResolvedEntries(): void {
    if (this.resolved.size <= this.maxResolvedEntries) {
      return;
    }
    
    // Remove oldest entries (FIFO based on insertion order)
    const entriesToRemove = this.resolved.size - this.maxResolvedEntries;
    const keys = Array.from(this.resolved.keys());
    for (let i = 0; i < entriesToRemove && i < keys.length; i++) {
      const key = keys[i];
      if (key) {
        this.resolved.delete(key);
      }
    }
  }

  /**
   * Create a new approval request and return a promise that resolves when the
   * user (or timeout/cancel) makes a decision.
   */
  requestApproval(input: {
    toolId: string;
    executionId: string;
    sessionId?: string;
    taskId?: string;
    action: PermissionAction;
    risk: RiskAssessment;
    description: string;
    preview?: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<ApprovalResult> {
    const approvalId = `approval-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;

    const request: ApprovalRequest = {
      approvalId,
      toolId: input.toolId,
      executionId: input.executionId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      action: input.action,
      risk: input.risk,
      description: input.description,
      preview: input.preview,
      requestedAt: Date.now(),
      timeoutMs,
    };

    return new Promise<ApprovalResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.expire(approvalId);
      }, timeoutMs);

      this.pending.set(approvalId, { request, resolve, reject, timer });
      this.onApprovalRequested?.(request);
    });
  }

  /** Approve a pending request. Idempotent. */
  approve(
    approvalId: string,
    scope: PermissionScope = "single_execution",
    reason = "",
  ): ApprovalResult | null {
    const pending = this.pending.get(approvalId);
    if (!pending) {
      return this.resolved.get(approvalId) ?? null;
    }
    
    // F-12: Start cleanup timer on first approval
    this.startCleanupIfNeeded();
    
    return this.resolvePending(approvalId, {
      approvalId,
      status: "approved",
      scope,
      resolvedAt: Date.now(),
      reason,
    });
  }

  /** Reject a pending request. Idempotent. */
  reject(
    approvalId: string,
    scope: PermissionScope = "single_execution",
    reason = "",
  ): ApprovalResult | null {
    const pending = this.pending.get(approvalId);
    if (!pending) {
      return this.resolved.get(approvalId) ?? null;
    }
    return this.resolvePending(approvalId, {
      approvalId,
      status: "rejected",
      scope,
      resolvedAt: Date.now(),
      reason,
    });
  }

  /** Cancel a pending request. Idempotent. */
  cancel(approvalId: string, reason = "Cancelled"): ApprovalResult | null {
    const pending = this.pending.get(approvalId);
    if (!pending) {
      return this.resolved.get(approvalId) ?? null;
    }
    return this.resolvePending(approvalId, {
      approvalId,
      status: "cancelled",
      scope: "single_execution",
      resolvedAt: Date.now(),
      reason,
    });
  }

  /** Expire a pending request. Idempotent. */
  expire(approvalId: string): ApprovalResult | null {
    const pending = this.pending.get(approvalId);
    if (!pending) {
      return this.resolved.get(approvalId) ?? null;
    }
    return this.resolvePending(approvalId, {
      approvalId,
      status: "expired",
      scope: "single_execution",
      resolvedAt: Date.now(),
      reason: "Approval timed out",
    });
  }

  /** Get a pending request by id. */
  getPending(approvalId: string): ApprovalRequest | null {
    return this.pending.get(approvalId)?.request ?? null;
  }

  /** Get a resolved result by id. */
  getApproval(approvalId: string): ApprovalResult | null {
    return this.resolved.get(approvalId) ?? null;
  }

  /** List all currently pending requests. */
  listPending(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  /** Get the number of pending approvals. */
  pendingCount(): number {
    return this.pending.size;
  }

  /** Dispose: cancel all pending approvals and stop cleanup timer. Idempotent. */
  dispose(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const id of [...this.pending.keys()]) {
      this.cancel(id, "ApprovalManager disposed");
    }
    this.cleanupOldResolvedEntries();
  }

  /** Active timer handle for lifecycle tests (null when stopped/disposed). */
  hasCleanupTimer(): boolean {
    return this.cleanupTimer !== null;
  }

  /** Get the number of resolved approvals (for monitoring). */
  resolvedCount(): number {
    return this.resolved.size;
  }

  // ---- Private ----

  private resolvePending(
    approvalId: string,
    result: ApprovalResult,
  ): ApprovalResult {
    const pending = this.pending.get(approvalId);
    if (!pending) return result;
    this.pending.delete(approvalId);
    if (pending.timer) clearTimeout(pending.timer);
    this.resolved.set(approvalId, result);
    pending.resolve(result);
    try {
      // Host notification (UI state sync). Must not break resolution.
      this.onApprovalResolved?.(result);
    } catch {
      // listener errors are ignored by design
    }
    return result;
  }
}
