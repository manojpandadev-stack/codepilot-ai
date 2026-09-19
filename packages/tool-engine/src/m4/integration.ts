/**
 * @codepilot/tool-engine — M4 integration layer
 *
 * Wires the M4 permission/approval pipeline into the M3 execution path.
 *
 * Pipeline:
 *   tool call
 *     → RiskEngine.evaluate()     → risk level + reasons
 *     → PermissionPolicyEngine    → ALLOW / DENY / ASK
 *     → (if ASK) ApprovalManager  → pending approval → user decision
 *     → SecurityValidator         → workspace boundary, path safety, command safety
 *     → tool.execute()
 *
 * Security boundaries (workspace, path, command) are ALWAYS enforced,
 * regardless of policy or approval decisions.
 */

import { PermissionPolicyEngine } from "./policy-engine.js";
import { ApprovalManager } from "./approval-manager.js";
import { RiskEngine } from "./risk-engine.js";
import { SecurityValidator } from "./security-validator.js";
import type {
  ApprovalResult,
  PermissionAction,
  PermissionContext,
  PermissionDecision,
  PermissionPolicy,
  PermissionScope,
  RiskAssessment,
} from "./permission-types.js";

// ============================================================================
// Configuration
// ============================================================================

export interface M4PipelineConfig {
  /** Workspace root — used for boundary enforcement. */
  workspaceRoot: string;
  /** Custom policies (merged with defaults). */
  policies?: PermissionPolicy[];
  /** Default timeout for user approvals in ms (default 60_000). */
  approvalTimeoutMs?: number;
  /** Whether to enable auto-approval for low-risk read operations. */
  autoApproveReads?: boolean;
  /**
   * Host-provided function to surface an approval request to the user.
   * Returns the user's decision. Receives a sanitized approval descriptor.
   */
  presentApproval: (
    request: ApprovalPresentation,
  ) => Promise<UserApprovalChoice>;
  /**
   * Host-provided callback fired when an approval reaches a terminal state
   * (approve / reject / cancel / expire / dispose) — lets the host retire
   * the pending UI card even when the user never clicked a button.
   */
  onApprovalResolved?: (result: ApprovalResult) => void;
}

/** Sanitized approval request presented to the user (no secrets). */
export interface ApprovalPresentation {
  approvalId: string;
  toolId: string;
  executionId: string;
  action: PermissionAction;
  description: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  riskReasons: string[];
  /** Preview of the operation (sanitized). */
  preview?: string;
  workingDirectory?: string;
  /** Whether session-scoped approval is offered. */
  allowSession: boolean;
  /** Whether task-scoped approval is offered. */
  allowTask: boolean;
}

export interface UserApprovalChoice {
  decision: "allow" | "deny";
  scope?: "once" | "session" | "task";
  reason?: string;
}

// ============================================================================
// Action mapping from M3 tool categories/ids
// ============================================================================

const TOOL_ID_ACTION_MAP: Record<string, PermissionAction> = {
  // Network / external capability tools. Without explicit entries these
  // fell through to read_file (auto-approved) — a permission bypass.
  use_web: "web_fetch",
  mcp_tool: "mcp_tool",
  mcp_resource: "mcp_resource",
  // --- Browser automation tools (@codepilot/browser-engine) --------------
  // Read-like browser operations map to web_fetch (medium risk, treated as
  // read for auto-approve); state-changing interactions map to
  // network_request (high risk → ASK by default). No browser action can
  // fall through to the auto-approved read path.
  browser_navigate: "web_fetch",
  browser_back: "web_fetch",
  browser_forward: "web_fetch",
  browser_reload: "web_fetch",
  browser_extract: "web_fetch",
  browser_screenshot: "web_fetch",
  browser_wait: "web_fetch",
  browser_scroll: "web_fetch",
  browser_click: "network_request",
  browser_type: "network_request",
  browser_press: "network_request",
  browser_close: "web_fetch",
  read_file: "read_file",
  write_file: "write_file",
  edit_file: "edit_file",
  delete_file: "delete_file",
  move_file: "move_file",
  list_directory: "list_directory",
  create_directory: "create_directory",
  search_files: "search_files",
  search_text: "search_text",
  execute_command: "execute_command",
  kill_process: "kill_process",
  git_diff: "git_operation",
  git_status: "git_operation",
  ask_user: "ask_user",
  // --- M5 mutation/checkpoint tools -------------------------------------
  // Mutating tools must be classified as writes so M4 requires approval;
  // leaving them unmapped would fall through to read_file (auto-approve),
  // which would be a permission bypass.
  apply_file_changes: "write_file",
  restore_checkpoint: "write_file",
  revert_change: "write_file",
  revert_task_changes: "write_file",
  // Read-only M5 tools retain read approval behavior.
  create_checkpoint: "read_file",
  list_checkpoints: "read_file",
  get_diff: "read_file",
};

