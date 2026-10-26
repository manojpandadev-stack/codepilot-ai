/**
 * Diagnostic context — construction, truncation, and secret redaction
 * (Agent 2, Phase 11, cases 6–8). Deterministic; no network, no LLM.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_STDOUT_CHARS,
  MAX_AFFECTED_FILES,
  buildDiagnosticContext,
  extractAffectedFiles,
  formatDiagnosticContext,
  truncateBounded,
} from "./diagnostic-context.js";

describe("6. diagnostic context construction", () => {
  it("carries command, exit code, duration, category, files, and ChangeSet", () => {
    const ctx = buildDiagnosticContext(
      {
        command: "npm test",
        toolName: "bash",
        exitCode: 1,
        stdout: "FAIL src/add.test.ts\nAssertionError: expected -0 to be 4",
        stderr: "    at Object.<anonymous> (src/add.test.ts:7:20)",
        durationMs: 1234,
      },
      {
        attempt: 1,
        previousChangeSet: {
          changeSetId: "cs-42",
          status: "applied",
          files: ["src/other.ts"],
        },
      },
    );
    expect(ctx.category).toBe("TEST_FAILURE");
    expect(ctx.reason).toContain("TEST_FAILURE");
    expect(ctx.command).toBe("npm test");
    expect(ctx.toolName).toBe("bash");
    expect(ctx.exitCode).toBe(1);
    expect(ctx.durationMs).toBe(1234);
    expect(ctx.attempt).toBe(1);
    expect(ctx.affectedFiles).toContain("src/add.test.ts");
    expect(ctx.previousChangeSet?.changeSetId).toBe("cs-42");
    expect(ctx.previousChangeSet?.files).toEqual(["src/other.ts"]);
    expect(ctx.truncated).toBe(false);
    expect(ctx.redacted).toBe(false);
  });

  it("formats a compact, honest prompt block", () => {
    const ctx = buildDiagnosticContext({
      command: "npm test",
      exitCode: 1,
      stdout: "AssertionError: expected -0 to be 4",
    });
    const block = formatDiagnosticContext(ctx);
    expect(block).toContain("FAILURE [TEST_FAILURE]");
    expect(block).toContain("Command: npm test");
    expect(block).toContain("exit 1");
    expect(block).toContain("--- stdout ---");
    expect(block).toContain("expected -0 to be 4");
  });
});

describe("7. output truncation", () => {
  it("truncates huge stdout with an explicit marker", () => {
    const huge = "A".repeat(20_000);
    const ctx = buildDiagnosticContext(
      { command: "npm test", exitCode: 1, stdout: huge },
      { maxStdoutChars: 1_000 },
    );
    expect(ctx.truncated).toBe(true);
    expect(ctx.stdout).toContain("…[truncated");
    expect(ctx.stdout.length).toBeLessThan(huge.length);
    // The marker must state how much was elided.
    expect(ctx.stdout).toMatch(/truncated \d+ chars/);
  });

  it("keeps both head and tail of a truncated stream", () => {
    const text = `HEAD${"x".repeat(5_000)}TAIL`;
    const result = truncateBounded(text, 500);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith("HEAD")).toBe(true);
    expect(result.text.endsWith("TAIL")).toBe(true);
    expect(result.text).toContain("truncated");
  });

  it("does not truncate output within the limit", () => {
    const result = truncateBounded("short output", 1_000);
    expect(result).toEqual({ text: "short output", truncated: false });
  });

  it("bounds the formatted block even for large contexts", () => {
    const ctx = buildDiagnosticContext(
      {
        command: "npm test",
        exitCode: 1,
        stdout: "x".repeat(4_000),
        stderr: "y".repeat(6_000),
      },
      { maxStdoutChars: DEFAULT_MAX_STDOUT_CHARS },
    );
    const block = formatDiagnosticContext(ctx);
    expect(block.length).toBeLessThanOrEqual(16_000 + 60);
  });
});

describe("8. secret redaction", () => {
  it("redacts credentials from stdout and stderr", () => {
    const ctx = buildDiagnosticContext({
      command: "npm test",
      exitCode: 1,
      stdout:
        "api_key=abc123secretvalue\nAuthorization: Bearer sk-abcdefghijklmnop",
      stderr: "password: hunter2secret",
    });
    expect(ctx.redacted).toBe(true);
    expect(ctx.stdout).not.toContain("abc123secretvalue");
    expect(ctx.stdout).not.toContain("sk-abcdefghijklmnop");
    expect(ctx.stderr).not.toContain("hunter2secret");
    expect(ctx.stdout).toContain("[REDACTED]");
  });

  it("redaction happens BEFORE truncation (secrets never survive a cut)", () => {
    const secret = "sk-abcdefghijklmnop";
    const filler = "z".repeat(900);
    const ctx = buildDiagnosticContext(
      { command: "npm test", exitCode: 1, stdout: `${filler} ${secret}` },
      { maxStdoutChars: 500 },
    );
    expect(ctx.truncated).toBe(true);
    expect(ctx.stdout).not.toContain(secret);
    expect(ctx.stdout).toContain("[REDACTED]");
  });

  it("never leaks secrets through the formatted prompt block", () => {
    const ctx = buildDiagnosticContext({
      command: "npm test",
      exitCode: 1,
      stderr: "token=ghp_abcdefghijklmnopqrstuv",
    });
    const block = formatDiagnosticContext(ctx);
    expect(block).not.toContain("ghp_abcdefghijklmnopqrstuv");
    expect(block).toContain("[REDACTED]");
  });
});

describe("affected file extraction", () => {
  it("extracts file:line references with extensions", () => {
    const files = extractAffectedFiles(
      "    at Object.<anonymous> (src/add.test.ts:7:20)\n",
    );
    expect(files).toContain("src/add.test.ts");
  });

  it("extracts FAIL-line files without line numbers", () => {
    const files = extractAffectedFiles("FAIL src/add.test.ts");
    expect(files).toContain("src/add.test.ts");
  });

  it("extracts Maven/Gradle java ranges", () => {
    const files = extractAffectedFiles(
      "[ERROR] /src/main/java/App.java:[12,5] bad thing",
    );
    expect(files.join(" ")).toContain("App.java");
  });

  it("skips vendored trees and URLs, dedupes, and bounds the count", () => {
    const noisy = [
      "see https://example.com/error:1",
      "node_modules/pkg/index.js:1:1 broken",
      "src/a.ts:1:1 broken",
      "src/a.ts:2:2 broken",
      ...Array.from(
        { length: MAX_AFFECTED_FILES + 5 },
        (_, i) => `src/f${i}.ts:1:1 broken`,
      ),
    ].join("\n");
    const files = extractAffectedFiles(noisy);
    expect(files.some((f) => f.includes("example.com"))).toBe(false);
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    expect(files.filter((f) => f === "src/a.ts")).toHaveLength(1);
    expect(files.length).toBeLessThanOrEqual(MAX_AFFECTED_FILES);
  });
});
