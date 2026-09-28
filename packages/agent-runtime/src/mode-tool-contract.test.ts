/**
 * Phase 1 (tool automation reliability) — Act-mode truth + mode/tool contract.
 *
 * Deterministic (fake fetch, no network). Proves, at the RUNTIME level (the
 * authoritative mode resolution — never the webview button):
 *
 *   ASK/PLAN  → mutating tools (bash, run_commands, write_file, editor,
 *               apply_patch, delete_file) are NOT advertised to the model at
 *               all; read-only tools stay. A status line records the filter.
 *   ACT/AUTO  → the full executable set is advertised; AGENT_REQUEST carries
 *               mode/provider/model/tools truth.
 *   ACT       → a turn that completes with zero tool calls emits the
 *               AGENT_COMPLETED_WITHOUT_TOOL_CALL diagnostic (never an error);
 *               a turn WITH tool calls does not.
 *
 * The M4 gate is NOT exercised here (Phase 10 covers approval); every call
 * still passes it in production — this filter changes what the MODEL SEES,
 * never authorization.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodePilotRuntime } from "./runtime.js";
import type { AgentEvent } from "./types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** NDJSON chat line + a Response assembled from lines (Ollama wire shape). */
const ndjson = (value: unknown): string => `${JSON.stringify(value)}\n`;

function chatResponse(lines: Array<Record<string, unknown>>): Response {
  // Responses are single-use: every fetch must get a FRESH one.
  return new Response(lines.map(ndjson).join(""), { status: 200 });
}

/** One structured tool call, Ollama-style (arguments as an object). */
function toolCallLine(name: string, args: Record<string, unknown>) {
  return {
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name, arguments: args } }],
    },
    done: false,
  };
}

const FINAL_ANSWER_LINES: Array<Record<string, unknown>> = [
  { message: { role: "assistant", content: "42" }, done: false },
  { message: { role: "assistant", content: "" }, done: true, eval_count: 3 },
];

interface Capture {
  bodies: Array<Record<string, unknown>>;
}

