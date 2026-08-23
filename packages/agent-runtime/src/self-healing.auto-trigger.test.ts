import { describe, it, expect, beforeEach } from "vitest";
import {
  classifyError,
  RecoveryManager,
  SelfHealingEngine,
} from "./self-healing.js";
import type { ErrorCategory } from "./self-healing.js";

// ============================================================================
// Error Classification Tests
// ============================================================================

describe("classifyError", () => {
  describe("SECURITY_VIOLATION", () => {
    const securityCases = [
      "path traversal detected: ../../etc/passwd",
      "workspace escape attempt",
      "command injection detected",
      "SSRF protection triggered",
      "unauthorized MCP operation",
      "secret leakage detected",
    ];

    for (const error of securityCases) {
      it(`classifies "${error.substring(0, 40)}..." as SECURITY_VIOLATION`, () => {
        const result = classifyError(error);
        expect(result.category).toBe("SECURITY_VIOLATION");
        expect(result.recoverable).toBe(false);
      });
    }
  });

  describe("NON_RECOVERABLE", () => {
    const nonRecoverableCases = [
      "Permission denied: cannot write to /usr/bin",
      "Access denied: insufficient privileges",
      "Authentication failed: invalid token",
      "Invalid API key provided",
      "Quota exceeded: daily limit reached",
      "ENOSPC: no space left on device",
      "Disk full: cannot write",
      "Out of memory: heap allocation failed",
    ];

    for (const error of nonRecoverableCases) {
      it(`classifies "${error.substring(0, 40)}..." as NON_RECOVERABLE`, () => {
        const result = classifyError(error);
        expect(result.category).toBe("NON_RECOVERABLE");
        expect(result.recoverable).toBe(false);
      });
    }
  });

  describe("REQUIRES_APPROVAL", () => {
    it("classifies approval-required errors correctly", () => {
      const result = classifyError("Tool requires approval from user");
      expect(result.category).toBe("REQUIRES_APPROVAL");
      expect(result.recoverable).toBe(false);
      expect(result.strategy).toBe("user_action");
    });

    it("classifies user approval required", () => {
      const result = classifyError("user approval required for this operation");
      expect(result.category).toBe("REQUIRES_APPROVAL");
      expect(result.recoverable).toBe(false);
    });
  });

  describe("TIMEOUT", () => {
    const timeoutCases = [
      "Command timed out after 120000ms",
      "ETIMEDOUT: connection timed out",
      "Deadline exceeded: operation took too long",
    ];

    for (const error of timeoutCases) {
      it(`classifies "${error.substring(0, 40)}..." as TIMEOUT`, () => {
        const result = classifyError(error);
        expect(result.category).toBe("TIMEOUT");
        expect(result.recoverable).toBe(true);
        expect(result.strategy).toBe("retry");
      });
    }
  });

  describe("TRANSIENT", () => {
    const transientCases = [
      "ECONNREFUSED: connection refused",
      "ECONNRESET: connection reset by peer",
      "socket hang up",
      "Network unreachable",
      "Temporary failure in name resolution",
      "503 Service Unavailable",
      "502 Bad Gateway",
    ];

    for (const error of transientCases) {
      it(`classifies "${error.substring(0, 40)}..." as TRANSIENT`, () => {
        const result = classifyError(error);
        expect(result.category).toBe("TRANSIENT");
        expect(result.recoverable).toBe(true);
        expect(result.strategy).toBe("retry");
      });
    }
  });

  describe("RECOVERABLE (build/test failures)", () => {
    const recoverableCases = [
      { error: "BUILD FAILURE: compilation error in Main.java", exitCode: 1 },
      { error: "Tests failed: 3 of 10 assertions failed", exitCode: 1 },
      {
        error: "error TS2345: Argument of type 'string' is not assignable",
        exitCode: 2,
      },
      { error: "SyntaxError: Unexpected token", exitCode: 1 },
      { error: "ImportError: No module named 'foo'", exitCode: 1 },
      { error: "Module not found: Can't resolve './utils'", exitCode: 1 },
      { error: "Cannot find module '@types/node'", exitCode: 1 },
    ];

    for (const { error, exitCode } of recoverableCases) {
      it(`classifies "${error.substring(0, 40)}..." as RECOVERABLE`, () => {
        const result = classifyError(error, undefined, exitCode);
        expect(result.category).toBe("RECOVERABLE");
        expect(result.recoverable).toBe(true);
        expect(result.strategy).toBe("repair");
      });
    }
  });

  describe("NON_RECOVERABLE (unknown errors)", () => {
    it("classifies unknown errors as non-recoverable by default", () => {
      const result = classifyError("Something completely unexpected happened");
      expect(result.category).toBe("NON_RECOVERABLE");
      expect(result.recoverable).toBe(false);
    });

    it("classifies unknown exit code failures as non-recoverable", () => {
      const result = classifyError("Unknown failure occurred", undefined, 137);
      expect(result.category).toBe("NON_RECOVERABLE");
      expect(result.recoverable).toBe(false);
    });
  });

  describe("reason truncation", () => {
    it("truncates long error messages in reason", () => {
      const longError = "A".repeat(500);
      const result = classifyError(longError);
      expect(result.reason!.length).toBeLessThanOrEqual(250);
    });
  });
});

