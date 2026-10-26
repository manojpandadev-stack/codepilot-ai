import { describe, expect, it } from "vitest";
import { runAgentLoop } from "./agent-loop.js";
import type { LlmProvider, LlmStreamEvent } from "../llm/types.js";
import type { AgentTool } from "../types.js";

const done: LlmStreamEvent = { type: "finish", reason: "complete" };
function provider(turns: LlmStreamEvent[][]): LlmProvider {
  let index = 0;
  return {
    id: "test",
    async *stream() {
      yield* turns[index++] ?? [];
    },
  };
}
function opts(p: LlmProvider, tools: AgentTool[] = [], maxIterations = 2) {
  return {
    provider: p,
    modelId: "test",
    sessionId: "s",
    tools,
    gate: async () => ({ approved: true }),
    maxIterations,
    onEvent: () => {},
  };
}

describe("agent loop terminal reasons", () => {
  const call = (id: string): LlmStreamEvent => ({
    type: "tool-call",
    call: { toolCallId: id, toolName: "mutate", argumentsText: "{}" },
  });

  it("completes only with a valid finish", async () => {
    expect(
      (
        await runAgentLoop(
          [],
          "hi",
          opts(provider([[{ type: "text-delta", text: "ok" }, done]])),
        )
      ).reason,
    ).toBe("complete");
  });
  it("preserves max iteration termination", async () => {
    const tool = {
      name: "act",
      description: "",
      inputSchema: {},
      execute: async () => "ok",
    } as AgentTool;
    const call: LlmStreamEvent = {
      type: "tool-call",
      call: { toolCallId: "1", toolName: "act", argumentsText: "{}" },
    };
    expect(
      (await runAgentLoop([], "go", opts(provider([[call, done]]), [tool], 1)))
        .reason,
    ).toBe("max_iterations");
  });
  it("marks EOF without terminal signal incomplete", async () => {
    expect(
      (
        await runAgentLoop(
          [],
          "hi",
          opts(provider([[{ type: "text-delta", text: "partial" }]])),
        )
      ).reason,
    ).toBe("incomplete");
  });
  it("preserves cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      (await runAgentLoop([], "hi", opts(provider([])), controller.signal))
        .reason,
    ).toBe("aborted");
  });
  it("cancellation wins over a provider that ignores AbortSignal and emits complete", async () => {
    const controller = new AbortController();
    const ignoresAbort: LlmProvider = {
      id: "ignores-abort",
      async *stream() {
        controller.abort();
        yield { type: "text-delta", text: "late" };
        yield { type: "finish", reason: "complete" };
      },
    };
    const result = await runAgentLoop(
      [],
      "hi",
      opts(ignoresAbort),
      controller.signal,
    );
    expect(result.reason).toBe("aborted");
  });
  it("settles cancellation when a provider stream never resolves", async () => {
    const controller = new AbortController();
    const stalled: LlmProvider = {
      id: "stalled-provider",
      async *stream() {
        await new Promise<void>(() => {});
        yield done;
      },
    };
    const running = runAgentLoop([], "hi", opts(stalled), controller.signal);
    setTimeout(() => controller.abort(), 20);
    expect((await running).reason).toBe("aborted");
  }, 1_000);
  it("preserves provider failure", async () => {
    expect(
      (
        await runAgentLoop(
          [],
          "hi",
          opts(
            provider([[{ type: "finish", reason: "error", error: "broken" }]]),
          ),
        )
      ).reason,
    ).toBe("error");
  });
  it("records tool failure as an error result and allows the model to recover", async () => {
    const tool = {
      name: "act",
      description: "",
      inputSchema: {},
      execute: async () => {
        throw new Error("tool failed");
      },
    } as AgentTool;
    const call: LlmStreamEvent = {
      type: "tool-call",
      call: { toolCallId: "1", toolName: "act", argumentsText: "{}" },
    };
    const result = await runAgentLoop(
      [],
      "go",
      opts(provider([[call, done], [done]]), [tool]),
    );
    expect(result.reason).toBe("complete");
  });

  it("does not execute an approved tool after cancellation while awaiting approval", async () => {
    const controller = new AbortController();
    let releaseApproval!: (value: { approved: boolean }) => void;
    let approvalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      approvalStarted = resolve;
    });
    const approval = new Promise<{ approved: boolean }>((resolve) => {
      releaseApproval = resolve;
    });
    let executions = 0;
    const tool = {
      name: "mutate",
      description: "",
      inputSchema: {},
      execute: async () => {
        executions++;
        return "done";
      },
    } as AgentTool;
    const options = {
      ...opts(provider([[call("one"), call("two"), done]]), [tool]),
      gate: async () => {
        approvalStarted();
        return approval;
      },
    };
    const running = runAgentLoop([], "go", options, controller.signal);
    await started;
    controller.abort();
    releaseApproval({ approved: true });
    expect((await running).reason).toBe("aborted");
    expect(executions).toBe(0);
  });

  it("stops a queued state-changing call when cancellation occurs during the first tool", async () => {
    const controller = new AbortController();
    let toolStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    let executions = 0;
    const tool = {
      name: "mutate",
      description: "",
      inputSchema: {},
      execute: async (_input: unknown, context: { signal?: AbortSignal }) => {
        executions++;
        toolStarted();
        await new Promise<void>((resolve) => {
          if (context.signal?.aborted) return resolve();
          context.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        throw new DOMException("aborted", "AbortError");
      },
    } as AgentTool;
    const running = runAgentLoop(
      [],
      "go",
      opts(provider([[call("one"), call("two"), done]]), [tool]),
      controller.signal,
    );
    await started;
    controller.abort();
    expect((await running).reason).toBe("aborted");
    expect(executions).toBe(1);
  });

  it("does not start tool two when tool one cancels as it completes", async () => {
    const controller = new AbortController();
    let executions = 0;
    const tool = {
      name: "mutate",
      description: "",
      inputSchema: {},
      execute: async () => {
        executions++;
        controller.abort();
        return "first finished while cancelling";
      },
    } as AgentTool;
    const result = await runAgentLoop(
      [],
      "go",
      opts(provider([[call("one"), call("two"), done]]), [tool]),
      controller.signal,
    );
    expect(result.reason).toBe("aborted");
    expect(executions).toBe(1);
  });
});

