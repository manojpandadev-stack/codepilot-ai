import { describe, it, expect } from "vitest";
import {
  SelfHealingEngine,
  healingEventToAgentEvent,
  createCommandValidator,
} from "./self-healing.js";
import type {
  ValidationResult,
  HealingEvent,
  ValidationRunner,
  RepairDiagnoser,
  RepairApplier,
} from "./self-healing.js";

// ============================================================================
// Helpers
// ============================================================================

function makeFailure(overrides?: Partial<ValidationResult>): ValidationResult {
  return {
    passed: false,
    command: "npm test",
    exitCode: 1,
    stdout: "",
    stderr: "FAIL src/app.test.ts\n  Expected 1, received 2",
    diagnostics: ["FAIL src/app.test.ts"],
    durationMs: 100,
    ...overrides,
  };
}

function makePassingValidation(): ValidationRunner {
  return async () => ({
    passed: true,
    command: "npm test",
    exitCode: 0,
    stdout: "All tests passed",
    stderr: "",
    diagnostics: [],
    durationMs: 50,
  });
}

function makeFailThenPassValidation(failOnAttempt: number): {
  validate: ValidationRunner;
  callCount: () => number;
} {
  let callCount = 0;
  return {
    validate: async () => {
      callCount++;
      if (callCount < failOnAttempt) {
        return makeFailure();
      }
      return { passed: true, exitCode: 0, durationMs: 50 };
    },
    callCount: () => callCount,
  };
}

function makeDiagnoser(): RepairDiagnoser {
  return async (failure, attemptNumber) => ({
    diagnosis: `Diagnosed: ${(failure.diagnostics ?? []).join("; ")}`,
    repairDescription: `Repair attempt ${attemptNumber}: fix the issue`,
    filesChanged: [`src/fix-${attemptNumber}.ts`],
  });
}

function makeApplier(): RepairApplier {
  return async (_diagnosis, _repairDescription, filesChanged) => ({
    success: true,
    filesChanged,
  });
}

function collectEvents(engine: SelfHealingEngine): HealingEvent[] {
  const events: HealingEvent[] = [];
  engine.subscribe((e) => events.push({ ...e }));
  return events;
}

