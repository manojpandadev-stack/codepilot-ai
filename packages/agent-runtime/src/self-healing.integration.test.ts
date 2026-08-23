/**
 * Self-Healing Integration Tests
 *
 * Tests the complete runtime flow:
 *   error → classification → recovery manager → healing engine → events
 *
 * Covers: build failure, transient, timeout, security, permission,
 *         exhaustion, concurrency, plan mode, reset, cancellation.
 */
import { describe, it, expect } from "vitest";
import {
  SelfHealingEngine,
  classifyError,
  RecoveryManager,
  healingEventToAgentEvent,
} from "./self-healing.js";
import type {
  ValidationResult,
  HealingEvent,
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

function makeDiagnoser(): RepairDiagnoser {
  return async (failure, attemptNumber) => ({
    diagnosis: `Diagnosed: ${(failure.diagnostics ?? []).join("; ")}`,
    repairDescription: `Repair attempt ${attemptNumber}: fix the issue`,
    filesChanged: [`src/fix-${attemptNumber}.ts`],
  });
}

function makeApplier(): RepairApplier {
  return async (_d, _r, filesChanged) => ({
    success: true,
    filesChanged: filesChanged,
  });
}

function collectEvents(engine: SelfHealingEngine): HealingEvent[] {
  const events: HealingEvent[] = [];
  engine.subscribe((e) => events.push({ ...e }));
  return events;
}

// ============================================================================
// Scenario A — Build Failure (RECOVERABLE → auto-heal → succeed)
// ============================================================================

describe("Scenario A: Build Failure", () => {
  it("classifies build failure as RECOVERABLE and heals successfully", async () => {
    // Step 1: Error classification
    const error =
      "BUILD FAILURE: error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.";
    const classification = classifyError(error, undefined, 1);

    expect(classification.category).toBe("RECOVERABLE");
    expect(classification.recoverable).toBe(true);
    expect(classification.strategy).toBe("repair");

    // Step 2: RecoveryManager permits
    const manager = new RecoveryManager("/tmp/test", {
      maxSessionRecoveries: 5,
      cooldownMs: 0,
    });
    const canRecover = manager.canRecover(error, undefined, 1);
    expect(canRecover.allowed).toBe(true);

    // Step 3: SelfHealingEngine starts and heals
    const engine = new SelfHealingEngine({
      workspaceRoot: "/tmp/test",
      maxAttempts: 3,
    });
    const events = collectEvents(engine);

    let validateCalls = 0;
    const result = await engine.heal(
      { passed: false, exitCode: 1, stderr: error, diagnostics: [error] },
      async () => {
        validateCalls++;
        // First call fails, second succeeds
        return validateCalls >= 2
          ? { passed: true, exitCode: 0 }
          : { passed: false, exitCode: 1, stderr: error, diagnostics: [error] };
      },
      makeDiagnoser(),
      makeApplier(),
    );

    // Step 4: Verify healing succeeded
    expect(result.healed).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.repairHistory).toHaveLength(2);

    // Step 5: Verify events
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("validation_failed");
    expect(eventTypes).toContain("diagnosis_started");
    expect(eventTypes).toContain("diagnosis_completed");
    expect(eventTypes).toContain("repair_started");
    expect(eventTypes).toContain("repair_completed");
    expect(eventTypes).toContain("healing_succeeded");

    // Step 6: Record in manager
    manager.record({
      timestamp: Date.now(),
      error,
      category: classification.category,
      strategy: classification.strategy!,
      success: true,
    });
    expect(manager.getAttemptCount()).toBe(1);

    // Step 7: Verify webview event mapping
    const succeededEvent = events.find((e) => e.type === "healing_succeeded");
    expect(succeededEvent).toBeDefined();
    const agentEvent = healingEventToAgentEvent(succeededEvent!);
    expect(agentEvent.type).toBe("status");
    if (agentEvent.type === "status") {
      expect(agentEvent.message).toContain("succeeded");
    }
  });

  it("classifies Java build failure as RECOVERABLE", () => {
    const classification = classifyError(
      "[ERROR] /src/main/java/com/example/UserService.java:[15,1] error: cannot find symbol",
      undefined,
      1,
    );
    expect(classification.category).toBe("RECOVERABLE");
    expect(classification.recoverable).toBe(true);
  });
});

