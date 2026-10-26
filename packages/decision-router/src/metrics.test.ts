import { describe, expect, it } from "vitest";
import { RoutingMetrics } from "./metrics.js";

describe("routing metrics", () => {
  it("accumulates counters and latency without contents", () => {
    const m = new RoutingMetrics();
    m.record("jev-success", 120);
    m.record("jev-uncertain", 40);
    m.record("fallback", 2);
    m.record("timeout", 8000);
    m.record("cancelled", 5);
    const s = m.summary();
    expect(s.attempts).toBe(5);
    expect(s.jevSuccess).toBe(1);
    expect(s.jevUncertain).toBe(1);
    expect(s.fallbackUsed).toBe(1);
    expect(s.timeouts).toBe(1);
    expect(s.cancelled).toBe(1);
    expect(s.totalLatencyMs).toBe(8167);
    expect(s.maxLatencyMs).toBe(8000);
    expect(m.averageLatencyMs()).toBeCloseTo(1633.4, 1);
    // Content-free by construction: no prompt, file, or secret fields exist.
    expect(JSON.stringify(s)).not.toMatch(/prompt|text|secret|key/i);
  });

  it("returns isolated copies", () => {
    const m = new RoutingMetrics();
    m.record("fallback", 3);
    const a = m.summary();
    a.attempts = 999;
    expect(m.summary().attempts).toBe(1);
  });

  it("averages zero with no attempts", () => {
    expect(new RoutingMetrics().averageLatencyMs()).toBe(0);
  });
});
