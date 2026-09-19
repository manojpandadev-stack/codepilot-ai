/**
 * M21 — Eval framework tests: check evaluation, scripted agent runs,
 * full benchmark execution over the built-in task library, and comparison.
 */

import { describe, it, expect } from "vitest";
import {
  BENCHMARK_TASKS,
  BenchmarkRunner,
  compareRuns,
  evaluateChecks,
} from "./index.js";
import type { AgentAdapter, AgentRunRecord, BenchmarkTask } from "./index.js";

function readFromSeed(
  task: BenchmarkTask,
): (rel: string) => string | undefined {
  return (rel) => task.seedFiles[rel];
}

// ============================================================================
// Check evaluation
// ============================================================================

describe("M21 evaluateChecks", () => {
  it("fails the new-behaviour checks against unmodified seed files", () => {
    const task = BENCHMARK_TASKS.find((t) => t.id === "feat-add-validation")!;
    const results = evaluateChecks(task, readFromSeed(task));
    // New-behaviour checks must fail on the untouched seed...
    expect(results.find((r) => r.checkId === "has-validator")?.passed).toBe(
      false,
    );
    expect(results.find((r) => r.checkId === "wired-in")?.passed).toBe(false);
    // ...while regression guards that already hold on the seed pass.
    expect(results.find((r) => r.checkId === "file-exists")?.passed).toBe(true);
    expect(results.find((r) => r.checkId === "keeps-signature")?.passed).toBe(
      true,
    );
  });

  it("passes when the seed satisfies a check (exists)", () => {
    const task = BENCHMARK_TASKS.find((t) => t.id === "feat-add-validation")!;
    const results = evaluateChecks(task, readFromSeed(task));
    const exists = results.find((r) => r.checkId === "file-exists");
    expect(exists?.passed).toBe(true);
  });

  it("handles missing files gracefully", () => {
    const task = BENCHMARK_TASKS.find(
      (t) => t.id === "refactor-extract-module",
    )!;
    const results = evaluateChecks(task, () => undefined);
    expect(results.every((r) => !r.passed)).toBe(true);
    expect(results[0]?.detail).toContain("missing file");
  });
});

// ============================================================================
// Scripted adapters
// ============================================================================

/** Adapter that "solves" tasks by writing the expected files directly. */
function scriptedAdapter(
  id: string,
  solve: (task: BenchmarkTask, files: Map<string, string>) => Promise<void>,
  overrides?: Partial<AgentRunRecord>,
): AgentAdapter & { lastFiles: Map<string, string> } {
  return {
    id,
    lastFiles: new Map(),
    async run({ task }) {
      const files = new Map<string, string>(Object.entries(task.seedFiles));
      this.lastFiles = files;
      await solve(task, files);
      // Persist solved files back into the seed map so evaluation sees them.
      for (const [k, v] of files) task.seedFiles[k] = v;
      return {
        completed: true,
        durationMs: 10,
        toolCalls: 2,
        retries: 0,
        healingAttempts: 0,
        humanApprovals: 1,
        rollbacks: 0,
        securityViolations: 0,
        ...overrides,
      };
    },
  };
}

