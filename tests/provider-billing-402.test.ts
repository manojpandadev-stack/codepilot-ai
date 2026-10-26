/**
 * Provider billing failure (HTTP 402) end-to-end regression test.
 *
 * A 402 from OpenRouter means the requested token budget exceeds available
 * credits. The run must: attempt exactly ONE chat request (no retries),
 * surface ONE error card with an actionable billing message (including the
 * reported affordable budget), keep the selected provider/model untouched,
 * and never fall back to Ollama or blame the model.
 *
 * Hermetic: global fetch is stubbed (402 for completions). No key, no
 * network, no Ollama.
 */
import { describe, expect, it, vi } from "vitest";
import {
  freshHost,
  sleep,
  type FreshHost,
} from "./vscode-integration-harness";
import type { WebviewMessage } from "@codepilot/shared";

const FAKE_KEY = "sk-openai-billing-test-not-real";
const MODEL = "gpt-4o-mini";

function provider402(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message:
          "Insufficient credits. This request would cost $0.42 in input and output tokens, but the available credit could only afford 11247 tokens.",
        code: 402,
      },
    }),
    { status: 402 },
  );
}

describe("provider billing failure (HTTP 402)", () => {
  it(
    "single attempt, one actionable card, config preserved, no fallback",
    async () => {
      const host: FreshHost = await freshHost();
      const sent: WebviewMessage[] = [];
      const completionsUrls: string[] = [];
      const fetchMock = vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("/chat/completions")) {
          completionsUrls.push(url);
          return provider402();
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
      try {
        const svc = host.seams.getProviderService();
        await svc.setCredential("openai-native", FAKE_KEY);
        await host.seams.handleMessage({
          type: "settings/set",
          id: "wv-bill-prov",
          payload: { key: "provider", value: "openai-native" },
          timestamp: Date.now(),
        });
        await host.seams.handleMessage({
          type: "settings/set",
          id: "wv-bill-model",
          payload: { key: "model", value: MODEL },
          timestamp: Date.now(),
        });
        // Explicit cloud opt-in (the only path that flips privacy mode).
        await host.seams.handleMessage({
          type: "privacy/confirm",
          id: "wv-bill-cloud",
          payload: { mode: "cloud" },
          timestamp: Date.now(),
        });

        host.ext.__setWebviewSinkForIntegrationTest((m) => {
          sent.push(m as WebviewMessage);
        });
        await host.seams.runPrompt("hi", "act");
        const deadline = Date.now() + 30_000;
        while (
          Date.now() < deadline &&
          !sent.some((m) => m.type === "error")
        ) {
          await sleep(500);
        }

        // Exactly one chat request: billing failures are never retried.
        expect(completionsUrls).toHaveLength(1);
        expect(
          sent.filter((m) => m.type === "agent.retry").length,
        ).toBe(0);

        // Exactly one consolidated error card with the actionable message.
        const errorCards = sent.filter((m) => m.type === "error");
        expect(errorCards).toHaveLength(1);
        const text = JSON.stringify(errorCards[0]!.payload);
        expect(text).toContain("AI REQUEST FAILED");
        expect(text).toContain("OpenAI");
        expect(text).toContain(MODEL);
        expect(text).toContain("exceeds the available credits");
        expect(text).toContain("11,247");
        expect(text).toContain("sufficient credits");

        // Config preserved: no silent switch, no Ollama fallback, model
        // not blamed.
        expect(
          host.vscodeStub.workspace
            .getConfiguration("codepilot")
            .get("provider", ""),
        ).toBe("openai-native");
        expect(
          host.vscodeStub.workspace
            .getConfiguration("codepilot")
            .get("model", ""),
        ).toBe(MODEL);
        const allText = sent.map((m) => JSON.stringify(m)).join("\n");
        expect(allText.toLowerCase()).not.toContain("ollama");
        expect(text.toLowerCase()).not.toContain("model is broken");
        expect(text.toLowerCase()).not.toContain("switch");

        // The secret never appears in any webview message.
        expect(
          sent.some((m) => JSON.stringify(m).includes(FAKE_KEY)),
        ).toBe(false);
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