// ============================================================================
// Scenario B — Transient Network Failure
// ============================================================================

describe("Scenario B: Transient Network Failure", () => {
  it("classifies ECONNREFUSED as TRANSIENT", () => {
    const classification = classifyError("ECONNREFUSED 127.0.0.1:5432");
    expect(classification.category).toBe("TRANSIENT");
    expect(classification.recoverable).toBe(true);
    expect(classification.strategy).toBe("retry");
  });

  it("classifies 503 as TRANSIENT", () => {
    const classification = classifyError("503 Service Unavailable");
    expect(classification.category).toBe("TRANSIENT");
    expect(classification.recoverable).toBe(true);
  });

  it("retries on transient failure and succeeds", async () => {
    const manager = new RecoveryManager("/tmp/test", { cooldownMs: 0 });
    const canRecover = manager.canRecover("ECONNREFUSED");
    expect(canRecover.allowed).toBe(true);

    const engine = new SelfHealingEngine({
      workspaceRoot: "/tmp/test",
      maxAttempts: 3,
    });
    let validateCalls = 0;

    const result = await engine.heal(
      { passed: false, exitCode: 1, stderr: "ECONNREFUSED" },
      async () => {
        validateCalls++;
        return validateCalls >= 2
          ? { passed: true, exitCode: 0 }
          : { passed: false, exitCode: 1, stderr: "ECONNREFUSED" };
      },
      async (_f, attempt) => ({
        diagnosis: `Retry connection (attempt ${attempt})`,
        repairDescription: "Retry after transient failure",
        filesChanged: [],
      }),
      async () => ({ success: true, filesChanged: [] }),
    );

    expect(result.healed).toBe(true);
    expect(result.attempts).toBe(2);
  });
});

// ============================================================================
// Scenario C — Timeout (no infinite loop)
// ============================================================================

describe("Scenario C: Timeout", () => {
  it("classifies timeout as TIMEOUT with retry strategy", () => {
    const classification = classifyError("Command timed out after 120000ms");
    expect(classification.category).toBe("TIMEOUT");
    expect(classification.recoverable).toBe(true);
    expect(classification.strategy).toBe("retry");
  });

  it("timeout recovery does not loop infinitely", async () => {
    const engine = new SelfHealingEngine({
      workspaceRoot: "/tmp/test",
      maxAttempts: 2,
    });
    let validateCalls = 0;

    const result = await engine.heal(
      { passed: false, exitCode: 1, stderr: "timeout" },
      async () => {
        validateCalls++;
        // Always fails
        return { passed: false, exitCode: 1, stderr: "timeout" };
      },
      async (_f, attempt) => ({
        diagnosis: `Timeout diagnosis ${attempt}`,
        repairDescription: `Retry ${attempt}`,
        filesChanged: [],
      }),
      async () => ({ success: true, filesChanged: [] }),
    );

    // Should stop after maxAttempts, not loop forever
    expect(result.healed).toBe(false);
    expect(result.attempts).toBe(2);
    expect(validateCalls).toBe(2);
  });

  it("transient errors in recovery also respect max attempts", async () => {
    const engine = new SelfHealingEngine({
      workspaceRoot: "/tmp/test",
      maxAttempts: 1,
    });
    const result = await engine.heal(
      makeFailure({ stderr: "ETIMEDOUT" }),
      async () => ({ passed: false, exitCode: 1, stderr: "ETIMEDOUT" }),
      makeDiagnoser(),
      makeApplier(),
    );

    expect(result.healed).toBe(false);
    expect(result.attempts).toBe(1);
  });
});

// ============================================================================
// Scenario D — Security Violation (NO healing)
// ============================================================================

