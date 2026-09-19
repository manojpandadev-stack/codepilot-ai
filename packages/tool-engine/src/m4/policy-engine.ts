/**
 * @codepilot/tool-engine — M4 PermissionPolicyEngine
 *
 * Centralized, deterministic policy evaluator. Given a PermissionContext,
 * produces a PermissionEvaluation.
 *
 * Precedence (highest priority wins):
 *   1. HARD_SECURITY_DENY  — workspace escapes, CRITICAL risk boundaries
 *   2. explicit DENY / DENY_SESSION policy
 *   3. explicit ALLOW / ALLOW_SESSION policy
 *   4. active scoped permission (session/task/workspace/global)
 *   5. auto-approval config
 *   6. ASK fallback
 *
 * The policy engine NEVER overrides hard security boundaries. Even an ALLOW
 * rule cannot authorize an operation that escapes the workspace.
 */

import type {
  PermissionAction,
  PermissionContext,
  PermissionDecision,
  PermissionEvaluation,
  PermissionPolicy,
  PermissionScope,
  RiskAssessment,
} from "./permission-types.js";
import type { RiskEngine } from "./risk-engine.js";

export interface PermissionPolicyEngineOptions {
  riskEngine: RiskEngine;
  autoApprove?: Record<PermissionAction, PermissionDecision>;
  enabled?: boolean;
}

const DEFAULT_AUTO_APPROVE: Partial<
  Record<PermissionAction, PermissionDecision>
> = {
  read_file: "allow",
  list_directory: "allow",
  search_files: "allow",
  search_text: "allow",
  ask_user: "allow",
  web_fetch: "allow",
};

export class PermissionPolicyEngine {
  private readonly riskEngine: RiskEngine;
  private readonly autoApprove: Partial<
    Record<PermissionAction, PermissionDecision>
  >;
  private policies: PermissionPolicy[] = [];
  private readonly scopedPermissions: Array<{
    id: string;
    action: PermissionAction;
    scope: PermissionScope;
    sessionId?: string;
    taskId?: string;
    workspaceRoot?: string;
    grantedAt: number;
  }> = [];
  private enabled = true;

  constructor(options: PermissionPolicyEngineOptions) {
    this.riskEngine = options.riskEngine;
    this.autoApprove = {
      ...DEFAULT_AUTO_APPROVE,
      ...(options.autoApprove ?? {}),
    };
    if (options.enabled !== undefined) this.enabled = options.enabled;
  }

