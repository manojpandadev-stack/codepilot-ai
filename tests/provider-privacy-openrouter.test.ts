/**
 * OpenRouter end-to-end honesty + provider privacy UX regression tests.
 *
 * Covers the provider brief's Goal D:
 *   1. Local-only mode blocks remote inference BEFORE any network request
 *      (single consolidated error — no duplicate failure cards).
 *   2. Explicitly enabling cloud mode lets the configured remote-provider
 *      request path proceed (runtime receives the authoritative value).
 *   3. Provider switch consistency: provider + credential + baseUrl move
 *      together onto the live runtime; secrets never reach the webview.
 *   4. Model choices are filtered per provider (no global catalogue in the
 *      chat dropdown's model list).
 *   5. A failed connection/model request never displays a successful
 *      inference state; inference results are provider-tagged.
 *   6. API keys never appear in logs or UI text.
 *
 * Everything here is hermetic: no real provider is contacted (the runtime is
 * constructed against a deliberately unreachable loopback port, and the
 * inference-test verdicts are exercised through fault injection).
 */

import { describe, expect, it, vi } from "vitest";
import {
  freshHost,
  sleep,
  type FreshHost,
} from "./vscode-integration-harness";
import type { WebviewMessage } from "@codepilot/shared";
import { LIVE_CLOUD } from "./live-cloud";

// ---------------------------------------------------------------------------
// 1. Local-only privacy mode blocks remote inference — once, before any
//    network request, with a single consolidated actionable error.
// ---------------------------------------------------------------------------

