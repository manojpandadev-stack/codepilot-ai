/**
 * Deterministic failure classification — autonomous debugging & self-repair
 * (Agent 2, Phase 2).
 *
 * WHY DETERMINISTIC: a structured command/tool result already carries the
 * exit code, streams, and executor flags needed to tell a compilation
 * failure from a test failure. Asking the model to classify what the host
 * can compute exactly would add latency, cost, and nondeterminism — so the
 * classifier never consults an LLM.
 *
 * Contract:
 *  - `classifyFailure` is a pure function of its signal: same input, same
 *    category, always (bounded text window, fixed precedence).
 *  - Precedence is explicit and ordered: executor flags first (the most
 *    trustworthy), then content patterns (most specific → least), then
 *    command-shape fallbacks, then conservative UNKNOWN.
 *  - `recoverable` encodes the repair policy: only failures that a code
 *    fix could plausibly address enter the recovery loop. TOOL- and
 *    UNKNOWN-class failures, infrastructure/network failures, and
 *    terminal conditions (permission, quota, security) NEVER auto-repair.
 *  - Evidence embedded in `reason` is bounded and passed through the
 *    canonical secret scrubber — a classification must never leak an API
 *    key, token, or Authorization header.
 */

import { scrubSecretsText } from "@codepilot/shared";

// ============================================================================
// Categories
// ============================================================================

/**
 * Failure categories the recovery engine distinguishes. Deterministic —
 * derived only from structured command/tool results.
 */
export type FailureCategory =
  | "BUILD_FAILURE"
  | "TEST_FAILURE"
  | "TYPECHECK_FAILURE"
  | "LINT_FAILURE"
  | "RUNTIME_FAILURE"
  | "DEPENDENCY_FAILURE"
  | "COMMAND_FAILURE"
  | "NETWORK_FAILURE"
  | "TOOL_FAILURE"
  | "TIMEOUT"
  | "UNKNOWN_FAILURE";

/**
 * Categories a repair attempt may address. TOOL/UNKNOWN are excluded
 * (nothing deterministic to act on), NETWORK is infrastructure (the
 * existing CommandRepairLoop owns bounded reruns for that class), and
 * terminal conditions are overridden to non-recoverable below.
 */
const RECOVERABLE_CATEGORIES: ReadonlySet<FailureCategory> = new Set([
  "BUILD_FAILURE",
  "TEST_FAILURE",
  "TYPECHECK_FAILURE",
  "LINT_FAILURE",
  "RUNTIME_FAILURE",
  "DEPENDENCY_FAILURE",
  "COMMAND_FAILURE",
  "TIMEOUT",
]);

/**
 * Terminal conditions — never auto-repair regardless of category
 * (mirrors the existing `classifyError` non-recoverable policy).
 */
const TERMINAL_PATTERNS: RegExp[] = [
  /permission denied/i,
  /access denied/i,
  /not authorized/i,
  /authorization failed/i,
  /invalid api key/i,
  /quota exceeded/i,
  /rate limit/i,
  /circuit breaker.*open/i,
  /out of memory/i,
  /ENOSPC/i,
  /disk full/i,
  /security violation/i,
  /workspace escape/i,
  /path traversal/i,
  /command injection/i,
  /gemini is temporarily busy/i,
  /model experiencing high demand/i,
];

// ============================================================================
// Signal
// ============================================================================

/** Structured result of one failed command or tool execution. */
export interface FailureSignal {
  /** Exact command text, when the failure came from a shell command. */
  command?: string;
  /** Tool that produced the failure (e.g. "bash", "read_files"). */
  toolName?: string;
  /** Process exit code when known (null/undefined = unknown). */
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  /** Combined tool output when the executor does not split streams. */
  output?: string;
  /** Executor-reported wall-clock duration in ms (never inferred). */
  durationMs?: number;
  /** Executor-reported timeout — never inferred from duration alone. */
  timedOut?: boolean;
  /**
   * The failure originated in the tool layer itself (dispatch/gate/tool
   * crash) rather than in a command the tool ran.
   */
  toolError?: boolean;
}

export interface FailureClassification {
  category: FailureCategory;
  /** Whether the autonomous recovery loop may attempt a repair. */
  recoverable: boolean;
  /** Deterministic, bounded, secret-scrubbed human-readable reason. */
  reason: string;
  /** Exit code carried by the signal, when known. */
  exitCode?: number | null;
  /** The pattern/group that decided the category (bounded, for audit). */
  evidence?: string;
}

/** Bounded text window scanned per stream (never the whole log). */
const SCAN_CHARS = 8_000;
/** Total scan window across all streams. */
const MAX_SCAN_CHARS = 20_000;
/** Max evidence characters embedded into `reason`. */
const EVIDENCE_CHARS = 160;

const slice = (s: string | undefined): string =>
  typeof s === "string" ? s.slice(0, SCAN_CHARS) : "";

