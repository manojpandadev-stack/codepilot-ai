/**
 * Self-Healing Engine for CodePilot AI.
 *
 * Orchestrates a bounded repair cycle when agent code changes fail validation.
 * Integrates with the existing agent runtime and PolicyEngine without creating
 * a second orchestration system.
 */

import type { AgentEvent } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export type HealingEventType =
  | "validation_started"
  | "validation_passed"
  | "validation_failed"
  | "diagnosis_started"
  | "diagnosis_completed"
  | "repair_started"
  | "repair_completed"
  | "repair_failed"
  | "healing_exhausted"
  | "healing_succeeded";

export interface HealingEvent {
  type: HealingEventType;
  attempt: number;
  maxAttempts: number;
  timestamp: number;
  data?: Record<string, unknown>;
}

export type HealingEventListener = (event: HealingEvent) => void;

/** Result of a validation run. */
export interface ValidationResult {
  passed: boolean;
  command?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  diagnostics?: string[];
  durationMs?: number;
}

/** A single repair attempt record. */
export interface RepairAttempt {
  attemptNumber: number;
  timestamp: number;
  diagnosis: string;
  repairDescription: string;
  filesChanged: string[];
  validation: ValidationResult;
  success: boolean;
  error?: string;
}

/** Complete result of the self-healing process. */
export interface HealingResult {
  /** Whether the final validation passed. */
  healed: boolean;
  /** Number of repair attempts made. */
  attempts: number;
  /** Maximum allowed attempts. */
  maxAttempts: number;
  /** All repair attempts for audit/review. */
  repairHistory: RepairAttempt[];
  /** The original failure that triggered healing. */
  originalFailure: ValidationResult;
  /** Final validation result. */
  finalValidation: ValidationResult;
  /** Total duration in milliseconds. */
  durationMs: number;
  /** Whether healing was cancelled. */
  cancelled: boolean;
}

/** Configuration for the self-healing engine. */
export interface SelfHealingConfig {
  /** Maximum repair attempts (default: 3). */
  maxAttempts?: number;
  /** Timeout per attempt in ms (default: 120000 = 2 minutes). */
  attemptTimeoutMs?: number;
  /** Whether to require user approval for repairs (default: true). */
  requireApproval?: boolean;
  /** Workspace root for security boundary checks. */
  workspaceRoot: string;
  /** Whether we're in plan mode (healing is blocked in plan mode). */
  isPlanMode?: boolean;
}

/** Callback to run validation (e.g., test suite, linter, build). */
export type ValidationRunner = () => Promise<ValidationResult>;

/** Callback to diagnose and propose a repair. Returns repair description and files changed. */
export type RepairDiagnoser = (
  failure: ValidationResult,
  attemptNumber: number,
  previousAttempts: RepairAttempt[],
) => Promise<{
  diagnosis: string;
  repairDescription: string;
  filesChanged: string[];
}>;

/** Callback to apply a proposed repair. Returns whether it succeeded. */
export type RepairApplier = (
  diagnosis: string,
  repairDescription: string,
  filesChanged: string[],
) => Promise<{ success: boolean; error?: string; filesChanged?: string[] }>;

// ============================================================================
// SelfHealingEngine
// ============================================================================

export class SelfHealingEngine {
  private listeners = new Set<HealingEventListener>();
  private abortController: AbortController | null = null;
  private cancelled = false;
  private readonly config: Required<
    Omit<SelfHealingConfig, "workspaceRoot" | "isPlanMode">
  > & {
    workspaceRoot: string;
    isPlanMode: boolean;
  };

  constructor(config: SelfHealingConfig) {
    this.config = {
      maxAttempts: config.maxAttempts ?? 3,
      attemptTimeoutMs: config.attemptTimeoutMs ?? 120_000,
      requireApproval: config.requireApproval ?? true,
      workspaceRoot: config.workspaceRoot,
      isPlanMode: config.isPlanMode ?? false,
    };
  }

