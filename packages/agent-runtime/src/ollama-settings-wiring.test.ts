/**
 * BUG 4 — Ollama settings wiring regression tests.
 *
 * Root cause: VS Code exposes `codepilot.localAI.ollama.contextLength`,
 * `.numPredict` and `.keepAlive`, but the production native Ollama
 * generation path never consumed them — the /api/chat body carried only
 * `temperature` (per-request) and a hardcoded-ish `keep_alive` default.
 * The settings were dead configuration.
 *
 * Contract under test (actual request body, fetch-level stub, no network):
 *   options: { num_ctx, num_predict, temperature } + keep_alive
 *   - contextLength  → options.num_ctx
 *   - numPredict     → options.num_predict
 *   - temperature    → options.temperature (preserved alongside the new keys)
 *   - keepAlive MINUTES → Go duration ("5" → "5m", "0" → "0"), never malformed
 *   - keys omitted entirely when unconfigured (no empty/partial options object)
 *   - first-token inactivity timeout (CPU prefill)
 *   - steady-stream inactivity timeout
 *   - request cancellation via AbortSignal
 *   - transient provider failure retried, then recovery
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OllamaLlmProvider,
  keepAliveMinutesToDuration,
} from "./native/llm/ollama.js";
import { createLlmProvider } from "./native/llm/registry.js";
import { CodePilotRuntime } from "./runtime.js";
import type { LlmRequest } from "./native/llm/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function ndjsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function okChatResponse(lines: unknown[]): Response {
  return new Response(lines.map(ndjsonLine).join(""), { status: 200 });
}

function captureFetch(): {
  fetchImpl: typeof fetch;
  bodies: Array<Record<string, unknown>>;
  respond: (lines: unknown[]) => void;
} {
  const bodies: Array<Record<string, unknown>> = [];
  let next = okChatResponse([
    { message: { role: "assistant", content: "ok" }, done: true },
  ]);
  const fetchImpl = vi.fn(
    async (_input: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? "{}"));
      return next;
    },
  ) as unknown as typeof fetch;
  return { fetchImpl, bodies, respond: (lines) => (next = okChatResponse(lines)) };
}

const drain = async (
  provider: OllamaLlmProvider,
  request: Partial<LlmRequest> = {},
): Promise<void> => {
  for await (const _ of provider.stream({
    providerId: "ollama",
    modelId: "qwen3:8b",
    messages: [{ role: "user", content: "hi" }],
    ...request,
  } as LlmRequest)) {
    // drain
  }
};

describe("OLLAMA — keepAliveMinutesToDuration (minutes → Go duration)", () => {
  it("converts whole minutes, zero, and fractional minutes; never malformed", () => {
    expect(keepAliveMinutesToDuration(5)).toBe("5m");
    expect(keepAliveMinutesToDuration(0)).toBe("0");
    expect(keepAliveMinutesToDuration(10)).toBe("10m");
    expect(keepAliveMinutesToDuration(0.5)).toBe("30s");
    // Honest failures — never a malformed duration string:
    expect(keepAliveMinutesToDuration(-1)).toBeUndefined();
    expect(keepAliveMinutesToDuration(Number.NaN)).toBeUndefined();
    expect(keepAliveMinutesToDuration(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe("OLLAMA — settings reach the actual /api/chat request body", () => {
  it("contextLength → options.num_ctx", async () => {
    const { fetchImpl, bodies } = captureFetch();
    const provider = new OllamaLlmProvider({ baseUrl: "http://localhost:11434", fetchImpl, numCtx: 8192 });
    await drain(provider);
    expect(bodies[0]?.options).toMatchObject({ num_ctx: 8192 });
  });

  it("numPredict → options.num_predict", async () => {
    const { fetchImpl, bodies } = captureFetch();
    const provider = new OllamaLlmProvider({ baseUrl: "http://localhost:11434", fetchImpl, numPredict: 1024 });
    await drain(provider);
    expect(bodies[0]?.options).toMatchObject({ num_predict: 1024 });
  });

  it("temperature is preserved alongside the new keys", async () => {
    const { fetchImpl, bodies } = captureFetch();
    const provider = new OllamaLlmProvider({
      baseUrl: "http://localhost:11434",
      fetchImpl,
      numCtx: 4096,
      numPredict: 512,
    });
    await drain(provider, { temperature: 0.3 });
    expect(bodies[0]?.options).toEqual({ num_ctx: 4096, num_predict: 512, temperature: 0.3 });
  });

  it("keepAlive reaches the wire as a duration string (default warm, 0 opt-out)", async () => {
    const { fetchImpl, bodies } = captureFetch();
    const warm = new OllamaLlmProvider({ baseUrl: "http://localhost:11434", fetchImpl });
    await drain(warm);
    expect(bodies[0]?.keep_alive).toBe("10m");

    const off = new OllamaLlmProvider({ baseUrl: "http://localhost:11434", fetchImpl, keepAlive: "0" });
    await drain(off);
    expect(bodies.at(-1)?.keep_alive).toBe("0");
  });

  it("unconfigured settings are omitted — no empty options object", async () => {
    const { fetchImpl, bodies } = captureFetch();
    const provider = new OllamaLlmProvider({ baseUrl: "http://localhost:11434", fetchImpl });
    await drain(provider);
    expect(bodies[0]?.options).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(bodies[0] ?? {}, "num_ctx")).toBe(false);
  });

  it("registry config carries the settings end-to-end", async () => {
    const { fetchImpl, bodies } = captureFetch();
    const provider = createLlmProvider(
      { providerId: "ollama", modelId: "qwen3:8b" },
      {
        fetchImpl,
        configs: [
          {
            providerId: "ollama",
            ollamaContextLength: 16384,
            ollamaNumPredict: 2048,
            ollamaKeepAlive: "5m",
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
    expect(bodies[0]?.options).toEqual({ num_ctx: 16384, num_predict: 2048 });
    expect(bodies[0]?.keep_alive).toBe("5m");
  });

  it("explicit think control reaches the wire; default omits the key (no blind disable)", async () => {
    const { fetchImpl, bodies } = captureFetch();
    const off = new OllamaLlmProvider({ baseUrl: "http://localhost:11434", fetchImpl, think: false });
    await drain(off);
    expect(bodies[0]?.think).toBe(false);

    const on = new OllamaLlmProvider({ baseUrl: "http://localhost:11434", fetchImpl, think: true });
    await drain(on);
    expect(bodies.at(-1)?.think).toBe(true);

    const defaultBehavior = new OllamaLlmProvider({ baseUrl: "http://localhost:11434", fetchImpl });
    await drain(defaultBehavior);
    expect(
      Object.prototype.hasOwnProperty.call(bodies.at(-1) ?? {}, "think"),
    ).toBe(false);
  });

  it("CodePilotRuntime options reach the provider through the real construction path", async () => {
    const { fetchImpl, bodies } = captureFetch();
    vi.stubGlobal("fetch", fetchImpl);

    const runtime = new CodePilotRuntime({
      workspaceRoot: process.cwd(),
      providerId: "ollama",
      modelId: "qwen3:8b",
      agentMode: "act",
      temperature: 0.7,
      ollamaContextLength: 4096,
      ollamaNumPredict: 256,
      ollamaKeepAlive: "5m",
      requestApproval: async () => ({ approved: true }),
    });
    await runtime.initialize();
    await runtime.startSession("Say ok.");
    await runtime.dispose().catch(() => undefined);

    const chatBody = bodies.find((b) => Array.isArray(b.messages));
    expect(chatBody).toBeDefined();
    expect(chatBody?.keep_alive).toBe("5m");
    expect(chatBody?.options).toMatchObject({
      num_ctx: 4096,
      num_predict: 256,
      temperature: 0.7,
    });
  });

  it("updateConfig live-applies the Ollama settings to the next request", async () => {
    const { fetchImpl, bodies } = captureFetch();
    vi.stubGlobal("fetch", fetchImpl);

    const runtime = new CodePilotRuntime({
      workspaceRoot: process.cwd(),
      providerId: "ollama",
      modelId: "qwen3:8b",
      agentMode: "act",
      requestApproval: async () => ({ approved: true }),
    });
    await runtime.initialize();
    runtime.updateConfig({
      ollamaContextLength: 2048,
      ollamaNumPredict: 128,
      ollamaKeepAlive: "0",
    });
    await runtime.startSession("Say ok.");
    await runtime.dispose().catch(() => undefined);

    const chatBody = bodies.find((b) => Array.isArray(b.messages));
    expect(chatBody?.keep_alive).toBe("0");
    expect(chatBody?.options).toMatchObject({ num_ctx: 2048, num_predict: 128 });
  });
});

describe("OLLAMA — timeout and cancellation behavior", () => {
  it("first-token inactivity timeout aborts a silent prefill", async () => {
    vi.useFakeTimers();
    // Faithful fetch semantics: the response resolves but the body stream
    // NEVER enqueues (silent prefill). Aborting the request signal errors
    // the body stream — this is what kills the pending reader in production.
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    // The body stream NEVER enqueues — a silent prefill. Any enqueued line
    // (even empty content) counts as the first chunk and would switch the
    // provider to the steady-stream window.
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
      firstTokenTimeoutMs: 5_000,
      timeoutMs: 60_000,
    });
    const pending = (async () => {
      const events = [];
      for await (const evt of provider.stream({
        providerId: "ollama",
        modelId: "qwen3:8b",
        messages: [{ role: "user", content: "hi" }],
      } as LlmRequest)) {
        events.push(evt);
      }
      return events;
    })();
    await vi.advanceTimersByTimeAsync(10_000);
    const events = await pending;
    const finish = events.find((e) => e.type === "finish");
    expect(finish?.type === "finish" ? finish.reason : undefined).toBe("error");
    expect(
      finish?.type === "finish" && finish.error ? finish.error : "",
    ).toMatch(/before the first stream chunk/);
  });

  it("steady-stream inactivity timeout aborts a stalled stream but not slow progress", async () => {
    vi.useFakeTimers();
    // Chunks spaced 2s apart — beyond a naive wall clock, but silence never
    // exceeds 2s against a 5s inactivity window. Must finish cleanly.
    const chatLines: Array<Record<string, unknown>> = Array.from(
      { length: 4 },
      (_, i) => ({
        message: { role: "assistant", content: `chunk${i} ` },
        done: false,
      }),
    );
    chatLines.push({
      message: { role: "assistant", content: "" },
      done: true,
      prompt_eval_count: 3,
      eval_count: 9,
    });
    const fetchImpl = vi.fn(async () => {
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
      firstTokenTimeoutMs: 60_000,
      timeoutMs: 5_000, // steady window: re-armed per chunk; 2s gaps survive
    });
    const events = [];
    for await (const evt of provider.stream({
      providerId: "ollama",
      modelId: "qwen3:8b",
      messages: [{ role: "user", content: "hi" }],
    } as LlmRequest)) {
      events.push(evt);
    }
    // Steady progress completed instead of being wall-clock aborted.
    expect(events.some((e) => e.type === "text-delta")).toBe(true);
    const finish = events.find((e) => e.type === "finish");
    expect(finish?.type === "finish" ? finish.reason : undefined).toBe(
      "complete",
    );
  });

  it("request cancellation via AbortSignal stops the stream", async () => {
    vi.useFakeTimers();
    // Response body stays open forever; abort must error the stream and
    // terminate consumption without hanging.
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
      firstTokenTimeoutMs: 60_000,
      timeoutMs: 60_000,
    });
    const controller = new AbortController();
    const pending = (async () => {
      const events = [];
      for await (const evt of provider.stream({
        providerId: "ollama",
        modelId: "qwen3:8b",
        messages: [{ role: "user", content: "hi" }],
        signal: controller.signal,
      } as LlmRequest)) {
        events.push(evt);
      }
      return events;
    })();
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    const events = await pending;
    // fetch saw the request; the stream was terminated by the abort.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const finish = events.find((e) => e.type === "finish");
    expect(finish?.type === "finish" ? finish.reason : undefined).toBe(
      "aborted",
    );
  });
});

describe("OLLAMA — provider failure recovery", () => {
  it("a transient connection failure is retried and the run then succeeds", async () => {
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
        { message: { role: "assistant", content: "recovered" }, done: true },
      ]);
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    const runtime = new CodePilotRuntime({
      workspaceRoot: process.cwd(),
      providerId: "ollama",
      modelId: "qwen3:8b",
      agentMode: "act",
      maxRetries: 2,
      requestApproval: async () => ({ approved: true }),
    });
    const events: Array<{ type: string }> = [];
    runtime.subscribe((event) => events.push({ type: event.type }));
    await runtime.initialize();
    await runtime.startSession("Say ok.");
    await runtime.dispose().catch(() => undefined);

    // First attempt failed transiently, second succeeded: the run completed
    // and never settled as failed.
    expect(call).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.type === "agent.retry")).toBe(true);
    expect(events.some((e) => e.type === "completed")).toBe(true);
    expect(events.some((e) => e.type === "agent.failed")).toBe(false);
  });
});
