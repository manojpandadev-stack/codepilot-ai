/**
 * F-02/F-03 — terminal outcome propagation (reproduction + regression).
 *
 * Invariants (proved here, never inferred):
 * - Cancellation is terminal: once abort wins, no tool executes, no recovery
 *   or retry starts, and no layer reports COMPLETE.
 * - No valid terminal completion evidence means NOT COMPLETE: truncated
 *   provider turns settle as failures, never silent completions.
 *
 * No network, no model. Providers are fakes; fetch is trapped or stubbed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "./native/engine/agent-loop.js";
import type { AgentTool } from "./native/types.js";
import type { LlmProvider, LlmStreamEvent } from "./native/llm/types.js";
import { dispatchToolCall } from "./native/engine/tool-dispatch.js";
import { runRecovery } from "./recovery-controller.js";
/**
 * Fake host ChangeSet staging bridge. Every repair the controller applies must
 * first become a pending ChangeSet — this models the production bridge, which
 * registers the approved repair with the host ChangeSetManager.
 */
const stageRepairOk = () => ({ ok: true as const, changeSetId: "cs-staged" });

import { CodePilotRuntime } from "./runtime.js";
import { MultiAgentOrchestrator } from "./orchestrator.js";
import { NativeSessionManager } from "./native/engine/session.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeProvider(
  script: LlmStreamEvent[][],
  seen?: { calls: number },
): LlmProvider {
  return {
    id: "fake",
    stream: async function* (_req) {
      if (seen) seen.calls += 1;
      const turn = script.shift() ?? [];
      for (const evt of turn) yield evt;
    },
  };
}

const done = { type: "finish", reason: "complete" } as const;

function toolCall(id: string, name = "reader"): LlmStreamEvent {
  return {
    type: "tool-call",
    call: { toolCallId: id, toolName: name, argumentsText: "{}" },
  } as LlmStreamEvent;
}

function readerTool(executions: { count: number }, name = "reader"): AgentTool {
  return {
    name,
    description: "test reader",
    inputSchema: { type: "object" },
    execute: async () => {
      executions.count += 1;
      return "content";
    },
  } as AgentTool;
}

function baseLoopOptions(
  provider: LlmProvider,
  tools: AgentTool[],
  over?: Record<string, unknown>,
) {
  return {
    provider,
    modelId: "m",
    sessionId: "s",
    tools,
    gate: async () => ({ approved: true }),
    maxIterations: 5,
    onEvent: () => {},
    ...over,
  } as Parameters<typeof runAgentLoop>[2];
}

// ---------------------------------------------------------------------------
// F-02 — dispatch level
// ---------------------------------------------------------------------------

