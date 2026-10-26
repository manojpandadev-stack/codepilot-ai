/**
 * CodePilot AI — Jev decision routing: cost/latency telemetry.
 *
 * Counts classification attempts, Jev successes, fallbacks, timeouts, and
 * cancellations, plus latency totals. Records NO prompt contents, NO file
 * contents, NO workspace metadata, and NO secrets — counters only.
 */
export type RoutingMetricKind =
  "jev-success" | "jev-uncertain" | "fallback" | "timeout" | "cancelled";

export interface RoutingMetricsSnapshot {
  attempts: number;
  jevSuccess: number;
  jevUncertain: number;
  fallbackUsed: number;
  timeouts: number;
  cancelled: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
}

export function emptyRoutingMetrics(): RoutingMetricsSnapshot {
  return {
    attempts: 0,
    jevSuccess: 0,
    jevUncertain: 0,
    fallbackUsed: 0,
    timeouts: 0,
    cancelled: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
  };
}

export class RoutingMetrics {
  private snapshot: RoutingMetricsSnapshot = emptyRoutingMetrics();

  record(kind: RoutingMetricKind, latencyMs: number): void {
    const latency = Math.max(0, Math.floor(latencyMs));
    this.snapshot.attempts += 1;
    this.snapshot.totalLatencyMs += latency;
    if (latency > this.snapshot.maxLatencyMs) {
      this.snapshot.maxLatencyMs = latency;
    }
    switch (kind) {
      case "jev-success":
        this.snapshot.jevSuccess += 1;
        break;
      case "jev-uncertain":
        this.snapshot.jevUncertain += 1;
        break;
      case "fallback":
        this.snapshot.fallbackUsed += 1;
        break;
      case "timeout":
        this.snapshot.timeouts += 1;
        break;
      case "cancelled":
        this.snapshot.cancelled += 1;
        break;
    }
  }

  /** A copy of the counters (safe to log and display). */
  summary(): RoutingMetricsSnapshot {
    return { ...this.snapshot };
  }

  /** Average classification latency in milliseconds (0 when no attempts). */
  averageLatencyMs(): number {
    if (this.snapshot.attempts === 0) return 0;
    return this.snapshot.totalLatencyMs / this.snapshot.attempts;
  }
}
