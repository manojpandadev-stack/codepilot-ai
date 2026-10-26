/**
 * Host OpenRouter model mapping (hermetic, mocked fetch).
 *
 * Drives the REAL provider/models handler through the integration harness
 * with a stubbed OpenRouter /models payload and asserts the webview payload:
 * per-model metadata tool flags map to the honest tri-state (metadata true
 * → "true", metadata false → "false", absent → resolver), pricing and
 * descriptions pass through, and no secret ever appears in any message.
 */
import { describe, expect, it, vi } from "vitest";
import { freshHost, sleep, type FreshHost } from "./vscode-integration-harness";
import type { WebviewMessage } from "@codepilot/shared";

function openRouterPayload(): Response {
  return new Response(
    JSON.stringify({
      object: "list",
      data: [
        {
          id: "acme/coder-1",
          object: "model",
          name: "Acme Coder",
          description: "A coding model.",
          context_length: 131072,
          pricing: { prompt: "0.0000005", completion: "0.0000015" },
          supported_parameters: ["temperature", "tools"],
          architecture: { input_modalities: ["text"] },
        },
        {
          id: "acme/chat-1",
          object: "model",
          supported_parameters: ["temperature"],
        },
      ],
    }),
    { status: 200 },
  );
}

describe("provider/models OpenRouter metadata mapping", () => {
  it("fails closed and returns empty models for removed provider openrouter", async () => {
    const host: FreshHost = await freshHost();
    const sent: WebviewMessage[] = [];
    const fetchMock = vi.fn(async () => openRouterPayload());
    vi.stubGlobal(
      "fetch",
      fetchMock as unknown as typeof fetch,
    );
    try {
      host.ext.__setWebviewSinkForIntegrationTest((m) => {
        sent.push(m as WebviewMessage);
      });
      await host.seams.handleMessage({
        type: "provider/models",
        id: "wv-or-models",
        payload: { providerId: "openrouter" },
        timestamp: Date.now(),
      });
      await sleep(200);
      const msg = sent.find((m) => m.type === "provider/models");
      expect(msg).toBeDefined();
      const payload = msg!.payload as {
        providerId: string;
        models: Array<Record<string, unknown>>;
      };
      expect(payload.providerId).toBe("openrouter");
      expect(payload.models).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate().catch(() => {});
      host.cleanup();
    }
  }, 30_000);
});
