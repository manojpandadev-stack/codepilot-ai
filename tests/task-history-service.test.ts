/**
 * TaskHistoryService tests — backend for the Task History UX.
 *
 * Uses REAL collaborators: M12 TaskStore on a temp dir, M5
 * FileMutationService + CheckpointManager on a temp workspace, and the REAL
 * M5 computeDiff engine for checkpoint comparison. Proves views, timeline,
 * file summaries, checkpoint listing/comparison, run comparison, search,
 * interruption/resume/restart/discard, ownership, redaction, bounds and
 * lifecycle determinism — with adversarial ownership/bypass attempts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { TaskStore } from "../packages/agent-runtime/src/m12-task-store";
import { FileMutationService } from "../packages/changeset-engine/src/m5/file-mutation";
import { CheckpointManager } from "../packages/changeset-engine/src/m5/checkpoint-manager";
import {
  TaskHistoryService,
  buildResumePrompt,
  isValidTaskId,
  isValidCheckpointId,
} from "../apps/vscode-extension/src/task-history-service";

let dir: string;
let workspace: string;
let store: TaskStore;
let mutation: FileMutationService;
let checkpoints: CheckpointManager;
let service: TaskHistoryService;

function allowGuard(rel: string): string {
  if (!rel || rel.includes("..") || path.isAbsolute(rel)) {
    throw new Error(`mutation path guard rejected: ${rel}`);
  }
  return rel.replace(/\\/g, "/");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-hist-"));
  workspace = path.join(dir, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  store = new TaskStore(path.join(dir, "tasks"));
  mutation = new FileMutationService({
    workspaceRoot: workspace,
    pathGuard: { guard: allowGuard, isSensitive: () => false },
  });
  checkpoints = new CheckpointManager({ mutation });
  service = new TaskHistoryService({
    taskStore: store,
    listCheckpoints: (taskId) => checkpoints.listCheckpoints(taskId),
    getCheckpoint: (id) => checkpoints.getCheckpoint(id),
    listMutations: (taskId) => mutation.listChanges(taskId),
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function seedTask(overrides: {
  title?: string;
  prompt?: string;
  status?: "running" | "completed" | "failed" | "interrupted" | "cancelled";
  mode?: string;
  provider?: string;
  model?: string;
  assistantResult?: string;
  error?: string;
  counters?: Record<string, unknown>;
  team?: boolean;
}): Promise<string> {
  const task = await store.create(overrides.title ?? "do the thing", {
    providerId: overrides.provider ?? "ollama",
    modelId: overrides.model ?? "qwen3:8b",
    mode: overrides.mode ?? "act",
  });
  await store.appendMessage(task.id, "user", overrides.prompt ?? "do the thing now");
  if (overrides.assistantResult !== undefined) {
    await store.appendMessage(task.id, "assistant", overrides.assistantResult);
  }
  if (overrides.error !== undefined) {
    await store.appendMessage(task.id, "system", `Error: ${overrides.error}`);
  }
  const agentState: Record<string, unknown> = {
    sessionId: `sess-${task.id.slice(-6)}`,
    mode: overrides.mode ?? "act",
    ...(overrides.counters ?? {}),
  };
  if (overrides.team) agentState.kind = "team";
  await store.update(task.id, {
    status: overrides.status ?? "completed",
    agentState,
  } as never);
  return task.id;
}

async function writeAndCheckpoint(
  taskId: string,
  files: Record<string, string>,
  description: string,
): Promise<string> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(workspace, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  const cp = checkpoints.createCheckpoint({
    taskId,
    description,
    files: Object.keys(files),
  });
  return cp.checkpointId;
}

// ---------------------------------------------------------------- history
describe("TaskHistoryService history listing", () => {
  it("lists rich summaries from real persisted data", async () => {
    const id = await seedTask({
      assistantResult: "all done",
      counters: {
        toolCalls: [{ name: "read_files", count: 3, totalDurationMs: 120 }],
        toolCallCount: 3,
        retries: 1,
        filesChanged: ["src/a.ts"],
      },
    });
    const list = await service.list();
    expect(list).toHaveLength(1);
    const summary = list[0]!;
    expect(summary.id).toBe(id);
    expect(summary.status).toBe("completed");
    expect(summary.provider).toBe("ollama");
    expect(summary.model).toBe("qwen3:8b");
    expect(summary.mode).toBe("act");
    expect(summary.toolCallCount).toBe(3);
    expect(summary.retryCount).toBe(1);
    expect(summary.filesChangedCount).toBe(1);
    expect(summary.resultExcerpt).toBe("all done");
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("excludes team records from chat history", async () => {
    await seedTask({ title: "normal" });
    await seedTask({ title: "[team] x", team: true });
    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe("normal");
  });

  it("filters by status/provider/model/mode/query/flags/dates", async () => {
    await seedTask({ title: "fix login bug", status: "failed", error: "boom" });
    await seedTask({ title: "write docs", status: "completed", provider: "openai", model: "gpt-4o", mode: "ask" });
    expect((await service.list({ status: "failed" })).length).toBe(1);
    expect((await service.list({ provider: "openai" })).length).toBe(1);
    expect((await service.list({ model: "gpt-4o" })).length).toBe(1);
    expect((await service.list({ mode: "ask" })).length).toBe(1);
    expect((await service.list({ query: "login" })).length).toBe(1);
    expect((await service.list({ query: "zzz-no-match" })).length).toBe(0);
    expect((await service.list({ failedOnly: true })).length).toBe(1);
    expect((await service.list({ completedOnly: true })).length).toBe(1);
    expect((await service.list({ fromMs: Date.now() + 1000 })).length).toBe(0);
    expect((await service.list({ toMs: Date.now() + 1000 })).length).toBe(2);
    expect((await service.list({ limit: 1 })).length).toBe(1);
  });

  it("hasFiles/hasCheckpoints filters use real ledger data", async () => {
    const id = await seedTask({ title: "with files" });
    await mutation.execute({ taskId: id, ops: [{ kind: "create", path: "src/new.ts", content: "x" }] });
    await seedTask({ title: "without files" });
    expect((await service.list({ hasFiles: true })).length).toBe(1);
    await writeAndCheckpoint(id, { "src/new.ts": "x" }, "cp one");
    expect((await service.list({ hasCheckpoints: true })).length).toBe(1);
  });
});

// ---------------------------------------------------------------- details
describe("TaskHistoryService details", () => {
  it("returns timeline, files, checkpoints, messages, tools, errors, metrics", async () => {
    const id = await seedTask({
      assistantResult: "done",
      counters: {
        toolCalls: [{ name: "bash", count: 2, totalDurationMs: 50 }],
        toolCallCount: 2,
        retries: 0,
      },
    });
    await mutation.execute({ taskId: id, ops: [{ kind: "create", path: "src/app.ts", content: "hello\n" }] });
    await writeAndCheckpoint(id, { "src/app.ts": "hello\n" }, "after create");
    const result = await service.details(id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.details;
    expect(d.timeline.length).toBeGreaterThanOrEqual(3);
    expect(d.timeline[0]!.phase).toBe("created");
    expect(d.timeline.map((e) => e.phase)).toContain("prompt");
    expect(d.timeline.map((e) => e.phase)).toContain("response");
    expect(d.timeline.map((e) => e.phase)).toContain("checkpoint");
    expect(d.files.created.map((f) => f.path)).toContain("src/app.ts");
    expect(d.checkpoints).toHaveLength(1);
    expect(d.tools).toHaveLength(1);
    expect(d.metrics.toolCallCount).toBe(2);
    expect(d.errors).toHaveLength(0);
    expect(d.approvalsNote).toContain("M4");
  });

  it("rejects unknown and malformed task ids", async () => {
    expect((await service.details("nope")).ok).toBe(false);
    expect((await service.details("task-12345678-deadbeef")).ok).toBe(false);
  });

  it("builds interruption info for interrupted tasks", async () => {
    const id = await seedTask({ status: "interrupted", assistantResult: "partial work here" });
    const result = await service.details(id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.details.interruption).toBeDefined();
    expect(result.details.interruption!.lastPhase).toBe("response");
    expect(result.details.interruption!.pendingSummary.length).toBeGreaterThan(0);
  });

  it("redacts secret-shaped content via the store", async () => {
    const id = await seedTask({ prompt: "use key sk-12345678901234567890 now" });
    const result = await service.details(id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = JSON.stringify(result.details);
    expect(text).not.toContain("sk-12345678901234567890");
    expect(text).toContain("[REDACTED]");
  });

  it("bounds large outputs (messages, timeline, files)", { timeout: 120_000 }, async () => {
    // I/O-bound by design: 600 real persistence writes (~1.2MB). The 30s
    // default flakes under parallel-worker disk contention; assertions below
    // are unchanged — only the wall-clock budget is honest.
    const task = await store.create("big task");
    for (let i = 0; i < 600; i++) {
      await store.appendMessage(task.id, "assistant", `msg ${i} ${"x".repeat(2000)}`);
    }
    const result = await service.details(task.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.details.messages.length).toBeLessThanOrEqual(100);
    expect(result.details.timeline.length).toBeLessThanOrEqual(200);
    expect(result.details.messages.every((m) => m.excerpt.length <= 1000)).toBe(true);
  });
});

// ---------------------------------------------------------------- checkpoints
describe("TaskHistoryService checkpoints", () => {
  it("lists checkpoints without file contents", async () => {
    const id = await seedTask({});
    const cpId = await writeAndCheckpoint(id, { "src/a.ts": "secret-content-here" }, "first");
    const result = await service.checkpointsForTask(id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.checkpoints).toHaveLength(1);
    expect(result.checkpoints[0]!.checkpointId).toBe(cpId);
    expect(JSON.stringify(result.checkpoints)).not.toContain("secret-content-here");
  });

  it("compares checkpoints: modified + unified diff from the M5 engine", async () => {
    const id = await seedTask({});
    const a = await writeAndCheckpoint(id, { "src/a.ts": "line1\nline2\n" }, "v1");
    const b = await writeAndCheckpoint(id, { "src/a.ts": "line1\nline2 changed\n" }, "v2");
    const result = service.compareCheckpoints(a, b);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compare.modified).toEqual(["src/a.ts"]);
    expect(result.compare.diffs[0]!.additions).toBe(1);
    expect(result.compare.diffs[0]!.unifiedDiff).toContain("line2 changed");
  });

  it("detects added/removed/renamed files", async () => {
    const id = await seedTask({});
    const a = await writeAndCheckpoint(id, { "src/old.ts": "same body\n", "src/gone.ts": "bye\n" }, "v1");
    const b = await writeAndCheckpoint(
      id,
      { "src/new.ts": "same body\n", "src/added.ts": "hi\n" },
      "v2",
    );
    const result = service.compareCheckpoints(a, b);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compare.added).toContain("src/added.ts");
    expect(result.compare.removed).toContain("src/gone.ts");
    expect(result.compare.renamed).toEqual([{ from: "src/old.ts", to: "src/new.ts" }]);
  });

  it("same id compares SAME; binary flagged without diff", async () => {
    const id = await seedTask({});
    const a = await writeAndCheckpoint(id, { "src/a.ts": "x\n" }, "v1");
    const same = service.compareCheckpoints(a, a);
    expect(same.ok).toBe(true);
    if (same.ok) expect(same.compare.unchanged).toBe(1);
    const binPath = path.join(workspace, "bin.dat");
    fs.writeFileSync(binPath, Buffer.from([0, 1, 2, 0, 3]));
    const binCp = checkpoints.createCheckpoint({ taskId: id, description: "bin", files: ["bin.dat"] });
    const cmp = service.compareCheckpoints(a, binCp.checkpointId);
    expect(cmp.ok).toBe(true);
    if (cmp.ok) {
      expect(cmp.compare.diffs.some((d) => d.binary)).toBe(true);
    }
  });

  it("missing checkpoints error gracefully", () => {
    expect(service.compareCheckpoints("cp-zzz-0000000000", "cp-zzz-1111111111").ok).toBe(false);
    expect(service.compareCheckpoints("nope", "nope").ok).toBe(false);
  });
});

// ---------------------------------------------------------------- run compare
describe("TaskHistoryService run comparison", () => {
  it("compares objectively with SAME/BETTER/WORSE/DIFFERENT/UNKNOWN", async () => {
    const fast = await seedTask({
      title: "fast",
      status: "completed",
      assistantResult: "ok",
      counters: { toolCallCount: 2, retries: 0 },
    });
    const slow = await seedTask({
      title: "slow",
      status: "failed",
      error: "boom",
      counters: { toolCallCount: 9, retries: 3 },
    });
    // Force distinct durations.
    await new Promise((r) => setTimeout(r, 5));
    const result = await service.compareRuns(fast, slow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byMetric = new Map(result.rows.map((r) => [r.metric, r]));
    expect(byMetric.get("status")!.verdict).toBe("BETTER");
    expect(byMetric.get("retries")!.verdict).toBe("BETTER");
    expect(byMetric.get("errors")!.verdict).toBe("BETTER");
    expect(byMetric.get("result quality")!.verdict).toBe("UNKNOWN");
    expect(byMetric.get("result quality")!.note).toContain("cannot be measured objectively");
  });

  it("rejects unknown ids", async () => {
    const id = await seedTask({});
    expect((await service.compareRuns(id, "task-12345678-deadbeef")).ok).toBe(false);
    expect((await service.compareRuns("nope", id)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------- resume/restart/discard
describe("TaskHistoryService resume, restart, discard", () => {
  it("resumeContext excludes tool output from the prompt and names completed work", async () => {
    const task = await store.create("resume me");
    await store.appendMessage(task.id, "user", "build it");
    await store.appendMessage(task.id, "tool", "stale tool output with secrets");
    await store.appendMessage(task.id, "assistant", "built half");
    const result = await service.resumeContext(task.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Raw context keeps messages; the PROMPT builder excludes stale tool output.
    const prompt = buildResumePrompt(result.context);
    expect(prompt).toContain("Do not repeat completed work");
    expect(prompt).not.toContain("stale tool output");
  });

  it("resume refuses completed/archived/unknown tasks", async () => {
    const done = await seedTask({ status: "completed" });
    expect((await service.resumeContext(done)).ok).toBe(false);
    expect((await service.resumeContext("task-12345678-deadbeef")).ok).toBe(false);
    expect((await service.resumeContext("nope")).ok).toBe(false);
  });

  it("buildResumePrompt never emits approval-bypass language", () => {
    const prompt = buildResumePrompt({
      title: "t",
      messages: [{ role: "user", content: "hi" }],
      checkpointsAvailable: 1,
      filesChanged: ["src/a.ts"],
    });
    expect(prompt).not.toMatch(/auto-approv|skip approval|bypass|without approval/i);
    expect(prompt).toContain("do not redo");
  });

  it("restartPrompt returns the original user prompt", async () => {
    const id = await seedTask({ prompt: "original prompt here", status: "failed" });
    const result = await service.restartPrompt(id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prompt).toContain("original prompt here");
    expect((await service.restartPrompt("task-12345678-deadbeef")).ok).toBe(false);
  });

  it("discard removes the record but refuses the active task", async () => {
    const id = await seedTask({});
    expect((await service.discard("task-12345678-deadbeef")).ok).toBe(false);
    expect((await service.discard(id, { activeTaskId: id })).ok).toBe(false);
    expect((await service.discard(id)).ok).toBe(true);
    expect(await store.get(id)).toBeNull();
  });
});

// ---------------------------------------------------------------- ownership/adversarial
describe("TaskHistoryService ownership and adversarial rejection", () => {
  it("checkpoint ownership blocks cross-task access", async () => {
    const a = await seedTask({ title: "aaa" });
    const b = await seedTask({ title: "bbb" });
    const cpId = await writeAndCheckpoint(b, { "src/b.ts": "x" }, "b cp");
    expect((await service.checkCheckpointOwnership(a, cpId)).ok).toBe(false);
    expect((await service.checkCheckpointOwnership(b, cpId)).ok).toBe(true);
    expect((await service.checkCheckpointOwnership(a, "cp-zzz-0000000000")).ok).toBe(false);
    expect((await service.checkCheckpointOwnership("nope", cpId)).ok).toBe(false);
    expect((await service.checkCheckpointOwnership(a, "nope")).ok).toBe(false);
  });

  it("PathGuard blocks traversal at the M5 layer (no bypass via history)", async () => {
    const id = await seedTask({});
    // Fail-closed batch semantics: the op is refused per-outcome, nothing
    // is written, and the guard reason names the offending path.
    const batch = await mutation.execute({
      taskId: id,
      ops: [{ kind: "create", path: "../escape.ts", content: "x" }],
    });
    expect(batch.ok).toBe(false);
    expect(batch.outcomes[0]!.ok).toBe(false);
    expect(batch.outcomes[0]!.error?.message ?? "").toContain("../escape.ts");
    expect(fs.existsSync(path.join(dir, "escape.ts"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "escape.ts"))).toBe(false);
  });

  it("comparison performs zero mutations", async () => {
    const id = await seedTask({});
    const a = await writeAndCheckpoint(id, { "src/a.ts": "one\n" }, "v1");
    const b = await writeAndCheckpoint(id, { "src/a.ts": "two\n" }, "v2");
    const before = fs.readdirSync(workspace).sort();
    service.compareCheckpoints(a, b);
    await service.compareRuns(id, id);
    expect(fs.readdirSync(workspace).sort()).toEqual(before);
  });

  it("id validators reject garbage", () => {
    expect(isValidTaskId("")).toBe(false);
    expect(isValidTaskId(undefined)).toBe(false);
    expect(isValidTaskId("task-1")).toBe(false);
    expect(isValidCheckpointId("cp-nope")).toBe(false);
    expect(isValidCheckpointId(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------- lifecycle
describe("TaskHistoryService lifecycle determinism", () => {
  it("repeated open → inspect → compare → close returns identical views", async () => {
    const id = await seedTask({ assistantResult: "done" });
    await mutation.execute({ taskId: id, ops: [{ kind: "create", path: "src/x.ts", content: "x" }] });
    await writeAndCheckpoint(id, { "src/x.ts": "x" }, "cp");
    const first = JSON.stringify(await service.details(id));
    for (let i = 0; i < 5; i++) {
      await service.list();
      await service.details(id);
      await service.checkpointsForTask(id);
      service.compareCheckpoints(
        (await service.checkpointsForTask(id)).ok
          ? ((await service.checkpointsForTask(id)) as { ok: true; checkpoints: { checkpointId: string }[] }).checkpoints[0]!.checkpointId
          : "cp-zzz-0000000000",
        (await service.checkpointsForTask(id)).ok
          ? ((await service.checkpointsForTask(id)) as { ok: true; checkpoints: { checkpointId: string }[] }).checkpoints[0]!.checkpointId
          : "cp-zzz-0000000000",
      );
      await service.compareRuns(id, id);
    }
    expect(JSON.stringify(await service.details(id))).toBe(first);
  });
});
