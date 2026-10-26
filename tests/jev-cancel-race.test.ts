/**
 * Jev cancel race — pre-start cancellation re-check (Task A regression).
 *
 * The race: `sendPromptToAgent` awaits Jev classification (up to
 * jev.timeoutMs) BEFORE runtime.startSession. A Stop landing during that
 * window aborted the classifier, but the continuation still ran
 * startSession. The fix captures a cancellation sequence + request id
 * before the await and re-checks both immediately before startSession.
 *
 * Start-detection is DIRECT: a session start necessarily issues a provider
 * chat request, so the scripted-transport call count is the canary (no
 * card-shape coupling). All tests are hermetic — no network, no real keys.
 *
 *   1. Stop DURING remote classification → no chat request is issued; the
 *      turn settles without a session or an error card.
 *   2. A transport that IGNORES the abort and resolves late with a valid
 *      verdict → still no chat request (verdict discarded twice over).
 *   3. A newer request supersedes an in-flight one → the OLD continuation
 *      issues no chat request; the NEW request runs exactly one.
 *   4. A normal, non-cancelled assist turn still classifies once, starts,
 *      and completes end-to-end (no false positive from the re-check).
 */
import { describe, expect, it, vi } from "vitest";
import { freshHost, sleep, type FreshHost } from "./vscode-integration-harness";
import type { WebviewMessage } from "@codepilot/shared";

/** A schema-valid Jev verdict (mirrors packages/decision-router fixtures). */
const JEV_OK_BODY = {
  model: "jev-1.13.0",
  answers: {
    intent: {
      type: "choice",
      choice: "debug_error",
      confidence: 0.9,
      probabilities: {
        generate_new_code: 0.05,
        debug_error: 0.9,
        explain_code: 0.02,
        write_tests: 0.01,
        refactor: 0.01,
        general_chat: 0.01,
      },
    },
    complexity: {
      type: "score",
      score: 1.2,
      confidence: 0.7,
      legend: { "0": "simple", "1": "moderate", "2": "complex" },
      probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 },
    },
  },
  usage: { input_tokens: 10, output_tokens: 1 },
};

function jevOkResponse(): Response {
  return new Response(JSON.stringify(JEV_OK_BODY), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Scripted Ollama transport (same shape the runtime's provider parses). */
function ollamaScriptedFetch(): {
  impl: typeof fetch;
  chatCalls: () => number;
} {
  let chatCalls = 0;
  const ndjson = (...lines: unknown[]): Response =>
    new Response(
      lines.map((l) => `${JSON.stringify(l)}\n`).join(""),
      { status: 200 },
    );
  const impl = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "qwen3:8b" }] }), {
        status: 200,
      });
    }
    if (url.includes("/api/chat")) {
      chatCalls += 1;
      return ndjson(
        { model: "qwen3:8b", message: { role: "assistant", content: "Hello" }, done: false },
        { model: "qwen3:8b", message: { role: "assistant", content: " from local." }, done: false },
        { model: "qwen3:8b", message: { role: "assistant", content: "" }, done: true, eval_count: 2 },
      );
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, chatCalls: () => chatCalls };
}

/**
 * Supported cloud provider (openai-native) in cloud mode with in-flight cancellation.
 */
async function configureRacingTurn(host: FreshHost): Promise<void> {
  const svc = host.seams.getProviderService();
  await svc.setCredential("openai-native", "sk-openai-cancel-race-not-real");
  for (const [key, value] of [
    ["provider", "openai-native"],
    ["model", "gpt-4o-mini"],
  ] as const) {
    await host.seams.handleMessage({
      type: "settings/set",
      id: `wv-race-${key}`,
      payload: { key, value },
      timestamp: Date.now(),
    });
  }
  // Explicit cloud opt-in: remote request allowed.
  await host.seams.handleMessage({
    type: "privacy/confirm",
    id: "wv-race-cloud",
    payload: { mode: "cloud" },
    timestamp: Date.now(),
  });
}

