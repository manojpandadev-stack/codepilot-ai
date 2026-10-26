/**
 * Multi-Agent Review & Verification Intelligence (Agent 2).
 *
 * Independent reviewer/test-analysis/verification intelligence callable by
 * the orchestrator (Agent 1 builds orchestration; this module builds NO
 * orchestration, NO retry loop, and changes NO lifecycle semantics).
 *
 * Reuses existing contracts: `classifyFailure`/`FailureSignal`
 * (failure-classifier), `containsUnverifiedExecutionClaim` (H6 gate),
 * `containsSecretText`/`scrubSecretsText` (shared secrets), error-signal
 * extraction (context-engine). The Verification Engine
 * (`tool-engine/verification-engine`) remains authoritative — this module
 * only RECOMMENDS checks.
 *
 * Every function is deterministic (sorted output, capped text, no network,
 * no model, no randomness) and observes AbortSignal; cancellation throws
 * AbortError so no partial report is ever marked complete.
 */

import { containsSecretText } from "@codepilot/shared";
import { classifyFailure } from "./failure-classifier.js";

/**
 * Execution-claim patterns (H6 philosophy, localized).
 *
 * A completion claim containing one of these WITHOUT supporting evidence
 * (changed files, test runs, verification) is treated as unverified. Kept
 * inside this module so review intelligence never depends on the live
 * agent loop's revision: the loop owns enforcement, this module owns
 * review-time validation, both from the same documented pattern set.
 */
const EXECUTION_CLAIM_PATTERNS: readonly RegExp[] = [
  /\bi\s+(have\s+)?(read|examined|edited|fixed|created|updated|deleted|removed|added|modified|refactored|implemented|applied|run|ran|executed|tested|verified|checked|confirmed|completed|finished)\b/i,
  /\b(done|completed|finished)\b/i,
  /\btests?\s+(pass|passing|passed)\b/i,
  /\ball\s+(tests?\s+)?green\b/i,
  /\bbuild\s+(passes|succeeds|succeeded|successful)\b/i,
  /\bno\s+(test\s+)?(failures|errors)\b/i,
  /\bverified\b/i,
  /\bworking\s+now\b/i,
];

/** True when `text` claims executed work or verified results. */
export function containsUnverifiedExecutionClaim(text: string): boolean {
  return EXECUTION_CLAIM_PATTERNS.some((pattern) => pattern.test(text));
}

// ============================================================================
// Shared helpers
// ============================================================================

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Review operation cancelled", "AbortError");
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function boundText(text: string, max = 200): string {
  return text.length > max ? text.slice(0, max) : text;
}

// ============================================================================
// Review Engine (Phases 1-3)
// ============================================================================

export type ReviewSeverity = "critical" | "high" | "medium" | "low";

export type FindingCategory =
  | "CORRECTNESS"
  | "SECURITY"
  | "PERFORMANCE"
  | "CONCURRENCY"
  | "ERROR_HANDLING"
  | "API_COMPATIBILITY"
  | "TESTING"
  | "MAINTAINABILITY"
  | "REGRESSION";

export interface ReviewFinding {
  readonly severity: ReviewSeverity;
  readonly category: FindingCategory;
  readonly file?: string;
  readonly line?: number;
  readonly message: string;
  readonly evidence?: string;
  readonly recommendation?: string;
  /** 0-1 self-assessed confidence (pattern precision, never a probability). */
  readonly confidence: number;
}

export type ReviewStatus = "pass" | "warn" | "fail";
export type ChangeRisk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ReviewReport {
  readonly status: ReviewStatus;
  readonly findings: ReviewFinding[];
  readonly risk: ChangeRisk;
  readonly filesReviewed: string[];
  readonly testsConsidered: string[];
  readonly securityChecks: string[];
  readonly recommendations: string[];
}

export interface ChangedFile {
  /** Workspace-relative path. */
  readonly path: string;
  /** Content before the change; null = file added. */
  readonly before: string | null;
  /** Content after the change; null = file deleted. */
  readonly after: string | null;
}

export interface ReviewInput {
  readonly task?: string;
  readonly planObjective?: string;
  readonly files: readonly ChangedFile[];
  readonly testsConsidered?: readonly string[];
  readonly signal?: AbortSignal;
}

/** Caps: at most 100 files, 2000 lines per side (overflow noted, not hidden). */
const MAX_REVIEW_FILES = 100;
const MAX_REVIEW_LINES = 2000;

