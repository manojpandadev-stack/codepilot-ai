/**
 * M18 — Observability tests: metrics (counters/histograms/gauges,
 * cardinality bounds), structured logger redaction, spans and traces.
 */

import { describe, it, expect } from "vitest";
import {
  MetricsRegistry,
  SpanTracker,
  StructuredLogger,
  createObservability,
  redactLogText,
  redactLogValue,
} from "./observability.js";

function tracerTraceCount(tracker: SpanTracker, correlationId: string): number {
  // Access via public API: run a second tracker only if needed; here we use
  // trace() which filters by correlation id.
  return tracker.trace(correlationId).length;
}

describe("M18 redaction", () => {
  it("redacts common secret shapes in text", () => {
    const input =
      "failed with key sk-abc123def456ghi789xyz and ghp_abcdefghijklmnopqrstuvwxyz012345";
    const out = redactLogText(input);
    expect(out).not.toContain("sk-abc123");
    expect(out).not.toContain("ghp_abcdefghij");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts Bearer tokens and private keys", () => {
    const out = redactLogText(
      "Authorization: Bearer abcdefghijklmnop123456 -----BEGIN RSA PRIVATE KEY----- secret -----END RSA PRIVATE KEY-----",
    );
    expect(out).not.toContain("abcdefghijklmnop123456");
    expect(out).not.toContain("secret");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts secret-named keys in values", () => {
    const out = redactLogValue({ apiKey: "plain-value", note: "safe" });
    expect(out).toEqual({ apiKey: "[REDACTED]", note: "safe" });
  });

  it("keeps ordinary log text intact", () => {
    expect(redactLogText("build completed in 1234ms")).toBe(
      "build completed in 1234ms",
    );
  });
});

describe("M18 MetricsRegistry", () => {
  it("counts increments with labels", () => {
    const metrics = new MetricsRegistry();
    metrics.increment("tool_calls", { tool: "read_file" });
    metrics.increment("tool_calls", { tool: "read_file" });
    metrics.increment("tool_calls", { tool: "terminal" });
    const snapshot = metrics.snapshot();
    const byTool = (tool: string): number =>
      snapshot.counters
        .filter((c) => c.name === "tool_calls" && c.labels.tool === tool)
        .reduce((sum, c) => sum + c.value, 0);
    expect(byTool("read_file")).toBe(2);
    expect(byTool("terminal")).toBe(1);
  });

  it("records histogram percentiles", () => {
    const metrics = new MetricsRegistry();
    for (let i = 1; i <= 100; i++) {
      metrics.observeMs("latency", i);
    }
    const snap = metrics.snapshot();
    const hist = snap.histograms.find((h) => h.name === "latency");
    expect(hist?.count).toBe(100);
    expect(hist?.p50Ms).toBeGreaterThanOrEqual(50);
    expect(hist?.p50Ms).toBeLessThanOrEqual(52);
    expect(hist?.p95Ms).toBeGreaterThanOrEqual(95);
    expect(hist?.maxMs).toBe(100);
  });

  it("sets and reads gauges", () => {
    const metrics = new MetricsRegistry();
    metrics.setGauge("active_tasks", 3);
    metrics.setGauge("active_tasks", 2);
    const snap = metrics.snapshot();
    expect(snap.gauges.find((g) => g.name === "active_tasks")?.value).toBe(2);
  });

  it("enforces bounded series cardinality", () => {
    const metrics = new MetricsRegistry();
    for (let i = 0; i < 600; i++) {
      metrics.increment("events", { user: `u${i}` });
    }
    expect(metrics.snapshot().counters).toHaveLength(500);
  });

  it("reset clears everything", () => {
    const metrics = new MetricsRegistry();
    metrics.increment("a");
    metrics.reset();
    expect(metrics.snapshot().counters).toEqual([]);
  });
});

describe("M18 StructuredLogger", () => {
  it("filters below the configured level", () => {
    let sinkCalls = 0;
    const logger = new StructuredLogger({
      level: "warn",
      sink: () => {
        sinkCalls += 1;
      },
    });
    logger.debug("nope");
    logger.info("nope");
    logger.warn("yes");
    logger.error("yes");
    expect(sinkCalls).toBe(2);
  });

  it("redacts secrets in messages and fields before sinking", () => {
    const sunk: string[] = [];
    const logger = new StructuredLogger({
      sink: (record) => {
        sunk.push(JSON.stringify(record));
      },
    });
    logger.info("using key sk-abc123def456ghi789xyz", { password: "hunter2" });
    const line = sunk[0] ?? "";
    expect(line).not.toContain("sk-abc123def456ghi789xyz");
    expect(line).not.toContain("hunter2");
  });

  it("keeps a ring buffer and correlation queries", () => {
    const logger = new StructuredLogger({
      sink: (): void => undefined,
      bufferSize: 10,
    });
    logger.info("a", undefined, "task-1");
    logger.info("b", undefined, "task-2");
    logger.info("c", undefined, "task-1");
    expect(logger.forCorrelation("task-1")).toHaveLength(2);
    expect(logger.recent(3)).toHaveLength(3);
  });
});

describe("M18 SpanTracker", () => {
  it("tracks spans with parent-child correlation", () => {
    const tracker = new SpanTracker();
    const parent = tracker.startSpan("task", { correlationId: "task-9" });
    const child = tracker.startSpan("tool.read", {
      correlationId: "task-9",
      parentSpanId: parent.spanId,
    });
    tracker.endSpan(child, "ok");
    tracker.endSpan(parent, "ok");
    const trace = tracker.trace("task-9");
    // Completion order: child first (it ended first).
    expect(trace.map((s) => s.name)).toEqual(["tool.read", "task"]);
    const childSpan = trace.find((s) => s.name === "tool.read");
    const parentSpan = trace.find((s) => s.name === "task");
    expect(childSpan?.parentSpanId).toBe(parentSpan?.spanId);
  });

  it("marks error spans and computes latency", async () => {
    const tracker = new SpanTracker();
    const span = tracker.startSpan("model.request");
    await new Promise((r) => setTimeout(r, 15));
    tracker.endSpan(span, "error");
    const stats = tracker.latencyByName().get("model.request");
    expect(stats?.count).toBe(1);
    expect(stats?.avgMs).toBeGreaterThanOrEqual(10);
  });

  it("ignores double-end", () => {
    const tracker = new SpanTracker();
    const span = tracker.startSpan("x", { correlationId: "double-end" });
    tracker.endSpan(span, "ok");
    tracker.endSpan(span, "error");
    expect(tracerTraceCount(tracker, "double-end")).toBe(1);
  });
});

describe("M18 createObservability", () => {
  it("creates an independent bundle wired together", () => {
    const obs = createObservability({ level: "debug", sink: () => {} });
    const span = obs.spans.startSpan("ctx.retrieve", { correlationId: "t" });
    obs.metrics.observeMs("ctx.retrieve.ms", 12);
    obs.spans.endSpan(span, "ok");
    obs.logger.info("retrieved context", { files: 3 }, "t");
    expect(obs.metrics.snapshot().histograms[0]?.count).toBe(1);
    expect(obs.spans.trace("t")).toHaveLength(1);
    expect(obs.logger.forCorrelation("t")).toHaveLength(1);
  });
});
