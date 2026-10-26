/**
 * Recovery controller — the bounded autonomous debug & self-repair loop
 * (Agent 2, Phases 4–9).
 *
 * Flow (ONE controlled cycle per attempt, never an uncontrolled retry loop):
 *
 *   failure → classify (deterministic) → diagnostic context → DIAGNOSIS
 *   → REPAIR_PROPOSED → REPAIR_APPROVAL_REQUIRED (fail-closed)
 *   → REPAIR_APPLIED → VERIFICATION (targeted, then broad after targeted
 *   success) → pass? SUCCESS : classify the NEW failure → RECOVERY_RETRY
 *   → … → RECOVERY_EXHAUSTED
 *
 * Bounds and guarantees:
 *  - Attempt budget: default 3 (same conservative policy as
 *    SelfHealingEngine / MAX_AUTO_REPAIR_ATTEMPTS), configurable per call,
 *    hard-capped so no configuration can create an infinite loop.
 *  - Non-recoverable classes stop immediately — no diagnosis, no retry.
 *  - Approval is authoritative and fail-closed: with no approval channel
 *    the repair never applies; a denial STOPS recovery entirely.
 *  - `proposal.apply()` is the ONLY mutation path — the controller itself
 *    never touches the filesystem, so ChangeSet/M4 stay authoritative.
 *  - ChangeSet staging is REQUIRED before every apply: `options.stageRepair`
 *    registers the approved repair as a pending ChangeSet and its id is the
 *    only thing `apply` receives. No staging bridge (or a staging refusal)
 *    means the repair is never applied and recovery stops.
 *  - AbortSignal unwinds at every phase boundary; late results after
 *    cancellation are discarded, no further events are emitted, and the
 *    result is CANCELLED (host reports AGENT_CANCELLED).
 *  - Regression awareness: every verification failure is classified and
 *    compared to the BASELINE signature; a different failure is reported
 *    as a NEW failure (PARTIAL_SUCCESS at exhaustion — never "fixed").
 *  - Verification success requires an actually-passing check; a command
 *    that merely started is not evidence.
 */

import { scrubSecretsText } from "@codepilot/shared";
import {
  buildDiagnosticContext,
  formatDiagnosticContext,
  type ChangeSetReference,
  type DiagnosticContext,
} from "./diagnostic-context.js";
import {
  classifyFailure,
  failureRegressionSignature,
  type FailureCategory,
  type FailureSignal,
} from "./failure-classifier.js";

// ============================================================================
// Constants
// ============================================================================

/** Conservative default repair budget (matches SelfHealingEngine). */
export const DEFAULT_MAX_REPAIR_ATTEMPTS = 3;
/** Hard ceiling — no configuration can exceed this (no infinite loop). */
export const MAX_REPAIR_ATTEMPTS_CEILING = 5;
/** Per-phase timeout (diagnosis / apply / verification). */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 120_000;
/** Minimal-change bound: the largest file set a proposal may touch. */
export const DEFAULT_MAX_FILES_PER_REPAIR = 10;
/** Bound for event/record summary text. */
const SUMMARY_CHARS = 400;

// ============================================================================
// Types
// ============================================================================

export type RecoveryStatus =
  "SUCCESS" | "PARTIAL_SUCCESS" | "FAILED" | "CANCELLED" | "TIMEOUT";

export type RecoveryEventPhase =
  | "FAILURE_DETECTED"
  | "DIAGNOSIS_STARTED"
  | "DIAGNOSIS_COMPLETED"
  | "REPAIR_PROPOSED"
  | "REPAIR_APPROVAL_REQUIRED"
  | "REPAIR_APPLIED"
  | "VERIFICATION_STARTED"
  | "VERIFICATION_FAILED"
  | "RECOVERY_RETRY"
  | "RECOVERY_COMPLETED"
  | "RECOVERY_EXHAUSTED";

export type VerificationStage = "targeted" | "broad";

