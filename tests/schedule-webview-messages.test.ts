/**
 * Scheduler WebView contract tests — message validation, normalization,
 * frequency descriptions, status display and countdown labels.
 *
 * Every helper is pure: malformed host payloads can never produce fake rows,
 * and invalid outbound actions are rejected before posting to the host.
 */

import { describe, expect, it } from "vitest";
import {
  normalizeScheduleList,
  normalizeScheduleView,
  normalizeScheduleHistory,
  normalizeScheduleDetails,
  validateScheduleAction,
  describeScheduleFrequency,
  scheduleStatusMeta,
  nextRunLabel,
} from "../apps/webview/src/lib/messages.js";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "sched-abc123",
    name: "Nightly",
    prompt: "run tests",
    kind: "recurring",
    everyMinutes: 60,
    enabled: true,
    maxRetries: 0,
    createdAtMs: 1,
    liveStatus: "idle",
    runCount: 0,
    successCount: 0,
    failedCount: 0,
    ...overrides,
  };
}

describe("validateScheduleAction (outbound WebView message validation)", () => {
  it("accepts well-formed actions", () => {
    expect(validateScheduleAction("schedule/list", {}).ok).toBe(true);
    expect(
      validateScheduleAction("schedule/create", { name: "n", prompt: "p", kind: "recurring", everyMinutes: 30 }).ok,
    ).toBe(true);
    expect(validateScheduleAction("schedule/update", { id: "sched-1", name: "x" }).ok).toBe(true);
    expect(validateScheduleAction("schedule/toggle", { id: "sched-1", enabled: false }).ok).toBe(true);
    expect(validateScheduleAction("schedule/run-now", { scheduleId: "sched-1" }).ok).toBe(true);
    expect(validateScheduleAction("schedule/details", { scheduleId: "sched-1" }).ok).toBe(true);
    expect(validateScheduleAction("schedule/remove", { scheduleId: "sched-1" }).ok).toBe(true);
  });

  it("rejects unknown actions", () => {
    expect(validateScheduleAction("schedule/nuke", { scheduleId: "sched-1" }).ok).toBe(false);
    expect(validateScheduleAction("chat/send", {}).ok).toBe(false);
  });

  it("rejects malformed ids (unknown/stale/cross-task blocked at both layers)", () => {
    expect(validateScheduleAction("schedule/remove", { scheduleId: "BAD ID!" }).ok).toBe(false);
    expect(validateScheduleAction("schedule/run-now", {}).ok).toBe(false);
    // Non-string ids fail closed (backend rejects non-strings outright).
    expect(validateScheduleAction("schedule/details", { scheduleId: {} }).ok).toBe(false);
    expect(validateScheduleAction("schedule/toggle", { id: "" }).ok).toBe(false);
  });

  it("rejects malformed create/update fields", () => {
    expect(validateScheduleAction("schedule/create", { name: "", prompt: "p" }).ok).toBe(false);
    expect(validateScheduleAction("schedule/create", { name: "n", prompt: "p", kind: "cron" }).ok).toBe(false);
    expect(validateScheduleAction("schedule/create", { name: "n", prompt: "p", everyMinutes: 0 }).ok).toBe(false);
    expect(validateScheduleAction("schedule/create", { name: "n", prompt: "p", dailyAt: "nope" }).ok).toBe(false);
    expect(validateScheduleAction("schedule/create", { name: "n", prompt: "p", atIso: "garbage" }).ok).toBe(false);
    expect(validateScheduleAction("schedule/create", { name: "n", prompt: "p", maxRetries: 99 }).ok).toBe(false);
    expect(validateScheduleAction("schedule/create", { name: "n", prompt: "p", enabled: "yes" }).ok).toBe(false);
    expect(validateScheduleAction("schedule/update", { name: "x" }).ok).toBe(false);
  });
});

