/**
 * BRIEF 8 — Scenario C (Local-mode re-block) + duplicate-error consolidation
 * for an ORDINARY provider failure.
 *
 * Scenario C: after cloud mode was explicitly enabled, switching BACK to
 * Local must immediately re-block remote inference — before any network
 * request — with the same single actionable card (and no silent flip).
 *
 * Duplicate-error: an ordinary (non-privacy) provider failure must produce
 * exactly ONE user-facing error card. Historically this failure produced
 * "AI REQUEST FAILED" AND "AGENT RUNTIME FAILED" for one root cause.
 *
 * Local-path control: the same local provider that failed with an ordinary
 * error still runs when the network endpoint answers (scripted), proving the
 * privacy machinery never touches local requests.
 */

import { describe, expect, it, vi } from "vitest";
import {
  freshHost,
  reopenHost,
  sleep,
  type FreshHost,
} from "./vscode-integration-harness";
import type { WebviewMessage } from "@codepilot/shared";

const FAKE_KEY = "sk-or-scenario-c-not-a-real-key";

function errorCards(sent: WebviewMessage[]) {
  return sent.filter((m) => m.type === "error");
}

async function selectOpenAI(host: FreshHost): Promise<void> {
  const svc = host.seams.getProviderService();
  await svc.setCredential("openai-native", FAKE_KEY);
  await host.seams.handleMessage({
    type: "provider/configure",
    id: `c-key-${Date.now()}`,
    payload: { providerId: "openai-native", apiKey: FAKE_KEY },
    timestamp: Date.now(),
  });
  await host.seams.handleMessage({
    type: "settings/set",
    id: `c-prov-${Date.now()}`,
    payload: { key: "provider", value: "openai-native" },
    timestamp: Date.now(),
  });
  await host.seams.handleMessage({
    type: "settings/set",
    id: `c-model-${Date.now()}`,
    payload: { key: "model", value: "gpt-4o" },
    timestamp: Date.now(),
  });
}

describe("Scenario C: switching back to Local re-blocks remote inference", () => {
  it(
    "cloud → local: the next OpenAI prompt is blocked pre-flight, once, and the runtime agrees",
    async () => {
      const host = await freshHost();
      const sent: WebviewMessage[] = [];
      try {
        host.ext.__setWebviewSinkForIntegrationTest((m) => {
          sent.push(m as WebviewMessage);
        });
        await selectOpenAI(host);

        // Enable cloud (explicit), verify it applies…
        await host.seams.handleMessage({
          type: "privacy/confirm",
          id: "c2-cloud",
          payload: { mode: "cloud" },
          timestamp: Date.now(),
        });
        const rt1 = await host.seams.ensureRuntime();
        expect(rt1.getProviderSettings().privacyMode).toBe("cloud");
        sent.length = 0;

        // …then switch BACK to Local via the SAME explicit action path
        // (the Settings select uses settings/set privacyMode=local).
        await host.seams.handleMessage({
          type: "settings/set",
          id: "c2-local",
          payload: { key: "privacyMode", value: "local" },
          timestamp: Date.now(),
        });
        // Persisted AND live-applied.
        expect(
          host.vscodeStub.workspace
            .getConfiguration("codepilot")
            .get("privacyMode", "cloud"),
        ).toBe("local");
        expect(rt1.getProviderSettings().privacyMode).toBe("local");

        // The next remote prompt must be blocked BEFORE any network request.
        await host.seams.runPrompt("hi again", "act");
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline && errorCards(sent).length === 0) {
          await sleep(400);
        }
        const card = errorCards(sent)[0];
        expect(card).toBeDefined();
        const p = card!.payload as { privacyBlocked?: boolean; message?: string };
        expect(p.privacyBlocked).toBe(true);
        expect(p.message ?? "").toMatch(/No request was made/i);
        // ONE card — no duplicate for the blocked attempt.
        expect(errorCards(sent).length).toBe(1);
        // No completion could have been produced (request never ran).
        expect(
          sent.some((m) => m.type === "agent/status" &&
            (m.payload as { status?: string }).status === "completed"),
        ).toBe(false);
      } finally {
        host.ext.__clearWebviewSinkForIntegrationTest();
        await host.ext.deactivate().catch(() => {});
        host.cleanup();
      }
    },
    60_000,
  );
});

