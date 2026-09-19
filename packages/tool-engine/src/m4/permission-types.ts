/**
 * @codepilot/tool-engine — M4 permission model
 *
 * Strongly-typed permission and approval contracts that sit between the
 * ToolRegistry and tool execution. These types are consumed by the
 * PermissionPolicyEngine, ApprovalManager, RiskEngine and AuditLogger.
 *
 * Every privileged operation must declare a PermissionAction. The policy
 * engine maps (action + context) to a PermissionDecision, possibly ASK.
 * ASK requests flow through the ApprovalManager, which produces an
 * ApprovalResult with exactly-once semantics.
 */

// ============================================================================
// Permission actions
// ============================================================================

export type PermissionAction =
  | "read_file"
  | "write_file"
  | "edit_file"
  | "delete_file"
  | "move_file"
  | "create_directory"
  | "list_directory"
  | "search_files"
  | "search_text"
  | "execute_command"
  | "kill_process"
  | "network_request"
  | "web_fetch"
  | "git_operation"
  | "mcp_tool"
  | "mcp_resource"
  | "environment_access"
  | "ask_user";

// ============================================================================
// Decisions
// ============================================================================

export type PermissionDecision =
  "allow" | "deny" | "ask" | "allow_session" | "deny_session";

// ============================================================================
// Scopes for granted permissions
// ============================================================================

export type PermissionScope =
  "single_execution" | "session" | "task" | "workspace" | "global";

// ============================================================================
// Risk classification
// ============================================================================

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface RiskAssessment {
  level: RiskLevel;
  reasons: string[];
  /** True when the operation is considered destructive/dangerous per se. */
  destructive: boolean;
}

// ============================================================================
// Policy
// ============================================================================

export interface PermissionPolicy {
  id: string;
  /** Actions this policy governs. Empty = match-all. */
  actions: PermissionAction[];
  decision: PermissionDecision;
  scope: PermissionScope;
  /** Higher priority wins when multiple policies match. */
  priority: number;
  /** Optional human-readable description shown in explain(). */
  description?: string;
  /** Whether the policy is currently active. */
  enabled: boolean;
}

// ============================================================================
// Evaluation context & result
// ============================================================================

export interface PermissionContext {
  action: PermissionAction;
  toolId: string;
  executionId: string;
  sessionId?: string;
  taskId?: string;
  workspaceRoot?: string;
  /** Action-specific metadata (command string, file path, url, ...). */
  metadata?: Record<string, unknown>;
}

export interface PermissionEvaluation {
  decision: PermissionDecision;
  policyId?: string;
  reason: string;
  risk: RiskAssessment;
}

// ============================================================================
// Approval request / result
// ============================================================================

export type ApprovalStatus =
  "pending" | "approved" | "rejected" | "cancelled" | "expired";

export interface ApprovalRequest {
  approvalId: string;
  toolId: string;
  executionId: string;
  sessionId?: string;
  taskId?: string;
  action: PermissionAction;
  risk: RiskAssessment;
  description: string;
  /** Sanitized, user-safe preview of the operation inputs. */
  preview?: Record<string, unknown>;
  requestedAt: number;
  timeoutMs: number;
}

export interface ApprovalResult {
  approvalId: string;
  status: ApprovalStatus;
  scope: PermissionScope;
  resolvedAt: number;
  reason?: string;
}

// ============================================================================
// Session / task permission record
// ============================================================================

export interface ScopedPermission {
  id: string;
  action: PermissionAction;
  scope: PermissionScope;
  sessionId?: string;
  taskId?: string;
  workspaceRoot?: string;
  grantedAt: number;
}
