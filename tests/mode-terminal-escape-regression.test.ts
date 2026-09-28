/**
 * REGRESSION — ASK/PLAN terminal escape (live-verified vulnerability).
 *
 * Live reproduction: in ASK mode the model emitted `terminal_session_exec`
 * and a REAL command executed with no approval card — the M7 tracked
 * terminal tools were injected as extra tools in EVERY mode and no mode
 * boundary existed at the security gate.
 *
 * The fix is DEFENSE IN DEPTH at the runtime (not advertisement-only):
 *   L1  buildNativeTools withholds every mutating tool (incl.
 *       terminal_session_start/exec) from the ask/plan request contract.
 *   L2  buildGate REJECTS those tool names in ask/plan EVEN IF a tool is
 *       registered through any other injection path.
 *
 * Proven here:
 *   TEST A/B  — ASK/PLAN end-to-end: registered escalation tool, model emits
 *               the call → ZERO executor invocations, structured denial.
 *   GATE      — the L2 boundary directly: in ask/plan the gate refuses
 *               terminal_session_exec/bash without consulting the host; in
 *               ACT it delegates to the normal M4 path.
 *   TEST C    — ACT end-to-end: the same call reaches M4 and executes.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  CodePilotRuntime,
  createTool,
} from "../packages/agent-runtime/src/index.js";
import type { AgentEvent } from "../packages/agent-runtime/src/types";
import type { AgentTool } from "../packages/agent-runtime/src/native/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const ndjson = (value: unknown): string => `${JSON.stringify(value)}\n`;

function toolCallTurn(name: string, args: Record<string, unknown>): Response {
  return new Response(
    [
      ndjson({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name, arguments: args } }],
        },
        done: false,
      }),
      ndjson({ message: { role: "assistant", content: "" }, done: true }),
    ].join(""),
    { status: 200 },
  );
}

function finalTurn(text: string): Response {
  return new Response(
    [
      ndjson({ message: { role: "assistant", content: text }, done: false }),
      ndjson({ message: { role: "assistant", content: "" }, done: true, eval_count: 2 }),
    ].join(""),
    { status: 200 },
  );
}

/** Stub M7 tracked-terminal exec tool (records every real invocation). */
function makeStubTerminalExec(executions: string[]): AgentTool {
  return createTool({
    name: "terminal_session_exec",
    description: "stub tracked-terminal exec",
    inputSchema: { type: "object", properties: { command: { type: "string" } } },
    execute: async (input) => {
      executions.push(JSON.stringify(input));
      return { ok: true, stdout: "RAN" };
    },
  });
}