describe("H6: unverified completion claims in act/auto with zero tool executions", () => {
  const actOpts = (p: LlmProvider, tools: AgentTool[] = []) => ({
    ...opts(p, tools),
    agentMode: "act",
  });
  const textTurn = (text: string): LlmStreamEvent[][] => [
    [{ type: "text-delta", text } as LlmStreamEvent, done],
  ];
  const execTool = {
    name: "reader",
    description: "",
    inputSchema: {},
    execute: async () => "file contents here",
  } as AgentTool;
  const readCall: LlmStreamEvent = {
    type: "tool-call",
    call: { toolCallId: "c1", toolName: "reader", argumentsText: "{}" },
  };

  it("fails a zero-tool act turn that claims to have edited", async () => {
    const result = await runAgentLoop(
      [],
      "fix it",
      actOpts(provider(textTurn("I fixed the bug in calc.js"))),
    );
    expect(result.reason).toBe("error");
    expect(result.error ?? "").toMatch(/without executing any tools/i);
    expect(result.error ?? "").toMatch(/unverified/i);
  });

  it("fails a zero-tool act turn that claims tests pass", async () => {
    const result = await runAgentLoop(
      [],
      "run tests",
      actOpts(provider(textTurn("All tests pass."))),
    );
    expect(result.reason).toBe("error");
  });

  it("fails a zero-tool act turn claiming a file read", async () => {
    const result = await runAgentLoop(
      [],
      "look",
      actOpts(provider(textTurn("I read the file and it looks fine."))),
    );
    expect(result.reason).toBe("error");
  });

  it("completes a zero-tool act turn with plain prose", async () => {
    const result = await runAgentLoop(
      [],
      "hi",
      actOpts(provider(textTurn("Hello! How can I help?"))),
    );
    expect(result.reason).toBe("complete");
  });

  it("completes when a tool actually executed despite claim prose", async () => {
    const result = await runAgentLoop(
      [],
      "fix it",
      actOpts(
        provider([
          [readCall, done],
          [
            { type: "text-delta", text: "I fixed the bug." } as LlmStreamEvent,
            done,
          ],
        ]),
        [execTool],
      ),
    );
    expect(result.reason).toBe("complete");
  });

  it("leaves ask-mode zero-tool claim prose untouched", async () => {
    const result = await runAgentLoop([], "hi", {
      ...opts(provider(textTurn("I fixed the bug and tests pass"))),
      agentMode: "ask",
    });
    expect(result.reason).toBe("complete");
  });

  it("denied tools do not count as executed evidence", async () => {
    const denying = {
      ...opts(provider(textTurn("I edited the file"))),
      agentMode: "act",
      gate: async () => ({ approved: false, reason: "nope" }),
    };
    const tool = {
      name: "editor",
      description: "",
      inputSchema: {},
      execute: async () => "never runs",
    } as AgentTool;
    const callEvt: LlmStreamEvent = {
      type: "tool-call",
      call: { toolCallId: "c9", toolName: "editor", argumentsText: "{}" },
    };
    const result = await runAgentLoop([], "edit", {
      ...denying,
      provider: provider([
        [callEvt, done],
        [
          { type: "text-delta", text: "I edited the file." } as LlmStreamEvent,
          done,
        ],
      ]),
      tools: [tool],
    });
    expect(result.reason).toBe("error");
  });
});

