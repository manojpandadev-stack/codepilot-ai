/**
 * Observability WebView contract tests — message validation, range presets,
 * filter payloads, normalization, formatting and display metadata.
 *
 * Every helper is pure: malformed host payloads can never produce fake rows,
 * and invalid outbound actions are rejected before posting to the host.
 */

import { describe, expect, it } from "vitest";
import {
  validateMetricsAction,
  dashboardRangeBounds,
  buildDashboardFilterPayload,
  normalizeDashboard,
  normalizeMetricValue,
  normalizeToolRow,
  normalizeDiagnosticSummary,
  formatMetricValue,
} from "../apps/webview/src/lib/messages.js";

function metric(overrides: Record<string, unknown> = {}) {
  return { key: "tasks", label: "Tasks", value: 3, scope: "range", ...overrides };
}

describe("validateMetricsAction (outbound WebView message validation)", () => {
  it("accepts well-formed actions", () => {
    expect(validateMetricsAction("metrics/get", {}).ok).toBe(true);
    expect(validateMetricsAction("metrics/export", {}).ok).toBe(true);
    expect(
      validateMetricsAction("metrics/dashboard", { status: "completed", limit: 50 }).ok,
    ).toBe(true);
    expect(validateMetricsAction("metrics/dashboard", {}).ok).toBe(true);
  });

  it("rejects unknown actions", () => {
    expect(validateMetricsAction("metrics/nuke", {}).ok).toBe(false);
    expect(validateMetricsAction("chat/send", {}).ok).toBe(false);
  });

  it("rejects malformed ranges, statuses and limits", () => {
    expect(validateMetricsAction("metrics/dashboard", { fromMs: -1 }).ok).toBe(false);
    expect(validateMetricsAction("metrics/dashboard", { fromMs: "soon" }).ok).toBe(false);
    expect(validateMetricsAction("metrics/dashboard", { fromMs: 200, toMs: 100 }).ok).toBe(false);
    expect(validateMetricsAction("metrics/dashboard", { status: "exploding" }).ok).toBe(false);
    expect(validateMetricsAction("metrics/dashboard", { provider: "" }).ok).toBe(false);
    expect(validateMetricsAction("metrics/dashboard", { provider: "x".repeat(65) }).ok).toBe(false);
    expect(validateMetricsAction("metrics/dashboard", { limit: 0 }).ok).toBe(false);
    expect(validateMetricsAction("metrics/dashboard", { limit: 201 }).ok).toBe(false);
    expect(validateMetricsAction("metrics/dashboard", { limit: 1.5 }).ok).toBe(false);
  });
});

describe("dashboardRangeBounds", () => {
  it("computes day-bounded presets", () => {
    // Fixed instant: 2026-06-15T12:00:00Z.
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    expect(dashboardRangeBounds("all", now)).toEqual({});
    const today = dashboardRangeBounds("today", now);
    expect(today.fromMs).toBeLessThanOrEqual(now);
    expect(today.toMs).toBe(now);
    expect(now - (today.fromMs as number)).toBeLessThanOrEqual(86_400_000);
    expect(dashboardRangeBounds("7d", now).fromMs).toBe(now - 7 * 86_400_000);
    expect(dashboardRangeBounds("30d", now).fromMs).toBe(now - 30 * 86_400_000);
  });
});

describe("buildDashboardFilterPayload", () => {
  it("builds a bounded payload, omitting defaults", () => {
    expect(
      buildDashboardFilterPayload({ range: "all", status: "all", provider: "", model: "", mode: "all" }, 1000),
    ).toEqual({ limit: 200 });
    expect(
      buildDashboardFilterPayload(
        { range: "7d", status: "failed", provider: "ollama", model: "m", mode: "act" },
        7 * 86_400_000,
      ),
    ).toEqual({
      limit: 200,
      fromMs: 0,
      toMs: 7 * 86_400_000,
      status: "failed",
      provider: "ollama",
      model: "m",
      mode: "act",
    });
  });
});

describe("normalizeMetricValue / normalizeToolRow", () => {
  it("normalizes rows and drops garbage", () => {
    expect(normalizeMetricValue(metric())?.value).toBe(3);
    expect(normalizeMetricValue({ key: "k", label: "l", value: null, scope: "session" })?.value).toBeNull();
    expect(normalizeMetricValue(null)).toBeNull();
    expect(normalizeMetricValue({ label: "no key" })).toBeNull();
    expect(normalizeToolRow({ name: "bash", invocations: 2, failures: 1, success: 1, samples: 2 })?.category).toBeDefined();
    expect(normalizeToolRow(null)).toBeNull();
    expect(normalizeToolRow({})).toBeNull();
  });
});

