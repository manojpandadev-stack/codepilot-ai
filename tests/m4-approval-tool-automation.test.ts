/**
 * Phase 10 — M4 approval boundary: write/execute tools still require the
 * human decision, and a rejection NEVER executes.
 *
 * Two layers, all real except the human click (simulated through the M4
 * pipeline's own approve()/reject() API — never bypassed):
 *
 *   A. LiveToolPermissionBridge + full M4PermissionPipeline
 *      (RiskEngine → PermissionPolicyEngine → ApprovalManager →
 *      SecurityValidator): bash / run_commands / write_file / editor /
 *      delete_file require an approval presentation; approve → decision
 *      allow; reject → approved:false and the executor never runs.
 *
 *   B. The production runtime gate (policyEngine.checkPermission →
 *      requestApproval) in ACT mode: policy marks these tools "approval",
 *      so the runtime gate calls the host hook and a false decision denies
 *      the dispatch; the tool's execute is never invoked and the loop
 *      surfaces tool_denied.
 *
 * No phrase-based execution, no auto-approve path exists in either layer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Windows-tolerant temp cleanup: a just-exited shell's CWD can hold the
 * directory briefly (EPERM/EBUSY). Retry with short blocking waits; NEVER
 * fail the suite on cleanup — leftovers are harmless and OS-reclaimed.
 */
function rmTempSafe(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "EPERM" && code !== "ENOTEMPTY" && code !== "EBUSY") return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150 * (attempt + 1));
    }
  }
}
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { M4PermissionPipeline } from "../packages/tool-engine/src/m4/integration";
import type { ApprovalPresentation } from "../packages/tool-engine/src/m4/integration";
import { LiveToolPermissionBridge } from "../packages/tool-engine/src/m4/live-bridge";
import {
  CodePilotRuntime,
  buildCodePilotBuiltinTools,
} from "../packages/agent-runtime/src/index.js";
import type { AgentEvent } from "../packages/agent-runtime/src/types";

// ---------------------------------------------------------------------------
// Layer A — real M4 pipeline + live bridge
// ---------------------------------------------------------------------------

