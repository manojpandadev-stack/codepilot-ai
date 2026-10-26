/**
 * Recovery controller — bounded autonomous debug & self-repair tests
 * (Agent 2, Phase 11, cases 9–24).
 *
 * Everything is deterministic and injected: no live LLM, no network, no
 * real approvals. The controller's contracts under test:
 *   bounded attempts, fail-closed approval, cancellation at every phase,
 *   regression detection, staged verification, ChangeSet authority,
 *   preserved tool-status semantics, and Activity Timeline events.
 */
import { describe, expect, it, vi } from "vitest";
import {
  MAX_REPAIR_ATTEMPTS_CEILING,
  runRecovery,
  type DiagnosisInput,
  type RepairProposal,
  type RecoveryEvent,
  type VerificationOutcome,
} from "./recovery-controller.js";
import { dispatchToolCall } from "./native/engine/tool-dispatch.js";
import { createTool, type AgentTool } from "./native/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_STDOUT = "FAIL src/add.test.ts\nAssertionError: expected -0 to be 4";

const failingSignal = () => ({
  command: "npm test",
  exitCode: 1,
  stdout: BASE_STDOUT,
  stderr: "    at add (src/add.js:2:10)",
});

const passingVerification = (): VerificationOutcome => ({
  passed: true,
  command: "npm test",
  exitCode: 0,
  stdout: "1 passed",
  durationMs: 12,
});

const sameFailureVerification = (): VerificationOutcome => ({
  passed: false,
  command: "npm test",
  exitCode: 1,
  stdout: BASE_STDOUT,
  stderr: "    at add (src/add.js:2:10)",
});

const makeProposal = (
  overrides: Partial<RepairProposal> = {},
): RepairProposal => ({
  summary: "Change `return a - b` to `return a + b` in src/add.js",
  files: ["src/add.js"],
  riskLevel: "low",
  apply: () => ({
    success: true,
    filesChanged: ["src/add.js"],
    changeSetId: "cs-1",
  }),
  ...overrides,
});

const approveAll = () => ({ approved: true });
/**
 * Fake host ChangeSet staging bridge. Every repair the controller applies must
 * first become a pending ChangeSet — this models the production bridge, which
 * registers the approved repair with the host ChangeSetManager.
 */
const stageRepairOk = () => ({ ok: true as const, changeSetId: "cs-staged" });

// ---------------------------------------------------------------------------
// 9–13: repair loop outcomes and bounds
// ---------------------------------------------------------------------------