  /**
   * Run the self-healing loop.
   *
   * @param initialFailure - The original validation failure that triggered healing.
   * @param validate - Function to run validation (tests, build, lint).
   * @param diagnose - Function to analyze the failure and propose a repair.
   * @param applyRepair - Function to apply the proposed repair.
   * @returns The complete healing result.
   */
  async heal(
    initialFailure: ValidationResult,
    validate: ValidationRunner,
    diagnose: RepairDiagnoser,
    applyRepair: RepairApplier,
  ): Promise<HealingResult> {
    // If the initial validation already passes, nothing to heal.
    if (initialFailure.passed) {
      return {
        healed: true,
        attempts: 0,
        maxAttempts: this.config.maxAttempts,
        repairHistory: [],
        originalFailure: initialFailure,
        finalValidation: initialFailure,
        durationMs: 0,
        cancelled: false,
      };
    }

    // Plan mode blocks healing (no mutations allowed)
    if (this.config.isPlanMode) {
      return {
        healed: false,
        attempts: 0,
        maxAttempts: this.config.maxAttempts,
        repairHistory: [],
        originalFailure: initialFailure,
        finalValidation: initialFailure,
        durationMs: 0,
        cancelled: false,
      };
    }

    // If already cancelled before heal() starts, return immediately
    if (this.cancelled) {
      return {
        healed: false,
        attempts: 0,
        maxAttempts: this.config.maxAttempts,
        repairHistory: [],
        originalFailure: initialFailure,
        finalValidation: initialFailure,
        durationMs: 0,
        cancelled: true,
      };
    }

    this.abortController = new AbortController();
    const startTime = Date.now();
    const repairHistory: RepairAttempt[] = [];
    let lastValidation = initialFailure;

    this.emitHealingEvent({
      type: "validation_failed",
      attempt: 0,
      maxAttempts: this.config.maxAttempts,
      timestamp: Date.now(),
      data: {
        exitCode: initialFailure.exitCode,
        diagnostics: initialFailure.diagnostics,
      },
    });

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      // Check cancellation
      if (this.abortController.signal.aborted) {
        return {
          healed: false,
          attempts: attempt - 1,
          maxAttempts: this.config.maxAttempts,
          repairHistory,
          originalFailure: initialFailure,
          finalValidation: lastValidation,
          durationMs: Date.now() - startTime,
          cancelled: true,
        };
      }

      // Phase 1: Diagnosis
      this.emitHealingEvent({
        type: "diagnosis_started",
        attempt,
        maxAttempts: this.config.maxAttempts,
        timestamp: Date.now(),
      });

      let diagnosisResult: {
        diagnosis: string;
        repairDescription: string;
        filesChanged: string[];
      };
      try {
        diagnosisResult = await this.withTimeout(
          () => diagnose(lastValidation, attempt, repairHistory),
          this.config.attemptTimeoutMs,
          `diagnosis-${attempt}`,
        );
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const failedAttempt: RepairAttempt = {
          attemptNumber: attempt,
          timestamp: Date.now(),
          diagnosis: `Diagnosis failed: ${error}`,
          repairDescription: "",
          filesChanged: [],
          validation: lastValidation,
          success: false,
          error,
        };
        repairHistory.push(failedAttempt);

        this.emitHealingEvent({
          type: "repair_failed",
          attempt,
          maxAttempts: this.config.maxAttempts,
          timestamp: Date.now(),
          data: { error, phase: "diagnosis" },
        });

        continue;
      }

      this.emitHealingEvent({
        type: "diagnosis_completed",
        attempt,
        maxAttempts: this.config.maxAttempts,
        timestamp: Date.now(),
        data: { diagnosis: diagnosisResult.diagnosis },
      });

      // Phase 2: Apply repair
      this.emitHealingEvent({
        type: "repair_started",
        attempt,
        maxAttempts: this.config.maxAttempts,
        timestamp: Date.now(),
        data: { repairDescription: diagnosisResult.repairDescription },
      });

      let repairResult: {
        success: boolean;
        error?: string;
        filesChanged?: string[];
      };
      try {
        repairResult = await this.withTimeout(
          () =>
            applyRepair(
              diagnosisResult.diagnosis,
              diagnosisResult.repairDescription,
              diagnosisResult.filesChanged,
            ),
          this.config.attemptTimeoutMs,
          `repair-${attempt}`,
        );
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const failedAttempt: RepairAttempt = {
          attemptNumber: attempt,
          timestamp: Date.now(),
          diagnosis: diagnosisResult.diagnosis,
          repairDescription: diagnosisResult.repairDescription,
          filesChanged: [],
          validation: lastValidation,
          success: false,
          error,
        };
        repairHistory.push(failedAttempt);

        this.emitHealingEvent({
          type: "repair_failed",
          attempt,
          maxAttempts: this.config.maxAttempts,
          timestamp: Date.now(),
          data: { error, phase: "apply" },
        });

        continue;
      }

      if (!repairResult.success) {
        const failedAttempt: RepairAttempt = {
          attemptNumber: attempt,
          timestamp: Date.now(),
          diagnosis: diagnosisResult.diagnosis,
          repairDescription: diagnosisResult.repairDescription,
          filesChanged: [],
          validation: lastValidation,
          success: false,
          error: repairResult.error,
        };
        repairHistory.push(failedAttempt);

        this.emitHealingEvent({
          type: "repair_failed",
          attempt,
          maxAttempts: this.config.maxAttempts,
          timestamp: Date.now(),
          data: { error: repairResult.error },
        });

        continue;
      }

      this.emitHealingEvent({
        type: "repair_completed",
        attempt,
        maxAttempts: this.config.maxAttempts,
        timestamp: Date.now(),
        data: {
          filesChanged:
            repairResult.filesChanged ?? diagnosisResult.filesChanged,
        },
      });

      // Phase 3: Re-validate
      this.emitHealingEvent({
        type: "validation_started",
        attempt,
        maxAttempts: this.config.maxAttempts,
        timestamp: Date.now(),
      });

      let revalidation: ValidationResult;
      try {
        revalidation = await this.withTimeout(
          () => validate(),
          this.config.attemptTimeoutMs,
          `validation-${attempt}`,
        );
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        revalidation = {
          passed: false,
          stdout: "",
          stderr: error,
          diagnostics: [`Validation crashed: ${error}`],
        };
      }

      lastValidation = revalidation;

      const successAttempt: RepairAttempt = {
        attemptNumber: attempt,
        timestamp: Date.now(),
        diagnosis: diagnosisResult.diagnosis,
        repairDescription: diagnosisResult.repairDescription,
        filesChanged: repairResult.filesChanged ?? diagnosisResult.filesChanged,
        validation: revalidation,
        success: revalidation.passed,
      };
      repairHistory.push(successAttempt);

      if (revalidation.passed) {
        this.emitHealingEvent({
          type: "healing_succeeded",
          attempt,
          maxAttempts: this.config.maxAttempts,
          timestamp: Date.now(),
          data: {
            attempts: attempt,
            durationMs: Date.now() - startTime,
          },
        });

        return {
          healed: true,
          attempts: attempt,
          maxAttempts: this.config.maxAttempts,
          repairHistory,
          originalFailure: initialFailure,
          finalValidation: revalidation,
          durationMs: Date.now() - startTime,
          cancelled: false,
        };
      }
    }