describe("agent loop — F-03 incomplete provider stream at the loop level", () => {
  const call = (id: string): LlmStreamEvent => ({
    type: "tool-call",
    call: { toolCallId: id, toolName: "mutate", argumentsText: "{}" },
  });

  it("propagates an incomplete provider finish (EOF without finish_reason) as incomplete at the loop", async () => {
    // Provider emits text and then a bare [DONE]-equivalent end with no
    // finish_reason. At the provider layer that is "incomplete"; the loop must
    // not upgrade it to "complete" just because it received a finish event.
    const provider = {
      id: "test",
      async *stream() {
        yield { type: "text-delta", text: "I did something" } as LlmStreamEvent;
        // No finish event with a reason — simulate EOF/incomplete.
        yield { type: "finish", reason: "incomplete" } as LlmStreamEvent;
      },
    };
    const result = await runAgentLoop([], "do it", opts(provider));
    expect(result.reason).toBe("incomplete");
  });

  it("propagates a provider error finish as loop error, not incomplete", async () => {
    const provider = {
      id: "test",
      async *stream() {
        yield {
          type: "finish",
          reason: "error",
          error: "provider stream failed",
        } as LlmStreamEvent;
      },
    };
    const result = await runAgentLoop([], "hi", opts(provider));
    expect(result.reason).toBe("error");
    expect(result.error).toContain("provider stream failed");
  });

  it("does not complete when the provider emits a fragmented tool call with no finish_reason", async () => {
    // The provider describes a tool call but never emits a finish_reason and
    // never sends a final complete tool-call block. The loop collects the
    // (unfinished) tool call and would dispatch it; but because the provider
    // itself finished "incomplete", the loop should surface incomplete rather
    // than pretending the turn succeeded.
    //
    // NOTE: the loop only sees fully-flushed tool_call events. Here the
    // provider yields a tool-call event (so the loop queues it) and then a
    // finish(incomplete) with no further tool calls — the loop treats the
    // turn as incomplete, not complete.
    const provider = {
      id: "test",
      async *stream() {
        yield {
          type: "tool-call",
          call: {
            toolCallId: "c1",
            toolName: "editor",
            argumentsText: "{",
          },
        } as LlmStreamEvent;
        yield { type: "finish", reason: "incomplete" } as LlmStreamEvent;
      },
    };
    const result = await runAgentLoop([], "edit", opts(provider));
    expect(result.reason).toBe("incomplete");
  });

  it("still completes when the provider emits a valid finish after tool calls", async () => {
    let executions = 0;
    const tool = {
      name: "mutate",
      description: "",
      inputSchema: {},
      execute: async () => {
        executions++;
        return "done";
      },
    } as AgentTool;
    let turn = 0;
    const provider = {
      id: "test",
      async *stream() {
        if (turn++ === 0) {
          yield call("1") as LlmStreamEvent;
          yield { type: "finish", reason: "complete" } as LlmStreamEvent;
        } else {
          yield { type: "text-delta", text: "done" } as LlmStreamEvent;
          yield { type: "finish", reason: "complete" } as LlmStreamEvent;
        }
      },
    };
    const result = await runAgentLoop([], "go", opts(provider, [tool], 2));
    expect(result.reason).toBe("complete");
    expect(executions).toBe(1);
  });
});

