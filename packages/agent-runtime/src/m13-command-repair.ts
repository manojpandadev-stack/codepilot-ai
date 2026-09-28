/**
 * Command-level failure repair (Phase 12, FEATURE_GAP row 14).
 *
 * A bounded diagnose→edit→rerun loop for terminal tool failures
 * (bash/run_commands). When a command fails with a RECOVERABLE error class,
 * the loop applies a small set of deterministic, safe transformations and
 * reruns — each rerun re-evaluated through the M4 gate by the host (the
 * runner is injected; identical command text stays covered by the original
 * approval, transformed text is re-gated deny-closed).
 *
 * Bounds (no infinite loop, ever):
 * - MAX_AUTO_REPAIR_ATTEMPTS total reruns per command (default 3).
 * - Loop guard: the same failure signature (class + command) stops the
 *   loop after `maxSameSignatureRepeats` (default 2) consecutive repeats.
 * - Attempt records persist (JSON, atomic tmp+rename, bounded history) so
 *   repair state survives restarts; corrupt files are quarantined.
 *
 * Non-recoverable classes (syntax errors, permission denied, security
 * violations, unknown commands) NEVER rerun — the model must fix its own
 * command. The loop only repairs infrastructure-shaped failures.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Total repair reruns allowed per command (gap-named constant). */
export const MAX_AUTO_REPAIR_ATTEMPTS = 3;
/** Consecutive identical failure signatures before the loop guard stops. */
export const MAX_SAME_SIGNATURE_REPEATS = 2;
/** Bounded persisted repair history. */
export const MAX_REPAIR_RECORDS = 100;

export type CommandFailureClass =
  | "transient"
  | "network"
  | "missing_module"
  | "non_recoverable";

export interface CommandRepairAttempt {
  /** 1-based attempt index (1 = original command). */
  attempt: number;
  /** Command text executed for this attempt (possibly transformed). */
  command: string;
  /** Failure class observed after this attempt (undefined on success). */
  failureClass?: CommandFailureClass;
  /** Error excerpt (bounded, never the full output). */
  error?: string;
  timestamp: number;
}

export type CommandRepairStatus =
  | "recovered"
  | "exhausted"
  | "non_recoverable";

export interface CommandRepairRecord {
  command: string;
  attempts: CommandRepairAttempt[];
  status: CommandRepairStatus;
  updatedAt: number;
}

export interface CommandRepairOutcome {
  status: CommandRepairStatus;
  /** Final command text (original or last transform). */
  command: string;
  /** Output of the successful attempt (undefined unless recovered). */
  output?: string;
  attempts: CommandRepairAttempt[];
}

const TRANSIENT_PATTERN =
  /timed?\s*out|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|rate limit|HTTP 429|HTTP 503|EPIPE/i;
const NETWORK_PATTERN = /ENOTFOUND|getaddrinfo|ENETUNREACH|EHOSTUNREACH/i;
const MISSING_MODULE_PATTERN = /Cannot find module '([^']+)'/;
/** Package names that are safe to auto-install (scoped or plain tokens). */
const SAFE_PACKAGE_PATTERN = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$|^[a-z0-9][a-z0-9._-]*$/i;

/** Classify a command failure from its error text. */
export function classifyCommandFailure(errorText: string): {
  classification: CommandFailureClass;
  missingModule?: string;
} {
  const text = errorText.slice(0, 8000);
  const missing = MISSING_MODULE_PATTERN.exec(text);
  if (missing) {
    const pkg = missing[1]!;
    // Only plain package names — never a relative path or URL.
    if (SAFE_PACKAGE_PATTERN.test(pkg) && !pkg.startsWith(".")) {
      return { classification: "missing_module", missingModule: pkg };
    }
    return { classification: "non_recoverable" };
  }
  if (TRANSIENT_PATTERN.test(text)) return { classification: "transient" };
  if (NETWORK_PATTERN.test(text)) return { classification: "network" };
  return { classification: "non_recoverable" };
}