    // Exhausted all attempts
    this.emitHealingEvent({
      type: "healing_exhausted",
      attempt: this.config.maxAttempts,
      maxAttempts: this.config.maxAttempts,
      timestamp: Date.now(),
      data: {
        attempts: this.config.maxAttempts,
        durationMs: Date.now() - startTime,
      },
    });

    return {
      healed: false,
      attempts: this.config.maxAttempts,
      maxAttempts: this.config.maxAttempts,
      repairHistory,
      originalFailure: initialFailure,
      finalValidation: lastValidation,
      durationMs: Date.now() - startTime,
      cancelled: false,
    };
  }

  /** Cancel any in-progress healing. */
  cancel(): void {
    this.cancelled = true;
    this.abortController?.abort();
  }

  /** Subscribe to healing events. */
  subscribe(listener: HealingEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Emit an event to all listeners. */
  private emitHealingEvent(event: HealingEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* don't break */
      }
    }
  }

  /** Run a promise with a timeout. */
  private withTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    label: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      fn()
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }
}

// ============================================================================
// HealerEvent → AgentEvent adapter
// ============================================================================

/**
 * Convert a HealingEvent into an AgentEvent for streaming to the webview.
 */
export function healingEventToAgentEvent(event: HealingEvent): AgentEvent {
  switch (event.type) {
    case "validation_started":
      return {
        type: "status",
        message: `🔄 Validation attempt ${event.attempt}/${event.maxAttempts}...`,
      };
    case "validation_passed":
      return {
        type: "status",
        message: `✅ Validation passed after ${event.attempt} repair(s)`,
      };
    case "validation_failed":
      return {
        type: "status",
        message: `❌ Validation failed — initiating self-healing (${event.maxAttempts} max attempts)`,
      };
    case "diagnosis_started":
      return {
        type: "status",
        message: `🔍 Diagnosing failure (attempt ${event.attempt}/${event.maxAttempts})...`,
      };
    case "diagnosis_completed":
      return {
        type: "status",
        message: `📋 Diagnosis: ${String(event.data?.diagnosis ?? "").substring(0, 200)}`,
      };
    case "repair_started":
      return {
        type: "status",
        message: `🔧 Applying repair (attempt ${event.attempt}/${event.maxAttempts})...`,
      };
    case "repair_completed":
      return {
        type: "file_changed",
        path:
          (event.data?.filesChanged as string[] | undefined)?.join(", ") ??
          "unknown",
        status: "modified",
      };
    case "repair_failed":
      return {
        type: "error",
        error: `Repair failed: ${String(event.data?.error ?? "unknown")}`,
        recoverable: true,
      };
    case "healing_succeeded":
      return {
        type: "status",
        message: `✅ Self-healing succeeded after ${event.attempt} attempt(s) (${String(event.data?.durationMs ?? 0)}ms)`,
      };
    case "healing_exhausted":
      return {
        type: "error",
        error: `Self-healing exhausted after ${event.maxAttempts} attempts`,
        recoverable: false,
      };
    default:
      return { type: "status", message: `Healing event: ${event.type}` };
  }
}

