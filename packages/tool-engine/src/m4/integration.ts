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

import {
  PermissionPolicyEngine,
  operationFingerprintOf,
} from "./policy-engine.js";
import { CommandValidator } from "@codepilot/shared";
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
  /**
   * Command policy validator for execute-shaped inputs. Defaults to the
   * CANONICAL CommandValidator from @codepilot/shared — the same single
   * implementation the runtime policy gate uses (one rule set, no copies).
   * Hosts and tests may inject a stub; a validator that throws results in
   * a deny-closed decision (command validation must never fail open).
   */
  commandValidator?: {
    validate(command: string): { allowed: boolean; reason?: string };
  };
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
  // The canonical web fetch tool id must map to its own network action —
  // without this it fell through to read_file (auto-approved), letting an
  // outbound request run with no permission decision.
  web_fetch: "web_fetch",
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
  browser_select: "network_request",
  browser_console: "web_fetch",
  browser_network: "web_fetch",
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
  // SECURITY: direct live-tool aliases. The LiveToolPermissionBridge maps
  // these to execute_command before calling the pipeline, but the pipeline
  // is a public API — without explicit entries toolIdToAction("bash")/
  // ("run_commands") fell through to read_file (auto-approve), a
  // misclassification hazard for any direct caller.
  bash: "execute_command",
  run_commands: "execute_command",
  run_command: "execute_command",
  terminal: "execute_command",
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

/**
 * SECURITY (P0-1): action used for tool ids with no explicit mapping.
 *
 * Unknown/unmapped tool ids previously fell through to `read_file`, which
 * the policy engine AUTO-APPROVES — any tool id absent from the map (a
 * typo, a newly registered tool, an attacker-supplied id) executed with no
 * permission decision at all. Fail closed instead: `write_file` has no
 * auto-approve entry, so the policy engine's ASK fallback requires explicit
 * user approval before the tool can run — the same deny-biased fallback the
 * LiveToolPermissionBridge already applies to unmapped live tool names
 * (UNMAPPED_TOOL_ID → apply_file_changes → write_file).
 */
const UNKNOWN_TOOL_ACTION: PermissionAction = "write_file";

export function toolIdToAction(toolId: string): PermissionAction {
  // Own-property check only: a plain object lookup would return inherited
  // members (`"constructor"`, `"toString"`, `"__proto__"`) as if they were
  // declared mappings, bypassing the fail-closed default below.
  if (Object.prototype.hasOwnProperty.call(TOOL_ID_ACTION_MAP, toolId)) {
    return TOOL_ID_ACTION_MAP[toolId] as PermissionAction;
  }
  return UNKNOWN_TOOL_ACTION;
}

// ============================================================================
// Execute-shaped classification — shared command policy (hard deny boundary)
// ============================================================================

/** Same execute-prefix heuristic the runtime gate applies to unlisted tools. */
const EXECUTE_PREFIX_PATTERN = /^(exec|run|execute|call|invoke)/i;

/**
 * File-mutation actions. Their inputs NEVER legitimately carry a
 * `command`/`cmd` field, so a command field present on one of these is
 * execute-shaped, not data (this also covers live tools the
 * LiveToolPermissionBridge normalized to `apply_file_changes` while
 * preserving the original input payload).
 */
const WRITE_ACTIONS: ReadonlySet<PermissionAction> = new Set<PermissionAction>([
  "write_file",
  "edit_file",
  "delete_file",
  "move_file",
  "create_directory",
]);

export type ExecuteShape =
  /** NOT execute-shaped: the command policy must not gate this tool call. */
  | { executeShaped: false }
  /** Execute-shaped with no command payload — nothing to validate. */
  | { executeShaped: true; command: { kind: "absent" } }
  /** Execute-shaped with a non-string payload — deny-closed. */
  | { executeShaped: true; command: { kind: "malformed" } }
  /** Execute-shaped with a real command string for the validator. */
  | { executeShaped: true; command: { kind: "string"; value: string } };

/**
 * Clearly defined execute-shaped classification for the shared command
 * policy. A tool call is execute-shaped when it carries a `command`/`cmd`
 * input field AND at least one of:
 *
 *   1. its action IS command execution (bash / run_commands / run_command /
 *      terminal / terminal_session_exec / execute_command — the recognized
 *      shell tools, including bridge-normalized live tools);
 *   2. its tool id has NO explicit mapping (unknown ids fail closed);
 *   3. its tool id matches the runtime's execute-prefix heuristic
 *      (`^(exec|run|execute|call|invoke)` — the canonical inference the
 *      runtime gate applies to unlisted tools);
 *   4. its action is a file mutation (writes never carry commands).
 *
 * Unrelated tools (reads, network, git, MCP, ask, …) are NEVER captured
 * merely for having a field named `command`, and the command STRING still
 * has to match a blocked pattern before anything is denied — safe commands
 * on captured tools proceed through the normal permission modes unchanged.
 */
