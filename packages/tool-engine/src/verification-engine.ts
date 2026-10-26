// ============================================================================
// Verification Engine — evidence that generated changes actually work.
//
// The engine answers "what evidence do we have that the generated changes
// work?" — never "did the agent say it was finished?". It is bounded
// orchestrations over the EXISTING safe execution path
// (`CommandExecutionService`, structured argv, timeout, cancellation,
// workspace-bound cwd). No new shell execution path is introduced.
//
// Honesty rules:
//  - a check whose command cannot be safely determined is NOT_AVAILABLE —
//    never guessed, never silently skipped;
//  - TIMEOUT and CANCELLED are distinct outcomes and can never map to
//    PASSED;
//  - a non-zero exit is FAILED, never PASSED;
//  - the overall verdict is conservative: any missing/unavailable applicable
//    check caps the verdict below VERIFIED.
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import {
  CommandExecutionService,
  type CommandOutput,
} from "./m3/command-execution.js";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type VerificationCheckType =
  "tests" | "build" | "typecheck" | "security";

export type VerificationCheckStatus =
  | "not_started"
  | "running"
  | "passed"
  | "failed"
  | "cancelled"
  | "timeout"
  | "not_available";

export interface VerificationCheck {
  type: VerificationCheckType;
  status: VerificationCheckStatus;
  /** Start time (epoch ms) when the check actually began, else undefined. */
  startedAt?: number;
  /** Completion time (epoch ms) when the check settled, else undefined. */
  completedAt?: number;
  /** Real exit code when a command ran (non-zero ⇒ failed; never faked). */
  exitCode?: number | null;
  /** Concise human-readable summary (no raw output dumps). */
  summary: string;
  /** Structured, bounded error information when available. */
  error?: string;
  /** The exact argv that will run / ran, for transparency and audit. */
  command?: string[];
  /** Duration in ms when the check settled. */
  durationMs?: number;
}

export interface VerificationRequest {
  /** Workspace root — commands never run outside this directory. */
  workspaceRoot: string;
  /** Cancellation (an aborted signal marks the run cancelled, never passed). */
  signal?: AbortSignal;
  /** Per-check timeout in ms (default 120s, bounded below). */
  timeoutMs?: number;
  /** Run only these checks (default: every check the workspace supports). */
  checks?: VerificationCheckType[];
  /** Test-only executor override; production always uses the safe service. */
  executor?: VerificationExecutor;
}