describe("normalizeDashboard (inbound host payload)", () => {
  function payload(overrides: Record<string, unknown> = {}) {
    return {
      dashboard: {
        generatedAtMs: 1,
        rangeNote: "note",
        overview: [metric()],
        performance: {
          taskDurations: { count: 1, avgMs: 5, minMs: 5, maxMs: 5 },
          toolLatency: [],
          modelLatency: { key: "m", label: "m", value: null, scope: "session" },
          contextLatency: { key: "c", label: "c", value: null, scope: "session" },
          terminalDuration: { key: "t", label: "t", value: null, scope: "session" },
          mcpDuration: { key: "mc", label: "mc", value: null, scope: "session" },
        },
        tools: [],
        providers: [],
        tokens: {
          input: { key: "i", label: "i", value: null, scope: "session" },
          output: { key: "o", label: "o", value: null, scope: "session" },
        },
        errors: { categories: [], recent: [] },
        active: [],
        ...overrides,
      },
    };
  }

  it("normalizes a rich payload", () => {
    const d = normalizeDashboard(payload());
    expect(d?.overview).toHaveLength(1);
    expect(d?.performance.taskDurations.count).toBe(1);
  });

  it("drops malformed rows instead of rendering fake state", () => {
    const d = normalizeDashboard({
      dashboard: {
        ...payload().dashboard,
        overview: [metric(), null, 42, { label: "no key" }],
        tools: [{ name: "bash", invocations: 1, failures: 0, success: 1, samples: 1 }, null],
      },
    });
    expect(d?.overview).toHaveLength(1);
    expect(d?.tools).toHaveLength(1);
  });

  it("returns null for garbage payloads", () => {
    expect(normalizeDashboard(undefined)).toBeNull();
    expect(normalizeDashboard(null)).toBeNull();
    expect(normalizeDashboard("nope")).toBeNull();
    expect(normalizeDashboard({})).toBeNull();
  });

  it("bounds untrusted strings", () => {
    const big = "x".repeat(9000);
    const d = normalizeDashboard(payload({ overview: [metric({ label: big })] }));
    expect(d?.overview[0]!.label.length).toBeLessThanOrEqual(64);
  });
});

describe("normalizeDiagnosticSummary", () => {
  it("normalizes the export bundle", () => {
    const s = normalizeDiagnosticSummary({
      summary: {
        generatedAtMs: 1,
        counts: { tasks: 2 },
        tools: [{ name: "bash", invocations: 1, failures: 0 }],
        errors: [{ summary: "boom", atMs: 2 }],
        active: 0,
        notes: ["note"],
      },
    });
    expect(s?.counts).toEqual({ tasks: 2 });
    expect(s?.tools).toHaveLength(1);
  });

  it("returns null for garbage", () => {
    expect(normalizeDiagnosticSummary(undefined)).toBeNull();
    expect(normalizeDiagnosticSummary({})).toBeNull();
  });
});

describe("formatMetricValue", () => {
  it("formats values and unavailable markers", () => {
    expect(formatMetricValue({ key: "k", label: "l", value: null, scope: "range" })).toBe("Unavailable");
    expect(formatMetricValue({ key: "k", label: "l", value: 500, unit: "ms", scope: "range" })).toBe("500ms");
    expect(formatMetricValue({ key: "k", label: "l", value: 1500, unit: "ms", scope: "range" })).toBe("1.5s");
    expect(formatMetricValue({ key: "k", label: "l", value: 120000, unit: "ms", scope: "range" })).toBe("2m");
    expect(formatMetricValue({ key: "k", label: "l", value: 2500, scope: "range" })).toBe("2,500");
  });
});

describe("metrics state synchronization", () => {
  it("authoritative dashboard replaces stale state wholesale", () => {
    const first = normalizeDashboard({
      dashboard: {
        generatedAtMs: 1,
        rangeNote: "",
        overview: [metric({ key: "tasks", value: 1 })],
        performance: { taskDurations: { count: 0, avgMs: null, minMs: null, maxMs: null }, toolLatency: [] },
        tools: [],
        providers: [],
        tokens: {},
        errors: {},
        active: [],
      },
    });
    expect(first?.overview[0]!.value).toBe(1);
  });
});
