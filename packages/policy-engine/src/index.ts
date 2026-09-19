/**
 * @codepilot/policy-engine
 *
 * Tool governance and security policy engine for CodePilot AI.
 * Controls which tools can run, whether they need approval, and validates
 * dangerous operations before execution.
 */

import type {
  ToolPolicy,
  ToolApprovalRequest,
  ToolApprovalResult,
} from "@codepilot/shared";
import {
  type ToolPermission,
  type ToolPermissionPolicy,
  type ToolCategory,
  BLOCKED_COMMANDS,
  DEFAULT_TOOL_POLICIES,
} from "@codepilot/shared";

// ============================================================================
// Tool Category Classifier
// ============================================================================

const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  // Read tools (native callable names plus UI/policy aliases)
  read_files: "read",
  read_file: "read",
  search: "read",
  search_codebase: "read",
  grep: "read",
  list_directory: "read",
  list_files: "read",
  git_diff: "read",
  git_status: "read",
  git_log: "read",
  git_show: "read",

  // Write tools
  write_file: "write",
  create_file: "write",
  apply_patch: "write",
  editor: "write",
  delete_file: "write",
  rename_file: "write",
  move_file: "write",

  // Execute tools
  bash: "execute",
  run_commands: "execute",
  terminal: "execute",

  // Network tools
  web_fetch: "network",
  fetch: "network",
  fetch_web_content: "network",
  web_search: "network",

  // Git tools
  git_commit: "git",
  git_push: "git",
  git_pull: "git",
  git_checkout: "git",
  git_merge: "git",
  git_rebase: "git",
  git_reset: "git",
  git_stash: "git",

  // MCP tools
  ask_question: "read",
  skills: "read",
};

// MCP tool default classification by tool name pattern
const MCP_TOOL_PATTERNS: Array<{ pattern: RegExp; category: ToolCategory }> = [
  { pattern: /^(list|read|get|search|find|query|describe)/i, category: "read" },
  {
    pattern: /^(write|create|update|insert|delete|drop|remove|patch)/i,
    category: "write",
  },
  { pattern: /^(exec|run|execute|call|invoke)/i, category: "execute" },
];

/**
 * Classify an MCP tool ID (serverName:toolName) into a category.
 */
function classifyMCPTool(toolId: string): ToolCategory {
  const colonIdx = toolId.indexOf(":");
  if (colonIdx < 0) return "system";
  const toolName = toolId.slice(colonIdx + 1);
  for (const { pattern, category } of MCP_TOOL_PATTERNS) {
    if (pattern.test(toolName)) return category;
  }
  return "read"; // Default MCP tools to read (safe default)
}

// ============================================================================
// Command Validator
// ============================================================================

/**
 * Validates shell commands against security policies.
 */