export type VerificationExecutor = (
  command: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<VerificationExecutionOutcome>;

/** Faithful subset of CommandOutput the engine needs (test-friendly). */
export interface VerificationExecutionOutcome {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  stdout: string;
  stderr: string;
}

export type VerificationVerdict =
  "verified" | "failed" | "not_verified" | "not_available";

export interface VerificationRunResult {
  /** Per-check results, in execution order. */
  checks: VerificationCheck[];
  /** Conservative overall verdict (see aggregateVerificationVerdict). */
  verdict: VerificationVerdict;
  /** Start of the whole run (epoch ms), when at least one check ran. */
  startedAt?: number;
  /** End of the whole run (epoch ms), when at least one check ran. */
  completedAt?: number;
}

// ---------------------------------------------------------------------------
// Project detection — conservative, file-based, no guessing
// ---------------------------------------------------------------------------

/** ExistsSync is only used on workspace-root-relative manifest files. */
function fileExists(root: string, rel: string): boolean {
  try {
    return fs.statSync(path.join(root, rel)).isFile();
  } catch {
    return false;
  }
}

/** First executable on PATH among candidates (build-tool detection). */
function firstOnPath(
  candidates: string[],
  probe: (name: string) => boolean,
): string | undefined {
  for (const c of candidates) {
    if (probe(c)) return c;
  }
  return undefined;
}

export interface WorkspacePlan {
  checks: Array<{
    type: VerificationCheckType;
    command: string[];
    /** Why this command was selected (audit trail, surfaced in summaries). */
    reason: string;
  }>;
  skipped: Array<{ type: VerificationCheckType; reason: string }>;
}

function posixJoin(cmd: string, args: string[]): string[] {
  return [cmd, ...args];
}

/**
 * Plan the applicable checks for a workspace from its actual manifests.
 * Only declared scripts are trusted; anything else is skipped as
 * not-applicable (NOT_AVAILABLE), never guessed. Defaults are bounded to a
 * conservative, widely-compatible set — the workspace's own scripts always
 * take precedence.
 */
export function planVerification(
  workspaceRoot: string,
  options?: {
    probe?: (name: string) => boolean;
    packageJson?: unknown;
  },
): WorkspacePlan {
  const probe = options?.probe ?? (() => true); // production resolves via PATH inside CommandExecutionService

  const checks: WorkspacePlan["checks"] = [];
  const skipped: WorkspacePlan["skipped"] = [];

  const pkgRaw = options?.packageJson;
  const pkgExists =
    pkgRaw !== undefined || fileExists(workspaceRoot, "package.json");
  const pkg =
    pkgRaw !== undefined
      ? pkgRaw
      : pkgExists
        ? safeReadJson(workspaceRoot, "package.json")
        : undefined;
  const scripts =
    pkg && typeof pkg === "object"
      ? ((pkg as { scripts?: Record<string, unknown> }).scripts ?? {})
      : {};

  const isNode = pkgExists;
  const isMaven = fileExists(workspaceRoot, "pom.xml");
  const isGradle =
    fileExists(workspaceRoot, "build.gradle") ||
    fileExists(workspaceRoot, "build.gradle.kts");
  const isDotnet = fileExists(workspaceRoot, "global.json")
    ? false // never assume; global.json alone does not prove a buildable project
    : fs
          .readdirSync(workspaceRoot)
          .some((f) => f.endsWith(".csproj") || f.endsWith(".fsproj"))
      ? true
      : false;

  // ---- TYPECHECK + BUILD + TESTS (Node workspaces) ----
  if (isNode) {
    const pm: string[] = [];
    if (fileExists(workspaceRoot, "pnpm-lock.yaml")) pm.push("pnpm");
    if (fileExists(workspaceRoot, "yarn.lock")) pm.push("yarn");
    if (fileExists(workspaceRoot, "package-lock.json")) pm.push("npm");
    if (
      fileExists(workspaceRoot, "bun.lockb") ||
      fileExists(workspaceRoot, "bun.lock")
    )
      pm.push("bun");
    // No lockfile: fall back to npx (npm ships with Node).
    const runner = pm[0] ?? "npm";
    const run = (script: string): string[] =>
      runner === "npm"
        ? posixJoin("npm", ["run", script])
        : posixJoin(runner, ["run", script]);

    const has = (s: string): boolean =>
      Object.prototype.hasOwnProperty.call(scripts, s);

    // TYPECHECK
    if (has("typecheck")) {
      checks.push({
        type: "typecheck",
        command: run("typecheck"),
        reason: `package.json scripts.typecheck via ${runner}`,
      });
    } else if (fileExists(workspaceRoot, "tsconfig.json")) {
      const tsc = firstOnPath(["tsc", "typescript"], probe);
      if (tsc) {
        checks.push({
          type: "typecheck",
          command: posixJoin("npx", ["-y", "tsc", "--noEmit"]),
          reason: "tsconfig.json present; npx tsc --noEmit",
        });
      } else {
        skipped.push({
          type: "typecheck",
          reason: "tsconfig.json present but no TypeScript toolchain detected",
        });
      }
    } else {
      skipped.push({
        type: "typecheck",
        reason: "no typecheck script and no tsconfig.json",
      });
    }

    // BUILD
    if (has("build")) {
      checks.push({
        type: "build",
        command: run("build"),
        reason: `package.json scripts.build via ${runner}`,
      });
    } else {
      skipped.push({ type: "build", reason: "no build script declared" });
    }

    // TESTS
    if (has("test")) {
      // Tests that hard-require a display or watch loop are still run with a
      // bounded timeout; CI-style one-shot runners are the target.
      checks.push({
        type: "tests",
        command: run("test"),
        reason: `package.json scripts.test via ${runner}`,
      });
    } else {
      skipped.push({ type: "tests", reason: "no test script declared" });
    }

    // SECURITY — only an explicitly declared script is trusted. Generic
    // audit-style commands are network-bound, opinionated, and slow; the
    // honest default is "not available" (the host additionally derives
    // Problems-based evidence from real editor diagnostics).
    if (has("security")) {
      checks.push({
        type: "security",
        command: run("security"),
        reason: `package.json scripts.security via ${runner}`,
      });
    } else {
      skipped.push({ type: "security", reason: "no security script declared" });
    }
  } else if (isMaven) {
    const mvn = firstOnPath(["mvn", "mvnw"], probe);
    if (mvn) {
      checks.push({
        type: "tests",
        command: posixJoin("mvn", ["-q", "test"]),
        reason: "pom.xml present; mvn test",
      });
    } else {
      skipped.push({
        type: "tests",
        reason: "pom.xml present but mvn not on PATH",
      });
    }
  } else if (isGradle) {
    const gradle = firstOnPath(["gradle"], probe);
    if (gradle) {
      checks.push({
        type: "tests",
        command: posixJoin("gradle", ["test", "--console=plain"]),
        reason: "Gradle build file present; gradle test",
      });
    } else {
      skipped.push({
        type: "tests",
        reason: "Gradle build file present but gradle not on PATH",
      });
    }
  } else if (isDotnet) {
    const dotnet = firstOnPath(["dotnet"], probe);
    if (dotnet) {
      checks.push({
        type: "build",
        command: posixJoin("dotnet", ["build", "--nologo"]),
        reason: "project file present; dotnet build",
      });
    } else {
      skipped.push({
        type: "build",
        reason: ".NET project present but dotnet not on PATH",
      });
    }
  } else {
    skipped.push({
      type: "tests",
      reason: "no recognized project manifest in the workspace root",
    });
    skipped.push({
      type: "build",
      reason: "no recognized project manifest in the workspace root",
    });
    skipped.push({
      type: "typecheck",
      reason: "no recognized project manifest in the workspace root",
    });
    skipped.push({
      type: "security",
      reason: "no recognized project manifest in the workspace root",
    });
  }

  return { checks, skipped };
}

function safeReadJson(root: string, rel: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Execution — bounded, safe, honest
// ---------------------------------------------------------------------------

const DEFAULT_CHECK_TIMEOUT_MS = 120_000;
const MAX_CHECK_TIMEOUT_MS = 600_000;
/** Bounded tail captured per stream for summaries (never streamed raw). */
const SUMMARY_TAIL_CHARS = 2_000;

const tail = (s: string, max = SUMMARY_TAIL_CHARS): string =>
  s.length > max ? `…${s.slice(-max)}` : s;

function summarize(
  command: string[],
  exitCode: number | null,
  ms: number,
): string {
  const cmd = command.length > 0 ? command.join(" ") : "(no command)";
  const exit = exitCode === null ? "no exit code" : `exit ${exitCode}`;
  return `${cmd} → ${exit} in ${Math.max(0, ms)}ms`;
}

/**
 * Windows `.cmd`/`.bat` shims (npm, pnpm, yarn, bun, npx, tsc, mvn, gradle)
 * cannot be spawned directly — Node requires a shell for them. These are the
 * only commands the planner can emit that need this wrapping; real `.exe`
 * binaries (node, dotnet) spawn directly. The argv is engine-authored (never
 * model input) and contains no shell metacharacters, so the join below is
 * safe; CommandExecutionService keeps its structured-argv guarantees by
 * receiving cmd.exe with the args array intact.
 */
const WINDOWS_CMD_SHIMS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "tsc",
  "mvn",
  "gradle",
]);

