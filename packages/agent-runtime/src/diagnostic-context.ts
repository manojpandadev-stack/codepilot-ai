/**
 * Diagnostic context — the compact, safe failure summary handed to the
 * recovery loop's diagnosis step (Agent 2, Phase 3).
 *
 * Rules enforced here (single place, unit-tested):
 *  - Bounded: stdout/stderr are head+tail truncated with an explicit
 *    marker (`…[truncated N chars]…`) — a huge log can never reach the
 *    model or the timeline verbatim.
 *  - Redacted: every stream passes through the canonical secret scrubber
 *    (scrubSecretsText) BEFORE truncation, so an API key, password,
 *    cookie, Authorization header, or SecretStorage value in the output
 *    never reaches the model or an event payload.
 *  - Structured: command, exit code, duration, failure category, affected
 *    files (deterministically extracted), and the previous ChangeSet
 *    reference when relevant.
 *  - Honest: nothing is invented — unknown fields stay undefined, and
 *    truncation is always marked, never silent.
 */

import { scrubSecretsText } from "@codepilot/shared";
import {
  classifyFailure,
  type FailureCategory,
  type FailureClassification,
  type FailureSignal,
} from "./failure-classifier.js";

// ============================================================================
// Limits
// ============================================================================

/** Bounded stdout kept in the context (head+tail, marked). */
export const DEFAULT_MAX_STDOUT_CHARS = 4_000;
/** Bounded stderr kept in the context (head+tail, marked). */
export const DEFAULT_MAX_STDERR_CHARS = 6_000;
/** Max affected files extracted from output. */
export const MAX_AFFECTED_FILES = 20;
/** Overall cap for the formatted prompt block. */
export const MAX_CONTEXT_CHARS = 16_000;

const TRUNCATION_MARKER = (omitted: number): string =>
  `…[truncated ${omitted} chars]…`;

// ============================================================================
// Types
// ============================================================================

/** Reference to the previous ChangeSet, when one is relevant. */
export interface ChangeSetReference {
  changeSetId?: string;
  /** ChangeSet status as reported by the ChangeSet manager. */
  status?: string;
  /** Files staged in that ChangeSet (bounded). */
  files: string[];
}

export interface DiagnosticContext {
  /** 1-based repair attempt; 0 = the baseline failure. */
  attempt: number;
  category: FailureCategory;
  /** Deterministic, bounded, secret-scrubbed classification reason. */
  reason: string;
  command?: string;
  toolName?: string;
  exitCode?: number | null;
  /** Redacted + bounded stdout ("" when the signal had none). */
  stdout: string;
  /** Redacted + bounded stderr ("" when the signal had none). */
  stderr: string;
  durationMs?: number;
  /** Deterministically extracted from output (bounded, deduplicated). */
  affectedFiles: string[];
  previousChangeSet?: ChangeSetReference;
  /** True when any stream was elided (always marked inline). */
  truncated: boolean;
  /** True when redaction actually altered a stream. */
  redacted: boolean;
}

export interface DiagnosticContextOptions {
  attempt?: number;
  previousChangeSet?: ChangeSetReference;
  maxStdoutChars?: number;
  maxStderrChars?: number;
  /** Redactor override (tests); defaults to scrubSecretsText. */
  redact?: (text: string) => string;
  /** Precomputed classification (avoids re-classifying the same signal). */
  classification?: FailureClassification;
}

// ============================================================================
// Truncation + redaction
// ============================================================================

/**
 * Head+tail truncation with an explicit marker. Never silent.
 * `keep` must be >= 80 chars for the marker to be meaningful.
 */
export function truncateBounded(
  text: string,
  keep: number,
): { text: string; truncated: boolean } {
  if (text.length <= keep) return { text, truncated: false };
  const markerWidth = 40; // reserve for the marker itself
  const budget = Math.max(80, keep - markerWidth);
  const head = Math.floor(budget * 0.7);
  const tail = budget - head;
  const omitted = text.length - head - tail;
  return {
    text:
      text.slice(0, head) +
      "\n" +
      TRUNCATION_MARKER(omitted) +
      "\n" +
      text.slice(-tail),
    truncated: true,
  };
}

/** Redact then bound one stream. Returns both flags for the context. */
function prepareStream(
  raw: string,
  keep: number,
  redact: (text: string) => string,
): { text: string; truncated: boolean; redacted: boolean } {
  const redacted = redact(raw);
  const bounded = truncateBounded(redacted, keep);
  return {
    text: bounded.text,
    truncated: bounded.truncated,
    redacted: redacted !== raw,
  };
}

// ============================================================================
// Affected-file extraction (deterministic)
// ============================================================================

/**
 * Code-file extensions recognized in failure output. The full path
 * (extension included) is ONE capture group — extraction must never
 * report the extension-less stem as an affected file.
 */
const CODE_EXTENSIONS =
  "ts|tsx|js|jsx|mjs|cjs|json|java|py|go|rs|rb|cs|cpp|cc|hpp|kt|kts|swift|vue|svelte|css|scss|less|html|xml|yml|yaml|sql|sh";
