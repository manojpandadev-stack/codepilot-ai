/**
 * Verification Engine tests — evidence, not agent claims.
 *
 * Covers the required matrix: per-check statuses (passed / failed /
 * cancelled / timeout / not_available), conservative overall verdicts,
 * missing-evidence handling, and the strict rule that a timeout or a
 * cancellation can NEVER become PASSED. The production executor path
 * (CommandExecutionService) is exercised with real short node processes.
 *
 * M4 boundary: verification is host-initiated presentation infrastructure.
 * It spawns commands through the same CommandExecutionService every gated
 * tool uses, runs only in the workspace root, and introduces NO new
 * approval-bypass path: it never touches the M4 gate, never auto-approves
 * an agent tool call, and the engine itself is not reachable from model
 * tool calls (no AgentTool wrapper is registered for it).
 */

import { describe, expect, it } from "vitest";
import {
  aggregateVerificationVerdict,
  planVerification,
  runVerification,
  runVerificationCheck,
  safeCommandExecutor,
  type VerificationExecutor,
} from "./verification-engine.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function outcome(over: {
  exitCode?: number | null;
  timedOut?: boolean;
  cancelled?: boolean;
  stdout?: string;
  stderr?: string;
}): Awaited<ReturnType<VerificationExecutor>> {
  return {
    // Explicit null must survive: a null exit code is a distinct honest
    // outcome (spawn-level failure), never coerced to 0.
    exitCode: over.exitCode !== undefined ? over.exitCode : 0,
    timedOut: over.timedOut ?? false,
    cancelled: over.cancelled ?? false,
    stdout: over.stdout ?? "",
    stderr: over.stderr ?? "",
  };
}

function executorOf(
  map: Record<string, Awaited<ReturnType<VerificationExecutor>>>,
): VerificationExecutor {
  return async (command) => {
    const key = command.join(" ");
    const hit = map[key] ?? map[command[0] ?? ""];
    if (!hit) throw new Error(`unexpected command: ${key}`);
    return hit;
  };
}

function tmpWorkspace(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-verify-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, "utf8");
  }
  return dir;
}

const PKG = JSON.stringify({
  name: "ws",
  scripts: {
    test: "node test.js",
    build: "node build.js",
    typecheck: "tsc --noEmit",
  },
});

// ---------------------------------------------------------------------------
// Planning — conservative detection, never guessing
// ---------------------------------------------------------------------------