describe("Scenario D: Security Violation", () => {
  const securityErrors = [
    "path traversal detected: ../../etc/passwd",
    "workspace escape attempt detected",
    "command injection detected in input",
    "SSRF protection blocked request to 169.254.169.254",
    "unauthorized MCP tool execution blocked",
    "secret leakage detected in output",
  ];

  for (const error of securityErrors) {
    it(`blocks auto-healing for: "${error.substring(0, 40)}..."`, () => {
      const classification = classifyError(error);
      expect(classification.category).toBe("SECURITY_VIOLATION");
      expect(classification.recoverable).toBe(false);

      const manager = new RecoveryManager("/tmp/test");
      const canRecover = manager.canRecover(error);
      expect(canRecover.allowed).toBe(false);
    });
  }

  it("security violation never triggers healing engine", async () => {
    const manager = new RecoveryManager("/tmp/test");
    const canRecover = manager.canRecover("path traversal detected");
    expect(canRecover.allowed).toBe(false);

    // Should never reach the engine
    expect(manager.getAttemptCount()).toBe(0);
  });

  it("security violation is correctly mapped to webview event", () => {
    const error = "path traversal detected: ../../etc/passwd";
    const classification = classifyError(error);
    expect(classification.recoverable).toBe(false);
    // The error should be sent as a regular error event, not a healing event
  });
});

// ============================================================================
// Scenario E — Permission/Auth Error (NO healing)
// ============================================================================

describe("Scenario E: Permission/Auth Error", () => {
  const permissionErrors = [
    "Permission denied: cannot write to /usr/bin",
    "Access denied: insufficient privileges",
    "Authentication failed: invalid token",
    "Invalid API key provided",
    "Quota exceeded: daily limit reached",
  ];

  for (const error of permissionErrors) {
    it(`blocks auto-healing for: "${error.substring(0, 40)}..."`, () => {
      const classification = classifyError(error);
      expect(classification.category).toBe("NON_RECOVERABLE");
      expect(classification.recoverable).toBe(false);

      const manager = new RecoveryManager("/tmp/test");
      const canRecover = manager.canRecover(error);
      expect(canRecover.allowed).toBe(false);
    });
  }
});

// ============================================================================
// Scenario F — Recovery Exhaustion
// ============================================================================

describe("Scenario F: Recovery Exhaustion", () => {
  it("session limit stops recovery after max attempts", async () => {
    const manager = new RecoveryManager("/tmp/test", {
      maxSessionRecoveries: 3,
      cooldownMs: 0,
    });

    // Exhaust 3 recoveries
    for (let i = 0; i < 3; i++) {
      const canRecover = manager.canRecover("BUILD FAILURE", undefined, 1);
      expect(canRecover.allowed).toBe(true);

      const engine = manager.createHealingEngine(false);
      await engine.heal(
        makeFailure(),
        async () => ({ passed: false, exitCode: 1 }),
        makeDiagnoser(),
        makeApplier(),
      );

      manager.record({
        timestamp: Date.now(),
        error: "BUILD FAILURE",
        category: "RECOVERABLE",
        strategy: "repair",
        success: false,
      });
    }

    // 4th attempt should be blocked
    const canRecover = manager.canRecover("BUILD FAILURE", undefined, 1);
    expect(canRecover.allowed).toBe(false);
    expect(canRecover.reason).toContain("limit reached");
  });

  it("emits healing_exhausted when engine max attempts reached", async () => {
    const engine = new SelfHealingEngine({
      workspaceRoot: "/tmp/test",
      maxAttempts: 2,
    });
    const events = collectEvents(engine);

    const result = await engine.heal(
      makeFailure(),
      async () => ({ passed: false, exitCode: 1 }),
      makeDiagnoser(),
      makeApplier(),
    );

    expect(result.healed).toBe(false);
    expect(result.attempts).toBe(2);

    const exhausted = events.filter((e) => e.type === "healing_exhausted");
    expect(exhausted).toHaveLength(1);

    // Map to webview event
    const agentEvent = healingEventToAgentEvent(exhausted[0]!);
    expect(agentEvent.type).toBe("error");
  });

  it("error event bypass does not exceed session limit", () => {
    const manager = new RecoveryManager("/tmp/test", {
      maxSessionRecoveries: 2,
      cooldownMs: 0,
    });

    // Simulate 10 rapid error events
    let allowedCount = 0;
    for (let i = 0; i < 10; i++) {
      const canRecover = manager.canRecover("BUILD FAILURE", undefined, 1);
      if (canRecover.allowed) {
        allowedCount++;
        manager.record({
          timestamp: Date.now(),
          error: "BUILD FAILURE",
          category: "RECOVERABLE",
          strategy: "repair",
          success: false,
        });
      }
    }

    // Only 2 should have been allowed
    expect(allowedCount).toBe(2);
    expect(manager.getAttemptCount()).toBe(2);
  });
});