/** Prefix/suffix-trim line diff: returns removed + added line sets with numbers. */
function diffLines(
  before: string | null,
  after: string | null,
): {
  removed: Array<{ line: number; text: string }>;
  added: Array<{ line: number; text: string }>;
} {
  const b = (before ?? "").split("\n").slice(0, MAX_REVIEW_LINES);
  const a = (after ?? "").split("\n").slice(0, MAX_REVIEW_LINES);
  let prefix = 0;
  while (prefix < b.length && prefix < a.length && b[prefix] === a[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < b.length - prefix &&
    suffix < a.length - prefix &&
    b[b.length - 1 - suffix] === a[a.length - 1 - suffix]
  ) {
    suffix++;
  }
  return {
    removed: b
      .slice(prefix, b.length - suffix)
      .map((text, i) => ({ line: prefix + i + 1, text })),
    added: a
      .slice(prefix, a.length - suffix)
      .map((text, i) => ({ line: prefix + i + 1, text })),
  };
}

const GUARD_RE =
  /if\s*\(.*(valid|check|assert|guard|ensure|verify|authenticated?|authorize)/i;
const CATCH_RE = /catch\s*\(|\.catch\s*\(|except[\s:]|rescue\b/;
const APPROVAL_RE =
  /requestApproval|approval_required|ToolGate|M4|permission|approve/i;
const CANCEL_RE =
  /abort|cancel|AbortSignal|AbortController|signal\??\.aborted|cancellation/i;
const EXEC_RE =
  /\b(exec|execSync|spawn|spawnSync|execFile|system|popen|shell_exec)\s*\(/;
const BACKTICK_EXEC_RE = /child_process/;
const PATH_TRAVERSAL_RE =
  /\.\.\/|path\.(join|resolve)\s*\([^)]*(req|input|param|query|user|name)/i;
const FETCH_RE =
  /\b(fetch|axios\.(get|post)|http\.(get|request))\s*\(\s*(?!["'`]\s*https?:\/\/[a-z0-9.-]+\/)/i;
const AUTH_HEADER_RE = /authorization\s*:\s*(?!.*REDACTED)/i;
const SECRET_ASSIGN_RE = /\b(api[_-]?key|passwd|password|secret|token)\s*[:=]/i;
const EXPORT_RE =
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
const CONSOLE_RE = /console\.(log|debug|info)\s*\(/;
const MARKER_RE = /TODO|FIXME|HACK|XXX/;
const LOG_SECRET_VAR_RE =
  /(console\.log|logger\.(info|debug))\s*\([^)]*(token|secret|password|api[_-]?key|authorization)/i;
const EVAL_RE = /eval\s*\(/;
const PROMPT_TO_MUTATION_RE =
  /(prompt|completion|modelOutput|llmOutput).*?(writeFile|exec\(|applyPatch|runCommand)|(\bwriteFile\b|\bexec\s*\().*?(prompt|completion|modelOutput)/i;

function pushFinding(
  out: ReviewFinding[],
  finding: ReviewFinding,
  signal?: AbortSignal,
): void {
  throwIfCancelled(signal);
  if (out.length >= 200) return;
  out.push(finding);
}

/** Deterministic per-file rule scan over added/removed lines. */
function scanFile(
  file: ChangedFile,
  removed: Array<{ line: number; text: string }>,
  added: Array<{ line: number; text: string }>,
  out: ReviewFinding[],
  securityChecks: string[],
  signal?: AbortSignal,
): void {
  const addedText = added.map((l) => l.text).join("\n");
  const removedText = removed.map((l) => l.text).join("\n");
  const isEnvFile = /(^|\/)\.env(\.[^/]*)?$/.test(file.path);

  const markSecurity = (name: string): void => {
    if (!securityChecks.includes(name)) securityChecks.push(name);
  };

  // --- Security: secrets in added lines ---
  markSecurity("secret-scan");
  for (const l of added) {
    throwIfCancelled(signal);
    if (
      containsSecretText(l.text) ||
      (SECRET_ASSIGN_RE.test(l.text) && /['"][^'"]{8,}/.test(l.text))
    ) {
      pushFinding(
        out,
        {
          severity: "critical",
          category: "SECURITY",
          file: file.path,
          line: l.line,
          message: "Possible secret committed in added lines.",
          evidence: boundText(l.text.trim()),
          recommendation:
            "Remove the secret, rotate it, and load it from SecretStorage/env at runtime.",
          confidence: 0.8,
        },
        signal,
      );
    }
    if (isEnvFile) {
      pushFinding(
        out,
        {
          severity: "critical",
          category: "SECURITY",
          file: file.path,
          line: l.line,
          message:
            ".env content changed — secrets must never enter the repository.",
          evidence: boundText(l.text.trim()),
          recommendation:
            "Revert and use .env.example with placeholders instead.",
          confidence: 0.9,
        },
        signal,
      );
      break;
    }
    if (AUTH_HEADER_RE.test(l.text)) {
      pushFinding(
        out,
        {
          severity: "high",
          category: "SECURITY",
          file: file.path,
          line: l.line,
          message: "Authorization header with a live credential.",
          evidence: boundText(l.text.trim()),
          recommendation:
            "Redact the credential; inject it at runtime from secure storage.",
          confidence: 0.75,
        },
        signal,
      );
    }
  }

  // --- Security: unsafe execution ---
  markSecurity("command-injection-scan");
  for (const l of added) {
    throwIfCancelled(signal);
    if (EVAL_RE.test(l.text)) {
      pushFinding(
        out,
        {
          severity: "critical",
          category: "SECURITY",
          file: file.path,
          line: l.line,
          message: "eval() enables code injection.",
          evidence: boundText(l.text.trim()),
          recommendation:
            "Replace eval() with a safe parser or allow-list dispatch.",
          confidence: 0.9,
        },
        signal,
      );
    }
    if (EXEC_RE.test(l.text) && /[+`$]/.test(l.text)) {
      pushFinding(
        out,
        {
          severity: "critical",
          category: "SECURITY",
          file: file.path,
          line: l.line,
          message: "Shell command built from dynamic parts (injection risk).",
          evidence: boundText(l.text.trim()),
          recommendation:
            "Use argv arrays (execFile) with fixed commands and validated arguments.",
          confidence: 0.7,
        },
        signal,
      );
    } else if (BACKTICK_EXEC_RE.test(l.text) || EXEC_RE.test(l.text)) {
      pushFinding(
        out,
        {
          severity: "high",
          category: "SECURITY",
          file: file.path,
          line: l.line,
          message:
            "Process execution added — verify command and arguments are fixed/validated.",
          evidence: boundText(l.text.trim()),
          recommendation:
            "Prefer allow-listed commands; never pass model output as a command.",
          confidence: 0.5,
        },
        signal,
      );
    }
    // Static import specifiers routinely contain ../ — only flag path
    // construction in executable code, never module specifiers.
    if (
      PATH_TRAVERSAL_RE.test(l.text) &&
      !/^\s*import\b|from\s*["']|require\s*\(/.test(l.text)
    ) {
      pushFinding(
        out,
        {
          severity: "high",
          category: "SECURITY",
          file: file.path,
          line: l.line,
          message:
            "Possible path traversal (user-influenced path construction).",
          evidence: boundText(l.text.trim()),
          recommendation:
            "Resolve inside the workspace root and reject escapes (WorkspaceBoundary).",
          confidence: 0.6,
        },
        signal,
      );
    }
    if (FETCH_RE.test(l.text)) {
      pushFinding(
        out,
        {
          severity: "medium",
          category: "SECURITY",
          file: file.path,
          line: l.line,
          message:
            "Network fetch with a non-literal URL — confirm SSRF protection applies.",
          evidence: boundText(l.text.trim()),
          recommendation:
            "Route through the SSRF-guarded fetch with allow-listed hosts.",
          confidence: 0.5,
        },
        signal,
      );
    }
    if (LOG_SECRET_VAR_RE.test(l.text)) {
      pushFinding(
        out,
        {
          severity: "medium",
          category: "SECURITY",
          file: file.path,
          line: l.line,
          message: "Credential-shaped value may reach logs.",
          evidence: boundText(l.text.trim()),
          recommendation:
            "Scrub with scrubSecretsText before logging or emitting events.",
          confidence: 0.6,
        },
        signal,
      );
    }
  }
  if (PROMPT_TO_MUTATION_RE.test(addedText)) {
    pushFinding(
      out,
      {
        severity: "high",
        category: "SECURITY",
        file: file.path,
        message: "Untrusted model output may flow into a mutation/execution.",
        recommendation:
          "Validate model output against a schema/allow-list before any write or exec.",
        confidence: 0.4,
      },
      signal,
    );
  }

  // --- Approval / workspace / cancellation guards removed ---
  markSecurity("guard-removal-scan");
  const removedApproval = removed.filter((l) => APPROVAL_RE.test(l.text));
  const addedApproval = APPROVAL_RE.test(addedText);
  if (removedApproval.length > 0 && !addedApproval) {
    pushFinding(
      out,
      {
        severity: "critical",
        category: "SECURITY",
        file: file.path,
        line: removedApproval[0]!.line,
        message: "Approval/permission check removed without replacement.",
        evidence: boundText(removedApproval[0]!.text.trim()),
        recommendation:
          "Restore the ToolGate/M4 check; approval boundaries are fail-closed.",
        confidence: 0.7,
      },
      signal,
    );
  }
  const removedCancel = removed.filter((l) => CANCEL_RE.test(l.text));
  if (removedCancel.length > 0 && !CANCEL_RE.test(addedText)) {
    pushFinding(
      out,
      {
        severity: "high",
        category: "CONCURRENCY",
        file: file.path,
        line: removedCancel[0]!.line,
        message: "Cancellation handling removed without replacement.",
        evidence: boundText(removedCancel[0]!.text.trim()),
        recommendation:
          "Restore AbortSignal propagation so Stop deterministically settles the run.",
        confidence: 0.7,
      },
      signal,
    );
  }
  if (
    /validatePath|isInsideWorkspace|WorkspaceBoundary/.test(removedText) &&
    !/validatePath|isInsideWorkspace|WorkspaceBoundary/.test(addedText)
  ) {
    pushFinding(
      out,
      {
        severity: "critical",
        category: "SECURITY",
        file: file.path,
        message: "Workspace boundary validation removed (escape risk).",
        recommendation:
          "Restore path validation; all file access stays inside the workspace root.",
        confidence: 0.75,
      },
      signal,
    );
  }

  // --- Error handling removed ---
  const removedGuards = removed.filter((l) => GUARD_RE.test(l.text));
  if (removedGuards.length > 0 && !GUARD_RE.test(addedText)) {
    pushFinding(
      out,
      {
        severity: "medium",
        category: "ERROR_HANDLING",
        file: file.path,
        line: removedGuards[0]!.line,
        message: "Input validation/guard removed without replacement.",
        evidence: boundText(removedGuards[0]!.text.trim()),
        recommendation:
          "Restore validation or document why it is no longer needed.",
        confidence: 0.55,
      },
      signal,
    );
  }
  const removedCatch = removed.filter((l) => CATCH_RE.test(l.text));
  if (removedCatch.length > 0 && !CATCH_RE.test(addedText)) {
    pushFinding(
      out,
      {
        severity: "high",
        category: "ERROR_HANDLING",
        file: file.path,
        line: removedCatch[0]!.line,
        message: "Error handling (catch) removed without replacement.",
        evidence: boundText(removedCatch[0]!.text.trim()),
        recommendation:
          "Restore error handling; failures must stay observable, never silent.",
        confidence: 0.65,
      },
      signal,
    );
  }

  // --- Race heuristic (narrow): Promise.all + shared push in one hunk ---
  if (/Promise\.all/.test(addedText) && /\.push\s*\(/.test(addedText)) {
    pushFinding(
      out,
      {
        severity: "medium",
        category: "CONCURRENCY",
        file: file.path,
        message:
          "Concurrent tasks push into shared state — confirm ordering/atomicity.",
        recommendation:
          "Collect per-task results and merge deterministically after await.",
        confidence: 0.4,
      },
      signal,
    );
  }

  // --- API compatibility: exported symbols added/removed ---
  const removedExports = removed
    .map((l) => EXPORT_RE.exec(l.text)?.[1])
    .filter((n): n is string => !!n);
  const addedExports = added
    .map((l) => EXPORT_RE.exec(l.text)?.[1])
    .filter((n): n is string => !!n);
  for (const name of removedExports) {
    if (!addedExports.includes(name)) {
      pushFinding(
        out,
        {
          severity: "medium",
          category: "API_COMPATIBILITY",
          file: file.path,
          message: `Exported symbol removed: ${name}.`,
          evidence: `export … ${name}`,
          recommendation:
            "Confirm callers migrated; breaking changes need a major-version note.",
          confidence: 0.6,
        },
        signal,
      );
    }
  }

  // --- Maintainability (low, informational) ---
  for (const l of added) {
    throwIfCancelled(signal);
    if (CONSOLE_RE.test(l.text)) {
      pushFinding(
        out,
        {
          severity: "low",
          category: "MAINTAINABILITY",
          file: file.path,
          line: l.line,
          message: "Console output in added code.",
          evidence: boundText(l.text.trim()),
          recommendation: "Use the structured event/log pipeline instead.",
          confidence: 0.8,
        },
        signal,
      );
      break;
    }
  }
  for (const l of added) {
    throwIfCancelled(signal);
    if (MARKER_RE.test(l.text)) {
      pushFinding(
        out,
        {
          severity: "low",
          category: "MAINTAINABILITY",
          file: file.path,
          line: l.line,
          message: `Unresolved marker: ${boundText(l.text.trim(), 80)}`,
          recommendation: "File a tracked task or resolve before merge.",
          confidence: 0.85,
        },
        signal,
      );
      break;
    }
  }
  for (const l of added) {
    throwIfCancelled(signal);
    if (l.text.length > 200) {
      pushFinding(
        out,
        {
          severity: "low",
          category: "MAINTAINABILITY",
          file: file.path,
          line: l.line,
          message: `Line exceeds 200 characters (${l.text.length}).`,
          recommendation: "Wrap the line for readability.",
          confidence: 0.9,
        },
        signal,
      );
      break;
    }
  }
}

/**
 * Review a change set file-by-file (diff-aware, never whole-repo).
 * Pure + deterministic; throws AbortError on cancellation (never partial).
 */
export function reviewChange(input: ReviewInput): ReviewReport {
  const signal = input.signal;
  throwIfCancelled(signal);
  const findings: ReviewFinding[] = [];
  const securityChecks: string[] = [];
  const filesReviewed: string[] = [];
  const recommendations: string[] = [];

  const files = input.files.slice(0, MAX_REVIEW_FILES);
  if (input.files.length > MAX_REVIEW_FILES) {
    recommendations.push(
      `${input.files.length - MAX_REVIEW_FILES} file(s) exceed the review cap — manual review recommended for the remainder.`,
    );
  }

  let linesAdded = 0;
  let linesDeleted = 0;
  for (const file of files) {
    throwIfCancelled(signal);
    filesReviewed.push(file.path);
    const { removed, added } = diffLines(file.before, file.after);
    linesAdded += added.length;
    linesDeleted += removed.length;
    scanFile(file, removed, added, findings, securityChecks, signal);
  }

  // Missing-tests rule (needs the whole change, not one file).
  const changedSource = files.filter(
    (f) => /\.(ts|tsx|js|jsx|java|py|go)$/.test(f.path) && f.after !== null,
  );
  const changedTests = new Set(
    files
      .filter((f) => /(\.test\.|\.spec\.|Test\.java|_test\.)/.test(f.path))
      .map((f) => f.path),
  );
  if (changedSource.length > 0 && changedTests.size === 0) {
    findings.push({
      severity: "medium",
      category: "TESTING",
      message: `${changedSource.length} source file(s) changed with no test changes in the set.`,
      recommendation: "Add or update tests covering the changed behavior.",
      confidence: 0.5,
    });
  }

  findings.sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      (a.file ?? "").localeCompare(b.file ?? "") ||
      (a.line ?? 0) - (b.line ?? 0),
  );

  let riskAssessment = assessRisk({
    filesChanged: files.map((f) => f.path),
    linesAdded,
    linesDeleted,
    ...(signal ? { signal } : {}),
  });
  // Findings-implied risk floor: a change carrying critical/high findings
  // must never report LOW risk. assessRisk stays pure (file signals only);
  // the floor is applied here with an explicit, scored factor.
  const criticalCount = findings.filter(
    (f) => f.severity === "critical",
  ).length;
  const highCount = findings.filter((f) => f.severity === "high").length;
  const floor = criticalCount > 0 ? 8 : highCount > 0 ? 4 : 0;
  if (riskAssessment.score < floor) {
    const delta = floor - riskAssessment.score;
    const factors = [...riskAssessment.factors];
    factors.push({
      factor: `risk floor from review findings (${criticalCount} critical, ${highCount} high)`,
      points: delta,
    });
    const score = riskAssessment.score + delta;
    riskAssessment = {
      level:
        score >= 13
          ? "CRITICAL"
          : score >= 8
            ? "HIGH"
            : score >= 4
              ? "MEDIUM"
              : "LOW",
      score,
      factors,
    };
  }

  const status: ReviewStatus =
    findings.some((f) => f.severity === "critical") ||
    riskAssessment.level === "CRITICAL"
      ? "fail"
      : findings.some(
            (f) => f.severity === "high" || f.severity === "medium",
          ) || riskAssessment.level === "HIGH"
        ? "warn"
        : "pass";

  for (const f of findings
    .filter((x) => x.severity === "critical" || x.severity === "high")
    .slice(0, 10)) {
    if (f.recommendation)
      recommendations.push(`${f.file ?? "change"}: ${f.recommendation}`);
  }
  if (recommendations.length === 0 && status !== "pass") {
    recommendations.push("Address the findings above before merge.");
  }

  return {
    status,
    findings,
    risk: riskAssessment.level,
    filesReviewed: [...filesReviewed].sort((a, b) => a.localeCompare(b)),
    testsConsidered: [...(input.testsConsidered ?? [])].sort((a, b) =>
      a.localeCompare(b),
    ),
    securityChecks: [...securityChecks].sort((a, b) => a.localeCompare(b)),
    recommendations,
  };
}

function severityRank(s: ReviewSeverity): number {
  return s === "critical" ? 0 : s === "high" ? 1 : s === "medium" ? 2 : 3;
}

// ============================================================================
// Change risk scoring (Phase 6)
// ============================================================================

export interface RiskInput {
  readonly filesChanged: readonly string[];
  readonly linesAdded?: number;
  readonly linesDeleted?: number;
  readonly signal?: AbortSignal;
}

export interface RiskFactor {
  readonly factor: string;
  readonly points: number;
}

export interface ChangeRiskAssessment {
  readonly level: ChangeRisk;
  readonly score: number;
  readonly factors: RiskFactor[];
}

const SENSITIVE_PATH_RE =
  /(auth|secret|crypto|permission|token|password|credential|key|security|approval|gate|policy|signin|login|oauth)/i;
const CONCURRENCY_RE = /(worker|thread|mutex|lock|atomic|shared|concurr)/i;
const PERSISTENCE_RE =
  /(migration|schema|\.sql\b|database|\bdb\b|repository|store)/i;
const BROWSER_RE = /browser|playwright|chromium|puppeteer/i;
const MANIFEST_RE =
  /(^|\/)(package\.json|pom\.xml|build\.gradle|go\.mod|requirements\.txt|pyproject\.toml|Cargo\.toml)$/;
const REPO_CONFIG_RE =
  /(\.config\.|\.env|settings|application\.(yml|yaml|properties))/i;

/** Deterministic additive risk scoring with explainable factors. */
export function assessRisk(input: RiskInput): ChangeRiskAssessment {
  throwIfCancelled(input.signal);
  const factors: RiskFactor[] = [];
  const add = (factor: string, points: number): void => {
    if (points > 0) factors.push({ factor, points });
  };

  const files = input.filesChanged.length;
  add(
    `files changed: ${files}`,
    Math.min(files, 20) >= 20 ? 3 : files >= 10 ? 2 : files >= 3 ? 1 : 0,
  );
  const lines = (input.linesAdded ?? 0) + (input.linesDeleted ?? 0);
  add(
    `lines changed: ${lines}`,
    lines > 2000 ? 4 : lines > 500 ? 2 : lines > 100 ? 1 : 0,
  );

  let sensitive = 0;
  let concurrency = 0;
  let persistence = 0;
  let browser = 0;
  let manifest = 0;
  let config = 0;
  let gate = 0;
  for (const f of input.filesChanged) {
    throwIfCancelled(input.signal);
    if (SENSITIVE_PATH_RE.test(f)) sensitive++;
    if (CONCURRENCY_RE.test(f)) concurrency++;
    if (PERSISTENCE_RE.test(f)) persistence++;
    if (BROWSER_RE.test(f)) browser++;
    if (MANIFEST_RE.test(f)) manifest++;
    if (REPO_CONFIG_RE.test(f)) config++;
    if (/(ToolGate|tool-gate|M4|approval|cancel|abort|signal)/i.test(f)) gate++;
  }
  add(`security-sensitive files: ${sensitive}`, Math.min(sensitive * 3, 9));
  add(`concurrency code: ${concurrency}`, concurrency > 0 ? 2 : 0);
  add(`persistence/migration: ${persistence}`, persistence > 0 ? 2 : 0);
  add(`browser surface: ${browser}`, browser > 0 ? 2 : 0);
  add(`dependency manifest: ${manifest}`, manifest > 0 ? 2 : 0);
  add(`configuration: ${config}`, config > 0 ? 1 : 0);
  add(`ToolGate/M4/cancellation touched: ${gate}`, gate > 0 ? 3 : 0);

  const score = factors.reduce((a, f) => a + f.points, 0);
  const level: ChangeRisk =
    score >= 13
      ? "CRITICAL"
      : score >= 8
        ? "HIGH"
        : score >= 4
          ? "MEDIUM"
          : "LOW";
  return { level, score, factors };
}

// ============================================================================
// Test selection (Phase 4)
// ============================================================================

export interface ImportEdge {
  readonly from: string;
  readonly to: string;
}

export interface TestSelectionInput {
  readonly changedFiles: readonly string[];
  /** All known test files (else derived by convention). */
  readonly knownTestFiles?: readonly string[];
  /** Resolved import edges (from → to workspace paths). */
  readonly importEdges?: readonly ImportEdge[];
  /** Previously failed test paths (boost, never sole signal). */
  readonly previousFailures?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface RankedTest {
  readonly path: string;
  readonly confidence: number;
  readonly reasons: string[];
}

export interface TestPlan {
  readonly targetedTests: RankedTest[];
  readonly integrationTests: RankedTest[];
  readonly recommendedFullSuite: boolean;
  readonly reasons: string[];
  readonly confidence: number;
}

function testCounterparts(changed: string): string[] {
  const dir = changed.split("/").slice(0, -1).join("/");
  const stem = (changed.split("/").pop() ?? "").replace(/\.[a-z0-9]+$/i, "");
  if (!stem) return [];
  const cands = [
    `${dir}/${stem}.test.ts`,
    `${dir}/${stem}.spec.ts`,
    `${dir}/${stem}Test.java`,
    `${dir}/${stem}_test.py`,
    `${dir}/${stem}_test.go`,
    `${dir}/__tests__/${stem}.test.ts`,
  ];
  return cands;
}

/** Deterministic test selection from conventions + graph + history. */
export function selectTests(input: TestSelectionInput): TestPlan {
  const signal = input.signal;
  throwIfCancelled(signal);
  const importers = new Map<string, Set<string>>();
  for (const e of input.importEdges ?? []) {
    throwIfCancelled(signal);
    if (!importers.has(e.to)) importers.set(e.to, new Set());
    importers.get(e.to)!.add(e.from);
  }
  const prevFailed = new Set(input.previousFailures ?? []);
  const known = new Set(input.knownTestFiles ?? []);
  const isTest = (p: string): boolean =>
    known.has(p) || /(\.test\.|\.spec\.|Test\.java|_test\.)/.test(p);

  const targeted = new Map<string, RankedTest>();
  const consider = (p: string, confidence: number, reason: string): void => {
    const cur = targeted.get(p);
    if (cur) {
      if (!cur.reasons.includes(reason)) {
        targeted.set(p, {
          path: p,
          confidence: Math.max(cur.confidence, confidence),
          reasons: [...cur.reasons, reason],
        });
      }
      return;
    }
    targeted.set(p, { path: p, confidence, reasons: [reason] });
  };

  for (const changed of input.changedFiles) {
    throwIfCancelled(signal);
    if (isTest(changed)) {
      consider(changed, 0.9, "changed test file itself");
      continue;
    }
    // Naming counterparts: authoritative when knownTestFiles verifies the
    // path; otherwise predicted only for source files (never for docs or
    // config, where a phantom test path would mislead the orchestrator).
    const isSource =
      /\.(ts|tsx|js|jsx|mjs|cjs|java|py|go|rs|rb|cs|kt|swift)$/i.test(changed);
    for (const cand of testCounterparts(changed)) {
      if (known.size > 0) {
        if (known.has(cand))
          consider(cand, 0.9, `naming counterpart of ${changed}`);
      } else if (isSource) {
        consider(
          cand,
          0.65,
          `naming counterpart of ${changed} (verify path exists)`,
        );
      }
    }
    for (const importer of importers.get(changed) ?? []) {
      if (isTest(importer))
        consider(importer, 0.7, `imports changed file ${changed}`);
    }
    const dir = changed.split("/").slice(0, -1).join("/");
    for (const t of known) {
      if (t.split("/").slice(0, -1).join("/") === dir && t !== changed) {
        consider(t, 0.5, `same directory as ${changed}`);
      }
    }
    if (prevFailed.has(changed)) consider(changed, 0.6, "previously failed");
  }
  for (const t of prevFailed) {
    if (isTest(t)) consider(t, 0.55, "previously failed test");
  }

  const targetedList = [...targeted.values()].sort(
    (a, b) => b.confidence - a.confidence || a.path.localeCompare(b.path),
  );
  // Integration: tests importing files that import changed files (2-hop).
  const integration: RankedTest[] = [];
  const targetedPaths = new Set(targetedList.map((t) => t.path));
  for (const t of targetedList) {
    for (const importer of importers.get(t.path) ?? []) {
      if (isTest(importer) && !targetedPaths.has(importer)) {
        integration.push({
          path: importer,
          confidence: 0.4,
          reasons: [`imports targeted test ${t.path}`],
        });
      }
    }
  }
  integration.sort((a, b) => a.path.localeCompare(b.path));

  const reasons: string[] = [];
  if (targetedList.length > 0)
    reasons.push(
      `${targetedList.length} targeted test(s) by convention/graph/history`,
    );
  if (integration.length > 0)
    reasons.push(`${integration.length} integration test(s) via 2-hop imports`);
  const recommendedFullSuite =
    input.changedFiles.length > 10 || targetedList.length === 0;
  if (recommendedFullSuite) {
    reasons.push(
      targetedList.length === 0
        ? "no targeted tests identified — full suite recommended"
        : "large change (>10 files) — full suite recommended",
    );
  }
  const confidence =
    targetedList.length > 0
      ? round2(
          targetedList.reduce((a, t) => a + t.confidence, 0) /
            targetedList.length,
        )
      : 0.3;
  return {
    targetedTests: targetedList,
    integrationTests: integration,
    recommendedFullSuite,
    reasons,
    confidence,
  };
}

// ============================================================================
// Failure classification for test/tool failures (Phase 5)
// ============================================================================

export type FailureKind =
  | "PRODUCTION_REGRESSION"
  | "TEST_FIXTURE"
  | "ENVIRONMENT"
  | "FLAKY"
  | "TIMEOUT"
  | "CANCELLATION"
  | "CONFIGURATION"
  | "DEPENDENCY"
  | "EXPECTED_FAILURE"
  | "UNKNOWN";

export interface TestFailureInput {
  readonly text: string;
  readonly exitCode?: number | null;
  readonly timedOut?: boolean;
  readonly cancelled?: boolean;
  readonly command?: string;
  readonly toolName?: string;
  /** Files changed by the agent in this task (links failures to changes). */
  readonly changedFiles?: readonly string[];
  /** Set true ONLY with real rerun/pass evidence — never assumed. */
  readonly knownFlaky?: boolean;
  /** Previous failure signatures for this test (regression comparison). */
  readonly previousFailures?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface ClassifiedFailure {
  readonly kind: FailureKind;
  readonly evidence: string[];
  /** 0-1 stated confidence with reason; FLAKY requires knownFlaky. */
  readonly confidence: number;
  readonly baseCategory: string;
}

const ENV_RE =
  /(command not found|ENOENT|EACCES|ENOSPC|out of memory|ECONNREFUSED|EADDRINUSE|no such file|cannot execute|permission denied)/i;
const DEP_RE =
  /(cannot find module|module not found|ModuleNotFoundError|NoClassDefFound|package not found|unresolved (import|dependency)|npm ERR! 404|version conflict)/i;
const CONFIG_RE =
  /(invalid (option|argument|configuration)|config.*(invalid|missing|parse|error)|schema.*valid|unknown option)/i;
const EXPECTED_RE =
  /\bxfail\b|@todo.*test|test\.skip|describe\.skip|it\.skip|expected to fail/i;
const ASSERT_RE = /(AssertionError|expect\(|assert|FAILED|✗|×|✘|test.*failed)/i;
const FIXTURE_HINT_RE = /(mock|stub|fake|fixture|factory|seed|snapshot)/i;

/** Classify a test/tool failure; FLAKY is never emitted without knownFlaky. */
export function classifyTestFailure(
  input: TestFailureInput,
): ClassifiedFailure {
  throwIfCancelled(input.signal);
  const text = input.text.slice(0, 20_000);
  const evidence: string[] = [];
  const ev = (s: string): void => {
    if (evidence.length < 5 && !evidence.includes(s)) evidence.push(s);
  };

  const base = classifyFailure({
    ...(input.command !== undefined ? { command: input.command } : {}),
    ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    stdout: text,
    ...(input.timedOut !== undefined ? { timedOut: input.timedOut } : {}),
  });

  if (input.cancelled || /abort|cancelled|canceled/i.test(text.slice(0, 500))) {
    ev("cancellation marker present");
    return {
      kind: "CANCELLATION",
      evidence,
      confidence: 0.95,
      baseCategory: base.category,
    };
  }
  if (
    input.timedOut ||
    input.exitCode === 124 ||
    /timed?\s*out|exceeded.*timeout|timeout.*exceeded/i.test(text)
  ) {
    const m = /timed?\s*out/i.exec(text)?.[0] ?? "timedOut flag";
    ev(`timeout marker: ${boundText(m, 60)}`);
    return {
      kind: "TIMEOUT",
      evidence,
      confidence: 0.9,
      baseCategory: base.category,
    };
  }
  const envM = ENV_RE.exec(text)?.[0];
  if (envM) {
    ev(`environment marker: ${boundText(envM, 80)}`);
    return {
      kind: "ENVIRONMENT",
      evidence,
      confidence: 0.8,
      baseCategory: base.category,
    };
  }
  const depM = DEP_RE.exec(text)?.[0];
  if (depM) {
    ev(`dependency marker: ${boundText(depM, 80)}`);
    return {
      kind: "DEPENDENCY",
      evidence,
      confidence: 0.8,
      baseCategory: base.category,
    };
  }
  const cfgM = CONFIG_RE.exec(text)?.[0];
  if (cfgM) {
    ev(`configuration marker: ${boundText(cfgM, 80)}`);
    return {
      kind: "CONFIGURATION",
      evidence,
      confidence: 0.6,
      baseCategory: base.category,
    };
  }
  if (EXPECTED_RE.test(text)) {
    ev("expected-failure marker (xfail/skip/todo)");
    return {
      kind: "EXPECTED_FAILURE",
      evidence,
      confidence: 0.8,
      baseCategory: base.category,
    };
  }
  if (input.knownFlaky && (input.previousFailures ?? []).length > 0) {
    ev("knownFlaky with prior differing signatures");
    return {
      kind: "FLAKY",
      evidence,
      confidence: 0.6,
      baseCategory: base.category,
    };
  }
  if (ASSERT_RE.test(text)) {
    const changed = input.changedFiles ?? [];
    const failingFiles = [
      ...text.matchAll(/([\w.@+\-/\\]+\.(?:test\.|spec\.)?[a-z]+)/gi),
    ]
      .map((m) => m[1]!)
      .filter((p) => p.length < 200)
      .slice(0, 5);
    for (const f of failingFiles) ev(`failing file: ${f}`);
    const linked = failingFiles.some((f) =>
      changed.some(
        (c) => c === f || c.endsWith(`/${f}`) || f.endsWith(`/${c}`),
      ),
    );
    if (linked) {
      ev("failing file overlaps changed files");
      return {
        kind: "PRODUCTION_REGRESSION",
        evidence,
        confidence: 0.7,
        baseCategory: base.category,
      };
    }
    if (FIXTURE_HINT_RE.test(text)) ev("fixture/mock hint in output");
    else ev("assertion failure without change linkage");
    return {
      kind: "TEST_FIXTURE",
      evidence,
      confidence: 0.5,
      baseCategory: base.category,
    };
  }
  ev("no recognized failure marker");
  return {
    kind: "UNKNOWN",
    evidence,
    confidence: 0.3,
    baseCategory: base.category,
  };
}

// ============================================================================
// Verification recommendation (Phase 7) — recommends only, engine decides
// ============================================================================

export type VerificationCheckKind =
  "tests" | "build" | "typecheck" | "security";

export interface VerificationRecommendationInput {
  readonly risk: ChangeRisk;
  readonly languagesChanged?: readonly string[];
  readonly manifestChanged?: boolean;
  readonly hasTests?: boolean;
  readonly targetedTestCount?: number;
  readonly touchesSecurity?: boolean;
  readonly failureKind?: FailureKind;
  readonly regressionSuspected?: boolean;
  readonly signal?: AbortSignal;
}

export interface VerificationRecommendation {
  readonly requiredChecks: VerificationCheckKind[];
  readonly targetedTests: number;
  readonly integrationTests: number;
  readonly securityChecks: string[];
  readonly fullSuiteRecommended: boolean;
  readonly reason: string;
}

/** Recommend verification steps; the Verification Engine stays authoritative. */
export function recommendVerification(
  input: VerificationRecommendationInput,
): VerificationRecommendation {
  throwIfCancelled(input.signal);
  const checks: VerificationCheckKind[] = [];
  const langs = new Set(
    (input.languagesChanged ?? []).map((l) => l.toLowerCase()),
  );
  const typed = [...langs].some((l) =>
    ["typescript", "javascript", "java"].includes(l),
  );

  if ((input.targetedTestCount ?? 0) > 0 || input.hasTests)
    checks.push("tests");
  if (typed || input.risk === "HIGH" || input.risk === "CRITICAL")
    checks.push("typecheck");
  if (input.risk !== "LOW" || input.manifestChanged) checks.push("build");
  if (
    input.touchesSecurity ||
    input.risk === "HIGH" ||
    input.risk === "CRITICAL"
  )
    checks.push("security");

  const securityChecks: string[] = [];
  if (checks.includes("security")) {
    securityChecks.push(
      "secret-scan",
      "command-injection-scan",
      "guard-removal-scan",
    );
  }
  const fullSuiteRecommended =
    input.risk === "HIGH" ||
    input.risk === "CRITICAL" ||
    input.regressionSuspected === true ||
    input.manifestChanged === true ||
    input.failureKind === "PRODUCTION_REGRESSION";

  const parts: string[] = [`risk ${input.risk}`];
  if (input.manifestChanged) parts.push("dependency manifest changed");
  if (input.regressionSuspected) parts.push("regression suspected");
  if (input.failureKind) parts.push(`failure: ${input.failureKind}`);
  return {
    requiredChecks: checks,
    targetedTests: input.targetedTestCount ?? 0,
    integrationTests: 0,
    securityChecks,
    fullSuiteRecommended,
    reason: parts.join("; "),
  };
}

// ============================================================================
// Regression detection (Phase 8)
// ============================================================================

export interface RegressionInput {
  readonly beforeTests?: readonly string[];
  readonly afterTests?: readonly string[];
  readonly beforeExports?: Readonly<Record<string, readonly string[]>>;
  readonly afterExports?: Readonly<Record<string, readonly string[]>>;
  readonly filesChanged: readonly string[];
  readonly linesAdded?: number;
  readonly linesDeleted?: number;
  /** Files related to the task (dependency closure); others are unrelated. */
  readonly relatedFiles?: readonly string[];
  readonly coverageBefore?: number;
  readonly coverageAfter?: number;
  readonly signal?: AbortSignal;
}

export interface RegressionReport {
  readonly removedTests: string[];
  readonly contractChanges: string[];
  readonly largeDiff: boolean;
  readonly unrelatedModifications: string[];
  /** Always explicit; never claims regression without data. */
  readonly coverageNote: string;
}

/** Compare before/after states; honest about unavailable data. */
export function detectRegression(input: RegressionInput): RegressionReport {
  throwIfCancelled(input.signal);
  const before = new Set(input.beforeTests ?? []);
  const after = new Set(input.afterTests ?? []);
  const removedTests = [...before]
    .filter((t) => !after.has(t))
    .sort((a, b) => a.localeCompare(b));

  const contractChanges: string[] = [];
  const beforeExp = input.beforeExports ?? {};
  const afterExp = input.afterExports ?? {};
  for (const file of new Set([
    ...Object.keys(beforeExp),
    ...Object.keys(afterExp),
  ]).values()) {
    throwIfCancelled(input.signal);
    const b = new Set(beforeExp[file] ?? []);
    const a = new Set(afterExp[file] ?? []);
    for (const sym of b) {
      if (!a.has(sym)) contractChanges.push(`${file}: export removed: ${sym}`);
    }
  }
  contractChanges.sort((a, b) => a.localeCompare(b));

  const lines = (input.linesAdded ?? 0) + (input.linesDeleted ?? 0);
  const largeDiff = input.filesChanged.length > 20 || lines > 2000;

  const related = input.relatedFiles ? new Set(input.relatedFiles) : undefined;
  const unrelatedModifications = related
    ? [...input.filesChanged]
        .filter((f) => !related.has(f))
        .sort((a, b) => a.localeCompare(b))
    : [];

  let coverageNote =
    "coverage data unavailable — no coverage regression claimed";
  if (input.coverageBefore !== undefined && input.coverageAfter !== undefined) {
    const delta = round2(input.coverageAfter - input.coverageBefore);
    coverageNote =
      delta < 0
        ? `coverage changed ${input.coverageBefore}% → ${input.coverageAfter}% (delta ${delta}pp)`
        : `coverage stable or improved (${input.coverageBefore}% → ${input.coverageAfter}%)`;
  }

  return {
    removedTests,
    contractChanges,
    largeDiff,
    unrelatedModifications,
    coverageNote,
  };
}

// ============================================================================
// Agent-claim validation (Phase 9) — extends H6, never weakens it
// ============================================================================

export type CompletionVerdict =
  "SUPPORTED" | "INCOMPLETE" | "FAILED" | "BLOCKED";

export interface CompletionEvidence {
  readonly filesChanged?: readonly string[];
  readonly testsRun?: readonly string[];
  readonly testsPassed?: boolean;
  readonly verificationVerdict?:
    "verified" | "failed" | "not_verified" | "not_available";
}

export interface CompletionValidation {
  readonly verdict: CompletionVerdict;
  readonly reasons: string[];
}

const FIX_CLAIM_RE =
  /\b(fix|fixed|resolv|pass|passing|passed|complete|done|implement)\b/i;

/**
 * Validate an agent completion claim against evidence.
 * Uses the H6 claim detector; BLOCKED on zero evidence, FAILED when the
 * agent's own evidence contradicts the claim, INCOMPLETE when required
 * verification is missing — never overrides H6 to approve.
 */
export function validateCompletion(
  claim: string,
  evidence: CompletionEvidence,
): CompletionValidation {
  const reasons: string[] = [];
  if (!claim || claim.trim().length === 0) {
    return {
      verdict: "INCOMPLETE",
      reasons: ["no completion claim to validate"],
    };
  }
  const hasClaim = containsUnverifiedExecutionClaim(claim);
  const filesChanged = evidence.filesChanged ?? [];
  const testsRun = evidence.testsRun ?? [];
  const hasEvidence =
    filesChanged.length > 0 ||
    testsRun.length > 0 ||
    evidence.verificationVerdict === "verified";

  if (hasClaim && !hasEvidence) {
    reasons.push(
      "claim asserts executed work but no files changed, no tests ran, and nothing verified",
    );
    return { verdict: "BLOCKED", reasons };
  }
  if (
    FIX_CLAIM_RE.test(claim) &&
    /test/i.test(claim) &&
    evidence.testsPassed === false
  ) {
    reasons.push("claim asserts fixed/passing tests but testsPassed is false");
    return { verdict: "FAILED", reasons };
  }
  if (
    evidence.verificationVerdict !== undefined &&
    evidence.verificationVerdict !== "verified"
  ) {
    if (hasClaim) {
      reasons.push(
        `required verification is ${evidence.verificationVerdict}, not verified`,
      );
      return {
        verdict:
          evidence.verificationVerdict === "failed" ? "FAILED" : "INCOMPLETE",
        reasons,
      };
    }
  }
  if (!hasClaim) {
    reasons.push(
      "plain acknowledgement without execution claims — nothing to verify",
    );
    return { verdict: "SUPPORTED", reasons };
  }
  reasons.push(
    "claim is consistent with files changed, tests run, or verification",
  );
  return { verdict: "SUPPORTED", reasons };
}
