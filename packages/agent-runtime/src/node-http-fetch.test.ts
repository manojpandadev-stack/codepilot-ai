/**
 * BUG 5 — default local transport regression (node:http, no undici caps).
 *
 * Root cause (measured, live qwen3:8b — tests/ollama-perf-live.test.ts):
 * the production Ollama path used Node's global `fetch` (undici), which
 * enforces a default 300s HEADERS timeout (UND_ERR_HEADERS_TIMEOUT). A
 * legitimate slow local prefill (model load + prompt evaluation on CPU is
 * silent for minutes) was killed at the transport layer BEFORE the
 * provider's designed 15-minute first-token inactivity window could apply.
 *
 * Fix: the local Ollama transport is now selectable. The registry keeps
 * global fetch as the default seam (tests/embedding hosts), and the
 * production host opts in via `transport: "node-http"` /
 * `CodePilotRuntimeOptions.ollamaUseNodeHttpTransport` — swapping in
 * `nodeHttpFetch`, which imposes NO transport timeouts. The provider's own
 * inactivity windows remain the sole timeout authority.
 *
 * The wiring assertions below are the true regression guard: they pin that
 * the default stays global fetch, that `transport: "node-http"` opts in, and
 * that an explicit fetchImpl wins. The behavioral tests (streaming, abort,
 * status, refusal) prove the adapter is a faithful fetch replacement. (A
 * unit test cannot reproduce undici's 300s cap itself without a 5-minute
 * sleep; the wiring check is what pins the guarantee.)
 */
import * as http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeHttpFetch } from "./native/llm/node-http-fetch.js";
import { OllamaLlmProvider } from "./native/llm/ollama.js";
import { createLlmProvider } from "./native/llm/registry.js";
import { CodePilotRuntime } from "./runtime.js";
import type { LlmRequest } from "./native/llm/types.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
});

