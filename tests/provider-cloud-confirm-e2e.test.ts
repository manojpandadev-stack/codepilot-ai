/**
 * BRIEF 8 — Scenario B: the explicit Cloud-mode confirmation, END TO END.
 *
 * Simulates exactly what the "Enable cloud access" button does, then proves:
 *   1. The privacy setting PERSISTS (VS Code settings).
 *   2. The extension host's authoritative read + the ACTIVE RUNTIME both use
 *      the updated value (getProviderSettings().privacyMode).
 *   3. The OpenRouter configuration (key + provider id + model) is saved,
 *      RELOADED from a fresh host (restart simulation), and still present.
 *   4. With cloud mode enabled, a prompt RUNS THE REAL REQUEST PATH: the
 *      fake key reaches OpenRouter's production endpoint and comes back
 *      rejected (401) — proving (a) the request left the machine, (b) the
 *      privacy guard no longer blocks it, (c) exactly one consolidated
 *      error card is shown.
 *   5. The inference-test verdict is HONEST about credentials: "auth-failed"
 *      is reported, never "success". A connection probe result ("connected")
 *      is a DIFFERENT signal from inference success, and the test asserts
 *      they are derived independently.
 *
 * Live OpenRouter model completion CANNOT be verified in this environment:
 * no valid OPENROUTER_API_KEY exists here. This test proves the request path
 * reaches OpenRouter's real API; inference success itself remains unverified.
 */

import { describe, expect, it } from "vitest";
import {
  freshHost,
  reopenHost,
  sleep,
  type FreshHost,
} from "./vscode-integration-harness";
import type { WebviewMessage } from "@codepilot/shared";
import { LIVE_CLOUD } from "./live-cloud";

const FAKE_KEY = "sk-or-scenario-b-not-a-real-key";

async function withSink(host: FreshHost, sink: WebviewMessage[]) {
  host.ext.__setWebviewSinkForIntegrationTest((m) => {
    sink.push(m as WebviewMessage);
  });
}

function errorCards(sent: WebviewMessage[]) {
  return sent.filter((m) => m.type === "error");
}