// ============================================================================
// Built-in validation runners
// ============================================================================

/**
 * Create a validation runner that executes a shell command.
 * Returns a ValidationResult based on exit code and output.
 */
export function createCommandValidator(
  command: string,
  cwd: string,
  options?: { timeoutMs?: number },
): ValidationRunner {
  return async (): Promise<ValidationResult> => {
    const { execSync } = await import("child_process");
    const startTime = Date.now();

    try {
      const stdout = execSync(command, {
        cwd,
        timeout: options?.timeoutMs ?? 120_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      return {
        passed: true,
        command,
        exitCode: 0,
        stdout,
        stderr: "",
        diagnostics: [],
        durationMs: Date.now() - startTime,
      };
    } catch (err: unknown) {
      const execErr = err as {
        status?: number;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        message?: string;
      };

      return {
        passed: false,
        command,
        exitCode: execErr.status ?? 1,
        stdout:
          typeof execErr.stdout === "string"
            ? execErr.stdout
            : String(execErr.stdout ?? ""),
        stderr:
          typeof execErr.stderr === "string"
            ? execErr.stderr
            : String(execErr.stderr ?? execErr.message ?? ""),
        diagnostics: parseDiagnostics(
          typeof execErr.stderr === "string"
            ? execErr.stderr
            : String(execErr.stderr ?? ""),
        ),
        durationMs: Date.now() - startTime,
      };
    }
  };
}

/**
 * Parse common diagnostic patterns from command output.
 */
function parseDiagnostics(stderr: string): string[] {
  const diagnostics: string[] = [];
  const lines = stderr.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Java/Maven errors
    if (trimmed.includes("BUILD FAILURE") || trimmed.includes("[ERROR]")) {
      diagnostics.push(trimmed);
    }
    // TypeScript errors
    else if (trimmed.includes("error TS") || trimmed.includes("Error:")) {
      diagnostics.push(trimmed);
    }
    // Test failures
    else if (
      trimmed.includes("FAIL") ||
      trimmed.includes("failed") ||
      trimmed.includes("AssertionError")
    ) {
      diagnostics.push(trimmed);
    }
    // ESLint errors
    else if (trimmed.includes("error ") && trimmed.includes(" at ")) {
      diagnostics.push(trimmed);
    }
    // Python errors
    else if (trimmed.includes("Traceback") || trimmed.includes("Error:")) {
      diagnostics.push(trimmed);
    }
    // Generic failure indicators
    else if (trimmed.match(/\berror\b/i) || trimmed.match(/\bfail\b/i)) {
      diagnostics.push(trimmed);
    }
  }

  return diagnostics.slice(0, 50); // Limit to 50 diagnostics
}

// ============================================================================
// Error Classification
// ============================================================================

export type ErrorCategory =
  | "RECOVERABLE"
  | "NON_RECOVERABLE"
  | "REQUIRES_APPROVAL"
  | "TRANSIENT"
  | "SECURITY_VIOLATION"
  | "TIMEOUT";

export interface ErrorClassification {
  category: ErrorCategory;
  /** Whether self-healing should attempt automatic recovery. */
  recoverable: boolean;
  /** Human-readable reason. */
  reason: string;
  /** Suggested recovery strategy. */
  strategy?: "retry" | "repair" | "skip" | "user_action";
}

/** Patterns that indicate non-recoverable errors. */
const NON_RECOVERABLE_PATTERNS = [
  /permission denied/i,
  /access denied/i,
  /not authorized/i,
  /authentication failed/i,
  /invalid api key/i,
  /quota exceeded/i,
  /rate limit.*exceeded/i,
  /circuit breaker.*open/i,
  /ENOSPC/i,
  /disk full/i,
  /out of memory/i,
  /segfault/i,
  /core dumped/i,
];

/** Patterns that indicate security violations. */
const SECURITY_VIOLATION_PATTERNS = [
  /path traversal/i,
  /workspace escape/i,
  /\.\.\/\.\.\//,
  /command injection/i,
  /ssrf/i,
  /unauthorized mcp/i,
  /secret leakage/i,
];

/** Patterns that indicate transient errors (safe to retry). */
const TRANSIENT_PATTERNS = [
  /econnrefused/i,
  /econnreset/i,
  /etimedout/i,
  /socket hang up/i,
  /network.*unreachable/i,
  /temporary failure/i,
  /service unavailable/i,
  /gateway timeout/i,
  /503 service/i,
  /502 bad gateway/i,
  /eai_again/i,
];

/** Patterns that indicate timeouts. */
const TIMEOUT_PATTERNS = [/timed? ?out/i, /timeout/i, /deadline exceeded/i];

/** Patterns that indicate errors requiring user approval. */
const APPROVAL_PATTERNS = [
  /requires approval/i,
  /user approval required/i,
  /approval required/i,
];

/**
 * Classify an error into a category with recovery guidance.
 */
export function classifyError(
  error: string,
  _toolName?: string,
  exitCode?: number,
): ErrorClassification {
  const lower = error.toLowerCase();

  // Security violations — never auto-recover
  for (const pattern of SECURITY_VIOLATION_PATTERNS) {
    if (pattern.test(error)) {
      return {
        category: "SECURITY_VIOLATION",
        recoverable: false,
        reason: `Security violation detected: ${error.substring(0, 200)}`,
      };
    }
  }

  // Non-recoverable errors — never auto-recover
  for (const pattern of NON_RECOVERABLE_PATTERNS) {
    if (pattern.test(error)) {
      return {
        category: "NON_RECOVERABLE",
        recoverable: false,
        reason: `Non-recoverable error: ${error.substring(0, 200)}`,
      };
    }
  }

  // Approval-required errors
  for (const pattern of APPROVAL_PATTERNS) {
    if (pattern.test(error)) {
      return {
        category: "REQUIRES_APPROVAL",
        recoverable: false,
        reason: `Requires user approval: ${error.substring(0, 200)}`,
        strategy: "user_action",
      };
    }
  }

  // Timeouts
  for (const pattern of TIMEOUT_PATTERNS) {
    if (pattern.test(error)) {
      return {
        category: "TIMEOUT",
        recoverable: true,
        reason: `Timeout detected: ${error.substring(0, 200)}`,
        strategy: "retry",
      };
    }
  }

  // Transient errors — safe to retry
  for (const pattern of TRANSIENT_PATTERNS) {
    if (pattern.test(error)) {
      return {
        category: "TRANSIENT",
        recoverable: true,
        reason: `Transient error: ${error.substring(0, 200)}`,
        strategy: "retry",
      };
    }
  }

  // Command execution failures (exit code != 0) — recoverable via repair
  if (exitCode !== undefined && exitCode !== 0) {
    // Build/test failures are generally recoverable
    if (
      lower.includes("build failure") ||
      lower.includes("test failed") ||
      lower.includes("tests failed") ||
      lower.includes("compilation error") ||
      lower.includes("error ts") ||
      lower.includes("syntaxerror") ||
      lower.includes("syntax error") ||
      lower.includes("importerror") ||
      lower.includes("import error") ||
      lower.includes("module not found") ||
      lower.includes("cannot find") ||
      lower.includes("assertionerror") ||
      lower.includes("assertion error") ||
      lower.includes("referenceerror") ||
      lower.includes("reference error") ||
      lower.includes("typeerror") ||
      lower.includes("type error") ||
      lower.includes("lint") ||
      lower.includes("eslint") ||
      lower.includes("prettier")
    ) {
      return {
        category: "RECOVERABLE",
        recoverable: true,
        reason: `Build/test failure (exit code ${exitCode}): ${error.substring(0, 200)}`,
        strategy: "repair",
      };
    }
  }

  // Default: non-recoverable (conservative — don't auto-heal unknown errors)
  return {
    category: "NON_RECOVERABLE",
    recoverable: false,
    reason: `Unclassified error: ${error.substring(0, 200)}`,
  };
}

// ============================================================================
// Recovery Manager
// ============================================================================

export interface RecoveryManagerConfig {
  /** Maximum total recovery attempts per session (default: 10). */
  maxSessionRecoveries?: number;
  /** Cooldown between recovery attempts in ms (default: 5000). */
  cooldownMs?: number;
}

export interface RecoveryRecord {
  timestamp: number;
  error: string;
  category: ErrorCategory;
  strategy: string;
  success: boolean;
  healingResult?: HealingResult;
}

/**
 * Tracks recovery state across a session to prevent infinite recovery loops.
 * Wraps SelfHealingEngine with session-level bounds.
 */
export class RecoveryManager {
  private records: RecoveryRecord[] = [];
  private lastRecoveryTime = 0;
  private readonly maxSessionRecoveries: number;
  private readonly cooldownMs: number;
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string, config?: RecoveryManagerConfig) {
    this.workspaceRoot = workspaceRoot;
    this.maxSessionRecoveries = config?.maxSessionRecoveries ?? 10;
    this.cooldownMs = config?.cooldownMs ?? 5_000;
  }

  /** Check whether auto-recovery is allowed for this error. */
  canRecover(
    error: string,
    _toolName?: string,
    exitCode?: number,
  ): {
    allowed: boolean;
    classification: ErrorClassification;
    reason?: string;
  } {
    const classification = classifyError(error, _toolName, exitCode);

    if (!classification.recoverable) {
      return { allowed: false, classification, reason: classification.reason };
    }

    if (this.records.length >= this.maxSessionRecoveries) {
      return {
        allowed: false,
        classification,
        reason: `Session recovery limit reached (${this.maxSessionRecoveries})`,
      };
    }

    const now = Date.now();
    if (now - this.lastRecoveryTime < this.cooldownMs) {
      return {
        allowed: false,
        classification,
        reason: `Recovery cooldown active (${this.cooldownMs}ms)`,
      };
    }

    return { allowed: true, classification };
  }

  /** Record a recovery attempt. */
  record(recovery: RecoveryRecord): void {
    this.records.push(recovery);
    this.lastRecoveryTime = Date.now();
  }

  /** Get all recovery records. */
  getRecords(): readonly RecoveryRecord[] {
    return this.records;
  }

  /** Get the total number of recovery attempts. */
  getAttemptCount(): number {
    return this.records.length;
  }

  /** Reset recovery state (e.g., for a new task). */
  reset(): void {
    this.records = [];
    this.lastRecoveryTime = 0;
  }

  /** Create a SelfHealingEngine configured for this session. */
  createHealingEngine(isPlanMode: boolean): SelfHealingEngine {
    return new SelfHealingEngine({
      workspaceRoot: this.workspaceRoot,
      isPlanMode,
      maxAttempts: Math.min(3, this.maxSessionRecoveries - this.records.length),
    });
  }
}