describe("planVerification", () => {
  it("plans declared scripts via the detected package manager", () => {
    const dir = tmpWorkspace({
      "package.json": PKG,
      "pnpm-lock.yaml": "",
    });
    const plan = planVerification(dir, { packageJson: JSON.parse(PKG) });
    expect(plan.checks.map((c) => c.type)).toEqual([
      "typecheck",
      "build",
      "tests",
    ]);
    expect(plan.checks.every((c) => c.command[0] === "pnpm")).toBe(true);
    expect(plan.skipped.some((s) => s.type === "security")).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("skips undeclared checks as not-applicable instead of guessing", () => {
    const dir = tmpWorkspace({ "package.json": JSON.stringify({ name: "x" }) });
    const plan = planVerification(dir, {
      packageJson: JSON.parse(
        fs.readFileSync(path.join(dir, "package.json"), "utf8"),
      ),
    });
    expect(plan.checks).toHaveLength(0);
    expect(plan.skipped.map((s) => s.type).sort()).toEqual([
      "build",
      "security",
      "tests",
      "typecheck",
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("an empty directory plans nothing", () => {
    const dir = tmpWorkspace({});
    const plan = planVerification(dir);
    expect(plan.checks).toHaveLength(0);
    expect(plan.skipped.length).toBeGreaterThan(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("detects Maven and Gradle workspaces", () => {
    const mvn = tmpWorkspace({ "pom.xml": "<project/>" });
    expect(planVerification(mvn).checks[0]?.command).toEqual([
      "mvn",
      "-q",
      "test",
    ]);
    fs.rmSync(mvn, { recursive: true, force: true });
    const gradle = tmpWorkspace({ "build.gradle": "" });
    expect(planVerification(gradle).checks[0]?.command).toEqual([
      "gradle",
      "test",
      "--console=plain",
    ]);
    fs.rmSync(gradle, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Per-check mapping — strict, honest
// ---------------------------------------------------------------------------

describe("runVerificationCheck mapping", () => {
  const entry = {
    type: "tests" as const,
    command: ["npm", "test"],
    reason: "r",
  };

  it("exit 0 → passed", async () => {
    const check = await runVerificationCheck(entry, "/w", {
      executor: async () => outcome({ exitCode: 0 }),
    });
    expect(check.status).toBe("passed");
    expect(check.exitCode).toBe(0);
    expect(check.completedAt).toBeGreaterThanOrEqual(check.startedAt!);
  });

  it("non-zero exit → failed (never passed)", async () => {
    const check = await runVerificationCheck(entry, "/w", {
      executor: async () => outcome({ exitCode: 3, stderr: "boom" }),
    });
    expect(check.status).toBe("failed");
    expect(check.exitCode).toBe(3);
    expect(check.error).toContain("boom");
  });

  it("timeout → timeout (NEVER passed)", async () => {
    const check = await runVerificationCheck(entry, "/w", {
      executor: async () => outcome({ exitCode: 0, timedOut: true }),
    });
    expect(check.status).toBe("timeout");
  });

  it("cancellation → cancelled (NEVER passed)", async () => {
    const check = await runVerificationCheck(entry, "/w", {
      executor: async () => outcome({ exitCode: 0, cancelled: true }),
    });
    expect(check.status).toBe("cancelled");
  });

  it("null exit code without timeout/cancel → failed (spawn failure)", async () => {
    const check = await runVerificationCheck(entry, "/w", {
      executor: async () => outcome({ exitCode: null }),
    });
    expect(check.status).toBe("failed");
  });

  it("executor throw → failed with structured error, exitCode null", async () => {
    const check = await runVerificationCheck(entry, "/w", {
      executor: async () => {
        throw new Error("spawn ENOENT");
      },
    });
    expect(check.status).toBe("failed");
    expect(check.error).toContain("ENOENT");
    expect(check.exitCode).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Orchestration — the 16 required scenarios
// ---------------------------------------------------------------------------

describe("runVerification scenarios", () => {
  it("1+11. all checks pass → overall VERIFIED", async () => {
    const dir = tmpWorkspace({ "package.json": PKG, "pnpm-lock.yaml": "" });
    const result = await runVerification({
      workspaceRoot: dir,
      checks: ["tests", "build", "typecheck"],
      executor: executorOf({
        "pnpm run test": outcome({ exitCode: 0 }),
        "pnpm run build": outcome({ exitCode: 0 }),
        "pnpm run typecheck": outcome({ exitCode: 0 }),
      }),
    });
    expect(result.checks.map((c) => c.status)).toEqual([
      "passed",
      "passed",
      "passed",
    ]);
    expect(result.verdict).toBe("verified");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("2+12. tests fail → FAILED", () => {
    const verdict = aggregateVerificationVerdict([
      { type: "tests", status: "failed", summary: "" },
      { type: "build", status: "passed", summary: "" },
    ]);
    expect(verdict).toBe("failed");
  });

  it("3. build fails → FAILED", () => {
    expect(
      aggregateVerificationVerdict([
        { type: "build", status: "failed", summary: "" },
      ]),
    ).toBe("failed");
  });

  it("4. typecheck fails → FAILED", () => {
    expect(
      aggregateVerificationVerdict([
        { type: "typecheck", status: "failed", summary: "" },
      ]),
    ).toBe("failed");
  });

  it("5. security fails → FAILED", () => {
    expect(
      aggregateVerificationVerdict([
        { type: "security", status: "failed", summary: "" },
      ]),
    ).toBe("failed");
  });

  it("6+16. check unavailable caps the verdict below VERIFIED", () => {
    expect(
      aggregateVerificationVerdict([
        { type: "tests", status: "passed", summary: "" },
        { type: "build", status: "not_available", summary: "" },
      ]),
    ).toBe("not_verified");
  });

  it("7+13. timeout → NOT VERIFIED (never verified)", () => {
    expect(
      aggregateVerificationVerdict([
        { type: "tests", status: "timeout", summary: "" },
      ]),
    ).toBe("not_verified");
  });

  it("8+13. cancellation → NOT VERIFIED", () => {
    expect(
      aggregateVerificationVerdict([
        { type: "tests", status: "cancelled", summary: "" },
        { type: "build", status: "passed", summary: "" },
      ]),
    ).toBe("not_verified");
  });

  it("9. non-zero exit through the real orchestrator → FAILED", async () => {
    const dir = tmpWorkspace({ "package.json": PKG, "pnpm-lock.yaml": "" });
    const result = await runVerification({
      workspaceRoot: dir,
      checks: ["tests"],
      executor: async (command) => {
        expect(command).toEqual(["pnpm", "run", "test"]);
        return outcome({ exitCode: 1, stderr: "2 failing" });
      },
    });
    expect(result.checks[0]?.status).toBe("failed");
    expect(result.verdict).toBe("failed");
    expect(result.startedAt).toBeDefined();
    expect(result.completedAt).toBeGreaterThanOrEqual(result.startedAt!);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("10+14. no applicable checks → NOT AVAILABLE (missing evidence)", async () => {
    const dir = tmpWorkspace({});
    const result = await runVerification({ workspaceRoot: dir });
    expect(result.checks.every((c) => c.status === "not_available")).toBe(true);
    expect(result.verdict).toBe("not_available");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("15. agent completed + verification failed stays FAILED (completion ≠ verification)", async () => {
    // The engine has no knowledge of agent state; the Control Center composes
    // the two. This test pins the engine half: a failing check yields FAILED
    // regardless of anything else.
    const dir = tmpWorkspace({ "package.json": PKG, "pnpm-lock.yaml": "" });
    const result = await runVerification({
      workspaceRoot: dir,
      checks: ["tests"],
      executor: async () => outcome({ exitCode: 2 }),
    });
    expect(result.verdict).toBe("failed");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("pre-aborted signal → cancelled, never passed", async () => {
    const dir = tmpWorkspace({ "package.json": PKG, "pnpm-lock.yaml": "" });
    const controller = new AbortController();
    controller.abort();
    const result = await runVerification({
      workspaceRoot: dir,
      checks: ["tests"],
      signal: controller.signal,
      executor: async () => outcome({ exitCode: 0 }),
    });
    expect(result.checks[0]?.status).toBe("cancelled");
    expect(result.verdict).toBe("not_verified");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Real executor integration — the safe CommandExecutionService path
// ---------------------------------------------------------------------------

describe("safeCommandExecutor", () => {
  it("runs a real command and maps exit codes honestly", async () => {
    const out = await safeCommandExecutor(
      [process.execPath, "-e", "process.exit(0)"],
      process.cwd(),
      30_000,
    );
    expect(out.exitCode).toBe(0);
    expect(out.timedOut).toBe(false);
    expect(out.cancelled).toBe(false);

    const fail = await safeCommandExecutor(
      [process.execPath, "-e", "process.stderr.write('nope'); process.exit(5)"],
      process.cwd(),
      30_000,
    );
    expect(fail.exitCode).toBe(5);
    expect(fail.stderr).toContain("nope");
  }, 30_000);

  it("a real timeout never becomes passed", async () => {
    const out = await safeCommandExecutor(
      [process.execPath, "-e", "setInterval(()=>{},1000)"],
      process.cwd(),
      700,
    );
    expect(out.timedOut).toBe(true);
    const check = await runVerificationCheck(
      { type: "tests", command: ["node", "hang"], reason: "t" },
      process.cwd(),
      { executor: async () => out },
    );
    expect(check.status).toBe("timeout");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// M4 / security boundary — verification must not bypass anything
// (covered in tests/verification-no-tool-surface.test.ts, which can reach
// the extension's tool-contract module across the package boundary)
// ---------------------------------------------------------------------------