export function classifyExecuteShape(
  toolId: string,
  action: PermissionAction,
  input: unknown,
): ExecuteShape {
  if (input === null || typeof input !== "object") {
    return { executeShaped: false };
  }
  const rec = input as Record<string, unknown>;
  if (!("command" in rec) && !("cmd" in rec)) {
    return { executeShaped: false };
  }
  const known = Object.prototype.hasOwnProperty.call(
    TOOL_ID_ACTION_MAP,
    toolId,
  );
  const executeShaped =
    action === "execute_command" ||
    !known ||
    EXECUTE_PREFIX_PATTERN.test(toolId) ||
    WRITE_ACTIONS.has(action);
  if (!executeShaped) return { executeShaped: false };
  // Mirror the runtime gate's payload selection: `command ?? cmd`.
  const raw = rec.command ?? rec.cmd;
  if (raw === undefined) {
    return { executeShaped: true, command: { kind: "absent" } };
  }
  if (typeof raw !== "string") {
    return { executeShaped: true, command: { kind: "malformed" } };
  }
  return { executeShaped: true, command: { kind: "string", value: raw } };
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
  /** Canonical command policy — see M4PipelineConfig.commandValidator. */
  private readonly commandValidator: {
    validate(command: string): { allowed: boolean; reason?: string };
  };

  constructor(config: M4PipelineConfig) {
    this.presentApproval = config.presentApproval;
    this.approvalTimeoutMs = config.approvalTimeoutMs ?? 60_000;
    this.commandValidator = config.commandValidator ?? new CommandValidator();

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

    // ---- HARD COMMAND POLICY (shared canonical CommandValidator) --------
    // Runs BEFORE the policy engine and BEFORE any approval card: a
    // blocked or malformed execute-shaped command is a hard deny that no
    // policy, auto-approve setting, session grant, or approval callback can
    // override — the ASK path is never reached, so no approval card is ever
    // presented. Same rule set as the runtime gate (one implementation in
    // @codepilot/shared) — closes the M4-only/custom-host gap.
    const shape = classifyExecuteShape(params.toolId, action, params.input);
    if (shape.executeShaped && shape.command.kind !== "absent") {
      const commandCheck = this.checkCommandPolicy(shape.command);
      if (!commandCheck.allowed) {
        return {
          approved: false,
          decision: "deny",
          reason: commandCheck.reason,
          risk: this.risk.assess(
            action,
            this.buildMetadata(params.input, params.cwd),
          ),
        };
      }
    }

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

  /**
   * Run the canonical command policy over an execute-shaped payload.
   * DENY-CLOSED: a malformed payload or a validator that throws both
   * deny — command validation being unavailable must never fail open.
   */
  private checkCommandPolicy(
    command:
      | {
          kind: "malformed";
        }
      | {
          kind: "string";
          value: string;
        },
  ): { allowed: boolean; reason: string } {
    if (command.kind === "malformed") {
      return {
        allowed: false,
        reason:
          "Command blocked by security policy: malformed command input (deny-closed)",
      };
    }
    try {
      const result = this.commandValidator.validate(command.value);
      if (result.allowed) return { allowed: true, reason: "" };
      return {
        allowed: false,
        reason: `Command blocked by security policy: ${result.reason ?? "blocked pattern"}`,
      };
    } catch (err) {
      return {
        allowed: false,
        reason: `Command validation unavailable — denied (deny-closed): ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
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
    // SECURITY: the grant is bound to the OPERATION FINGERPRINT of the
    // exact approved operation (action + command + paths + cwd). A session
    // grant for `node --version` can never authorize a different command —
    // a materially different command re-enters the ASK path and prompts.
    // Single_execution grants are also fingerprinted for auditability but
    // are consumed by their one approval and never re-match (scope guard).
    this.policy.grantScopedPermission({
      id: `grant-${result.approvalId}`,
      action: context.action,
      scope,
      sessionId: context.sessionId,
      taskId: context.taskId,
      workspaceRoot: this.security.workspaceRoot,
      operationFingerprint: operationFingerprintOf(context),
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