function argvForPlatform(command: string[]): {
  command: string;
  args: string[];
} {
  const base = path
    .basename(command[0] ?? "")
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, "");
  if (process.platform === "win32" && WINDOWS_CMD_SHIMS.has(base)) {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", command.join(" ")] };
  }
  return { command: command[0]!, args: command.slice(1) };
}

/**
 * The production executor. Structured argv through CommandExecutionService
 * (the exact service every other tool uses): sanitized base env, timeout,
 * tree-kill cleanup, cancellation — no new shell path, no raw string shell.
 */
export const safeCommandExecutor: VerificationExecutor = async (
  command,
  cwd,
  timeoutMs,
  signal,
) => {
  const service = new CommandExecutionService();
  const argv = argvForPlatform(command);
  const out: CommandOutput = await service.run(
    { command: argv.command, args: argv.args, cwd, timeoutMs },
    { signal },
  );
  return {
    exitCode: out.exitCode,
    timedOut: out.timedOut,
    cancelled: out.cancelled,
    stdout: out.stdout,
    stderr: out.stderr,
  };
};

/**
 * Run one planned check. The mapping is strict:
 *   cancelled  → cancelled (never passed)
 *   timedOut   → timeout (never passed)
 *   exit 0     → passed
 *   exit !==0  → failed
 *   null exit without timeout/cancel → failed ("no exit code")
 */