describe("F-02 dispatch cancellation", () => {
  it("1. pre-aborted signal never reaches tool.execute", async () => {
    const executions = { count: 0 };
    const controller = new AbortController();
    controller.abort();
    const outcome = await dispatchToolCall(
      readerTool(executions),
      { toolCallId: "c1", toolName: "reader", argumentsText: "{}" },
      async () => ({ approved: true }),
      { sessionId: "s", iteration: 1, signal: controller.signal },
    );
    expect(executions.count).toBe(0);
    expect(outcome.denied).toBe(true);
  });

  it("returns from pending approval promptly when cancellation wins", async () => {
    const executions = { count: 0 };
    const controller = new AbortController();
    let release!: (v: { approved: boolean }) => void;
    let gateStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      gateStarted = resolve;
    });
    const gate = () => {
      gateStarted();
      return new Promise<{ approved: boolean }>((resolve) => {
        release = resolve;
      });
    };
    const pending = dispatchToolCall(
      readerTool(executions),
      { toolCallId: "c1", toolName: "reader", argumentsText: "{}" },
      gate,
      { sessionId: "s", iteration: 1, signal: controller.signal },
    );
    await started;
    controller.abort();
    const outcome = await pending;
    release({ approved: true });
    expect(outcome.denied).toBe(true);
    expect(executions.count).toBe(0);
  });

  it("3. approval resolving approved after cancellation still blocks execute", async () => {
    const executions = { count: 0 };
    const controller = new AbortController();
    let release!: (v: { approved: boolean }) => void;
    const gate = () =>
      new Promise<{ approved: boolean }>((resolve) => {
        release = resolve;
      });
    const pending = dispatchToolCall(
      readerTool(executions),
      { toolCallId: "c1", toolName: "reader", argumentsText: "{}" },
      gate,
      { sessionId: "s", iteration: 1, signal: controller.signal },
    );
    controller.abort();
    release({ approved: true });
    const outcome = await pending;
    expect(executions.count).toBe(0);
    expect(outcome.denied).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F-02 — loop level
// ---------------------------------------------------------------------------

describe("F-02 agent-loop cancellation is terminal", () => {
  it("5. provider ignoring AbortSignal that still emits finish(complete) yields cancellation", async () => {
    // Uncooperative provider: never observes the signal, keeps streaming,
    // and claims success. Cancellation must still win at the post-stream
    // boundary — before any tool dispatch or completion report.
    // Limitation (documented, not claimed otherwise): a provider that HANGS
    // forever despite abort cannot be preempted; the loop passes the signal
    // through and settles on whatever the transport eventually yields.
    const executions = { count: 0 };
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const stubborn: LlmProvider = {
      id: "stubborn",
      stream: async function* () {
        yield { type: "text-delta", text: "partial" } as LlmStreamEvent;
        await gate;
        yield toolCall("c1");
        yield { type: "finish", reason: "complete" } as LlmStreamEvent;
      },
    };
    const running = runAgentLoop(
      [],
      "go",
      baseLoopOptions(stubborn, [readerTool(executions)]),
      controller.signal,
    );
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    release();
    const result = await running;
    expect(result.reason).toBe("aborted");
    expect(executions.count).toBe(0);
  });

  it("8. already-aborted signal returns aborted without calling the provider", async () => {
    const seen = { calls: 0 };
    const controller = new AbortController();
    controller.abort();
    const result = await runAgentLoop(
      [],
      "go",
      baseLoopOptions(
        fakeProvider(
          [[{ type: "text-delta", text: "hi" } as LlmStreamEvent, done]],
          seen,
        ),
        [],
      ),
      controller.signal,
    );
    expect(result.reason).toBe("aborted");
    expect(seen.calls).toBe(0);
  });

  it("critical race: late approval after abort yields CANCELLED, never COMPLETE", async () => {
    const executions = { count: 0 };
    const seen = { calls: 0 };
    const controller = new AbortController();
    let release!: (v: { approved: boolean }) => void;
    const gate = () =>
      new Promise<{ approved: boolean }>((resolve) => {
        release = resolve;
      });
    const provider = fakeProvider([[toolCall("c1"), done]], seen);
    const running = runAgentLoop(
      [],
      "go",
      baseLoopOptions(provider, [readerTool(executions)], { gate }),
      controller.signal,
    );
    // Let the turn reach the pending gate, then cancel, then approve late.
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    release({ approved: true });
    const result = await running;
    expect(executions.count).toBe(0);
    expect(result.reason).toBe("aborted");
    // No second model turn was started after cancellation.
    expect(seen.calls).toBe(1);
  });

  it("5. abort during tool execution stops the turn with no further tools", async () => {
    const executions = { count: 0 };
    const second = { count: 0 };
    const controller = new AbortController();
    const blocking = {
      name: "blocker",
      description: "hangs until abort",
      inputSchema: { type: "object" },
      execute: async (_input: unknown, ctx?: { signal?: AbortSignal }) =>
        new Promise<string>((_, reject) => {
          ctx?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    } as unknown as AgentTool;
    const provider = fakeProvider([
      [toolCall("c1", "blocker"), toolCall("c2", "second"), done],
    ]);
    const running = runAgentLoop(
      [],
      "go",
      baseLoopOptions(provider, [blocking, readerTool(second, "second")]),
      controller.signal,
    );
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    const result = await running;
    expect(result.reason).toBe("aborted");
    expect(second.count).toBe(0);
    expect(executions.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F-02 — recovery + retry + runtime + orchestration
// ---------------------------------------------------------------------------

describe("F-02 cancellation across recovery, runtime, orchestration", () => {
  it("6. cancel during verification settles CANCELLED with no further attempts", async () => {
    const controller = new AbortController();
    let verifications = 0;
    const result = await runRecovery(
      {
        command: "npm test",
        exitCode: 1,
        stdout: "AssertionError: nope",
      },
      {
        stageRepair: stageRepairOk,
        signal: controller.signal,
        maxAttempts: 3,
        diagnose: () => ({
          summary: "fix",
          files: ["a.ts"],
          apply: async () => ({ success: true, filesChanged: ["a.ts"] }),
        }),
        requestApproval: () => ({ approved: true }),
        verify: () => {
          verifications += 1;
          controller.abort();
          return new Promise<never>(() => {});
        },
      },
    );
    expect(result.status).toBe("CANCELLED");
    expect(verifications).toBe(1);
  });

  it("9. stopSession never settles as COMPLETE", async () => {
    // Abort-aware hang: rejects when the run aborts, like a real transport.
    const hangingFetch = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          if (init?.signal?.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    ) as unknown as typeof fetch;
    vi.stubGlobal("fetch", hangingFetch);
    const rt = new CodePilotRuntime({
      workspaceRoot: process.cwd(),
      providerId: "ollama",
      modelId: "qwen3:8b",
      agentMode: "act",
      requestApproval: async () => ({ approved: true }),
    });
    const events: Array<{ type: string }> = [];
    rt.subscribe((e) => {
      events.push({ type: e.type });
    });
    await rt.initialize();
    const run = rt.startSession("hang forever");
    await new Promise((r) => setTimeout(r, 50));
    await rt.stopSession();
    await run;
    const types = events.map((e) => e.type);
    expect(types).toContain("cancelled");
    expect(types).not.toContain("completed");
    expect(types).not.toContain("agent.completed");
    expect(rt.getState().status).toBe("idle");
    await rt.dispose().catch(() => undefined);
  });

  it("orchestrator abort settles CANCELLED, never COMPLETED", async () => {
    const hangingFetch = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          if (init?.signal?.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    ) as unknown as typeof fetch;
    vi.stubGlobal("fetch", hangingFetch);
    const orch = new MultiAgentOrchestrator(
      {
        providerId: "ollama",
        modelId: "qwen3:8b",
        workspaceRoot: process.cwd(),
        privacyMode: "local",
        maxIterations: 2,
      },
      { maxConcurrency: 1 },
    );
    try {
      const executing = orch.execute("summarize the repo", "act", {
        roles: ["architect"],
      });
      await new Promise((r) => setTimeout(r, 100));
      orch.cancel();
      const outcome = await executing;
      expect(outcome.outcome.outcome).toBe("CANCELLED");
    } finally {
      orch.dispose();
    }
  }, 15000);
});

// ---------------------------------------------------------------------------
// F-03 — incomplete streams
// ---------------------------------------------------------------------------

describe("F-03 incomplete provider output is never completion", () => {
  function ollamaStub(body: string) {
    return vi.fn(
      async () => new Response(body, { status: 200 }),
    ) as unknown as typeof fetch;
  }

  const nd = (line: unknown): string => `${JSON.stringify(line)}\n`;

  it("Ollama EOF without done:true is incomplete at the provider", async () => {
    const { OllamaLlmProvider } = await import("./native/llm/ollama.js");
    const provider = new OllamaLlmProvider({
      baseUrl: "http://localhost:11434",
      fetchImpl: ollamaStub(
        nd({ message: { role: "assistant", content: "half" }, done: false }),
      ),
    });
    const reasons: string[] = [];
    for await (const evt of provider.stream({
      providerId: "ollama",
      modelId: "m",
      messages: [{ role: "user", content: "hi" }],
    })) {
      if (evt.type === "finish") reasons.push(evt.reason);
    }
    expect(reasons).toEqual(["incomplete"]);
  });

  it("Ollama done:true still completes", async () => {
    const { OllamaLlmProvider } = await import("./native/llm/ollama.js");
    const provider = new OllamaLlmProvider({
      baseUrl: "http://localhost:11434",
      fetchImpl: ollamaStub(
        nd({ message: { role: "assistant", content: "hi" }, done: false }) +
          nd({
            message: { role: "assistant", content: "" },
            done: true,
            prompt_eval_count: 1,
            eval_count: 1,
          }),
      ),
    });
    const reasons: string[] = [];
    for await (const evt of provider.stream({
      providerId: "ollama",
      modelId: "m",
      messages: [{ role: "user", content: "hi" }],
    })) {
      if (evt.type === "finish") reasons.push(evt.reason);
    }
    expect(reasons).toEqual(["complete"]);
  });

  it("loop: partial tool call + EOF returns incomplete without executing", async () => {
    const executions = { count: 0 };
    const provider = fakeProvider([
      [
        { type: "text-delta", text: "calling" } as LlmStreamEvent,
        {
          type: "tool-call",
          call: {
            toolCallId: "c1",
            toolName: "reader",
            argumentsText: '{"p":',
          },
        } as unknown as LlmStreamEvent,
        // stream ends with no finish event: truncated mid-tool-call.
      ],
    ]);
    const result = await runAgentLoop(
      [],
      "go",
      baseLoopOptions(provider, [readerTool(executions)]),
    );
    expect(result.reason).toBe("incomplete");
    expect(executions.count).toBe(0);
  });

  it("runtime: truncated Ollama turn settles FAILED, never completed", async () => {
    vi.stubGlobal(
      "fetch",
      ollamaStub(
        nd({ message: { role: "assistant", content: "half" }, done: false }),
      ),
    );
    const rt = new CodePilotRuntime({
      workspaceRoot: process.cwd(),
      providerId: "ollama",
      modelId: "qwen3:8b",
      agentMode: "act",
      requestApproval: async () => ({ approved: true }),
    });
    const events: string[] = [];
    rt.subscribe((e) => {
      events.push(e.type);
    });
    await rt.initialize();
    await expect(rt.startSession("say something")).rejects.toThrow(
      /without valid terminal completion evidence/i,
    );
    expect(events).not.toContain("completed");
    expect(events).not.toContain("agent.completed");
    expect(events).toContain("agent.failed");
    await rt.dispose().catch(() => undefined);
  });

  it("session maps truncated turns to failed status, never completed", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          `${JSON.stringify({ message: { role: "assistant", content: "half" }, done: false })}\n`,
          { status: 200 },
        ),
    );
    const mgr = new NativeSessionManager([]);
    const sessionId = "sess-truncated";
    const config = {
      providerId: "ollama",
      modelId: "m",
      tools: [],
      gate: async () => ({ approved: true }),
      maxIterations: 5,
    };
    mgr.create(sessionId, config);
    const statuses: string[] = [];
    const result = await mgr.run(sessionId, config, "hi", (e) => {
      if (e.type === "status") statuses.push(e.status);
    });
    expect(result.reason).toBe("incomplete");
    expect(statuses).toContain("failed");
    expect(statuses).not.toContain("completed");
    mgr.dispose();
  });

  it("orchestrator: truncated child turn fails the task, never completes it", async () => {
    vi.stubGlobal(
      "fetch",
      ollamaStub(
        nd({ message: { role: "assistant", content: "half" }, done: false }),
      ),
    );
    const orch = new MultiAgentOrchestrator(
      {
        providerId: "ollama",
        modelId: "qwen3:8b",
        workspaceRoot: process.cwd(),
        privacyMode: "local",
        maxIterations: 2,
      },
      { maxConcurrency: 1 },
    );
    try {
      const outcome = await orch.execute("summarize the repo", "act", {
        roles: ["architect"],
      });
      expect(outcome.outcome.outcome).toBe("FAILED");
    } finally {
      orch.dispose();
    }
  }, 15000);
});