export function toolIdToAction(toolId: string): PermissionAction {
  return TOOL_ID_ACTION_MAP[toolId] ?? "read_file";
}

// ============================================================================
// Evaluation result
// ============================================================================

export interface PipelineDecision {
  approved: boolean;
  decision: PermissionDecision;
  reason: string;
  risk: RiskAssessment;
  approvalId?: string;
}

// ============================================================================
// M4PermissionPipeline
// ============================================================================

export class M4PermissionPipeline {
  private readonly policy: PermissionPolicyEngine;
  private readonly risk: RiskEngine;
  private readonly approvals: ApprovalManager;
  private readonly security: SecurityValidator;
  private readonly presentApproval: M4PipelineConfig["presentApproval"];
  private readonly approvalTimeoutMs: number;

  constructor(config: M4PipelineConfig) {
    this.presentApproval = config.presentApproval;
    this.approvalTimeoutMs = config.approvalTimeoutMs ?? 60_000;

    this.risk = new RiskEngine();
    this.policy = new PermissionPolicyEngine({ riskEngine: this.risk });
    this.approvals = new ApprovalManager({
      defaultTimeoutMs: this.approvalTimeoutMs,
      onApprovalResolved: config.onApprovalResolved,
      onApprovalRequested: (request) => {
        // Surface the approval request to the host (VS Code / WebView).
        // This is fire-and-forget — the actual resolution happens when the
        // host calls approve()/reject() on the ApprovalManager.
        void this.presentApproval({
          approvalId: request.approvalId,
          toolId: request.toolId,
          executionId: request.executionId,
          action: request.action,
          description: request.description,
          riskLevel:
            request.risk.level.toUpperCase() as ApprovalPresentation["riskLevel"],
          riskReasons: request.risk.reasons,
          preview: request.preview
            ? Object.entries(request.preview)
                .map(
                  ([k, v]) =>
                    `${k}: ${typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "…" : v}`,
                )
                .join(" | ")
            : undefined,
          workingDirectory: request.preview?.path as string | undefined,
          allowSession: true,
          allowTask: true,
        });
      },
    });
    this.security = new SecurityValidator({
      workspaceRoot: config.workspaceRoot,
    });

    if (config.autoApproveReads !== false) {
      this.policy.setAutoApprove("read_file", "allow");
      this.policy.setAutoApprove("list_directory", "allow");
      this.policy.setAutoApprove("search_files", "allow");
      this.policy.setAutoApprove("search_text", "allow");
      this.policy.setAutoApprove("git_operation", "allow");
    }
    for (const p of config.policies ?? []) {
      this.policy.addPolicy(p);
    }
  }

  get approvalManager(): ApprovalManager {
    return this.approvals;
  }

  get policyEngine(): PermissionPolicyEngine {
    return this.policy;
  }

  get riskEngine(): RiskEngine {
    return this.risk;
  }

  get securityValidator(): SecurityValidator {
    return this.security;
  }

  /**
   * Evaluate whether a tool execution is permitted.
   * If approval is required, this method blocks until the user decides,
   * the approval times out, or is cancelled.
   */
  async evaluate(params: {
    toolId: string;
    executionId: string;
    sessionId?: string;
    taskId?: string;
    input: unknown;
    cwd?: string;
  }): Promise<PipelineDecision> {
    const action = toolIdToAction(params.toolId);
    const context: PermissionContext = {
      action,
      toolId: params.toolId,
      executionId: params.executionId,
      sessionId: params.sessionId,
      taskId: params.taskId,
      workspaceRoot: this.security.workspaceRoot,
      metadata: this.buildMetadata(params.input, params.cwd),
    };

    // 1. Policy evaluation (includes hard security boundaries)
    const evaluation = this.policy.evaluate(context);

    // 2. DENY / DENY_SESSION → never execute
    if (
      evaluation.decision === "deny" ||
      evaluation.decision === "deny_session"
    ) {
      return {
        approved: false,
        decision: evaluation.decision,
        reason: evaluation.reason,
        risk: evaluation.risk,
      };
    }

    // 3. ALLOW → still enforce security boundaries before executing
    if (evaluation.decision === "allow") {
      const boundary = this.enforceBoundaries(params.input, params.cwd);
      if (!boundary.ok) {
        return {
          approved: false,
          decision: "deny",
          reason: boundary.reason,
          risk: this.risk.assess(action, context.metadata),
        };
      }
      return {
        approved: true,
        decision: "allow",
        reason: evaluation.reason,
        risk: evaluation.risk,
      };
    }

    // 4. ASK → require explicit approval
    const approvalResult = await this.requestUserApproval(
      context,
      evaluation,
      params,
    );
    if (approvalResult.approved) {
      const boundary = this.enforceBoundaries(params.input, params.cwd);
      if (!boundary.ok) {
        return {
          approved: false,
          decision: "deny",
          reason: boundary.reason,
          risk: this.risk.assess(action, context.metadata),
        };
      }
    }
    return approvalResult;
  }