describe("M21 BenchmarkRunner", () => {
  it("a perfect solver passes the validation task", async () => {
    const adapter = scriptedAdapter("perfect", async (task, files) => {
      if (task.id !== "feat-add-validation") return;
      const content = files.get("src/registration.ts") ?? "";
      files.set(
        "src/registration.ts",
        content
          .replace(
            "export function registerUser",
            "export function validateEmail(email: string): boolean {\n  return email.includes('@');\n}\n\nexport function registerUser",
          )
          .replace(
            "  if (!email) return { ok: false, error: 'email required' };",
            "  if (!email || !validateEmail(email)) return { ok: false, error: 'invalid email' };",
          ),
      );
    });
    // Seed maps are mutated per run — clone the task for isolation.
    const task = structuredClone(
      BENCHMARK_TASKS.find((t) => t.id === "feat-add-validation"),
    ) as BenchmarkTask;
    const runner = new BenchmarkRunner(adapter, {
      seedWorkspace: async (t) => ({
        workspaceRoot: "/memory",
        readFile: (rel) => t.seedFiles[rel],
        cleanup: () => undefined,
      }),
    });
    const result = await runner.runTask(task);
    expect(result.success).toBe(true);
    expect(result.checkPassRate).toBe(1);
    expect(result.humanApprovals).toBe(1);
  });

  it("a no-op agent fails every task", async () => {
    const adapter = scriptedAdapter("noop", async () => undefined, {
      completed: false,
      error: "agent did nothing",
    });
    const runner = new BenchmarkRunner(adapter, {
      seedWorkspace: async (t) => ({
        workspaceRoot: "/memory",
        readFile: (rel) => t.seedFiles[rel],
        cleanup: () => undefined,
      }),
    });
    const result = await runner.runAll(
      BENCHMARK_TASKS.map((t) => structuredClone(t) as BenchmarkTask),
    );
    expect(result.summary.passed).toBe(0);
    expect(result.summary.successRate).toBe(0);
    expect(result.summary.total).toBe(BENCHMARK_TASKS.length);
  });

  it("a crashing adapter produces a failed result, not a throw", async () => {
    const adapter: AgentAdapter = {
      id: "crasher",
      async run() {
        throw new Error("adapter exploded");
      },
    };
    const runner = new BenchmarkRunner(adapter, {
      seedWorkspace: async (t) => ({
        workspaceRoot: "/memory",
        readFile: (rel) => t.seedFiles[rel],
        cleanup: () => undefined,
      }),
    });
    const result = await runner.runTask(
      structuredClone(BENCHMARK_TASKS[0]) as BenchmarkTask,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("exploded");
  });

  it("security violations force task failure even with passing checks", async () => {
    const task = structuredClone(
      BENCHMARK_TASKS.find((t) => t.id === "security-no-secrets"),
    ) as BenchmarkTask;
    const adapter = scriptedAdapter(
      "leaky",
      async (_t, files) => {
        const content = files.get("src/client.ts") ?? "";
        files.set(
          "src/client.ts",
          content + "\nexport function apiVersion(): string { return 'v1'; }",
        );
        // Simulate the agent copying the seeded secret into a new file.
        files.set(
          "src/leaked.ts",
          "const t = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';",
        );
      },
      { securityViolations: 1 },
    );
    const runner = new BenchmarkRunner(adapter, {
      seedWorkspace: async (t) => ({
        workspaceRoot: "/memory",
        readFile: (rel) => t.seedFiles[rel],
        cleanup: () => undefined,
      }),
    });
    const result = await runner.runTask(task);
    expect(result.checkPassRate).toBe(1);
    expect(result.success).toBe(false);
    expect(result.securityViolations).toBe(1);
  });

  it("computes aggregate metrics across the built-in library", async () => {
    const adapter = scriptedAdapter("partial", async (task, files) => {
      // Solve only the debugging task.
      if (task.id !== "debug-failing-condition") return;
      files.set(
        "src/pricing.ts",
        [
          "export function discountFor(tier: 'standard' | 'vip'): number {",
          "  if (tier === 'vip') {",
          "    return 0.2;",
          "  }",
          "  return 0;",
          "}",
        ].join("\n"),
      );
    });
    const runner = new BenchmarkRunner(adapter, {
      seedWorkspace: async (t) => ({
        workspaceRoot: "/memory",
        readFile: (rel) => t.seedFiles[rel],
        cleanup: () => undefined,
      }),
    });
    const result = await runner.runAll(
      BENCHMARK_TASKS.map((t) => structuredClone(t) as BenchmarkTask),
    );
    expect(result.summary.total).toBe(BENCHMARK_TASKS.length);
    expect(result.summary.passed).toBe(1);
    expect(result.summary.avgCheckPassRate).toBeGreaterThan(0);
    expect(result.summary.successRate).toBe(1 / BENCHMARK_TASKS.length);
  });
});

// ============================================================================
// Comparison
// ============================================================================

describe("M21 compareRuns", () => {
  it("compares two agents on identical task ids only", () => {
    const mkResult = (
      agentId: string,
      rows: Array<{
        taskId: string;
        success: boolean;
        checkPassRate: number;
        durationMs: number;
      }>,
    ) => ({
      agentId,
      startedAtMs: 0,
      finishedAtMs: 1,
      results: rows.map((r) => ({
        taskId: r.taskId,
        agentId,
        success: r.success,
        checkResults: [],
        checkPassRate: r.checkPassRate,
        durationMs: r.durationMs,
        toolCalls: 0,
        retries: 0,
        healingAttempts: 0,
        humanApprovals: 0,
        rollbacks: 0,
        securityViolations: 0,
      })),
      summary: {
        total: rows.length,
        passed: rows.filter((r) => r.success).length,
        successRate: 0,
        avgCheckPassRate: 0,
        avgDurationMs: 0,
        totalToolCalls: 0,
        totalRetries: 0,
        totalHealingAttempts: 0,
        totalHumanApprovals: 0,
        totalRollbacks: 0,
        totalSecurityViolations: 0,
      },
    });

    const a = mkResult("codepilot", [
      { taskId: "t1", success: true, checkPassRate: 1, durationMs: 100 },
      { taskId: "t2", success: false, checkPassRate: 0.5, durationMs: 200 },
      { taskId: "only-in-a", success: true, checkPassRate: 1, durationMs: 50 },
    ]);
    const b = mkResult("baseline", [
      { taskId: "t1", success: false, checkPassRate: 0, durationMs: 300 },
      { taskId: "t2", success: true, checkPassRate: 1, durationMs: 150 },
    ]);

    const report = compareRuns(a, b);
    expect(report.agents).toEqual(["codepilot", "baseline"]);
    expect(report.summary.tasksCompared).toBe(2); // only common ids
    expect(report.summary.aSuccessRate).toBe(0.5);
    expect(report.summary.bSuccessRate).toBe(0.5);
    expect(report.summary.aAvgCheckPassRate).toBe(0.75);
    expect(report.summary.bAvgCheckPassRate).toBe(0.5);
  });

  it("handles empty runs without dividing by zero", () => {
    const mkEmpty = (agentId: string) => ({
      agentId,
      startedAtMs: 0,
      finishedAtMs: 0,
      results: [],
      summary: {
        total: 0,
        passed: 0,
        successRate: 0,
        avgCheckPassRate: 0,
        avgDurationMs: 0,
        totalToolCalls: 0,
        totalRetries: 0,
        totalHealingAttempts: 0,
        totalHumanApprovals: 0,
        totalRollbacks: 0,
        totalSecurityViolations: 0,
      },
    });
    const report = compareRuns(mkEmpty("a"), mkEmpty("b"));
    expect(report.summary.tasksCompared).toBe(0);
    expect(Number.isNaN(report.summary.aSuccessRate)).toBe(false);
  });
});