/** Activity-Timeline recovery event (secret-scrubbed, bounded). */
export interface RecoveryEvent {
  phase: RecoveryEventPhase;
  /** 1-based attempt (0 for the baseline FAILURE_DETECTED event). */
  attempt: number;
  maxAttempts: number;
  timestamp: number;
  category?: FailureCategory;
  /** Bounded, secret-scrubbed one-line summary. */
  summary?: string;
  files?: string[];
  /** Present on terminal phases (COMPLETED / EXHAUSTED). */
  status?: RecoveryStatus;
  /** True when the verification failure differs from the baseline. */
  newFailure?: boolean;
  stage?: VerificationStage;
  riskLevel?: "low" | "medium" | "high";
}

export interface ApplyOutcome {
  success: boolean;
  filesChanged?: string[];
  /**
   * Informational echo of the ChangeSet the host applied. The controller
   * records the id returned by `stageRepair`, which is authoritative — an
   * echoed id can never widen what was authorized.
   */
  changeSetId?: string;
  error?: string;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
}

export interface ApprovalRequest {
  attempt: number;
  category: FailureCategory;
  summary: string;
  files: string[];
  commands?: string[];
  preview?: string;
  riskLevel: "low" | "medium" | "high";
}

/**
 * The proposed minimal fix. `apply` is the ONLY mutation path and is handed
 * the ChangeSet id the host staged for THIS attempt — a repair can therefore
 * never apply an unstaged edit.
 */
export interface RepairProposal {
  /** Proposed action (bounded, human-readable). */
  summary: string;
  /** Affected workspace-relative files — smallest intended set. */
  files: string[];
  commands?: string[];
  /** Bounded preview: diff excerpt or before/after snippet. */
  preview?: string;
  riskLevel?: "low" | "medium" | "high";
  apply: (changeSetId: string) => Promise<ApplyOutcome> | ApplyOutcome;
}

export interface VerificationOutcome {
  passed: boolean;
  command?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  /** Executor-reported timeout — a timeout can never be a pass. */
  timedOut?: boolean;
  /** The check was cancelled — never a pass. */
  cancelled?: boolean;
  /** Bounded note (e.g. why a check is unavailable). */
  note?: string;
}

export interface DiagnosisInput {
  context: DiagnosticContext;
  /** formatDiagnosticContext(context) — ready to append to a prompt. */
  prompt: string;
  attempt: number;
  previousAttempts: RecoveryAttempt[];
  signal?: AbortSignal;
}

export interface VerifyInput {
  context: DiagnosticContext;
  attempt: number;
  signal?: AbortSignal;
}

export interface RecoveryOptions {
  /** Repair budget per run (default 3, hard ceiling 5). */
  maxAttempts?: number;
  /** Per-phase timeout in ms (default 120s). */
  attemptTimeoutMs?: number;
  /** Minimal-change bound for one proposal's file set (default 10). */
  maxFilesPerRepair?: number;
  /** Cancellation — Stop unwinds the whole loop. */
  signal?: AbortSignal;
  /** Activity-Timeline events (exceptions never break the loop). */
  onEvent?: (event: RecoveryEvent) => void;
  /** Previous ChangeSet, included in the diagnostic context when known. */
  previousChangeSet?: ChangeSetReference;
  now?: () => number;

  /** Diagnose the failure and propose the minimal fix. */
  diagnose: (input: DiagnosisInput) => Promise<RepairProposal> | RepairProposal;
  /**
   * Approval channel (M4 / host prompt). OPTIONAL — when absent the
   * controller is fail-closed and never applies a repair.
   */
  requestApproval?: (
    request: ApprovalRequest,
  ) => Promise<ApprovalDecision> | ApprovalDecision;
  /** Most relevant targeted verification (required — success needs evidence). */
  verify: (
    input: VerifyInput,
  ) => Promise<VerificationOutcome> | VerificationOutcome;
  /** Broader regression check — run only after targeted success. */
  verifyBroad?: (
    input: VerifyInput,
  ) => Promise<VerificationOutcome> | VerificationOutcome;
  /**
   * Host ChangeSet staging bridge — REQUIRED. Called after approval and
   * BEFORE `proposal.apply()`; it registers the repair as a pending ChangeSet
   * and returns its id. The id is handed to `apply` so the applied mutation is
   * exactly the reviewed proposal.
   *
   * Fail-closed: when absent, or when it refuses, the repair is NOT applied
   * and recovery stops (same treatment as an approval denial) — a recovery
   * edit can never bypass the main agent's ChangeSet/M5 boundary.
   */
  stageRepair?: (
    proposal: RepairProposal,
    attempt: number,
  ) =>
    | Promise<{ ok: true; changeSetId: string } | { ok: false; reason: string }>
    | { ok: true; changeSetId: string }
    | { ok: false; reason: string };
}

