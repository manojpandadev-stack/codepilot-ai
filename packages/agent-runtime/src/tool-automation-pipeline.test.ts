/**
 * Tool automation pipeline — Phases 4–9, deterministic (no network, no model).
 *
 * Proves each link of the native tool-calling chain in isolation AND chained:
 *
 *   4. Registered AgentTools reach the provider request unmodified
 *      (name/description/inputSchema preserved — what the model reasons over).
 *   5. The Ollama adapter serializes them to the exact /api/chat wire shape
 *      ({type:"function", function:{name, description, parameters}}) and maps
 *      the tool_use/tool_result protocol onto Ollama messages.
 *   6. Ollama NDJSON streaming: tool_calls arrive whole (object OR string
 *      arguments), content/thinking mix streams, malformed lines are
 *      tolerated, an `error` line surfaces as finish(error) — never a valid
 *      call silently dropped.
 *   7. The dispatcher is deny-closed: unknown tool / unparsable arguments /
 *      gate denial / gate crash all block execution; only an explicit
 *      approval reaches the executor; results are bounded.
 *   8. A tool result is appended as the next user message (tool_result block)
 *      and physically reaches the model's NEXT request (role:"tool").
 *   9. Multi-step: read → bash → final answer across three iterations with
 *      no premature termination; maxIterations still bounds a runaway loop.
 *
 * M4 approval acceptance/rejection is exercised further in Phase 10.
 */
import { describe, expect, it, vi } from "vitest";
import { OllamaLlmProvider, toOllamaMessages } from "./native/llm/ollama.js";
import {
  LlmError,
  type LlmProvider,
  type LlmRequest,
  type LlmStreamEvent,
  type LlmToolCall,
} from "./native/llm/types.js";
import {
  dispatchToolCall,
  type ToolGate,
} from "./native/engine/tool-dispatch.js";
import {
  runAgentLoop,
  type AgentLoopEvent,
} from "./native/engine/agent-loop.js";
import {
  createTool,
  type AgentMessage,
  type AgentTool,
} from "./native/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ndjson = (value: unknown): string => `${JSON.stringify(value)}\n`;

function okChatResponse(lines: unknown[]): Response {
  return new Response(lines.map(ndjson).join(""), { status: 200 });
}

const call = (
  toolName: string,
  args: Record<string, unknown> | string,
): LlmToolCall => ({
  toolCallId: `call_${Math.random().toString(36).slice(2, 8)}`,
  toolName,
  argumentsText: typeof args === "string" ? args : JSON.stringify(args),
});

/** Read-only tool mirroring the builtin read_files schema. */
function readFilesTool(impl?: AgentTool["execute"]): AgentTool {
  return createTool({
    name: "read_files",
    description: "Read text file content from the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          description: "Files to read.",
          items: { type: "object", properties: { path: { type: "string" } } },
        },
      },
      required: ["files"],
    },
    execute: impl ?? (async () => "FILE CONTENT HI"),
  });
}

function bashTool(impl?: AgentTool["execute"]): AgentTool {
  return createTool({
    name: "bash",
    description: "Run a shell command in the workspace.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    execute: impl ?? (async () => "v24.0.0"),
  });
}

const approveAll: ToolGate = async () => ({ approved: true });

/** Provider that replays scripted LlmStreamEvent turns, recording requests. */
class ScriptedProvider implements LlmProvider {
  readonly id = "scripted";
  requests: LlmRequest[] = [];
  private turns: LlmStreamEvent[][] = [];
  pushTurn(events: LlmStreamEvent[]): void {
    this.turns.push(events);
  }
  async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    this.requests.push(request);
    const turn = this.turns.shift();
    if (!turn) throw new Error("scripted provider exhausted its turns");
    for (const evt of turn) yield evt;
  }
}

const toolCallEvent = (
  toolName: string,
  args: Record<string, unknown>,
): LlmStreamEvent => ({
  type: "tool-call",
  call: call(toolName, args),
});

const finishOk = (): LlmStreamEvent => ({ type: "finish", reason: "complete" });