// ============================================================================
// SelfHealingEngine — Validation passes immediately
// ============================================================================
describe("SelfHealingEngine", () => {
  describe("validation passes immediately", () => {
    it("returns healed=true with 0 attempts when initial validation passes", async () => {
      const engine = new SelfHealingEngine({ workspaceRoot: "/tmp/test" });
      const result = await engine.heal(
        { passed: true, exitCode: 0 },
        makePassingValidation(),
        makeDiagnoser(),
        makeApplier(),
      );

      expect(result.healed).toBe(true);
      expect(result.attempts).toBe(0);
      expect(result.repairHistory).toHaveLength(0);
    });

    it("emits no healing events when validation passes", async () => {
      const engine = new SelfHealingEngine({ workspaceRoot: "/tmp/test" });
      const events = collectEvents(engine);

      await engine.heal(
        { passed: true, exitCode: 0 },
        makePassingValidation(),
        makeDiagnoser(),
        makeApplier(),
      );

      // No validation_failed → no healing events
      expect(events).toHaveLength(0);
    });
  });

  describe("one failed validation followed by successful repair", () => {
    it("returns healed=true after repair attempts", async () => {
      const engine = new SelfHealingEngine({ workspaceRoot: "/tmp/test" });
      const { validate, callCount } = makeFailThenPassValidation(2); // fail 1st, pass on 2nd

      const result = await engine.heal(
        makeFailure(),
        validate,
        makeDiagnoser(),
        makeApplier(),
      );

      expect(result.healed).toBe(true);
      expect(result.attempts).toBe(2);
      expect(result.repairHistory).toHaveLength(2);
      // Second attempt passes validation
      expect(result.repairHistory[1]!.success).toBe(true);
      expect(result.repairHistory[1]!.filesChanged).toContain("src/fix-2.ts");
      expect(callCount()).toBe(2);
    });

    it("emits the full healing lifecycle events", async () => {
      const engine = new SelfHealingEngine({ workspaceRoot: "/tmp/test" });
      const events = collectEvents(engine);
      const { validate } = makeFailThenPassValidation(2);

      await engine.heal(
        makeFailure(),
        validate,
        makeDiagnoser(),
        makeApplier(),
      );

      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("validation_failed");
      expect(eventTypes).toContain("diagnosis_started");
      expect(eventTypes).toContain("diagnosis_completed");
      expect(eventTypes).toContain("repair_started");
      expect(eventTypes).toContain("repair_completed");
      expect(eventTypes).toContain("validation_started");
      expect(eventTypes).toContain("healing_succeeded");
    });
  });

  describe("multiple repair attempts", () => {
    it("continues until validation passes or max attempts reached", async () => {
      const engine = new SelfHealingEngine({
        workspaceRoot: "/tmp/test",
        maxAttempts: 3,
      });
      // Always fail
      const validate: ValidationRunner = async () => makeFailure();
      let repairCount = 0;
      const diagnose: RepairDiagnoser = async (_f, attempt) => {
        repairCount++;
        return {
          diagnosis: `Diagnosis ${attempt}`,
          repairDescription: `Fix ${attempt}`,
          filesChanged: [`file-${attempt}.ts`],
        };
      };

      const result = await engine.heal(
        makeFailure(),
        validate,
        diagnose,
        makeApplier(),
      );

      expect(result.healed).toBe(false);
      expect(result.attempts).toBe(3);
      expect(result.repairHistory).toHaveLength(3);
      expect(repairCount).toBe(3);
      // Applier succeeded but validation still failed — all records have success=false
      expect(result.repairHistory.every((r) => r.success === false)).toBe(true);
      // Validation still failed
      expect(result.finalValidation.passed).toBe(false);
    });
  });

  describe("maximum retry limit", () => {
    it("respects maxAttempts config", async () => {
      const engine = new SelfHealingEngine({
        workspaceRoot: "/tmp/test",
        maxAttempts: 1,
      });
      const { validate } = makeFailThenPassValidation(100); // never passes

      const result = await engine.heal(
        makeFailure(),
        validate,
        makeDiagnoser(),
        makeApplier(),
      );

      expect(result.healed).toBe(false);
      expect(result.attempts).toBe(1);
      expect(result.maxAttempts).toBe(1);
      expect(result.repairHistory).toHaveLength(1);
    });

    it("emits healing_exhausted when all attempts fail", async () => {
      const engine = new SelfHealingEngine({
        workspaceRoot: "/tmp/test",
        maxAttempts: 2,
      });
      const events = collectEvents(engine);
      const validate: ValidationRunner = async () => makeFailure();

      await engine.heal(
        makeFailure(),
        validate,
        makeDiagnoser(),
        makeApplier(),
      );

      const exhausted = events.filter((e) => e.type === "healing_exhausted");
      expect(exhausted).toHaveLength(1);
      expect(exhausted[0]!.maxAttempts).toBe(2);
    });
  });

  describe("repair failure", () => {
    it("continues to next attempt when applier fails", async () => {
      const engine = new SelfHealingEngine({
        workspaceRoot: "/tmp/test",
        maxAttempts: 3,
      });
      let attemptCount = 0;
      const validate: ValidationRunner = async () => makeFailure();

      const flakyApplier: RepairApplier = async () => {
        attemptCount++;
        if (attemptCount === 1) {
          return { success: false, error: "Patch conflict" };
        }
        return { success: true };
      };

      const result = await engine.heal(
        makeFailure(),
        validate,
        makeDiagnoser(),
        flakyApplier,
      );

      expect(result.healed).toBe(false); // validation still fails
      expect(result.repairHistory).toHaveLength(3);
      // First attempt should have failed (applier error)
      expect(result.repairHistory[0]!.success).toBe(false);
      expect(result.repairHistory[0]!.error).toContain("Patch conflict");
    });
  });

  describe("command failure / diagnosis failure", () => {
    it("continues to next attempt when diagnosis throws", async () => {
      const engine = new SelfHealingEngine({
        workspaceRoot: "/tmp/test",
        maxAttempts: 2,
      });
      let diagnoseCount = 0;
      const validate: ValidationRunner = async () => makeFailure();

      const flakyDiagnoser: RepairDiagnoser = async (_f, _attempt) => {
        diagnoseCount++;
        if (diagnoseCount === 1) {
          throw new Error("LLM API timeout");
        }
        return {
          diagnosis: "Fixed diagnosis",
          repairDescription: "Fixed repair",
          filesChanged: ["fixed.ts"],
        };
      };

      const result = await engine.heal(
        makeFailure(),
        validate,
        flakyDiagnoser,
        makeApplier(),
      );

      expect(result.healed).toBe(false);
      expect(result.repairHistory).toHaveLength(2);
      // First attempt: diagnosis failed
      expect(result.repairHistory[0]!.success).toBe(false);
      expect(result.repairHistory[0]!.error).toContain("LLM API timeout");
      // Second attempt: diagnosis succeeded but validation still fails
      expect(result.repairHistory[1]!.success).toBe(false);
    });
  });

  describe("malformed diagnostics", () => {
    it("handles empty diagnostics gracefully", async () => {
      const engine = new SelfHealingEngine({ workspaceRoot: "/tmp/test" });
      const { validate } = makeFailThenPassValidation(2);

      const result = await engine.heal(
        makeFailure({ diagnostics: [], stderr: "" }),
        validate,
        makeDiagnoser(),
        makeApplier(),
      );

      expect(result.healed).toBe(true);
      expect(result.repairHistory[0]!.diagnosis).toContain("Diagnosed:");
    });

    it("handles undefined diagnostics", async () => {
      const engine = new SelfHealingEngine({ workspaceRoot: "/tmp/test" });
      const { validate } = makeFailThenPassValidation(2);

      const result = await engine.heal(
        makeFailure({ diagnostics: undefined }),
        validate,
        makeDiagnoser(),
        makeApplier(),
      );

      expect(result.healed).toBe(true);
    });
  });

  describe("cancellation during healing", () => {
    it("stops healing when cancelled", async () => {
      const engine = new SelfHealingEngine({
        workspaceRoot: "/tmp/test",
        maxAttempts: 5,
      });
      let repairCount = 0;
      const validate: ValidationRunner = async () => makeFailure();

      const slowDiagnoser: RepairDiagnoser = async (_f, attempt) => {
        repairCount++;
        if (repairCount >= 2) {
          engine.cancel(); // Cancel after 2nd diagnosis
        }
        return {
          diagnosis: `Diagnosis ${attempt}`,
          repairDescription: `Fix ${attempt}`,
          filesChanged: [`file-${attempt}.ts`],
        };
      };

      const result = await engine.heal(
        makeFailure(),
        validate,
        slowDiagnoser,
        makeApplier(),
      );

      expect(result.cancelled).toBe(true);
      expect(result.healed).toBe(false);
      expect(result.repairHistory.length).toBeLessThan(5);
    });

    it("emits cancelled state correctly", async () => {
      const engine = new SelfHealingEngine({
        workspaceRoot: "/tmp/test",
        maxAttempts: 5,
      });
      let count = 0;
      const validate: ValidationRunner = async () => makeFailure();

      const diagnoser: RepairDiagnoser = async (_f, attempt) => {
        count++;
        if (count >= 3) engine.cancel();
        return {
          diagnosis: `D${attempt}`,
          repairDescription: `R${attempt}`,
          filesChanged: [],
        };
      };

      const result = await engine.heal(
        makeFailure(),
        validate,
        diagnoser,
        makeApplier(),
      );

      expect(result.cancelled).toBe(true);
    });
  });

  describe("plan mode restrictions", () => {
    it("blocks healing in plan mode", async () => {
      const engine = new SelfHealingEngine({
        workspaceRoot: "/tmp/test",
        isPlanMode: true,
      });
      const events = collectEvents(engine);
      const validate: ValidationRunner = async () => makeFailure();

      const result = await engine.heal(
        makeFailure(),
        validate,
        makeDiagnoser(),
        makeApplier(),
      );

      expect(result.healed).toBe(false);
      expect(result.attempts).toBe(0);
      expect(result.repairHistory).toHaveLength(0);
      expect(result.cancelled).toBe(false);
      // No healing events should be emitted
      expect(events).toHaveLength(0);
    });
  });

  describe("act mode behavior", () => {
    it("allows healing in act mode (default)", async () => {
      const engine = new SelfHealingEngine({
        workspaceRoot: "/tmp/test",
        isPlanMode: false,
      });
      const { validate } = makeFailThenPassValidation(2);

      const result = await engine.heal(
        makeFailure(),
        validate,
        makeDiagnoser(),
        makeApplier(),
      );

      expect(result.healed).toBe(true);
      expect(result.attempts).toBe(2);
    });
  });

  describe("event data", () => {
    it("includes attempt numbers and max attempts in all events", async () => {
      const engine = new SelfHealingEngine({
        workspaceRoot: "/tmp/test",
        maxAttempts: 2,
      });
      const events = collectEvents(engine);
      const { validate } = makeFailThenPassValidation(3);

      await engine.heal(
        makeFailure(),
        validate,
        makeDiagnoser(),
        makeApplier(),
      );

      for (const event of events) {
        expect(event.maxAttempts).toBe(2);
        expect(typeof event.attempt).toBe("number");
        expect(typeof event.timestamp).toBe("number");
      }
    });

    it("includes diagnostics in validation_failed event", async () => {
      const engine = new SelfHealingEngine({ workspaceRoot: "/tmp/test" });
      const events = collectEvents(engine);

      await engine.heal(
        makeFailure({ diagnostics: ["error TS2345"] }),
        makePassingValidation(),
        makeDiagnoser(),
        makeApplier(),
      );

      const failedEvent = events.find((e) => e.type === "validation_failed");
      expect(failedEvent).toBeDefined();
      expect(failedEvent!.data).toBeDefined();
      expect(failedEvent!.data!.diagnostics).toEqual(["error TS2345"]);
    });
  });

  describe("healing result", () => {
    it("includes original failure in result", async () => {
      const engine = new SelfHealingEngine({ workspaceRoot: "/tmp/test" });
      const original = makeFailure({ exitCode: 42 });

      const result = await engine.heal(
        original,
        makePassingValidation(),
        makeDiagnoser(),
        makeApplier(),
      );

      expect(result.originalFailure).toEqual(original);
    });

    it("tracks duration", async () => {
      const engine = new SelfHealingEngine({ workspaceRoot: "/tmp/test" });

      const result = await engine.heal(
        makeFailure(),
        makePassingValidation(),
        makeDiagnoser(),
        makeApplier(),
      );

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.durationMs).toBe("number");
    });
  });

  describe("subscribe/unsubscribe", () => {
    it("stops receiving events after unsubscribe", async () => {
      const engine = new SelfHealingEngine({ workspaceRoot: "/tmp/test" });
      const events: HealingEvent[] = [];
      const unsub = engine.subscribe((e) => events.push({ ...e }));

      unsub();

      const { validate } = makeFailThenPassValidation(2);
      await engine.heal(
        makeFailure(),
        validate,
        makeDiagnoser(),
        makeApplier(),
      );

      expect(events).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("handles healing with maxAttempts=0", async () => {
      const engine = new SelfHealingEngine({
        workspaceRoot: "/tmp/test",
        maxAttempts: 0,
      });

      const result = await engine.heal(
        makeFailure(),
        makePassingValidation(),
        makeDiagnoser(),
        makeApplier(),
      );

      expect(result.healed).toBe(false);
      expect(result.attempts).toBe(0);
    });
  });
});

// ============================================================================
// healingEventToAgentEvent adapter
// ============================================================================
describe("healingEventToAgentEvent", () => {
  it("maps validation_failed to status event", () => {
    const agentEvent = healingEventToAgentEvent({
      type: "validation_failed",
      attempt: 0,
      maxAttempts: 3,
      timestamp: Date.now(),
    });
    expect(agentEvent.type).toBe("status");
  });

  it("maps healing_succeeded to status event", () => {
    const agentEvent = healingEventToAgentEvent({
      type: "healing_succeeded",
      attempt: 1,
      maxAttempts: 3,
      timestamp: Date.now(),
      data: { attempts: 1, durationMs: 500 },
    });
    expect(agentEvent.type).toBe("status");
    expect(agentEvent.type === "status" && agentEvent.message).toContain(
      "succeeded",
    );
  });

  it("maps healing_exhausted to error event", () => {
    const agentEvent = healingEventToAgentEvent({
      type: "healing_exhausted",
      attempt: 3,
      maxAttempts: 3,
      timestamp: Date.now(),
    });
    expect(agentEvent.type).toBe("error");
  });

  it("maps repair_failed to error event", () => {
    const agentEvent = healingEventToAgentEvent({
      type: "repair_failed",
      attempt: 1,
      maxAttempts: 3,
      timestamp: Date.now(),
      data: { error: "timeout" },
    });
    expect(agentEvent.type).toBe("error");
    expect(agentEvent.type === "error" && agentEvent.error).toContain(
      "timeout",
    );
  });

  it("maps repair_completed to file_changed event", () => {
    const agentEvent = healingEventToAgentEvent({
      type: "repair_completed",
      attempt: 1,
      maxAttempts: 3,
      timestamp: Date.now(),
      data: { filesChanged: ["src/app.ts"] },
    });
    expect(agentEvent.type).toBe("file_changed");
  });
});

// ============================================================================
// createCommandValidator
// ============================================================================
describe("createCommandValidator", () => {
  it("returns passed=true for a successful command", async () => {
    const validate = createCommandValidator("echo hello", "/tmp");
    const result = await validate();

    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
  });
  it("returns passed=false for a failing command", async () => {
    const validate = createCommandValidator(
      "node -e throw new Error('test error')",
      "/tmp",
    );
    const result = await validate();

    expect(result.passed).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  it("returns diagnostics for commands with stderr output", async () => {
    const validate = createCommandValidator(
      "node -e 'console.error(\"error TS2345: type mismatch\"); process.exit(1)'",
      "/tmp",
    );
    const result = await validate();

    expect(result.passed).toBe(false);
    expect(result.diagnostics).toBeDefined();
    expect(result.diagnostics!.length).toBeGreaterThan(0);
  });
});