/** Minimal NDJSON /api/chat + /api/tags stub over a real localhost socket. */
async function startStub(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

function ndjson(lines: unknown[]): string {
  return lines.map((l) => `${JSON.stringify(l)}\n`).join("");
}

function defaultRequest(): LlmRequest {
  return {
    providerId: "ollama",
    modelId: "qwen3:8b",
    messages: [{ role: "user", content: "hi" }],
  } as LlmRequest;
}

async function collect(
  provider: OllamaLlmProvider,
  request: LlmRequest = defaultRequest(),
): Promise<Array<{ type: string; text?: string; reason?: string }>> {
  const events: Array<{ type: string; text?: string; reason?: string }> = [];
  for await (const ev of provider.stream(request)) {
    const e = ev as { type: string; text?: string; reason?: string };
    events.push({
      type: e.type,
      ...(e.text !== undefined ? { text: e.text } : {}),
      ...(e.reason !== undefined ? { reason: e.reason } : {}),
    });
  }
  return events;
}

describe("node-http transport — default wiring (global fetch is the default)", () => {
  it("OllamaLlmProvider defaults to GLOBAL fetch (the test seam), not node-http", async () => {
    const port = await startStub((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(ndjson([{ message: { content: "ok" }, done: true }]));
    });
    const provider = new OllamaLlmProvider({
      baseUrl: `http://127.0.0.1:${port}`,
    });
    // The wiring IS the contract: default = global fetch (undici), so
    // vi.stubGlobal("fetch") keeps intercepting in every embedding test.
    const inner = provider as unknown as {
      usesNodeHttpTransport: boolean;
      fetchImpl: typeof fetch;
    };
    expect(inner.usesNodeHttpTransport).toBe(false);
    expect(inner.fetchImpl).toBe(fetch);
    const events = await collect(provider);
    expect(events.some((e) => e.type === "text-delta" && e.text === "ok")).toBe(
      true,
    );
    expect(events.at(-1)?.type).toBe("finish");
  });

  it("transport 'node-http' opts in; explicit fetchImpl wins", () => {
    const make = (
      options: ConstructorParameters<typeof OllamaLlmProvider>[0],
    ) =>
      new OllamaLlmProvider(options) as unknown as {
        usesNodeHttpTransport: boolean;
      };
    expect(make({}).usesNodeHttpTransport).toBe(false);
    expect(make({ transport: "fetch" }).usesNodeHttpTransport).toBe(false);
    expect(make({ transport: "node-http" }).usesNodeHttpTransport).toBe(true);
    // Explicit fetchImpl always wins over the transport option.
    expect(
      make({ transport: "node-http", fetchImpl: fetch }).usesNodeHttpTransport,
    ).toBe(false);
  });

  it("createLlmProvider: default = global fetch; transport 'node-http' opts in; explicit fetchImpl wins", () => {
    const make = (options: Parameters<typeof createLlmProvider>[1]) =>
      createLlmProvider(
        { providerId: "ollama", modelId: "qwen3:8b" },
        options,
      ) as unknown as { usesNodeHttpTransport: boolean };

    // Default (tests/embedding seam): global fetch — NOT node-http.
    expect(make({ configs: [] }).usesNodeHttpTransport).toBe(false);
    // Production opt-in: node-http (undici caps bypassed).
    expect(
      make({ configs: [], transport: "node-http" }).usesNodeHttpTransport,
    ).toBe(true);
    // Explicit fetchImpl wins even over the transport option.
    expect(
      make({ configs: [], transport: "node-http", fetchImpl: fetch })
        .usesNodeHttpTransport,
    ).toBe(false);
  });
});

describe("node-http transport — faithful fetch semantics (opted in)", () => {
  it("streams NDJSON chunks incrementally (no buffering-until-end)", async () => {
    const port = await startStub((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(ndjson([{ message: { role: "assistant", content: "a" } }]));
      setTimeout(() => {
        res.write(ndjson([{ message: { content: "b" }, done: true }]));
        res.end();
      }, 120);
    });
    const provider = new OllamaLlmProvider({
      baseUrl: `http://127.0.0.1:${port}`,
      transport: "node-http",
    });
    const events = await collect(provider);
    const texts = events
      .filter((e) => e.type === "text-delta")
      .map((e) => e.text)
      .join("");
    expect(texts).toBe("ab");
  });

  it("delayed headers (1.2s) still complete — no transport-level impatience", async () => {
    const port = await startStub((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.end(ndjson([{ message: { content: "late" }, done: true }]));
      }, 1_200);
    });
    const provider = new OllamaLlmProvider({
      baseUrl: `http://127.0.0.1:${port}`,
      transport: "node-http",
      firstTokenTimeoutMs: 9_000,
      timeoutMs: 9_000,
    });
    const events = await collect(provider);
    expect(events.some((e) => e.type === "text-delta")).toBe(true);
  });
});

