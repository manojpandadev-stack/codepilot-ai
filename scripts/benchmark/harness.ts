/**
 * Benchmark harness: monotonic clocks, robust statistics, deterministic
 * fixtures, environment capture, and report writers.
 *
 * Honesty rules enforced here (not just documented):
 * - p99 is reported ONLY when n >= 100; p95 only when n >= 20. Otherwise
 *   the field is null (never extrapolated).
 * - Every result records iteration counts, fixture stats, and environment.
 * - Cold measurements run in a FRESH child process per iteration so JIT and
 *   module-cache warmth cannot leak in; warm measurements reuse one process.
 */
import { performance } from "node:perf_hooks";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export interface BenchStats {
  samples: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  medianMs: number;
  /** null unless samples >= 20. */
  p95Ms: number | null;
  /** null unless samples >= 100. */
  p99Ms: number | null;
  stddevMs: number;
}

export function computeStats(durationsMs: number[]): BenchStats {
  const samples = durationsMs.length;
  if (samples === 0) {
    throw new Error("computeStats: no samples");
  }
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const minMs = sorted[0]!;
  const maxMs = sorted[sorted.length - 1]!;
  const meanMs = sorted.reduce((a, b) => a + b, 0) / samples;
  const mid = Math.floor(samples / 2);
  const medianMs =
    samples % 2 === 1
      ? sorted[mid]!
      : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const at = (q: number): number => sorted[Math.min(samples - 1, Math.ceil(q * samples) - 1)]!;
  const variance =
    sorted.reduce((acc, v) => acc + (v - meanMs) ** 2, 0) / samples;
  return {
    samples,
    minMs,
    maxMs,
    meanMs,
    medianMs,
    p95Ms: samples >= 20 ? at(0.95) : null,
    p99Ms: samples >= 100 ? at(0.99) : null,
    stddevMs: Math.sqrt(variance),
  };
}

export interface MeasureOptions {
  warmup?: number;
  iterations?: number;
  /** Optional per-iteration setup run BEFORE the clock starts. */
  setup?: () => void | Promise<void>;
  /** Optional per-iteration teardown run AFTER the clock stops. */
  teardown?: () => void | Promise<void>;
  /** Abort remaining iterations when a single iteration exceeds this. */
  timeoutMs?: number;
}

/** Time an async/sync fn with warmup + measured iterations. */
export async function measure(
  fn: () => void | Promise<void>,
  options: MeasureOptions = {},
): Promise<{ stats: BenchStats; timedOut: boolean }> {
  const warmup = options.warmup ?? 5;
  const iterations = options.iterations ?? 20;
  for (let i = 0; i < warmup; i++) {
    await options.setup?.();
    await fn();
    await options.teardown?.();
  }
  const samples: number[] = [];
  let timedOut = false;
  for (let i = 0; i < iterations; i++) {
    await options.setup?.();
    const t0 = performance.now();
    await fn();
    const dt = performance.now() - t0;
    await options.teardown?.();
    samples.push(dt);
    if (options.timeoutMs !== undefined && dt > options.timeoutMs) {
      timedOut = true;
      break;
    }
  }
  return { stats: computeStats(samples), timedOut };
}

/**
 * Wall-clock import cost inside a FRESH child process.
 *
 * The child runs tsx (startup excluded from the window: timing starts inside
 * the child right before import) against package SOURCE entries, because
 * some workspace packages ship TypeScript sources as their entry point
 * (e.g. changeset-engine has no dist build). Each iteration is a new OS
 * process, so JIT and module-cache warmth cannot leak across samples.
 *
 * Caveat (stated in results): the number INCLUDES tsx on-the-fly
 * transpilation, so it is an UPPER BOUND on production cold load, which
 * uses prebuilt dist output.
 */
export function measureColdImport(
  absoluteSourcePath: string,
  iterations = 10,
): BenchStats {
  const samples: number[] = [];
  const fileUrl = pathToFileURL(absoluteSourcePath).href;
  const probeFile = path.join(path.resolve("scripts/benchmark"), "cold-probe.ts");
  for (let i = 0; i < iterations; i++) {
    // pnpm exec resolves tsx from this repo; tsconfig paths map workspace
    // packages to source so no dist build is required for the probe.
    // NOTE: shell:true so the Windows pnpm shim resolves. The target travels
    // as an argv (no shell quoting of code); timing happens inside the child,
    // so shell + loader startup are out of the measured window.
    const res = spawnSync(
      `pnpm exec tsx --tsconfig scripts/benchmark/tsconfig.json ${probeFile} ${fileUrl}`,
      { encoding: "utf8", timeout: 120_000, cwd: path.resolve("."), shell: true },
    );
    if (res.status !== 0) {
      throw new Error(
        `cold import probe failed for ${absoluteSourcePath}: ${((res.stderr ?? "") as string).slice(0, 500)}`,
      );
    }
    const ms = Number(((res.stdout ?? "") as string).trim().split("\n").pop());
    if (!Number.isFinite(ms)) {
      throw new Error(`cold import probe produced no timing for ${absoluteSourcePath}`);
    }
    samples.push(ms);
  }
  return computeStats(samples);
}