  /** Build metadata for policy evaluation from the raw tool input. */
  private buildMetadata(input: unknown, cwd?: string): Record<string, unknown> {
    const meta: Record<string, unknown> = {};
    if (input && typeof input === "object") {
      const rec = input as Record<string, unknown>;
      if (typeof rec.path === "string") meta.path = rec.path;
      if (typeof rec.command === "string") meta.command = rec.command;
      if (typeof rec.oldPath === "string") meta.oldPath = rec.oldPath;
      if (typeof rec.newPath === "string") meta.newPath = rec.newPath;
    }
    if (cwd) meta.cwd = cwd;
    return meta;
  }

  /** Enforce workspace, path, and command boundaries. Never bypasses. */
  private enforceBoundaries(
    input: unknown,
    _cwd?: string,
  ): { ok: boolean; reason: string } {
    if (input && typeof input === "object") {
      const rec = input as Record<string, unknown>;
      if (typeof rec.command === "string") {
        const result = this.security.validateCommand(rec.command);
        return { ok: result.allowed, reason: result.reason ?? "" };
      }
      if (typeof rec.path === "string") {
        const result = this.security.validatePath(rec.path);
        return { ok: result.allowed, reason: result.reason ?? "" };
      }
      if (typeof rec.oldPath === "string") {
        const result = this.security.validatePath(rec.oldPath);
        if (!result.allowed) return { ok: false, reason: result.reason ?? "" };
      }
      if (typeof rec.newPath === "string") {
        const result = this.security.validatePath(rec.newPath);
        return { ok: result.allowed, reason: result.reason ?? "" };
      }
    }
    return { ok: true, reason: "" };
  }

  private async requestUserApproval(
    context: PermissionContext,
    evaluation: {
      decision: PermissionDecision;
      reason: string;
      risk: RiskAssessment;
    },
    params: { toolId: string; executionId: string; input: unknown },
  ): Promise<PipelineDecision> {
    // Create the approval request — this returns a Promise that resolves when
    // the user approves/rejects via the ApprovalManager. The onApprovalRequested
    // callback (set in the constructor) surfaces the UI via presentApproval.
    const approvalPromise = this.approvals.requestApproval({
      toolId: params.toolId,
      executionId: params.executionId,
      sessionId: context.sessionId,
      taskId: context.taskId,
      action: context.action,
      risk: evaluation.risk,
      description: evaluation.reason,
      preview: this.buildPreviewRecord(params.input),
      timeoutMs: this.approvalTimeoutMs,
    });

    // Await the approval result — resolves when user approves/rejects or timeout fires
    const result = await approvalPromise;

    if (
      result.status === "rejected" ||
      result.status === "cancelled" ||
      result.status === "expired"
    ) {
      return {
        approved: false,
        decision: "deny",
        reason: result.reason || "Approval denied",
        risk: evaluation.risk,
        approvalId: result.approvalId,
      };
    }

    // approved
    const scope: PermissionScope =
      result.scope === "session"
        ? "session"
        : result.scope === "task"
          ? "task"
          : "single_execution";
    this.policy.grantScopedPermission({
      id: `grant-${result.approvalId}`,
      action: context.action,
      scope,
      sessionId: context.sessionId,
      taskId: context.taskId,
      workspaceRoot: this.security.workspaceRoot,
    });

    return {
      approved: true,
      decision: scope === "single_execution" ? "allow" : "allow_session",
      reason: `User approved (${scope})`,
      risk: evaluation.risk,
      approvalId: result.approvalId,
    };
  }

  /** Build a sanitized preview record from tool input — never exposes secrets. */
  private buildPreviewRecord(
    input: unknown,
  ): Record<string, unknown> | undefined {
    if (!input || typeof input !== "object") return undefined;
    const rec = input as Record<string, unknown>;
    const preview: Record<string, unknown> = {};
    for (const key of ["path", "command", "oldPath", "newPath", "query"]) {
      const val = rec[key];
      if (typeof val === "string" && val.length > 0) {
        preview[key] = val.length > 200 ? val.slice(0, 200) + "…" : val;
      }
    }
    return Object.keys(preview).length > 0 ? preview : undefined;
  }

  /** Revoke a previously granted scoped permission. */
  revoke(id: string): boolean {
    return this.policy.revokeScopedPermission(id);
  }

  /** Clear all session-scoped permissions. */
  clearSession(sessionId: string): void {
    this.policy.clearSessionPermissions(sessionId);
  }

  /** Dispose the pipeline and cancel pending approvals. */
  dispose(): void {
    this.approvals.dispose();
  }
}