describe("agent loop — F-02 cancellation during approval must not start tool.execute", () => {
  const call = (id: string): LlmStreamEvent => ({
    type: "tool-call",
    call: { toolCallId: id, toolName: "mutate", argumentsText: "{}" },
  });

  it("does not execute an approved tool after cancellation while awaiting approval (retained)", async () => {
    const controller = new AbortController();
    let releaseApproval!: (value: { approved: boolean }) => void;
    let approvalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      approvalStarted = resolve;
    });
    const approval = new Promise<{ approved: boolean }>((resolve) => {
      releaseApproval = resolve;
    });
    let executions = 0;
    const tool = {
      name: "mutate",
      description: "",
      inputSchema: {},
      execute: async () => {
        executions++;
        return "done";
      },
    } as AgentTool;
    const options = {
      ...opts(provider([[call("one"), call("two"), done]]), [tool]),
      gate: async () => {
        approvalStarted();
        return approval;
      },
    };
    const running = runAgentLoop([], "go", options, controller.signal);
    await started;
    controller.abort();
    releaseApproval({ approved: true });
    expect((await running).reason).toBe("aborted");
    expect(executions).toBe(0);
  });

  it("does not execute a tool approved concurrently with cancellation (simultaneity)", async () => {
    // The gate resolves at roughly the same moment the controller is aborted.
    // Either order must leave executions at 0.
    let releaseApproval!: (value: { approved: boolean }) => void;
    const approval = new Promise<{ approved: boolean }>((resolve) => {
      releaseApproval = resolve;
    });
    let executions = 0;
    const tool = {
      name: "mutate",
      description: "",
      inputSchema: {},
      execute: async () => {
        executions++;
        await new Promise<void>((r) => setTimeout(r, 50));
        return "done";
      },
    } as AgentTool;
    const controller = new AbortController();
    const options = {
      ...opts(provider([[call("one"), done]]), [tool]),
      gate: async () => {
        // Hold the gate open briefly so cancellation can race it.
        await new Promise<void>((r) => setTimeout(r, 10));
        return approval;
      },
    };
    const running = runAgentLoop([], "go", options, controller.signal);
    // Fire approval and cancellation in the same microtask batch (simulating
    // a concurrent user click + stop).
    Promise.resolve().then(() => {
      releaseApproval({ approved: true });
      controller.abort();
    });
    const result = await running;
    expect(result.reason).toBe("aborted");
    expect(executions).toBe(0);
  });

  it("returns cancelled when cancellation arrives before the gate is even called", async () => {
    const controller = new AbortController();
    controller.abort();
    let gateCalled = false;
    let executions = 0;
    const tool = {
      name: "mutate",
      description: "",
      inputSchema: {},
      execute: async () => {
        executions++;
        return "done";
      },
    } as AgentTool;
    const options = {
      ...opts(provider([[call("one"), done]]), [tool]),
      gate: async () => {
        gateCalled = true;
        return { approved: true };
      },
    };
    const result = await runAgentLoop([], "go", options, controller.signal);
    expect(result.reason).toBe("aborted");
    expect(gateCalled).toBe(false);
    expect(executions).toBe(0);
  });

  it("does not restart a cancelled approval-turn via recovery (reason stays aborted)", async () => {
    // A recovery loop must not reinterpret an aborted approval-turn as
    // "complete" or "error" and retry it. The loop result reason is aborted.
    const controller = new AbortController();
    let releaseApproval!: (value: { approved: boolean }) => void;
    let approvalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      approvalStarted = resolve;
    });
    const approval = new Promise<{ approved: boolean }>((resolve) => {
      releaseApproval = resolve;
    });
    let executions = 0;
    const tool = {
      name: "mutate",
      description: "",
      inputSchema: {},
      execute: async () => {
        executions++;
        return "done";
      },
    } as AgentTool;
    const options = {
      ...opts(provider([[call("one"), done]]), [tool]),
      gate: async () => {
        approvalStarted();
        return approval;
      },
      maxIterations: 5,
    };
    const running = runAgentLoop([], "go", options, controller.signal);
    await started;
    controller.abort();
    releaseApproval({ approved: true });
    const result = await running;
    expect(result.reason).toBe("aborted");
    expect(executions).toBe(0);
    // A caller inspecting result.reason for retry should see aborted, never
    // complete or error.
    expect(["complete", "error", "max_iterations"]).not.toContain(
      result.reason,
    );
  });
});
