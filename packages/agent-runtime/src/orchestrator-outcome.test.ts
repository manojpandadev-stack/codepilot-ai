/**
 * F-05/F-06 — orchestration outcome model + child-agent tool access.
 *
 * Deterministic, no network, no model:
 * - deriveOrchestrationOutcome: COMPLETED / FAILED / PARTIAL / CANCELLED /
 *   BLOCKED from DAG state (+ optional-task semantics).
 * - Role tool allowlists: canonical-registry subsets; mutating tools absent
 *   for read-only roles; every name inside CODEPILOT_MODEL_TOOL_NAMES.
 * - buildChildAgentConfig: inherits provider/workspace/privacy/approval from
 *   the base config (never blanked, never "disabled").
 * - RoleScopedToolExecutor: unknown tools denied, role-denied tools denied,
 *   allowed tools execute, pre-aborted signal cancels, bad ids don't cancel.
 */
import { describe, it, expect } from "vitest";
import {
  TaskDAG,
  deriveOrchestrationOutcome,
  childAgentToolNames,
  buildChildAgentTools,
  buildChildAgentConfig,
  RoleScopedToolExecutor,
  type TaskNode,
} from "./orchestrator.js";
import { CODEPILOT_MODEL_TOOL_NAMES } from "./builtin-tools.js";
import { MUTATING_TOOL_NAMES } from "./staged-write-tools.js";
import { ToolRegistry, ToolAuditLogger } from "@codepilot/tool-engine";

import type { ToolDefinition } from "@codepilot/tool-engine";

function makeTask(
  overrides: Partial<TaskNode> & {
    id: string;
    agentRole: TaskNode["agentRole"];
  },
): TaskNode {
  return {
    description: `Test task ${overrides.id}`,
    dependencies: [],
    status: "pending",
    priority: 1,
    retryCount: 0,
    maxRetries: 1,
    timeoutMs: 300_000,
    ...overrides,
  };
}

function completedDag(): TaskDAG {
  const dag = new TaskDAG();
  dag.addTask(
    makeTask({ id: "a", agentRole: "architect", status: "completed" }),
  );
  dag.addTask(makeTask({ id: "b", agentRole: "coder", status: "completed" }));
  return dag;
}

describe("F-05 deriveOrchestrationOutcome", () => {
  it("all completed → COMPLETED", () => {
    const out = deriveOrchestrationOutcome(completedDag(), false);
    expect(out.outcome).toBe("COMPLETED");
    expect(out.failedRequired).toEqual([]);
    expect(out.cancelled).toBe(false);
  });

  it("required failure → FAILED (never completed)", () => {
    const dag = completedDag();
    dag.addTask(makeTask({ id: "c", agentRole: "tester", status: "failed" }));
    const out = deriveOrchestrationOutcome(dag, false);
    expect(out.outcome).toBe("FAILED");
    expect(out.failedRequired).toEqual(["c"]);
  });

  it("optional-only failure → PARTIAL", () => {
    const dag = completedDag();
    dag.addTask(
      makeTask({
        id: "c",
        agentRole: "tester",
        status: "failed",
        optional: true,
      }),
    );
    const out = deriveOrchestrationOutcome(dag, false);
    expect(out.outcome).toBe("PARTIAL");
    expect(out.failedOptional).toEqual(["c"]);
    expect(out.failedRequired).toEqual([]);
  });

  it("blocked required task → FAILED", () => {
    const dag = completedDag();
    dag.addTask(makeTask({ id: "c", agentRole: "tester", status: "blocked" }));
    expect(deriveOrchestrationOutcome(dag, false).outcome).toBe("FAILED");
  });

  it("user abort wins over failures → CANCELLED", () => {
    const dag = completedDag();
    dag.addTask(makeTask({ id: "c", agentRole: "tester", status: "failed" }));
    const out = deriveOrchestrationOutcome(dag, true);
    expect(out.outcome).toBe("CANCELLED");
    expect(out.cancelled).toBe(true);
  });

  it("unresolved remainder with no failure → BLOCKED", () => {
    const dag = completedDag();
    dag.addTask(makeTask({ id: "c", agentRole: "tester", status: "pending" }));
    expect(deriveOrchestrationOutcome(dag, false).outcome).toBe("BLOCKED");
  });

  it("empty DAG → COMPLETED", () => {
    expect(deriveOrchestrationOutcome(new TaskDAG(), false).outcome).toBe(
      "COMPLETED",
    );
  });
});