export class CommandValidator {
  private blockedPatterns: RegExp[] = BLOCKED_COMMANDS.map(
    (cmd) => new RegExp(cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
  );

  private additionalBlockedPatterns: RegExp[] = [
    /\brm\s+-rf\s+[\/~]/i, // rm -rf from root or home
    /\bmkfs\b/i,
    /\bdd\b.*\bof=\/dev\//i,
    /\bformat\b.*\b[Cc]:/i,
    />\s*\/dev\/[sh]da/i,
    /\bchmod\s+777\b/i,
    /\bchown\s+.*\/\b/i,
    /curl.*\|\s*bash/i, // pipe to bash
    /wget.*\|\s*sh/i, // pipe to shell
    /\bsudo\b/i, // block sudo by default
    /\b(kill|killall)\s+-9\s+(?!self|current)/i,
    /\bnc\s+-l/i, // netcat listener
    /\bpython\s*-c\s*.*import\s+os.*system/i, // suspicious python
  ];

  /**
   * Validate a command before execution.
   */
  validate(command: string): { allowed: boolean; reason?: string } {
    const trimmed = command.trim();

    if (!trimmed) {
      return { allowed: false, reason: "Empty command" };
    }

    // Check explicitly blocked commands
    for (const pattern of this.blockedPatterns) {
      if (pattern.test(trimmed)) {
        return {
          allowed: false,
          reason: `Command matches blocked pattern: ${pattern.source}`,
        };
      }
    }

    // Check additional blocked patterns
    for (const pattern of this.additionalBlockedPatterns) {
      if (pattern.test(trimmed)) {
        return {
          allowed: false,
          reason: `Command matches security policy: ${pattern.source}`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Add a custom blocked pattern.
   */
  addBlockedPattern(pattern: RegExp): void {
    this.additionalBlockedPatterns.push(pattern);
  }
}

// ============================================================================
// Policy Engine
// ============================================================================

export type AgentMode = "plan" | "act" | "review";

const WRITE_TOOL_CATEGORIES: ToolCategory[] = ["write", "execute", "git"];

/**
 * The main policy engine that governs tool execution.
 */
export class PolicyEngine {
  private policies: Map<string, ToolPermissionPolicy> = new Map();
  private commandValidator: CommandValidator;
  private auditLog: AuditEntry[] = [];
  private agentMode: AgentMode = "act";

  constructor(options?: {
    customPolicies?: ToolPermissionPolicy[];
    initialMode?: AgentMode;
  }) {
    this.commandValidator = new CommandValidator();
    if (options?.initialMode) {
      this.agentMode = options.initialMode;
    }

    // Load default policies
    for (const [toolName, permission] of Object.entries(
      DEFAULT_TOOL_POLICIES,
    )) {
      this.policies.set(toolName, {
        toolName,
        category: TOOL_CATEGORIES[toolName] ?? "system",
        permission,
        description: `Default policy for ${toolName}`,
      });
    }

    // Apply custom policies
    if (options?.customPolicies) {
      for (const policy of options.customPolicies) {
        this.policies.set(policy.toolName, policy);
      }
    }
  }

  /**
   * Set the current agent mode (plan, act, review).
   */
  setAgentMode(mode: AgentMode): void {
    this.agentMode = mode;
    this.logAudit("system", "mode_change", `Agent mode set to ${mode}`);
  }

  /**
   * Get the current agent mode.
   */
  getAgentMode(): AgentMode {
    return this.agentMode;
  }

  /**
   * Check if a tool is allowed to execute.
   * In plan mode, only read-only tools are allowed.
   */
  checkPermission(toolName: string, input?: unknown): ToolPolicy {
    // PLAN MODE: block all write/edit/delete/execute/git-mutate tools
    if (this.agentMode === "plan") {
      const policy = this.policies.get(toolName);
      if (policy && WRITE_TOOL_CATEGORIES.includes(policy.category)) {
        this.logAudit(
          toolName,
          "blocked_plan_mode",
          `Tool '${toolName}' is blocked in Plan mode (${policy.category})`,
        );
        return { enabled: false, autoApprove: false };
      }
      // If category is unknown, default to blocking in plan mode to be safe
      if (!policy) {
        this.logAudit(
          toolName,
          "blocked_plan_mode",
          `Unknown tool '${toolName}' is blocked in Plan mode by default`,
        );
        return { enabled: false, autoApprove: false };
      }
    }
    const policy = this.policies.get(toolName);

    if (!policy) {
      // Unknown tool: require approval by default
      return { enabled: true, autoApprove: false };
    }

    if (policy.permission === "blocked") {
      return { enabled: false, autoApprove: false };
    }

    // For bash/execute tools, also validate the command
    if (
      policy.category === "execute" &&
      typeof input === "object" &&
      input !== null
    ) {
      const inputObj = input as Record<string, unknown>;
      const command = (inputObj.command ?? inputObj.cmd ?? "") as string;
      if (command) {
        const validation = this.commandValidator.validate(command);
        if (!validation.allowed) {
          this.logAudit(toolName, "blocked", validation.reason);
          return { enabled: false, autoApprove: false };
        }
      }
    }

    return {
      enabled: true,
      autoApprove: policy.permission === "auto",
    };
  }

  /**
   * Handle a tool approval request.
   */
  handleApprovalRequest(request: ToolApprovalRequest): ToolApprovalResult {
    const policy = this.policies.get(request.toolName);
    const permission = policy?.permission ?? "approval";

    this.logAudit(
      request.toolName,
      permission,
      `Approval requested for ${request.toolName}`,
    );

    if (permission === "blocked") {
      return { approved: false, reason: "Tool is blocked by security policy" };
    }

    if (permission === "auto") {
      return { approved: true, reason: "Auto-approved by policy" };
    }

    // For approval-required tools, the UI will handle the actual approval
    // This is a default implementation
    return { approved: false, reason: "Requires user approval" };
  }

  /**
   * Check permission for an MCP tool (identified by serverName:toolName).
   * MCP tools with write/execute categories require approval by default.
   */
  checkMCPPermission(toolId: string, _input?: unknown): ToolPolicy {
    // In plan mode, block all write/execute MCP tools
    if (this.agentMode === "plan") {
      const category = classifyMCPTool(toolId);
      if (WRITE_TOOL_CATEGORIES.includes(category)) {
        this.logAudit(
          toolId,
          "blocked_plan_mode",
          `MCP tool '${toolId}' is blocked in Plan mode (${category})`,
        );
        return { enabled: false, autoApprove: false };
      }
    }

    // Check explicit policy
    const policy = this.policies.get(toolId);
    if (policy) {
      if (policy.permission === "blocked") {
        this.logAudit(
          toolId,
          "blocked",
          `MCP tool '${toolId}' is blocked by policy`,
        );
        return { enabled: false, autoApprove: false };
      }
      return {
        enabled: true,
        autoApprove: policy.permission === "auto",
      };
    }

    // Auto-classify MCP tools by name pattern
    const category = classifyMCPTool(toolId);
    if (category === "read") {
      return { enabled: true, autoApprove: true };
    }
    // Write/execute MCP tools require approval
    return { enabled: true, autoApprove: false };
  }

  /**
   * Update a tool's permission policy.
   */
  setPolicy(toolName: string, permission: ToolPermission): void {
    const existing = this.policies.get(toolName);
    if (existing) {
      this.policies.set(toolName, { ...existing, permission });
    } else {
      this.policies.set(toolName, {
        toolName,
        category: TOOL_CATEGORIES[toolName] ?? "system",
        permission,
      });
    }
  }

  /**
   * Register an MCP tool policy explicitly.
   */
  setMCPToolPolicy(toolId: string, permission: ToolPermission): void {
    this.setPolicy(toolId, permission);
  }

  /**
   * Get all current policies.
   */
  getPolicies(): ToolPermissionPolicy[] {
    return Array.from(this.policies.values());
  }

  /**
   * Get the audit log.
   */
  getAuditLog(limit = 100): AuditEntry[] {
    return this.auditLog.slice(-limit);
  }

  /**
   * Get tool policies in the flat shape the native dispatcher gate consumes.
   */
  toNativeToolPolicies(): Record<string, ToolPolicy> {
    const result: Record<string, ToolPolicy> = {};
    for (const [toolName, policy] of this.policies) {
      if (
        this.agentMode === "plan" &&
        WRITE_TOOL_CATEGORIES.includes(policy.category)
      ) {
        result[toolName] = { enabled: false, autoApprove: false };
      } else {
        result[toolName] = {
          enabled: policy.permission !== "blocked",
          autoApprove: policy.permission === "auto",
        };
      }
    }
    return result;
  }

  // ---- Private ----

  private logAudit(toolName: string, action: string, detail?: string): void {
    this.auditLog.push({
      timestamp: Date.now(),
      toolName,
      action,
      detail,
    });

    // Keep audit log bounded
    if (this.auditLog.length > 10_000) {
      this.auditLog = this.auditLog.slice(-5_000);
    }
  }
}

// ============================================================================
// Types
// ============================================================================

export interface AuditEntry {
  timestamp: number;
  toolName: string;
  action: string;
  detail?: string;
}

export function createPolicyEngine(options?: {
  customPolicies?: ToolPermissionPolicy[];
  initialMode?: AgentMode;
}): PolicyEngine {
  return new PolicyEngine(options);
}
