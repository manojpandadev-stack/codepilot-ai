/**
 * PHASE 12 — realistic autonomous-debugging E2E (deterministic, no LLM).
 *
 * A small DISPOSABLE project with an intentional bug:
 *
 *   function add(a, b) { return a - b; }   // bug: subtraction
 *   test expects add(2, 2) === 4
 *
 * Three legs prove the full desired flow against real files and a real
 * test runner (node --test, real exit codes):
 *
 *   A. CodePilot's native agent loop drives read → run test (failure is
 *      delivered to the model as a structured tool_result) → repair →
 *      rerun → success, through the M4 gate contract on every call.
 *   B. The bounded recovery controller drives classify → diagnose →
 *      approval → apply (ChangeSet-shaped) → targeted/broad verification
 *      → SUCCESS with real evidence; denial and regression variants.
 *   C. No leg touches the user's real project: everything lives under
 *      os.tmpdir() and is removed afterwards. No Ollama, no network.
 *
 * The cloud-provider variant of this scenario lives in
 * `autonomous-debug-cloud-live.test.ts` (gated, opt-in).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Fake host ChangeSet staging bridge. Every repair the controller applies must
 * first become a pending ChangeSet — this models the production bridge, which
 * registers the approved repair with the host ChangeSetManager.
 */
const stageRepairOk = () => ({ ok: true as const, changeSetId: "cs-staged" });
import {
  runRecovery,
  classifyFailure,
  buildDiagnosticContext,
  formatDiagnosticContext,
  type DiagnosisInput,
  type RecoveryEvent,
  type RepairProposal,
  type VerificationOutcome,
} from "../packages/agent-runtime/src/index.js";
import {
  runAgentLoop,
  type AgentLoopEvent,
} from "../packages/agent-runtime/src/native/engine/agent-loop.js";
import {
  createTool,
  type AgentMessage,
  type AgentTool,
} from "../packages/agent-runtime/src/native/types.js";
import type {
  LlmProvider,
  LlmRequest,
  LlmStreamEvent,
  LlmToolCall,
} from "../packages/agent-runtime/src/native/llm/types.js";

// ---------------------------------------------------------------------------
// Disposable fixture project
// ---------------------------------------------------------------------------

const BUGGY_ADD = `// Intentional bug for the autonomous-debugging E2E.
function add(a, b) {
  return a - b;
}

function multiply(a, b) {
  return a * b;
}

module.exports = { add, multiply };
`;

const FIXED_ADD = BUGGY_ADD.replace("return a - b;", "return a + b;");

const BROKEN_MULTIPLY = BUGGY_ADD.replace(
  "return a - b;",
  "return a + b;",
).replace("return a * b;", "return a * b * 2;");

const ADD_TEST = `const test = require("node:test");
const assert = require("node:assert");
const { add } = require("../src/add.js");

test("add(2, 2) === 4", () => {
  assert.strictEqual(add(2, 2), 4);
});
`;

let WORKSPACE = "";
const SRC = (): string => path.join(WORKSPACE, "src", "add.js");

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-autodbg-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "add.js"), BUGGY_ADD, "utf8");
  fs.writeFileSync(path.join(dir, "tests", "add.test.js"), ADD_TEST, "utf8");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "autodbg-fixture",
        private: true,
        scripts: { test: "node --test" },
      },
      null,
      2,
    ),
    "utf8",
  );
  return dir;
}

/** Real test run — real exit code, real stdout/stderr. */
function runTests(
  cwd: string,
  file?: string,
): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const args = file ? ["--test", file] : ["--test"];
  const r = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    exitCode: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function baselineSignal(): {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const out = runTests(WORKSPACE);
  return {
    command: "node --test",
    exitCode: out.exitCode,
    stdout: out.stdout,
    stderr: out.stderr,
  };
}

// ---------------------------------------------------------------------------
// Scripted provider (deterministic stand-in for the configured model)
// ---------------------------------------------------------------------------

const call = (
  toolName: string,
  args: Record<string, unknown>,
): LlmToolCall => ({
  toolCallId: `call_${Math.random().toString(36).slice(2, 8)}`,
  toolName,
  argumentsText: JSON.stringify(args),
});

