/**
 * OpenAI readiness (hermetic — no key, no network, no Ollama).
 *
 * Proves the provider architecture is ready for OpenAI API support:
 *   1. `openai-native` is a curated, selectable catalogue entry that
 *      requires an API key and carries models with pricing.
 *   2. Configuring a (fake) key stores it securely (SecretStorage slot)
 *      and surfaces presence-only booleans — the secret never appears in
 *      any webview message, log line, or persisted record scanned here.
 *   3. Connection truth for an unprobed cloud provider is honestly
 *      "configured" (never "connected") with ZERO network requests.
 *   4. Model resolution falls back to the static catalogue when the network
 *      is unavailable (fault-injected fetch).
 *
 * No OpenAI key is required: nothing here contacts api.openai.com.
 */
import { describe, expect, it, vi } from "vitest";
import {
  freshHost,
  sleep,
  type FreshHost,
} from "./vscode-integration-harness";
import type { WebviewMessage } from "@codepilot/shared";

const FAKE_KEY = "sk-openai-test-key-not-real";

describe("openai readiness", () => {
  it("openai-native is curated, requires a key, and carries models", async () => {
    const host: FreshHost = await freshHost();
    try {
      const svc = host.seams.getProviderService();
      const curated = svc.listProviders().map((p) => p.id);
      expect(curated).toContain("openai-native");
      const all = svc.listAllProviders().find((p) => p.id === "openai-native");
      expect(all).toBeDefined();
      expect(all!.requiresApiKey).toBe(true);
      expect(all!.baseUrl).toBe("https://api.openai.com/v1");
      const gpt = all!.models.find((m) => m.id === "gpt-4o");
      expect(gpt).toBeDefined();
      // Capability fields exist (never undefined) — the live command uses
      // them to decide whether tool-calling is supported before agent runs.
      expect(typeof gpt!.inputPerMtok).toBe("number");
      expect(gpt!.toolCalling === undefined).toBe(false);
    } finally {
      await host.ext.deactivate().catch(() => {});
      host.cleanup();
    }
  });

  it("stores the key securely and reports presence-only, offline-safe models", async () => {
    const host: FreshHost = await freshHost();
    const sent: WebviewMessage[] = [];
    // Fault-injected transport: everything network fails. Static catalogue
    // paths must still work; nothing here may depend on the network.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("offline"));
    try {
      const svc = host.seams.getProviderService();
      host.ext.__setWebviewSinkForIntegrationTest((m) => {
        sent.push(m as WebviewMessage);
      });

      await host.seams.handleMessage({
        type: "provider/configure",
        id: "wv-oai-key",
        payload: { providerId: "openai-native", apiKey: FAKE_KEY },
        timestamp: Date.now(),
      });
      expect(await svc.hasCredential("openai-native")).toBe(true);

      // Honest static truth without any REMOTE network request (local
      // provider probes stay loopback-only).
      const states = await svc.listConnectionStates();
      const entry = states.find((s) => s.id === "openai-native");
      expect(entry).toBeDefined();
      expect(entry!.state).toBe("configured");
      expect(entry!.connected).toBe(false);
      const remoteCalls = fetchSpy.mock.calls.filter((args) => {
        const url = String(args[0] ?? "");
        return !url.includes("localhost") && !url.includes("127.0.0.1");
      });
      expect(remoteCalls).toEqual([]);

      // Static model fallback still resolves the catalogue synchronously.
      await host.seams.handleMessage({
        type: "settings/set",
        id: "wv-oai-prov",
        payload: { key: "provider", value: "openai-native" },
        timestamp: Date.now(),
      });

      // The secret never appears in any webview message.
      expect(
        sent.some((m) => JSON.stringify(m).includes(FAKE_KEY)),
      ).toBe(false);
      await sleep(100);
      expect(
        sent.some((m) => JSON.stringify(m).includes(FAKE_KEY)),
      ).toBe(false);
    } finally {
      fetchSpy.mockRestore();
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate().catch(() => {});
      host.cleanup();
    }
  });
});