const blocksOf = (m: AgentMessage): Array<Record<string, unknown>> =>
  Array.isArray(m.content)
    ? (m.content as unknown as Array<Record<string, unknown>>)
    : [];

// ---------------------------------------------------------------------------
// Phase 5 — Ollama request serialization
// ---------------------------------------------------------------------------

describe("Phase 5 — Ollama request serialization", () => {
  it("serializes tools to {type:'function', function:{name,description,parameters}} in the /api/chat body", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(
      async (_input: unknown, init?: { body?: string }) => {
        bodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
        return okChatResponse([
          { message: { role: "assistant", content: "ok" }, done: false },
          { message: { role: "assistant", content: "" }, done: true },
        ]);
      },
    ) as unknown as typeof fetch;

    const toolA = readFilesTool();
    const toolB = bashTool();
    const provider = new OllamaLlmProvider({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl,
    });
    const events: LlmStreamEvent[] = [];
    for await (const evt of provider.stream({
      providerId: "ollama",
      modelId: "qwen2.5-coder:3b",
      systemPrompt: "SYS",
      messages: [{ role: "user", content: "hi" }],
      tools: [toolA, toolB],
    } as LlmRequest)) {
      events.push(evt);
    }

    const body = bodies[0]!;
    expect(body.model).toBe("qwen2.5-coder:3b");
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "hi" },
    ]);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read_files",
          description: toolA.description,
          parameters: toolA.inputSchema,
        },
      },
      {
        type: "function",
        function: {
          name: "bash",
          description: toolB.description,
          parameters: toolB.inputSchema,
        },
      },
    ]);
    expect(events[events.length - 1]).toEqual({
      type: "finish",
      reason: "complete",
    });
  });

  it("toOllamaMessages maps tool_use/tool_result protocol to assistant.tool_calls + role:'tool' (error prefix included)", () => {
    const wire = toOllamaMessages([
      { role: "user", content: "read a.txt" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me read it" },
          {
            type: "tool_use",
            id: "call_1",
            name: "read_files",
            input: { files: [{ path: "a.txt" }] },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            name: "read_files",
            content: "FILE BODY",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_2",
            name: "bash",
            content: "boom",
            is_error: true,
          },
        ],
      },
    ] as AgentMessage[]);

    expect(wire[0]).toEqual({ role: "user", content: "read a.txt" });
    expect(wire[1]).toEqual({
      role: "assistant",
      content: "let me read it",
      tool_calls: [
        {
          function: {
            name: "read_files",
            arguments: { files: [{ path: "a.txt" }] },
          },
        },
      ],
    });
    expect(wire[2]).toEqual({ role: "tool", content: "FILE BODY" });
    expect(wire[3]).toEqual({ role: "tool", content: "[error] boom" });
  });
});

// ---------------------------------------------------------------------------
// Phase 6 — Ollama NDJSON streaming tool calls
// ---------------------------------------------------------------------------

async function drain(
  provider: OllamaLlmProvider,
  request: Partial<LlmRequest>,
): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const evt of provider.stream({
    providerId: "ollama",
    modelId: "qwen2.5-coder:3b",
    messages: [{ role: "user", content: "go" }],
    ...request,
  } as LlmRequest)) {
    out.push(evt);
  }
  return out;
}