const MUTATING = ["editor", "apply_patch", "run_commands", "bash"];

describe("F-06 role tool allowlists", () => {
  it("every allowlisted name is a canonical registry tool", () => {
    const canonical = new Set<string>(CODEPILOT_MODEL_TOOL_NAMES);
    for (const role of [
      "orchestrator",
      "architect",
      "coder",
      "tester",
      "security",
      "reviewer",
      "documentation",
    ] as const) {
      for (const name of childAgentToolNames(role)) {
        expect(canonical.has(name), `${role} lists unknown tool ${name}`).toBe(
          true,
        );
      }
    }
  });

  it("planner/architect cannot mutate", () => {
    const names = childAgentToolNames("architect");
    for (const tool of MUTATING) expect(names).not.toContain(tool);
    expect(names).toContain("read_files");
    expect(names).toContain("search_codebase");
  });

  it("reviewer is read-only", () => {
    const names = childAgentToolNames("reviewer");
    for (const tool of MUTATING) expect(names).not.toContain(tool);
    expect(names).toContain("git_diff");
  });

  it("coder receives read/edit/terminal under policies", () => {
    const names = childAgentToolNames("coder");
    expect(names).toEqual(
      expect.arrayContaining([
        "read_files",
        "editor",
        "apply_patch",
        "run_commands",
      ]),
    );
  });

  it("tester receives test/read/terminal but no edit", () => {
    const names = childAgentToolNames("tester");
    expect(names).toEqual(
      expect.arrayContaining(["read_files", "run_commands"]),
    );
    expect(names).not.toContain("editor");
    expect(names).not.toContain("apply_patch");
  });

  it("security is read-only", () => {
    const names = childAgentToolNames("security");
    for (const tool of MUTATING) expect(names).not.toContain(tool);
  });
});

