/**
 * ToolExecutionService tests: lifecycle transitions, exactly-once events,
 * permissions, approval, validation, cancellation, timeout and retry.
 */
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "./registry.js";
import { ToolPermissionManager } from "./permission-manager.js";
import { ToolAuditLogger } from "./audit-logger.js";
import { ToolExecutionService } from "./executor.js";
import type { ToolDefinition } from "./types.js";
import type { ToolEvent } from "./lifecycle.js";
import { toolError } from "./types.js";

function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id: "base",
    name: "Base Tool",
    description: "test",
    category: "analysis",
    version: "1.0.0",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: [],
      additionalProperties: false,
    },
    capabilities: ["idempotent"],
    permission: { level: "read", requiresApproval: false, rationale: "test" },
    idempotent: true,
    async execute(input) {
      return { ok: true, value: input.value };
    },
    ...overrides,
  };
}

interface Harness {
  registry: ToolRegistry;
  permissions: ToolPermissionManager;
  audit: ToolAuditLogger;
  service: ToolExecutionService;
  events: ToolEvent[];
  run: (
    toolId: string,
    input?: unknown,
    opts?: Record<string, unknown>,
  ) => ReturnType<ToolExecutionService["execute"]>;
}

function harness(): Harness {
  const registry = new ToolRegistry();
  const permissions = new ToolPermissionManager();
  const audit = new ToolAuditLogger();
  const service = new ToolExecutionService(registry, permissions, audit);
  const events: ToolEvent[] = [];
  service.subscribe((e) => events.push(e));
  const run = (
    toolId: string,
    input: unknown = {},
    opts: Record<string, unknown> = {},
  ) => service.execute(toolId, input, opts);
  return { registry, permissions, audit, service, events, run };
}

describe("ToolExecutionService — lifecycle", () => {
  it("executes a read tool through requested → started → completed with correlation", async () => {
    const h = harness();
    h.registry.register(makeTool({ id: "read_tool" }));
    const result = await h.run(
      "read_tool",
      { value: "x" },
      {
        sessionId: "s7",
        taskId: "t9",
        eventId: "ev1",
      },
    );

    expect(result.status).toBe("completed");
    expect(result.output!).toEqual({ ok: true, value: "x" });
    expect(result.executionId).toMatch(/^tool-exec-/);
    expect(result.error).toBeUndefined();

    const types = h.events.map((e) => e.type);
    expect(types.filter((t) => t === "tool.requested")).toHaveLength(1);
    expect(types.filter((t) => t === "tool.started")).toHaveLength(1);
    expect(types.filter((t) => t === "tool.completed")).toHaveLength(1);

    const completed = h.events.find((e) => e.type === "tool.completed");
    expect(completed?.executionId).toBe(result.executionId);
    expect(completed?.sessionId).toBe("s7");
    expect(completed?.taskId).toBe("t9");
    expect(completed?.eventId).toBe("ev1");
  });

  it("exactly-one terminal event even when a listener throws", async () => {
    const h = harness();
    h.registry.register(makeTool({ id: "t" }));
    h.service.subscribe(() => {
      throw new Error("listener boom");
    });
    const result = await h.run("t");
    expect(h.events.filter((e) => e.type === "tool.completed")).toHaveLength(1);
    expect(result.status).toBe("completed");
  });

  it("emits validation failure without executing", async () => {
    const h = harness();
    let executed = false;
    h.registry.register(
      makeTool({
        id: "t",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        async execute() {
          executed = true;
          return {};
        },
      }),
    );
    const result = await h.run("t", {});
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("VALIDATION");
    expect(executed).toBe(false);
    expect(h.events.filter((e) => e.type === "tool.failed")).toHaveLength(1);
  });

  it("rejects unknown tools with NOT_FOUND", async () => {
    const h = harness();
    const result = await h.run("nope");
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("NOT_FOUND");
  });

  it("denies disabled tools", async () => {
    const h = harness();
    h.registry.register(makeTool({ id: "t" }));
    h.registry.disable("t");
    const result = await h.run("t");
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("UNSUPPORTED");
  });
});

describe("ToolExecutionService — permissions & approval", () => {
  it("denies when the permission manager says deny", async () => {
    const h = harness();
    h.registry.register(
      makeTool({
        id: "write_tool",
        permission: {
          level: "write",
          requiresApproval: true,
          rationale: "write",
        },
      }),
    );
    h.permissions.setRule("write_tool", "deny");
    const result = await h.run("write_tool");
    expect(result.status).toBe("denied");
    expect(result.error?.code).toBe("PERMISSION_DENIED");
    expect(h.events.filter((e) => e.type === "tool.denied")).toHaveLength(1);
  });

  it("waits for approval, then runs, when the decision is approve", async () => {
    const h = harness();
    h.registry.register(
      makeTool({
        id: "write_tool",
        permission: {
          level: "write",
          requiresApproval: true,
          rationale: "write file",
        },
      }),
    );
    const requested: string[] = [];
    const result = await h.run(
      "write_tool",
      {},
      {
        requestApproval: async (_req: {
          toolId: string;
          executionId: string;
          summary: string;
        }) => {
          requested.push(_req.toolId);
          return { approved: true, scope: "session" };
        },
      },
    );
    expect(requested).toEqual(["write_tool"]);
    expect(result.status).toBe("completed");
    expect(h.events.map((e) => e.type)).toContain("tool.permission_required");
  });

  it("denies when approval is declined", async () => {
    const h = harness();
    h.registry.register(
      makeTool({
        id: "w",
        permission: { level: "write", requiresApproval: true, rationale: "w" },
      }),
    );
    const result = await h.run(
      "w",
      {},
      {
        requestApproval: async () => ({ approved: false, reason: "not today" }),
      },
    );
    expect(result.status).toBe("denied");
    expect(result.error?.message).toContain("not today");
  });

  it("denies when approval is required but no channel exists", async () => {
    const h = harness();
    h.registry.register(
      makeTool({
        id: "w",
        permission: {
          level: "execute",
          requiresApproval: true,
          rationale: "w",
        },
      }),
    );
    const result = await h.run("w");
    expect(result.status).toBe("denied");
    expect(result.error?.message).toContain("no approval channel");
  });
});