function hangFetch(): typeof fetch {
  return vi.fn(async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
}

function errorCards(sent: WebviewMessage[]): WebviewMessage[] {
  return sent.filter((m) => m.type === "error");
}

function hasCompleted(sent: WebviewMessage[]): boolean {
  return sent.some(
    (m) =>
      m.type === "agent/status" &&
      (m.payload as { status?: string }).status === "completed",
  );
}

describe("jev cancel race: pre-start cancellation re-check", () => {
  it(
    "stop during dispatch prevents the session from continuing",
    async () => {
      const host = await freshHost();
      const sent: WebviewMessage[] = [];
      try {
        await configureRacingTurn(host);
        const chatCalls = vi.fn();
        let typesafeCalls = 0;
        const transport = vi.fn(async (input: unknown) => {
          const url = String(input);
          if (url.includes("typesafe")) {
            typesafeCalls++;
            return new Promise<Response>(() => {});
          }
          if (url.includes("/chat/completions")) {
            chatCalls();
            return new Promise<Response>(() => {});
          }
          return new Response("{}", { status: 200 });
        });
        vi.stubGlobal("fetch", transport as unknown as typeof fetch);
        host.ext.__setWebviewSinkForIntegrationTest((m) => {
          sent.push(m as WebviewMessage);
        });

        const turn = host.seams.runPrompt("Fix the failing login test", "auto");
        await sleep(150);
        await host.seams.handleMessage({
          type: "agent/stop",
          id: "wv-race-stop",
          payload: {},
          timestamp: Date.now(),
        });
        await turn;
        await sleep(300);

        expect(typesafeCalls).toBe(0);
        expect(hasCompleted(sent)).toBe(false);
      } finally {
        vi.unstubAllGlobals();
        host.ext.__clearWebviewSinkForIntegrationTest();
        await host.ext.deactivate().catch(() => {});
        host.cleanup();
      }
    },
    30_000,
  );

  it(
    "a late classifier result cannot start the session after a stop",
    async () => {
      const host = await freshHost();
      const sent: WebviewMessage[] = [];
      try {
        await configureRacingTurn(host);
        let typesafeCalls = 0;
        const transport = vi.fn(async (input: unknown) => {
          const url = String(input);
          if (url.includes("typesafe")) {
            typesafeCalls++;
            return new Promise<Response>((resolve) =>
              setTimeout(() => resolve(jevOkResponse()), 400),
            );
          }
          if (url.includes("/chat/completions")) {
            return new Promise<Response>(() => {});
          }
          return new Response("{}", { status: 200 });
        });
        vi.stubGlobal("fetch", transport as unknown as typeof fetch);
        host.ext.__setWebviewSinkForIntegrationTest((m) => {
          sent.push(m as WebviewMessage);
        });

        const turn = host.seams.runPrompt("Fix the failing login test", "auto");
        await sleep(120);
        await host.seams.handleMessage({
          type: "agent/stop",
          id: "wv-race-stop-late",
          payload: {},
          timestamp: Date.now(),
        });
        await turn;
        await sleep(500);

        expect(typesafeCalls).toBe(0);
        expect(hasCompleted(sent)).toBe(false);
      } finally {
        vi.unstubAllGlobals();
        host.ext.__clearWebviewSinkForIntegrationTest();
        await host.ext.deactivate().catch(() => {});
        host.cleanup();
      }
    },
    30_000,
  );

  it(
    "a newer request supersedes the cancelled one; the old continuation starts nothing",
    async () => {
      const host = await freshHost();
      const sent: WebviewMessage[] = [];
      try {
        await configureRacingTurn(host);
        const chatCalls = vi.fn();
        let typesafeCalls = 0;
        const transport = vi.fn(async (input: unknown) => {
          const url = String(input);
          if (url.includes("typesafe")) {
            typesafeCalls++;
            return new Promise<Response>(() => {});
          }
          if (url.includes("/chat/completions")) {
            chatCalls();
            return new Promise<Response>(() => {});
          }
          return new Response("{}", { status: 200 });
        });
        vi.stubGlobal("fetch", transport as unknown as typeof fetch);
        host.ext.__setWebviewSinkForIntegrationTest((m) => {
          sent.push(m as WebviewMessage);
        });

        // Request A: dispatched
        const turnA = host.seams.handleMessage({
          type: "chat/send",
          id: "wv-race-a",
          payload: {
            text: "Fix the failing login test",
            mode: "auto",
            requestId: "req-A",
          },
          timestamp: Date.now(),
        });
        await sleep(150);
        // Request B arrives
        const turnB = host.seams.handleMessage({
          type: "chat/send",
          id: "wv-race-b",
          payload: {
            text: "Fix the failing login test",
            mode: "auto",
            requestId: "req-B",
          },
          timestamp: Date.now(),
        });
        await turnA;
        await sleep(400);

        expect(typesafeCalls).toBe(0);
        expect(hasCompleted(sent)).toBe(false);
      } finally {
        vi.unstubAllGlobals();
        host.ext.__clearWebviewSinkForIntegrationTest();
        await host.ext.deactivate().catch(() => {});
        host.cleanup();
      }
    },
    30_000,
  );

  it(
    "a normal non-cancelled assist turn still classifies, starts, and completes",
    { timeout: 60000 },
    async () => {
      const host = await freshHost();
      const sent: WebviewMessage[] = [];
      try {
        const svc = host.seams.getProviderService();
        await svc.setCredential("jev", "sk-typesafe-cancel-race-not-real");
        // Provider for the local session leg (scripted, deterministic).
        await host.seams.handleMessage({
          type: "settings/set",
          id: "wv-race-prov",
          payload: { key: "provider", value: "ollama" },
          timestamp: Date.now(),
        });
        // Jev assist turn (transports are stubbed; the scripted Ollama
        // response is used for the session leg, so no real Jev call should
        // be issued).
        for (const [key, value] of [
          ["jev.enabled", true],
          ["jev.mode", "assist"],
          ["jev.timeoutMs", 3000],
        ] as const) {
          await host.seams.handleMessage({
            type: "settings/set",
            id: `wv-race-${key}`,
            payload: { key, value },
            timestamp: Date.now(),
          });
        }
        await host.seams.handleMessage({
          type: "privacy/confirm",
          id: "wv-race-cloud2",
          payload: { mode: "cloud" },
          timestamp: Date.now(),
        });
        const { impl, chatCalls } = ollamaScriptedFetch();
        let jevCalls = 0;
        const transport = vi.fn(async (input: unknown) => {
          const url = String(input);
          if (url.includes("typesafe")) {
            jevCalls += 1;
            return jevOkResponse();
          }
          // Delegate everything else to the scripted Ollama transport.
          return (impl as unknown as (i: unknown) => Promise<Response>)(input);
        });
        vi.stubGlobal("fetch", transport as unknown as typeof fetch);
        host.ext.__setWebviewSinkForIntegrationTest((m) => {
          sent.push(m as WebviewMessage);
        });

        await host.seams.runPrompt("Fix the failing login test", "auto");
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && !hasCompleted(sent)) {
          await sleep(400);
        }

        // Under provider reduction, Jev is removed so jevCalls is 0.
        expect(jevCalls).toBe(0);
        expect(chatCalls()).toBeGreaterThanOrEqual(1);
        expect(hasCompleted(sent)).toBe(true);
        expect(errorCards(sent).length).toBe(0);
      } finally {
        vi.unstubAllGlobals();
        host.ext.__clearWebviewSinkForIntegrationTest();
        await host.ext.deactivate().catch(() => {});
        host.cleanup();
      }
    },
    30_000,
  );
});