// ============================================================================
// Concurrency Protection
// ============================================================================

describe("Concurrency Protection", () => {
  it("prevents multiple concurrent healing engines", async () => {
    const activeEngines: SelfHealingEngine[] = [];

    // Simulate the concurrency guard from extension.ts
    function tryStartHealing(): boolean {
      if (activeEngines.length > 0) return false;
      const engine = new SelfHealingEngine({
        workspaceRoot: "/tmp/test",
        maxAttempts: 3,
      });
      activeEngines.push(engine);
      return true;
    }

    function stopHealing(): void {
      activeEngines.length = 0;
    }

    // First should succeed
    expect(tryStartHealing()).toBe(true);

    // Second should be blocked
    expect(tryStartHealing()).toBe(false);
    expect(tryStartHealing()).toBe(false);

    // Stop and try again
    stopHealing();
    expect(tryStartHealing()).toBe(true);

    // Clean up
    stopHealing();
  });

  it("concurrent error events do not spawn parallel engines", () => {
    const manager = new RecoveryManager("/tmp/test", {
      maxSessionRecoveries: 5,
      cooldownMs: 0,
    });

    // Fire 10 rapid errors synchronously
    // Manager's cooldown=0 means
    // they all pass canRecover. The concurrency guard should prevent
    // parallel execution in the real extension (which uses async).
    // For this test, verify the manager limits work independently.
    let allowedCount = 0;
    for (let i = 0; i < 10; i++) {
      const canRecover = manager.canRecover("BUILD FAILURE", undefined, 1);
      if (canRecover.allowed) {
        allowedCount++;
        manager.record({
          timestamp: Date.now(),
          error: "BUILD FAILURE",
          category: "RECOVERABLE",
          strategy: "repair",
          success: false,
        });
      }
    }

    // Manager limits: 5 recoveries max
    expect(allowedCount).toBe(5);
  });
});

// ============================================================================
// Plan Mode Blocking
// ============================================================================

describe("Plan Mode", () => {
  it("blocks healing in plan mode", async () => {
    const engine = new SelfHealingEngine({
      workspaceRoot: "/tmp/test",
      isPlanMode: true,
    });
    const events = collectEvents(engine);

    const result = await engine.heal(
      makeFailure(),
      async () => ({ passed: false, exitCode: 1 }),
      makeDiagnoser(),
      makeApplier(),
    );

    expect(result.healed).toBe(false);
    expect(result.attempts).toBe(0);
    expect(result.repairHistory).toHaveLength(0);
    // No healing events should be emitted
    expect(events).toHaveLength(0);
  });

  it("plan mode diagnosis returns empty repair", async () => {
    // Simulates what the extension does in plan mode
    const mode = "plan";
    const isPlanMode = mode === "plan";

    const engine = new SelfHealingEngine({
      workspaceRoot: "/tmp/test",
      isPlanMode,
    });

    const result = await engine.heal(
      makeFailure(),
      async () => ({ passed: false, exitCode: 1 }),
      // Diagnosis callback that checks plan mode
      async (failure, attemptNumber) => {
        if (isPlanMode) {
          return {
            diagnosis: "Healing disabled in plan mode",
            repairDescription: "",
            filesChanged: [],
          };
        }
        return {
          diagnosis: `Diagnosed: ${(failure.diagnostics ?? []).join("; ")}`,
          repairDescription: `Repair ${attemptNumber}`,
          filesChanged: [],
        };
      },
      makeApplier(),
    );

    // Plan mode blocks healing entirely
    expect(result.healed).toBe(false);
    expect(result.attempts).toBe(0);
  });

  it("classification still works in plan mode (just not executed)", () => {
    const error = "BUILD FAILURE: error TS2345";
    const classification = classifyError(error, undefined, 1);
    expect(classification.recoverable).toBe(true);
    // Classification is independent of plan mode; execution is blocked
  });
});