describe("node-http transport — failure and cancellation paths", () => {
  it("mid-stream abort finishes the stream with reason 'aborted'", async () => {
    let res!: http.ServerResponse;
    const port = await startStub((_req, r) => {
      res = r;
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(ndjson([{ message: { role: "assistant", content: "first" } }]));
      // never ends — the caller must be able to abort
    });
    const provider = new OllamaLlmProvider({
      baseUrl: `http://127.0.0.1:${port}`,
      transport: "node-http",
      firstTokenTimeoutMs: 30_000,
      timeoutMs: 30_000,
    });
    const controller = new AbortController();
    const events: Array<{ type: string; reason?: string }> = [];
    const run = (async () => {
      for await (const ev of provider.stream({
        ...defaultRequest(),
        signal: controller.signal,
      })) {
        const e = ev as { type: string; reason?: string };
        events.push({
          type: e.type,
          ...(e.reason !== undefined ? { reason: e.reason } : {}),
        });
      }
    })();
    // wait for the first delta, then abort
    await new Promise((r) => setTimeout(r, 250));
    controller.abort();
    await run;
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "aborted" });
    res.end();
  });

  it("non-200 response surfaces status and body through LlmError", async () => {
    const port = await startStub((_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("model exploded");
    });
    const provider = new OllamaLlmProvider({
      baseUrl: `http://127.0.0.1:${port}`,
      transport: "node-http",
    });
    await expect(collect(provider)).rejects.toThrow(/chat failed 500/);
  });

  it("connection refused names the endpoint and carries ECONNREFUSED (both transports)", async () => {
    // Grab an ephemeral port by binding and closing — nothing listens there.
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const addr = probe.address();
    const port = addr && typeof addr !== "string" ? addr.port : 1;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    // DEFAULT (global fetch/undici): the raw error is the opaque "fetch
    // failed" — the provider must unwrap the cause (ECONNREFUSED) so
    // health-check classification sees the real transport reason.
    const viaFetch = new OllamaLlmProvider({
      baseUrl: `http://127.0.0.1:${port}`,
    });
    await expect(viaFetch.listInstalledModels()).rejects.toThrow(
      /ECONNREFUSED/,
    );

    // OPT-IN node-http: the adapter itself already carries the cause code.
    const viaNodeHttp = new OllamaLlmProvider({
      baseUrl: `http://127.0.0.1:${port}`,
      transport: "node-http",
    });
    await expect(viaNodeHttp.listInstalledModels()).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });

  it("nodeHttpFetch.json() parses a JSON document (listInstalledModels path)", async () => {
    const port = await startStub((_req, res) => {
      if (_req.url === "/api/tags") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "qwen3:8b", size: 1 }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const provider = new OllamaLlmProvider({
      baseUrl: `http://127.0.0.1:${port}`,
      transport: "node-http",
    });
    const models = await provider.listInstalledModels();
    expect(models).toEqual([{ name: "qwen3:8b", size: 1 }]);
  });

  it("direct adapter: response.ok/status/text() behave like fetch", async () => {
    const port = await startStub((_req, res) => {
      res.writeHead(418, { "Content-Type": "text/plain" });
      res.end("teapot");
    });
    const res = await nodeHttpFetch(`http://127.0.0.1:${port}/x`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(418);
    expect(await res.text()).toBe("teapot");
  });
});

describe("CodePilotRuntime — ollamaUseNodeHttpTransport wiring (both paths)", () => {
  function stubGlobalFetchForChat(chatHits: { n: number }): typeof fetch {
    return vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/chat")) {
        chatHits.n += 1;
        return new Response(
          ndjson([{ message: { content: "via-global-fetch" }, done: true }]),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  function makeRuntime(
    options: Partial<ConstructorParameters<typeof CodePilotRuntime>[0]>,
  ): CodePilotRuntime {
    return new CodePilotRuntime({
      workspaceRoot: process.cwd(),
      providerId: "ollama",
      modelId: "qwen3:8b",
      agentMode: "act",
      requestApproval: async () => ({ approved: true }),
      ...options,
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("false/unset (default): the chat leg is carried by GLOBAL fetch (stub seam)", async () => {
    const chatHits = { n: 0 };
    vi.stubGlobal("fetch", stubGlobalFetchForChat(chatHits));
    const nodeHttpChat = await startStub((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(ndjson([{ message: { content: "via-node-http" }, done: true }]));
    });

    const runtime = makeRuntime({
      baseUrl: `http://127.0.0.1:${nodeHttpChat}`,
      ollamaUseNodeHttpTransport: false,
    });
    await runtime.initialize();
    await runtime.startSession("Say ok.");
    await runtime.dispose().catch(() => undefined);

    // The chat leg went through the stubbed global fetch — the seam works.
    expect(chatHits.n).toBeGreaterThan(0);
  });

  it("true + ollama provider: the chat leg BYPASSES global fetch and uses node-http", async () => {
    const chatHits = { n: 0 };
    vi.stubGlobal("fetch", stubGlobalFetchForChat(chatHits));
    const port = await startStub((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(ndjson([{ message: { content: "via-node-http" }, done: true }]));
    });

    const runtime = makeRuntime({
      baseUrl: `http://127.0.0.1:${port}`,
      ollamaUseNodeHttpTransport: true,
    });
    await runtime.initialize();
    await runtime.startSession("Say ok.");
    await runtime.dispose().catch(() => undefined);

    // node-http carried the chat; global fetch never did (the stub would
    // happily have served it — its zero hits are the proof).
    expect(chatHits.n).toBe(0);
  });
});