export type RepairOutcomeKind =
  "verified" | "retry" | "denied" | "rejected" | "failed";

export interface RecoveryAttempt {
  attempt: number;
  /** Failure this attempt addressed. */
  category: FailureCategory;
  outcome: RepairOutcomeKind;
  diagnosis?: string;
  proposalSummary?: string;
  files?: string[];
  approval?: ApprovalDecision;
  applied?: boolean;
  applyError?: string;
  filesChanged?: string[];
  changeSetId?: string;
  verification?: VerificationOutcome & { stage: VerificationStage };
  /** Classification of a failed verification (the "next" failure). */
  failureCategory?: FailureCategory;
  /** True when this verification failure differs from the baseline. */
  newFailure?: boolean;
  error?: string;
}

export interface RecoveryResult {
  status: RecoveryStatus;
  /** Repair attempts performed (diagnosis rounds started). */
  attempts: number;
  maxAttempts: number;
  /** Baseline failure category. */
  category: FailureCategory;
  baseline: DiagnosticContext;
  /** Last failing verification context (undefined on SUCCESS). */
  finalFailure?: DiagnosticContext;
  /** True when a verification failure differed from the baseline. */
  newFailureDetected: boolean;
  /** Evidence of the passing verification (SUCCESS only). */
  evidence?: {
    stage: VerificationStage;
    command?: string;
    exitCode?: number | null;
    durationMs?: number;
  };
  history: RecoveryAttempt[];
  /** Bounded, secret-scrubbed settlement reason. */
  reason: string;
  durationMs: number;
}

// ============================================================================
// Internals
// ============================================================================

const scrub = (text: string): string =>
  scrubSecretsText(text).slice(0, SUMMARY_CHARS);