/** Bounded, ordered scan window for pattern matching. */
export function failureScanText(signal: FailureSignal): string {
  const text = [
    signal.command !== undefined ? `COMMAND: ${signal.command}` : "",
    slice(signal.stderr),
    slice(signal.stdout),
    slice(signal.output),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return text.slice(0, MAX_SCAN_CHARS);
}

// ============================================================================
// Content patterns (specific → general; first match wins)
// ============================================================================

interface PatternGroup {
  category: FailureCategory;
  patterns: RegExp[];
}

const CONTENT_GROUPS: PatternGroup[] = [
  {
    category: "NETWORK_FAILURE",
    patterns: [
      /ENOTFOUND/i,
      /ECONNREFUSED/i,
      /ECONNRESET/i,
      /EHOSTUNREACH/i,
      /ENETUNREACH/i,
      /EAI_AGAIN/i,
      /getaddrinfo/i,
      /socket hang up/i,
      /network (?:error|unreachable|failure)/i,
      /could not resolve (?:host|domain|server)/i,
      /connection (?:refused|reset|closed)/i,
      /proxy (?:error|timeout)/i,
      /HTTP (?:502|503|504)\b/,
    ],
  },
  {
    category: "DEPENDENCY_FAILURE",
    patterns: [
      /Cannot find module ['"]/,
      /Cannot find package ['"]/,
      /MODULE_NOT_FOUND/i,
      /ModuleNotFoundError/i,
      /Module not found/i,
      /Could not resolve (?:dependency|module|entry)/i,
      /unresolved import/i,
      /npm ERR!.*ERESOLVE/i,
      /ClassNotFoundError/i,
      /ClassNotFoundException/i,
      /Missing required (?:dependency|module)/i,
    ],
  },
  {
    category: "TYPECHECK_FAILURE",
    patterns: [
      /error TS\d{4}/,
      /TypeScript(?: compiler)? (?:error|errors|failed)/i,
      /\btypecheck (?:error|errors|failed|failure)\b/i,
      /\b\d+ type errors?\b/i,
      /type errors? found/i,
      /❌\s*Type/,
      /Found \d+ errors? in .*\.tsx?/i,
    ],
  },
  {
    category: "LINT_FAILURE",
    patterns: [
      /eslint/i,
      /\.eslintrc/i,
      /\u2716\s*\d+\s*problems?/i,
      /\bprettier\b.*(error|fail|violation)/i,
      /\blint (?:error|failure|failed)/i,
      /\blinting failed/i,
      /stylelint/i,
    ],
  },
  {
    category: "TEST_FAILURE",
    patterns: [
      /AssertionError/i,
      /assertion failed/i,
      /FAIL\s+\S*\.(?:test|spec)\.[cm]?[jt]sx?/i,
      /(?:^|\n)\s*(?:✗|×|✘)\s+/,
      /Tests:\s*\d+\s*(?:failed|failing)/i,
      /Tests\s+\d+\s+failed/i,
      /Test Suites:.*failed/i,
      /\d+\s+failing\b/,
      /FAILED\s+\S*(?:test|spec)/i,
      /short test summary info/i,
      /expected\b[\s\S]{0,120}?\bto (?:be|equal|deeply equal|contain|throw)/i,
      /npm ERR!.*Test failed/i,
      /Assertion `.*` failed/i,
    ],
  },
  {
    category: "BUILD_FAILURE",
    patterns: [
      /BUILD FAILURE/i,
      /COMPILATION ERROR/i,
      /compilation failed/i,
      /Failed to compile/i,
      /ERROR in \.?\//,
      /error during build/i,
      /build (?:error|errors|failed|failure)/i,
      /\bmake(?:\[\d+\])?: \*\*\*/,
    ],
  },
  {
    category: "RUNTIME_FAILURE",
    patterns: [
      /Traceback \(most recent call last\)/,
      /UnhandledPromiseRejection/i,
      /Uncaught (?:exception|error|TypeError|ReferenceError)/i,
      /\b(?:TypeError|ReferenceError|SyntaxError|RangeError):/,
      /panic:/,
      /Segmentation fault/i,
      /Exception in thread ["']main["']/,
      /\bcore dumped\b/i,
      /\bfatal error\b/i,
    ],
  },
];

// Command-shape fallbacks (used only when no content pattern matched).
const TEST_COMMAND =
  /(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|(?:^|[\s;&|])jest\b|(?:^|[\s;&|])vitest\b|(?:^|[\s;&|])mocha\b|(?:^|[\s;&|])pytest\b|(?:^|[\s;&|])node\s+--test\b|(?:^|[\s;&|])mvn\s+(?:-[\w]+\s+)*test\b|(?:^|[\s;&|])gradle\s+(?:[\w]+\s+)*test\b/i;
const LINT_COMMAND =
  /(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint\b|(?:^|[\s;&|])eslint\b|(?:^|[\s;&|])stylelint\b|(?:^|[\s;&|])prettier\s+--check\b/i;
const BUILD_COMMAND =
  /(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|(?:^|[\s;&|])mvn\b|(?:^|[\s;&|])gradle\b|(?:^|[\s;&|])(?:npx\s+)?tsc\b|(?:^|[\s;&|])webpack\b|(?:^|[\s;&|])make\b/i;
const TIMEOUT_COMMAND_OUTPUT = /\btimed? ?out\b|deadline exceeded/i;

// ============================================================================
// Classification
// ============================================================================

/** First line of `text` that looks like an error, else first non-empty line. */
function firstEvidenceLine(text: string): string {
  const lines = text.split(/\r?\n/);
  const errorLine = lines.find((line) =>
    /\b(?:error|failed|failure|expected|exception|assert)\b/i.test(line),
  );
  const chosen = errorLine ?? lines.find((line) => line.trim().length > 0);
  return (chosen ?? "").trim().slice(0, EVIDENCE_CHARS);
}

/**
 * Classify one failure from its structured signal. Pure and deterministic:
 * no I/O, no clock, no model, bounded text window.
 */
export function classifyFailure(signal: FailureSignal): FailureClassification {
  const text = failureScanText(signal);
  const exit = signal.exitCode ?? null;

  const finish = (
    category: FailureCategory,
    evidence: string,
  ): FailureClassification => {
    const terminal = TERMINAL_PATTERNS.some((pattern) => pattern.test(text));
    const recoverable = !terminal && RECOVERABLE_CATEGORIES.has(category);
    const evidenceLine = evidence || firstEvidenceLine(text);
    const prefix = terminal
      ? "Non-recoverable terminal condition — "
      : !recoverable
        ? "Non-recoverable — "
        : "";
    const reasonBase =
      prefix +
      `${category} (exit ${exit === null ? "unknown" : exit}): ` +
      `${evidenceLine || "no further detail"}`;
    return {
      category,
      recoverable,
      reason: scrubSecretsText(reasonBase).slice(0, 400),
      exitCode: signal.exitCode,
      ...(evidence ? { evidence: evidence.slice(0, EVIDENCE_CHARS) } : {}),
    };
  };

  // 1. Executor flags are authoritative — never second-guessed.
  if (signal.timedOut === true) {
    return finish("TIMEOUT", "executor reported a timeout");
  }
  if (exit === 124) {
    return finish("TIMEOUT", "exit code 124 (timeout wrapper)");
  }

  // 2. Content patterns in fixed precedence (specific → general).
  for (const group of CONTENT_GROUPS) {
    for (const pattern of group.patterns) {
      const match = pattern.exec(text);
      if (match) {
        const line = match[0].includes("\n")
          ? firstEvidenceLine(match[0])
          : match[0];
        return finish(group.category, line || pattern.source);
      }
    }
  }

  // 3. Timeout text without an executor flag (lowest content precedence).
  if (exit !== 0 && TIMEOUT_COMMAND_OUTPUT.test(text)) {
    return finish("TIMEOUT", firstEvidenceLine(text));
  }

  // 4. Command-shape fallbacks for a non-zero exit.
  const command = signal.command ?? "";
  if (exit !== null && exit !== 0 && command.length > 0) {
    if (TEST_COMMAND.test(command)) return finish("TEST_FAILURE", command);
    if (LINT_COMMAND.test(command)) return finish("LINT_FAILURE", command);
    if (BUILD_COMMAND.test(command)) return finish("BUILD_FAILURE", command);
    return finish("COMMAND_FAILURE", command);
  }

  // 5. Tool-layer failure with nothing recognizable.
  if (signal.toolError === true) {
    return finish("TOOL_FAILURE", firstEvidenceLine(text));
  }

  // 6. Non-zero exit without command text is still a command failure.
  if (exit !== null && exit !== 0) {
    return finish("COMMAND_FAILURE", firstEvidenceLine(text));
  }

  // 7. Conservative default — never guessed as recoverable.
  return finish("UNKNOWN_FAILURE", firstEvidenceLine(text));
}

// ============================================================================
// Failure signatures — regression awareness (Phase 7)
// ============================================================================

export interface FailureSignatureInput {
  category: FailureCategory;
  /** Raw failure output (used to pick the first error line). */
  text?: string;
  /** Affected files, when known (first file anchors the signature). */
  files?: readonly string[];
}

/**
 * Normalized signature used to decide whether a NEW failure differs from
 * the baseline: category + first affected file (basename) + first error
 * line with digits collapsed (line numbers moving must not look like a
 * different bug) and paths reduced to basenames.
 *
 * Named distinctly from m10-loop-guard's `failureSignature` (which
 * fingerprints a ValidationResult for cross-session failure memory).
 */
export function failureRegressionSignature(
  input: FailureSignatureInput,
): string {
  const file =
    input.files && input.files.length > 0
      ? (input.files[0]!.split(/[\\/]/).pop() ?? input.files[0]!)
      : "";
  const line = firstEvidenceLine(input.text ?? "");
  const normalized = line
    .toLowerCase()
    // Paths → basenames (drive-qualified and plain).
    .replace(/[a-z]:[\\/][^\s"')]+/gi, (m) => m.split(/[\\/]/).pop() ?? m)
    .replace(/[^\s"'()/]*[\\/][^\s"')]+/g, (m) => m.split(/[\\/]/).pop() ?? m)
    // Line:column suffixes are volatile — strip before digit collapsing.
    .replace(/:\d+(?::\d+)?/g, "")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return `${input.category}|${file}|${normalized}`;
}
