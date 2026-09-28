/**
 * Regression tests for two production defects found during live E2E:
 *
 * 1. Silent completion on LLM failure — the runtime's withRetry callback
 *    returned loop results with `reason: "error"` without inspection, so a
 *    provider failure settled the run as "completed" (zero text, zero tools)
 *    instead of surfacing agent.failed. Loop errors are now thrown inside
 *    the retry callback: transient ones retry (bounded), permanent ones
 *    settle the run as FAILED.
 *
 * 2. Wall-clock per-request abort — the native Ollama provider used to
 *    abort the fetch after a fixed duration even while the stream made
 *    steady progress (cold model load plus long thinking spans legitimately
 *    exceed 300s). The timer is now an INACTIVITY timer: re-armed on every
 *    received chunk, trips only on a silent connection.
 *
 * No network, no model — the Ollama protocol is stubbed at fetch level and
 * driven through the genuine production runtime.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodePilotRuntime } from "./runtime.js";
import { OllamaLlmProvider } from "./native/llm/ollama.js";
import { createLlmProvider } from "./native/llm/registry.js";
import type { OllamaChatLine } from "./native/llm/ollama.js";
import type { LlmRequest, LlmStreamEvent } from "./native/llm/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function ndjsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function okChatResponse(lines: unknown[]): Response {
  const body = lines.map(ndjsonLine).join("");
  return new Response(body, { status: 200 });
}

const eventsOf = async (
  provider: OllamaLlmProvider,
  request: Partial<LlmRequest>,
): Promise<LlmStreamEvent[]> => {
  const out: LlmStreamEvent[] = [];
  for await (const evt of provider.stream({
    providerId: "ollama",
    modelId: "qwen3:8b",
    messages: [{ role: "user", content: "hi" }],
    ...request,
  } as LlmRequest)) {
    out.push(evt);
  }
  return out;
};

describe("OllamaLlmProvider — inactivity timeout", () => {
  it("completes a slow but steadily streaming response (no wall-clock abort)", async () => {
    // Chunks spaced 2s apart for 8s total — far beyond any small wall clock,
    // but silence never exceeds 2s. With a 3s inactivity window this must
    // finish cleanly; the old fixed 300ms-equivalent would have killed it.
    vi.useFakeTimers();
    const chatLines: OllamaChatLine[] = Array.from({ length: 4 }, (_, i) => ({
      message: { role: "assistant", content: `chunk${i} ` },
      done: false,
    }));
    chatLines.push({
      message: { role: "assistant", content: "" },
      done: true,
      prompt_eval_count: 3,
      eval_count: 9,
    });

    const fetchImpl = vi.fn(async () => {
      // Return the response immediately; the body streams lazily with
      // artificial 2s gaps, simulated by awaiting the fake timer.
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder();
          for (const line of chatLines) {
            await vi.advanceTimersByTimeAsync(2_000);
            controller.enqueue(enc.encode(ndjsonLine(line)));
          }
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new OllamaLlmProvider({
      baseUrl: "http://localhost:11434",
      fetchImpl,
      timeoutMs: 3_000,
    });

    const events = await eventsOf(provider, {});
    const finish = events.find((e) => e.type === "finish");
    expect(finish?.type === "finish" ? finish.reason : undefined).toBe(
      "complete",
    );
    const text = events
      .filter(
        (e): e is Extract<LlmStreamEvent, { type: "text-delta" }> =>
          e.type === "text-delta",
      )
      .map((e) => e.text)
      .join("");
    expect(text).toContain("chunk3");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("aborts and reports an error when the stream goes silent beyond the window", async () => {
    vi.useFakeTimers();
    const enc = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(
          enc.encode(
            ndjsonLine({
              message: { role: "assistant", content: "start" },
              done: false,
            }),
          ),
        );
      },
    });

    // Faithful fetch semantics: aborting the request signal errors the body
    // stream (this is what kills the pending reader.read() in production).
    const fetchImpl = vi.fn(
      async (
        _input: unknown,
        init?: { signal?: AbortSignal },
      ): Promise<Response> => {
        init?.signal?.addEventListener(
          "abort",
          () =>
            streamController.error(
              new DOMException("This operation was aborted", "AbortError"),
            ),
          { once: true },
        );
        return new Response(stream, { status: 200 });
      },
    ) as unknown as typeof fetch;
    const provider = new OllamaLlmProvider({
      baseUrl: "http://localhost:11434",
      fetchImpl,
      timeoutMs: 3_000,
    });

    // Start consumption, then advance fake time so the inactivity timer
    // fires (fake timers freeze otherwise) and aborts the stalled read.
    const pending = eventsOf(provider, {});
    await vi.advanceTimersByTimeAsync(10_000);
    const events = await pending;
    const finish = events.find((e) => e.type === "finish");
    expect(finish?.type === "finish" ? finish.reason : undefined).toBe("error");
    expect(
      finish?.type === "finish" && finish.error ? finish.error : "",
    ).toMatch(/inactivity/);
  });
});

describe("CodePilotRuntime — LLM failure must never settle as completed", () => {
  it("settles a permanent provider failure as agent.failed (not completed) and retries transient errors first", async () => {
    // Turn 1: transport failure mid-request (transient — must retry).
    // Turn 2: deterministic in-stream protocol error (permanent — fails the run).
    // Turn 3+: would be consumed if the runtime retried the permanent error.
    let call = 0;
    const fetchImpl = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/tags")) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      call += 1;
      if (call === 1) {
        throw new Error("connect ECONNRESET");
      }
      return okChatResponse([
        { error: "model exploded deterministically" },
        { message: { role: "assistant", content: "" }, done: true },
      ]);
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    const runtime = new CodePilotRuntime({
      workspaceRoot: process.cwd(),
      providerId: "ollama",
      modelId: "qwen3:8b",
      agentMode: "act",
      maxRetries: 1,
      requestApproval: async () => ({ approved: true }),
    });

    const events: Array<{ type: string; error?: unknown }> = [];
    runtime.subscribe((event) => {
      events.push({ type: event.type, ...(event as { error?: unknown }) });
    });

    await runtime.initialize();
    await expect(runtime.startSession("Hello")).rejects.toThrow(
      /model exploded deterministically|provider/i,
    );

    const completedCount = events.filter((e) => e.type === "completed").length;
    const agentCompleted = events.filter(
      (e) => e.type === "agent.completed",
    ).length;
    const failed = events.filter((e) => e.type === "agent.failed").length;
    const retried = events.filter((e) => e.type === "agent.retry").length;

    // The defect: completed/agent.completed were emitted on failure.
    expect(completedCount).toBe(0);
    expect(agentCompleted).toBe(0);
    // Transient ECONNRESET was retried once, then the permanent error failed the run.
    expect(retried).toBe(1);
    expect(failed).toBe(1);
    // Two chat attempts were made (original + one retry), not three.
    expect(call).toBe(2);
  });
});

describe("OllamaLlmProvider — first-token inactivity window (CPU prefill)", () => {
  // Live-measured defect (qwen3:8b, CPU): a warm ~4k-token prefill emitted NO
  // stream bytes for >420s. The steady-stream window (300s) was armed from
  // request start, so a HEALTHY request was aborted mid-prefill — the UI
  // showed nothing, the user pressed Stop, and the task recorded only
  // run_interrupted. The window before the first chunk must be more generous
  // than the steady-stream window; both must remain INACTIVITY windows.
  it("keeps a long silent prefill alive until the first chunk arrives", async () => {
    vi.useFakeTimers();
    const enc = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const fetchImpl = vi.fn(
      async () => new Response(stream, { status: 200 }),
    ) as unknown as typeof fetch;

    const provider = new OllamaLlmProvider({
      baseUrl: "http://localhost:11434",
      fetchImpl,
      timeoutMs: 3_000, // steady-stream window
      firstTokenTimeoutMs: 10_000, // first-token window
    });

    const pending = eventsOf(provider, {});
    const consume = (async () => {
      const events: LlmStreamEvent[] = [];
      for await (const evt of await pending) events.push(evt);
      return events;
    })();

    // 9s of total silence: beyond the steady-stream window, inside the
    // first-token window. The old code (steady window armed at t=0) aborts.
    await vi.advanceTimersByTimeAsync(9_000);
    streamController.enqueue(
      enc.encode(
        ndjsonLine({
          message: { role: "assistant", content: "hi" },
          done: false,
        }),
      ),
    );
    // Steady-stream window re-arms per chunk; finish the stream.
    streamController.enqueue(
      enc.encode(
        ndjsonLine({ message: { role: "assistant", content: "" }, done: true }),
      ),
    );
    streamController.close();
    const events = await consume;

    const finish = events.find((e) => e.type === "finish");
    expect(finish?.type === "finish" ? finish.reason : undefined).toBe(
      "complete",
    );
    expect(events.some((e) => e.type === "text-delta")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("still aborts when silence exceeds the first-token window", async () => {
    vi.useFakeTimers();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const fetchImpl = vi.fn(
      async (
        _input: unknown,
        init?: { signal?: AbortSignal },
      ): Promise<Response> => {
        init?.signal?.addEventListener(
          "abort",
          () =>
            streamController.error(
              new DOMException("This operation was aborted", "AbortError"),
            ),
          { once: true },
        );
        return new Response(stream, { status: 200 });
      },
    ) as unknown as typeof fetch;
    const provider = new OllamaLlmProvider({
      baseUrl: "http://localhost:11434",
      fetchImpl,
      timeoutMs: 3_000,
      firstTokenTimeoutMs: 10_000,
    });

    const pending = eventsOf(provider, {});
    await vi.advanceTimersByTimeAsync(20_000);
    const events = await pending;
    const finish = events.find((e) => e.type === "finish");
    expect(finish?.type === "finish" ? finish.reason : undefined).toBe("error");
    expect(
      finish?.type === "finish" && finish.error ? finish.error : "",
    ).toMatch(/before the first stream chunk/);
  });

  it("pins keep_alive so the model stays resident across turns", async () => {
    // Live-measured defect: without keep_alive, Ollama unloads the model 5m
    // after each turn; the next turn pays a 22-60s+ reload before prefill
    // (21.9s cold vs 0.6s warm first chunk on qwen3:8b/CPU).
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(
      async (_input: unknown, init?: { body?: string }) => {
        capturedBody = JSON.parse(init?.body ?? "{}");
        return okChatResponse([
          { message: { role: "assistant", content: "ok" }, done: true },
        ]);
      },
    ) as unknown as typeof fetch;

    const provider = new OllamaLlmProvider({
      baseUrl: "http://localhost:11434",
      fetchImpl,
    });
    await eventsOf(provider, {});

    expect(capturedBody?.keep_alive).toBe("10m"); // default: keep warm
    const custom = new OllamaLlmProvider({
      baseUrl: "http://localhost:11434",
      fetchImpl,
      keepAlive: "0",
    });
    await eventsOf(custom, {});
    expect(capturedBody?.keep_alive).toBe("0"); // opt-out honored
  });

  it("propagates firstTokenTimeoutMs and keepAlive through the registry config", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(
      async (_input: unknown, init?: { body?: string }) => {
        capturedBody = JSON.parse(init?.body ?? "{}");
        return okChatResponse([
          { message: { role: "assistant", content: "ok" }, done: true },
        ]);
      },
    ) as unknown as typeof fetch;

    const provider = createLlmProvider(
      { providerId: "ollama", modelId: "qwen3:8b" },
      {
        fetchImpl,
        configs: [
          {
            providerId: "ollama",
            ollamaFirstTokenTimeoutMs: 60_000,
            ollamaKeepAlive: "30m",
          },
        ],
      },
    );
    for await (const _ of provider.stream({
      providerId: "ollama",
      modelId: "qwen3:8b",
      messages: [{ role: "user", content: "hi" }],
    } as LlmRequest)) {
      // drain
    }
    expect(capturedBody?.keep_alive).toBe("30m");
  });
});