// ============================================================================
// RecoveryManager Tests
// ============================================================================

describe("RecoveryManager", () => {
  let manager: RecoveryManager;

  beforeEach(() => {
    manager = new RecoveryManager("/tmp/test", {
      maxSessionRecoveries: 5,
      cooldownMs: 100,
    });
  });

  describe("canRecover", () => {
    it("allows recovery for recoverable errors", () => {
      const result = manager.canRecover(
        "BUILD FAILURE: compilation error",
        undefined,
        1,
      );
      expect(result.allowed).toBe(true);
      expect(result.classification.recoverable).toBe(true);
    });

    it("blocks recovery for security violations", () => {
      const result = manager.canRecover("path traversal detected");
      expect(result.allowed).toBe(false);
      expect(result.classification.category).toBe("SECURITY_VIOLATION");
    });

    it("blocks recovery for non-recoverable errors", () => {
      const result = manager.canRecover("Permission denied");
      expect(result.allowed).toBe(false);
    });

    it("blocks recovery when session limit is reached", () => {
      // Record max recoveries
      for (let i = 0; i < 5; i++) {
        manager.record({
          timestamp: Date.now(),
          error: "test error",
          category: "RECOVERABLE",
          strategy: "repair",
          success: false,
        });
      }

      const result = manager.canRecover("BUILD FAILURE", undefined, 1);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Session recovery limit reached");
    });

    it("blocks recovery during cooldown period", () => {
      manager.record({
        timestamp: Date.now(),
        error: "test error",
        category: "RECOVERABLE",
        strategy: "repair",
        success: true,
      });

      // Immediately try again — should be blocked by cooldown
      const result = manager.canRecover("BUILD FAILURE", undefined, 1);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("cooldown");
    });

    it("allows recovery after cooldown expires", async () => {
      manager.record({
        timestamp: Date.now(),
        error: "test error",
        category: "RECOVERABLE",
        strategy: "repair",
        success: true,
      });

      // Wait for cooldown to expire
      await new Promise((r) => setTimeout(r, 150));

      const result = manager.canRecover("BUILD FAILURE", undefined, 1);
      expect(result.allowed).toBe(true);
    });
  });

  describe("record", () => {
    it("records recovery attempts", () => {
      manager.record({
        timestamp: Date.now(),
        error: "test error",
        category: "RECOVERABLE",
        strategy: "repair",
        success: true,
      });

      expect(manager.getAttemptCount()).toBe(1);
      expect(manager.getRecords()).toHaveLength(1);
    });

    it("preserves full recovery history", () => {
      const records = [
        {
          timestamp: Date.now(),
          error: "error 1",
          category: "RECOVERABLE" as ErrorCategory,
          strategy: "repair",
          success: true,
        },
        {
          timestamp: Date.now(),
          error: "error 2",
          category: "TRANSIENT" as ErrorCategory,
          strategy: "retry",
          success: false,
        },
      ];

      for (const record of records) {
        manager.record(record);
      }

      expect(manager.getRecords()).toHaveLength(2);
      expect(manager.getRecords()[0]!.error).toBe("error 1");
      expect(manager.getRecords()[1]!.error).toBe("error 2");
    });
  });

  describe("reset", () => {
    it("clears all recovery state", () => {
      manager.record({
        timestamp: Date.now(),
        error: "test",
        category: "RECOVERABLE",
        strategy: "repair",
        success: true,
      });

      manager.reset();

      expect(manager.getAttemptCount()).toBe(0);
      expect(manager.getRecords()).toHaveLength(0);
    });

    it("allows recovery again after reset when limit was reached", () => {
      for (let i = 0; i < 5; i++) {
        manager.record({
          timestamp: Date.now(),
          error: "test",
          category: "RECOVERABLE",
          strategy: "repair",
          success: false,
        });
      }

      // Should be blocked now
      expect(manager.canRecover("BUILD FAILURE", undefined, 1).allowed).toBe(
        false,
      );

      manager.reset();

      // Should be allowed again
      expect(manager.canRecover("BUILD FAILURE", undefined, 1).allowed).toBe(
        true,
      );
    });
  });

  describe("createHealingEngine", () => {
    it("creates a healing engine with bounded attempts", () => {
      const engine = manager.createHealingEngine(false);
      expect(engine).toBeInstanceOf(SelfHealingEngine);
    });

    it("limits attempts based on remaining session budget", () => {
      // Use up 3 of 5 recoveries
      for (let i = 0; i < 3; i++) {
        manager.record({
          timestamp: Date.now(),
          error: "test",
          category: "RECOVERABLE",
          strategy: "repair",
          success: false,
        });
      }

      const engine = manager.createHealingEngine(false);
      // Engine should have maxAttempts = min(3, 5-3) = 2
      // Verify by running with failures that always fail
      const result = engine.heal(
        { passed: false, exitCode: 1, stderr: "test" },
        async () => ({ passed: false, exitCode: 1 }),
        async () => ({
          diagnosis: "fix",
          repairDescription: "repair",
          filesChanged: [],
        }),
        async () => ({ success: true }),
      );

      return result.then((r) => {
        expect(r.maxAttempts).toBeLessThanOrEqual(2);
      });
    });
  });
});

