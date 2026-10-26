/**
 * Failure classifier — deterministic classification tests (Agent 2, Phase 11).
 *
 * Covers required cases 1–5 (build/test/typecheck/runtime/timeout) plus the
 * remaining categories, the recoverability policy, determinism, and secret
 * redaction of classification evidence. No live LLM, no network.
 */
import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  failureRegressionSignature,
  type FailureSignal,
} from "./failure-classifier.js";

describe("failure classification — required categories", () => {
  it("1. classifies a build failure", () => {
    const result = classifyFailure({
      command: "npm run build",
      exitCode: 1,
      stderr: "Failed to compile.\nERROR in ./src/app.ts\nbuild failed",
    });
    expect(result.category).toBe("BUILD_FAILURE");
    expect(result.recoverable).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it("1b. classifies a Maven BUILD FAILURE as build", () => {
    const result = classifyFailure({
      command: "mvn -q package",
      exitCode: 1,
      stderr:
        "[ERROR] COMPILATION ERROR \n[ERROR] /src/App.java:[12,5] cannot find symbol\nBUILD FAILURE",
    });
    expect(result.category).toBe("BUILD_FAILURE");
  });

  it("2. classifies a test failure", () => {
    const result = classifyFailure({
      command: "npm test",
      exitCode: 1,
      stdout:
        "FAIL src/add.test.ts\nAssertionError: expected -0 to be 4\n  at Object.<anonymous> (src/add.test.ts:7:20)",
    });
    expect(result.category).toBe("TEST_FAILURE");
    expect(result.recoverable).toBe(true);
  });

  it("2b. classifies pytest failures as test failures", () => {
    const result = classifyFailure({
      command: "pytest -q",
      exitCode: 1,
      stderr: "FAILED tests/test_add.py::test_add - assert 0 == 4\n1 failed",
    });
    expect(result.category).toBe("TEST_FAILURE");
  });

  it("3. classifies a typecheck failure", () => {
    const result = classifyFailure({
      command: "npx tsc --noEmit",
      exitCode: 2,
      stderr:
        "src/main.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    });
    expect(result.category).toBe("TYPECHECK_FAILURE");
    expect(result.recoverable).toBe(true);
  });

  it("4. classifies a runtime failure (JS)", () => {
    const result = classifyFailure({
      command: "node app.js",
      exitCode: 1,
      stderr:
        "Uncaught TypeError: add is not a function\n    at Object.<anonymous> (/app/app.js:5:1)",
    });
    expect(result.category).toBe("RUNTIME_FAILURE");
    expect(result.recoverable).toBe(true);
  });

  it("4b. classifies a runtime failure (Python traceback)", () => {
    const result = classifyFailure({
      command: "python app.py",
      exitCode: 1,
      stderr:
        'Traceback (most recent call last):\n  File "app.py", line 3, in <module>\n    main()\nRuntimeError: boom',
    });
    expect(result.category).toBe("RUNTIME_FAILURE");
  });

  it("5. classifies an executor-reported timeout as TIMEOUT", () => {
    const result = classifyFailure({
      command: "npm test",
      exitCode: null,
      timedOut: true,
      stderr: "some output that would otherwise match other classes",
    });
    expect(result.category).toBe("TIMEOUT");
    expect(result.recoverable).toBe(true);
  });

  it("5b. classifies exit code 124 as TIMEOUT", () => {
    const result = classifyFailure({ command: "slow.sh", exitCode: 124 });
    expect(result.category).toBe("TIMEOUT");
  });
});

describe("failure classification — remaining categories", () => {
  it("classifies network failures (and never auto-repairs them)", () => {
    const result = classifyFailure({
      command: "curl https://example.com",
      exitCode: 6,
      stderr: "curl: (6) Could not resolve host: example.com",
    });
    expect(result.category).toBe("NETWORK_FAILURE");
    expect(result.recoverable).toBe(false);
  });

  it("classifies dependency failures as recoverable", () => {
    const result = classifyFailure({
      command: "node index.js",
      exitCode: 1,
      stderr: "Error: Cannot find module 'left-pad'",
    });
    expect(result.category).toBe("DEPENDENCY_FAILURE");
    expect(result.recoverable).toBe(true);
  });

  it("classifies lint failures", () => {
    const result = classifyFailure({
      command: "npm run lint",
      exitCode: 1,
      stdout:
        "eslint src/a.ts\n  3:1  error  'x' is defined but never used  no-unused-vars\n✖ 1 problem (1 error, 0 warnings)",
    });
    expect(result.category).toBe("LINT_FAILURE");
    expect(result.recoverable).toBe(true);
  });

  it("classifies a failing shell command with no known shape", () => {
    const result = classifyFailure({
      command: "./deploy.sh",
      exitCode: 3,
      stderr: "deployment exploded",
    });
    expect(result.category).toBe("COMMAND_FAILURE");
    expect(result.recoverable).toBe(true);
  });

  it("classifies tool-layer failures and never auto-repairs them", () => {
    const result = classifyFailure({
      toolName: "read_files",
      toolError: true,
      output: "something structurally odd happened",
    });
    expect(result.category).toBe("TOOL_FAILURE");
    expect(result.recoverable).toBe(false);
  });

  it("defaults to UNKNOWN_FAILURE and never auto-repairs it", () => {
    const result = classifyFailure({ output: "hm" });
    expect(result.category).toBe("UNKNOWN_FAILURE");
    expect(result.recoverable).toBe(false);
  });

  it("terminal conditions override recoverability (permission denied)", () => {
    const result = classifyFailure({
      command: "./run.sh",
      exitCode: 126,
      stderr: "bash: ./run.sh: Permission denied",
    });
    expect(result.category).toBe("COMMAND_FAILURE");
    expect(result.recoverable).toBe(false);
    expect(result.reason).toContain("Non-recoverable terminal condition");
  });

  it("terminal conditions override recoverability (quota)", () => {
    const result = classifyFailure({
      command: "npm test",
      exitCode: 1,
      stderr: "HTTP 429 — quota exceeded for this billing period",
    });
    expect(result.recoverable).toBe(false);
  });
});

describe("failure classification — determinism & safety", () => {
  it("is deterministic: identical signals classify identically", () => {
    const signal: FailureSignal = {
      command: "npm test",
      exitCode: 1,
      stdout: "FAIL src/x.test.ts\nAssertionError: expected 1 to be 2",
    };
    const a = classifyFailure(signal);
    const b = classifyFailure(signal);
    expect(a).toEqual(b);
  });

  it("never leaks secrets in the classification reason", () => {
    const result = classifyFailure({
      output: "api_key=abc123secretvalue\nboom happened",
    });
    expect(result.reason).not.toContain("abc123secretvalue");
    expect(result.reason).toContain("[REDACTED]");
  });

  it("bounds the evidence it reports", () => {
    const result = classifyFailure({
      command: "npm test",
      exitCode: 1,
      stderr: `AssertionError: ${"x".repeat(50_000)}`,
    });
    expect(result.reason.length).toBeLessThanOrEqual(400);
    expect((result.evidence ?? "").length).toBeLessThanOrEqual(160);
  });

  it("prefers executor flags over content patterns", () => {
    const result = classifyFailure({
      command: "npm test",
      exitCode: 1,
      timedOut: true,
      stdout: "FAIL src/x.test.ts\nAssertionError: expected 1 to be 2",
    });
    expect(result.category).toBe("TIMEOUT");
  });
});

describe("failureRegressionSignature — regression awareness", () => {
  const base = {
    category: "TEST_FAILURE" as const,
    text: "AssertionError: expected -0 to be 4 at src/add.test.ts",
    files: ["src/add.test.ts"],
  };

  it("is stable when only line numbers shift", () => {
    const a = failureRegressionSignature(base);
    const b = failureRegressionSignature({
      ...base,
      text: "AssertionError: expected -0 to be 4 at src/add.test.ts:99:12",
    });
    expect(a).toBe(b);
  });

  it("differs when the failing file differs", () => {
    const a = failureRegressionSignature(base);
    const b = failureRegressionSignature({
      ...base,
      files: ["src/other.test.ts"],
    });
    expect(a).not.toBe(b);
  });

  it("differs when the failure category differs", () => {
    const a = failureRegressionSignature(base);
    const b = failureRegressionSignature({
      ...base,
      category: "TYPECHECK_FAILURE",
    });
    expect(a).not.toBe(b);
  });

  it("differs when the error message differs", () => {
    const a = failureRegressionSignature(base);
    const b = failureRegressionSignature({
      ...base,
      text: "ReferenceError: total is not defined",
      files: [],
    });
    expect(a).not.toBe(b);
  });
});
