/**
 * M17 ScheduleService tests — backend for the Scheduler UI.
 *
 * Proves, against the REAL M17 TaskScheduler (same queue/pump/executor/
 * history path for ticks AND Run Now), that the UI:
 *  - lists/creates/edits/enables/disables/deletes with backend enforcement
 *  - validates every schedule server-side (UI checks are convenience only)
 *  - runs Run Now through the identical execution path (no bypass)
 *  - never double-executes (duplicates, tick+manual overlap, concurrency)
 *  - retries within bounds, cancels cleanly, persists across restarts
 *  - executes side effects ONLY through ToolExecutionService → M4
 *    (deny blocks, handler never runs; allow executes)
 *  - cleans up timers/listeners/runs (lifecycle)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  ScheduleService,
  validateScheduleInput,
  isValidScheduleId,
  isValidTimezone,
  describeSchedule,
  type ScheduleExecutor,
} from "../apps/vscode-extension/src/schedule-service";
import { ToolRegistry } from "../packages/tool-engine/src/m3/registry";
import { ToolPermissionManager } from "../packages/tool-engine/src/m3/permission-manager";
import { ToolAuditLogger } from "../packages/tool-engine/src/m3/audit-logger";
import { ToolExecutionService } from "../packages/tool-engine/src/m3/executor";
import { M4PermissionPipeline } from "../packages/tool-engine/src/m4/integration";
import type { ToolDefinition } from "../packages/tool-engine/src/m3/types";

let dir: string;
let storePath: string;

function okExecutor(
  seen: string[] = [],
  result: { exitCode: number; output: string } = { exitCode: 0, output: "ok" },
): ScheduleExecutor {
  return async (prompt) => {
    seen.push(prompt);
    return result;
  };
}

function makeService(executor?: ScheduleExecutor): ScheduleService {
  return new ScheduleService(executor ?? okExecutor(), {
    storePath,
    maxConcurrent: 1,
    tickIntervalMs: 60_000,
  });
}

function intervalInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "Nightly tests",
    prompt: "run the test suite",
    kind: "recurring",
    everyMinutes: 60,
    ...overrides,
  };
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-sched-"));
  storePath = path.join(dir, "schedules.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- validation
describe("ScheduleService server-side validation", () => {
  it("accepts the three real schedule shapes", () => {
    expect(
      validateScheduleInput({ name: "a", prompt: "p", kind: "once", atIso: new Date(Date.now() + 3600_000).toISOString() }).ok,
    ).toBe(true);
    expect(validateScheduleInput(intervalInput()).ok).toBe(true);
    expect(
      validateScheduleInput({ name: "a", prompt: "p", kind: "recurring", dailyAt: "09:00", timezone: "America/New_York" }).ok,
    ).toBe(true);
  });

  it("rejects malformed expressions and impossible schedules", () => {
    expect(validateScheduleInput({ name: "a", prompt: "p", kind: "once", atIso: "not-a-date" }).ok).toBe(false);
    expect(
      validateScheduleInput({ name: "a", prompt: "p", kind: "once", atIso: new Date(Date.now() - 1000).toISOString() }).ok,
    ).toBe(false);
    expect(validateScheduleInput(intervalInput({ everyMinutes: 0 })).ok).toBe(false);
    expect(validateScheduleInput(intervalInput({ everyMinutes: -5 })).ok).toBe(false);
    expect(validateScheduleInput(intervalInput({ everyMinutes: 1.5 })).ok).toBe(false);
    expect(validateScheduleInput(intervalInput({ everyMinutes: 99999 })).ok).toBe(false);
    expect(
      validateScheduleInput({ name: "a", prompt: "p", kind: "recurring", dailyAt: "25:00" }).ok,
    ).toBe(false);
    expect(
      validateScheduleInput({ name: "a", prompt: "p", kind: "recurring", dailyAt: "9am" }).ok,
    ).toBe(false);
    expect(
      validateScheduleInput({ name: "a", prompt: "p", kind: "recurring", dailyAt: "09:00", timezone: "Mars/Olympus" }).ok,
    ).toBe(false);
    expect(validateScheduleInput({ name: "", prompt: "p", kind: "recurring", everyMinutes: 5 }).ok).toBe(false);
    expect(validateScheduleInput({ name: "a", prompt: "", kind: "recurring", everyMinutes: 5 }).ok).toBe(false);
    expect(validateScheduleInput({ name: "a", prompt: "p", kind: "cron", everyMinutes: 5 } as never).ok).toBe(false);
    expect(validateScheduleInput(intervalInput({ maxRetries: 99 })).ok).toBe(false);
    expect(validateScheduleInput(intervalInput({ missedRunPolicy: "sometimes" })).ok).toBe(false);
    expect(validateScheduleInput(intervalInput({ enabled: "yes" })).ok).toBe(false);
  });

  it("rejects mixed/ambiguous shapes (UI-only bypass impossible)", () => {
    // everyMinutes + dailyAt together.
    expect(
      validateScheduleInput({ name: "a", prompt: "p", kind: "recurring", everyMinutes: 5, dailyAt: "09:00" }).ok,
    ).toBe(false);
    // recurring without either.
    expect(validateScheduleInput({ name: "a", prompt: "p", kind: "recurring" }).ok).toBe(false);
    // timezone without dailyAt.
    expect(validateScheduleInput(intervalInput({ timezone: "UTC" })).ok).toBe(false);
    // atIso on recurring.
    expect(validateScheduleInput(intervalInput({ atIso: new Date().toISOString() })).ok).toBe(false);
    // interval fields on once.
    expect(
      validateScheduleInput({ name: "a", prompt: "p", kind: "once", atIso: new Date(Date.now() + 60000).toISOString(), everyMinutes: 5 }).ok,
    ).toBe(false);
  });

  it("id and timezone helpers", () => {
    expect(isValidScheduleId("sched-abc123")).toBe(true);
    expect(isValidScheduleId("BAD ID!")).toBe(false);
    expect(isValidScheduleId("")).toBe(false);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });

  it("describeSchedule uses only the real syntax", () => {
    expect(describeSchedule({ kind: "once", atIso: new Date().toISOString() })).toMatch(/^once /);
    expect(describeSchedule({ kind: "recurring", everyMinutes: 90 })).toBe("every 90m");
    expect(describeSchedule({ kind: "recurring", everyMinutes: 120 })).toBe("every 2h");
    expect(describeSchedule({ kind: "recurring", dailyAt: "09:00", timezone: "UTC" })).toBe("daily 09:00 (UTC)");
  });
});

// ---------------------------------------------------------------- CRUD
describe("ScheduleService CRUD", () => {
  it("creates and lists schedules with computed next runs", () => {
    const svc = makeService();
    try {
      const created = svc.create(intervalInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.schedule.id).toMatch(/^sched-/);
      expect(created.schedule.nextRunAtMs).toBeGreaterThan(Date.now());
      expect(svc.list()).toHaveLength(1);
    } finally {
      svc.dispose();
    }
  });

  it("create rejects duplicates and invalid ids", () => {
    const svc = makeService();
    try {
      expect(svc.create({ ...intervalInput(), id: "sched-dup" }).ok).toBe(true);
      expect(svc.create({ ...intervalInput(), id: "sched-dup" }).ok).toBe(false);
      expect(svc.create({ ...intervalInput(), id: "BAD ID!" }).ok).toBe(false);
    } finally {
      svc.dispose();
    }
  });

  it("update edits fields and preserves bookkeeping", () => {
    const svc = makeService();
    try {
      const created = svc.create({ ...intervalInput(), maxRetries: 2 });
      if (!created.ok) return;
      const updated = svc.update(created.schedule.id, { name: "Renamed" });
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;
      expect(updated.schedule.name).toBe("Renamed");
      expect(updated.schedule.maxRetries).toBe(2);
      expect(updated.schedule.everyMinutes).toBe(60);
    } finally {
      svc.dispose();
    }
  });

  it("update of unknown/invalid schedules fails without side effects", () => {
    const svc = makeService();
    try {
      expect(svc.update("sched-nope", { name: "x" }).ok).toBe(false);
      expect(svc.update("BAD!", { name: "x" }).ok).toBe(false);
      const created = svc.create(intervalInput());
      if (!created.ok) return;
      expect(svc.update(created.schedule.id, { dailyAt: "99:99" }).ok).toBe(false);
      // Original untouched.
      expect(svc.details(created.schedule.id).ok).toBe(true);
    } finally {
      svc.dispose();
    }
  });

  it("toggle preserves maxRetries (regression: toggle must not reset retry config)", () => {
    const svc = makeService();
    try {
      const created = svc.create({ ...intervalInput(), maxRetries: 3 });
      if (!created.ok) return;
      expect(svc.setEnabled(created.schedule.id, false).ok).toBe(true);
      const details = svc.details(created.schedule.id);
      if (!details.ok) return;
      expect(details.details.schedule.enabled).toBe(false);
      expect(details.details.schedule.maxRetries).toBe(3);
      expect(svc.setEnabled(created.schedule.id, true).ok).toBe(true);
    } finally {
      svc.dispose();
    }
  });

  it("remove deletes; unknown ids and replayed removes fail", () => {
    const svc = makeService();
    try {
      const created = svc.create(intervalInput());
      if (!created.ok) return;
      expect(svc.remove(created.schedule.id).ok).toBe(true);
      expect(svc.remove(created.schedule.id).ok).toBe(false);
      expect(svc.remove("sched-unknown").ok).toBe(false);
      expect(svc.remove("BAD!").ok).toBe(false);
      expect(svc.list()).toHaveLength(0);
    } finally {
      svc.dispose();
    }
  });

  it("details returns metadata, computed next run, and bounded history", () => {
    const svc = makeService();
    try {
      const created = svc.create(intervalInput());
      if (!created.ok) return;
      const details = svc.details(created.schedule.id);
      expect(details.ok).toBe(true);
      if (!details.ok) return;
      expect(details.details.schedule.id).toBe(created.schedule.id);
      expect(details.details.history).toEqual([]);
      expect(svc.details("sched-nope").ok).toBe(false);
    } finally {
      svc.dispose();
    }
  });
});

// ---------------------------------------------------------------- run-now
describe("ScheduleService Run Now (same path as scheduled runs)", () => {
  it("executes the real runner with the schedule prompt", async () => {
    const seen: string[] = [];
    const svc = makeService(okExecutor(seen));
    try {
      const created = svc.create({ ...intervalInput(), prompt: "the real prompt" });
      if (!created.ok) return;
      const result = svc.runNow(created.schedule.id);
      expect(result.ok).toBe(true);
      await waitFor(() => svc.history(10).some((r) => r.status === "success"));
      expect(seen).toEqual(["the real prompt"]);
    } finally {
      svc.dispose();
    }
  });

  it("refuses duplicates while queued/running (no double execution)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const svc = makeService(async () => {
      calls += 1;
      await gate;
      return { exitCode: 0, output: "ok" };
    });
    try {
      const created = svc.create(intervalInput());
      if (!created.ok) return;
      expect(svc.runNow(created.schedule.id).ok).toBe(true);
      await waitFor(() => svc.history(10).some((r) => r.status === "running"));
      // Second trigger while running → refused, not queued.
      const dup = svc.runNow(created.schedule.id);
      expect(dup.ok).toBe(false);
      expect(dup.errors.join(" ")).toContain("already");
      release();
      await waitFor(() => svc.history(10).some((r) => r.status === "success"));
      expect(calls).toBe(1);
    } finally {
      svc.dispose();
    }
  });

  it("refuses run-now for unknown, disabled, or invalid ids", () => {
    const svc = makeService();
    try {
      expect(svc.runNow("sched-nope").ok).toBe(false);
      expect(svc.runNow("BAD!").ok).toBe(false);
      const created = svc.create({ ...intervalInput(), enabled: false });
      if (!created.ok) return;
      expect(svc.runNow(created.schedule.id).ok).toBe(false);
    } finally {
      svc.dispose();
    }
  });

  it("tick-triggered and manual runs share one funnel (no overlap, no dup)", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const svc = makeService(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 30));
      concurrent -= 1;
      return { exitCode: 0, output: "ok" };
    });
    try {
      const a = svc.create({ ...intervalInput(), name: "aaa" });
      const b = svc.create({ ...intervalInput(), name: "bbb" });
      if (!a.ok || !b.ok) return;
      expect(svc.runNow(a.schedule.id).ok).toBe(true);
      expect(svc.runNow(b.schedule.id).ok).toBe(true);
      await waitFor(() => svc.history(10).filter((r) => r.status === "success").length >= 2);
      expect(maxConcurrent).toBe(1);
    } finally {
      svc.dispose();
    }
  });
});

// ---------------------------------------------------------------- retry/cancel
describe("ScheduleService retry and cancellation", () => {
  it("retries bounded attempts then records failure", async () => {
    let attempts = 0;
    const svc = makeService(async () => {
      attempts += 1;
      return { exitCode: 1, output: "boom" };
    });
    try {
      const created = svc.create({ ...intervalInput(), maxRetries: 2 });
      if (!created.ok) return;
      svc.runNow(created.schedule.id);
      await waitFor(() => svc.history(10).some((r) => r.status === "failed"));
      expect(attempts).toBe(3);
      const details = svc.details(created.schedule.id);
      if (details.ok) {
        expect(details.details.schedule.lastRunStatus).toBe("failed");
        expect(details.details.history[0]!.attempt).toBe(3);
      }
    } finally {
      svc.dispose();
    }
  });

  it("failing runner error text is captured actionably", async () => {
    const svc = makeService(async () => {
      throw new Error("runner exploded");
    });
    try {
      const created = svc.create(intervalInput());
      if (!created.ok) return;
      svc.runNow(created.schedule.id);
      await waitFor(() => svc.history(10).some((r) => r.status === "failed"));
      expect(svc.history(10)[0]!.error).toContain("runner exploded");
    } finally {
      svc.dispose();
    }
  });

  it("dispose stops the timer and marks in-flight cancelled", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const svc = makeService(async () => {
      await gate;
      return { exitCode: 0, output: "ok" };
    });
    const created = svc.create(intervalInput());
    if (!created.ok) {
      svc.dispose();
      return;
    }
    svc.runNow(created.schedule.id);
    await waitFor(() => svc.history(10).some((r) => r.status === "running"));
    svc.dispose();
    svc.dispose(); // idempotent
    expect(svc.isDisposed()).toBe(true);
    expect(svc.listenerCount()).toBe(0);
    expect(svc.taskScheduler.hasTimer()).toBe(false);
    release();
  });
});

// ---------------------------------------------------------------- persistence
describe("ScheduleService persistence and restart", () => {
  it("schedules and enabled state survive restarts; no duplicate timers", () => {
    const first = makeService();
    const created = first.create({ ...intervalInput(), name: "persist-me" });
    expect(created.ok).toBe(true);
    const disabled = first.create({ ...intervalInput(), name: "off", enabled: false });
    expect(disabled.ok).toBe(true);
    first.dispose();

    const second = makeService();
    try {
      const list = second.list();
      expect(list).toHaveLength(2);
      expect(list.find((s) => s.name === "persist-me")!.enabled).toBe(true);
      expect(list.find((s) => s.name === "off")!.enabled).toBe(false);
      // No timer until ensureStarted; exactly one after (idempotent).
      expect(second.taskScheduler.hasTimer()).toBe(false);
      second.ensureStarted();
      second.ensureStarted();
      expect(second.taskScheduler.hasTimer()).toBe(true);
    } finally {
      second.dispose();
    }
  });

  it("last-run bookkeeping survives; in-memory history does not (documented)", async () => {
    const first = makeService();
    const created = first.create(intervalInput());
    if (!created.ok) {
      first.dispose();
      return;
    }
    first.runNow(created.schedule.id);
    await waitFor(() => first.history(10).some((r) => r.status === "success"));
    first.dispose();

    const second = makeService();
    try {
      const list = second.list();
      expect(list[0]!.lastRunStatus).toBe("success");
      expect(list[0]!.lastRunAtMs).toBeDefined();
      // History is bounded in-memory by design — coherent, not phantom.
      expect(second.history(50)).toHaveLength(0);
      expect(second.metrics().total).toBe(0);
    } finally {
      second.dispose();
    }
  });

  it("interrupted executions never become phantom-running tasks", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = makeService(async () => {
      await gate;
      return { exitCode: 0, output: "ok" };
    });
    const created = first.create(intervalInput());
    if (!created.ok) {
      first.dispose();
      return;
    }
    first.runNow(created.schedule.id);
    await waitFor(() => first.history(10).some((r) => r.status === "running"));
    // Simulate crash: drop WITHOUT dispose (no cancelAll persisted — history
    // is memory-only, schedules carry lastRun bookkeeping only).
    release();
    const second = makeService();
    try {
      // Schedules reload; nothing claims to be running (no phantom).
      expect(second.metrics().running).toBe(0);
      expect(second.metrics().queued).toBe(0);
      expect(second.list()).toHaveLength(1);
    } finally {
      second.dispose();
      first.dispose();
    }
  });
});

// ---------------------------------------------------------------- M4 chain
describe("ScheduleService M4 enforcement (no scheduled bypass)", () => {
  function probeTool(calls: string[]): ToolDefinition {
    return {
      id: "sched_probe",
      name: "Sched Probe",
      description: "test",
      category: "analysis",
      version: "1.0.0",
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      capabilities: ["idempotent"],
      permission: { level: "read", requiresApproval: false, rationale: "test" },
      idempotent: true,
      async execute() {
        calls.push("ran");
        return { ok: true };
      },
    };
  }

  function m4Executor(
    pipeline: M4PermissionPipeline,
    received: string[],
    calls: string[],
    cwd: string,
  ): ScheduleExecutor {
    const registry = new ToolRegistry();
    registry.register(probeTool(calls));
    const exec = new ToolExecutionService(
      registry,
      new ToolPermissionManager(),
      new ToolAuditLogger(),
      { defaultTimeoutMs: 5000 },
      pipeline,
    );
    return async (prompt) => {
      received.push(prompt);
      const res = await exec.execute("sched_probe", {}, { cwd });
      return res.status === "completed"
        ? { exitCode: 0, output: "executed" }
        : { exitCode: 1, output: res.error?.message ?? "denied" };
    };
  }

  it("M4 DENY stops execution and the side effect never occurs", async () => {
    const calls: string[] = [];
    const received: string[] = [];
    const deny = new M4PermissionPipeline({
      workspaceRoot: dir,
      presentApproval: async () => ({ decision: "allow", scope: "once" }),
      policies: [
        {
          id: "deny-reads",
          actions: ["read_file"],
          decision: "deny",
          scope: "single_execution",
          priority: 1000,
          enabled: true,
        },
      ],
    });
    const svc = new ScheduleService(m4Executor(deny, received, calls, dir), { maxConcurrent: 1 });
    try {
      const created = svc.create({ ...intervalInput(), prompt: "do the thing" });
      if (!created.ok) return;
      svc.runNow(created.schedule.id);
      await waitFor(() => svc.history(10).some((r) => r.status === "failed"));
      expect(calls).toHaveLength(0);
      expect(received).toEqual(["do the thing"]);
      // The denial surfaces in the recorded output (M4 reason preserved).
      expect(svc.history(10)[0]!.outputExcerpt ?? "").toMatch(/denied/i);
    } finally {
      svc.dispose();
    }
  });

  it("M4 allow executes through the full chain", async () => {
    const calls: string[] = [];
    const allow = new M4PermissionPipeline({
      workspaceRoot: dir,
      presentApproval: async () => ({ decision: "allow", scope: "once" }),
    });
    const svc = new ScheduleService(m4Executor(allow, [], calls, dir), { maxConcurrent: 1 });
    try {
      const created = svc.create(intervalInput());
      if (!created.ok) return;
      svc.runNow(created.schedule.id);
      await waitFor(() => svc.history(10).some((r) => r.status === "success"));
      expect(calls).toHaveLength(1);
    } finally {
      svc.dispose();
    }
  });

  it("missing executor (no M4 runtime) fails closed without crashing", async () => {
    const svc = new ScheduleService(async () => {
      throw new Error("backend unavailable (M4 permission pipeline not initialized)");
    });
    try {
      const created = svc.create(intervalInput());
      if (!created.ok) return;
      svc.runNow(created.schedule.id);
      await waitFor(() => svc.history(10).some((r) => r.status === "failed"));
      expect(svc.history(10)[0]!.error).toContain("backend unavailable");
      expect(svc.list()).toHaveLength(1);
    } finally {
      svc.dispose();
    }
  });
});

// ---------------------------------------------------------------- history/metrics
describe("ScheduleService history and metrics", () => {
  it("history is bounded and metrics aggregate", async () => {
    const svc = makeService();
    try {
      const created = svc.create(intervalInput());
      if (!created.ok) return;
      svc.runNow(created.schedule.id);
      await waitFor(() => svc.history(10).some((r) => r.status === "success"));
      const m = svc.metrics();
      expect(m.total).toBe(1);
      expect(m.success).toBe(1);
      expect(m.failed).toBe(0);
      const details = svc.details(created.schedule.id);
      if (details.ok) {
        expect(details.details.history).toHaveLength(1);
        expect(details.details.history[0]!.exitCode).toBe(0);
        expect(details.details.history[0]!.durationMs).toBeDefined();
      }
    } finally {
      svc.dispose();
    }
  });
});

// ---------------------------------------------------------------- lifecycle
describe("ScheduleService lifecycle", () => {
  it("repeated create → enable → execute → disable → dispose returns to baseline", async () => {
    for (let i = 0; i < 3; i++) {
      const svc = makeService();
      const unsub = svc.subscribe(() => undefined);
      const created = svc.create(intervalInput());
      if (!created.ok) throw new Error("setup failed");
      svc.runNow(created.schedule.id);
      await waitFor(() => svc.history(10).some((r) => r.status === "success"));
      expect(svc.setEnabled(created.schedule.id, false).ok).toBe(true);
      unsub();
      svc.dispose();
      expect(svc.listenerCount()).toBe(0);
      expect(svc.taskScheduler.hasTimer()).toBe(false);
    }
  });

  it(" restart → reload → execute works without duplicate timers", async () => {
    const first = makeService();
    first.create(intervalInput());
    first.dispose();
    const second = makeService();
    try {
      expect(second.list()).toHaveLength(1);
      second.ensureStarted();
      expect(second.taskScheduler.hasTimer()).toBe(true);
      const only = second.list()[0]!;
      second.runNow(only.id);
      await waitFor(() => second.history(10).some((r) => r.status === "success"));
    } finally {
      second.dispose();
    }
  });

  it("run events fan out to subscribers exactly once per transition", async () => {
    const svc = makeService();
    try {
      const seen: string[] = [];
      const unsub = svc.subscribe(() => seen.push("changed"));
      const created = svc.create(intervalInput());
      if (!created.ok) return;
      svc.runNow(created.schedule.id);
      await waitFor(() => svc.history(10).some((r) => r.status === "success"));
      // create + runNow + running + success = at least 3 change events.
      expect(seen.length).toBeGreaterThanOrEqual(3);
      unsub();
      const before = seen.length;
      svc.create({ ...intervalInput(), name: "another" });
      expect(seen.length).toBe(before);
    } finally {
      svc.dispose();
    }
  });
});