/**
 * Plan the next command for a recoverable failure. Returns null when no
 * safe transformation exists (non-recoverable, or the one allowed
 * install-transform was already used).
 */
export function planCommandRepair(
  command: string,
  classification: CommandFailureClass,
  missingModule?: string,
  installAlreadyUsed = false,
): string | null {
  if (classification === "transient" || classification === "network") {
    // Same command — the failure was infrastructure-shaped.
    return command;
  }
  if (classification === "missing_module" && missingModule) {
    if (installAlreadyUsed) return null;
    if (command.includes("npm install")) return null;
    // The transformed command is NEW text — the host re-gates it (M4).
    return `npm install ${missingModule} && ${command}`;
  }
  return null;
}

/** Failure signature for the loop guard (class + bounded command text). */
export function commandFailureSignature(
  command: string,
  classification: CommandFailureClass,
): string {
  return `${classification}:${command.slice(0, 200)}`;
}

export interface CommandRepairLoopOptions {
  maxAttempts?: number;
  /** Persisted history file (JSON). Omit for in-memory only. */
  persistPath?: string;
  maxSameSignatureRepeats?: number;
  maxRecords?: number;
  now?: () => number;
}

interface PersistShape {
  version: 1;
  records: CommandRepairRecord[];
}

/**
 * Bounded command-failure repair loop. The `runner` executes one command
 * and throws on failure; it is injected by the host so every rerun passes
 * through the host's M4 gate (identical text covered by the original
 * approval, transformed text re-evaluated deny-closed).
 */
export class CommandRepairLoop {
  private readonly maxAttempts: number;
  private readonly maxSameSignatureRepeats: number;
  private readonly maxRecords: number;
  private readonly persistPath?: string;
  private readonly now: () => number;
  private records = new Map<string, CommandRepairRecord>();

  constructor(options: CommandRepairLoopOptions = {}) {
    this.maxAttempts = Math.max(
      1,
      options.maxAttempts ?? MAX_AUTO_REPAIR_ATTEMPTS,
    );
    this.maxSameSignatureRepeats = Math.max(
      1,
      options.maxSameSignatureRepeats ?? MAX_SAME_SIGNATURE_REPEATS,
    );
    this.maxRecords = Math.max(1, options.maxRecords ?? MAX_REPAIR_RECORDS);
    this.persistPath = options.persistPath;
    this.now = options.now ?? (() => Date.now());
    if (this.persistPath !== undefined) this.load();
  }

  /** Repair history (bounded, oldest first). */
  listRecords(): CommandRepairRecord[] {
    return [...this.records.values()].sort((a, b) => a.updatedAt - b.updatedAt);
  }

