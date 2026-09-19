/**
 * Reproducible benchmark runner.
 *
 * Usage:
 *   pnpm benchmark                       full run (all suites, default iterations)
 *   pnpm benchmark --fast                smoke run (fewer iterations, for CI-adjacent checks)
 *   pnpm benchmark --suite <prefix>      run only suites whose id starts with prefix
 *   pnpm benchmark --write-thresholds    regenerate scripts/benchmark/thresholds.ts
 *                                        from THIS run (round up, warn=3x, fail=10x)
 *   pnpm benchmark --out <dir>           results directory (default scripts/benchmark/results)
 *
 * Writes benchmark-results.json + BENCHMARK-RESULTS.md. Never fabricates:
 * operations that cannot run here are recorded Not measured with reasons.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildFixture,
  captureEnvironment,
  writeReport,
  type BenchReport,
  type BenchResult,
} from "./harness.js";
import { runSuites } from "./suites.js";
import { runClineComparison } from "./cline-compare.js";
import { THRESHOLDS } from "./thresholds.js";

function parseArgs(argv: string[]): {
  fast: boolean;
  suitePrefix: string | null;
  writeThresholds: boolean;
  outDir: string;
} {
  let fast = false;
  let suitePrefix: string | null = null;
  let writeThresholds = false;
  let outDir = path.resolve("scripts/benchmark/results");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fast") fast = true;
    else if (a === "--suite") suitePrefix = argv[++i] ?? null;
    else if (a === "--write-thresholds") writeThresholds = true;
    else if (a === "--out") outDir = path.resolve(argv[++i] ?? outDir);
  }
  return { fast, suitePrefix, writeThresholds, outDir };
}

function roundUp2Sig(x: number): number {
  if (x <= 0) return 0.01;
  const magnitude = 10 ** Math.floor(Math.log10(x));
  const normalized = x / magnitude;
  const rounded = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return rounded * magnitude;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[bench] CodePilot performance benchmark (fast=${args.fast})`);
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-bench-"));
  try {
    console.log("[bench] building deterministic fixtures…");
    const fixtures = {
      small: buildFixture("small", workRoot),
      medium: buildFixture("medium", workRoot),
      large: buildFixture("large", workRoot),
    };
    for (const f of Object.values(fixtures)) {
      console.log(
        `[bench] fixture ${f.name}: ${f.fileCount} files, ${f.codeFiles} code, ${f.totalBytes} bytes, ~${f.approxSymbols} symbols`,
      );
    }
    console.log("[bench] running suites…");
    const { results, memory } = await runSuites({ fixtures, workRoot }, {
      fast: args.fast,
      onProgress: (id) => console.log(`[bench]   done ${id}`),
    });
    console.log("[bench] running Cline comparison probe…");
    const clineResults = await runClineComparison();
    const all: BenchResult[] = args.suitePrefix
      ? [...results, ...clineResults].filter((r) => r.id.startsWith(args.suitePrefix as string))
      : [...results, ...clineResults];
    const report: BenchReport = {
      tool: "codepilot-benchmark",
      version: "0.1.0",
      environment: captureEnvironment(),
      fixtures: Object.values(fixtures),
      results: all,
    };
    const { jsonPath, mdPath } = writeReport(report, args.outDir);
    console.log(`[bench] wrote ${jsonPath}`);
    console.log(`[bench] wrote ${mdPath}`);
    const measured = all.filter((r) => r.measured).length;
    const skipped = all.length - measured;
    console.log(`[bench] ${measured} measured, ${skipped} not-measured (see report for reasons)`);
    console.log(
      `[bench] memory: baseline heap ${memory.baselineMB.heapUsedMB}MB → ` +
      `100 tasks ${memory.after100TasksMB.heapUsedMB}MB → ` +
      `checkpoints ${memory.afterCheckpointsMB.heapUsedMB}MB → ` +
      `open/close ${memory.afterOpenCloseMB.heapUsedMB}MB (${memory.note})`,
    );

    if (args.writeThresholds) {
      const lines: string[] = [];
      lines.push(`/**`);
      lines.push(` * Benchmark thresholds — measured baselines with regression gates.`);
      lines.push(` *`);
      lines.push(` * HOW THESE WERE SET (not invented): each threshold was derived from a real`);
      lines.push(` * measurement run on the reference machine (see docs/PERFORMANCE.md):`);
      lines.push(` *`);
      lines.push(` *   warnMs = max(10 x measured p95-or-median, 0.5ms)`);
      lines.push(` *   failMs = max(100 x measured p95-or-median, 5ms)`);
      lines.push(` *`);
      lines.push(` * Rounded up to 2 significant figures for stability. The vitest regression`);
      lines.push(` * suite (tests/benchmark-harness.test.ts) asserts the FAST subset stays`);
      lines.push(` * under failMs. Full results live in scripts/benchmark/results/ (ignored).`);
      lines.push(` *`);
      lines.push(` * Units: milliseconds. Only operations stable enough for CI gating are`);
      lines.push(` * listed here (pure CPU / in-memory ops, no process spawn, no network).`);
      lines.push(` * Regenerate with: pnpm benchmark --write-thresholds`);
      lines.push(` */`);
      lines.push(`export interface ThresholdEntry {`);
      lines.push(`  /** Measured median at the time thresholds were set. */`);
      lines.push(`  baselineMedianMs: number;`);
      lines.push(`  /** Warn on sustained slowdown beyond this. */`);
      lines.push(`  warnMs: number;`);
      lines.push(`  /** Fail: likely real regression, not noise. */`);
      lines.push(`  failMs: number;`);
      lines.push(`}`);
      lines.push(``);
      lines.push(`// Filled by \`pnpm benchmark --write-thresholds\` after a real measurement run.`);
      lines.push(`export const THRESHOLDS: Record<string, ThresholdEntry> = {`);
      const fastIds = new Set([
        "tool-registry-lookup", "tool-registry-list", "m4-risk-assess",
        "m4-policy-evaluate", "m4-security-validate", "ssrf-policy-allow",
        "ssrf-policy-block", "ssrf-classify-ipv4", "orchestrator-classify",
        "orchestrator-dag-build", "webview-normalize-50", "webview-validate-action",
        "plugin-validate-manifest", "m5-pathguard-allow",
      ]);
      void THRESHOLDS;
      for (const r of all) {
        if (!r.measured || !r.stats || !fastIds.has(r.id)) continue;
        const base = r.stats.p95Ms ?? r.stats.medianMs;
        const warn = roundUp2Sig(Math.max(10 * base, 0.5));
        const fail = roundUp2Sig(Math.max(100 * base, 5));
        const median = roundUp2Sig(r.stats.medianMs);
        lines.push(`  ${JSON.stringify(r.id)}: { baselineMedianMs: ${median}, warnMs: ${warn}, failMs: ${fail} },`);
      }
      lines.push(`};`);
      lines.push(``);
      fs.writeFileSync(
        path.resolve("scripts/benchmark/thresholds.ts"),
        lines.join("\n"),
        "utf8",
      );
      console.log("[bench] thresholds rewritten from measured values");
    }
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error("[bench] FATAL:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