const FILE_WITH_LINE = new RegExp(
  `((?:[A-Za-z]:)?[\\w.@+\\-/\\\\]+\\.(?:${CODE_EXTENSIONS})):\\d+(?::\\d+)?`,
  "g",
);
/** `FAIL src/foo.test.ts` / `FAILED tests/test_add.py::test_add` style. */
const FAIL_FILE =
  /(?:^|[\s"'`([])(?:FAIL(?:ED)?|ERROR|✗|×|✘)\s+([\w.@+\-/\\]+\.(?:test|spec)\.[cm]?[jt]sx?|[\w.@+\-/\\]+\.py)\b/gi;
/** Maven/Gradle range form: `BoardController.java:[12,5]`. */
const JAVA_RANGE = /([\w.@+\-/\\]+\.java):\[\d+(?:,\d+)?\]/g;

const FILE_SKIP = /(?:^|\/)(?:node_modules|dist|build|\.git)(?:\/|$)/;

/**
 * Deterministically extract affected file paths from failure output.
 * Bounded, deduplicated, order-preserving; URLs and vendored trees are
 * never reported as affected files.
 */
export function extractAffectedFiles(
  ...sources: Array<string | undefined>
): string[] {
  const text = sources
    .filter((s): s is string => typeof s === "string")
    .join("\n")
    .slice(0, 60_000);
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (candidate: string): void => {
    const file = candidate.replace(/^["'`(]+|["'`),]+$/g, "").trim();
    if (file.length === 0 || file.length > 300) return;
    if (file.includes("://")) return;
    if (FILE_SKIP.test(file)) return;
    if (seen.has(file)) return;
    seen.add(file);
    found.push(file);
  };

  for (const re of [FILE_WITH_LINE, FAIL_FILE, JAVA_RANGE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      if (match[1]) push(match[1]);
      else if (match[2]) push(match[2]);
      if (found.length >= MAX_AFFECTED_FILES) break;
    }
    if (found.length >= MAX_AFFECTED_FILES) break;
  }
  return found.slice(0, MAX_AFFECTED_FILES);
}

// ============================================================================
// Context construction
// ============================================================================

/**
 * Build the compact diagnostic context for one failure. Deterministic:
 * classification + extraction + bounded redacted streams. This is the
 * ONLY shape the recovery loop passes to the diagnosis step.
 */
export function buildDiagnosticContext(
  signal: FailureSignal,
  options: DiagnosticContextOptions = {},
): DiagnosticContext {
  const classification = options.classification ?? classifyFailure(signal);
  const redact = options.redact ?? scrubSecretsText;

  const stdout = prepareStream(
    signal.stdout ?? signal.output ?? "",
    options.maxStdoutChars ?? DEFAULT_MAX_STDOUT_CHARS,
    redact,
  );
  const stderr = prepareStream(
    signal.stderr ?? "",
    options.maxStderrChars ?? DEFAULT_MAX_STDERR_CHARS,
    redact,
  );

  const affectedFiles = extractAffectedFiles(
    signal.stdout,
    signal.stderr,
    signal.output,
  );

  const context: DiagnosticContext = {
    attempt: options.attempt ?? 0,
    category: classification.category,
    reason: classification.reason,
    stdout: stdout.text,
    stderr: stderr.text,
    affectedFiles,
    truncated: stdout.truncated || stderr.truncated,
    redacted: stdout.redacted || stderr.redacted,
    ...(signal.command !== undefined ? { command: signal.command } : {}),
    ...(signal.toolName !== undefined ? { toolName: signal.toolName } : {}),
    ...(signal.exitCode !== undefined ? { exitCode: signal.exitCode } : {}),
    ...(signal.durationMs !== undefined
      ? { durationMs: signal.durationMs }
      : {}),
    ...(options.previousChangeSet !== undefined
      ? { previousChangeSet: options.previousChangeSet }
      : {}),
  };
  return context;
}

// ============================================================================
// Prompt formatting
// ============================================================================

/**
 * Format the context as a compact prompt block for the diagnosis step.
 * Bounded overall (MAX_CONTEXT_CHARS) with an explicit marker; already
 * redacted/bounded streams are embedded verbatim.
 */
export function formatDiagnosticContext(ctx: DiagnosticContext): string {
  const lines: string[] = [];
  lines.push(
    `FAILURE [${ctx.category}] attempt ${ctx.attempt}` +
      (ctx.exitCode !== undefined && ctx.exitCode !== null
        ? ` (exit ${ctx.exitCode})`
        : ""),
  );
  lines.push(`Reason: ${ctx.reason}`);
  if (ctx.command !== undefined) lines.push(`Command: ${ctx.command}`);
  if (ctx.toolName !== undefined) lines.push(`Tool: ${ctx.toolName}`);
  if (ctx.durationMs !== undefined) {
    lines.push(`Duration: ${ctx.durationMs}ms`);
  }
  if (ctx.affectedFiles.length > 0) {
    lines.push(`Affected files: ${ctx.affectedFiles.join(", ")}`);
  }
  if (ctx.previousChangeSet) {
    const cs = ctx.previousChangeSet;
    lines.push(
      `Previous ChangeSet: ${cs.changeSetId ?? "unknown"}` +
        `${cs.status ? ` (${cs.status})` : ""}` +
        `${cs.files.length > 0 ? ` — ${cs.files.join(", ")}` : ""}`,
    );
  }
  if (ctx.truncated) lines.push("Note: output was truncated for size.");
  if (ctx.redacted) lines.push("Note: secrets were redacted from output.");
  if (ctx.stdout.trim().length > 0) {
    lines.push("--- stdout ---", ctx.stdout);
  }
  if (ctx.stderr.trim().length > 0) {
    lines.push("--- stderr ---", ctx.stderr);
  }
  const block = lines.join("\n");
  if (block.length <= MAX_CONTEXT_CHARS) return block;
  return truncateBounded(block, MAX_CONTEXT_CHARS).text;
}
