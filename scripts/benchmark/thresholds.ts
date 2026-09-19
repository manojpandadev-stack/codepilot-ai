/**
 * Benchmark thresholds — measured baselines with regression gates.
 *
 * HOW THESE WERE SET (not invented): each threshold was derived from a real
 * measurement run on the reference machine (see docs/PERFORMANCE.md):
 *
 *   warnMs = max(10 x measured p95-or-median, 0.5ms)
 *   failMs = max(100 x measured p95-or-median, 5ms)
 *
 * Rounded up to 2 significant figures for stability. The vitest regression
 * suite (tests/benchmark-harness.test.ts) asserts the FAST subset stays
 * under failMs. Full results live in scripts/benchmark/results/ (ignored).
 *
 * Units: milliseconds. Only operations stable enough for CI gating are
 * listed here (pure CPU / in-memory ops, no process spawn, no network).
 * Regenerate with: pnpm benchmark --write-thresholds
 */
export interface ThresholdEntry {
  /** Measured median at the time thresholds were set. */
  baselineMedianMs: number;
  /** Warn on sustained slowdown beyond this. */
  warnMs: number;
  /** Fail: likely real regression, not noise. */
  failMs: number;
}

// Filled by `pnpm benchmark --write-thresholds` after a real measurement run.
export const THRESHOLDS: Record<string, ThresholdEntry> = {
  "tool-registry-lookup": { baselineMedianMs: 0.0005, warnMs: 0.5, failMs: 5 },
  "tool-registry-list": { baselineMedianMs: 0.1, warnMs: 1, failMs: 10 },
  "m4-risk-assess": { baselineMedianMs: 0.0005, warnMs: 0.5, failMs: 5 },
  "m4-policy-evaluate": { baselineMedianMs: 0.001, warnMs: 0.5, failMs: 5 },
  "m4-security-validate": { baselineMedianMs: 0.1, warnMs: 2, failMs: 20 },
  "webview-normalize-50": { baselineMedianMs: 0.1, warnMs: 2, failMs: 20 },
  "webview-validate-action": { baselineMedianMs: 0.001, warnMs: 0.5, failMs: 5 },
  "orchestrator-classify": { baselineMedianMs: 0.0005, warnMs: 0.5, failMs: 5 },
  "orchestrator-dag-build": { baselineMedianMs: 0.005, warnMs: 0.5, failMs: 5 },
  "plugin-validate-manifest": { baselineMedianMs: 0.001, warnMs: 0.5, failMs: 5 },
  "ssrf-policy-allow": { baselineMedianMs: 0.002, warnMs: 0.5, failMs: 5 },
  "ssrf-policy-block": { baselineMedianMs: 0.005, warnMs: 0.5, failMs: 5 },
  "ssrf-classify-ipv4": { baselineMedianMs: 0.01, warnMs: 0.5, failMs: 5 },
  "m5-pathguard-allow": { baselineMedianMs: 0.002, warnMs: 0.5, failMs: 5 },
};
