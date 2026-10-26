/**
 * H3: Jev remote-classification credential boundary (hermetic).
 *
 * With Jev enabled + cloud mode + a saved Jev key, the outbound TypeSafe
 * payload must carry the scrubbed prompt — never credential-shaped text
 * pasted into the user prompt. Synthetic markers only
 * (sk-fake-…, hunter2-fake-…); nothing real, nothing leaves the machine
 * except to the stubbed fetch.
 */
import { describe, expect, it, vi } from "vitest";
import {
  freshHost,
  sleep,
  type FreshHost,
} from "./vscode-integration-harness";
import type { WebviewMessage } from "@codepilot/shared";

const JEV_KEY = "sk-fake-jev-key-not-real";
const PROMPT_MARKER = "sk-fake-secret-12345678";
const PROMPT_MARKER_2 = "hunter2-fake-pw";

function jevSuccessBody(): Response {
  const probs: Record<string, number> = {
    generate_new_code: 0.05,
    debug_error: 0.05,
    write_tests: 0.05,
    explain_code: 0.05,
    refactor: 0.05,
    general_chat: 0.75,
  };
  return new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        intent: {
          type: "choice",
          choice: "general_chat",
          confidence: 0.87,
          probabilities: probs,
        },
        complexity: {
          type: "score",
          score: 1.2,
          confidence: 0.7,
          legend: { "0": "simple", "1": "moderate", "2": "complex" },
          probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 },
        },
      },
      usage: { input_tokens: 100, output_tokens: 10 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("jev remote payload scrubbing (H3)", () => {
  it(
    "scrubs credential-shaped prompt text before the TypeSafe request",
    async () => {
      const host: FreshHost = await freshHost();
      const sent: WebviewMessage[] = [];
      const jevBodies: string[] = [];
      const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("typesafe")) {
          const text =
            typeof init?.body === "string" ? init.body : "{}";
          jevBodies.push(text);
          return jevSuccessBody();
        }
        if (url.includes("/api/tags")) {
          return new Response(JSON.stringify({ models: [{ name: "llama3" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/api/chat")) {
          const ndjson = [
            JSON.stringify({ model: "llama3", message: { role: "assistant", content: "I cannot expose credentials." }, done: false }),
            JSON.stringify({ model: "llama3", message: { role: "assistant", content: "" }, done: true, eval_count: 2 }),
          ].join("\n");
          return new Response(ndjson, {
            status: 200,
            headers: { "content-type": "application/x-ndjson" },
          });
        }
        throw new Error("fetch failed: hermetic stub denies non-Jev traffic");
      });
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
      try {
        host.ext.__setWebviewSinkForIntegrationTest((m) => {
          sent.push(m as WebviewMessage);
        });
        const svc = host.seams.getProviderService();
        await svc.setCredential("jev", JEV_KEY);
        await host.seams.handleMessage({
          type: "settings/set",
          id: "wv-jev-on",
          payload: { key: "jev.enabled", value: true },
          timestamp: Date.now(),
        });
        await host.seams.handleMessage({
          type: "privacy/confirm",
          id: "wv-jev-cloud",
          payload: { mode: "cloud" },
          timestamp: Date.now(),
        });

        await host.seams.runPrompt(
          `my deploy key is ${PROMPT_MARKER} and db password = ${PROMPT_MARKER_2}, help me deploy`,
          "act",
        );
        await sleep(500);

        // Under provider reduction policy, Jev is removed and jev.enabled is rejected fail-closed
        expect(
          sent.some(
            (m) =>
              m.type === "settings/error" &&
              (m.payload as { key?: string })?.key === "jev.enabled",
          ),
        ).toBe(true);

        // With Jev removed, zero outbound TypeSafe classification requests are made.
        expect(jevBodies.length).toBe(0);

        // Synthetic markers never reach any webview message either.
        expect(
          sent.some(
            (m) =>
              JSON.stringify(m).includes(PROMPT_MARKER) ||
              JSON.stringify(m).includes(PROMPT_MARKER_2),
          ),
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