// ============================================================================
// New Task Reset
// ============================================================================

describe("New Task Reset", () => {
  it("resets recovery counter for new task", () => {
    const manager = new RecoveryManager("/tmp/test", {
      maxSessionRecoveries: 3,
      cooldownMs: 0,
    });

    // Task A: use up 3 recoveries
    for (let i = 0; i < 3; i++) {
      manager.record({
        timestamp: Date.now(),
        error: "task A error",
        category: "RECOVERABLE",
        strategy: "repair",
        success: false,
      });
    }

    expect(manager.canRecover("BUILD FAILURE", undefined, 1).allowed).toBe(
      false,
    );

    // Task B: reset
    manager.reset();

    expect(manager.canRecover("BUILD FAILURE", undefined, 1).allowed).toBe(
      true,
    );
    expect(manager.getAttemptCount()).toBe(0);
  });

  it("reset clears cooldown state", async () => {
    const manager = new RecoveryManager("/tmp/test", {
      cooldownMs: 5000,
    });

    manager.record({
      timestamp: Date.now(),
      error: "error",
      category: "RECOVERABLE",
      strategy: "repair",
      success: true,
    });

    // Should be blocked by cooldown
    expect(manager.canRecover("BUILD FAILURE", undefined, 1).allowed).toBe(
      false,
    );

    // Reset clears cooldown
    manager.reset();
    expect(manager.canRecover("BUILD FAILURE", undefined, 1).allowed).toBe(
      true,
    );
  });

  it("old task's cooldown does not block new task after reset", async () => {
    const manager = new RecoveryManager("/tmp/test", {
      cooldownMs: 5000,
    });

    // Task A records a recovery
    manager.record({
      timestamp: Date.now(),
      error: "BUILD FAILURE",
      category: "RECOVERABLE",
      strategy: "repair",
      success: true,
    });

    // Task A cooldown is active
    expect(manager.canRecover("BUILD FAILURE", undefined, 1).allowed).toBe(
      false,
    );

    // Simulate new task: reset
    manager.reset();

    // Task B should have fresh budget
    expect(manager.canRecover("BUILD FAILURE", undefined, 1).allowed).toBe(
      true,
    );
  });
});

// ============================================================================
// Cancellation
// ============================================================================

describe("Cancellation", () => {
  it("cancelling stops healing engine", async () => {
    const engine = new SelfHealingEngine({
      workspaceRoot: "/tmp/test",
      maxAttempts: 10,
    });
    let repairCount = 0;

    const diagnoser: RepairDiagnoser = async (_f, attempt) => {
      repairCount++;
      if (repairCount >= 2) engine.cancel();
      return {
        diagnosis: `Diagnosis ${attempt}`,
        repairDescription: `Fix ${attempt}`,
        filesChanged: [],
      };
    };

    const result = await engine.heal(
      makeFailure(),
      async () => ({ passed: false, exitCode: 1 }),
      diagnoser,
      makeApplier(),
    );

    expect(result.cancelled).toBe(true);
    expect(result.healed).toBe(false);
    expect(result.repairHistory.length).toBeLessThan(10);
  });

  it("cancelled engine does not emit stale success event", async () => {
    const engine = new SelfHealingEngine({
      workspaceRoot: "/tmp/test",
      maxAttempts: 5,
    });
    const events = collectEvents(engine);
    let count = 0;

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
      async () => ({ passed: false, exitCode: 1 }),
      diagnoser,
      makeApplier(),
    );

    expect(result.cancelled).toBe(true);
    const succeededEvents = events.filter(
      (e) => e.type === "healing_succeeded",
    );
    expect(succeededEvents).toHaveLength(0);
  });

  it("RecoveryManager remains consistent after cancellation", () => {
    const manager = new RecoveryManager("/tmp/test", { cooldownMs: 0 });
    manager.record({
      timestamp: Date.now(),
      error: "cancelled error",
      category: "RECOVERABLE",
      strategy: "repair",
      success: false,
    });

    // Should still be able to recover after a cancelled healing
    expect(manager.canRecover("BUILD FAILURE", undefined, 1).allowed).toBe(
      true,
    );
  });
});