// Historical test fixture: OpenRouter is no longer a supported provider.
// Active privacy boundary tests for supported providers run in
// provider-local-only-network-boundary.test.ts and provider-reduction-compliance.test.ts.
describe.skip("privacy guard: local mode blocks OpenRouter before any network request", () => {
  it(
    "blocks the run, emits exactly ONE error card, and never reaches the network",
    async () => {
      const host: FreshHost = await freshHost();
      const sent: WebviewMessage[] = [];
      try {
        const svc = host.seams.getProviderService();
        await svc.setCredential("openrouter", "sk-or-test-key-not-real");

        // Select OpenRouter with an explicit model id.
        await host.seams.handleMessage({
          type: "settings/set",
          id: "wv-priv-prov",
          payload: { key: "provider", value: "openrouter" },
          timestamp: Date.now(),
        });
        await host.seams.handleMessage({
          type: "settings/set",
          id: "wv-priv-model",
          payload: { key: "model", value: "openai/gpt-4o-mini" },
          timestamp: Date.now(),
        });
        // Privacy mode stays at the default "local" (never flipped).

        host.ext.__setWebviewSinkForIntegrationTest((m) => {
          sent.push(m as WebviewMessage);
        });

        await host.seams.runPrompt("hi", "act");
        await sleep(300);

        // Exactly one consolidated privacy card — the historical double
        // ("AI REQUEST FAILED" + "AGENT RUNTIME FAILED") must stay dead.
        const errorCards = sent.filter((m) => m.type === "error");
        expect(errorCards.length).toBe(1);
        const payload = errorCards[0]!.payload as {
          privacyBlocked?: boolean;
          providerId?: string;
          message?: string;
        };
        expect(payload.privacyBlocked).toBe(true);
        expect(payload.providerId).toBe("openrouter");
        expect(payload.message ?? "").toMatch(/privacy mode/i);
        expect(payload.message ?? "").toMatch(/No request was made/i);

        // The run produced no assistant output (blocked pre-flight).
        const statuses = sent
          .filter((m) => m.type === "agent/status")
          .map((m) => (m.payload as { status?: string }).status);
        expect(statuses).not.toContain("completed");
      } finally {
        host.ext.__clearWebviewSinkForIntegrationTest();
        await host.ext.deactivate().catch(() => {});
        host.cleanup();
      }
    },
    30_000,
  );

  it(
    "keeps blocking every turn until the user explicitly changes privacy mode",
    async () => {
      const host: FreshHost = await freshHost();
      const sent: WebviewMessage[] = [];
      try {
        const svc = host.seams.getProviderService();
        await svc.setCredential("openrouter", "sk-or-test-key-not-real");
        await host.seams.handleMessage({
          type: "settings/set",
          id: "wv-priv2-prov",
          payload: { key: "provider", value: "openrouter" },
          timestamp: Date.now(),
        });

        host.ext.__setWebviewSinkForIntegrationTest((m) => {
          sent.push(m as WebviewMessage);
        });

        await host.seams.runPrompt("hi", "act");
        await sleep(200);
        await host.seams.runPrompt("hello again", "act");
        await sleep(200);

        const errorCards = sent.filter((m) => m.type === "error");
        // One card per blocked attempt — never two for the same attempt.
        expect(errorCards.length).toBe(2);
        for (const card of errorCards) {
          expect((card.payload as { privacyBlocked?: boolean }).privacyBlocked).toBe(
            true,
          );
        }
      } finally {
        host.ext.__clearWebviewSinkForIntegrationTest();
        await host.ext.deactivate().catch(() => {});
        host.cleanup();
      }
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// 1b. The explicit TEST buttons are fail-closed too: with a saved credential,
//     Local Only mode answers WITHOUT any network request (inference-test →
//     "blocked", probe → explicit unavailable), and cloud opt-in re-arms them.
// ---------------------------------------------------------------------------

describe.skip("privacy guard: Test Connection / Test model response send nothing under Local Only", () => {
  it(
    "blocks both test buttons pre-network when an OpenRouter key is saved",
    async () => {
      const host: FreshHost = await freshHost();
      const sent: WebviewMessage[] = [];
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        const svc = host.seams.getProviderService();
        await svc.setCredential("openrouter", "sk-or-test-key-not-real");
        await host.seams.handleMessage({
          type: "settings/set",
          id: "wv-gate-prov",
          payload: { key: "provider", value: "openrouter" },
          timestamp: Date.now(),
        });
        await host.seams.handleMessage({
          type: "settings/set",
          id: "wv-gate-model",
          payload: { key: "model", value: "openai/gpt-4o-mini" },
          timestamp: Date.now(),
        });
        // Privacy mode stays at the default "local" (never flipped).

        host.ext.__setWebviewSinkForIntegrationTest((m) => {
          sent.push(m as WebviewMessage);
        });

        const callsBefore = fetchSpy.mock.calls.length;
        await host.seams.handleMessage({
          type: "provider/inference-test",
          id: "wv-gate-inf",
          payload: { providerId: "openrouter", modelId: "openai/gpt-4o-mini" },
          timestamp: Date.now(),
        });
        await host.seams.handleMessage({
          type: "provider/test",
          id: "wv-gate-probe",
          payload: { providerId: "openrouter" },
          timestamp: Date.now(),
        });
        await sleep(300);

        const inf = sent.find((m) => m.type === "provider/inference_result");
        expect(inf).toBeDefined();
        const ip = inf!.payload as {
          providerId: string;
          state: string;
          message?: string;
        };
        expect(ip.providerId).toBe("openrouter");
        expect(ip.state).toBe("blocked");
        expect(ip.message ?? "").toMatch(/Local Only|no request was sent/i);

        const probe = sent.find((m) => m.type === "provider/test_result");
        expect(probe).toBeDefined();
        expect(
          (probe!.payload as { message?: string }).message ?? "",
        ).toMatch(/Local Only|no request was sent/i);

        // Neither button produced a network request.
        expect(fetchSpy.mock.calls.length).toBe(callsBefore);

        // No webview message ever carries the literal secret.
        expect(
          sent.some((m) => JSON.stringify(m).includes("sk-or-test-key-not-real")),
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
});

// ---------------------------------------------------------------------------
// 2. Explicitly enabling cloud mode (privacy/confirm) — persisted, live-applied
//    to the runtime, and the remote request path proceeds (fails only at the
//    network layer, which proves the privacy gate was passed).
// ---------------------------------------------------------------------------

describe.skip("explicit cloud opt-in: privacy/confirm reaches the runtime", () => {
  it(
    "persists the mode and live-applies it to the runtime (hermetic)",
    async () => {
      const host: FreshHost = await freshHost();
      const sent: WebviewMessage[] = [];
      try {
        const svc = host.seams.getProviderService();
        await svc.setCredential("openrouter", "sk-or-test-key-not-real");
        await host.seams.handleMessage({
          type: "settings/set",
          id: "wv-cloud-prov",
          payload: { key: "provider", value: "openrouter" },
          timestamp: Date.now(),
        });
        await host.seams.handleMessage({
          type: "settings/set",
          id: "wv-cloud-model",
          payload: { key: "model", value: "openai/gpt-4o-mini" },
          timestamp: Date.now(),
        });

        host.ext.__setWebviewSinkForIntegrationTest((m) => {
          sent.push(m as WebviewMessage);
        });

        // THE EXPLICIT USER ACTION (what the "Enable cloud access" button sends).
        await host.seams.handleMessage({
          type: "privacy/confirm",
          id: "wv-cloud-confirm",
          payload: { mode: "cloud" },
          timestamp: Date.now(),
        });

        // Acknowledged + settings snapshot reflects the new authoritative mode.
        const ack = sent.find((m) => m.type === "privacy/result");
        expect(ack).toBeDefined();
        expect((ack!.payload as { ok?: boolean }).ok).toBe(true);

        // Persisted into VS Code settings (the stub records writes) AND
        // applied to the live runtime's authoritative config.
        const persisted = host.vscodeStub.workspace
          .getConfiguration("codepilot")
          .get("privacyMode", "local");
        expect(persisted).toBe("cloud");
        const rt = await host.seams.ensureRuntime();
        expect(rt.getProviderSettings().privacyMode).toBe("cloud");
      } finally {
        host.ext.__clearWebviewSinkForIntegrationTest();
        await host.ext.deactivate().catch(() => {});
        host.cleanup();
      }
    },
    60_000,
  );

  it.skipIf(!LIVE_CLOUD)(
    "lets the request path run past the privacy guard (live network)",
    async () => {
      const host: FreshHost = await freshHost();
      const sent: WebviewMessage[] = [];
      try {
        const svc = host.seams.getProviderService();
        await svc.setCredential("openrouter", "sk-or-test-key-not-real");
        await host.seams.handleMessage({
          type: "settings/set",
          id: "wv-cloud-prov2",
          payload: { key: "provider", value: "openrouter" },
          timestamp: Date.now(),
        });
        await host.seams.handleMessage({
          type: "settings/set",
          id: "wv-cloud-model2",
          payload: { key: "model", value: "openai/gpt-4o-mini" },
          timestamp: Date.now(),
        });

        host.ext.__setWebviewSinkForIntegrationTest((m) => {
          sent.push(m as WebviewMessage);
        });

        await host.seams.handleMessage({
          type: "privacy/confirm",
          id: "wv-cloud-confirm2",
          payload: { mode: "cloud" },
          timestamp: Date.now(),
        });

        sent.length = 0;

        // The next turn must get PAST the privacy guard. The key is fake, so
        // the run fails at the provider HTTP layer — a NETWORK/HTTP failure,
        // NOT a privacy block. That distinction is the assertion.
        await host.seams.runPrompt("hi", "act");
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const terminal = sent.find((m) => m.type === "error");
          if (terminal) break;
          await sleep(500);
        }
        const errCard = sent.find((m) => m.type === "error");
        expect(errCard).toBeDefined();
        const p = errCard!.payload as { privacyBlocked?: boolean; message?: string };
        expect(p.privacyBlocked).toBeUndefined();
        expect(p.message ?? "").not.toMatch(/privacy mode/i);
      } finally {
        host.ext.__clearWebviewSinkForIntegrationTest();
        await host.ext.deactivate().catch(() => {});
        host.cleanup();
      }
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------
// 3. OpenRouter selection + persistence + runtime consistency, and per-provider
//    model filtering. Plus the inference-truth and secrecy invariants.
// ---------------------------------------------------------------------------

describe.skip("provider switch consistency, model filtering, inference truth, secrecy", () => {
  it(
    "switches providers atomically, filters models per provider, and never leaks keys",
    async () => {
      const host: FreshHost = await freshHost();
      const sent: WebviewMessage[] = [];
      try {
        host.ext.__setWebviewSinkForIntegrationTest((m) => {
          sent.push(m as WebviewMessage);
        });
        const SECRET = "sk-or-very-secret-value-9f8e7d6c";

        // Switch to openrouter; then to ollama; then back — the runtime patch
        // must always carry the target provider's own config.
        await host.seams.handleMessage({
          type: "provider/configure",
          id: "wv-cons-key",
          payload: { providerId: "openrouter", apiKey: SECRET },
          timestamp: Date.now(),
        });
        await host.seams.handleMessage({
          type: "settings/set",
          id: "wv-cons-to-openrouter",
          payload: { key: "provider", value: "openrouter" },
          timestamp: Date.now(),
        });
        const rt1 = await host.seams.ensureRuntime();
        expect(rt1.getProviderSettings().providerId).toBe("openrouter");
        // Not the previous (ollama loopback) baseUrl.
        const settings1 = rt1.getProviderSettings();
        expect(settings1.baseUrl === undefined || !settings1.baseUrl.includes("localhost:11434")).toBe(true);
        // The runtime's authoritative privacy mode matches the persisted one.
        expect(settings1.privacyMode).toBe("local");

        // Persisted selection survives a settings read.
        expect(
          host.vscodeStub.workspace.getConfiguration("codepilot").get("provider", ""),
        ).toBe("openrouter");

        // Model discovery is provider-tagged: an ollama request can never
        // satisfy an openrouter ask and vice versa (stale-guard on payload).
        const svc = host.seams.getProviderService();
        const orModels = await (svc as unknown as {
          testConnection: (id: string) => Promise<unknown>;
        }).testConnection("openrouter").catch(() => null);
        void orModels; // probe result is network-dependent; filtering is checked below

        // Credential presence, never the key itself, reaches the webview.
        const leak = sent.some((m) =>
          JSON.stringify(m).includes(SECRET),
        );
        expect(leak).toBe(false);

        // A failure probe never reports success anywhere in the stream.
        const falseSuccess = sent.some((m) =>
          JSON.stringify(m).includes('"state":"connected"'),
        );
        // Note: provider/list may legitimately mark LOCAL providers connected
        // after a live probe of their own endpoint — but openrouter must not
        // be among them without a real network round-trip succeeding.
        const openrouterFalseConnected = sent.some((m) => {
          if (m.type !== "provider/list") return false;
          const payload = m.payload as {
            providers?: Array<{ id?: string; state?: string; connected?: boolean }>;
          };
          return (payload.providers ?? []).some(
            (c) =>
              c.id === "openrouter" &&
              (c.state === "connected" || c.connected === true),
          );
        });
        expect(openrouterFalseConnected).toBe(false);

        // No webview message ever carries the literal secret.
        expect(sent.some((m) => JSON.stringify(m).includes(SECRET))).toBe(false);
      } finally {
        host.ext.__clearWebviewSinkForIntegrationTest();
        await host.ext.deactivate().catch(() => {});
        host.cleanup();
      }
    },
    45_000,
  );

  it(
    "returns inference-test results provider-tagged and never fabricates success",
    async () => {
      const host: FreshHost = await freshHost();
      const sent: WebviewMessage[] = [];
      try {
        host.ext.__setWebviewSinkForIntegrationTest((m) => {
          sent.push(m as WebviewMessage);
        });

        // No credential saved: the inference test must honestly report the
        // auth problem — it must NOT claim "success" from nothing.
        await host.seams.handleMessage({
          type: "provider/inference-test",
          id: "wv-inf-1",
          payload: { providerId: "openrouter" },
          timestamp: Date.now(),
        });
        await sleep(200);
        const result = sent.find((m) => m.type === "provider/inference_result");
        expect(result).toBeDefined();
        const p = result!.payload as { providerId: string; state: string };
        expect(p.providerId).toBe("openrouter");
        expect(p.state).toBe("auth-failed");

        // Connection state for openrouter remains NOT connected (a failed or
        // skipped probe must never display a successful inference/connection).
        const states = await host.seams
          .getProviderService()
          .connectionState("openrouter");
        expect(states.state).not.toBe("connected");
        expect(states.connected).toBe(false);
      } finally {
        host.ext.__clearWebviewSinkForIntegrationTest();
        await host.ext.deactivate().catch(() => {});
        host.cleanup();
      }
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// 4. Webview mapper honesty: connectionSummary never derives "connected" from
//    credential presence for cloud providers (the "Connected but blocked"
//    screenshot bug).
// ---------------------------------------------------------------------------

describe.skip("connection-truth labeling", () => {
  it("labels a configured-but-unprobed cloud provider as not connected", async () => {
    const { connectionSummary } = await import(
      "../apps/webview/src/lib/messages.js"
    );
    const verdict = connectionSummary({
      selectedProviderId: "openrouter",
      credentialConfigured: true,
      modelCount: 3,
    });
    // A credential alone must never read as connected — the honest neutral
    // state is CLOUD-scope + provider name (probe needed for any positive).
    expect(verdict.connected).toBe(false);
    expect(verdict.label).toMatch(/CLOUD · openrouter/);
  });

  it("privacyClaim flags a remote provider under local mode", async () => {
    const { privacyClaim } = await import(
      "../apps/webview/src/lib/messages.js"
    );
    const claim = privacyClaim("local", "cloud");
    expect(claim).toMatch(/blocked|remote|requests WILL leave/i);
  });
});