describe("Phase 10 — M4 approval accept/reject (bridge layer)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "phase10-m4-"));
  });

  afterEach(() => {
    rmTempSafe(dir);
  });

  /** Pipeline whose presenter resolves via the ApprovalManager like the host. */
  const makePipeline = (
    decide: (presentation: ApprovalPresentation) => "allow" | "deny",
  ): M4PermissionPipeline => {
    let manager: M4PermissionPipeline["approvalManager"] | null = null;
    const pipeline = new M4PermissionPipeline({
      workspaceRoot: dir,
      approvalTimeoutMs: 2_000,
      autoApproveReads: true,
      presentApproval: async (presentation) => {
        const m = manager!;
        const d = decide(presentation);
        queueMicrotask(() => {
          if (d === "allow") m.approve(presentation.approvalId);
          else m.reject(presentation.approvalId);
        });
        return { decision: d };
      },
    });
    manager = pipeline.approvalManager;
    return pipeline;
  };

  const cases = [
    { toolName: "bash", input: { command: "node --version" } },
    { toolName: "run_commands", input: { command: "node --version" } },
    { toolName: "write_file", input: { path: "a.txt", content: "x" } },
    { toolName: "editor", input: { file_path: "a.txt", operation: "replace", old_string: "a", new_string: "b" } },
    { toolName: "delete_file", input: { path: "a.txt" } },
  ];

  it.each(cases.map((c) => [c.toolName, c.input] as const))(
    "%s — presented for approval, executes the decision path (accept)",
    async (_toolName, input) => {
      let presented: ApprovalPresentation | undefined;
      const bridge = new LiveToolPermissionBridge(
        makePipeline((presentation) => {
          presented = presentation;
          return "allow";
        }),
      );
      const result = await bridge.evaluateLiveTool({
        toolName: _toolName,
        input,
        sessionId: "s-accept",
      });
      expect(result.approved).toBe(true);
      expect(result.decision).toBe("allow");
      expect(presented).toBeDefined();
      expect(presented!.toolId.length).toBeGreaterThan(0);
    },
  );

  it.each(cases.map((c) => [c.toolName, c.input] as const))(
    "%s — user rejection denies the decision (never auto-approves)",
    async (_toolName, input) => {
      let presentations = 0;
      const bridge = new LiveToolPermissionBridge(
        makePipeline(() => {
          presentations += 1;
          return "deny";
        }),
      );
      const result = await bridge.evaluateLiveTool({
        toolName: _toolName,
        input,
        sessionId: "s-deny",
      });
      expect(result.approved).toBe(false);
      expect(presentations).toBe(1);
    },
  );

  it("bridge denies closed when the pipeline evaluation throws", async () => {
    const broken = {
      evaluate: async () => {
        throw new Error("pipeline offline");
      },
    } as unknown as M4PermissionPipeline;
    const bridge = new LiveToolPermissionBridge(broken);
    const result = await bridge.evaluateLiveTool({
      toolName: "bash",
      input: { command: "node --version" },
    });
    expect(result.approved).toBe(false);
    expect(result.decision).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Layer B — production runtime gate in ACT mode (executor is a REAL shell run)
// ---------------------------------------------------------------------------

describe("Phase 10 — runtime gate in ACT mode (real dispatch, real shell)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "phase10-rt-"));
  });

  afterEach(() => {
    rmTempSafe(dir);
  });

  const ndjson = (value: unknown): string => `${JSON.stringify(value)}\n`;

  function stubChat(responder: (body: Record<string, unknown>) => Response): void {
    const fetchImpl = vi.fn(async (_input: unknown, init?: { body?: string }) => {
      return responder(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);
  }

  const toolCallTurn = (name: string, args: Record<string, unknown>): Response =>
    new Response(
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

  const finalTurn = (): Response =>
    new Response(
      [
        ndjson({ message: { role: "assistant", content: "done" }, done: false }),
        ndjson({ message: { role: "assistant", content: "" }, done: true, eval_count: 2 }),
      ].join(""),
      { status: 200 },
    );

  const collect = () => {
    const events: AgentEvent[] = [];
    return { events, byType: (t: string) => events.filter((e) => e.type === t) };
  };

  const makeRuntime = (approve: boolean) => {
    const sink = collect();
    const runtime = new CodePilotRuntime({
      workspaceRoot: dir,
      providerId: "ollama",
      modelId: "qwen3:8b",
      agentMode: "act",
      requestApproval: async () => ({ approved: approve, reason: approve ? undefined : "user clicked Deny" }),
    });
    runtime.subscribe((e) => sink.events.push(e));
    return { runtime, sink };
  };

  beforeEach(() => {
    stubChat((body) => {
      const tools = (body.tools ?? []) as Array<{ function: { name: string } }>;
      const names = tools.map((t) => t.function.name);
      if (!names.includes("run_commands")) return finalTurn();
      if (names.includes("tool_result")) return finalTurn();
      const last = (body.messages as Array<{ role: string; content: unknown }>).at(-1);
      const alreadyRan = Array.isArray(last?.content)
        ? (last!.content as Array<{ type: string }>).some((b) => b.type === "tool_result")
        : false;
      return alreadyRan ? finalTurn() : toolCallTurn("run_commands", { command: "echo CODEPILOT_GATE_PROBE" });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Real process spawn: under full-suite CPU load the shell settle needs
  // more than the 30s global default — an environmental bound, not a weaker
  // assertion (same timeout pattern as the live suites).
  it("ACT: approved run_commands executes (echo → output returned to the model)", { timeout: 120_000 }, async () => {
    const { runtime, sink } = makeRuntime(true);
    await runtime.initialize();
    await runtime.startSession("Run echo CODEPILOT_GATE_PROBE.");
    await runtime.dispose().catch(() => undefined);

    expect(sink.byType("tool_started").length).toBeGreaterThan(0);
    const completed = sink.byType("tool_completed") as Array<{ toolName: string; output?: string }>;
    expect(completed.map((e) => e.toolName)).toContain("run_commands");
    const run = completed.find((e) => e.toolName === "run_commands");
    expect(String(run?.output ?? "")).toContain("CODEPILOT_GATE_PROBE");
    expect(sink.byType("error")).toHaveLength(0);
  });

  it("ACT: rejected run_commands NEVER executes (denied + no output event)", { timeout: 120_000 }, async () => {
    const { runtime, sink } = makeRuntime(false);
    await runtime.initialize();
    await runtime.startSession("Run echo CODEPILOT_GATE_PROBE.");
    await runtime.dispose().catch(() => undefined);

    expect(sink.byType("tool_started").length).toBeGreaterThan(0);
    const failed = sink.byType("tool_failed") as Array<{ toolName?: string; error?: string }>;
    const deny = failed.find((e) => e.toolName === "run_commands");
    expect(deny).toBeDefined();
    expect(String(deny?.error ?? "")).toContain("Deny");
    const completed = sink.byType("tool_completed") as Array<{ toolName?: string; output?: string }>;
    const run = completed.find((e) => e.toolName === "run_commands");
    expect(run).toBeUndefined();
  });
});
