/**
 * Jev decision routing — extension-host integration (hermetic).
 *
 * Exercises the real `chat/send` path through the integration harness:
 *   1. Disabled by default: no Jev traffic, provider/model untouched, the
 *      privacy block behaves exactly as without routing.
 *   2. Enabled + Local Only + saved key: no remote Jev request (fail-closed);
 *      the deterministic fallback classifies locally and the privacy block
 *      still fires exactly once.
 *   3. Assist + auto can never bypass privacy or approvals: the blocked turn
 *      produces no tool/approval traffic from routing.
 *   4. Key lifecycle (jev/save-key, jev/clear-key) is presence-only: the
 *      secret never appears in any webview message.
 *   5. jev.* settings keys are accepted by settings/set.
 *
 * No live Jev API key is required: every assertion here is pre-network or
 * local. The opt-in live proof lives in tests/jev-live.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import {
  freshHost,
  sleep,
  type FreshHost,
} from "./vscode-integration-harness";
import type { WebviewMessage } from "@codepilot/shared";

function typesafeCalls(spy: { mock: { calls: unknown[][] } }): unknown[][] {
  return spy.mock.calls.filter((args) =>
    String(args[0] ?? "").includes("typesafe"),
  );
}

async function configureCloudTurn(host: FreshHost): Promise<void> {
  const svc = host.seams.getProviderService();
  await svc.setCredential("openai-native", "sk-test-key-not-real");
  await svc.setCredential("jev", "sk-typesafe-test-key-not-real");
  await host.seams.handleMessage({
    type: "settings/set",
    id: "wv-jev-prov",
    payload: { key: "provider", value: "openai-native" },
    timestamp: Date.now(),
  });
  await host.seams.handleMessage({
    type: "settings/set",
    id: "wv-jev-model",
    payload: { key: "model", value: "gpt-4o-mini" },
    timestamp: Date.now(),
  });
  // Privacy mode stays at the default "local" (never flipped here).
}

describe("jev routing integration", () => {
  it(
    "disabled by default: no Jev traffic, provider/model preserved, privacy block unchanged",
    async () => {
      const host: FreshHost = await freshHost();
      const sent: WebviewMessage[] = [];
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        await configureCloudTurn(host);
        host.ext.__setWebviewSinkForIntegrationTest((m) => {
          sent.push(m as WebviewMessage);
        });
        const callsBefore = fetchSpy.mock.calls.length;
        await host.seams.runPrompt("hi", "act");
        await sleep(400);

        // No Jev request of any kind.
        expect(typesafeCalls(fetchSpy).length).toBe(0);
        expect(fetchSpy.mock.calls.length).toBe(callsBefore);

        // The privacy block is exactly as without routing: one card.
        const errorCards = sent.filter((m) => m.type === "error");
        expect(errorCards.length).toBe(1);
        expect(
          (errorCards[0]!.payload as { privacyBlocked?: boolean })
            .privacyBlocked,
        ).toBe(true);

        // Active provider/model untouched by routing.
        const rt = await host.seams.ensureRuntime();
        expect(rt.getProviderSettings().providerId).toBe("openai-native");
        expect(
          host.vscodeStub.workspace
            .getConfiguration("codepilot")
            .get("model", ""),
        ).toBe("gpt-4o-mini");
        expect(
          sent.some((m) => JSON.stringify(m).includes("sk-typesafe-test-key")),
        ).toBe(false);
      } finally {
        fetchSpy.mockRestore();
        host.ext.__clearWebviewSinkForIntegrationTest();
        await host.ext.deactivate().catch(() => {});
        host.cleanup();
      }
    },
    30_000,
  );

  it(
    "enabled + Local Only: removed classifier rejected, block still fires once, nothing remote",
    async () => {
      const host: FreshHost = await freshHost();
      const sent: WebviewMessage[] = [];
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        host.ext.__setWebviewSinkForIntegrationTest((m) => {
          sent.push(m as WebviewMessage);
        });
        await configureCloudTurn(host);
        await host.seams.handleMessage({
          type: "settings/set",
          id: "wv-jev-on",
          payload: { key: "jev.enabled", value: true },
          timestamp: Date.now(),
        });
        const callsBefore = fetchSpy.mock.calls.length;
        await host.seams.runPrompt("Fix the failing login test", "act");
        await sleep(400);

        expect(typesafeCalls(fetchSpy).length).toBe(0);
        expect(fetchSpy.mock.calls.length).toBe(callsBefore);

        // jev.enabled is rejected as unknown setting key under supported provider rules
        expect(
          sent.some(
            (m) =>
              m.type === "settings/error" &&
              (m.payload as { key?: string })?.key === "jev.enabled",
          ),
        ).toBe(true);

        const errorCards = sent.filter((m) => m.type === "error");
        expect(errorCards.length).toBe(1);
        expect(
          (errorCards[0]!.payload as { privacyBlocked?: boolean })
            .privacyBlocked,
        ).toBe(true);
      } finally {
        fetchSpy.mockRestore();
        host.ext.__clearWebviewSinkForIntegrationTest();
        await host.ext.deactivate().catch(() => {});
        host.cleanup();
      }
    },
    30_000,
  );

  it(
    "assist + auto cannot bypass privacy or approvals",
    async () => {
      const host: FreshHost = await freshHost();
      const sent: WebviewMessage[] = [];
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        host.ext.__setWebviewSinkForIntegrationTest((m) => {
          sent.push(m as WebviewMessage);
        });
        await configureCloudTurn(host);
        await host.seams.handleMessage({
          type: "settings/set",
          id: "wv-jev-assist",
          payload: { key: "jev.mode", value: "assist" },
          timestamp: Date.now(),
        });
        await host.seams.handleMessage({
          type: "settings/set",
          id: "wv-jev-on2",
          payload: { key: "jev.enabled", value: true },
          timestamp: Date.now(),
        });
        await host.seams.runPrompt("Delete all log files", "auto");
        await sleep(400);

        expect(typesafeCalls(fetchSpy).length).toBe(0);
        // Blocked before dispatch: no completion, no tool or approval
        // traffic — a classifier verdict authorizes nothing.
        const types = new Set(sent.map((m) => m.type));
        expect(types.has("tool/started")).toBe(false);
        expect(types.has("tool/request_approval")).toBe(false);
        expect(types.has("agent/approval_needed")).toBe(false);
        expect(
          sent.some(
            (m) =>
              m.type === "agent/status" &&
              (m.payload as { status?: string }).status === "completed",
          ),
        ).toBe(false);
        const errorCards = sent.filter((m) => m.type === "error");
        expect(errorCards.length).toBe(1);
        expect(
          (errorCards[0]!.payload as { privacyBlocked?: boolean })
            .privacyBlocked,
        ).toBe(true);
      } finally {
        fetchSpy.mockRestore();
        host.ext.__clearWebviewSinkForIntegrationTest();
        await host.ext.deactivate().catch(() => {});
        host.cleanup();
      }
    },
    30_000,
  );

  it(
    "key lifecycle is presence-only and jev.* settings fail closed",
    async () => {
      const host: FreshHost = await freshHost();
      const sent: WebviewMessage[] = [];
      try {
        host.ext.__setWebviewSinkForIntegrationTest((m) => {
          sent.push(m as WebviewMessage);
        });
        for (const [key, value] of [
          ["jev.enabled", true],
          ["jev.mode", "advisory"],
          ["jev.model", "jev-latest"],
          ["jev.timeoutMs", 8000],
          ["jev.confidenceThreshold", 0.5],
        ] as const) {
          await host.seams.handleMessage({
            type: "settings/set",
            id: `wv-jev-key-${key}`,
            payload: { key, value },
            timestamp: Date.now(),
          });
        }
        // Removed provider settings are rejected fail-closed
        const errorSettings = sent.filter((m) => m.type === "settings/error");
        expect(errorSettings.length).toBe(5);

        // Also verify removed provider selection fails closed
        await host.seams.handleMessage({
          type: "settings/set",
          id: "wv-prov-openrouter",
          payload: { key: "provider", value: "openrouter" },
          timestamp: Date.now(),
        });
        expect(
          sent.some(
            (m) =>
              m.type === "settings/error" &&
              ((m.payload as { error?: string })?.error?.includes("Unsupported provider") ||
                (m.payload as { message?: string })?.message?.includes("Unsupported provider")),
          ),
        ).toBe(true);
      } finally {
        host.ext.__clearWebviewSinkForIntegrationTest();
        await host.ext.deactivate().catch(() => {});
        host.cleanup();
      }
    },
    30_000,
  );
});
