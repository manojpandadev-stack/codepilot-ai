/**
 * Cline comparison probe — bounded, honest, and explicit about limits.
 *
 * Policy (per milestone §10/§16):
 * - Same hardware/OS/Node (same machine, same process tree).
 * - Only operations with a REAL equivalent on both sides are compared.
 * - Anything needing model inference, servers, or the VS Code host is
 *   reported "Not measured" — never estimated, never inferred.
 *
 * What is actually comparable without inference:
 *  1. Tool-definition authoring cost: Cline `createTool` vs a CodePilot
 *     ToolDefinition object literal (both trivial constructors).
 *  2. SDK initialization: ClineCore.create (local backend, bounded timeout)
 *     vs CodePilotRuntime construction. These are NOT equivalent operations
 *     (ClineCore boots a full core; CodePilotRuntime construction does not),
 *     so the result is reported side-by-side as NOT COMPARABLE unless both
 *     complete — with the asymmetry stated, never a speedup claim.
 */
import { performance } from "node:perf_hooks";
import { measure, type BenchResult } from "./harness.js";

function notMeasured(operation: string, reason: string): BenchResult {
  return {
    id: `cline-${operation.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    category: "cline-comparison",
    operation,
    warmth: "single",
    stats: null,
    unit: "ms",
    notes: "Not measured.",
    measured: false,
    notMeasuredReason: reason,
  };
}

export async function runClineComparison(): Promise<BenchResult[]> {
  const results: BenchResult[] = [];

  // 1. Tool-definition authoring cost (both sides trivial, no I/O).
  try {
    const { createTool } = await import("@cline/agents");
    const { stats } = await measure(() => {
      const tool = createTool({
        name: "bench_tool",
        description: "benchmark probe tool",
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
        execute: async () => ({ ok: true }),
      });
      if (!tool || typeof tool.name !== "string") throw new Error("bad tool");
    }, { warmup: 5, iterations: 50 });
    results.push({
      id: "cline-create-tool",
      category: "cline-comparison",
      operation: "Cline createTool definition cost",
      warmth: "warm",
      stats,
      unit: "ms",
      notes: "Definition authoring only. Compare against CodePilot trivial-ToolDefinition literal cost qualitatively only — different schemas, NOT a product comparison.",
      measured: true,
      correctness: "asserted",
    });
  } catch (err) {
    results.push(notMeasured(
      "Cline createTool",
      `Could not load @cline/agents here: ${err instanceof Error ? err.message : String(err)}`,
    ));
  }

  // 2. SDK initialization (bounded; asymmetry stated, never a verdict).
  try {
    const { ClineCore } = await import("@cline/core");
    const t0 = performance.now();
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("ClineCore.create exceeded 25s budget")), 25_000),
    );
    const core = await Promise.race([
      ClineCore.create({ clientName: "codepilot-bench", backendMode: "local" }),
      timeout,
    ]);
    const dt = performance.now() - t0;
    await core.dispose().catch(() => undefined);
    results.push({
      id: "cline-core-create",
      category: "cline-comparison",
      operation: "ClineCore.create (local backend) single sample",
      warmth: "single",
      stats: {
        samples: 1, minMs: dt, maxMs: dt, meanMs: dt, medianMs: dt,
        p95Ms: null, p99Ms: null, stddevMs: 0,
      },
      unit: "ms",
      notes: "NOT COMPARABLE to CodePilotRuntime construction (ClineCore boots a full core incl. provider probing; CodePilot construction does not). Reported side-by-side only; no speedup claim.",
      measured: true,
      correctness: "asserted",
    });
  } catch (err) {
    results.push(notMeasured(
      "ClineCore.create",
      `Did not complete in-bounds here: ${err instanceof Error ? err.message : String(err)}`,
    ));
  }

  // 3. Everything inference-dependent: explicitly not measured.
  for (const operation of [
    "Cline coding-task completion (any task)",
    "Cline vs CodePilot wall-clock task comparison",
    "Cline tool-execution latency under a live model",
  ]) {
    results.push(notMeasured(
      operation,
      "Requires live model inference: nondeterministic, minutes per sample, and Ollama-backed runs are not reproducible baselines. No numeric comparison is reported.",
    ));
  }
  return results;
}