describe("ToolExecutionService — cancellation, timeout, retry", () => {
  it("cancels an execution that observes the signal", async () => {
    const h = harness();
    h.registry.register(
      makeTool({
        id: "slow",
        idempotent: false,
        async execute(_input, ctx) {
          for (let i = 0; i < 50; i++) {
            if (ctx.signal.aborted) {
              throw toolError(
                "CANCELLED",
                "cancelled by test",
                ctx.executionId,
                {
                  recoverable: false,
                },
              );
            }
            await new Promise((r) => setTimeout(r, 5));
          }
          return {};
        },
      }),
    );
    const exec = h.service.execute("slow", {}, { timeoutMs: 60_000 });
    await new Promise((r) => setTimeout(r, 30));
    const active = h.service.activeExecutions();
    expect(active.length).toBe(1);
    h.service.cancel(active[0]!.executionId);
    const result = await exec;
    expect(result.status).toBe("cancelled");
    expect(result.error?.code).toBe("CANCELLED");
    expect(h.events.filter((e) => e.type === "tool.cancelled")).toHaveLength(1);
  });

  it("times out a tool that ignores its signal", async () => {
    const h = harness();
    h.registry.register(
      makeTool({
        id: "stuck",
        idempotent: false,
        async execute() {
          await new Promise((r) => setTimeout(r, 400));
          return { late: true };
        },
      }),
    );
    const result = await h.run("stuck", {}, { timeoutMs: 40 });
    expect(result.status).toBe("timed_out");
    expect(result.error?.code).toBe("TIMEOUT");
    const timedOut = h.events.find((e) => e.type === "tool.timed_out");
    expect(timedOut?.timeoutMs).toBe(40);
  });

  it("retries idempotent tools on retryable errors up to maxRetries", async () => {
    const h = harness();
    let attempts = 0;
    h.registry.register(
      makeTool({
        id: "flaky",
        async execute() {
          attempts += 1;
          if (attempts < 3) {
            throw toolError("IO_ERROR", "transient", "x", { retryable: true });
          }
          return { ok: true };
        },
      }),
    );
    const service = new ToolExecutionService(
      h.registry,
      h.permissions,
      h.audit,
      {
        maxRetries: 3,
        retryBackoffMs: 1,
      },
    );
    const result = await service.execute("flaky", {});
    expect(attempts).toBe(3);
    expect(result.status).toBe("completed");
    expect(result.retriesUsed).toBe(2);
  });

  it("does NOT retry non-idempotent tools", async () => {
    const h = harness();
    let attempts = 0;
    h.registry.register(
      makeTool({
        id: "no_retry",
        idempotent: false,
        async execute() {
          attempts += 1;
          throw toolError("IO_ERROR", "transient", "x", { retryable: true });
        },
      }),
    );
    const result = await h.run("no_retry");
    expect(attempts).toBe(1);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("IO_ERROR");
  });

  it("normalizes raw thrown errors into structured ToolErrors (redacted)", async () => {
    const h = harness();
    h.registry.register(
      makeTool({
        id: "boom",
        async execute() {
          throw new Error("boom with sk-abcdefghijklmnop secret");
        },
      }),
    );
    const result = await h.run("boom");
    expect(result.error?.code).toBe("INTERNAL");
    expect(result.error?.message).not.toContain("sk-abcdefghijklmnop");
  });

  it("records exactly one audit entry per execution", async () => {
    const h = harness();
    h.registry.register(makeTool({ id: "t" }));
    await h.run("t");
    const entries = h.audit.list();
    expect(entries).toHaveLength(1);
    expect(h.audit.forExecution(entries[0]!.executionId)).toHaveLength(1);
  });

  it("activeExecutions reflects in-flight work only", async () => {
    const h = harness();
    h.registry.register(makeTool({ id: "t" }));
    await h.run("t");
    expect(h.service.activeExecutions()).toEqual([]);
  });

  it("dispose aborts in-flight executions", async () => {
    const h = harness();
    h.registry.register(
      makeTool({
        id: "slow",
        idempotent: false,
        async execute() {
          await new Promise((r) => setTimeout(r, 1000));
          return {};
        },
      }),
    );
    const exec = h.run("slow", {}, { timeoutMs: 60_000 });
    await new Promise((r) => setTimeout(r, 20));
    h.service.dispose();
    const result = await exec;
    expect(["cancelled", "timed_out", "failed"]).toContain(result.status);
  });

  it("rejects execution after dispose", async () => {
    const h = harness();
    h.registry.register(makeTool({ id: "t" }));
    h.service.dispose();
    const result = await h.run("t");
    expect(result.error?.code).toBe("INTERNAL");
  });
});
