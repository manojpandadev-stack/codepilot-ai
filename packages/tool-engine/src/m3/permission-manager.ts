/**
 * @codepilot/tool-engine — M3 ToolPermissionManager
 *
 * Decides whether a tool execution may proceed. Decisions are correlated with
 * toolId + executionId and can be scoped:
 *   - "deny"     → execution rejected
 *   - "allow"    → allowed by policy
 *   - "approve"  → requires explicit user approval
 * Session-scope approvals ("allow for session") are held in memory only.
 */

import type { ToolPermissionLevel } from "./types.js";

export type PermissionDecisionType = "allow" | "deny" | "approve";

export interface PermissionDecision {
  type: PermissionDecisionType;
  /** Why this decision was made (for events + audit). */
  reason: string;
  /** Whether this decision should persist for the rest of the session. */
  scope: "once" | "session";
}

export interface ToolPermissionRule {
  toolId: string;
  /** Explicit override for this tool. */
  decision: PermissionDecisionType;
}

export interface ToolPermissionManagerOptions {
  /** Default decision for tools whose level is not covered by a level policy. */
  defaultDecision?: PermissionDecisionType;
  /** Decision per escalation level (wins over default). */
  levelPolicies?: Partial<Record<ToolPermissionLevel, PermissionDecisionType>>;
  /** Explicit per-tool overrides (win over level policies). */
  rules?: ToolPermissionRule[];
}

/** Ordered privilege levels — the highest requested level wins comparisons. */
const LEVEL_ORDER: ToolPermissionLevel[] = [
  "read",
  "interaction",
  "write",
  "network",
  "execute",
  "destructive",
];

export class ToolPermissionManager {
  private readonly levelPolicies: Partial<
    Record<ToolPermissionLevel, PermissionDecisionType>
  >;
  private readonly rules = new Map<string, PermissionDecisionType>();
  private readonly sessionApprovals = new Set<string>();
  private readonly sessionDenials = new Set<string>();
  private defaultDecision: PermissionDecisionType;

  constructor(options: ToolPermissionManagerOptions = {}) {
    this.defaultDecision = options.defaultDecision ?? "approve";
    this.levelPolicies = options.levelPolicies ?? {};
    for (const rule of options.rules ?? []) {
      this.rules.set(rule.toolId, rule.decision);
    }
  }

  /**
   * Decide for an execution. `executionId`/`taskId` are accepted so callers
   * can correlate the decision; decisions themselves are per-tool scoped.
   */
  decide(
    toolId: string,
    level: ToolPermissionLevel,
    executionId: string,
    _taskId?: string,
  ): PermissionDecision {
    void executionId;
    void _taskId;
    // 1. Explicit per-session user decision (once/session) wins.
    if (this.sessionApprovals.has(toolId)) {
      return {
        type: "allow",
        reason: "Approved for session by user",
        scope: "session",
      };
    }
    if (this.sessionDenials.has(toolId)) {
      return {
        type: "deny",
        reason: "Denied for session by user",
        scope: "session",
      };
    }
    // 2. Explicit per-tool rule.
    const rule = this.rules.get(toolId);
    if (rule) {
      return {
        type: rule,
        reason: `Explicit rule for '${toolId}'`,
        scope: "once",
      };
    }
    // 3. Level policy.
    const levelDecision = this.levelPolicies[level];
    if (levelDecision) {
      return {
        type: levelDecision,
        reason: `Level policy for '${level}'`,
        scope: "once",
      };
    }
    // 4. Safe defaults: reads and questions are auto-allowed, everything else
    //    requires approval.
    if (level === "read" || level === "interaction") {
      return {
        type: "allow",
        reason: `Default allow for '${level}'`,
        scope: "once",
      };
    }
    return {
      type: this.defaultDecision,
      reason: `Default policy (${this.defaultDecision}) for '${level}'`,
      scope: "once",
    };
  }

  /** Record a user approval. scope "session" persists for this session. */
  recordApproval(toolId: string, scope: "once" | "session"): void {
    if (scope === "session") this.sessionApprovals.add(toolId);
  }

  /** Record a user rejection. scope "session" persists for this session. */
  recordDenial(toolId: string, scope: "once" | "session"): void {
    if (scope === "session") this.sessionDenials.add(toolId);
  }

  setRule(toolId: string, decision: PermissionDecisionType): void {
    this.rules.set(toolId, decision);
  }

  setLevelPolicy(
    level: ToolPermissionLevel,
    decision: PermissionDecisionType,
  ): void {
    this.levelPolicies[level] = decision;
  }

  setDefaultDecision(decision: PermissionDecisionType): void {
    this.defaultDecision = decision;
  }

  /** Clear in-memory session state (new session, tests). */
  resetSession(): void {
    this.sessionApprovals.clear();
    this.sessionDenials.clear();
  }

  /** Highest privilege level in LEVEL_ORDER covered by the given levels. */
  static maxLevel(levels: ToolPermissionLevel[]): ToolPermissionLevel {
    let best: ToolPermissionLevel = "read";
    for (const level of levels) {
      if (LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(best)) best = level;
    }
    return best;
  }
}