describe("duplicate-error consolidation for an ORDINARY provider failure", () => {
  it(
    "a failing local endpoint produces exactly ONE error card (no AGENT RUNTIME FAILED twin)",
    async () => {
      const host = await freshHost();
      const sent: WebviewMessage[] = [];
      try {
        // Local provider, dead endpoint → an ordinary network failure
        // (no privacy involvement) through the REAL runtime request path.
        // Same seam the continuation tests use: the host re-syncs the live
        // runtime baseUrl from ProviderService.effectiveBaseUrl() before the
        // run, so the dead endpoint MUST be set through the service (a bare
        // configOverrides write is silently overridden by that re-sync).
        host.seams
          .getProviderService()
          .setConfig("ollama", { baseUrl: "http://127.0.0.1:11499" });
        // Cloud-first default is OpenRouter; this test exercises a LOCAL
        // endpoint failure, so it explicitly selects Ollama.
        await host.seams.handleMessage({
          type: "settings/set",
          id: "wv-local-prov",
          payload: { key: "provider", value: "ollama" },
          timestamp: Date.now(),
        });
        host.ext.__setWebviewSinkForIntegrationTest((m) => {
          sent.push(m as WebviewMessage);
        });
        await host.seams.runPrompt("hi", "act");
        // ECONNREFUSED is transient-classified, so withRetry re-attempts with
        // backoff before the failure settles — the wait must outlast the
        // retry budget (attempts at ~0s/0.5s/1.5s) plus connect timeouts.
        const deadline = Date.now() + 50_000;
        while (Date.now() < deadline && errorCards(sent).length === 0) {
          await sleep(1_000);
        }
        // Allow late async events to settle before counting.
        await sleep(1_500);
        const cards = errorCards(sent);
        expect(cards.length).toBeGreaterThan(0);
        // THE regression: exactly ONE primary card per failure.
        expect(cards.length).toBe(1);
        const text = JSON.stringify(cards[0]!.payload);
        // The card carries the root cause (provider + the real transport error).
        expect(text).toMatch(/ollama|ECONNREFUSED|failed/i);
        // …and it is NOT the duplicate "AGENT RUNTIME FAILED" twin.
        expect(text.includes("AGENT RUNTIME FAILED")).toBe(false);
      } finally {
        host.ext.__clearWebviewSinkForIntegrationTest();
        await host.ext.deactivate().catch(() => {});
        host.cleanup();
      }      },
    70_000,
  );

  it(
    "a scripted local run still completes end-to-end after all privacy changes (local requests untouched)",
    async () => {
      const host = await freshHost();
      const sent: WebviewMessage[] = [];
      try {
        host.ext.__setWebviewSinkForIntegrationTest((m) => {
          sent.push(m as WebviewMessage);
        });
        // Real runtime against a scripted Ollama endpoint (NDJSON stream,
        // same shape the runtime's OllamaLlmProvider parses): the loop must
        // complete with text — privacy guards and error consolidation must
        // never interfere with a healthy LOCAL run. The cloud-first default
        // is OpenRouter, so this local run selects Ollama explicitly.
        await host.seams.handleMessage({
          type: "settings/set",
          id: "wv-local-prov2",
          payload: { key: "provider", value: "ollama" },
          timestamp: Date.now(),
        });
        const ndjson = (...lines: unknown[]): Response =>
          new Response(
            lines.map((l) => `${JSON.stringify(l)}\n`).join(""),
            { status: 200 },
          );
        const scripted = vi.fn(async (input: unknown) => {
          const url = String(input);
          if (url.includes("/api/tags")) {
            return new Response(JSON.stringify({ models: [{ name: "qwen3:8b" }] }), {
              status: 200,
            });
          }
          return ndjson(
            { model: "qwen3:8b", message: { role: "assistant", content: "Hello" }, done: false },
            { model: "qwen3:8b", message: { role: "assistant", content: " from local." }, done: false },
            { model: "qwen3:8b", message: { role: "assistant", content: "" }, done: true },
          );
        }) as unknown as typeof fetch;
        vi.stubGlobal("fetch", scripted);

        await host.seams.runPrompt("say hi", "act");
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const completed = sent.some(
            (m) =>
              m.type === "agent/status" &&
              (m.payload as { status?: string }).status === "completed",
          );
          if (completed) break;
          await sleep(500);
        }
        expect(
          sent.some(
            (m) =>
              m.type === "agent/status" &&
              (m.payload as { status?: string }).status === "completed",
          ),
        ).toBe(true);
        expect(errorCards(sent).length).toBe(0);
      } finally {
        vi.unstubAllGlobals();
        host.ext.__clearWebviewSinkForIntegrationTest();
        await host.ext.deactivate().catch(() => {});
        host.cleanup();
      }
    },
    60_000,
  );
});