describe("Phase 6 — Ollama NDJSON streaming tool calls", () => {
  it("single object-arguments tool call yields tool-call + usage from the done line", async () => {
    const fetchImpl = vi.fn(async () =>
      okChatResponse([
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                function: {
                  name: "read_files",
                  arguments: { files: [{ path: "package.json" }] },
                },
              },
            ],
          },
          done: false,
        },
        {
          message: { role: "assistant", content: "" },
          done: true,
          prompt_eval_count: 12,
          eval_count: 34,
        },
      ]),
    ) as unknown as typeof fetch;
    const provider = new OllamaLlmProvider({ fetchImpl });

    const events = await drain(provider, { tools: [readFilesTool()] });
    const toolEvents = events.filter((e) => e.type === "tool-call");
    expect(toolEvents).toHaveLength(1);
    const tc = toolEvents[0] as { call: LlmToolCall };
    expect(tc.call.toolName).toBe("read_files");
    expect(tc.call.argumentsText).toBe(
      JSON.stringify({ files: [{ path: "package.json" }] }),
    );
    expect(tc.call.toolCallId).toMatch(/^call_/);
    const usage = events.find((e) => e.type === "usage") as {
      usage: { inputTokens: number; outputTokens: number };
    };
    expect(usage.usage.inputTokens).toBe(12);
    expect(usage.usage.outputTokens).toBe(34);
    expect(events[events.length - 1]).toEqual({
      type: "finish",
      reason: "complete",
    });
  });

  it("string arguments, multiple calls, thinking + content are ALL forwarded (nothing dropped)", async () => {
    const fetchImpl = vi.fn(async () =>
      okChatResponse([
        {
          message: {
            role: "assistant",
            thinking: "hmm",
            content: "let me look",
          },
          done: false,
        },
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                function: {
                  name: "read_files",
                  arguments: '{"files":[{"path":"a.txt"}]}',
                },
              },
              { function: { name: "bash", arguments: { command: "ls" } } },
            ],
          },
          done: false,
        },
        {
          message: { role: "assistant", content: "" },
          done: true,
          eval_count: 7,
        },
      ]),
    ) as unknown as typeof fetch;
    const provider = new OllamaLlmProvider({ fetchImpl });

    const events = await drain(provider, {
      tools: [readFilesTool(), bashTool()],
    });
    const types = events.map((e) => e.type);
    expect(types).toContain("reasoning-delta");
    expect(events.filter((e) => e.type === "text-delta")).toHaveLength(1);
    const calls = events.filter((e) => e.type === "tool-call") as Array<{
      call: LlmToolCall;
    }>;
    expect(calls).toHaveLength(2);
    // String arguments preserved VERBATIM (no re-serialization drift).
    expect(calls[0]!.call.toolName).toBe("read_files");
    expect(calls[0]!.call.argumentsText).toBe('{"files":[{"path":"a.txt"}]}');
    // Object arguments canonicalized to JSON text.
    expect(calls[1]!.call.toolName).toBe("bash");
    expect(calls[1]!.call.argumentsText).toBe(
      JSON.stringify({ command: "ls" }),
    );
    expect(events[events.length - 1]).toEqual({
      type: "finish",
      reason: "complete",
    });
  });

  it("malformed NDJSON line is tolerated; the stream continues to the valid call", async () => {
    const body =
      "{this is not json}\n" +
      ndjson({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { function: { name: "read_files", arguments: { files: [] } } },
          ],
        },
        done: false,
      }) +
      ndjson({ message: { role: "assistant", content: "" }, done: true });
    const fetchImpl = vi.fn(
      async () => new Response(body, { status: 200 }),
    ) as unknown as typeof fetch;
    const provider = new OllamaLlmProvider({ fetchImpl });

    const events = await drain(provider, { tools: [readFilesTool()] });
    expect(events.filter((e) => e.type === "tool-call")).toHaveLength(1);
    expect(events[events.length - 1]).toEqual({
      type: "finish",
      reason: "complete",
    });
  });

  it("an `error` line surfaces as finish(error) — never a fake completion", async () => {
    const fetchImpl = vi.fn(async () =>
      okChatResponse([{ error: "model exploded" }]),
    ) as unknown as typeof fetch;
    const provider = new OllamaLlmProvider({ fetchImpl });

    const events = await drain(provider, {});
    const last = events[events.length - 1] as {
      type: string;
      reason?: string;
      error?: string;
    };
    expect(last.type).toBe("finish");
    expect(last.reason).toBe("error");
    expect(last.error).toContain("model exploded");
  });
});

// ---------------------------------------------------------------------------
// Phase 7 — dispatcher: deny-closed M4 gate
// ---------------------------------------------------------------------------

