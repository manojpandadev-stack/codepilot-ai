/**
 * M17 — Scheduler tests: next-run computation (once/interval/daily with
 * timezone), missed-run policies, bounded concurrency, retries,
 * persistence/restart, and cancellation.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TaskScheduler, nextRunAt } from "./m17-scheduler.js";
import type { ScheduleDefinition, ScheduleRunner } from "./m17-scheduler.js";

function schedule(overrides?: Partial<ScheduleDefinition>): ScheduleDefinition {
  return {
    id: "sched-1",
    name: "Test Schedule",
    kind: "recurring",
    everyMinutes: 10,
    prompt: "run the checks",
    enabled: true,
    createdAtMs: Date.now(),
    ...overrides,
  };
}

describe("M17 nextRunAt", () => {
  it("computes once schedules strictly in the future", () => {
    const now = Date.now();
    const future = nextRunAt(
      schedule({ kind: "once", atIso: new Date(now + 60_000).toISOString() }),
      now,
    );
    expect(future).toBeGreaterThan(now);

    // Past once schedules never fire.
    const past = nextRunAt(
      schedule({ kind: "once", atIso: new Date(now - 60_000).toISOString() }),
      now,
    );
    expect(past).toBeUndefined();
  });

  it("computes interval recurrences after lastRun", () => {
    const now = Date.now();
    const next = nextRunAt(schedule({ everyMinutes: 15 }), now);
    expect(next).toBeGreaterThan(now);
    expect(next! - now).toBeLessThanOrEqual(15 * 60_000 + 5_000);
  });

  it("computes daily time-of-day in a timezone", () => {
    const now = Date.now();
    const next = nextRunAt(
      schedule({
        everyMinutes: undefined,
        dailyAt: "09:00",
        timezone: "America/New_York",
      }),
      now,
    );
    expect(next).toBeDefined();
    // 09:00 America/New_York is 13:00 or 14:00 UTC depending on DST.
    const inZone = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(next!));
    expect(inZone.replace(/^0/, "")).toMatch(/^9:00( AM|)$/);
  });

  it("returns undefined for disabled schedules", () => {
    expect(nextRunAt(schedule({ enabled: false }), Date.now())).toBeUndefined();
  });

  it("returns undefined for malformed dailyAt", () => {
    expect(
      nextRunAt(
        schedule({ everyMinutes: undefined, dailyAt: "25:99" }),
        Date.now(),
      ),
    ).toBeUndefined();
  });
});

describe("M17 TaskScheduler", () => {
  let runnerCalls: Array<{ prompt: string; atMs: number }>;
  let runner: ScheduleRunner;

  beforeEach(() => {
    runnerCalls = [];
    runner = async (prompt) => {
      runnerCalls.push({ prompt, atMs: Date.now() });
      return { exitCode: 0, output: "ok" };
    };
  });

  it("runs a due schedule through the runner", () => {
    const scheduler = new TaskScheduler(runner, { tickIntervalMs: 60_000 });
    const past = Date.now() - 60_000;
    scheduler.upsert(
      schedule({
        id: "due-now",
        everyMinutes: 5,
        lastRunAtMs: past - 10 * 60_000,
        missedRunPolicy: "run-once",
      }),
    );
    const started = scheduler.processTick();
    expect(started).toHaveLength(1);
    expect(started[0]?.scheduleId).toBe("due-now");
  });

  it("skips non-due schedules", () => {
    const scheduler = new TaskScheduler(runner);
    scheduler.upsert(schedule({ everyMinutes: 60 }));
    expect(scheduler.processTick()).toHaveLength(0);
    expect(runnerCalls).toHaveLength(0);
  });

  it("applies skip policy for missed recurring runs", () => {
    const scheduler = new TaskScheduler(runner);
    const longAgo = Date.now() - 3 * 60 * 60_000;
    scheduler.upsert(
      schedule({
        everyMinutes: 10,
        lastRunAtMs: longAgo,
        missedRunPolicy: "skip",
      }),
    );
    scheduler.processTick();
    expect(runnerCalls).toHaveLength(0);
    expect(scheduler.get("sched-1")?.lastRunStatus).toBe("skipped");
  });

  it("run-once policy still executes after downtime", () => {
    const scheduler = new TaskScheduler(runner);
    const longAgo = Date.now() - 3 * 60 * 60_000;
    scheduler.upsert(
      schedule({
        everyMinutes: 10,
        lastRunAtMs: longAgo,
        missedRunPolicy: "run-once",
      }),
    );
    const started = scheduler.processTick();
    expect(started).toHaveLength(1);
  });

  it("enforces bounded concurrency", () => {
    let active = 0;
    let maxActive = 0;
    const slowRunner: ScheduleRunner = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active -= 1;
      return { exitCode: 0, output: "ok" };
    };
    const scheduler = new TaskScheduler(slowRunner, { maxConcurrent: 2 });
    for (let i = 0; i < 5; i++) {
      scheduler.upsert(
        schedule({
          id: `s-${i}`,
          everyMinutes: 5,
          lastRunAtMs: Date.now() - 30 * 60_000,
        }),
      );
    }
    scheduler.processTick();
    // All 5 queued, only 2 running at once.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(maxActive).toBeLessThanOrEqual(2);
        resolve();
      }, 120);
    });
  });

  it("retries failed runs up to maxRetries", async () => {
    let attempts = 0;
    const flaky: ScheduleRunner = async () => {
      attempts += 1;
      return { exitCode: attempts < 3 ? 1 : 0, output: "" };
    };
    const scheduler = new TaskScheduler(flaky);
    scheduler.upsert(
      schedule({
        id: "retry-me",
        everyMinutes: 5,
        lastRunAtMs: Date.now() - 30 * 60_000,
        maxRetries: 3,
        missedRunPolicy: "run-once",
      }),
    );
    scheduler.processTick();
    await vi.waitFor(() => expect(attempts).toBe(3));
    expect(scheduler.get("retry-me")?.lastRunStatus).toBe("success");
  });

  it("records failure when retries are exhausted", async () => {
    const failing: ScheduleRunner = async () => ({ exitCode: 2, output: "" });
    const scheduler = new TaskScheduler(failing);
    scheduler.upsert(
      schedule({
        id: "always-fails",
        everyMinutes: 5,
        lastRunAtMs: Date.now() - 30 * 60_000,
        maxRetries: 1,
        missedRunPolicy: "run-once",
      }),
    );
    scheduler.processTick();
    await vi.waitFor(() =>
      expect(scheduler.runHistory()[0]?.error).toContain("exit code 2"),
    );
    expect(scheduler.get("always-fails")?.lastRunStatus).toBe("failed");
  });

  it("persists schedules and survives restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-m17-"));
    try {
      const storePath = path.join(dir, "schedules.json");
      const first = new TaskScheduler(runner, { storePath });
      first.upsert(schedule({ id: "persistent", everyMinutes: 30 }));
      expect(first.get("persistent")).toBeDefined();

      const second = new TaskScheduler(runner, { storePath });
      expect(second.get("persistent")?.prompt).toBe("run the checks");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tolerates corrupt persistence files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-m17-"));
    try {
      const storePath = path.join(dir, "schedules.json");
      fs.writeFileSync(storePath, "{corrupt", "utf8");
      const scheduler = new TaskScheduler(runner, { storePath });
      expect(scheduler.list()).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancelAll stops activity and cancels pending runs", () => {
    const scheduler = new TaskScheduler(runner);
    scheduler.upsert(
      schedule({ everyMinutes: 5, lastRunAtMs: Date.now() - 30 * 60_000 }),
    );
    scheduler.cancelAll();
    expect(scheduler.processTick()).toHaveLength(0);
  });

  it("remove deletes a schedule", () => {
    const scheduler = new TaskScheduler(runner);
    scheduler.upsert(schedule({ id: "gone" }));
    expect(scheduler.remove("gone")).toBe(true);
    expect(scheduler.get("gone")).toBeUndefined();
  });

  it("disabled schedules never run", () => {
    const scheduler = new TaskScheduler(runner);
    scheduler.upsert(
      schedule({
        everyMinutes: 5,
        lastRunAtMs: Date.now() - 30 * 60_000,
        enabled: false,
      }),
    );
    expect(scheduler.processTick()).toHaveLength(0);
    expect(runnerCalls).toHaveLength(0);
  });
});
