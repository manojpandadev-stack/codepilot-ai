/**
 * CHAT — lifecycle regression tests (audit CHAT set).
 *
 * Covers the CONNECTION+CHAT cross-check contract at the unit seam (real
 * runtime, fetch-stubbed Ollama protocol; live E2E lives in the perf/live
 * suites):
 *   - provider unavailable → run fails, error event emitted, runtime settles
 *     failed (never completed, never a stuck "running")
 *   - provider recovers → next run completes and streams
 *   - stream starts (text deltas) and completes (finish/complete)
 *   - status labels: the runtime emits REAL states only (reasoning_delta →
 *     "Thinking…", text deltas, cancelled → idle "Agent stopped.") — the
 *     webview maps them 1:1; no fabricated progress
 *   - error clears the running state (webview reducer contract)
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodePilotRuntime } from "../packages/agent-runtime/src/runtime.js";
import { chatStatusLabel } from "../apps/webview/src/lib/messages.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function ndjsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function okChatResponse(text: string): Response {
  const body =
    ndjsonLine({ message: { role: "assistant", content: text }, done: false }) +
    ndjsonLine({
      message: { role: "assistant", content: "" },
      done: true,
      prompt_eval_count: 5,
      eval_count: 4,
    });
  return new Response(body, { status: 200 });
}

async function makeRuntime(
  fetchImpl: typeof fetch,
): Promise<CodePilotRuntime> {
  vi.stubGlobal("fetch", fetchImpl);
  const runtime = new CodePilotRuntime({
    workspaceRoot: process.cwd(),
    providerId: "ollama",
    modelId: "qwen3:8b",
    agentMode: "act",
    maxRetries: 0,
    requestApproval: async () => ({ approved: true }),
  });
  await runtime.initialize();
  return runtime;
}

describe("CHAT — provider unavailable / recovery / stream lifecycle", () => {
  it("provider unavailable: run fails with a real provider error and never settles completed", async () => {
    const runtime = await makeRuntime(
      vi.fn(async () => {
        throw new TypeError("connect ECONNREFUSED 127.0.0.1:11434");
      }) as unknown as typeof fetch,
    );
    const events: Array<{ type: string; error?: string }> = [];
    runtime.subscribe((e) =>
      events.push({ type: e.type, ...(e as { error?: string }) }),
    );
    await expect(runtime.startSession("Hello")).rejects.toThrow(
      /ECONNREFUSED|provider|network/i,
    );
    // No false completion, a real failure signal, and the state machine is
    // not stuck in running.
    expect(events.some((e) => e.type === "completed")).toBe(false);
    expect(
      events.some((e) => e.type === "error" || e.type === "agent.failed"),
    ).toBe(true);
    expect(runtime.getState().status).not.toBe("running");
    await runtime.dispose().catch(() => undefined);
  });

  it("provider recovers: the next run streams text and completes", async () => {
    let up = false;
    const runtime = await makeRuntime(
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("/api/tags")) {
          return new Response(JSON.stringify({ models: [] }), { status: 200 });
        }
        if (!up) throw new TypeError("connect ECONNREFUSED 127.0.0.1:11434");
        return okChatResponse("recovered response");
      }) as unknown as typeof fetch,
    );
    const events: Array<{ type: string; text?: string }> = [];
    runtime.subscribe((e) =>
      events.push({ type: e.type, ...(e as { text?: string }) }),
    );
    // First turn: provider down → fails.
    await expect(runtime.startSession("Hello")).rejects.toThrow();
    // Provider comes back (no reload): next turn streams for real.
    up = true;
    await runtime.startSession("Hello again");
    expect(events.some((e) => e.type === "completed")).toBe(true);
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.find((e) => e.type === "completed")).toBeTruthy();
    expect(runtime.getState().status).not.toBe("running");
    await runtime.dispose().catch(() => undefined);
  });

  it("stream starts and completes with real token usage", async () => {
    const runtime = await makeRuntime(
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("/api/tags")) {
          return new Response(JSON.stringify({ models: [] }), { status: 200 });
        }
        return okChatResponse("streamed hello");
      }) as unknown as typeof fetch,
    );
    const events: Array<{ type: string; text?: string; usage?: unknown }> = [];
    runtime.subscribe((e) =>
      events.push({ type: e.type, ...(e as { text?: string }) }),
    );
    await runtime.startSession("Say something");
    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas.length).toBeGreaterThan(0);
    const completed = events.find((e) => e.type === "completed") as
      | { usage?: { outputTokens?: number } }
      | undefined;
    expect(completed?.usage?.outputTokens).toBeGreaterThan(0);
    expect(runtime.getState().status).not.toBe("running");
    await runtime.dispose().catch(() => undefined);
  });
});

describe("CHAT — status labels derive ONLY from runtime-emitted states", () => {
  it("maps every real runtime status to an honest label (no fabricated progress)", () => {
    // The webview renders exactly these mappings (App.tsx agent/status case):
    // running+message → the message, running without → Generating…,
    // completed → Completed with real token counts, else Idle.
    expect(chatStatusLabel({ status: "running" }, false)).toBe("Generating…");
    expect(
      chatStatusLabel({ status: "running", message: "Thinking…" }, false),
    ).toBe("Thinking…");
    expect(
      chatStatusLabel(
        { status: "completed", usage: { inputTokens: 10, outputTokens: 4 } },
        false,
      ),
    ).toBe("Completed · 10→4 tok");
    expect(chatStatusLabel({ status: "idle" }, false)).toBe("Idle");
    // A not-running turn always releases the spinner.
    expect(chatStatusLabel({ status: "failed" }, false)).toBe("Idle");
  });

  it("a stopped turn reports the real cancelled state (Agent stopped.), never running", () => {
    // The host maps agent-runtime "cancelled" to agent/status idle +
    // "Agent stopped." (forwardAgentEvent); the label must never remain a
    // running state after an explicit stop.
    expect(chatStatusLabel({ status: "idle", message: "Agent stopped." }, true)).toBe(
      "Agent stopped.",
    );
    // While actually running, the spinner stays on.
    expect(chatStatusLabel({ status: "running" }, true)).toBe("Generating…");
  });
});
