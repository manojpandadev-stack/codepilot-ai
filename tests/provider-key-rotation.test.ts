/**
 * H5: credential rotation reaches the live provider (hermetic).
 *
 * Rotating the saved OpenRouter key and re-running must send the NEW
 * credential — never a stale cached one. The stub captures Authorization
 * headers per chat request (fake key material only, asserted as values
 * because proving WHICH key was sent is the entire point).
 */
import { describe, expect, it, vi } from "vitest";
import {
  freshHost,
  sleep,
  type FreshHost,
} from "./vscode-integration-harness";
import type { WebviewMessage } from "@codepilot/shared";

const KEY_A = "sk-test-key-aaa-not-real";
const KEY_B = "sk-test-key-bbb-not-real";

describe("provider credential rotation (H5)", () => {
  it(
    "uses the new key after rotation, never the cached old one",
    async () => {
      const host: FreshHost = await freshHost();
      const sent: WebviewMessage[] = [];
      const authHeaders: Array<string | null> = [];
      const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/chat/completions")) {
          const headers = new Headers(init?.headers);
          authHeaders.push(headers.get("authorization"));
          return new Response(JSON.stringify({ error: "bad key" }), {
            status: 401,
          });
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
      try {
        const svc = host.seams.getProviderService();
        await svc.setCredential("openai-native", KEY_A);
        await host.seams.handleMessage({
          type: "settings/set",
          id: "wv-rot-prov",
          payload: { key: "provider", value: "openai-native" },
          timestamp: Date.now(),
        });
        await host.seams.handleMessage({
          type: "privacy/confirm",
          id: "wv-rot-cloud",
          payload: { mode: "cloud" },
          timestamp: Date.now(),
        });
        host.ext.__setWebviewSinkForIntegrationTest((m) => {
          sent.push(m as WebviewMessage);
        });

        await host.seams.runPrompt("hi", "act");
        await sleep(400);
        expect(authHeaders).toHaveLength(1);
        expect(authHeaders[0]).toBe(`Bearer ${KEY_A}`);

        // Rotate the saved credential mid-life (same live runtime).
        await host.seams.handleMessage({
          type: "provider/configure",
          id: "wv-rot-key",
          payload: { providerId: "openai-native", apiKey: KEY_B },
          timestamp: Date.now(),
        });
        await host.seams.runPrompt("hi again", "act");
        await sleep(400);

        expect(authHeaders).toHaveLength(2);
        expect(authHeaders[1]).toBe(`Bearer ${KEY_B}`);
        // No webview message ever carries either key value.
        expect(
          sent.some(
            (m) =>
              JSON.stringify(m).includes(KEY_A) ||
              JSON.stringify(m).includes(KEY_B),
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
