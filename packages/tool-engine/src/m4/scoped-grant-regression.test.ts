/**
 * REGRESSION — M4 scoped-grant leak (live-verified vulnerability).
 *
 * Live reproduction that motivated this test: a user approved
 * `node --version` (session grant); LATER `echo CODEPILOT_DENY_PROBE` ran
 * with NO approval card because the scoped-permission matcher matched by
 * ACTION ALONE. A grant for one command authorized a materially different
 * command.
 *
 * The fix binds every scoped grant to an OPERATION FINGERPRINT
 * (action + command + paths + cwd) and makes session binding fail-closed.
 * These tests MUST fail against the vulnerable implementation.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { M4PermissionPipeline } from "./integration.js";
import type { ApprovalPresentation } from "./integration.js";
import {
  PermissionPolicyEngine,
  operationFingerprintOf,
} from "./policy-engine.js";
import { RiskEngine } from "./risk-engine.js";

afterEach(() => {
  vi.useRealTimers();
});

/** Pipeline whose presenter auto-approves the FIRST N requests (session scope). */
function makeAutoApprovingPipeline(
  workspaceRoot: string,
  opts: { approveFirst: number; rejectAfter?: number } = { approveFirst: 1 },
): { pipeline: M4PermissionPipeline; presentations: ApprovalPresentation[] } {
  const presentations: ApprovalPresentation[] = [];
  let manager: M4PermissionPipeline["approvalManager"] | null = null;
  let seen = 0;
  const pipeline = new M4PermissionPipeline({
    workspaceRoot,
    approvalTimeoutMs: 2_000,
    autoApproveReads: true,
    presentApproval: async (presentation) => {
      presentations.push(presentation);
      const m = manager!;
      const idx = seen++;
      queueMicrotask(() => {
        if (idx < opts.approveFirst) m.approve(presentation.approvalId, "session");
        else m.reject(presentation.approvalId);
      });
      return { decision: idx < opts.approveFirst ? "allow" : "deny" };
    },
  });
  manager = pipeline.approvalManager;
  return { pipeline, presentations };
}