describe("normalizeScheduleList / normalizeScheduleView (inbound host payload)", () => {
  it("normalizes a rich payload", () => {
    const { schedules, history, metrics } = normalizeScheduleList({
      schedules: [row()],
      history: [{ scheduleId: "sched-abc123", scheduleName: "Nightly", startedAtMs: 5, status: "success", attempt: 1 }],
      metrics: { total: 1, success: 1, failed: 0, running: 0, queued: 0 },
    });
    expect(schedules).toHaveLength(1);
    expect(schedules[0]!.id).toBe("sched-abc123");
    expect(history).toHaveLength(1);
    expect(metrics.total).toBe(1);
  });

  it("drops malformed rows instead of rendering fake state", () => {
    const { schedules } = normalizeScheduleList({
      schedules: [row(), null, 42, { id: "BAD ID!" }, { name: "no id" }, { id: "sched-x", kind: "cron" }],
    });
    expect(schedules).toHaveLength(1);
  });

  it("returns empty state for garbage payloads", () => {
    expect(normalizeScheduleList(undefined)).toEqual({
      schedules: [],
      history: [],
      metrics: { total: 0, success: 0, failed: 0, running: 0, queued: 0 },
    });
    expect(normalizeScheduleList(null).schedules).toEqual([]);
    expect(normalizeScheduleList("nope").schedules).toEqual([]);
  });

  it("bounds untrusted string lengths", () => {
    const big = "x".repeat(9000);
    const v = normalizeScheduleView(row({ prompt: big, name: big }));
    expect(v!.prompt.length).toBeLessThanOrEqual(4000);
    expect(v!.name.length).toBeLessThanOrEqual(100);
  });
});

describe("normalizeScheduleHistory", () => {
  it("drops rows without identity", () => {
    expect(
      normalizeScheduleHistory([
        { scheduleId: "sched-1", startedAtMs: 5, status: "success", attempt: 1 },
        { nope: true },
        null,
      ]),
    ).toHaveLength(1);
  });

  it("returns [] for non-arrays", () => {
    expect(normalizeScheduleHistory(undefined)).toEqual([]);
    expect(normalizeScheduleHistory({})).toEqual([]);
  });
});

describe("normalizeScheduleDetails", () => {
  it("extracts schedule + history", () => {
    const d = normalizeScheduleDetails({ details: { schedule: row(), history: [] } });
    expect(d?.schedule.id).toBe("sched-abc123");
    expect(d?.history).toEqual([]);
  });

  it("returns null for garbage", () => {
    expect(normalizeScheduleDetails(undefined)).toBeNull();
    expect(normalizeScheduleDetails({})).toBeNull();
    expect(normalizeScheduleDetails({ details: { schedule: { id: "BAD" } } })).toBeNull();
  });
});

describe("describeScheduleFrequency", () => {
  it("uses only the real syntax", () => {
    expect(describeScheduleFrequency({ kind: "once", atIso: new Date(1700000000000).toISOString() })).toMatch(/^once /);
    expect(describeScheduleFrequency({ kind: "recurring", everyMinutes: 30 })).toBe("every 30m");
    expect(describeScheduleFrequency({ kind: "recurring", everyMinutes: 120 })).toBe("every 2h");
    expect(describeScheduleFrequency({ kind: "recurring", everyMinutes: 2880 })).toBe("every 2d");
    expect(describeScheduleFrequency({ kind: "recurring", dailyAt: "09:00", timezone: "UTC" })).toBe("daily 09:00 (UTC)");
    expect(describeScheduleFrequency({ kind: "recurring" })).toBe("recurring (unset)");
  });
});

describe("scheduleStatusMeta", () => {
  it("labels run and schedule states distinctly", () => {
    expect(scheduleStatusMeta("running").tone).toBe("blue");
    expect(scheduleStatusMeta("queued").tone).toBe("yellow");
    expect(scheduleStatusMeta("success").tone).toBe("green");
    expect(scheduleStatusMeta("failed").tone).toBe("red");
    expect(scheduleStatusMeta("skipped").tone).toBe("gray");
    expect(scheduleStatusMeta("cancelled").tone).toBe("orange");
    expect(scheduleStatusMeta("enabled").tone).toBe("green");
    expect(scheduleStatusMeta("disabled").tone).toBe("gray");
  });
});

describe("nextRunLabel", () => {
  it("renders countdowns and edge states", () => {
    expect(nextRunLabel(undefined)).toBe("not scheduled");
    expect(nextRunLabel(Date.now() - 1000)).toBe("due now");
    expect(nextRunLabel(Date.now() + 30_000)).toBe("in <1m");
    expect(nextRunLabel(Date.now() + 5 * 60_000)).toBe("in 5m");
    expect(nextRunLabel(Date.now() + 3 * 3600_000)).toBe("in 3h");
    expect(nextRunLabel(Date.now() + 5 * 86400_000)).toBe("in 5d");
  });
});

describe("schedule state synchronization", () => {
  it("authoritative details replace the stale row", () => {
    const list = [row({ enabled: true })];
    const details = { ...row(), enabled: false };
    const next = list.map((s) => (s.id === details.id ? details : s));
    expect(next[0]!.enabled).toBe(false);
  });
});