  addPolicy(policy: PermissionPolicy): void {
    const existing = this.policies.findIndex((p) => p.id === policy.id);
    if (existing >= 0) {
      this.policies[existing] = policy;
    } else {
      this.policies.push(policy);
    }
    this.policies.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Set or clear an auto-approval decision for a specific action.
   * Used by the integration layer to configure auto-approve for low-risk reads.
   */
  setAutoApprove(
    action: PermissionAction,
    decision: PermissionDecision | undefined,
  ): void {
    if (decision === undefined) {
      delete this.autoApprove[action];
    } else {
      this.autoApprove[action] = decision;
    }
  }

  removePolicy(id: string): boolean {
    const idx = this.policies.findIndex((p) => p.id === id);
    if (idx >= 0) {
      this.policies.splice(idx, 1);
      return true;
    }
    return false;
  }

  updatePolicy(policy: PermissionPolicy): boolean {
    const idx = this.policies.findIndex((p) => p.id === policy.id);
    if (idx >= 0) {
      this.policies[idx] = policy;
      this.policies.sort((a, b) => b.priority - a.priority);
      return true;
    }
    return false;
  }

  /**
   * Grant a scoped permission (e.g. "Allow for session").
   */
  grantScopedPermission(params: {
    id: string;
    action: PermissionAction;
    scope: PermissionScope;
    sessionId?: string;
    taskId?: string;
    workspaceRoot?: string;
  }): void {
    this.scopedPermissions.push({
      ...params,
      grantedAt: Date.now(),
    });
  }

  evaluate(context: PermissionContext): PermissionEvaluation {
    if (!this.enabled) {
      return {
        decision: "ask",
        reason: "Policy engine disabled — approval required",
        risk: this.riskEngine.assess(context.action, {}),
      };
    }

    const risk = this.riskEngine.assess(context.action, context.metadata);

    // 1. Hard security boundaries ALWAYS override — even ALLOW cannot bypass.
    if (this.isHardBoundaryViolation(context, risk)) {
      return {
        decision: "deny",
        reason: `Hard security boundary: ${risk.reasons.join(", ")}`,
        risk,
      };
    }

    // 2. Explicit DENY / DENY_SESSION policy
    const denyPolicy = this.findMatchingPolicy(
      context,
      (p) => p.decision === "deny" || p.decision === "deny_session",
    );
    if (denyPolicy) {
      return {
        decision: denyPolicy.decision,
        policyId: denyPolicy.id,
        reason: `Denied by policy "${denyPolicy.id}": ${denyPolicy.description ?? denyPolicy.decision}`,
        risk,
      };
    }

    // 3. Explicit ALLOW / ALLOW_SESSION policy
    const allowPolicy = this.findMatchingPolicy(
      context,
      (p) => p.decision === "allow" || p.decision === "allow_session",
    );
    if (allowPolicy) {
      return {
        decision: allowPolicy.decision,
        policyId: allowPolicy.id,
        reason: `Allowed by policy "${allowPolicy.id}": ${allowPolicy.description ?? allowPolicy.decision}`,
        risk,
      };
    }

    // 4. Active scoped permission
    const scoped = this.findActiveScopedPermission(context);
    if (scoped) {
      return {
        decision: "allow",
        reason: `Scoped permission (${scoped.scope}) already granted`,
        risk,
      };
    }

    // 5. Auto-approval — never for CRITICAL risk. An auto-approve setting
    // must not be able to wave through destructive commands (rm -rf /, sudo,
    // format, …): the RiskEngine classifies them critical and the hard
    // boundary below keeps the decision at ASK so a human always decides.
    const auto = this.autoApprove[context.action];
    if (auto && risk.level !== "critical") {
      return {
        decision: auto,
        reason: `Auto-${auto} configured for ${context.action}`,
        risk,
      };
    }

    // 6. ASK fallback
    return {
      decision: "ask",
      reason: `No matching policy — user approval required for ${context.action}`,
      risk,
    };
  }

  explain(context: PermissionContext): {
    evaluation: PermissionEvaluation;
    matchingPolicies: PermissionPolicy[];
  } {
    const matchingPolicies = this.policies.filter(
      (p) => p.enabled && this.policyMatches(p, context),
    );
    const evaluation = this.evaluate(context);
    return { evaluation, matchingPolicies };
  }

  revokeScopedPermission(id: string): boolean {
    const idx = this.scopedPermissions.findIndex((p) => p.id === id);
    if (idx >= 0) {
      this.scopedPermissions.splice(idx, 1);
      return true;
    }
    return false;
  }

  clearSessionPermissions(sessionId: string): void {
    for (let i = this.scopedPermissions.length - 1; i >= 0; i--) {
      if (this.scopedPermissions[i]?.sessionId === sessionId) {
        this.scopedPermissions.splice(i, 1);
      }
    }
  }

  listScopedPermissions(): Array<(typeof this.scopedPermissions)[number]> {
    return [...this.scopedPermissions];
  }

  private isHardBoundaryViolation(
    context: PermissionContext,
    risk: RiskAssessment,
  ): boolean {
    if (
      risk.level === "critical" &&
      risk.reasons.some((r) =>
        r.toLowerCase().includes("outside the workspace"),
      )
    ) {
      return true;
    }
    if (context.metadata?.outsideWorkspace === true) {
      return true;
    }
    return false;
  }

  private findMatchingPolicy(
    context: PermissionContext,
    filter: (p: PermissionPolicy) => boolean,
  ): PermissionPolicy | undefined {
    return this.policies.find(
      (p) => p.enabled && this.policyMatches(p, context) && filter(p),
    );
  }

  private policyMatches(
    policy: PermissionPolicy,
    context: PermissionContext,
  ): boolean {
    if (policy.actions.length === 0) return true;
    return policy.actions.includes(context.action);
  }

  private findActiveScopedPermission(
    context: PermissionContext,
  ): (typeof this.scopedPermissions)[number] | undefined {
    return this.scopedPermissions.find((p) => {
      if (p.action !== context.action) return false;
      if (p.scope === "session" && p.sessionId !== context.sessionId)
        return false;
      if (
        p.scope === "task" &&
        (p.taskId !== context.taskId || p.sessionId !== context.sessionId)
      )
        return false;
      if (p.scope === "workspace" && p.workspaceRoot !== context.workspaceRoot)
        return false;
      return true;
    });
  }

  listPolicies(): PermissionPolicy[] {
    return [...this.policies];
  }

  resetPolicies(): void {
    this.policies = [];
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
}
