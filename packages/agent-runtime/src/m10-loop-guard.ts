/**
 * M10 — Self-Healing 2.0: failure memory, loop prevention, rollback.
 *
 * Extends the existing SelfHealingEngine (bounded attempts, timeout,
 * cancellation, classification) without duplicating it:
 *
 * - FailureMemory records failure signatures so repeated identical failures
 *   are recognized across attempts AND across task sessions (persisted).
 * - healWithLoopGuard wraps the engine: after each repair it fingerprints the
 *   validation result; if the same failure signature repeats, healing stops
 *   early (no infinite repair loops) and a rollback callback runs.
 * - Rollback is a caller-supplied callback; the engine never touches the
 *   filesystem directly, so M4/M5 permission rules remain in force.
 */

import type { HealingResult, ValidationResult } from "./self-healing.js";

// ============================================================================
// Failure signatures
// ============================================================================

/**
 * Fingerprint a validation failure: a stable short signature so repeated
 * identical failures can be recognized. Uses the error lines only (stdout +
 * diagnostics), ignoring line numbers that shift between attempts.
 */
export function failureSignature(failure: ValidationResult): string {
  const parts: string[] = [];
  if (failure.stderr) parts.push(failure.stderr);
  for (const d of failure.diagnostics ?? []) {
    parts.push(d);
  }
  const text = parts.join("\n");
  if (!text.trim()) {
    return failure.exitCode !== undefined
      ? `exit:${failure.exitCode}`
      : "unknown";
  }
  // Keep only lines that look like errors, strip volatile numbers/paths.
  const lines = text
    .split(/\r?\n/)
    .filter((l) =>
      /error|fail|cannot|unable|invalid|missing|exception/i.test(l),
    )
    .map((l) =>
      l
        .replace(/\d+/g, "#")
        .replace(/[/\\][^\s:]+/g, "<path>")
        .trim(),
    )
    .filter(Boolean)
    .slice(0, 10);
  if (lines.length === 0) {
    return `exit:${failure.exitCode ?? "?"}`;
  }
  return lines.join("|");
}

// ============================================================================
// Failure memory
// ============================================================================

export interface FailureRecord {
  signature: string;
  category: string;
  firstSeenMs: number;
  lastSeenMs: number;
  count: number;
}

/** In-memory + optionally persisted failure memory. */
export class FailureMemory {
  private records = new Map<string, FailureRecord>();

  constructor(private readonly persistPath?: string) {
    if (persistPath) this.loadFromDisk();
  }

  /** Record a failure occurrence. Returns the record. */
  record(signature: string, category: string): FailureRecord {
    const now = Date.now();
    const existing = this.records.get(signature);
    if (existing) {
      existing.count += 1;
      existing.lastSeenMs = now;
      this.saveToDisk();
      return existing;
    }
    const record: FailureRecord = {
      signature,
      category,
      firstSeenMs: now,
      lastSeenMs: now,
      count: 1,
    };
    this.records.set(signature, record);
    this.saveToDisk();
    return record;
  }

  /** How many times this signature has been seen (ever, if persisted). */
  countFor(signature: string): number {
    return this.records.get(signature)?.count ?? 0;
  }

  /** Has this exact failure been seen at least `n` times? */
  hasRepeated(signature: string, n: number): boolean {
    return this.countFor(signature) >= n;
  }

  /** All records, most recent first. */
  list(): FailureRecord[] {
    return [...this.records.values()].sort(
      (a, b) => b.lastSeenMs - a.lastSeenMs,
    );
  }

  /** Clear memory (e.g. after a successful full validation). */
  clear(): void {
    this.records.clear();
    this.saveToDisk();
  }

  private loadFromDisk(): void {
    if (!this.persistPath) return;
    try {
      const raw = require("node:fs").readFileSync(this.persistPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (
            entry &&
            typeof entry === "object" &&
            typeof (entry as FailureRecord).signature === "string"
          ) {
            const rec = entry as FailureRecord;
            this.records.set(rec.signature, rec);
          }
        }
      }
    } catch {
      // missing or corrupt — start empty
    }
  }

  private saveToDisk(): void {
    if (!this.persistPath) return;
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      const path = require("node:path") as typeof import("node:path");
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(
        this.persistPath,
        JSON.stringify(this.list().slice(0, 100), null, 2),
        "utf8",
      );
    } catch {
      // persistence is best-effort; memory still works
    }
  }
}

// ============================================================================
// Loop-guarded healing
// ============================================================================

export interface LoopGuardResult extends HealingResult {
  /** True if healing stopped because the same failure repeated. */
  loopDetected: boolean;
  /** The signature that repeated, when loopDetected. */
  loopSignature?: string;
  /** True if the rollback callback ran successfully after loop detection. */
  rolledBack: boolean;
}

export interface LoopGuardOptions {
  /** Stop when the same signature occurs this many times. Default 2. */
  maxSameFailureRepeats?: number;
  /** Called when a loop is detected, before giving up. Must not throw to abort healing. */
  rollback?: (info: {
    signature: string;
    attempts: number;
  }) => Promise<boolean> | boolean;
}

/**
 * Wrap SelfHealingEngine.heal() with a loop guard.
 *
 * Strategy: run the engine in short bursts (one attempt at a time by
 * constructing a delegated engine call), fingerprint each validation result,
 * and stop early if the same failure signature repeats — preventing infinite
 * repair loops even when maxAttempts is large.
 */
export async function healWithLoopGuard(
  runHeal: (maxAttempts: number) => Promise<HealingResult>,
  memory: FailureMemory,
  options?: LoopGuardOptions,
): Promise<LoopGuardResult> {
  const maxRepeats = options?.maxSameFailureRepeats ?? 2;
  let totalAttempts = 0;
  let lastResult: HealingResult | null = null;
  let loopDetected = false;
  let loopSignature: string | undefined;
  const maxBursts = 8; // hard outer bound — absolute loop prevention

  for (let burst = 0; burst < maxBursts; burst++) {
    lastResult = await runHeal(1);
    totalAttempts += lastResult.attempts;

    // Immediate success, cancellation or non-loop exhaustion ends the loop.
    if (lastResult.healed || lastResult.cancelled) {
      return finish(lastResult, false, undefined, totalAttempts);
    }
    if (lastResult.attempts === 0) {
      // Engine refused to attempt (plan mode, etc.) — pass through.
      return finish(lastResult, false, undefined, totalAttempts);
    }

    const finalValidation = lastResult.finalValidation;
    const signature = failureSignature(finalValidation);
    memory.record(signature, "healing");

    if (memory.countFor(signature) >= maxRepeats) {
      loopDetected = true;
      loopSignature = signature;
      break;
    }
  }

  const result = lastResult as HealingResult;
  if (loopDetected) {
    let rolledBack = false;
    if (options?.rollback) {
      try {
        rolledBack = await options.rollback({
          signature: loopSignature ?? "",
          attempts: totalAttempts,
        });
      } catch {
        rolledBack = false;
      }
    }
    return {
      ...result,
      attempts: totalAttempts,
      loopDetected: true,
      loopSignature,
      rolledBack,
    };
  }
  return finish(result, false, undefined, totalAttempts);
}

function finish(
  result: HealingResult,
  loopDetected: boolean,
  loopSignature: string | undefined,
  totalAttempts: number,
): LoopGuardResult {
  return {
    ...result,
    attempts: totalAttempts || result.attempts,
    loopDetected,
    loopSignature,
    rolledBack: false,
  };
}