describe("Phase 7 — tool dispatcher is deny-closed", () => {
  const ctx = { sessionId: "s1", iteration: 1 };

  it("unknown tool → denied, nothing executes", async () => {
    const execute = vi.fn();
    const outcome = await dispatchToolCall(
      undefined,
      call("no_such_tool", {}),
      approveAll,
      ctx,
    );
    expect(outcome.denied).toBe(true);
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("Unknown tool 'no_such_tool'");
    expect(execute).not.toHaveBeenCalled();
  });

  it("unparsable arguments → denied BEFORE the gate is even consulted", async () => {
    const gate = vi.fn(approveAll);
    const outcome = await dispatchToolCall(
      readFilesTool(),
      call("read_files", "{not json"),
      gate as unknown as ToolGate,
      ctx,
    );
    expect(outcome.denied).toBe(true);
    expect(outcome.content).toContain("invalid JSON tool arguments");
    expect(gate).not.toHaveBeenCalled();
  });

  it("gate denial → executor never runs; denial reason surfaces", async () => {
    const execute = vi.fn();
    const outcome = await dispatchToolCall(
      readFilesTool(execute as AgentTool["execute"]),
      call("read_files", { files: [{ path: "a.txt" }] }),
      async () => ({ approved: false, reason: "user denied in M4" }),
      ctx,
    );
    expect(outcome.denied).toBe(true);
    expect(outcome.denialReason).toBe("user denied in M4");
    expect(outcome.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("gate THROW → deny-closed (execution blocked, no crash escapes)", async () => {
    const execute = vi.fn();
    const outcome = await dispatchToolCall(
      readFilesTool(execute as AgentTool["execute"]),
      call("read_files", { files: [] }),
      async () => {
        throw new Error("permission pipeline offline");
      },
      ctx,
    );
    expect(outcome.denied).toBe(true);
    expect(outcome.content).toContain("deny-closed");
    expect(execute).not.toHaveBeenCalled();
  });

  it("approved call executes and the result is bounded by maxResultChars", async () => {
    const gateCalls: Array<{ toolName: string; input: unknown }> = [];
    const huge = "x".repeat(50_000);
    const outcome = await dispatchToolCall(
      readFilesTool(async () => huge),
      call("read_files", { files: [{ path: "big.txt" }] }),
      async (req) => {
        gateCalls.push({ toolName: req.toolName, input: req.input });
        return { approved: true };
      },
      ctx,
      { maxResultChars: 1_000 },
    );
    expect(outcome.denied).toBe(false);
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toContain("output truncated");
    expect(outcome.content.length).toBeLessThan(1_100);
    expect(gateCalls).toEqual([
      { toolName: "read_files", input: { files: [{ path: "big.txt" }] } },
    ]);
  });

  it("tool timeout aborts execution and becomes an error tool_result", async () => {
    const slow = createTool({
      name: "slow",
      description: "never finishes on its own",
      inputSchema: { type: "object" },
      timeoutMs: 30,
      execute: (_input, toolCtx) =>
        new Promise((_resolve, reject) => {
          const t = setTimeout(
            () => reject(new Error("should have been aborted")),
            10_000,
          );
          toolCtx.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              reject(new Error("tool aborted by timeout"));
            },
            { once: true },
          );
        }),
    });
    const outcome = await dispatchToolCall(
      slow,
      call("slow", {}),
      approveAll,
      ctx,
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.denied).toBe(false);
    expect(outcome.content).toContain("failed");
    expect(outcome.durationMs).toBeLessThan(5_000);
  });
});

// ---------------------------------------------------------------------------
// Phase 7b — HARD DEADLINE: timeout settles non-cooperative tools too
// ---------------------------------------------------------------------------

describe("Phase 7 — hard execution deadline (timeout never hangs dispatch)", () => {
  const ctx = { sessionId: "s1", iteration: 1 };

  it("a never-resolving tool that IGNORES its signal becomes a structured timeout failure", async () => {
    const started = Date.now();
    const hung = createTool({
      name: "hung",
      description: "never settles and ignores the abort signal",
      inputSchema: { type: "object" },
      timeoutMs: 30,
      // Deliberately ignores toolCtx.signal and never resolves/rejects.
      execute: () => new Promise(() => {}),
    });
    const outcome = await dispatchToolCall(
      hung,
      call("hung", {}),
      approveAll,
      ctx,
    );
    expect(outcome.denied).toBe(false);
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("hung");
    expect(outcome.content).toContain("timed out after 30ms");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("a cooperative timeout still receives the abort signal before failing", async () => {
    let signalSeen = false;
    const cooperative = createTool({
      name: "cooperative",
      description: "rejects when its signal aborts",
      inputSchema: { type: "object" },
      timeoutMs: 30,
      execute: (_input, toolCtx) =>
        new Promise((_resolve, reject) => {
          toolCtx.signal?.addEventListener(
            "abort",
            () => {
              signalSeen = true;
              reject(new Error("aborted by tool signal"));
            },
            { once: true },
          );
        }),
    });
    const outcome = await dispatchToolCall(
      cooperative,
      call("cooperative", {}),
      approveAll,
      ctx,
    );
    expect(signalSeen).toBe(true); // abort propagation preserved
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("failed");
    expect(outcome.denied).toBe(false);
  });

  it("successful completion well before the timeout returns the result untouched", async () => {
    const fast = createTool({
      name: "fast",
      description: "settles quickly",
      inputSchema: { type: "object" },
      timeoutMs: 5_000,
      execute: async () => "quick result",
    });
    const outcome = await dispatchToolCall(
      fast,
      call("fast", {}),
      approveAll,
      ctx,
    );
    expect(outcome.isError).toBe(false);
    expect(outcome.denied).toBe(false);
    expect(outcome.content).toBe("quick result");
  });

  it("tool rejection becomes a structured failure carrying the tool's message", async () => {
    const failing = createTool({
      name: "failing",
      description: "rejects with a real error",
      inputSchema: { type: "object" },
      timeoutMs: 5_000,
      execute: async () => {
        throw new Error("disk on fire");
      },
    });
    const outcome = await dispatchToolCall(
      failing,
      call("failing", {}),
      approveAll,
      ctx,
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.denied).toBe(false);
    expect(outcome.content).toContain("disk on fire");
  });

  it("external cancellation during execution throws AbortError (propagates to the loop)", async () => {
    const controller = new AbortController();
    const stubborn = createTool({
      name: "stubborn",
      description: "keeps running until the outer run is cancelled",
      inputSchema: { type: "object" },
      timeoutMs: 10_000,
      execute: () => new Promise(() => {}),
    });
    const pending = dispatchToolCall(
      stubborn,
      call("stubborn", {}),
      approveAll,
      {
        sessionId: "s1",
        iteration: 1,
        signal: controller.signal,
      },
    );
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("a rejection that lands AFTER the deadline won is never an unhandled rejection", async () => {
    let lateReject!: (err: Error) => void;
    const late = createTool({
      name: "late",
      description: "rejects long after the deadline fired",
      inputSchema: { type: "object" },
      timeoutMs: 30,
      execute: () =>
        new Promise<void>((_resolve, reject) => {
          lateReject = reject;
        }),
    });
    const outcome = await dispatchToolCall(
      late,
      call("late", {}),
      approveAll,
      ctx,
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("timed out after 30ms");
    // Fire the losing side's rejection AFTER the race already settled.
    lateReject(new Error("too late"));
    await new Promise((r) => setTimeout(r, 50));
    // Vitest fails the run on any unhandled rejection — reaching this line
    // with the process healthy is the assertion.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 8 — tool result returned to the model
// ---------------------------------------------------------------------------

describe("Phase 8 — tool result returned to the model", () => {
  it("result is appended as the next user message AND reaches the provider's next request as role:'tool'", async () => {
    const provider = new ScriptedProvider();
    provider.pushTurn([
      toolCallEvent("read_files", { files: [{ path: "planner.txt" }] }),
      {
        type: "usage",
        usage: {
          inputTokens: 5,
          outputTokens: 6,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
      finishOk(),
    ]);
    provider.pushTurn([
      { type: "text-delta", text: "the file says HI" },
      finishOk(),
    ]);

    const events: AgentLoopEvent[] = [];
    const messages: AgentMessage[] = [];
    const result = await runAgentLoop(messages, "read planner.txt", {
      provider,
      modelId: "qwen2.5-coder:3b",
      sessionId: "s-phase8",
      tools: [readFilesTool()],
      gate: approveAll,
      maxIterations: 5,
      onEvent: (e) => events.push(e),
    });

    expect(result.reason).toBe("complete");
    expect(result.iterations).toBe(2);
    expect(result.text).toBe("the file says HI");

    // Loop events: exactly one started + one completed with the tool's output.
    const started = events.filter((e) => e.type === "tool_started");
    const completed = events.filter(
      (e) => e.type === "tool_completed",
    ) as Array<{
      output: string;
      isError: boolean;
    }>;
    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.output).toBe("FILE CONTENT HI");
    expect(completed[0]!.isError).toBe(false);

    // Protocol invariant: assistant tool_use paired with tool_result in the
    // FOLLOWING user message of the transcript.
    const toolUseMsg = messages.find(
      (m) =>
        m.role === "assistant" &&
        blocksOf(m).some((b) => b.type === "tool_use"),
    );
    const toolResultMsg = messages.find(
      (m) =>
        m.role === "user" && blocksOf(m).some((b) => b.type === "tool_result"),
    );
    expect(toolUseMsg).toBeDefined();
    expect(toolResultMsg).toBeDefined();
    const useBlock = blocksOf(toolUseMsg!).find((b) => b.type === "tool_use");
    const resultBlock = blocksOf(toolResultMsg!).find(
      (b) => b.type === "tool_result",
    );
    expect(useBlock).toMatchObject({
      id: expect.any(String),
      name: "read_files",
    });
    expect(resultBlock).toMatchObject({
      tool_use_id: (useBlock as { id: string }).id,
      name: "read_files",
      content: "FILE CONTENT HI",
    });

    // The SECOND provider request physically contains the tool result
    // (role:"tool" on the Ollama wire) — the model can actually see it.
    expect(provider.requests).toHaveLength(2);
    const firstWire = toOllamaMessages(provider.requests[0]!.messages);
    expect(firstWire.some((m) => m.role === "tool")).toBe(false);
    const secondWire = toOllamaMessages(provider.requests[1]!.messages);
    expect(
      secondWire.some(
        (m) => m.role === "tool" && m.content === "FILE CONTENT HI",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 9 — multi-step loop
// ---------------------------------------------------------------------------

describe("Phase 9 — multi-step tool loop", () => {
  it("read → bash → final answer across three iterations, no premature termination", async () => {
    const provider = new ScriptedProvider();
    provider.pushTurn([
      toolCallEvent("read_files", { files: [{ path: "planner.txt" }] }),
      finishOk(),
    ]);
    provider.pushTurn([
      toolCallEvent("bash", { command: "node --version" }),
      finishOk(),
    ]);
    provider.pushTurn([
      { type: "text-delta", text: "planner.txt read; node version is v24.0.0" },
      finishOk(),
    ]);

    const readExecute = vi.fn(async (_input: unknown) => "PLANNER BODY");
    const bashExecute = vi.fn(async (_input: unknown) => "v24.0.0");
    const events: AgentLoopEvent[] = [];
    const messages: AgentMessage[] = [];
    const result = await runAgentLoop(
      messages,
      "Read planner.txt then run node --version.",
      {
        provider,
        modelId: "qwen2.5-coder:3b",
        sessionId: "s-phase9",
        tools: [
          readFilesTool(readExecute as AgentTool["execute"]),
          bashTool(bashExecute as AgentTool["execute"]),
        ],
        gate: approveAll,
        maxIterations: 10,
        onEvent: (e) => events.push(e),
      },
    );

    expect(result.reason).toBe("complete");
    expect(result.iterations).toBe(3);
    expect(result.text).toBe("planner.txt read; node version is v24.0.0");

    const completed = events.filter(
      (e) => e.type === "tool_completed",
    ) as Array<{
      toolName: string;
      output: string;
    }>;
    expect(completed.map((c) => c.toolName)).toEqual(["read_files", "bash"]);
    expect(completed.map((c) => c.output)).toEqual(["PLANNER BODY", "v24.0.0"]);

    // Both executions happened, in order, with the model's arguments.
    expect(readExecute).toHaveBeenCalledTimes(1);
    expect(bashExecute).toHaveBeenCalledTimes(1);
    expect(bashExecute.mock.calls[0]?.[0]).toEqual({
      command: "node --version",
    });

    // Transcript: 2 assistant tool_use messages + 2 user tool_result messages.
    const useMsgs = messages.filter(
      (m) =>
        m.role === "assistant" &&
        blocksOf(m).some((b) => b.type === "tool_use"),
    );
    const resultMsgs = messages.filter(
      (m) =>
        m.role === "user" && blocksOf(m).some((b) => b.type === "tool_result"),
    );
    expect(useMsgs).toHaveLength(2);
    expect(resultMsgs).toHaveLength(2);

    // Chaining: the bash request (turn 2) already contains turn 1's result.
    const turn2Wire = toOllamaMessages(provider.requests[1]!.messages);
    expect(
      turn2Wire.some((m) => m.role === "tool" && m.content === "PLANNER BODY"),
    ).toBe(true);
    const turn3Wire = toOllamaMessages(provider.requests[2]!.messages);
    expect(
      turn3Wire.some((m) => m.role === "tool" && m.content === "v24.0.0"),
    ).toBe(true);
  });

  it("runaway tool loop is bounded by maxIterations (explicit error, not a hang)", async () => {
    const provider = new ScriptedProvider();
    for (let i = 0; i < 3; i += 1) {
      provider.pushTurn([
        toolCallEvent("read_files", { files: [{ path: `f${i}.txt` }] }),
        finishOk(),
      ]);
    }
    const messages: AgentMessage[] = [];
    const result = await runAgentLoop(messages, "loop forever", {
      provider,
      modelId: "qwen2.5-coder:3b",
      sessionId: "s-phase9b",
      tools: [readFilesTool()],
      gate: approveAll,
      maxIterations: 3,
      onEvent: () => undefined,
    });
    expect(result.reason).toBe("max_iterations");
    expect(result.iterations).toBe(3);
    expect(result.error).toContain("maximum");
  });
});

// ---------------------------------------------------------------------------
// Phase 4 — registered tools forwarded to the provider request unmodified
// ---------------------------------------------------------------------------

describe("Phase 4 — registered tools reach the provider request unmodified", () => {
  it("LlmRequest.tools is exactly the registered toolset (name/description/schema preserved)", async () => {
    const provider = new ScriptedProvider();
    provider.pushTurn([{ type: "text-delta", text: "done" }, finishOk()]);
    const tools = [readFilesTool(), bashTool()];
    const messages: AgentMessage[] = [];
    await runAgentLoop(messages, "hello", {
      provider,
      modelId: "qwen2.5-coder:3b",
      sessionId: "s-phase4",
      tools,
      gate: approveAll,
      maxIterations: 5,
      onEvent: () => undefined,
    });
    expect(provider.requests[0]!.tools).toBe(tools); // same objects, no cloning drift
    expect(provider.requests[0]!.tools?.map((t) => t.name)).toEqual([
      "read_files",
      "bash",
    ]);
    expect(provider.requests[0]!.tools?.[0]!.description).toBe(
      tools[0]!.description,
    );
    expect(provider.requests[0]!.tools?.[0]!.inputSchema).toEqual(
      tools[0]!.inputSchema,
    );
  });
});

// LlmError import is exercised via the Phase 6 error-line test's contract;
// keep the binding honest by asserting the class shape once.
describe("LlmError contract", () => {
  it("marks 5xx as transient and prefixes the provider id", () => {
    const err = new LlmError("ollama", "chat failed 500", { status: 500 });
    expect(err.transient).toBe(true);
    expect(err.message).toContain("[ollama]");
    expect(
      new LlmError("ollama", "bad request", { status: 400 }).transient,
    ).toBe(false);
  });
});