describe("recovery loop outcomes", () => {
  it("9. first repair succeeds", async () => {
    const events: RecoveryEvent[] = [];
    const result = await runRecovery(failingSignal(), {
      stageRepair: stageRepairOk,
      onEvent: (e) => events.push(e),
      diagnose: () => makeProposal(),
      requestApproval: approveAll,
      verify: () => passingVerification(),
    });
    expect(result.status).toBe("SUCCESS");
    expect(result.attempts).toBe(1);
    expect(result.history[0]!.outcome).toBe("verified");
    expect(result.evidence).toMatchObject({
      command: "npm test",
      exitCode: 0,
      stage: "targeted",
    });
    expect(result.reason).toContain("Targeted verification passed");
    expect(events.map((e) => e.phase)).toContain("RECOVERY_COMPLETED");
  });

  it("10. first repair fails, second succeeds", async () => {
    const diagnose = vi.fn((input: DiagnosisInput) =>
      makeProposal({
        summary:
          input.attempt === 1
            ? "first fix attempt"
            : "second fix attempt (informed by the new failure)",
      }),
    );
    let verifyCalls = 0;
    const result = await runRecovery(failingSignal(), {
      stageRepair: stageRepairOk,
      diagnose,
      requestApproval: approveAll,
      verify: () => {
        verifyCalls += 1;
        return verifyCalls === 1
          ? sameFailureVerification()
          : passingVerification();
      },
    });
    expect(result.status).toBe("SUCCESS");
    expect(result.attempts).toBe(2);
    expect(diagnose).toHaveBeenCalledTimes(2);
    expect(verifyCalls).toBe(2);
    // The second diagnosis receives the NEW failure context and the history.
    const second = diagnose.mock.calls[1]![0];
    expect(second.attempt).toBe(2);
    expect(second.previousAttempts).toHaveLength(1);
    expect(second.prompt).toContain("TEST_FAILURE");
    expect(second.context.attempt).toBe(1); // failure of attempt 1
    expect(result.newFailureDetected).toBe(false);
  });

  it("11. all repair attempts fail", async () => {
    const events: RecoveryEvent[] = [];
    const diagnose = vi.fn(() => makeProposal());
    const result = await runRecovery(failingSignal(), {
      stageRepair: stageRepairOk,
      onEvent: (e) => events.push(e),
      diagnose,
      requestApproval: approveAll,
      verify: () => sameFailureVerification(),
    });
    expect(result.status).toBe("FAILED");
    expect(result.attempts).toBe(3);
    expect(diagnose).toHaveBeenCalledTimes(3);
    expect(result.history).toHaveLength(3);
    expect(events.at(-1)!.phase).toBe("RECOVERY_EXHAUSTED");
    expect(events.at(-1)!.status).toBe("FAILED");
    expect(result.finalFailure?.category).toBe("TEST_FAILURE");
  });

  it("12. retry limit enforced (default 3, hard ceiling regardless of config)", async () => {
    const defaultDiagnose = vi.fn(() => makeProposal());
    await runRecovery(failingSignal(), {
      stageRepair: stageRepairOk,
      diagnose: defaultDiagnose,
      requestApproval: approveAll,
      verify: () => sameFailureVerification(),
    });
    expect(defaultDiagnose).toHaveBeenCalledTimes(3);

    const greedyDiagnose = vi.fn(() => makeProposal());
    const result = await runRecovery(failingSignal(), {
      stageRepair: stageRepairOk,
      maxAttempts: 99,
      diagnose: greedyDiagnose,
      requestApproval: approveAll,
      verify: () => sameFailureVerification(),
    });
    expect(greedyDiagnose).toHaveBeenCalledTimes(MAX_REPAIR_ATTEMPTS_CEILING);
    expect(result.maxAttempts).toBe(MAX_REPAIR_ATTEMPTS_CEILING);
    expect(result.maxAttempts).toBeLessThanOrEqual(5);
  });

  it("13. no infinite loop even when every failure looks brand new", async () => {
    let n = 0;
    const diagnose = vi.fn(() => makeProposal());
    const result = await runRecovery(failingSignal(), {
      stageRepair: stageRepairOk,
      diagnose,
      requestApproval: approveAll,
      verify: () => {
        n += 1;
        return {
          passed: false,
          command: "npm test",
          exitCode: 1,
          stdout: `AssertionError: unexpected variant number ${n} exploded`,
        };
      },
    });
    expect(diagnose).toHaveBeenCalledTimes(3);
    expect(result.attempts).toBe(3);
    expect(result.newFailureDetected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 14–15: approval (Phase 9)
// ---------------------------------------------------------------------------

describe("approval is authoritative (fail-closed)", () => {
  it("14. approval is required for a repair — no channel, no apply", async () => {
    const events: RecoveryEvent[] = [];
    const apply = vi.fn(() => ({ success: true }));
    const result = await runRecovery(failingSignal(), {
      stageRepair: stageRepairOk,
      onEvent: (e) => events.push(e),
      diagnose: () => makeProposal({ apply }),
      verify: () => passingVerification(),
      // NOTE: no requestApproval — the controller must deny closed.
    });
    expect(result.status).toBe("FAILED");
    expect(apply).not.toHaveBeenCalled();
    expect(result.reason).toContain("deny-closed");
    expect(events.map((e) => e.phase)).toContain("REPAIR_APPROVAL_REQUIRED");
    expect(result.history[0]!.outcome).toBe("denied");
  });

  it("15. approval denial stops recovery (no further attempts)", async () => {
    const diagnose = vi.fn(() => makeProposal());
    const apply = vi.fn(() => ({ success: true }));
    const verify = vi.fn(() => passingVerification());
    const events: RecoveryEvent[] = [];
    const result = await runRecovery(failingSignal(), {
      stageRepair: stageRepairOk,
      onEvent: (e) => events.push(e),
      diagnose,
      requestApproval: (req) => ({
        approved: false,
        reason: `user rejected ${req.files.join(", ")}`,
      }),
      verify,
      maxAttempts: 3,
    });
    expect(result.status).toBe("FAILED");
    expect(result.reason).toContain("user rejected src/add.js");
    // Recovery STOPS: one diagnosis, zero applies, zero verifications.
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(result.history).toHaveLength(1);
    expect(result.history[0]!.outcome).toBe("denied");
    expect(events.filter((e) => e.phase === "DIAGNOSIS_STARTED")).toHaveLength(
      1,
    );
    expect(events.at(-1)!.phase).toBe("RECOVERY_COMPLETED");
    expect(events.at(-1)!.status).toBe("FAILED");
  });
});

// ---------------------------------------------------------------------------
// 16–18: cancellation (Phase 8)
// ---------------------------------------------------------------------------

describe("cancellation respects AbortSignal", () => {
  it("16. cancel during diagnosis stops before any proposal", async () => {
    const controller = new AbortController();
    const events: RecoveryEvent[] = [];
    const apply = vi.fn(() => ({ success: true }));
    const verify = vi.fn(() => passingVerification());
    const result = await runRecovery(failingSignal(), {
      stageRepair: stageRepairOk,
      signal: controller.signal,
      onEvent: (e) => {
        events.push(e);
        if (e.phase === "DIAGNOSIS_STARTED") controller.abort();
      },
      diagnose: () => new Promise<RepairProposal>(() => {}), // pending
      requestApproval: approveAll,
      verify,
    });
    expect(result.status).toBe("CANCELLED");
    expect(result.reason).toContain("AGENT_CANCELLED");
    expect(apply).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    // Late results are discarded: no diagnosis/proposal events after abort.
    expect(events.map((e) => e.phase)).not.toContain("DIAGNOSIS_COMPLETED");
    expect(events.map((e) => e.phase)).not.toContain("REPAIR_PROPOSED");
    expect(events.map((e) => e.phase)).not.toContain("RECOVERY_COMPLETED");
    expect(events.map((e) => e.phase)).not.toContain("RECOVERY_EXHAUSTED");
  });

  it("17. cancel during repair apply stops before verification", async () => {
    const controller = new AbortController();
    const events: RecoveryEvent[] = [];
    const verify = vi.fn(() => passingVerification());
    const result = await runRecovery(failingSignal(), {
      stageRepair: stageRepairOk,
      signal: controller.signal,
      onEvent: (e) => events.push(e),
      diagnose: () =>
        makeProposal({
          apply: () => {
            controller.abort(); // Stop pressed while the repair applies
            return new Promise<never>(() => {}); // apply still pending
          },
        }),
      requestApproval: approveAll,
      verify,
    });
    expect(result.status).toBe("CANCELLED");
    expect(verify).not.toHaveBeenCalled();
    expect(events.map((e) => e.phase)).not.toContain("REPAIR_APPLIED");
    expect(events.map((e) => e.phase)).not.toContain("VERIFICATION_STARTED");
    expect(events.at(-1)!.phase).toBe("REPAIR_APPROVAL_REQUIRED");
  });

  it("18. cancel between repair attempts prevents the next diagnosis", async () => {
    const controller = new AbortController();
    const events: RecoveryEvent[] = [];
    const diagnose = vi.fn(() => makeProposal());
    const verify = vi.fn(() => sameFailureVerification());
    const result = await runRecovery(failingSignal(), {
      stageRepair: stageRepairOk,
      signal: controller.signal,
      onEvent: (e) => {
        events.push(e);
        if (e.phase === "RECOVERY_RETRY") controller.abort();
      },
      diagnose,
      requestApproval: approveAll,
      verify,
    });
    expect(result.status).toBe("CANCELLED");
    expect(result.reason).toContain("AGENT_CANCELLED");
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(result.history).toHaveLength(1);
    // No further repair attempt and no terminal event after cancellation.
    expect(events.filter((e) => e.phase === "DIAGNOSIS_STARTED")).toHaveLength(
      1,
    );
    expect(events.at(-1)!.phase).toBe("RECOVERY_RETRY");
    expect(events.map((e) => e.phase)).not.toContain("RECOVERY_EXHAUSTED");
  });
});

// ---------------------------------------------------------------------------
// 19–20: regression awareness + verification (Phases 6–7)
// ---------------------------------------------------------------------------

describe("regression awareness & verification", () => {
  it("19. a different failure after repair is a NEW failure (PARTIAL_SUCCESS)", async () => {
    const events: RecoveryEvent[] = [];
    const result = await runRecovery(failingSignal(), {
      stageRepair: stageRepairOk,
      onEvent: (e) => events.push(e),
      maxAttempts: 2,
      diagnose: () => makeProposal(),
      requestApproval: approveAll,
      verify: () => ({
        passed: false,
        command: "npm run typecheck",
        exitCode: 2,
        stderr:
          "src/other.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'.",
      }),
    });
    expect(result.status).toBe("PARTIAL_SUCCESS");
    expect(result.newFailureDetected).toBe(true);
    expect(result.finalFailure?.category).toBe("TYPECHECK_FAILURE");
    expect(result.reason).toContain("NEW failure");
    // Never reported as fixed.
    expect(result.reason).not.toContain("Verification passed");
    const failed = events.find((e) => e.phase === "VERIFICATION_FAILED");
    expect(failed?.newFailure).toBe(true);
    expect(failed?.category).toBe("TYPECHECK_FAILURE");
    expect(events.at(-1)!.phase).toBe("RECOVERY_EXHAUSTED");
    expect(events.at(-1)!.status).toBe("PARTIAL_SUCCESS");
  });

  it("20. success requires actual verification: targeted then broad regression", async () => {
    const stages: string[] = [];
    const result = await runRecovery(failingSignal(), {
      stageRepair: stageRepairOk,
      diagnose: () => makeProposal(),
      requestApproval: approveAll,
      verify: () => {
        stages.push("targeted");
        return passingVerification();
      },
      verifyBroad: () => {
        stages.push("broad");
        return {
          passed: true,
          command: "npm run build",
          exitCode: 0,
          durationMs: 5,
        };
      },
    });
    expect(result.status).toBe("SUCCESS");
    expect(stages).toEqual(["targeted", "broad"]);
    expect(result.evidence?.stage).toBe("broad");
    expect(result.evidence?.command).toBe("npm run build");
    expect(result.history[0]!.outcome).toBe("verified");
  });

  it("20b. broad regression never runs when targeted verification fails", async () => {
    const broad = vi.fn(() => passingVerification());
    const result = await runRecovery(failingSignal(), {
      stageRepair: stageRepairOk,
      maxAttempts: 1,
      diagnose: () => makeProposal(),
      requestApproval: approveAll,
      verify: () => sameFailureVerification(),
      verifyBroad: broad,
    });
    expect(broad).not.toHaveBeenCalled();
    expect(result.status).toBe("FAILED");
  });

  it("20c. a failing broad regression is NOT a success", async () => {
    let broadCalls = 0;
    const result = await runRecovery(failingSignal(), {
      stageRepair: stageRepairOk,
      maxAttempts: 2,
      diagnose: () => makeProposal(),
      requestApproval: approveAll,
      verify: () => passingVerification(),
      verifyBroad: () => {
        broadCalls += 1;
        return broadCalls === 1
          ? sameFailureVerification()
          : passingVerification();
      },
    });
    expect(result.status).toBe("SUCCESS");
    expect(broadCalls).toBe(2);
    expect(result.evidence?.stage).toBe("broad");
  });

  it("a verification timeout settles as TIMEOUT, never as a pass", async () => {
    const result = await runRecovery(failingSignal(), {
      stageRepair: stageRepairOk,
      maxAttempts: 1,
      diagnose: () => makeProposal(),
      requestApproval: approveAll,
      verify: () => ({
        passed: false,
        command: "npm test",
        timedOut: true,
        exitCode: null,
      }),
    });
    expect(result.status).toBe("TIMEOUT");
    expect(result.reason).toContain("timed out");
  });
});

// ---------------------------------------------------------------------------
// 5/21: minimal change + ChangeSet authority (Phase 5 / 9)
// ---------------------------------------------------------------------------

describe("minimal change & ChangeSet authority", () => {
  it("21. approval precedes staging precedes apply; the STAGED id is authoritative", async () => {
    const order: string[] = [];
    const result = await runRecovery(failingSignal(), {
      stageRepair: () => {
        order.push("stage");
        return { ok: true, changeSetId: "cs-staged-1" };
      },
      diagnose: () =>
        makeProposal({
          apply: (changeSetId: string) => {
            order.push(`apply:${changeSetId}`);
            return {
              success: true,
              filesChanged: ["src/add.js"],
              // A host may echo a DIFFERENT id — the staged one still wins.
              changeSetId: "cs-77",
            };
          },
        }),
      requestApproval: () => {
        order.push("approval");
        return { approved: true };
      },
      verify: () => passingVerification(),
    });
    expect(order).toEqual(["approval", "stage", "apply:cs-staged-1"]);
    expect(result.history[0]!.changeSetId).toBe("cs-staged-1");
    expect(result.history[0]!.filesChanged).toEqual(["src/add.js"]);
  });

  it("21b. a rejected ChangeSet stops the attempt without verification", async () => {
    const verify = vi.fn(() => passingVerification());
    const result = await runRecovery(failingSignal(), {
      stageRepair: stageRepairOk,
      maxAttempts: 1,
      diagnose: () =>
        makeProposal({
          apply: () => ({
            success: false,
            error: "ChangeSet rejected by user",
          }),
        }),
      requestApproval: approveAll,
      verify,
    });
    expect(result.status).toBe("FAILED");
    expect(verify).not.toHaveBeenCalled();
    expect(result.reason).toContain("ChangeSet rejected by user");
  });

  it("rejects over-broad proposals (smallest file set first)", async () => {
    const apply = vi.fn(() => ({ success: true }));
    const files = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`);
    const result = await runRecovery(failingSignal(), {
      stageRepair: stageRepairOk,
      maxAttempts: 1,
      diagnose: () => makeProposal({ files, apply }),
      requestApproval: approveAll,
      verify: () => passingVerification(),
    });
    expect(result.status).toBe("FAILED");
    expect(apply).not.toHaveBeenCalled();
    expect(result.history[0]!.outcome).toBe("rejected");
    expect(result.reason).toContain("minimal-change bound");
  });
});

// ---------------------------------------------------------------------------
// 22: existing tool status semantics preserved
// ---------------------------------------------------------------------------

describe("22. existing tool status semantics preserved", () => {
  const call = (name: string) => ({
    toolCallId: "tool-1",
    toolName: name,
    argumentsText: JSON.stringify({ command: "echo hi" }),
  });
  const context = { sessionId: "s", iteration: 1 };

  it("non-SUCCESS status objects are a normal result (isError=false, denied=false)", async () => {
    const tool: AgentTool = createTool({
      name: "run_commands",
      description: "run",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ status: "ERROR", output: "boom" }),
    });
    const outcome = await dispatchToolCall(
      tool,
      call("run_commands"),
      async () => ({ approved: true }),
      context,
    );
    // A non-throwing tool that returns { status: "ERROR" } is a normal
    // dispatched result (isError=false). The dispatch boundary only marks
    // isError=true for thrown rejections or gate denials — a status field is
    // ordinary tool output, not a dispatch-level failure. We assert the
    // "ERROR" status text is preserved in the content so a swallowed status
    // field can never look like success.
    expect(outcome.isError).toBe(false);
    expect(outcome.denied).toBe(false);
    expect(outcome.content).toContain("ERROR");
  });

  it("a throwing tool becomes a structured error result (never throws)", async () => {
    const tool: AgentTool = createTool({
      name: "bash",
      description: "run",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        throw new Error("exit code 1");
      },
    });
    const outcome = await dispatchToolCall(
      tool,
      call("bash"),
      async () => ({ approved: true }),
      context,
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.denied).toBe(false);
    expect(outcome.content).toContain("failed");
  });

  it("successful tools stay isError=false", async () => {
    const tool: AgentTool = createTool({
      name: "bash",
      description: "run",
      inputSchema: { type: "object", properties: {} },
      execute: async () => "v24.0.0",
    });
    const outcome = await dispatchToolCall(
      tool,
      call("bash"),
      async () => ({ approved: true }),
      context,
    );
    expect(outcome.isError).toBe(false);
    expect(outcome.denied).toBe(false);
    expect(outcome.content).toBe("v24.0.0");
  });

  it("gate denial stays distinct from tool failure", async () => {
    const tool: AgentTool = createTool({
      name: "bash",
      description: "run",
      inputSchema: { type: "object", properties: {} },
      execute: async () => "never reached",
    });
    const outcome = await dispatchToolCall(
      tool,
      call("bash"),
      async () => ({ approved: false, reason: "M4 denied" }),
      context,
    );
    expect(outcome.denied).toBe(true);
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("M4 denied");
  });
});

// ---------------------------------------------------------------------------
// 23: Activity Timeline events
// ---------------------------------------------------------------------------

describe("23. Activity Timeline recovery events", () => {
  it("emits the canonical phase sequence with bounded, scrubbed payloads", async () => {
    const events: RecoveryEvent[] = [];
    let verifyCalls = 0;
    await runRecovery(failingSignal(), {
      stageRepair: stageRepairOk,
      onEvent: (e) => events.push(e),
      maxAttempts: 2,
      diagnose: (input) =>
        makeProposal({
          summary: `fix attempt ${input.attempt} with api_key=abcdef123456`,
        }),
      requestApproval: approveAll,
      verify: () => {
        verifyCalls += 1;
        return verifyCalls === 1
          ? sameFailureVerification()
          : passingVerification();
      },
    });

    expect(events.map((e) => e.phase)).toEqual([
      "FAILURE_DETECTED",
      "DIAGNOSIS_STARTED",
      "DIAGNOSIS_COMPLETED",
      "REPAIR_PROPOSED",
      "REPAIR_APPROVAL_REQUIRED",
      "REPAIR_APPLIED",
      "VERIFICATION_STARTED",
      "VERIFICATION_FAILED",
      "RECOVERY_RETRY",
      "DIAGNOSIS_STARTED",
      "DIAGNOSIS_COMPLETED",
      "REPAIR_PROPOSED",
      "REPAIR_APPROVAL_REQUIRED",
      "REPAIR_APPLIED",
      "VERIFICATION_STARTED",
      "RECOVERY_COMPLETED",
    ]);

    for (const event of events) {
      expect(typeof event.timestamp).toBe("number");
      expect(event.maxAttempts).toBe(2);
      expect(event.attempt).toBeGreaterThanOrEqual(0);
    }
    expect(events[0]!.category).toBe("TEST_FAILURE");
    expect(events.find((e) => e.phase === "REPAIR_APPLIED")?.files).toEqual([
      "src/add.js",
    ]);
    expect(
      events.find((e) => e.phase === "REPAIR_APPROVAL_REQUIRED")?.riskLevel,
    ).toBe("low");

    // No secrets in any event payload.
    const proposed = events.find((e) => e.phase === "REPAIR_PROPOSED");
    expect(proposed?.summary).toContain("[REDACTED]");
    expect(proposed?.summary).not.toContain("abcdef123456");
    for (const event of events) {
      expect(event.summary ?? "").not.toContain("abcdef123456");
    }
  });
});

// ---------------------------------------------------------------------------
// 24: no automatic retry after a terminal failure
// ---------------------------------------------------------------------------

describe("24. no automatic retry after terminal failure", () => {
  it("an UNKNOWN failure never enters the diagnosis loop", async () => {
    const diagnose = vi.fn(() => makeProposal());
    const verify = vi.fn(() => passingVerification());
    const events: RecoveryEvent[] = [];
    const result = await runRecovery(
      {
        output: "hm, something unclassifiable",
      },
      {
        stageRepair: stageRepairOk,
        onEvent: (e) => events.push(e),
        diagnose,
        requestApproval: approveAll,
        verify,
      },
    );
    expect(result.status).toBe("FAILED");
    expect(diagnose).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(events.map((e) => e.phase)).toEqual([
      "FAILURE_DETECTED",
      "RECOVERY_COMPLETED",
    ]);
    expect(result.reason).toContain("Non-recoverable");
  });

  it("a permission-denied command never enters the diagnosis loop", async () => {
    const diagnose = vi.fn(() => makeProposal());
    const result = await runRecovery(
      {
        command: "./run.sh",
        exitCode: 126,
        stderr: "bash: ./run.sh: Permission denied",
      },
      {
        diagnose,
        requestApproval: approveAll,
        verify: () => passingVerification(),
      },
    );
    expect(result.status).toBe("FAILED");
    expect(diagnose).not.toHaveBeenCalled();
    expect(result.reason).toContain("Non-recoverable terminal condition");
  });

  it("a tool-layer failure never enters the diagnosis loop", async () => {
    const diagnose = vi.fn(() => makeProposal());
    const result = await runRecovery(
      {
        toolName: "read_files",
        toolError: true,
        output: "structurally odd",
      },
      {
        stageRepair: stageRepairOk,
        diagnose,
        requestApproval: approveAll,
        verify: () => passingVerification(),
      },
    );
    expect(result.status).toBe("FAILED");
    expect(diagnose).not.toHaveBeenCalled();
    expect(result.category).toBe("TOOL_FAILURE");
  });
});
