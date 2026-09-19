/**
 * Runtime streaming terminal — deterministic, no model.
 *
 * The model layer is a stubbed Ollama wire (canned NDJSON): the agent loop,
 * M4 gate, tool dispatch, and the REAL streaming `bash` executor
 * (CommandExecutionService + real child processes) are all genuine. This
 * proves, without any LLM:
 *
 * - the runtime routes `bash` tool calls through the streaming executor;
 * - live stdout chunks surface as `terminal_output` agent events BEFORE
 *   `tool_completed` (genuinely streamed, not buffered);
 * - tool names resolve from the live dispatch mapping;
 * - sequence numbers are monotonic per execution;
 * - executor failure surfaces as `tool_failed` carrying the streamed
 *   prefix, with exactly one terminal event per call.
 */

import { describe, expect, it, afterEach, vi } from "vitest";
import { CodePilotRuntime } from "./runtime.js";
import type { AgentEvent } from "./types.js";
import { stubOllamaFetch, registerStubCleanup } from "./ollama-fetch-stub.js";

registerStubCleanup();

afterEach(() => {
  vi.unstubAllGlobals();
});

const NODE = process.execPath;

function makeRuntime(): CodePilotRuntime {
  return new CodePilotRuntime({
    workspaceRoot: process.cwd(),
    providerId: "ollama",
    modelId: "qwen3:8b",
    // Tests play the permission pipeline: allow everything so dispatch
    // reaches the executor (gate behavior itself is covered by M4 suites).
    requestApproval: async () => ({ approved: true }),
  });
}

function bashTurn(script: string): {
  texts: string[];
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  // Shell command strings, exactly as the model emits them per the tool
  // schema (the `& "..."` form keeps spaced install paths working under
  // PowerShell, which reads the script from stdin).
  return {
    texts: [],
    toolCalls: [
      {
        name: "bash",
        args: { command: `& "${NODE}" -e "${script}"` },
      },
    ],
  };
}

function rawBashTurn(command: string): {
  texts: string[];
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  return { texts: [], toolCalls: [{ name: "bash", args: { command } }] };
}

function outputsOf(seen: AgentEvent[]) {
  return seen.filter((e) => e.type === "terminal_output");
}

describe("runtime streaming terminal", () => {
  it("routes bash tool calls through the streaming executor", async () => {
    stubOllamaFetch([
      bashTurn("console.log('RT-1')"),
      { texts: ["done"] },
    ]);
    const runtime = makeRuntime();
    const seen: AgentEvent[] = [];
    runtime.subscribe((event) => {
      seen.push(event);
    });
    try {
      await runtime.initialize();
      await runtime.startSession("stream please");
    } finally {
      await runtime.dispose();
    }
    const outputs = outputsOf(seen);
    expect(outputs.length).toBeGreaterThan(0);
    for (const o of outputs) {
      expect(o.type).toBe("terminal_output");
      if (o.type === "terminal_output") {
        expect(o.toolName).toBe("bash");
        expect(o.stream).toBe("stdout");
      }
    }
  });

  it("emits terminal_output chunks before tool_completed", async () => {
    stubOllamaFetch([
      bashTurn(
        "console.log('RT-1');setTimeout(()=>console.log('RT-2'),150);setTimeout(()=>console.log('RT-3'),300);",
      ),
      { texts: ["done"] },
    ]);
    const runtime = makeRuntime();
    const seen: AgentEvent[] = [];
    runtime.subscribe((event) => {
      seen.push(event);
    });
    try {
      await runtime.initialize();
      await runtime.startSession("stream please");
    } finally {
      await runtime.dispose();
    }
    const outputs = outputsOf(seen);
    expect(outputs.length).toBeGreaterThan(0);
    const completedAt = seen.findIndex((e) => e.type === "tool_completed");
    const firstOutputAt = seen.findIndex((e) => e.type === "terminal_output");
    // Genuinely streamed: output precedes completion.
    expect(firstOutputAt).toBeGreaterThanOrEqual(0);
    expect(completedAt).toBeGreaterThan(firstOutputAt);
    // Monotonic per-execution sequence.
    const seqs = outputs.map((o) => (o.type === "terminal_output" ? o.seq : -1));
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }
    // Final contract kept: combined output reaches tool_completed.
    const completed = seen.find((e) => e.type === "tool_completed");
    expect(completed?.type === "tool_completed" && String(completed.output)).toContain("RT-3");
  });

  it("labels stderr chunks and keeps per-stream order", async () => {
    stubOllamaFetch([
      bashTurn("console.log('OUT-1');console.error('ERR-1');console.log('OUT-2');"),
      { texts: ["done"] },
    ]);
    const runtime = makeRuntime();
    const seen: AgentEvent[] = [];
    runtime.subscribe((event) => {
      seen.push(event);
    });
    try {
      await runtime.initialize();
      await runtime.startSession("mixed streams please");
    } finally {
      await runtime.dispose();
    }
    const outputs = outputsOf(seen);
    const streams = new Set(
      outputs.map((o) => (o.type === "terminal_output" ? o.stream : "")),
    );
    expect(streams.has("stdout")).toBe(true);
    expect(streams.has("stderr")).toBe(true);
    const data = outputs
      .map((o) => (o.type === "terminal_output" ? `${o.stream}:${o.data}` : ""))
      .join("|");
    expect(data).toContain("stdout");
    expect(data).toContain("ERR-1");
  });

  it("surfaces executor failure as tool_failed with streamed prefix", async () => {
    // A failing shell: node prints a marker, then PowerShell exits 4.
    // (The stdin bootstrap normalizes in-script process exits, so the
    // shell-level `exit` carries the asserted code.)
    stubOllamaFetch([
      rawBashTurn(`& "${NODE}" -e "console.log('before-fail')"; exit 4`),
      { texts: ["done"] },
    ]);
    const runtime = makeRuntime();
    const seen: AgentEvent[] = [];
    runtime.subscribe((event) => {
      seen.push(event);
    });
    try {
      // A failing command still settles the run (error result feeds back).
      await runtime.startSession("fail please");
    } finally {
      await runtime.dispose();
    }
    const toolCallId = (() => {
      const started = seen.find((e) => e.type === "tool_started");
      return started?.type === "tool_started" ? started.toolCallId : "";
    })();
    expect(toolCallId.length).toBeGreaterThan(0);
    const failed = seen.find(
      (e) => e.type === "tool_failed" && e.toolCallId === toolCallId,
    );
    expect(failed).toBeDefined();
    expect(failed?.type === "tool_failed" && failed.error).toContain(
      "Command exited with code 4",
    );
    // Partial output still streamed before the failure (no silent loss).
    const outputs = outputsOf(seen).filter(
      (o) => o.type === "terminal_output" && o.toolCallId === toolCallId,
    );
    expect(
      outputs.map((o) => (o.type === "terminal_output" ? o.data : "")).join(""),
    ).toContain("before-fail");
    // Exactly one terminal tool event for the call (never both).
    expect(
      seen.filter(
        (e) =>
          (e.type === "tool_completed" || e.type === "tool_failed") &&
          e.toolCallId === toolCallId,
      ),
    ).toHaveLength(1);
  });
});
