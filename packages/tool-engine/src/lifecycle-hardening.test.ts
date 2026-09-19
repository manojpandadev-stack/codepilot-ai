/**
 * Lifecycle hardening — tool-engine subscriptions do not accumulate.
 *
 * Repeatedly exercises start → execute → cancel/complete → dispose for:
 *  - ToolExecutionService (subscribe/dispose idempotent, no growth)
 *  - ApprovalManager (dispose idempotent, cleanup timer released)
 *  - TerminalSession (dispose idempotent, listeners/timers released)
 */
import { describe, it, expect } from "vitest";
import { ToolRegistry } from "./m3/registry.js";
import { ToolPermissionManager } from "./m3/permission-manager.js";
import { ToolAuditLogger } from "./m3/audit-logger.js";
import { ToolExecutionService } from "./m3/executor.js";
import type { ToolDefinition } from "./m3/types.js";
import { ApprovalManager } from "./m4/approval-manager.js";
import { TerminalSession } from "./m7/terminal-session.js";

function makeTool(id: string): ToolDefinition {
  return {
    id,
    name: "Test Tool",
    description: "test",
    category: "analysis",
    version: "1.0.0",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    capabilities: ["idempotent"],
    permission: { level: "read", requiresApproval: false, rationale: "test" },
    idempotent: true,
    async execute() {
      return { ok: true };
    },
  };
}

describe("lifecycle: ToolExecutionService subscriptions", () => {
  it("repeated subscribe → execute → unsubscribe cycles do not grow listeners", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("echo"));
    const service = new ToolExecutionService(
      registry,
      new ToolPermissionManager(),
      new ToolAuditLogger(),
      { defaultTimeoutMs: 5000 },
    );
    for (let i = 0; i < 10; i++) {
      const u1 = service.subscribe(() => {});
      const u2 = service.subscribe(() => {});
      await service.execute("echo", {}, { cwd: process.cwd() });
      u1();
      u2();
      expect(service.listenerCount()).toBe(0);
    }
    service.dispose();
    service.dispose(); // idempotent
    expect(service.listenerCount()).toBe(0);
    await registry.dispose();
  });

  it("dispose is idempotent and clears listeners", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("echo"));
    const service = new ToolExecutionService(
      registry,
      new ToolPermissionManager(),
      new ToolAuditLogger(),
    );
    service.subscribe(() => {});
    service.dispose();
    service.dispose();
    expect(service.listenerCount()).toBe(0);
    await registry.dispose();
    await registry.dispose(); // idempotent
  });
});

describe("lifecycle: ApprovalManager disposal", () => {
  it("repeated request → resolve cycles then dispose releases the timer", async () => {
    const am = new ApprovalManager({ defaultTimeoutMs: 5000 });
    for (let i = 0; i < 5; i++) {
      const p = am.requestApproval({
        toolId: "bash",
        executionId: `e-${i}`,
        action: "execute_command",
        risk: { level: "low", reasons: [], destructive: false },
        description: "test",
      });
      const pending = am.listPending();
      for (const req of pending) am.approve(req.approvalId);
      await p;
    }
    am.dispose();
    am.dispose(); // idempotent
    expect(am.hasCleanupTimer()).toBe(false);
    expect(am.pendingCount()).toBe(0);
  });
});

describe("lifecycle: TerminalSession disposal", () => {
  it("repeated start → cancel → dispose cycles do not retain listeners", async () => {
    for (let i = 0; i < 5; i++) {
      const session = new TerminalSession({
        command: "node",
        args: ["-e", "setTimeout(() => {}, 30_000);"],
        timeoutMs: 0,
      }).start();
      const unsub = session.onOutput(() => {});
      session.cancel();
      await session.wait();
      unsub();
      session.dispose();
      session.dispose(); // idempotent
      expect(session.listenerCount()).toBe(0);
      expect(session.isDisposed()).toBe(true);
    }
  });

  it("dispose without start is safe and idempotent", () => {
    const session = new TerminalSession({ command: "node", args: ["-e", "1"] });
    session.dispose();
    session.dispose();
    expect(session.isDisposed()).toBe(true);
  });
});