// ============================================================================
// Environment
// ============================================================================

export interface BenchEnvironment {
  nodeVersion: string;
  platform: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  totalMemMB: number;
  typescriptVersion: string;
  recordedAt: string;
}

export function captureEnvironment(): BenchEnvironment {
  const cpus = os.cpus();
  let typescriptVersion = "unknown";
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("typescript/package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    typescriptVersion = pkg.version ?? "unknown";
  } catch {
    // best effort
  }
  return {
    nodeVersion: process.version,
    platform: os.platform(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model ?? "unknown",
    cpuCount: cpus.length,
    totalMemMB: Math.round(os.totalmem() / (1024 * 1024)),
    typescriptVersion,
    recordedAt: new Date().toISOString(),
  };
}

// ============================================================================
// Deterministic fixtures (seeded PRNG — no Date.now/Math.random in bodies)
// ============================================================================

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IDENTIFIERS = [
  "config", "handler", "service", "manager", "runner", "store",
  "index", "cache", "pipeline", "worker", "client", "server",
  "parser", "writer", "reader", "builder", "helper", "util",
];

export interface FixtureStats {
  name: "small" | "medium" | "large";
  root: string;
  fileCount: number;
  totalBytes: number;
  codeFiles: number;
  approxSymbols: number;
  approxImports: number;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function lower(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function renderTsModule(rand: () => number, moduleName: string, lines: number): string {
  const out: string[] = [
    `/** Generated deterministic fixture module ${moduleName}. */`,
  ];
  const nFns = Math.max(1, Math.floor(lines / 25));
  for (let i = 0; i < nFns; i++) {
    const id = IDENTIFIERS[Math.floor(rand() * IDENTIFIERS.length)];
    out.push(`import { ${id}Config } from "./${id}.js";`);
    out.push(`export interface ${cap(moduleName)}Options${i} {`);
    out.push(`  ${id}: ${id}Config;`);
    out.push(`  retries: number;`);
    out.push(`}`);
    out.push(`export function ${lower(moduleName)}Run${i}(options: ${cap(moduleName)}Options${i}): string {`);
    for (let l = 0; l < Math.min(lines, 12); l++) {
      out.push(`  const value${l} = options.retries * ${l + 1} + ${Math.floor(rand() * 1000)};`);
    }
    out.push(`  return \`${moduleName}-${i}-\${value0}\`;`);
    out.push(`}`);
    out.push(`export class ${cap(moduleName)}Service${i} {`);
    out.push(`  execute(input: string): string { return ${lower(moduleName)}Run${i}({ ${id}: {} as ${id}Config, retries: 1 }) + input; }`);
    out.push(`}`);
  }
  return out.join("\n") + "\n";
}

function renderJson(rand: () => number): string {
  const entries: Record<string, unknown> = {};
  for (let i = 0; i < 12; i++) {
    entries[`key_${i}`] = { enabled: rand() > 0.5, weight: Math.floor(rand() * 100), label: `fixture-${i}` };
  }
  return JSON.stringify(entries, null, 2);
}

/**
 * Build a deterministic fixture tree. Returns stats; content is a pure
 * function of (name, seed) — verified by the determinism test.
 */
export function buildFixture(
  name: "small" | "medium" | "large",
  parentDir: string,
  seed = 0xc0de,
): FixtureStats {
  const spec =
    name === "small"
      ? { packages: 1, modulesPerPackage: 10, linesPerModule: 20, jsonFiles: 2 }
      : name === "medium"
        ? { packages: 6, modulesPerPackage: 30, linesPerModule: 40, jsonFiles: 12 }
        : { packages: 12, modulesPerPackage: 140, linesPerModule: 45, jsonFiles: 40 };
  const rand = mulberry32(seed + name.length * 7919);
  const root = path.join(parentDir, `fixture-${name}`);
  fs.rmSync(root, { recursive: true, force: true });
  let fileCount = 0;
  let totalBytes = 0;
  let codeFiles = 0;
  let approxSymbols = 0;
  let approxImports = 0;
  const write = (rel: string, content: string): void => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    fileCount += 1;
    totalBytes += Buffer.byteLength(content, "utf8");
    if (rel.endsWith(".ts")) {
      codeFiles += 1;
      approxSymbols += (content.match(/^export (function|class|interface)/gm) ?? []).length;
      approxImports += (content.match(/^import /gm) ?? []).length;
    }
  };
  for (let p = 0; p < spec.packages; p++) {
    const pkg = `pkg-${p}`;
    for (let m = 0; m < spec.modulesPerPackage; m++) {
      const modName = `module-${m}`;
      const body = renderTsModule(rand, modName, spec.linesPerModule);
      write(path.join(pkg, "src", `${modName}.ts`), body);
    }
    write(path.join(pkg, "package.json"), JSON.stringify({ name: `@fixture/${pkg}`, version: "1.0.0" }, null, 2));
  }
  for (let j = 0; j < spec.jsonFiles; j++) {
    write(`config-${j}.json`, renderJson(rand));
  }
  write("README.md", `# ${name} fixture\nDeterministic benchmark fixture.\n`);
  return { name, root, fileCount, totalBytes, codeFiles, approxSymbols, approxImports };
}

// ============================================================================
// Memory helpers
// ============================================================================

export interface MemorySample {
  heapUsedMB: number;
  heapTotalMB: number;
  rssMB: number;
  externalMB: number;
}

export function sampleMemory(): MemorySample {
  const m = process.memoryUsage();
  const mb = (b: number): number => Math.round((b / (1024 * 1024)) * 100) / 100;
  return { heapUsedMB: mb(m.heapUsed), heapTotalMB: mb(m.heapTotal), rssMB: mb(m.rss), externalMB: mb(m.external) };
}

// ============================================================================
// Report model + writers
// ============================================================================

export interface BenchResult {
  id: string;
  category: string;
  operation: string;
  warmth: "cold" | "warm" | "single";
  stats: BenchStats | null;
  fixture?: string;
  unit: string;
  notes: string;
  /** false when the op could not run in this environment (never fake). */
  measured: boolean;
  notMeasuredReason?: string;
  correctness?: string;
  timedOut?: boolean;
}

export interface BenchReport {
  tool: string;
  version: string;
  environment: BenchEnvironment;
  fixtures: FixtureStats[];
  results: BenchResult[];
}

export function writeReport(report: BenchReport, outDir: string): { jsonPath: string; mdPath: string } {
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "benchmark-results.json");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  const mdPath = path.join(outDir, "BENCHMARK-RESULTS.md");
  fs.writeFileSync(mdPath, renderMarkdown(report), "utf8");
  return { jsonPath, mdPath };
}

function fmtMs(v: number | null): string {
  if (v === null) return "n/a (insufficient samples)";
  if (v < 1) return `${v.toFixed(3)} ms`;
  if (v < 1000) return `${v.toFixed(2)} ms`;
  return `${(v / 1000).toFixed(2)} s`;
}

function renderMarkdown(report: BenchReport): string {
  const lines: string[] = [];
  lines.push(`# CodePilot Benchmark Results`);
  lines.push(``);
  lines.push(`Generated: ${report.environment.recordedAt}`);
  lines.push(
    `Env: Node ${report.environment.nodeVersion} · TS ${report.environment.typescriptVersion} · ` +
    `${report.environment.platform}/${report.environment.arch} · ` +
    `${report.environment.cpuModel} × ${report.environment.cpuCount} · ` +
    `${report.environment.totalMemMB} MB RAM`,
  );
  lines.push(``);
  lines.push(`## Fixtures`);
  lines.push(``);
  lines.push(`| Fixture | Files | Code files | Bytes | Approx symbols | Approx imports |`);
  lines.push(`| --- | --- | --- | --- | --- | --- |`);
  for (const f of report.fixtures) {
    lines.push(
      `| ${f.name} | ${f.fileCount} | ${f.codeFiles} | ${f.totalBytes} | ${f.approxSymbols} | ${f.approxImports} |`,
    );
  }
  lines.push(``);
  lines.push(`## Results`);
  lines.push(``);
  lines.push(`| Operation | Warmth | Median | p95 | p99 | Min | Max | Samples | Notes |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const r of report.results) {
    if (!r.measured || !r.stats) {
      lines.push(`| ${r.operation} | ${r.warmth} | NOT MEASURED | — | — | — | — | 0 | ${r.notMeasuredReason ?? ""} |`);
      continue;
    }
    const s = r.stats;
    lines.push(
      `| ${r.operation} | ${r.warmth} | ${fmtMs(s.medianMs)} | ${fmtMs(s.p95Ms)} | ${fmtMs(s.p99Ms)} | ` +
      `${fmtMs(s.minMs)} | ${fmtMs(s.maxMs)} | ${s.samples} | ${r.notes} |`,
    );
  }
  lines.push(``);
  lines.push(`Percentile policy: p95 requires ≥20 samples, p99 requires ≥100 samples; otherwise null (never extrapolated).`);
  return lines.join("\n");
}
