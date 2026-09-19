/**
 * M10 — Loop guard tests: failure signatures, failure memory (incl.
 * persistence), loop prevention and rollback.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  FailureMemory,
  failureSignature,
  healWithLoopGuard,
} from "./m10-loop-guard.js";
import type { HealingResult, ValidationResult } from "./self-healing.js";

function failure(stderr: string, exitCode = 1): ValidationResult {
  return { passed: false, stdout: "", stderr, diagnostics: [stderr], exitCode };
}

function healingResult(overrides: Partial<HealingResult>): HealingResult {
  return {
    healed: false,
    attempts: 1,
    maxAttempts: 1,
    repairHistory: [],
    originalFailure: failure("TSError: cannot find name 'x'"),
    finalValidation: failure("TSError: cannot find name 'x'"),
    durationMs: 5,
    cancelled: false,
    ...overrides,
  };
}

describe("M10 failureSignature", () => {
  it("produces identical signatures for the same logical failure", () => {
    // Same missing identifier at different paths/lines → same signature.
    const a = failure("src/a.ts(12,5): error TS2304: Cannot find name 'x'");
    const b = failure("src/b.ts(77,9): error TS2304: Cannot find name 'x'");
    expect(failureSignature(a)).toBe(failureSignature(b));
  });

  it("distinguishes genuinely different failures", () => {
    const a = failure("error TS2304: Cannot find name 'x'");
    const b = failure("error TS2571: Object is possibly 'undefined'");
    expect(failureSignature(a)).not.toBe(failureSignature(b));
  });

  it("strips volatile numbers and paths", () => {
    const sig = failureSignature(failure("error at /tmp/x/y.ts: line 42"));
    expect(sig).not.toContain("/tmp");
    expect(sig).not.toContain("42");
    expect(sig).toContain("#");
  });

  it("falls back to exit code when no error lines exist", () => {
    expect(failureSignature(failure("", 3))).toBe("exit:3");
  });
});

describe("M10 FailureMemory", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-m10-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("counts repeated signatures", () => {
    const memory = new FailureMemory();
    memory.record("sig-a", "healing");
    memory.record("sig-a", "healing");
    memory.record("sig-b", "healing");
    expect(memory.countFor("sig-a")).toBe(2);
    expect(memory.countFor("sig-b")).toBe(1);
    expect(memory.countFor("sig-c")).toBe(0);
    expect(memory.hasRepeated("sig-a", 2)).toBe(true);
    expect(memory.hasRepeated("sig-b", 2)).toBe(false);
  });

  it("persists counts and reloads them in a new instance", () => {
    const file = path.join(dir, "failures.json");
    const first = new FailureMemory(file);
    first.record("sig-a", "healing");
    first.record("sig-a", "healing");

    const second = new FailureMemory(file);
    expect(second.countFor("sig-a")).toBe(2);
  });

  it("starts empty on corrupt persistence", () => {
    const file = path.join(dir, "failures.json");
    fs.writeFileSync(file, "{corrupt!!", "utf8");
    const memory = new FailureMemory(file);
    expect(memory.countFor("anything")).toBe(0);
  });

  it("clear resets counts and disk", () => {
    const file = path.join(dir, "failures.json");
    const memory = new FailureMemory(file);
    memory.record("sig-a", "healing");
    memory.clear();
    expect(new FailureMemory(file).countFor("sig-a")).toBe(0);
  });
});

describe("M10 healWithLoopGuard", () => {
  it("passes through an immediate success", async () => {
    const memory = new FailureMemory();
    const result = await healWithLoopGuard(
      () => Promise.resolve(healingResult({ healed: true, attempts: 1 })),
      memory,
    );
    expect(result.healed).toBe(true);
    expect(result.loopDetected).toBe(false);
    expect(result.rolledBack).toBe(false);
  });

  it("stops and rolls back when the same failure repeats", async () => {
    const memory = new FailureMemory();
    const rollbacks: number[] = [];
    const result = await healWithLoopGuard(
      () =>
        Promise.resolve(
          healingResult({
            healed: false,
            attempts: 1,
            finalValidation: failure("error TS2304: Cannot find name 'x'"),
          }),
        ),
      memory,
      {
        rollback: ({ attempts }) => {
          rollbacks.push(attempts);
          return true;
        },
      },
    );
    expect(result.loopDetected).toBe(true);
    expect(result.loopSignature).toBeTruthy();
    expect(result.rolledBack).toBe(true);
    expect(rollbacks).toHaveLength(1);
  });

  it("allows a different failure each attempt to continue within burst cap", async () => {
    const memory = new FailureMemory();
    let call = 0;
    const words = [
      "alpha",
      "beta",
      "gamma",
      "delta",
      "epsilon",
      "zeta",
      "eta",
      "theta",
      "iota",
    ];
    const result = await healWithLoopGuard(() => {
      call += 1;
      return Promise.resolve(
        healingResult({
          healed: false,
          attempts: 1,
          finalValidation: failure(
            `unique failure word ${words[call] ?? "overflow"}`,
          ),
        }),
      );
    }, memory);
    expect(result.loopDetected).toBe(false);
    expect(result.attempts).toBe(8); // maxBursts
  });

  it("propagates cancellation without rollback", async () => {
    const memory = new FailureMemory();
    let rollbackCalled = false;
    const result = await healWithLoopGuard(
      () => Promise.resolve(healingResult({ cancelled: true, attempts: 1 })),
      memory,
      {
        rollback: () => {
          rollbackCalled = true;
          return true;
        },
      },
    );
    expect(result.cancelled).toBe(true);
    expect(rollbackCalled).toBe(false);
  });

  it("survives a throwing rollback callback", async () => {
    const memory = new FailureMemory();
    const result = await healWithLoopGuard(
      () =>
        Promise.resolve(
          healingResult({
            finalValidation: failure("error TS2304: Cannot find name 'x'"),
          }),
        ),
      memory,
      {
        rollback: () => {
          throw new Error("rollback crashed");
        },
      },
    );
    expect(result.loopDetected).toBe(true);
    expect(result.rolledBack).toBe(false);
  });

  it("passes through zero-attempt refusals (plan mode)", async () => {
    const memory = new FailureMemory();
    const result = await healWithLoopGuard(
      () => Promise.resolve(healingResult({ attempts: 0, healed: false })),
      memory,
    );
    expect(result.attempts).toBe(0);
    expect(result.loopDetected).toBe(false);
  });
});