function clampAttempts(value: number | undefined): number {
  const n = value ?? DEFAULT_MAX_REPAIR_ATTEMPTS;
  if (!Number.isFinite(n)) return DEFAULT_MAX_REPAIR_ATTEMPTS;
  return Math.min(MAX_REPAIR_ATTEMPTS_CEILING, Math.max(1, Math.floor(n)));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Reject as soon as the signal aborts (DOMException AbortError). */
async function raceWithAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }
  let onAbort: (() => void) | undefined;
  try {
    const abort = new Promise<never>((_resolve, reject) => {
      onAbort = () =>
        reject(new DOMException("The operation was aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([operation, abort]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Per-phase timeout wrapper (labelled errors, timer always cleared). */
function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Unique, bounded proposal file list. */
function proposalFiles(proposal: RepairProposal): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const raw of proposal.files ?? []) {
    if (typeof raw !== "string") continue;
    const file = raw.trim();
    if (file.length === 0 || file.length > 300) continue;
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(file);
    if (files.length >= 50) break;
  }
  return files;
}

function verificationSignal(
  outcome: VerificationOutcome,
  toolName?: string,
): FailureSignal {
  return {
    ...(outcome.command !== undefined ? { command: outcome.command } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
    exitCode: outcome.exitCode ?? null,
    ...(outcome.stdout !== undefined ? { stdout: outcome.stdout } : {}),
    ...(outcome.stderr !== undefined ? { stderr: outcome.stderr } : {}),
    ...(outcome.durationMs !== undefined
      ? { durationMs: outcome.durationMs }
      : {}),
    ...(outcome.timedOut !== undefined ? { timedOut: outcome.timedOut } : {}),
  };
}

function combinedText(signal: FailureSignal): string {
  return [signal.stdout, signal.stderr, signal.output, signal.command]
    .filter((s): s is string => typeof s === "string")
    .join("\n");
}

// ============================================================================
// runRecovery — the bounded loop
// ============================================================================

export async function runRecovery(
  initialFailure: FailureSignal,
  options: RecoveryOptions,
): Promise<RecoveryResult> {
  const maxAttempts = clampAttempts(options.maxAttempts);
  const attemptTimeoutMs =
    options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const maxFilesPerRepair = Math.max(
    1,
    options.maxFilesPerRepair ?? DEFAULT_MAX_FILES_PER_REPAIR,
  );
  const signal = options.signal;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const history: RecoveryAttempt[] = [];

  const aborted = (): boolean => signal?.aborted === true;

  const emit = (
    phase: RecoveryEventPhase,
    attempt: number,
    extra: Partial<RecoveryEvent> = {},
  ): void => {
    // Late results after cancellation are discarded — no events escape.
    if (aborted()) return;
    try {
      options.onEvent?.({
        phase,
        attempt,
        maxAttempts,
        timestamp: now(),
        ...extra,
        // Scrubbed LAST so a raw summary can never override it.
        ...(extra.summary !== undefined
          ? { summary: scrub(extra.summary) }
          : {}),
      });
    } catch {
      /* listeners must never break the loop */
    }
  };

  const classification = classifyFailure(initialFailure);
  const baseline = buildDiagnosticContext(initialFailure, {
    attempt: 0,
    classification,
    ...(options.previousChangeSet !== undefined
      ? { previousChangeSet: options.previousChangeSet }
      : {}),
  });
  const baselineSignature = failureRegressionSignature({
    category: classification.category,
    text: combinedText(initialFailure),
    files: baseline.affectedFiles,
  });

  let lastContext = baseline;
  let lastCategory = classification.category;
  let lastWasNew = false;
  let newFailureDetected = false;
  let evidence: RecoveryResult["evidence"];

  const result = (
    status: RecoveryStatus,
    reason: string,
    extra: Partial<RecoveryResult> = {},
  ): RecoveryResult => ({
    status,
    attempts: history.length,
    maxAttempts,
    category: classification.category,
    baseline,
    newFailureDetected,
    history,
    reason: scrub(reason),
    durationMs: now() - startedAt,
    ...(status !== "SUCCESS" ? { finalFailure: lastContext } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
    ...extra,
  });

  const settleExhausted = (
    reason: string,
    status: RecoveryStatus,
  ): RecoveryResult => {
    emit("RECOVERY_EXHAUSTED", history.length, {
      category: lastCategory,
      status,
      newFailure: lastWasNew,
      summary: reason,
    });
    return result(status, reason);
  };

  const settleCancelled = (): RecoveryResult =>
    result("CANCELLED", "Recovery cancelled by user (AGENT_CANCELLED).");

  emit("FAILURE_DETECTED", 0, {
    category: classification.category,
    summary: classification.reason,
  });

  // Terminal class: never diagnosed, never retried.
  if (!classification.recoverable) {
    const reason = `${classification.reason} — no automatic repair attempted.`;
    emit("RECOVERY_COMPLETED", 0, {
      category: classification.category,
      status: "FAILED",
      summary: reason,
    });
    return result("FAILED", reason);
  }
  if (aborted()) return settleCancelled();

  // ---- Bounded attempt loop ------------------------------------------------
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (aborted()) return settleCancelled();

    // ---- Phase 1: diagnose (with context) ----
    emit("DIAGNOSIS_STARTED", attempt, { category: lastCategory });
    let proposal: RepairProposal;
    try {
      proposal = await withTimeout(
        raceWithAbort(
          Promise.resolve(
            options.diagnose({
              context: lastContext,
              prompt: formatDiagnosticContext(lastContext),
              attempt,
              previousAttempts: [...history],
              signal,
            }),
          ),
          signal,
        ),
        attemptTimeoutMs,
        `diagnosis-${attempt}`,
      );
    } catch (err) {
      if (aborted()) return settleCancelled();
      const message = errorMessage(err);
      history.push({
        attempt,
        category: lastCategory,
        outcome: "failed",
        error: scrub(message),
      });
      const reason = `Diagnosis failed on attempt ${attempt}: ${message}`;
      if (attempt < maxAttempts) {
        emit("RECOVERY_RETRY", attempt, {
          category: lastCategory,
          summary: reason,
        });
        continue;
      }
      return settleExhausted(
        reason,
        lastCategory === "TIMEOUT" ? "TIMEOUT" : "FAILED",
      );
    }
    if (aborted()) return settleCancelled(); // late diagnosis discarded
    emit("DIAGNOSIS_COMPLETED", attempt, {
      category: lastCategory,
      summary: proposal.summary ?? "",
    });

    const files = proposalFiles(proposal);
    emit("REPAIR_PROPOSED", attempt, {
      category: lastCategory,
      files,
      summary: proposal.summary ?? "",
    });

    // ---- Minimal-change bound (Phase 5) ----
    if (files.length > maxFilesPerRepair) {
      const reason =
        `Repair proposal exceeds the minimal-change bound ` +
        `(${files.length} files > ${maxFilesPerRepair}).`;
      history.push({
        attempt,
        category: lastCategory,
        outcome: "rejected",
        diagnosis: scrub(proposal.summary ?? ""),
        files,
        error: reason,
      });
      if (attempt < maxAttempts) {
        emit("RECOVERY_RETRY", attempt, { files, summary: reason });
        continue;
      }
      return settleExhausted(reason, "FAILED");
    }

    // ---- Phase 2: approval (fail-closed, authoritative) ----
    const riskLevel: "low" | "medium" | "high" = proposal.riskLevel ?? "medium";
    emit("REPAIR_APPROVAL_REQUIRED", attempt, {
      category: lastCategory,
      files,
      riskLevel,
      summary: proposal.summary ?? "",
    });
    let decision: ApprovalDecision = {
      approved: false,
      reason: "Approval channel unavailable (deny-closed).",
    };
    if (options.requestApproval) {
      try {
        decision = await raceWithAbort(
          Promise.resolve(
            options.requestApproval({
              attempt,
              category: lastCategory,
              summary: proposal.summary ?? "",
              files,
              ...(proposal.commands !== undefined
                ? { commands: proposal.commands }
                : {}),
              ...(proposal.preview !== undefined
                ? { preview: proposal.preview }
                : {}),
              riskLevel,
            }),
          ),
          signal,
        );
      } catch (err) {
        if (aborted()) return settleCancelled();
        decision = { approved: false, reason: errorMessage(err) };
      }
    }
    if (aborted()) return settleCancelled(); // late approval discarded
    if (!decision.approved) {
      const reason = `Repair approval denied: ${decision.reason ?? "user denied the proposed change"}`;
      history.push({
        attempt,
        category: lastCategory,
        outcome: "denied",
        diagnosis: scrub(proposal.summary ?? ""),
        files,
        approval: decision,
      });
      // Denial STOPS recovery — no further repair attempts, ever.
      emit("RECOVERY_COMPLETED", attempt, {
        category: lastCategory,
        status: "FAILED",
        files,
        summary: reason,
      });
      return result("FAILED", reason);
    }

    // ---- Phase 2b: ChangeSet staging (fail-closed) ----
    // The repair MUST become a pending ChangeSet before anything is applied,
    // so an autonomous self-repair can never write outside the same M4/M5
    // review boundary the main agent's edits go through.
    if (!options.stageRepair) {
      const reason =
        "ChangeSet staging unavailable — the repair was not applied (fail-closed).";
      history.push({
        attempt,
        category: lastCategory,
        outcome: "denied",
        diagnosis: scrub(proposal.summary ?? ""),
        files,
        approval: decision,
        applied: false,
        error: reason,
      });
      emit("RECOVERY_COMPLETED", attempt, {
        category: lastCategory,
        status: "FAILED",
        files,
        summary: reason,
      });
      return result("FAILED", reason);
    }
    let staged:
      { ok: true; changeSetId: string } | { ok: false; reason: string };
    try {
      staged = await withTimeout(
        raceWithAbort(
          Promise.resolve(options.stageRepair(proposal, attempt)),
          signal,
        ),
        attemptTimeoutMs,
        `stage-${attempt}`,
      );
    } catch (err) {
      if (aborted()) return settleCancelled();
      staged = { ok: false, reason: errorMessage(err) };
    }
    if (aborted()) return settleCancelled();
    if (
      !staged.ok ||
      typeof staged.changeSetId !== "string" ||
      staged.changeSetId.length === 0
    ) {
      const reason = `Repair not staged as a ChangeSet: ${
        staged.ok ? "staging returned no ChangeSet id" : staged.reason
      } — nothing was applied (fail-closed).`;
      history.push({
        attempt,
        category: lastCategory,
        outcome: "denied",
        diagnosis: scrub(proposal.summary ?? ""),
        files,
        approval: decision,
        applied: false,
        error: reason,
      });
      emit("RECOVERY_COMPLETED", attempt, {
        category: lastCategory,
        status: "FAILED",
        files,
        summary: reason,
      });
      return result("FAILED", reason);
    }

    // ---- Phase 3: apply (only mutation path; ChangeSet stays authoritative) ----
    let applyOutcome: ApplyOutcome;
    try {
      applyOutcome = await withTimeout(
        raceWithAbort(
          Promise.resolve(proposal.apply(staged.changeSetId)),
          signal,
        ),
        attemptTimeoutMs,
        `apply-${attempt}`,
      );
    } catch (err) {
      if (aborted()) return settleCancelled();
      const message = errorMessage(err);
      history.push({
        attempt,
        category: lastCategory,
        outcome: "failed",
        diagnosis: scrub(proposal.summary ?? ""),
        files,
        approval: decision,
        applied: false,
        applyError: scrub(message),
      });
      const reason = `Repair apply failed on attempt ${attempt}: ${message}`;
      if (attempt < maxAttempts) {
        emit("RECOVERY_RETRY", attempt, {
          category: lastCategory,
          summary: reason,
        });
        continue;
      }
      return settleExhausted(reason, "FAILED");
    }
    if (aborted()) return settleCancelled();

    if (!applyOutcome.success) {
      history.push({
        attempt,
        category: lastCategory,
        outcome: "failed",
        diagnosis: scrub(proposal.summary ?? ""),
        files,
        approval: decision,
        applied: false,
        applyError: scrub(applyOutcome.error ?? "apply reported failure"),
      });
      const reason = `Repair apply failed on attempt ${attempt}: ${applyOutcome.error ?? "unknown error"}`;
      if (attempt < maxAttempts) {
        emit("RECOVERY_RETRY", attempt, {
          category: lastCategory,
          summary: reason,
        });
        continue;
      }
      return settleExhausted(reason, "FAILED");
    }

    const changedFiles =
      applyOutcome.filesChanged && applyOutcome.filesChanged.length > 0
        ? applyOutcome.filesChanged
        : files;
    history.push({
      attempt,
      category: lastCategory,
      outcome: "retry", // refined after verification
      diagnosis: scrub(proposal.summary ?? ""),
      files,
      approval: decision,
      applied: true,
      filesChanged: changedFiles,
      changeSetId: staged.changeSetId,
    });
    emit("REPAIR_APPLIED", attempt, {
      category: lastCategory,
      files: changedFiles,
      summary: applyOutcome.changeSetId
        ? `Applied via ChangeSet ${applyOutcome.changeSetId}`
        : `Applied ${changedFiles.length} change(s)`,
    });
    if (aborted()) return settleCancelled();

    // ---- Phase 4: verification (targeted → broad) ----
    const runVerify = async (
      fn: (
        input: VerifyInput,
      ) => Promise<VerificationOutcome> | VerificationOutcome,
      stage: VerificationStage,
    ): Promise<VerificationOutcome> => {
      emit("VERIFICATION_STARTED", attempt, { stage, category: lastCategory });
      try {
        return await withTimeout(
          raceWithAbort(
            Promise.resolve(fn({ context: lastContext, attempt, signal })),
            signal,
          ),
          attemptTimeoutMs,
          `verification-${stage}-${attempt}`,
        );
      } catch (err) {
        if (aborted()) throw err;
        return {
          passed: false,
          timedOut: /timed out/i.test(errorMessage(err)),
          note: errorMessage(err),
        };
      }
    };

    let verification: VerificationOutcome;
    let stage: VerificationStage = "targeted";
    try {
      verification = await runVerify(options.verify, "targeted");
      if (verification.passed && options.verifyBroad) {
        // Targeted passed → run the broader regression check before SUCCESS.
        verification = await runVerify(options.verifyBroad, "broad");
        stage = "broad";
      }
    } catch (err) {
      void err;
      return settleCancelled(); // abort propagated out of verification
    }
    if (aborted()) return settleCancelled();
    if (verification.cancelled === true) return settleCancelled();

    const record = history[history.length - 1]!;

    if (verification.passed) {
      record.outcome = "verified";
      record.verification = { ...verification, stage };
      evidence = {
        stage,
        ...(verification.command !== undefined
          ? { command: verification.command }
          : {}),
        ...(verification.exitCode !== undefined
          ? { exitCode: verification.exitCode }
          : {}),
        ...(verification.durationMs !== undefined
          ? { durationMs: verification.durationMs }
          : {}),
      };
      const reason =
        stage === "broad"
          ? `Verification passed (targeted + broad) after ${attempt} repair attempt(s).`
          : `Targeted verification passed after ${attempt} repair attempt(s).`;
      emit("RECOVERY_COMPLETED", attempt, {
        category: lastCategory,
        status: "SUCCESS",
        summary: reason,
      });
      return result("SUCCESS", reason);
    }

    // ---- Verification failed → classify, compare with baseline ----
    const nextSignal = verificationSignal(verification, lastContext.toolName);
    const nextClass = classifyFailure(nextSignal);
    const nextContext = buildDiagnosticContext(nextSignal, {
      attempt,
      classification: nextClass,
    });
    const nextSignature = failureRegressionSignature({
      category: nextClass.category,
      text: combinedText(nextSignal),
      files: nextContext.affectedFiles,
    });
    const isNew = nextSignature !== baselineSignature;
    if (isNew) newFailureDetected = true;

    record.outcome = "retry";
    record.verification = { ...verification, stage };
    record.failureCategory = nextClass.category;
    record.newFailure = isNew;
    lastContext = nextContext;
    lastCategory = nextClass.category;
    lastWasNew = isNew;

    emit("VERIFICATION_FAILED", attempt, {
      category: nextClass.category,
      newFailure: isNew,
      stage,
      summary: nextClass.reason,
    });

    if (attempt < maxAttempts) {
      emit("RECOVERY_RETRY", attempt, {
        category: nextClass.category,
        newFailure: isNew,
        summary: isNew
          ? `NEW failure detected (${nextClass.category}) — re-diagnosing`
          : `Verification still failing (${nextClass.category})`,
      });
      continue;
    }
    break;
  }

  // ---- Budget exhausted ----------------------------------------------------
  if (aborted()) return settleCancelled();
  if (lastCategory === "TIMEOUT") {
    return settleExhausted(
      `Recovery exhausted after ${maxAttempts} attempt(s); the last verification timed out (TIMEOUT).`,
      "TIMEOUT",
    );
  }
  if (lastWasNew) {
    return settleExhausted(
      `Original failure resolved, but a NEW failure appeared: ${lastContext.reason}`,
      "PARTIAL_SUCCESS",
    );
  }
  return settleExhausted(
    `Recovery exhausted after ${maxAttempts} attempt(s); verification still fails: ${lastContext.reason}`,
    "FAILED",
  );
}