// ============================================================================
// Integration: RecoveryManager + SelfHealingEngine
// ============================================================================

describe("RecoveryManager + SelfHealingEngine integration", () => {
  it("full recovery flow: classify → canRecover → heal → record", async () => {
    const manager = new RecoveryManager("/tmp/test", {
      maxSessionRecoveries: 5,
      cooldownMs: 0,
    });

    const error = "BUILD FAILURE: error TS2345: type mismatch";
    const classification = classifyError(error, undefined, 1);

    expect(classification.recoverable).toBe(true);
    expect(classification.category).toBe("RECOVERABLE");

    const canRecover = manager.canRecover(error, undefined, 1);
    expect(canRecover.allowed).toBe(true);

    const engine = manager.createHealingEngine(false);
    let validateCalls = 0;
    const result = await engine.heal(
      { passed: false, exitCode: 1, stderr: error },
      async () => {
        validateCalls++;
        return validateCalls >= 2
          ? { passed: true, exitCode: 0 }
          : { passed: false, exitCode: 1, stderr: error };
      },
      async (failure, attempt) => ({
        diagnosis: `Diagnosed: ${failure.stderr}`,
        repairDescription: `Fix attempt ${attempt}`,
        filesChanged: [`fix-${attempt}.ts`],
      }),
      async (_d, _r, files) => ({ success: true, filesChanged: files }),
    );

    expect(result.healed).toBe(true);
    expect(result.attempts).toBe(2);

    manager.record({
      timestamp: Date.now(),
      error,
      category: classification.category,
      strategy: classification.strategy ?? "repair",
      success: true,
      healingResult: result,
    });

    expect(manager.getAttemptCount()).toBe(1);
    expect(manager.getRecords()[0]!.success).toBe(true);
  });

  it("blocked recovery: security violation stops flow", () => {
    const manager = new RecoveryManager("/tmp/test");

    const error = "path traversal detected: ../../etc/passwd";
    const classification = classifyError(error);

    expect(classification.recoverable).toBe(false);
    expect(classification.category).toBe("SECURITY_VIOLATION");

    const canRecover = manager.canRecover(error);
    expect(canRecover.allowed).toBe(false);

    // No healing engine should be created
    expect(manager.getAttemptCount()).toBe(0);
  });

  it("session limit prevents infinite healing", async () => {
    const manager = new RecoveryManager("/tmp/test", {
      maxSessionRecoveries: 2,
      cooldownMs: 0,
    });

    // First two recoveries should work
    for (let i = 0; i < 2; i++) {
      const canRecover = manager.canRecover("BUILD FAILURE", undefined, 1);
      expect(canRecover.allowed).toBe(true);

      const engine = manager.createHealingEngine(false);
      const result = await engine.heal(
        { passed: false, exitCode: 1 },
        async () => ({ passed: false, exitCode: 1 }),
        async () => ({
          diagnosis: "fix",
          repairDescription: "repair",
          filesChanged: [],
        }),
        async () => ({ success: true }),
      );

      manager.record({
        timestamp: Date.now(),
        error: "BUILD FAILURE",
        category: "RECOVERABLE",
        strategy: "repair",
        success: result.healed,
      });
    }

    // Third recovery should be blocked
    const canRecover = manager.canRecover("BUILD FAILURE", undefined, 1);
    expect(canRecover.allowed).toBe(false);
    expect(canRecover.reason).toContain("limit reached");
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe("edge cases", () => {
  it("classifyError handles empty string", () => {
    const result = classifyError("");
    expect(result.category).toBe("NON_RECOVERABLE");
    expect(result.recoverable).toBe(false);
  });

  it("classifyError handles very long error messages", () => {
    const longError = "Error: " + "x".repeat(10000);
    const result = classifyError(longError);
    expect(result.reason!.length).toBeLessThan(300);
  });

  it("RecoveryManager handles concurrent canRecover checks", () => {
    const manager = new RecoveryManager("/tmp/test", {
      maxSessionRecoveries: 3,
      cooldownMs: 0,
    });

    const results = Array.from({ length: 10 }, () =>
      manager.canRecover("BUILD FAILURE", undefined, 1),
    );

    // First 3 should be allowed (before recording)
    const allowedCount = results.filter((r) => r.allowed).length;
    expect(allowedCount).toBe(10); // All allowed since we haven't recorded any yet
  });

  it("classifyError with undefined parameters", () => {
    const result = classifyError("error", undefined, undefined);
    expect(result).toHaveProperty("category");
    expect(result).toHaveProperty("recoverable");
    expect(result).toHaveProperty("reason");
  });
});