/** Stub global fetch: every /api/chat request body is recorded. */
function stubChat(responder: (body: Record<string, unknown>) => Response): Capture {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn(async (_input: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    bodies.push(body);
    return responder(body);
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchImpl);
  return { bodies };
}

/** Collect runtime events, keyed by type. */
function collect(): { events: AgentEvent[]; byType: (t: string) => AgentEvent[] } {
  const events: AgentEvent[] = [];
  return {
    events,
    byType: (t: string) => events.filter((e) => e.type === t),
  };
}

function makeRuntime(
  mode: "ask" | "plan" | "act" | "auto" | "review",
  responder: (body: Record<string, unknown>) => Response,
): { runtime: CodePilotRuntime; capture: Capture; sink: ReturnType<typeof collect> } {
  const sink = collect();
  const runtime = new CodePilotRuntime({
    workspaceRoot: process.cwd(),
    providerId: "ollama",
    modelId: "qwen3:8b",
    agentMode: mode,
    requestApproval: async () => ({ approved: true }),
  });
  runtime.subscribe((e) => sink.events.push(e));
  const capture = stubChat(responder);
  return { runtime, capture, sink };
}

const statusMessages = (sink: ReturnType<typeof collect>): string[] =>
  sink
    .byType("status")
    .map((e) => (e as { message?: string }).message ?? "");

const finalAnswer = (): Response => chatResponse(FINAL_ANSWER_LINES);

describe("Phase 1 — runtime-authoritative mode/tool contract", () => {
  it("ASK exposes NO mutating tools to the model; read-only tools remain", async () => {
    const { runtime, capture } = makeRuntime("ask", () => finalAnswer());
    await runtime.initialize();
    await runtime.startSession("What does this repo do?");
    await runtime.dispose().catch(() => undefined);

    const body = capture.bodies.find((b) => Array.isArray(b.messages));
    expect(body).toBeDefined();
    const tools = (body?.tools ?? []) as Array<{ function: { name: string } }>;
    const names = tools.map((t) => t.function.name);
    expect(names).not.toContain("bash");
    expect(names).not.toContain("run_commands");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("editor");
    expect(names).not.toContain("apply_patch");
    expect(names).not.toContain("delete_file");
    // Read-only tools legitimately remain (ASK reads the workspace).
    expect(names).toContain("read_files");
    expect(names).toContain("search_codebase");
    // The runtime recorded the authoritative post-filter list.
    const summary = runtime.getLastRunToolSummary();
    expect(summary.count).toBe(names.length);
    expect(summary.names).toEqual(names);
  });

  it("PLAN behaves like ASK: mutating tools withheld, read-only kept", async () => {
    const { runtime, capture } = makeRuntime("plan", () => finalAnswer());
    await runtime.initialize();
    await runtime.startSession("Plan a caching layer.");
    await runtime.dispose().catch(() => undefined);

    const body = capture.bodies.find((b) => Array.isArray(b.messages));
    const names = ((body?.tools ?? []) as Array<{ function: { name: string } }>).map(
      (t) => t.function.name,
    );
    expect(names).not.toContain("bash");
    expect(names).not.toContain("editor");
    expect(names).toContain("read_files");
  });

  it("ACT exposes the full executable set and emits the AGENT_REQUEST truth line", async () => {
    const { runtime, capture, sink } = makeRuntime("act", () => finalAnswer());
    await runtime.initialize();
    await runtime.startSession("Run node --version in the terminal now.");
    await runtime.dispose().catch(() => undefined);

    const body = capture.bodies.find((b) => Array.isArray(b.messages));
    const names = ((body?.tools ?? []) as Array<{ function: { name: string } }>).map(
      (t) => t.function.name,
    );
    expect(names).toContain("bash");
    expect(names).toContain("run_commands");
    expect(names).toContain("editor");
    expect(names).toContain("read_files");

    const truth = statusMessages(sink).find((m) => m.startsWith("AGENT_REQUEST"));
    expect(truth).toBeDefined();
    expect(truth).toContain("mode=act");
    expect(truth).toContain("provider=ollama");
    expect(truth).toContain("model=qwen3:8b");
    expect(truth).toMatch(/tools=\d+/);
    // Runtime truth matches the actual request contract.
    const count = Number(truth!.match(/tools=(\d+)/)?.[1]);
    expect(count).toBe(names.length);
    expect(runtime.getLastRunToolSummary().count).toBe(count);
  });

  it("REVIEW and AUTO keep the full toolset (no filter)", async () => {
    for (const mode of ["review", "auto"] as const) {
      const { runtime, capture } = makeRuntime(mode, () => finalAnswer());
      await runtime.initialize();
      await runtime.startSession("Review the workspace.");
      await runtime.dispose().catch(() => undefined);
      const body = capture.bodies.find((b) => Array.isArray(b.messages));
      const names = ((body?.tools ?? []) as Array<{ function: { name: string } }>).map(
        (t) => t.function.name,
      );
      expect(names).toContain("bash");
      expect(names).toContain("read_files");
    }
  });

  it("ACT turn with ZERO tool calls emits the no-tool-call diagnostic (not an error)", async () => {
    const { runtime, capture, sink } = makeRuntime("act", () => finalAnswer());
    await runtime.initialize();
    await runtime.startSession("Just say hi.");
    await runtime.dispose().catch(() => undefined);

    const diag = statusMessages(sink).find((m) =>
      m.startsWith("AGENT_COMPLETED_WITHOUT_TOOL_CALL"),
    );
    expect(diag).toBeDefined();
    expect(diag).toContain("mode=act");
    expect(diag).toContain("toolCount=");
    expect(diag).toContain("classification=model_answered_without_tool_call");
    // Diagnostic only — the run still completes normally.
    expect(sink.byType("completed")).toHaveLength(1);
    expect(sink.byType("error")).toHaveLength(0);
    // The tools WERE advertised (prose was the model's choice).
    const body = capture.bodies.find((b) => Array.isArray(b.messages));
    expect(((body?.tools ?? []) as unknown[]).length).toBeGreaterThan(0);
  });

  it("ACT turn WITH a tool call emits NO no-tool-call diagnostic", async () => {
    let firstTurn = true;
    const { runtime, sink } = makeRuntime("act", () => {
      if (firstTurn) {
        firstTurn = false;
        return chatResponse([
          toolCallLine("read_files", { files: [{ path: "package.json" }] }),
        ]);
      }
      return finalAnswer();
    });
    await runtime.initialize();
    await runtime.startSession("Read package.json.");
    await runtime.dispose().catch(() => undefined);

    const diag = statusMessages(sink).filter((m) =>
      m.startsWith("AGENT_COMPLETED_WITHOUT_TOOL_CALL"),
    );
    expect(diag).toHaveLength(0);
    // The tool actually started (post-parse receipt proven).
    expect(sink.byType("tool_started").length).toBeGreaterThan(0);
  });

  it("ASK completing without tools does NOT emit the diagnostic (filtered by design)", async () => {
    const { runtime, sink } = makeRuntime("ask", () => finalAnswer());
    await runtime.initialize();
    await runtime.startSession("What is 2+2?");
    await runtime.dispose().catch(() => undefined);
    const diag = statusMessages(sink).filter((m) =>
      m.startsWith("AGENT_COMPLETED_WITHOUT_TOOL_CALL"),
    );
    expect(diag).toHaveLength(0);
  });
});
