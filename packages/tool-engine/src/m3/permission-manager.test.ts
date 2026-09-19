/**
 * ToolPermissionManager tests: defaults, level policies, per-tool rules and
 * once/session scoping.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { ToolPermissionManager } from "./permission-manager.js";

describe("ToolPermissionManager", () => {
  let pm: ToolPermissionManager;

  beforeEach(() => {
    pm = new ToolPermissionManager();
  });

  it("auto-allows reads and interaction by default", () => {
    expect(pm.decide("read_tool", "read", "e1").type).toBe("allow");
    expect(pm.decide("ask_tool", "interaction", "e1").type).toBe("allow");
  });

  it("requires approval for writes and executes by default", () => {
    expect(pm.decide("write_tool", "write", "e1").type).toBe("approve");
    expect(pm.decide("exec_tool", "execute", "e1").type).toBe("approve");
    expect(pm.decide("del_tool", "destructive", "e1").type).toBe("approve");
  });

  it("respects the default decision", () => {
    const strict = new ToolPermissionManager({ defaultDecision: "deny" });
    expect(strict.decide("w", "write", "e1").type).toBe("deny");
    const open = new ToolPermissionManager({ defaultDecision: "allow" });
    expect(open.decide("w", "write", "e1").type).toBe("allow");
  });

  it("level policies override the default", () => {
    const pm2 = new ToolPermissionManager({
      levelPolicies: { write: "allow" },
      defaultDecision: "approve",
    });
    expect(pm2.decide("w", "write", "e1").type).toBe("allow");
    expect(pm2.decide("e", "execute", "e1").type).toBe("approve");
  });

  it("per-tool rules win over level policies", () => {
    const pm2 = new ToolPermissionManager({
      rules: [{ toolId: "danger", decision: "deny" }],
    });
    expect(pm2.decide("danger", "read", "e1").type).toBe("deny");
  });

  it("honors session approvals and denials", () => {
    pm.recordApproval("write_tool", "session");
    expect(pm.decide("write_tool", "write", "e1").type).toBe("allow");
    expect(pm.decide("write_tool", "write", "e1").scope).toBe("session");
    pm.recordDenial("exec_tool", "session");
    expect(pm.decide("exec_tool", "execute", "e1").type).toBe("deny");
  });

  it("once-scope approvals do not persist", () => {
    pm.recordApproval("write_tool", "once");
    expect(pm.decide("write_tool", "write", "e1").type).toBe("approve");
  });

  it("resetSession clears session state", () => {
    pm.recordApproval("write_tool", "session");
    pm.resetSession();
    expect(pm.decide("write_tool", "write", "e1").type).toBe("approve");
  });

  it("setRule and setLevelPolicy update behavior at runtime", () => {
    pm.setRule("exec_tool", "allow");
    expect(pm.decide("exec_tool", "execute", "e1").type).toBe("allow");
    pm.setLevelPolicy("destructive", "allow");
    expect(pm.decide("d", "destructive", "e1").type).toBe("allow");
  });

  it("maxLevel returns the highest escalated level", () => {
    expect(
      ToolPermissionManager.maxLevel([
        "read",
        "write",
        "execute",
        "destructive",
      ]),
    ).toBe("destructive");
    expect(ToolPermissionManager.maxLevel(["read", "interaction"])).toBe(
      "interaction",
    );
  });
});