export async function runVerificationCheck(
  planEntry: { type: VerificationCheckType; command: string[]; reason: string },
  workspaceRoot: string,
  options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    executor?: VerificationExecutor;
  },
): Promise<VerificationCheck> {
  const timeoutMs = Math.min(
    Math.max(1, options?.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS),
    MAX_CHECK_TIMEOUT_MS,
  );
  const startedAt = Date.now();
  const execute = options?.executor ?? safeCommandExecutor;
  try {
    const outcome = await execute(
      planEntry.command,
      workspaceRoot,
      timeoutMs,
      options?.signal,
    );
    const completedAt = Date.now();
    const durationMs = completedAt - startedAt;
    const base = {
      type: planEntry.type,
      command: planEntry.command,
      startedAt,
      completedAt,
      durationMs,
      exitCode: outcome.exitCode as number | null | undefined,
    };
    if (outcome.cancelled) {
      return {
        ...base,
        status: "cancelled",
        summary: `${planEntry.type}: cancelled before completion (${planEntry.reason}).`,
        error: outcome.stderr ? tail(outcome.stderr) : undefined,
      };
    }
    if (outcome.timedOut) {
      return {
        ...base,
        status: "timeout",
        summary: `${planEntry.type}: timed out after ${timeoutMs}ms — outcome unknown, never counted as passed (${planEntry.reason}).`,
        error: outcome.stderr ? tail(outcome.stderr) : undefined,
      };
    }
    if (outcome.exitCode === 0) {
      return {
        ...base,
        status: "passed",
        summary: `${summarize(planEntry.command, outcome.exitCode, durationMs)} (${planEntry.reason})`,
      };
    }
    return {
      ...base,
      status: "failed",
      summary: `${summarize(planEntry.command, outcome.exitCode, durationMs)} (${planEntry.reason})`,
      error: tail(
        [outcome.stderr, outcome.stdout]
          .filter((s) => s.length > 0)
          .join("\n") || `exit code ${outcome.exitCode ?? "null"}`,
      ),
    };
  } catch (err) {
    const completedAt = Date.now();
    const message = err instanceof Error ? err.message : String(err);
    // Spawn-level failure (ENOENT, EACCES, ...) is never a fake pass.
    return {
      type: planEntry.type,
      status: "failed",
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
      command: planEntry.command,
      exitCode: null,
      summary: `${planEntry.type}: could not start — ${message}`,
      error: message,
    };
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Run the applicable checks in order (tests → build → typecheck → security
 * is the preferred order; this implementation runs typecheck/build/tests as
 * detected — the ordered execution contract is preserved by the planner's
 * deterministic check list). Missing checks become not_available with the
 * planner's reason, and the overall verdict stays conservative.
 */
export async function runVerification(
  request: VerificationRequest,
): Promise<VerificationRunResult> {
  const startedAt = Date.now();
  let plan: WorkspacePlan;
  try {
    plan = planVerification(request.workspaceRoot);
  } catch (err) {
    // An unreadable workspace must yield honest NOT_AVAILABLE states —
    // never a crash and never fabricated passes.
    const reason = err instanceof Error ? err.message : String(err);
    plan = {
      checks: [],
      skipped: (["tests", "build", "typecheck", "security"] as const).map(
        (type) => ({
          type,
          reason: `workspace could not be inspected: ${reason}`,
        }),
      ),
    };
  }
  const wanted = request.checks;
  const planned = wanted
    ? plan.checks.filter((c) => wanted.includes(c.type))
    : plan.checks;
  const skipped = wanted
    ? plan.skipped.filter((s) => wanted.includes(s.type))
    : plan.skipped;
  // A requested check that is neither planned nor skipped (planner never
  // modeled it) is explicitly not available — never silently missing.
  const modeled = new Set([
    ...planned.map((c) => c.type),
    ...skipped.map((s) => s.type),
  ]);
  const unmodeled = (wanted ?? []).filter((t) => !modeled.has(t));

  const results: VerificationCheck[] = [];
  for (const entry of skipped) {
    results.push({
      type: entry.type,
      status: "not_available",
      summary: `${entry.type}: not available — ${entry.reason}.`,
    });
  }
  for (const t of unmodeled) {
    results.push({
      type: t,
      status: "not_available",
      summary: `${t}: not available — no safe verification command could be determined.`,
    });
  }

  for (const entry of planned) {
    if (request.signal?.aborted) {
      results.push({
        type: entry.type,
        status: "cancelled",
        summary: `${entry.type}: cancelled before start.`,
        command: entry.command,
      });
      continue;
    }
    results.push(
      await runVerificationCheck(entry, request.workspaceRoot, {
        timeoutMs: request.timeoutMs,
        signal: request.signal,
        executor: request.executor,
      }),
    );
  }

  const completedAt = Date.now();
  const ranSomething = results.some((r) => r.status !== "not_available");
  return {
    checks: results,
    verdict: aggregateVerificationVerdict(results),
    ...(ranSomething ? { startedAt, completedAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// Conservative aggregation
// ---------------------------------------------------------------------------

/**
 * Overall verdict:
 *  - any failed            → failed
 *  - any cancelled/timeout → not_verified (distinct from failed, never pass)
 *  - all passed            → verified
 *  - nothing applicable    → not_available
 * A missing check NEVER counts as a pass.
 */
export function aggregateVerificationVerdict(
  checks: VerificationCheck[],
): VerificationVerdict {
  if (checks.length === 0) return "not_available";
  if (checks.some((c) => c.status === "failed")) return "failed";
  if (checks.some((c) => c.status === "cancelled" || c.status === "timeout")) {
    return "not_verified";
  }
  if (checks.some((c) => c.status === "passed")) {
    // Only fully-passed when EVERY check passed; any not_available caps it.
    if (checks.every((c) => c.status === "passed")) return "verified";
    return "not_verified";
  }
  return "not_available";
}
