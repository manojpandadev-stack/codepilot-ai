/**
 * M14 TeamService tests — backend for the Team (multi-agent) UI.
 *
 * Uses a FakeOrchestrator implementing the TeamOrchestratorPort against the
 * REAL TaskDAG (dependency semantics are production code), plus the REAL
 * M12 TaskStore on a temp dir (persistence/recovery are production code).
 * The security path (buildTeamAgentConfig → M4 bridge) is tested with a
 * mock bridge for every side-effecting tool category.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  TeamService,
  buildTeamAgentConfig,
  isValidTeamId,
  isValidRunId,
  validateTeamFiles,
  roleLabel,
  type TeamOrchestratorPort,
} from "../apps/vscode-extension/src/team-service";
import { TaskDAG } from "../packages/agent-runtime/src/orchestrator";
import type { AgentEventListener } from "../packages/agent-runtime/src/types";
import { TaskStore } from "../packages/agent-runtime/src/m12-task-store";
import type { CodePilotAgentConfig } from "../packages/agent-runtime/src/types";

// ---------------------------------------------------------------------------
// Fake orchestrator (real DAG, scripted task outcomes)
// ---------------------------------------------------------------------------

type Behavior =
  | { kind: "succeed" }
  | { kind: "fail"; role: string }
  | { kind: "hang"; role?: string }
  | { kind: "throw"; message: string };

class FakeOrchestrator implements TeamOrchestratorPort {
  dag: TaskDAG | null = null;
  private listeners = new Set<AgentEventListener>();
  cancelled = false;
  disposed = false;
  started = 0;
  behavior: Behavior = { kind: "succeed" };
  seenDescriptions: string[] = [];

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getDAG(): TaskDAG | null {
    return this.dag;
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  cancel(): void {
    this.cancelled = true;
    if (this.dag) {
      for (const t of this.dag.getAllTasks()) {
        if (t.status === "pending" || t.status === "waiting" || t.status === "running") {
          this.dag.markCancelled(t.id);
        }
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.dag = null;
  }

  private emitStatus(taskId: string, message: string): void {
    for (const l of [...this.listeners]) {
      try {
        l({ type: "status", message, taskId } as never);
      } catch {
        // ignore
      }
    }
  }

  async execute(
    description: string,
    _mode: "plan" | "act" | "review",
    opts?: { roles?: string[] },
  ): Promise<{
    results: Array<{ role: string; task: string; result: string; success: boolean }>;
    finalResult: string;
    dag: TaskDAG;
  }> {
    void _mode;
    this.started += 1;
    this.seenDescriptions.push(description);
    // Honor explicit roles like the real engine; else classify the text.
    const roles = opts?.roles && opts.roles.length > 0 ? opts.roles : TaskDAG.classifyTask(description);
    this.dag = TaskDAG.buildFromRoles(roles as never, description);
    const results: Array<{ role: string; task: string; result: string; success: boolean }> = [];

    if (this.behavior.kind === "throw") {
      throw new Error(this.behavior.message);
    }

    while (!this.dag.isComplete()) {
      if (this.cancelled) {
        for (const t of this.dag.getAllTasks()) {
          if (t.status === "pending" || t.status === "waiting" || t.status === "running") {
            this.dag.markCancelled(t.id);
          }
        }
        break;
      }
      const ready = this.dag.getReadyTasks().slice(0, 2);
      if (ready.length === 0) break;
      for (const task of ready) {
        this.dag.markRunning(task.id);
        this.emitStatus(task.id, `Running ${task.agentRole}`);
        if (this.behavior.kind === "hang" && (!this.behavior.role || this.behavior.role === task.agentRole)) {
          // Hang until cancelled (the test cancels or disposes).
          while (!this.cancelled) {
            await new Promise((r) => setTimeout(r, 5));
          }
          this.dag.markCancelled(task.id);
          continue;
        }
        if (this.behavior.kind === "fail" && this.behavior.role === task.agentRole) {
          this.dag.markFailed(task.id, `${task.agentRole} exploded`);
          this.dag.propagateFailure(task.id);
          results.push({ role: task.agentRole, task: task.description, result: "boom", success: false });
          continue;
        }
        this.dag.markCompleted(task.id, `Modified src/${task.agentRole}.ts — done by ${task.agentRole}`);
        results.push({ role: task.agentRole, task: task.description, result: "done", success: true });
        this.emitStatus(task.id, `${task.agentRole} completed`);
      }
    }
    const ok = results.filter((r) => r.success);
    return { results, finalResult: ok[ok.length - 1]?.result ?? "done", dag: this.dag };
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let dir: string;
let store: TaskStore;
let fakes: FakeOrchestrator[];
let capturedConfigs: CodePilotAgentConfig[];
let service: TeamService;

function makeService(): TeamService {
  return new TeamService({
    taskStore: store,
    // Production wiring: the M4-gated config builder (null bridge here =
    // deny-closed, exactly as the extension behaves when M4 is down).
    buildBaseConfig: async () =>
      buildTeamAgentConfig({
        workspaceRoot: dir,
        providerId: "ollama",
        modelId: "qwen3:8b",
        bridge: null,
      }),
    createOrchestrator: (baseConfig) => {
      capturedConfigs.push(baseConfig);
      const fake = new FakeOrchestrator();
      fakes.push(fake);
      return fake;
    },
  });
}

function hangServiceOn(fake: FakeOrchestrator): TeamService {
  return new TeamService({
    taskStore: store,
    buildBaseConfig: async () =>
      buildTeamAgentConfig({
        workspaceRoot: dir,
        providerId: "ollama",
        modelId: "qwen3:8b",
        bridge: null,
      }),
    createOrchestrator: () => fake,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-team-"));
  store = new TaskStore(path.join(dir, "tasks"));
  fakes = [];
  capturedConfigs = [];
  service = makeService();
});

afterEach(() => {
  service.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function waitFor(
  pred: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------------------
// Team creation
// ---------------------------------------------------------------------------

describe("TeamService team creation", () => {
  it("creates a team with classified roles and a real DAG", async () => {
    const created = await service.createTeam("implement caching for the api");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.team.status).toBe("idle");
    expect(created.team.roles).toContain("coder");
    expect(created.team.tasks.length).toBeGreaterThan(0);
    expect(created.team.runCount).toBe(0);
  });

  it("accepts explicit role selection", async () => {
    const created = await service.createTeam("do work", {
      roles: ["architect", "coder", "reviewer"],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.team.roles).toEqual(["architect", "coder", "reviewer"]);
    // Linear chain: architect → coder → reviewer.
    const byId = new Map(created.team.tasks.map((t) => [t.taskId, t]));
    expect(byId.get("task-2")!.dependencies).toEqual(["task-1"]);
    expect(byId.get("task-3")!.dependencies).toEqual(["task-2"]);
  });

  it("builds parallel branches for the complex workflow", async () => {
    const created = await service.createTeam("implement x", {
      roles: ["architect", "coder", "tester", "security", "reviewer"],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const tasks = created.team.tasks;
    const tester = tasks.find((t) => t.role === "tester")!;
    const security = tasks.find((t) => t.role === "security")!;
    const reviewer = tasks.find((t) => t.role === "reviewer")!;
    // Parallel: same level, same dependency; reviewer joins both.
    expect(tester.level).toBe(security.level);
    expect(tester.dependencies).toEqual(security.dependencies);
    expect(reviewer.dependencies).toContain(tester.taskId);
    expect(reviewer.dependencies).toContain(security.taskId);
    expect(reviewer.level).toBeGreaterThan(tester.level);
  });

  it("rejects empty objectives, bad roles, bad concurrency, bad modes", async () => {
    expect((await service.createTeam("")).ok).toBe(false);
    expect((await service.createTeam("x", { roles: [] })).ok).toBe(false);
    expect((await service.createTeam("x", { roles: ["hacker"] })).ok).toBe(false);
    expect((await service.createTeam("x", { roles: ["coder", "coder"] })).ok).toBe(false);
    expect((await service.createTeam("x", { maxConcurrency: 99 })).ok).toBe(false);
    expect((await service.createTeam("x", { mode: "yolo" })).ok).toBe(false);
    expect((await service.createTeam("x".repeat(3000))).ok).toBe(false);
  });

  it("rejects files for unselected roles and unsafe paths", async () => {
    expect(
      (await service.createTeam("do work", {
        roles: ["coder"],
        filesByRole: { tester: ["src/a.ts"] },
      })).ok,
    ).toBe(false);
    expect(
      (await service.createTeam("do work", {
        roles: ["coder"],
        filesByRole: { coder: ["/etc/passwd"] },
      })).ok,
    ).toBe(false);
    expect(
      (await service.createTeam("do work", {
        roles: ["coder"],
        filesByRole: { coder: ["../escape.ts"] },
      })).ok,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Statuses / DAG
// ---------------------------------------------------------------------------

describe("TeamService live agent status", () => {
  it("runs to completion with per-task statuses and timings", async () => {
    const created = await service.createTeam("[[roles=coder]] simple job");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const events: string[] = [];
    const unsub = service.subscribe((e) => events.push(e.type));
    const started = await service.startTeam(created.team.teamId);
    expect(started.ok).toBe(true);
    await waitFor(async () => (await service.getTeam(created.team.teamId))?.status === "completed");
    const view = (await service.getTeam(created.team.teamId))!;
    expect(view.status).toBe("completed");
    expect(view.tasks[0]!.status).toBe("completed");
    expect(view.tasks[0]!.startedAtMs).toBeDefined();
    expect(view.tasks[0]!.completedAtMs).toBeDefined();
    expect(view.completedCount).toBe(1);
    expect(events).toContain("team/started");
    expect(events).toContain("team/completed");
    unsub();
  });

  it("passes the base config with an M4 approval hook to the orchestrator", async () => {
    const created = await service.createTeam("[[roles=coder]] job");
    if (!created.ok) return;
    await service.startTeam(created.team.teamId);
    await waitFor(async () => (await service.getTeam(created.team.teamId))?.status === "completed");
    expect(capturedConfigs.length).toBeGreaterThan(0);
    expect(typeof capturedConfigs[0]!.requestApproval).toBe("function");
  });

  it("refuses double-start while running", async () => {
    const created = await service.createTeam("slow job", {
      roles: ["coder"],
    });
    if (!created.ok) return;
    const hangFake = new FakeOrchestrator();
    hangFake.behavior = { kind: "hang", role: "coder" };
    const svc = hangServiceOn(hangFake);
    try {
      const started = await svc.startTeam(created.team.teamId);
      expect(started.ok).toBe(true);
      await waitFor(async () => {
        const v = await svc.getTeam(created.team.teamId);
        return v?.tasks.some((t) => t.status === "running") ?? false;
      });
      const again = await svc.startTeam(created.team.teamId);
      expect(again.ok).toBe(false);
      expect(again.errors.join(" ")).toContain("already running");
      await svc.cancelTeam(created.team.teamId);
    } finally {
      svc.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// File locks
// ---------------------------------------------------------------------------

describe("TeamService file locks", () => {
  it("refuses concurrent claims on the same file at creation", async () => {
    const result = await service.createTeam("implement x", {
      roles: ["architect", "coder", "tester", "security", "reviewer"],
      filesByRole: {
        tester: ["src/shared.ts"],
        security: ["src/shared.ts"],
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("file conflict");
    }
  });

  it("allows sequential tasks to share files and tracks holds during the run", async () => {
    const created = await service.createTeam("[[roles=coder]] job with files", {
      roles: ["coder"],
      filesByRole: { coder: ["src/app.ts"] },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // Hold the run open: hang the coder task.
    const fake = new FakeOrchestrator();
    fake.behavior = { kind: "hang", role: "coder" };
    fakes.push(fake);
    const svc = hangServiceOn(fake);
    try {
      const started = await svc.startTeam(created.team.teamId);
      expect(started.ok).toBe(true);
      await waitFor(async () => {
        const v = await svc.getTeam(created.team.teamId);
        return v?.tasks.some((t) => t.status === "running") ?? false;
      });
      // Give the event handler a tick to acquire the lock.
      await waitFor(() => svc.runLocks(created.team.teamId).length > 0);
      const locks = svc.runLocks(created.team.teamId);
      expect(locks[0]!.file).toBe("src/app.ts");
      const view = (await svc.getTeam(created.team.teamId))!;
      expect(view.locks[0]!.holderRole).toBe("Implementer");
      await svc.cancelTeam(created.team.teamId);
      expect(svc.runLocks(created.team.teamId)).toHaveLength(0);
    } finally {
      svc.dispose();
    }
  });

  it("validateTeamFiles rejects absolute paths and escapes", () => {
    expect(validateTeamFiles(["/etc/passwd"]).ok).toBe(false);
    expect(validateTeamFiles(["C:/win/path"]).ok).toBe(false);
    expect(validateTeamFiles(["../up.ts"]).ok).toBe(false);
    expect(validateTeamFiles("nope").ok).toBe(false);
    const ok = validateTeamFiles(["src/a.ts", "src\\b.ts"]);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.files).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("TeamService cancellation", () => {
  it("cancels a running team and releases locks without orphans", async () => {
    const created = await service.createTeam("[[roles=coder]] cancellable", {
      roles: ["coder"],
      filesByRole: { coder: ["src/x.ts"] },
    });
    if (!created.ok) return;
    const hangFake = new FakeOrchestrator();
    hangFake.behavior = { kind: "hang", role: "coder" };
    const svc = hangServiceOn(hangFake);
    try {
      const started = await svc.startTeam(created.team.teamId);
      expect(started.ok).toBe(true);
      const runId = started.team.runId!;
      await waitFor(async () => {
        const v = await svc.getTeam(created.team.teamId);
        return v?.tasks.some((t) => t.status === "running") ?? false;
      });
      const cancelled = await svc.cancelTeam(created.team.teamId, { runId });
      expect(cancelled.ok).toBe(true);
      expect(cancelled.team.status).toBe("cancelled");
      expect(hangFake.cancelled).toBe(true);
      expect(svc.runLocks(created.team.teamId)).toHaveLength(0);
      expect(svc.activeRunCount()).toBe(0);
      expect(hangFake.listenerCount()).toBe(0);
    } finally {
      svc.dispose();
    }
  });

  it("cancelling a queued (pending) team leaves it cancelled, not running", async () => {
    const created = await service.createTeam("[[roles=coder]] quick", {
      roles: ["coder"],
    });
    if (!created.ok) return;
    // Cancel before the background run settles (fake succeeds fast; cancel
    // may land before or after completion — both outcomes are consistent).
    const started = await service.startTeam(created.team.teamId);
    expect(started.ok).toBe(true);
    const cancelled = await service.cancelTeam(created.team.teamId);
    const view = (await service.getTeam(created.team.teamId))!;
    expect(["cancelled", "completed"]).toContain(view.status);
    expect(cancelled.ok || view.status === "completed").toBe(true);
  });

  it("rejects stale/unknown cancel commands (replay + cross-task)", async () => {
    const a = await service.createTeam("[[roles=coder]] team a", { roles: ["coder"] });
    const b = await service.createTeam("[[roles=coder]] team b", { roles: ["coder"] });
    if (!a.ok || !b.ok) return;
    // Unknown team.
    expect((await service.cancelTeam("team-00000000-deadbeef")).ok).toBe(false);
    // Malformed ids.
    expect((await service.cancelTeam("nope")).ok).toBe(false);
    expect((await service.cancelTeam(a.team.teamId, { runId: "bogus" })).ok).toBe(false);
    // Cross-task run id: start B, try to cancel A with B's run id.
    const startedB = await service.startTeam(b.team.teamId);
    expect(startedB.ok).toBe(true);
    const cross = await service.cancelTeam(a.team.teamId, { runId: startedB.team.runId });
    expect(cross.ok).toBe(false);
    // Replay after settle: cancel B twice.
    await service.cancelTeam(b.team.teamId);
    const replay = await service.cancelTeam(b.team.teamId, { runId: startedB.team.runId });
    expect(replay.ok).toBe(false);
    expect(replay.errors.join(" ")).toContain("stale");
  });
});

// ---------------------------------------------------------------------------
// Failure propagation + retry
// ---------------------------------------------------------------------------

describe("TeamService failure propagation and retry", () => {
  it("marks downstream dependents blocked when a task fails", async () => {
    const created = await service.createTeam("job", {
      roles: ["architect", "coder", "reviewer"],
    });
    if (!created.ok) return;
    const failFake = new FakeOrchestrator();
    failFake.behavior = { kind: "fail", role: "coder" };
    const svc = hangServiceOn(failFake);
    try {
      await svc.startTeam(created.team.teamId);
      await waitFor(async () => {
        const v = await svc.getTeam(created.team.teamId);
        return v?.status === "failed";
      });
      const view = (await svc.getTeam(created.team.teamId))!;
      expect(view.status).toBe("failed");
      const coder = view.tasks.find((t) => t.role === "coder")!;
      const reviewer = view.tasks.find((t) => t.role === "reviewer")!;
      expect(coder.status).toBe("failed");
      expect(coder.error).toContain("exploded");
      expect(reviewer.status).toBe("blocked");
      expect(view.failedCount).toBe(2);
    } finally {
      svc.dispose();
    }
  });

  it("retry starts a new run that references completed work (no blind repeat)", async () => {
    const created = await service.createTeam("job", {
      roles: ["architect", "coder"],
    });
    if (!created.ok) return;
    const failFake = new FakeOrchestrator();
    failFake.behavior = { kind: "fail", role: "coder" };
    let descriptions: string[] = [];
    const svc = new TeamService({
      taskStore: store,
      buildBaseConfig: async () =>
        buildTeamAgentConfig({
          workspaceRoot: dir,
          providerId: "ollama",
          modelId: "qwen3:8b",
          bridge: null,
        }),
      createOrchestrator: () => {
        const f = new FakeOrchestrator();
        f.behavior = failFake.behavior;
        const orig = f.execute.bind(f);
        f.execute = async (d, m, o) => {
          descriptions.push(d);
          return orig(d, m, o);
        };
        return f;
      },
    });
    try {
      await svc.startTeam(created.team.teamId);
      await waitFor(async () => (await svc.getTeam(created.team.teamId))?.status === "failed");
      const retried = await svc.retryTeam(created.team.teamId);
      expect(retried.ok).toBe(true);
      expect(retried.team.runCount).toBe(2);
      // Retry objective carries completed-work context, not a blind repeat.
      expect(descriptions.length).toBe(2);
      expect(descriptions[1]).toContain("do NOT redo");
      expect(descriptions[1]).toContain("Previous attempt");
      await waitFor(async () => {
        const s = (await svc.getTeam(created.team.teamId))?.status;
        return s === "failed" || s === "completed";
      });
    } finally {
      svc.dispose();
    }
  });

  it("retry is rejected when idle, running, or already completed", async () => {
    const created = await service.createTeam("[[roles=coder]] job", { roles: ["coder"] });
    if (!created.ok) return;
    expect((await service.retryTeam(created.team.teamId)).ok).toBe(false);
    await service.startTeam(created.team.teamId);
    await waitFor(async () => (await service.getTeam(created.team.teamId))?.status === "completed");
    expect((await service.retryTeam(created.team.teamId)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Persistence / recovery
// ---------------------------------------------------------------------------

describe("TeamService persistence and recovery", () => {
  it("recovers interrupted teams after restart with completed info intact", async () => {
    const created = await service.createTeam("[[roles=coder]] durable job", {
      roles: ["coder"],
    });
    if (!created.ok) return;
    const hangFake = new FakeOrchestrator();
    hangFake.behavior = { kind: "hang", role: "coder" };
    const svc = hangServiceOn(hangFake);
    const started = await svc.startTeam(created.team.teamId);
    expect(started.ok).toBe(true);
    await waitFor(async () => {
      const v = await svc.getTeam(created.team.teamId);
      return v?.tasks.some((t) => t.status === "running") ?? false;
    });
    // Simulate extension restart WITHOUT dispose (crash): new service, same store.
    const recovered = await store.markInterruptedOnStartup();
    expect(recovered).toBeGreaterThanOrEqual(1);
    const svc2 = makeService();
    try {
      const view = (await svc2.getTeam(created.team.teamId))!;
      expect(view.status).toBe("interrupted");
      expect(view.runCount).toBe(1);
      // Completed-agent info survives: roles/objective/identity intact.
      expect(view.roles).toEqual(["coder"]);
      expect(view.objective).toContain("durable job");
      // Retire the crashed ghost run before retrying (crash cleanup); the
      // retry path itself is proven from interrupted/cancelled states.
      svc.dispose();
      // Let the ghost's background settle land before retrying (deterministic).
      await new Promise((r) => setTimeout(r, 50));
      // Recovery path: retry works after restart.
      const retried = await svc2.retryTeam(created.team.teamId);
      expect(retried.ok).toBe(true);
      await waitFor(async () => {
        const s = (await svc2.getTeam(created.team.teamId))?.status;
        return s === "completed" || s === "failed";
      });
    } finally {
      svc2.dispose();
      svc.dispose();
    }
  });

  it("removeTeam deletes the record (destructive, UI confirms)", async () => {
    const created = await service.createTeam("[[roles=coder]] temp", { roles: ["coder"] });
    if (!created.ok) return;
    await service.startTeam(created.team.teamId);
    await waitFor(async () => (await service.getTeam(created.team.teamId))?.status === "completed");
    expect((await service.removeTeam(created.team.teamId)).ok).toBe(true);
    expect(await service.getTeam(created.team.teamId)).toBeNull();
    expect((await service.listTeams()).some((t) => t.teamId === created.team.teamId)).toBe(false);
  });

  it("removeTeam refuses while running", async () => {
    const created = await service.createTeam("[[roles=coder]] temp", { roles: ["coder"] });
    if (!created.ok) return;
    const hangFake = new FakeOrchestrator();
    hangFake.behavior = { kind: "hang", role: "coder" };
    const svc = hangServiceOn(hangFake);
    try {
      await svc.startTeam(created.team.teamId);
      expect((await svc.removeTeam(created.team.teamId)).ok).toBe(false);
      await svc.cancelTeam(created.team.teamId);
      expect((await svc.removeTeam(created.team.teamId)).ok).toBe(true);
    } finally {
      svc.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// M4 enforcement for the team agent config (all six side-effect categories)
// ---------------------------------------------------------------------------

describe("Team agent config M4 enforcement (no bypass)", () => {
  const SIDE_EFFECT_TOOLS = [
    "terminal", // terminal command
    "write_file", // file write
    "delete_file", // file delete
    "mcp__postgres__query", // MCP tool
    "myplugin__do_thing", // plugin tool (live name)
    "web_fetch", // browser/web operation
  ];

  it("deny-closed without a bridge for every side-effect category", async () => {
    const config = buildTeamAgentConfig({
      workspaceRoot: dir,
      providerId: "ollama",
      modelId: "qwen3:8b",
    });
    expect(config.requestApproval).toBeDefined();
    for (const toolName of SIDE_EFFECT_TOOLS) {
      const decision = await config.requestApproval!({
        toolCallId: "tc-1",
        toolName,
        input: { path: "src/a.ts", command: "rm -rf /" },
      });
      expect(decision.approved).toBe(false);
    }
  });

  it("delegates every category to the M4 bridge and honors deny", async () => {
    const seen: string[] = [];
    const config = buildTeamAgentConfig({
      workspaceRoot: dir,
      providerId: "ollama",
      modelId: "qwen3:8b",
      bridge: {
        evaluateLiveTool: async ({ toolName }) => {
          seen.push(toolName);
          return { approved: false, reason: "denied by test policy" };
        },
      },
    });
    for (const toolName of SIDE_EFFECT_TOOLS) {
      const decision = await config.requestApproval!({
        toolCallId: "tc-1",
        toolName,
        input: {},
      });
      expect(decision.approved).toBe(false);
    }
    expect(seen).toEqual(SIDE_EFFECT_TOOLS);
  });

  it("passes through bridge approvals without alteration", async () => {
    const config = buildTeamAgentConfig({
      workspaceRoot: dir,
      providerId: "ollama",
      modelId: "qwen3:8b",
      bridge: {
        evaluateLiveTool: async () => ({ approved: true, reason: "ok" }),
      },
    });
    const decision = await config.requestApproval!({
      toolCallId: "tc-1",
      toolName: "write_file",
      input: { path: "src/a.ts" },
    });
    expect(decision.approved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validation + lifecycle
// ---------------------------------------------------------------------------

describe("TeamService validation", () => {
  it("rejects malformed/unknown ids everywhere", async () => {
    expect(isValidTeamId("nope")).toBe(false);
    expect(isValidTeamId("team-123-abc")).toBe(true);
    expect(isValidRunId("run-123-abc")).toBe(true);
    expect(isValidRunId("bogus")).toBe(false);
    expect((await service.startTeam("nope")).ok).toBe(false);
    expect((await service.startTeam("team-00000000-deadbeef")).ok).toBe(false);
    expect((await service.cancelTeam("nope")).ok).toBe(false);
    expect((await service.retryTeam("nope")).ok).toBe(false);
    expect((await service.removeTeam("nope")).ok).toBe(false);
    expect(await service.getTeam("team-00000000-deadbeef")).toBeNull();
  });

  it("roleLabel covers engine roles", () => {
    expect(roleLabel("architect")).toBe("Planner");
    expect(roleLabel("coder")).toBe("Implementer");
    expect(roleLabel("tester")).toBe("Tester");
    expect(roleLabel("reviewer")).toBe("Reviewer");
  });
});

describe("TeamService lifecycle and disposal", () => {
  it("repeated start → execute → complete cycles return to baseline", async () => {
    for (let i = 0; i < 3; i++) {
      const created = await service.createTeam("[[roles=coder]] cycle job", {
        roles: ["coder"],
      });
      if (!created.ok) throw new Error("setup failed");
      const unsub = service.subscribe(() => undefined);
      await service.startTeam(created.team.teamId);
      await waitFor(async () => (await service.getTeam(created.team.teamId))?.status === "completed");
      unsub();
      expect(service.listenerCount()).toBe(0);
      expect(service.activeRunCount()).toBe(0);
      expect(service.runLocks(created.team.teamId)).toHaveLength(0);
    }
  });

  it("repeated start → execute → cancel cycles return to baseline", async () => {
    for (let i = 0; i < 3; i++) {
      const created = await service.createTeam("[[roles=coder]] cycle job", {
        roles: ["coder"],
      });
      if (!created.ok) throw new Error("setup failed");
      const hangFake = new FakeOrchestrator();
      hangFake.behavior = { kind: "hang", role: "coder" };
      const svc = hangServiceOn(hangFake);
      try {
        const unsub = svc.subscribe(() => undefined);
        await svc.startTeam(created.team.teamId);
        await waitFor(async () => {
          const v = await svc.getTeam(created.team.teamId);
          return v?.tasks.some((t) => t.status === "running") ?? false;
        });
        await svc.cancelTeam(created.team.teamId);
        unsub();
        expect(svc.listenerCount()).toBe(0);
        expect(svc.activeRunCount()).toBe(0);
        expect(svc.runLocks(created.team.teamId)).toHaveLength(0);
        expect(hangFake.listenerCount()).toBe(0);
      } finally {
        svc.dispose();
      }
    }
  });

  it("start → execute → fail → dispose leaves no locks, runs or listeners", async () => {
    const created = await service.createTeam("job", {
      roles: ["architect", "coder"],
      filesByRole: { coder: ["src/fail.ts"] },
    });
    if (!created.ok) return;
    const failFake = new FakeOrchestrator();
    failFake.behavior = { kind: "fail", role: "coder" };
    const svc = hangServiceOn(failFake);
    try {
      const unsub = svc.subscribe(() => undefined);
      await svc.startTeam(created.team.teamId);
      await waitFor(async () => (await svc.getTeam(created.team.teamId))?.status === "failed");
      unsub();
      expect(svc.runLocks(created.team.teamId)).toHaveLength(0);
      svc.dispose();
      svc.dispose();
      expect(svc.listenerCount()).toBe(0);
      expect(svc.activeRunCount()).toBe(0);
    } finally {
      svc.dispose();
    }
  });

  it("dispose cancels active runs and releases locks (extension shutdown)", async () => {
    const created = await service.createTeam("[[roles=coder]] shutdown job", {
      roles: ["coder"],
      filesByRole: { coder: ["src/live.ts"] },
    });
    if (!created.ok) return;
    const hangFake = new FakeOrchestrator();
    hangFake.behavior = { kind: "hang", role: "coder" };
    const svc = hangServiceOn(hangFake);
    svc.subscribe(() => undefined);
    await svc.startTeam(created.team.teamId);
    await waitFor(async () => {
      const v = await svc.getTeam(created.team.teamId);
      return v?.tasks.some((t) => t.status === "running") ?? false;
    });
    svc.dispose();
    expect(hangFake.cancelled).toBe(true);
    expect(svc.runLocks(created.team.teamId)).toHaveLength(0);
    expect(svc.listenerCount()).toBe(0);
    expect(svc.activeRunCount()).toBe(0);
  });
});