describe("M4 scoped-grant leak regression", () => {
  it("approve command A → command B (different command) requires a NEW approval; rejecting B means B NEVER executes", async () => {
    const { pipeline, presentations } = makeAutoApprovingPipeline("/ws", {
      approveFirst: 1,
    });

    // A: node --version — presented, approved (session), allowed.
    const a = await pipeline.evaluate({
      toolId: "run_commands",
      executionId: "exec-A",
      input: { command: "node --version" },
    });
    expect(a.approved).toBe(true);
    expect(presentations).toHaveLength(1); // approval A occurred

    // B: echo CODEPILOT_DENY_PROBE — a MATERIALLY DIFFERENT command.
    const b = await pipeline.evaluate({
      toolId: "run_commands",
      executionId: "exec-B",
      input: { command: "echo CODEPILOT_DENY_PROBE" },
    });
    // THE FIX: B must re-enter the ASK path (fresh approval), not ride on
    // A's grant. Under the vulnerable matcher this returned approved:true.
    expect(b.approved).toBe(false);
    expect(b.decision).toBe("deny"); // presenter rejected the second request
    expect(presentations).toHaveLength(2); // approval B WAS requested
    // B's side effect (its stdout) must never be produced by an authorized
    // execution — the pipeline withheld approval entirely.
    expect(b.reason).toContain("denied");
  });

  it("exact approved command repeated: legitimate re-execution still works", async () => {
    const { pipeline } = makeAutoApprovingPipeline("/ws", { approveFirst: 1 });
    const first = await pipeline.evaluate({
      toolId: "run_commands",
      executionId: "exec-1",
      sessionId: "s-run",
      input: { command: "node --version" },
    });
    expect(first.approved).toBe(true);
    // Same operation (whitespace-normalized equality) in the SAME session →
    // the grant legitimately applies; no new approval needed.
    const repeat = await pipeline.evaluate({
      toolId: "run_commands",
      executionId: "exec-2",
      sessionId: "s-run",
      input: { command: "node   --version" },
    });
    expect(repeat.approved).toBe(true);
  });

  it("same command + different cwd is a DIFFERENT operation (fresh approval)", async () => {
    const { pipeline, presentations } = makeAutoApprovingPipeline("/ws", {
      approveFirst: 1,
    });
    const a = await pipeline.evaluate({
      toolId: "run_commands",
      executionId: "exec-A",
      input: { command: "node --version" },
      cwd: "/ws",
    });
    expect(a.approved).toBe(true);
    const b = await pipeline.evaluate({
      toolId: "run_commands",
      executionId: "exec-B",
      input: { command: "node --version" },
      cwd: "/elsewhere",
    });
    expect(b.approved).toBe(false);
    expect(presentations).toHaveLength(2);
  });

  it("same action on a different FILE (write_file) is a different operation", async () => {
    const { pipeline, presentations } = makeAutoApprovingPipeline("/ws", {
      approveFirst: 1,
    });
    const a = await pipeline.evaluate({
      toolId: "write_file",
      executionId: "exec-A",
      input: { path: "a.txt" },
    });
    expect(a.approved).toBe(true);
    const b = await pipeline.evaluate({
      toolId: "write_file",
      executionId: "exec-B",
      input: { path: "b.txt" },
    });
    expect(b.approved).toBe(false);
    expect(presentations).toHaveLength(2);
  });

  it("undefined sessionId: a session grant can NEVER match a session-less evaluation (fail closed)", async () => {
    const { pipeline } = makeAutoApprovingPipeline("/ws", { approveFirst: 1 });
    // Approved WITH a session id.
    const a = await pipeline.evaluate({
      toolId: "run_commands",
      executionId: "exec-A",
      sessionId: "s-live",
      input: { command: "node --version" },
    });
    expect(a.approved).toBe(true);
    // Live bridge / runtime gate path that omits sessionId — even for the
    // SAME command, the grant must not apply (cannot prove same session).
    const b = await pipeline.evaluate({
      toolId: "run_commands",
      executionId: "exec-B",
      input: { command: "node --version" },
    });
    expect(b.approved).toBe(false);
  });

  it("legacy action-only grants (no fingerprint) authorize nothing", async () => {
    const risk = new RiskEngine();
    const engine = new PermissionPolicyEngine({ riskEngine: risk });
    // Simulate a pre-fix grant stored without a fingerprint.
    engine.grantScopedPermission({
      id: "legacy",
      action: "execute_command",
      scope: "session",
      sessionId: undefined,
    });
    const evaluation = engine.evaluate({
      action: "execute_command",
      toolId: "run_commands",
      executionId: "exec-x",
      metadata: { command: "node --version" },
    });
    expect(evaluation.decision).not.toBe("allow");
    expect(evaluation.decision).not.toBe("allow_session");
  });

  it("grants expire (TTL): an old grant requires fresh approval", async () => {
    vi.useFakeTimers();
    const { pipeline } = makeAutoApprovingPipeline("/ws", { approveFirst: 1 });
    const a = await pipeline.evaluate({
      toolId: "run_commands",
      executionId: "exec-A",
      input: { command: "node --version" },
    });
    expect(a.approved).toBe(true);
    // Advance past the one-hour grant TTL.
    vi.advanceTimersByTime(61 * 60 * 1000);
    const b = await pipeline.evaluate({
      toolId: "run_commands",
      executionId: "exec-B",
      input: { command: "node --version" },
    });
    expect(b.approved).toBe(false);
  });

  it("fingerprint is deterministic and scope-sensitive", () => {
    const base = {
      action: "execute_command" as const,
      metadata: { command: "node --version", cwd: "/ws" },
    };
    expect(operationFingerprintOf(base)).toBe(operationFingerprintOf(base));
    expect(operationFingerprintOf(base)).not.toBe(
      operationFingerprintOf({
        action: "execute_command",
        metadata: { command: "node -v", cwd: "/ws" },
      }),
    );
    expect(operationFingerprintOf(base)).not.toBe(
      operationFingerprintOf({
        action: "write_file",
        metadata: { command: "node --version", cwd: "/ws" },
      }),
    );
    // No command metadata can never collide with a command fingerprint.
    const noCmd = operationFingerprintOf({
      action: "execute_command",
      metadata: {},
    });
    expect(noCmd).not.toBe(operationFingerprintOf(base));
  });
});