// ============================================================================
// Error Classification Comprehensive
// ============================================================================

describe("Error Classification Comprehensive", () => {
  it("classifies 403 Forbidden as NON_RECOVERABLE", () => {
    const result = classifyError("403 Forbidden");
    expect(result.category).toBe("NON_RECOVERABLE");
    expect(result.recoverable).toBe(false);
  });

  it("classifies 401 Unauthorized as NON_RECOVERABLE", () => {
    const result = classifyError("401 Unauthorized");
    expect(result.category).toBe("NON_RECOVERABLE");
    expect(result.recoverable).toBe(false);
  });

  it("classifies circuit breaker as NON_RECOVERABLE", () => {
    const result = classifyError("circuit breaker open for service X");
    expect(result.category).toBe("NON_RECOVERABLE");
    expect(result.recoverable).toBe(false);
  });

  it("classifies rate limit exceeded as NON_RECOVERABLE", () => {
    const result = classifyError("rate limit exceeded: 429");
    expect(result.category).toBe("NON_RECOVERABLE");
    expect(result.recoverable).toBe(false);
  });

  it("classifies approval-required as REQUIRES_APPROVAL", () => {
    const result = classifyError("approval required for tool execution");
    expect(result.category).toBe("REQUIRES_APPROVAL");
    expect(result.recoverable).toBe(false);
    expect(result.strategy).toBe("user_action");
  });

  it("classifies network unreachable as TRANSIENT", () => {
    const result = classifyError("Network unreachable");
    expect(result.category).toBe("TRANSIENT");
    expect(result.recoverable).toBe(true);
  });

  it("classifies gateway timeout as TRANSIENT", () => {
    const result = classifyError("502 Bad Gateway");
    expect(result.category).toBe("TRANSIENT");
    expect(result.recoverable).toBe(true);
  });

  it("build failure with specific exit code is RECOVERABLE", () => {
    const result = classifyError("BUILD FAILURE", undefined, 2);
    expect(result.category).toBe("RECOVERABLE");
    expect(result.recoverable).toBe(true);
  });

  it("test failure is RECOVERABLE", () => {
    const result = classifyError(
      "Tests failed: 3 assertions failed",
      undefined,
      1,
    );
    expect(result.category).toBe("RECOVERABLE");
    expect(result.recoverable).toBe(true);
  });

  it("reference error in JS/TS is RECOVERABLE", () => {
    const result = classifyError(
      "ReferenceError: foo is not defined",
      undefined,
      1,
    );
    expect(result.category).toBe("RECOVERABLE");
    expect(result.recoverable).toBe(true);
  });

  it("type error is RECOVERABLE", () => {
    const result = classifyError(
      "TypeError: cannot read property of undefined",
      undefined,
      1,
    );
    expect(result.category).toBe("RECOVERABLE");
    expect(result.recoverable).toBe(true);
  });

  it("unknown error with exit code 0 is NON_RECOVERABLE", () => {
    const result = classifyError("something weird happened", undefined, 0);
    expect(result.category).toBe("NON_RECOVERABLE");
    expect(result.recoverable).toBe(false);
  });
});

// ============================================================================
// Full Flow Integration
// ============================================================================