  async run(
    command: string,
    runner: (command: string) => Promise<string>,
  ): Promise<CommandRepairOutcome> {
    const startedAt = this.now();
    const attempts: CommandRepairAttempt[] = [];
    let current = command;
    let installUsed = false;
    let lastError = "";

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const output = await runner(current);
        attempts.push({ attempt, command: current, timestamp: this.now() });
        this.persist(command, attempts, "recovered", startedAt);
        return {
          status: "recovered",
          command: current,
          output,
          attempts,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        const { classification, missingModule } = classifyCommandFailure(
          `${lastError}\n${current.slice(0, 200)}`,
        );
        attempts.push({
          attempt,
          command: current,
          failureClass: classification,
          error: lastError.slice(0, 2000),
          timestamp: this.now(),
        });
        if (classification === "non_recoverable") {
          this.persist(command, attempts, "non_recoverable", startedAt);
          return { status: "non_recoverable", command: current, attempts };
        }
        // Loop guard: same signature repeating → stop.
        const signature = commandFailureSignature(current, classification);
        const repeats = attempts.filter(
          (a) =>
            a.failureClass !== undefined &&
            commandFailureSignature(a.command ?? "", a.failureClass) ===
              signature,
        ).length;
        if (repeats >= this.maxSameSignatureRepeats) {
          this.persist(command, attempts, "exhausted", startedAt);
          return { status: "exhausted", command: current, attempts };
        }
        const next = planCommandRepair(
          current,
          classification,
          missingModule,
          installUsed,
        );
        if (next === null) {
          this.persist(command, attempts, "exhausted", startedAt);
          return { status: "exhausted", command: current, attempts };
        }
        if (next !== current && current.includes("npm install") === false) {
          installUsed = true;
        }
        current = next;
      }
    }
    this.persist(command, attempts, "exhausted", startedAt);
    return { status: "exhausted", command: current, attempts };
  }

  // ---- Persistence (atomic, bounded, quarantine corrupt files) ----

  private persist(
    command: string,
    attempts: CommandRepairAttempt[],
    status: CommandRepairStatus,
    updatedAt: number,
  ): void {
    this.records.set(command, {
      command,
      attempts,
      status,
      updatedAt,
    });
    // Bound the history (oldest evicted).
    if (this.records.size > this.maxRecords) {
      const oldest = this.listRecords()[0];
      if (oldest) this.records.delete(oldest.command);
    }
    if (this.persistPath === undefined) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const tmp = `${this.persistPath}.tmp-${process.pid}`;
      const payload: PersistShape = {
        version: 1,
        records: this.listRecords(),
      };
      fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
      fs.renameSync(tmp, this.persistPath);
    } catch {
      // Persistence is best-effort — never fail a repair for it.
    }
  }

  private load(): void {
    if (this.persistPath === undefined) return;
    let raw: string;
    try {
      raw = fs.readFileSync(this.persistPath, "utf8");
    } catch {
      return; // No history yet.
    }
    try {
      const parsed = JSON.parse(raw) as PersistShape;
      if (!parsed || !Array.isArray(parsed.records)) {
        throw new Error("invalid shape");
      }
      for (const record of parsed.records) {
        if (
          !record ||
          typeof record.command !== "string" ||
          !Array.isArray(record.attempts)
        ) {
          continue;
        }
        this.records.set(record.command, record);
      }
    } catch {
      try {
        fs.renameSync(
          this.persistPath,
          `${this.persistPath}.corrupt-${this.now()}`,
        );
      } catch {
        // Ignore.
      }
    }
  }
}

export interface TerminalToolFailure {
  toolCallId: string;
  toolName: string;
  input: unknown;
  /** Error text from the failed execution. */
  output: string;
}

export interface TerminalToolRepairDeps {
  loop: CommandRepairLoop;
  /** True when the failed tool is a terminal tool (bash/run_commands). */
  isTerminalTool: (toolName: string) => boolean;
  /** Extract the command text from the tool input (null when unknown). */
  extractCommand: (input: unknown) => string | null;
  /**
   * Execute one repair attempt. Identical command text stays covered by
   * the original approval; transformed text MUST be re-gated by the host
   * (deny-closed) before executing.
   */
  executeRepair: (command: string) => Promise<string>;
}

export type TerminalToolRepairDecision =
  | { action: "none"; reason: string }
  | { action: "repair"; outcome: CommandRepairOutcome };

/**
 * Decide and run a repair for a failed terminal tool call. Returns
 * `{ action: "none" }` when the failure is not repairable (non-terminal
 * tool, unknown command, non-recoverable class, exhausted budget).
 */
export async function runTerminalToolRepair(
  deps: TerminalToolRepairDeps,
  failure: TerminalToolFailure,
): Promise<TerminalToolRepairDecision> {
  if (!deps.isTerminalTool(failure.toolName)) {
    return { action: "none", reason: "not a terminal tool" };
  }
  const command = deps.extractCommand(failure.input);
  if (command === null) {
    return { action: "none", reason: "command text unknown" };
  }
  const outcome = await deps.loop.run(command, deps.executeRepair);
  if (outcome.status === "non_recoverable") {
    return { action: "none", reason: "non-recoverable failure class" };
  }
  return { action: "repair", outcome };
}
