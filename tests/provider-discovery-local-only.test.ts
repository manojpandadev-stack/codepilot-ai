/**
 * H1: Local Only blocks AUTHENTICATED remote model discovery and usage
 * probes (hermetic, mocked fetch).
 *
 * With Local Only + a saved OpenRouter key:
 * - provider/models serves the static catalogue with ZERO network
 *   requests and ZERO credential use (no Authorization header can leave,
 *   because no request leaves at all).
 * - provider/usage answers with an explicit error, also with zero requests.
 * Control: after explicit cloud opt-in, the same calls DO reach the
 * (stubbed) network. Local providers are unaffected (loopback is local).
 */
import { describe, expect, it, vi } from "vitest";
import {
  freshHost,
  sleep,
  type FreshHost,
} from "./vscode-integration-harness";
import type { WebviewMessage } from "@codepilot/shared";

const FAKE_KEY = "sk-openai-discovery-test-not-real";

function openaiModelsPayload(): Response {
  return new Response(
    JSON.stringify({
      object: "list",
      data: [
        {
          id: "gpt-4o-mini",
          object: "model",
        },
      ],
    }),
    { status: 200 },
  );
}

describe("local-only discovery gate (H1)", () => {
  it(
    "serves static catalogue with zero network under Local Only",
    async () => {
      const host: FreshHost = await freshHost();
      const sent: WebviewMessage[] = [];
      const fetchMock = vi.fn(async () => openaiModelsPayload());
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
      try {
        const svc = host.seams.getProviderService();
        await svc.setCredential("openai-native", FAKE_KEY);
        host.ext.__setWebviewSinkForIntegrationTest((m) => {
          sent.push(m as WebviewMessage);
        });
        // Privacy stays local (default) — never flipped.
        await host.seams.handleMessage({
          type: "provider/models",
          id: "wv-disc-local",
          payload: { providerId: "openai-native" },
          timestamp: Date.now(),
        });
        await sleep(200);
        const msg = sent.find((m) => m.type === "provider/models");
        expect(msg).toBeDefined();
        const payload = msg!.payload as {
          providerId: string;
          models: unknown[];
        };
        expect(payload.providerId).toBe("openai-native");
        expect(Array.isArray(payload.models)).toBe(true);
        // The gate fired: not a single byte left the machine, so no
        // Authorization header could have been sent anywhere.
        expect(fetchMock).not.toHaveBeenCalled();
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
    "refuses the usage probe without network under Local Only",
    async () => {
      const host: FreshHost = await freshHost();
      const sent: WebviewMessage[] = [];
      const fetchMock = vi.fn(async () => openaiModelsPayload());
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
      try {
        const svc = host.seams.getProviderService();
        await svc.setCredential("openai-native", FAKE_KEY);
        host.ext.__setWebviewSinkForIntegrationTest((m) => {
          sent.push(m as WebviewMessage);
        });
        await host.seams.handleMessage({
          type: "provider/usage",
          id: "wv-usage-local",
          payload: { providerId: "openai-native" },
          timestamp: Date.now(),
        });
        await sleep(200);
        const msg = sent.find((m) => m.type === "provider/usage");
        expect(msg).toBeDefined();
        const payload = msg!.payload as { error?: string };
        expect(payload.error ?? "").toMatch(/Local Only/i);
        expect(fetchMock).not.toHaveBeenCalled();
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
    "still discovers live after explicit cloud opt-in (gate is conditional)",
    async () => {
      const host: FreshHost = await freshHost();
      const sent: WebviewMessage[] = [];
      const fetchMock = vi.fn(async () => openaiModelsPayload());
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
      try {
        const svc = host.seams.getProviderService();
        await svc.setCredential("openai-native", FAKE_KEY);
        await host.seams.handleMessage({
          type: "privacy/confirm",
          id: "wv-disc-cloud",
          payload: { mode: "cloud" },
          timestamp: Date.now(),
        });
        host.ext.__setWebviewSinkForIntegrationTest((m) => {
          sent.push(m as WebviewMessage);
        });
        await host.seams.handleMessage({
          type: "provider/models",
          id: "wv-disc-cloud2",
          payload: { providerId: "openai-native" },
          timestamp: Date.now(),
        });
        await sleep(200);
        const msg = sent.find((m) => m.type === "provider/models");
        expect(msg).toBeDefined();
        const payload = msg!.payload as {
          models: Array<{ id?: string }>;
        };
        expect(payload.models.map((m) => m.id)).toContain("gpt-4o-mini");
        expect(fetchMock).toHaveBeenCalled();
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