describe("F-06 buildChildAgentTools / buildChildAgentConfig", () => {
  it("builds native-shaped tools honoring privacy", () => {
    const tools = buildChildAgentTools("architect", process.cwd(), "cloud");
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(typeof t.execute).toBe("function");
    }
    const local = buildChildAgentTools("architect", process.cwd(), "local");
    expect(local.map((t) => t.name)).not.toContain("fetch_web_content");
    expect(local.map((t) => t.name)).not.toContain("web_search");
  });

  it("inherits provider/workspace/privacy/approval/staging from base (never blanked)", () => {
    const approval = async (): Promise<{ approved: boolean }> => ({
      approved: true,
    });
    const onWriteProposal = async () => ({ changeSetId: "cs-1" });
    const cfg = buildChildAgentConfig(
      {
        providerId: "ollama",
        modelId: "qwen3:8b",
        apiKey: "k",
        baseUrl: "http://localhost:11434",
        workspaceRoot: "/repo",
        privacyMode: "local",
        maxIterations: 50,
        temperature: 0.2,
        requestApproval: approval,
        onWriteProposal,
      },
      "coder",
      "act",
    );
    expect(cfg.providerId).toBe("ollama");
    expect(cfg.workspaceRoot).toBe("/repo");
    expect(cfg.privacyMode).toBe("local");
    expect(cfg.requestApproval).toBe(approval);
    expect(cfg.onWriteProposal).toBe(onWriteProposal);
    expect(cfg.extraTools!.length).toBeGreaterThan(0);
    expect(cfg.extraTools!.some((t) => t.name === "editor")).toBe(true);
    expect(cfg.extraTools!.some((t) => t.name === "apply_patch")).toBe(true);
  });

  it("maps plan mode to ask and drops credentials when absent", () => {
    const cfg = buildChildAgentConfig(
      {
        providerId: "ollama",
        modelId: "m",
        workspaceRoot: "/repo",
        privacyMode: "cloud",
      },
      "reviewer",
      "plan",
    );
    expect(cfg.agentMode).toBe("ask");
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.requestApproval).toBeUndefined();
    expect(cfg.extraTools!.map((t) => t.name)).not.toContain("editor");
  });

  // --- M4/M5 write-path parity (agent write-path audit) -------------------
  it("WITHOUT a staging bridge a coder gets NO write tool at all (fail closed)", () => {
    const cfg = buildChildAgentConfig(
      {
        providerId: "ollama",
        modelId: "m",
        workspaceRoot: "/repo",
        privacyMode: "local",
        requestApproval: async () => ({ approved: true }),
      },
      "coder",
      "act",
    );
    const names = cfg.extraTools!.map((t) => t.name);
    expect(names).not.toContain("editor");
    expect(names).not.toContain("apply_patch");
    expect(names).not.toContain("delete_file");
    // Terminal stays: it is M4-gated execution, not an unstaged file write.
    expect(names).toContain("run_commands");
  });

  it("plan mode drops every mutating tool from a coder, even with staging", () => {
    const cfg = buildChildAgentConfig(
      {
        providerId: "ollama",
        modelId: "m",
        workspaceRoot: "/repo",
        privacyMode: "local",
        onWriteProposal: async () => ({ changeSetId: "cs-1" }),
        requestApproval: async () => ({ approved: true }),
      },
      "coder",
      "plan",
    );
    const names = cfg.extraTools!.map((t) => t.name);
    for (const mutating of MUTATING_TOOL_NAMES) {
      expect(
        names,
        `plan-mode coder must not advertise ${mutating}`,
      ).not.toContain(mutating);
    }
    expect(names).toContain("read_files");
  });
});

function fakeTool(
  id: string,
  level: "read" | "write" | "execute" = "read",
): ToolDefinition {
  return {
    id,
    name: id,
    description: `fake ${id}`,
    category: "command",
    version: "1.0.0",
    inputSchema: { type: "object", properties: {} },
    capabilities: [],
    permission: { level, requiresApproval: false, rationale: "test tool" },
    idempotent: true,
    execute: async () => ({ ok: true }),
  };
}

function executorFor(role: "coder" | "reviewer"): RoleScopedToolExecutor {
  const registry = new ToolRegistry();
  registry.register(fakeTool("read_files", "read"));
  registry.register(fakeTool("editor", "write"));
  return new RoleScopedToolExecutor(registry, new ToolAuditLogger(), role);
}

describe("F-06 RoleScopedToolExecutor gating", () => {
  it("denies unknown tools fail-closed", async () => {
    const ex = executorFor("coder");
    const res = await ex.execute("no_such_tool", {});
    expect(res.status).toBe("denied");
  });

  it("coder can execute an allowed tool end to end", async () => {
    const ex = executorFor("coder");
    const res = await ex.execute("read_files", {});
    expect(res.status).toBe("completed");
  });

  it("reviewer cannot execute a mutating tool", async () => {
    const ex = executorFor("reviewer");
    const res = await ex.execute("editor", {});
    expect(res.status).toBe("denied");
  });

  it("pre-aborted signal cancels instead of executing", async () => {
    const ex = executorFor("coder");
    const controller = new AbortController();
    controller.abort();
    const res = await ex.execute(
      "read_files",
      {},
      { signal: controller.signal },
    );
    expect(res.status).toBe("cancelled");
  });

  it("cancel() reports false for unknown ids and dispose is safe", async () => {
    const ex = executorFor("coder");
    expect(ex.cancel("does-not-exist")).toBe(false);
  });
});