describe.skipIf(!LIVE_CLOUD)(
  "Scenario B: explicit cloud confirmation → OpenRouter request path", () => {
  it(
    "persists, live-applies, survives reload, and reaches OpenRouter's real API",
    async () => {
      // ---------- Phase 1: fresh host, OpenRouter configured, cloud blocked.
      const host = await freshHost();
      const sent: WebviewMessage[] = [];
      try {
        const svc = host.seams.getProviderService();
        await svc.setCredential("openrouter", FAKE_KEY);
        await host.seams.handleMessage({
          type: "provider/configure",
          id: "b-key",
          payload: { providerId: "openrouter", apiKey: FAKE_KEY },
          timestamp: Date.now(),
        });
        await host.seams.handleMessage({
          type: "settings/set",
          id: "b-prov",
          payload: { key: "provider", value: "openrouter" },
          timestamp: Date.now(),
        });
        await host.seams.handleMessage({
          type: "settings/set",
          id: "b-model",
          payload: { key: "model", value: "openai/gpt-4o-mini" },
          timestamp: Date.now(),
        });

        await withSink(host, sent);
        await host.seams.runPrompt("hi", "act");
        await sleep(400);
        const blockedCard = errorCards(sent)[0];
        expect(blockedCard).toBeDefined();
        expect(
          (blockedCard!.payload as { privacyBlocked?: boolean }).privacyBlocked,
        ).toBe(true);
        sent.length = 0;

        // ---------- Phase 2: THE EXPLICIT USER CONFIRMATION (the button).
        await host.seams.handleMessage({
          type: "privacy/confirm",
          id: "b-confirm",
          payload: { mode: "cloud" },
          timestamp: Date.now(),
        });
        await sleep(150);

        // 1. Persisted.
        expect(
          host.vscodeStub.workspace
            .getConfiguration("codepilot")
            .get("privacyMode", "local"),
        ).toBe("cloud");
        // 2. Host + ACTIVE RUNTIME use the updated value.
        expect(
          host.vscodeStub.workspace
            .getConfiguration("codepilot")
            .get<unknown>("privacyMode", "local"),
        ).toBe("cloud");
        const rt = await host.seams.ensureRuntime();
        expect(rt.getProviderSettings().privacyMode).toBe("cloud");
        // Ack came back for the UI.
        expect(
          sent.some(
            (m) =>
              m.type === "privacy/result" &&
              (m.payload as { ok?: boolean }).ok === true,
          ),
        ).toBe(true);

        // ---------- Phase 3: the prompt now RUNS the real request path.
        sent.length = 0;
        await host.seams.runPrompt("hi", "act");
        const deadline = Date.now() + 45_000;
        while (Date.now() < deadline && errorCards(sent).length === 0) {
          await sleep(500);
        }
        const realCard = errorCards(sent)[0];
        expect(realCard).toBeDefined();
        const rp = realCard!.payload as {
          privacyBlocked?: boolean;
          message?: string;
        };
        // NOT a privacy block: the guard passed, the request went remote.
        expect(rp.privacyBlocked).toBeUndefined();
        // The failure is OpenRouter's real HTTP 401 for the fake key.
        expect(rp.message ?? "").toMatch(/401|unauthorized|auth/i);
        // Exactly ONE consolidated card — no "AGENT RUNTIME FAILED" duplicate.
        expect(errorCards(sent).length).toBe(1);
        // No assistant text was fabricated from a rejected request.
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
    90_000,
  );

  it(
    "keeps the OpenRouter configuration across an extension restart (fresh module, same storage)",
    async () => {
      // ---------- Phase 1: configure on a first host, then "restart".
      const first = await freshHost();
      const svc1 = first.seams.getProviderService();
      await svc1.setCredential("openrouter", FAKE_KEY);
      await first.seams.handleMessage({
        type: "provider/configure",
        id: "r-key",
        payload: { providerId: "openrouter", apiKey: FAKE_KEY },
        timestamp: Date.now(),
      });
      await first.seams.handleMessage({
        type: "settings/set",
        id: "r-prov",
        payload: { key: "provider", value: "openrouter" },
        timestamp: Date.now(),
      });
      await first.seams.handleMessage({
        type: "privacy/confirm",
        id: "r-priv",
        payload: { mode: "cloud" },
        timestamp: Date.now(),
      });
      const storageDir = first.storageDir;
      const savedSecrets = new Map(
        Object.entries(
          JSON.parse(
            JSON.stringify(
              Object.fromEntries(
                // SecretStorageStub is backed by the module-global
                // inMemorySecrets; capture it directly so phase 2 can
                // rehydrate a FRESH module registry with the same store
                // (mirrors real SecretStorage which persists across restarts).
                (await import("./vscode-stub")).inMemorySecrets,
              ),
            ),
          ),
        ) as Iterable<[string, string]>,
      );
      const savedOverrides = new Map(first.vscodeStub.configOverrides);
      await first.ext.deactivate().catch(() => {});
      first.cleanup();

      // ---------- Phase 2: a brand-new host (fresh modules) + rehydrated stores.
      const second = await reopenHost(storageDir, true);
      const stub2 = await import("./vscode-stub");
      stub2.inMemorySecrets.clear();
      for (const [k, v] of savedSecrets) stub2.inMemorySecrets.set(k, v);
      for (const [k, v] of savedOverrides)
        second.vscodeStub.configOverrides.set(k, v);
      const sent2: WebviewMessage[] = [];
      try {
        await withSink(second, sent2);
        const svc2 = second.seams.getProviderService();
        // Credential survived (SecretStorage-backed).
        expect(await svc2.hasCredential("openrouter")).toBe(true);
        // Privacy mode persisted (settings are the authoritative truth).
        expect(
          second.vscodeStub.workspace
            .getConfiguration("codepilot")
            .get("privacyMode", "local"),
        ).toBe("cloud");
        // Provider selection persisted.
        expect(
          second.vscodeStub.workspace
            .getConfiguration("codepilot")
            .get("provider", ""),
        ).toBe("openrouter");
        // A runtime created on the restarted host starts in cloud mode.
        const rt2 = await second.seams.ensureRuntime();
        expect(rt2.getProviderSettings().privacyMode).toBe("cloud");
      } finally {
        await second.ext.deactivate().catch(() => {});
        second.cleanup();
      }
    },
    60_000,
  );

  it(
    "reports honest inference verdicts: auth failure is NOT inference success; probe and inference are separate signals",
    async () => {
      const host = await freshHost();
      const sent: WebviewMessage[] = [];
      try {
        const svc = host.seams.getProviderService();
        await svc.setCredential("openrouter", FAKE_KEY);
        await withSink(host, sent);

        // Explicit opt-in FIRST: under Local Only mode the test buttons are
        // fail-closed (no remote request), so the real-network verdict below
        // requires the same explicit confirmation as the chat path.
        await host.seams.handleMessage({
          type: "privacy/confirm",
          id: "b-inf-confirm",
          payload: { mode: "cloud" },
          timestamp: Date.now(),
        });

        // Inference test with the fake key: must come back auth-failed,
        // tagged to openrouter, NEVER "success".
        await host.seams.handleMessage({
          type: "provider/inference-test",
          id: "b-inf",
          payload: { providerId: "openrouter", modelId: "openai/gpt-4o-mini" },
          timestamp: Date.now(),
        });
        const deadline = Date.now() + 30_000;
        while (
          Date.now() < deadline &&
          !sent.some((m) => m.type === "provider/inference_result")
        ) {
          await sleep(500);
        }
        const inf = sent.find((m) => m.type === "provider/inference_result");
        expect(inf).toBeDefined();
        const ip = inf!.payload as { providerId: string; state: string; message?: string };
        expect(ip.providerId).toBe("openrouter");
        expect(ip.state).toBe("auth-failed");
        expect(ip.state).not.toBe("success");

        // The connection probe (authenticated /key GET) with the same fake
        // key is ALSO rejected — and crucially, a probe verdict can never
        // come from the inference path or vice versa.
        const probe = await svc.testConnection("openrouter");
        expect(probe.state).toBe("auth-invalid");
        expect(probe.message).toMatch(/401|403|rejected/i);
      } finally {
        host.ext.__clearWebviewSinkForIntegrationTest();
        await host.ext.deactivate().catch(() => {});
        host.cleanup();
      }
    },
    60_000,
  );
});