describe("ASK/PLAN terminal escape — end-to-end invariants", () => {
  const attempt = async (
    mode: "ask" | "plan" | "act",
    toolName: string,
    args: Record<string, unknown>,
  ) => {
    const dir = mkdtempSync(join(tmpdir(), "mode-escape-"));
    const executions: string[] = [];
    let attempted = false;
    let executed = false;
    let denyReason: string | null = null;

    let firstTurn = true;
    const fetchImpl = vi.fn(async () => {
      if (firstTurn) {
        firstTurn = false;
        return toolCallTurn(toolName, args);
      }
      return finalTurn("done");
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    const events: AgentEvent[] = [];
    const runtime = new CodePilotRuntime({
      workspaceRoot: dir,
      providerId: "ollama",
      modelId: "qwen3:8b",
      agentMode: mode,
      requestApproval: async () => ({ approved: true }),
      extraTools: [makeStubTerminalExec(executions)],
    });
    runtime.subscribe((e) => {
      events.push(e);
      if (e.type === "tool_started" && e.toolName === toolName) {
        attempted = true; // the model's call reached dispatch
      }
      if (e.type === "tool_completed" && e.toolName === toolName) {
        executed = true; // executor RAN (denials emit tool_failed instead)
      }
      if (e.type === "tool_failed" && e.toolName === toolName) {
        denyReason = String((e as { error?: string }).error ?? "");
      }
    });

    await runtime.initialize();
    await runtime.startSession(`Use the ${toolName} tool to run: echo PROBE.`);
    await runtime.dispose().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    return { attempted, executed, denyReason, executorInvocations: executions.length };
  };

  it("TEST A — ASK: the escalation call NEVER executes (zero executor invocations)", async () => {
    const r = await attempt("ask", "terminal_session_exec", {
      sessionId: "s-esc",
      command: "echo PROBE",
    });
    expect(r.attempted).toBe(true); // the model emitted the structured call
    expect(r.executed).toBe(false); // no tool_completed
    expect(r.executorInvocations).toBe(0); // the executor NEVER ran
    expect(r.denyReason ?? "").toMatch(/unavailable in ask mode|Unknown tool/);
  });

  it("TEST B — PLAN: the escalation call NEVER executes (zero executor invocations)", async () => {
    const r = await attempt("plan", "terminal_session_exec", {
      sessionId: "s-esc",
      command: "echo PROBE",
    });
    expect(r.executed).toBe(false);
    expect(r.executorInvocations).toBe(0);
    expect(r.denyReason ?? "").toMatch(/unavailable in plan mode|Unknown tool/);
  });

  it("TEST A2/B2 — bash (direct executor) also never executes in ASK/PLAN", async () => {
    for (const mode of ["ask", "plan"] as const) {
      const r = await attempt(mode, "bash", { command: "echo PROBE" });
      expect(r.executed).toBe(false);
      expect(r.executorInvocations).toBe(0);
    }
  });

  it("TEST C — ACT: the same call reaches the normal M4 path and executes", async () => {
    const r = await attempt("act", "terminal_session_exec", {
      sessionId: "s-esc",
      command: "echo PROBE",
    });
    expect(r.attempted).toBe(true);
    expect(r.executed).toBe(true);
    expect(r.executorInvocations).toBe(1);
    expect(r.denyReason).toBeNull();
  });
});

describe("ASK/PLAN terminal escape — gate boundary (layer 2, direct)", () => {
  /** The runtime's private buildGate(), invoked directly (white-box). */
  const gateOf = (mode: "ask" | "plan" | "act") => {
    const dir = mkdtempSync(join(tmpdir(), "mode-gate-"));
    let hostConsulted = 0;
    const runtime = new CodePilotRuntime({
      workspaceRoot: dir,
      providerId: "ollama",
      modelId: "qwen3:8b",
      agentMode: mode,
      requestApproval: async () => {
        hostConsulted += 1;
        return { approved: true };
      },
    });
    void runtime.initialize().catch(() => undefined);
    const gate = (
      runtime as unknown as {
        buildGate: () => (r: {
          toolCallId: string;
          toolName: string;
          input: unknown;
        }) => Promise<{ approved: boolean; reason?: string }>;
      }
    ).buildGate();
    return { gate, consulted: () => hostConsulted, dir };
  };

  it("ASK: gate refuses terminal_session_exec WITHOUT consulting the host", async () => {
    const { gate, consulted, dir } = gateOf("ask");
    const decision = await gate({
      toolCallId: "t1",
      toolName: "terminal_session_exec",
      input: { sessionId: "s", command: "echo PROBE" },
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain("unavailable in ask mode");
    expect(consulted()).toBe(0); // the host was never asked — denied outright
    rmSync(dir, { recursive: true, force: true });
  });

  it("PLAN: gate refuses bash WITHOUT consulting the host", async () => {
    const { gate, consulted, dir } = gateOf("plan");
    const decision = await gate({
      toolCallId: "t2",
      toolName: "bash",
      input: { command: "echo PROBE" },
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain("unavailable in plan mode");
    expect(consulted()).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("ACT: gate does NOT mode-deny — it defers to the host/M4 decision", async () => {
    const { gate, consulted, dir } = gateOf("act");
    const decision = await gate({
      toolCallId: "t3",
      toolName: "terminal_session_exec",
      input: { sessionId: "s", command: "echo PROBE" },
    });
    expect(decision.approved).toBe(true); // host hook approved (normal M4)
    expect(consulted()).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