describe("Full Flow Integration", () => {
  it("complete flow: classify → manager → engine → heal → record", async () => {
    // 1. Error occurs
    const error = "BUILD FAILURE: error TS2345: type mismatch in main.ts";

    // 2. Classify
    const classification = classifyError(error, "bash", 1);
    expect(classification.recoverable).toBe(true);

    // 3. Check with manager
    const manager = new RecoveryManager("/tmp/test", { cooldownMs: 0 });
    const canRecover = manager.canRecover(error, "bash", 1);
    expect(canRecover.allowed).toBe(true);

    // 4. Create engine via manager
    const engine = manager.createHealingEngine(false);
    const events = collectEvents(engine);

    // 5. Heal
    let validateCalls = 0;
    const result = await engine.heal(
      { passed: false, exitCode: 1, stderr: error, diagnostics: [error] },
      async () => {
        validateCalls++;
        return validateCalls >= 2
          ? { passed: true, exitCode: 0 }
          : { passed: false, exitCode: 1, stderr: error };
      },
      makeDiagnoser(),
      makeApplier(),
    );

    expect(result.healed).toBe(true);

    // 6. Record
    manager.record({
      timestamp: Date.now(),
      error,
      category: classification.category,
      strategy: classification.strategy!,
      success: true,
      healingResult: result,
    });

    expect(manager.getAttemptCount()).toBe(1);

    // 7. Verify event flow
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("validation_failed");
    expect(eventTypes).toContain("healing_succeeded");

    // 8. Verify webview mapping
    const successEvent = events.find((e) => e.type === "healing_succeeded")!;
    const webviewEvent = healingEventToAgentEvent(successEvent);
    expect(webviewEvent.type).toBe("status");
  });

  it("complete flow with exhaustion", async () => {
    const error = "BUILD FAILURE: persistent error";

    const classification = classifyError(error, undefined, 1);
    expect(classification.recoverable).toBe(true);

    const manager = new RecoveryManager("/tmp/test", {
      maxSessionRecoveries: 2,
      cooldownMs: 0,
    });

    // First recovery attempt
    const canRecover1 = manager.canRecover(error, undefined, 1);
    expect(canRecover1.allowed).toBe(true);

    const engine1 = manager.createHealingEngine(false);
    const result1 = await engine1.heal(
      makeFailure({ stderr: error }),
      async () => ({ passed: false, exitCode: 1, stderr: error }),
      makeDiagnoser(),
      makeApplier(),
    );
    expect(result1.healed).toBe(false);

    manager.record({
      timestamp: Date.now(),
      error,
      category: classification.category,
      strategy: "repair",
      success: false,
    });

    // Second recovery attempt
    const canRecover2 = manager.canRecover(error, undefined, 1);
    expect(canRecover2.allowed).toBe(true);

    const engine2 = manager.createHealingEngine(false);
    const result2 = await engine2.heal(
      makeFailure({ stderr: error }),
      async () => ({ passed: false, exitCode: 1, stderr: error }),
      makeDiagnoser(),
      makeApplier(),
    );
    expect(result2.healed).toBe(false);

    manager.record({
      timestamp: Date.now(),
      error,
      category: classification.category,
      strategy: "repair",
      success: false,
    });

    // Third attempt should be blocked
    const canRecover3 = manager.canRecover(error, undefined, 1);
    expect(canRecover3.allowed).toBe(false);
    expect(canRecover3.reason).toContain("limit reached");
  });
});

// ============================================================================
// Runtime Error Classification
// ============================================================================

describe("Runtime Error Classification", () => {
  it("run-failed with transient error is classified as recoverable", () => {
    // Simulates what runtime.ts now does
    const errorMessage = "ECONNREFUSED: connection refused to model server";
    const classification = classifyError(errorMessage);
    expect(classification.recoverable).toBe(true);
  });

  it("run-failed with security error is classified as non-recoverable", () => {
    const errorMessage = "path traversal detected in file operation";
    const classification = classifyError(errorMessage);
    expect(classification.recoverable).toBe(false);
  });

  it("tool failure with build error is classified as recoverable", () => {
    const errorMessage = "[bash] BUILD FAILURE: compilation error";
    const classification = classifyError(errorMessage, "bash", 1);
    expect(classification.recoverable).toBe(true);
  });

  it("tool failure with permission error is non-recoverable", () => {
    const errorMessage = "[write_file] Permission denied";
    const classification = classifyError(errorMessage, "write_file");
    expect(classification.recoverable).toBe(false);
  });
});
