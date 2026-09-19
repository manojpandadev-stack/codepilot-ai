/**
 * PermissionPolicyEngine tests: policy evaluation, auto-approve, and scoped permissions.
 */
import { describe, it, expect } from "vitest";
import { RiskEngine } from "./risk-engine.js";
import { PermissionPolicyEngine } from "./policy-engine.js";
import type { PermissionContext } from "./permission-types.js";

function context(
  overrides: Partial<PermissionContext> = {},
): PermissionContext {
  return {
    action: "read_file",
    toolId: "read_file",
    executionId: "exec-1",
    sessionId: "sess-1",
    taskId: "task-1",
    workspaceRoot: "/workspace",
    metadata: {},
    ...overrides,
  };
}

describe("PermissionPolicyEngine", () => {
  it("auto-approves read_file by default", () => {
    const engine = new PermissionPolicyEngine({ riskEngine: new RiskEngine() });
    const decision = engine.evaluate(context({ action: "read_file" }));
    expect(decision.decision).toBe("allow");
  });

  it("requires approval for write_file by default", () => {
    const engine = new PermissionPolicyEngine({ riskEngine: new RiskEngine() });
    const decision = engine.evaluate(context({ action: "write_file" }));
    expect(decision.decision).toBe("ask");
  });

  it("denies delete_file with a hard-deny policy", () => {
    const engine = new PermissionPolicyEngine({ riskEngine: new RiskEngine() });
    engine.addPolicy({
      id: "no-delete",
      actions: ["delete_file"],
      decision: "deny",
      scope: "single_execution",
      priority: 100,
      enabled: true,
    });
    const decision = engine.evaluate(context({ action: "delete_file" }));
    expect(decision.decision).toBe("deny");
  });

  it("auto-approves write_file after setAutoApprove", () => {
    const engine = new PermissionPolicyEngine({ riskEngine: new RiskEngine() });
    engine.setAutoApprove("write_file", "allow");
    const decision = engine.evaluate(context({ action: "write_file" }));
    expect(decision.decision).toBe("allow");
  });

  it("can clear auto-approve with undefined", () => {
    const engine = new PermissionPolicyEngine({ riskEngine: new RiskEngine() });
    engine.setAutoApprove("write_file", "allow");
    engine.setAutoApprove("write_file", undefined);
    const decision = engine.evaluate(context({ action: "write_file" }));
    expect(decision.decision).toBe("ask");
  });
});