class ScriptedProvider implements LlmProvider {
  readonly id = "scripted";
  private turns: LlmStreamEvent[][] = [];
  pushTurn(events: LlmStreamEvent[]): void {
    this.turns.push(events);
  }
  async *stream(_request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const turn = this.turns.shift();
    if (!turn) throw new Error("scripted provider exhausted its turns");
    for (const evt of turn) yield evt;
  }
}

const toolCall = (
  name: string,
  args: Record<string, unknown>,
): LlmStreamEvent => ({
  type: "tool-call",
  call: call(name, args),
});
/** Every scripted turn must terminate with a valid completion signal. */
const turnEnd: LlmStreamEvent = { type: "finish", reason: "complete" };
const finish = (text: string): LlmStreamEvent[] => [
  { type: "text-delta", text },
  turnEnd,
];

// ---------------------------------------------------------------------------
// Real tools over the disposable workspace (M4-gated like production)
// ---------------------------------------------------------------------------

function realTools(workspace: string): AgentTool[] {
  return [
    createTool({
      name: "read_files",
      description: "Read files.",
      inputSchema: {
        type: "object",
        properties: {
          files: {
            type: "array",
            items: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
        },
      },
      execute: async (input) => {
        const files =
          (input as { files?: Array<{ path: string }> }).files ?? [];
        return files
          .map((f) => {
            const abs = path.resolve(workspace, f.path);
            if (!abs.startsWith(workspace)) return `${f.path}: DENIED`;
            return `--- ${f.path} ---\n${fs.readFileSync(abs, "utf8")}`;
          })
          .join("\n");
      },
    }),
    createTool({
      name: "bash",
      description: "Run a command.",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
      },
      execute: async (input) => {
        const command = String((input as { command: string }).command);
        const out = runTests(workspace);
        if (out.exitCode !== 0) {
          throw new Error(
            `node --test failed (exit ${out.exitCode}): ${out.stdout}${out.stderr}`.slice(
              0,
              20_000,
            ),
          );
        }
        return {
          status: "SUCCESS",
          command,
          exitCode: out.exitCode,
          output: `${out.stdout}${out.stderr}`.slice(0, 20_000),
        };
      },
    }),
    createTool({
      name: "editor",
      description: "Stage a file edit.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
      },
      execute: async (input) => {
        const p = String((input as { path: string }).path);
        const content = String((input as { content: string }).content);
        const abs = path.resolve(workspace, p);
        if (!abs.startsWith(workspace)) {
          return { status: "ERROR", error: "workspace boundary" };
        }
        fs.writeFileSync(abs, content, "utf8");
        return { status: "SUCCESS", path: p };
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Before / after
// ---------------------------------------------------------------------------

beforeAll(() => {
  WORKSPACE = makeWorkspace();
});

afterAll(() => {
  if (WORKSPACE && WORKSPACE.includes("codepilot-autodbg-")) {
    fs.rmSync(WORKSPACE, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Leg A — CodePilot agent loop against the real bug
// ---------------------------------------------------------------------------

describe("E2E A — agent loop: read → run test → repair → verify", () => {
  it(
    "delivers the real failure to the model, applies the fix through the gate, and reruns green",
    { timeout: 60_000 },
    async () => {
      // Reset the fixture for this leg.
      fs.writeFileSync(SRC(), BUGGY_ADD, "utf8");
      const before = runTests(WORKSPACE);
      expect(before.exitCode).not.toBe(0);

      const provider = new ScriptedProvider();
      provider.pushTurn([
        toolCall("read_files", { files: [{ path: "src/add.js" }] }),
        turnEnd,
      ]);
      provider.pushTurn([
        toolCall("bash", { command: "node --test" }),
        turnEnd,
      ]);
      provider.pushTurn([
        toolCall("editor", {
          path: "src/add.js",
          content: FIXED_ADD,
        }),
        turnEnd,
      ]);
      provider.pushTurn([
        toolCall("bash", { command: "node --test" }),
        turnEnd,
      ]);
      provider.pushTurn(
        finish("Fixed add() and verified the test suite passes."),
      );

      const gateCalls: string[] = [];
      const events: AgentLoopEvent[] = [];
      const messages: AgentMessage[] = [];

      const result = await runAgentLoop(
        messages,
        "Fix the failing test in this project.",
        {
          provider,
          modelId: "scripted-model",
          sessionId: "e2e-autodbg",
          tools: realTools(WORKSPACE),
          gate: async (request) => {
            gateCalls.push(
              `${request.toolName}:${JSON.stringify(request.input).slice(0, 80)}`,
            );
            return { approved: true };
          },
          maxIterations: 8,
          onEvent: (e) => events.push(e),
        },
      );

      // 10. Final evidence: the run completed and the fix is on disk.
      expect(result.reason).toBe("complete");
      expect(fs.readFileSync(SRC(), "utf8")).toContain("return a + b;");
      expect(runTests(WORKSPACE).exitCode).toBe(0);

      // The model SAW the real failure as a structured tool_result.
      const flat = JSON.stringify(messages);
      expect(flat).toContain("add(2, 2) === 4");
      expect(flat).toContain("tool_result");

      // Every tool call passed through the M4 gate (deny-closed contract):
      // read → failing test → edit → retest = four gated calls, one editor.
      expect(gateCalls.length).toBe(4);
      expect(gateCalls.filter((c) => c.startsWith("editor:")).length).toBe(1);

      // Real tool lifecycle events, in order, with no fabricated success:
      // the failing bash run is an ERROR before the repair.
      const toolCompletedErrors = events.filter(
        (e) => e.type === "tool_completed" && e.isError,
      );
      expect(toolCompletedErrors.length).toBeGreaterThanOrEqual(1);
      expect(events.at(-1)).toMatchObject({
        type: "finish",
        reason: "complete",
      });
    },
  );

  it("aborts the run on cancellation without executing later tool calls", async () => {
    fs.writeFileSync(SRC(), BUGGY_ADD, "utf8");
    const provider = new ScriptedProvider();
    provider.pushTurn([toolCall("bash", { command: "node --test" }), turnEnd]);
    provider.pushTurn(finish("should not be reached"));

    const controller = new AbortController();
    controller.abort();
    const events: AgentLoopEvent[] = [];
    const result = await runAgentLoop(
      [],
      "Fix it.",
      {
        provider,
        modelId: "scripted-model",
        sessionId: "e2e-cancel",
        tools: realTools(WORKSPACE),
        gate: async () => ({ approved: true }),
        maxIterations: 4,
        onEvent: (e) => events.push(e),
      },
      controller.signal,
    );
    expect(result.reason).toBe("aborted");
    expect(events.some((e) => e.type === "tool_completed")).toBe(false);
    // Cancellation reported, never a fabricated completion.
    expect(
      events.some((e) => e.type === "finish" && e.reason === "complete"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Leg B — recovery controller against the real project
// ---------------------------------------------------------------------------

/** Deterministic "model": read the real source and fix the observed bug. */
function diagnoseFromDisk(input: DiagnosisInput): RepairProposal {
  const source = fs.readFileSync(SRC(), "utf8");
  const hasBug = source.includes("return a - b;");
  const line =
    source.split(/\r?\n/).find((l) => l.includes("return a -")) ??
    "return a - b;";
  return {
    summary: `Attempt ${input.attempt}: replace \`${line.trim()}\` with \`return a + b;\` (subtraction is why add(2,2) returned 0)`,
    files: ["src/add.js"],
    preview: `--- src/add.js\n- ${line.trim()}\n+ return a + b;`,
    riskLevel: "low",
    apply: () => {
      // ChangeSet-shaped apply: stage, then commit after approval.
      const staged = hasBug ? FIXED_ADD : BUGGY_ADD;
      fs.writeFileSync(SRC(), staged, "utf8");
      return {
        success: true,
        filesChanged: ["src/add.js"],
        changeSetId: `cs-e2e-${Date.now()}`,
      };
    },
  };
}

function targetedVerify(): VerificationOutcome {
  const out = runTests(WORKSPACE, "tests/add.test.js");
  return {
    passed: out.exitCode === 0,
    command: "node --test tests/add.test.js",
    exitCode: out.exitCode,
    stdout: out.stdout.slice(0, 4_000),
    stderr: out.stderr.slice(0, 4_000),
    durationMs: 0,
  };
}

function broadVerify(): VerificationOutcome {
  const out = runTests(WORKSPACE);
  return {
    passed: out.exitCode === 0,
    command: "node --test",
    exitCode: out.exitCode,
    stdout: out.stdout.slice(0, 4_000),
    stderr: out.stderr.slice(0, 4_000),
    durationMs: 0,
  };
}

describe("E2E B — recovery controller: classify → diagnose → approve → apply → verify", () => {
  it(
    "first repair succeeds with real evidence and a complete timeline",
    { timeout: 60_000 },
    async () => {
      fs.writeFileSync(SRC(), BUGGY_ADD, "utf8");
      const signal = baselineSignal();
      expect(signal.exitCode).not.toBe(0);

      // Deterministic classification of the REAL failure output.
      const classification = classifyFailure(signal);
      expect(classification.category).toBe("TEST_FAILURE");
      expect(classification.recoverable).toBe(true);

      const events: RecoveryEvent[] = [];
      const approvals: string[] = [];
      const prompts: string[] = [];

      const result = await runRecovery(signal, {
      stageRepair: stageRepairOk,
        onEvent: (e) => events.push(e),
        diagnose: (input) => {
          prompts.push(input.prompt);
          return diagnoseFromDisk(input);
        },
        requestApproval: (req) => {
          approvals.push(req.files.join(","));
          return { approved: true };
        },
        verify: () => targetedVerify(),
        verifyBroad: () => broadVerify(),
      });

      // 9. SUCCESS requires actual verification evidence.
      expect(result.status).toBe("SUCCESS");
      expect(result.attempts).toBe(1);
      expect(result.evidence?.stage).toBe("broad");
      expect(result.evidence?.command).toBe("node --test");
      expect(result.evidence?.exitCode).toBe(0);

      // 7. The diagnosis prompt carried the compact diagnostic context.
      expect(prompts[0]).toContain("FAILURE [TEST_FAILURE]");
      expect(prompts[0]).toContain("Command: node --test");

      // 6. Approval happened exactly once, before the apply.
      expect(approvals).toEqual(["src/add.js"]);

      // The file really changed and the real suite passes now.
      expect(fs.readFileSync(SRC(), "utf8")).toContain("return a + b;");
      expect(runTests(WORKSPACE).exitCode).toBe(0);

      // 10. Final evidence + Phase 10 timeline phases in order.
      expect(events.map((e) => e.phase)).toEqual([
        "FAILURE_DETECTED",
        "DIAGNOSIS_STARTED",
        "DIAGNOSIS_COMPLETED",
        "REPAIR_PROPOSED",
        "REPAIR_APPROVAL_REQUIRED",
        "REPAIR_APPLIED",
        "VERIFICATION_STARTED",
        "VERIFICATION_STARTED",
        "RECOVERY_COMPLETED",
      ]);
      const applied = events.find((e) => e.phase === "REPAIR_APPLIED");
      expect(applied?.files).toEqual(["src/add.js"]);
    },
  );

  it("approval denial stops recovery and leaves the bug untouched", async () => {
    fs.writeFileSync(SRC(), BUGGY_ADD, "utf8");
    const signal = baselineSignal();
    let diagnoses = 0;
    const result = await runRecovery(signal, {
      stageRepair: stageRepairOk,
      diagnose: (input) => {
        diagnoses += 1;
        return diagnoseFromDisk(input);
      },
      requestApproval: () => ({ approved: false, reason: "user denied" }),
      verify: () => targetedVerify(),
    });
    expect(result.status).toBe("FAILED");
    expect(diagnoses).toBe(1);
    expect(result.reason).toContain("user denied");
    // No mutation happened — the bug is still on disk.
    expect(fs.readFileSync(SRC(), "utf8")).toContain("return a - b;");
    expect(runTests(WORKSPACE).exitCode).not.toBe(0);
  });

  it(
    'a fix that breaks another test is a NEW failure (PARTIAL_SUCCESS), never "fixed"',
    { timeout: 60_000 },
    async () => {
      // Add a second expectation the "wrong" fix will break.
      const multiplyTest = `const test = require("node:test");
const assert = require("node:assert");
const { multiply } = require("../src/add.js");

test("multiply(3, 3) === 9", () => {
  assert.strictEqual(multiply(3, 3), 9);
});
`;
      fs.writeFileSync(
        path.join(WORKSPACE, "tests", "multiply.test.js"),
        multiplyTest,
        "utf8",
      );
      fs.writeFileSync(SRC(), BUGGY_ADD, "utf8");

      const signal = baselineSignal();
      expect(classifyFailure(signal).category).toBe("TEST_FAILURE");

      const result = await runRecovery(signal, {
      stageRepair: stageRepairOk,
        maxAttempts: 1,
        diagnose: () => ({
          summary: "Fix add() but accidentally break multiply()",
          files: ["src/add.js"],
          riskLevel: "medium",
          apply: () => {
            fs.writeFileSync(SRC(), BROKEN_MULTIPLY, "utf8");
            return { success: true, filesChanged: ["src/add.js"] };
          },
        }),
        requestApproval: () => ({ approved: true }),
        verify: () => broadVerify(),
      });

      expect(result.status).toBe("PARTIAL_SUCCESS");
      expect(result.newFailureDetected).toBe(true);
      expect(result.reason).toContain("NEW failure");
      expect(result.reason).not.toContain("Verification passed");

      // Cleanup the extra test so later legs see the original fixture.
      fs.rmSync(path.join(WORKSPACE, "tests", "multiply.test.js"), {
        force: true,
      });
    },
  );

  it("cancellation between attempts stops the loop (AGENT_CANCELLED)", async () => {
    fs.writeFileSync(SRC(), BUGGY_ADD, "utf8");
    const signal = baselineSignal();
    const controller = new AbortController();
    const events: RecoveryEvent[] = [];
    let diagnoses = 0;
    const result = await runRecovery(signal, {
      stageRepair: stageRepairOk,
      signal: controller.signal,
      onEvent: (e) => {
        events.push(e);
        if (e.phase === "RECOVERY_RETRY") controller.abort();
      },
      diagnose: (input) => {
        diagnoses += 1;
        return diagnoseFromDisk(input);
      },
      requestApproval: () => ({ approved: true }),
      // Always failing with the SAME failure → RECOVERY_RETRY each round.
      verify: () => ({
        passed: false,
        command: "node --test",
        exitCode: 1,
        stdout: signal.stdout,
        stderr: signal.stderr,
      }),
    });
    expect(result.status).toBe("CANCELLED");
    expect(result.reason).toContain("AGENT_CANCELLED");
    expect(diagnoses).toBe(1);
    expect(events.at(-1)!.phase).toBe("RECOVERY_RETRY");
    // No terminal event after cancellation — late results are discarded.
    expect(events.map((e) => e.phase)).not.toContain("RECOVERY_COMPLETED");
    expect(events.map((e) => e.phase)).not.toContain("RECOVERY_EXHAUSTED");
  });
});

// ---------------------------------------------------------------------------
// Diagnostic context sanity against the REAL output (Phase 3)
// ---------------------------------------------------------------------------

describe("E2E — diagnostic context from the real failing run", () => {
  it("formats the real failure compactly and redacts planted secrets", async () => {
    fs.writeFileSync(SRC(), BUGGY_ADD, "utf8");
    const signal = baselineSignal();
    // Plant a credential in the captured stream — it must never surface.
    const poisoned = {
      ...signal,
      stderr: `${signal.stderr}\napi_key=e2e-secret-do-not-leak`,
    };
    const ctx = buildDiagnosticContext(poisoned, { attempt: 0 });
    const block = formatDiagnosticContext(ctx);
    expect(ctx.category).toBe("TEST_FAILURE");
    expect(block).not.toContain("e2e-secret-do-not-leak");
    expect(block).toContain("[REDACTED]");
    expect(ctx.redacted).toBe(true);
    expect(block.length).toBeLessThanOrEqual(16_000 + 60);
  });
});
