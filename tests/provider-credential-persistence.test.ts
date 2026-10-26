/**
 * Credential persistence regression tests.
 *
 * Locks in the API-key lifecycle contract:
 *  1. A saved key survives provider-service reinitialization.
 *  2. A saved key survives extension reload/restart (activation rehydration).
 *  3. Failed requests (HTTP 400/401/403/429/500/503, network failure)
 *     PRESERVE the key — persistence is store-first, probes are reporting-only.
 *  4. Switching models or providers never erases any provider's saved key.
 *  5. Empty or masked UI values never overwrite a saved key.
 *  6. Explicit user removal (clearApiKey) deletes ONLY the selected provider.
 *  7. No key value appears in logs, error payloads, or webview messages.
 *
 * Also covers the two "forgets my key" regressions fixed in
 * `provider/configure`:
 *  - Connect with an empty field while a key IS saved must not throw
 *    "Gemini API key is required." (the saved key is used for the re-probe).
 *  - A mask-style value ("••••…") must never be persisted over the saved key.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderService } from "../apps/vscode-extension/src/provider-service";
import { inMemorySecrets, inMemoryState, context } from "./vscode-stub";
import {
  freshHost,
  reopenHost,
  sleep,
  type FreshHost,
} from "./vscode-integration-harness";
import type { WebviewMessage } from "@codepilot/shared";
import * as fs from "node:fs";
import * as path from "node:path";

const GEMINI_KEY = "AIzaSyPersistenceTestKeyDoNotLog123";
const OPENAI_KEY = "sk-persistence-test-openai-456";
const MASK = "••••••••••••••••";

function makeService(): ProviderService {
  // Direct construction defaults privacyMode to "cloud" (unit-harness
  // default) so real probe classification is exercised without a host.
  return new ProviderService(
    context as unknown as ConstructorParameters<typeof ProviderService>[0],
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
  });
}

beforeEach(() => {
  inMemoryState.clear();
  inMemorySecrets.clear();
  vi.unstubAllGlobals();
});

// ============================================================================
// Part A — ProviderService-level persistence contract
// ============================================================================

describe("credential persistence — ProviderService lifecycle", () => {
  it("1. a saved key survives provider-service reinitialization", async () => {
    const first = makeService();
    await first.setCredential("gemini", GEMINI_KEY);

    // A brand-new service instance over the same SecretStorage (what
    // reinitialization / lazy re-creation does) resolves the same key.
    const second = makeService();
    expect(await second.getCredential("gemini")).toBe(GEMINI_KEY);
    expect(await second.hasCredential("gemini")).toBe(true);
  });

  it("3. probe failures with HTTP 400/401/403/429/500/503 preserve the saved key", async () => {
    for (const status of [400, 401, 403, 429, 500, 503]) {
      inMemorySecrets.clear();
      const svc = makeService();
      await svc.setCredential("gemini", GEMINI_KEY);

      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse({ error: { message: `synthetic ${status}` } }, status),
        ) as unknown as typeof fetch,
      );

      const health = await svc.testConnection("gemini");
      expect(health.state).not.toBe("connected");
      // The key is untouched by a failed probe.
      expect(inMemorySecrets.get("codepilot.apiKey.gemini")).toBe(GEMINI_KEY);
      expect(await svc.getCredential("gemini")).toBe(GEMINI_KEY);
      // The verdict never carries key material.
      expect(JSON.stringify(health)).not.toContain(GEMINI_KEY);
      vi.unstubAllGlobals();
    }
  });

  it("3b. a network failure (fetch rejection) preserves the saved key", async () => {
    const svc = makeService();
    await svc.setCredential("gemini", GEMINI_KEY);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED synthetic");
      }) as unknown as typeof fetch,
    );

    const health = await svc.testConnection("gemini");
    expect(health.state).not.toBe("connected");
    expect(inMemorySecrets.get("codepilot.apiKey.gemini")).toBe(GEMINI_KEY);
  });

  it("5. empty values never overwrite a saved key (setCredential ignores empty)", async () => {
    const svc = makeService();
    await svc.setCredential("gemini", GEMINI_KEY);

    await svc.setCredential("gemini", "");
    await svc.setCredential("gemini", "   ");
    // Whitespace/empty input is a no-op — the saved key remains authoritative.
    expect(await svc.getCredential("gemini")).toBe(GEMINI_KEY);
  });

  it("6. explicit removal deletes only the selected provider's key", async () => {
    const svc = makeService();
    await svc.setCredential("gemini", GEMINI_KEY);
    await svc.setCredential("openai-native", OPENAI_KEY);

    await svc.clearCredential("gemini");

    expect(await svc.hasCredential("gemini")).toBe(false);
    expect(await svc.getCredential("gemini")).toBeUndefined();
    // The other provider's key is untouched.
    expect(await svc.getCredential("openai-native")).toBe(OPENAI_KEY);
  });

  it("7. health results never contain the key", async () => {
    const svc = makeService();
    await svc.setCredential("gemini", GEMINI_KEY);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { message: "bad key" } }, 401)) as unknown as typeof fetch,
    );

    const health = await svc.testConnection("gemini");
    expect(JSON.stringify(health)).not.toContain(GEMINI_KEY);
    expect(health.message).not.toContain(GEMINI_KEY);
  });
});

// ============================================================================
// Part B — host-level lifecycle (real activation + provider/configure handler)
// ============================================================================

async function withSink(host: FreshHost, sink: WebviewMessage[]) {
  host.ext.__setWebviewSinkForIntegrationTest((m) => {
    sink.push(m as WebviewMessage);
  });
}

/** The last webview message of a given type (each configure ends with status). */
function lastOfType(
  sent: WebviewMessage[],
  type: string,
): WebviewMessage | undefined {
  return [...sent].reverse().find((m) => m.type === type);
}

describe("credential persistence — extension host lifecycle", () => {
  it("2. saved keys survive an extension reload (fresh module, rehydrated SecretStorage)", async () => {
    // ---------- Phase 1: configure on a first host, then "restart".
    const first = await freshHost();
    const svc1 = first.seams.getProviderService();
    await svc1.setCredential("gemini", GEMINI_KEY);
    await svc1.setCredential("openai-native", OPENAI_KEY);
    const storageDir = first.storageDir;
    // SecretStorageStub is backed by the module-global inMemorySecrets;
    // capture it directly so phase 2 can rehydrate a FRESH module registry
    // with the same store (mirrors real SecretStorage across restarts).
    const savedSecrets = new Map(
      Object.entries(
        JSON.parse(
          JSON.stringify(
            Object.fromEntries(
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
    try {
      const svc2 = second.seams.getProviderService();
      expect(await svc2.hasCredential("gemini")).toBe(true);
      expect(await svc2.getCredential("gemini")).toBe(GEMINI_KEY);
      expect(await svc2.getCredential("openai-native")).toBe(OPENAI_KEY);
    } finally {
      await second.ext.deactivate().catch(() => {});
      second.cleanup();
    }
  }, 60_000);

  it("3. provider/configure stores the key BEFORE the probe; every HTTP failure preserves it", async () => {
    const host = await freshHost();
    const sent: WebviewMessage[] = [];
    try {
      await withSink(host, sent);
      // Probes must be allowed to hit (mocked) fetch — Local Only would
      // policy-block them before the network layer.
      await host.seams.handleMessage({
        type: "privacy/confirm",
        id: "p-cloud",
        payload: { mode: "cloud" },
        timestamp: Date.now(),
      });
      const svc = host.seams.getProviderService();
      for (const status of [400, 401, 403, 429, 500, 503]) {
        const fetchMock = vi.fn(async () =>
          jsonResponse({ error: { message: `synthetic ${status}` } }, status),
        );
        vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
        await host.seams.handleMessage({
          type: "provider/configure",
          id: `cfg-${status}`,
          payload: { providerId: "gemini", apiKey: GEMINI_KEY },
          timestamp: Date.now(),
        });
        // The probe really ran…
        expect(fetchMock).toHaveBeenCalled();
        // …and the key was persisted BEFORE it, so the failure cannot
        // discard it (the historical bug deleted/never stored on failure).
        expect(await svc.getCredential("gemini")).toBe(GEMINI_KEY);
        expect(await svc.hasCredential("gemini")).toBe(true);
        // The reported verdict is failure — never "connected".
        const results = sent.filter((m) => m.type === "provider/test_result");
        expect(results.length).toBeGreaterThan(0);
        const lastResult = results.at(-1)!.payload as { state?: string };
        expect(lastResult.state).not.toBe("connected");
        // The authoritative status still reports the credential as configured.
        const lastStatus = lastOfType(sent, "provider/status")!
          .payload as { status?: { credentialConfigured?: boolean } };
        expect(lastStatus.status?.credentialConfigured).toBe(true);
        vi.unstubAllGlobals();
      }
      // No webview message ever carries the key value.
      expect(JSON.stringify(sent)).not.toContain(GEMINI_KEY);
    } finally {
      vi.unstubAllGlobals();
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate().catch(() => {});
      host.cleanup();
    }
  }, 60_000);

  it("4. switching providers and models never erases any saved key", async () => {
    const host = await freshHost();
    const sent: WebviewMessage[] = [];
    try {
      await withSink(host, sent);
      const svc = host.seams.getProviderService();
      await svc.setCredential("gemini", GEMINI_KEY);
      await svc.setCredential("openai-native", OPENAI_KEY);
      // Switch the selection through BOTH host paths: settings/set (Settings
      // UI) and provider/configure with a modelId (provider picker).
      await host.seams.handleMessage({
        type: "settings/set",
        id: "sw-1",
        payload: { key: "provider", value: "ollama" },
        timestamp: Date.now(),
      });
      await host.seams.handleMessage({
        type: "settings/set",
        id: "sw-2",
        payload: { key: "model", value: "qwen3:8b" },
        timestamp: Date.now(),
      });
      await host.seams.handleMessage({
        type: "provider/configure",
        id: "sw-3",
        payload: { providerId: "openai-native", modelId: "gpt-4o-mini" },
        timestamp: Date.now(),
      });
      await host.seams.handleMessage({
        type: "settings/set",
        id: "sw-4",
        payload: { key: "provider", value: "gemini" },
        timestamp: Date.now(),
      });
      await host.seams.handleMessage({
        type: "settings/set",
        id: "sw-5",
        payload: { key: "model", value: "gemini-2.5-flash" },
        timestamp: Date.now(),
      });
      // Both credentials survive every switch.
      expect(await svc.getCredential("gemini")).toBe(GEMINI_KEY);
      expect(await svc.getCredential("openai-native")).toBe(OPENAI_KEY);
      expect(JSON.stringify(sent)).not.toContain(GEMINI_KEY);
      expect(JSON.stringify(sent)).not.toContain(OPENAI_KEY);
    } finally {
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate().catch(() => {});
      host.cleanup();
    }
  }, 30_000);

  it("5. empty or masked UI values never overwrite a saved key (provider/configure)", async () => {
    const host = await freshHost();
    const sent: WebviewMessage[] = [];
    try {
      await withSink(host, sent);
      const svc = host.seams.getProviderService();
      // Save a key once. The default Local Only policy blocks the inline
      // probe BEFORE any network I/O, so no fetch stub is needed — the key
      // is persisted regardless of the probe verdict.
      await host.seams.handleMessage({
        type: "provider/configure",
        id: "c-save",
        payload: { providerId: "gemini", apiKey: GEMINI_KEY },
        timestamp: Date.now(),
      });
      expect(await svc.getCredential("gemini")).toBe(GEMINI_KEY);

      // A mask-style value (the UI's configured placeholder) is treated as
      // absent — it can never be persisted over the real key.
      await host.seams.handleMessage({
        type: "provider/configure",
        id: "c-mask",
        payload: { providerId: "gemini", apiKey: MASK },
        timestamp: Date.now(),
      });
      expect(await svc.getCredential("gemini")).toBe(GEMINI_KEY);

      // An empty string is ignored end-to-end.
      await host.seams.handleMessage({
        type: "provider/configure",
        id: "c-empty",
        payload: { providerId: "gemini", apiKey: "" },
        timestamp: Date.now(),
      });
      expect(await svc.getCredential("gemini")).toBe(GEMINI_KEY);

      // The mask itself was never echoed back to the webview either.
      expect(JSON.stringify(sent)).not.toContain(MASK);
    } finally {
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate().catch(() => {});
      host.cleanup();
    }
  }, 30_000);

  it("guard regression: Connect with an empty field while a key is saved does NOT throw", async () => {
    const host = await freshHost();
    const sent: WebviewMessage[] = [];
    try {
      await withSink(host, sent);
      const svc = host.seams.getProviderService();
      await svc.setCredential("gemini", GEMINI_KEY);
      // The configured provider's Connect button re-sends WITHOUT the key
      // (the real key never round-trips to the webview). This used to throw
      // "Gemini API key is required." and surface a scary error even though
      // the key was still in SecretStorage.
      await host.seams.handleMessage({
        type: "provider/configure",
        id: "guard-empty",
        payload: { providerId: "gemini", modelId: "gemini-2.5-flash" },
        timestamp: Date.now(),
      });
      // No error surfaced to the webview.
      const errors = sent.filter(
        (m) => typeof (m.payload as { error?: unknown }).error === "string",
      );
      expect(errors).toHaveLength(0);
      // The authoritative status reports the credential as configured.
      const lastStatus = lastOfType(sent, "provider/status")!
        .payload as { status?: { credentialConfigured?: boolean } };
      expect(lastStatus.status?.credentialConfigured).toBe(true);
      // The key is untouched.
      expect(await svc.getCredential("gemini")).toBe(GEMINI_KEY);
      expect(JSON.stringify(sent)).not.toContain(GEMINI_KEY);
    } finally {
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate().catch(() => {});
      host.cleanup();
    }
  }, 30_000);

  it("6. explicit clearApiKey deletes ONLY the selected provider's key", async () => {
    const host = await freshHost();
    const sent: WebviewMessage[] = [];
    try {
      await withSink(host, sent);
      const svc = host.seams.getProviderService();
      await svc.setCredential("gemini", GEMINI_KEY);
      await svc.setCredential("openai-native", OPENAI_KEY);
      // The Clear button's confirmed action — the ONLY host path that
      // removes a credential.
      await host.seams.handleMessage({
        type: "provider/configure",
        id: "clear-gemini",
        payload: { providerId: "gemini", clearApiKey: true },
        timestamp: Date.now(),
      });
      expect(await svc.hasCredential("gemini")).toBe(false);
      expect(await svc.getCredential("gemini")).toBeUndefined();
      // The other provider's key is untouched.
      expect(await svc.getCredential("openai-native")).toBe(OPENAI_KEY);
      // The final status reports the cleared provider as not configured.
      const lastStatus = lastOfType(sent, "provider/status")!
        .payload as {
        status?: { providerId?: string; credentialConfigured?: boolean };
      };
      expect(lastStatus.status?.providerId).toBe("gemini");
      expect(lastStatus.status?.credentialConfigured).toBe(false);
      // The clear flow never echoes any key material.
      expect(JSON.stringify(sent)).not.toContain(GEMINI_KEY);
      expect(JSON.stringify(sent)).not.toContain(OPENAI_KEY);
    } finally {
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate().catch(() => {});
      host.cleanup();
    }
  }, 30_000);

  it("7. no key value reaches output-channel logs or webview messages", async () => {
    const host = await freshHost();
    const sent: WebviewMessage[] = [];
    try {
      await withSink(host, sent);
      await host.seams.handleMessage({
        type: "privacy/confirm",
        id: "l-cloud",
        payload: { mode: "cloud" },
        timestamp: Date.now(),
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse({ error: { message: "nope" } }, 401),
        ) as unknown as typeof fetch,
      );
      // Save (probe fails), save a second provider, then explicitly clear.
      await host.seams.handleMessage({
        type: "provider/configure",
        id: "l-save",
        payload: { providerId: "gemini", apiKey: GEMINI_KEY },
        timestamp: Date.now(),
      });
      await host.seams.handleMessage({
        type: "provider/configure",
        id: "l-openai",
        payload: { providerId: "openai-native", apiKey: OPENAI_KEY },
        timestamp: Date.now(),
      });
      await host.seams.handleMessage({
        type: "provider/configure",
        id: "l-clear",
        payload: { providerId: "gemini", clearApiKey: true },
        timestamp: Date.now(),
      });

      // Positive control: the log DOES record the store action…
      const texts = (await import("./vscode-stub")).outputChannelLines
        .map((l) => l.text)
        .join("\n");
      expect(texts).toContain("Stored credential");
      // …but never the credential itself.
      expect(texts).not.toContain(GEMINI_KEY);
      expect(texts).not.toContain(OPENAI_KEY);
      // No webview message ever carries a key.
      expect(JSON.stringify(sent)).not.toContain(GEMINI_KEY);
      expect(JSON.stringify(sent)).not.toContain(OPENAI_KEY);
    } finally {
      vi.unstubAllGlobals();
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate().catch(() => {});
      host.cleanup();
    }
  }, 30_000);
});

// ============================================================================
// Part C — webview Clear buttons require confirmation (source contract)
// ============================================================================

describe("credential persistence — webview clear confirmation (source contract)", () => {
  it("both Clear buttons are gated behind ConfirmCard with stable testids", () => {
    // No DOM test library exists in this repo, so the confirmation contract
    // is asserted at the source level: every destructive clear goes through
    // ConfirmCard, exposes a stable testid for e2e targeting, and the
    // pending-confirm state is reset when the provider selection changes.
    const src = fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "apps",
        "webview",
        "src",
        "ProviderSelector.tsx",
      ),
      "utf8",
    );
    expect(src).toContain('data-testid="gemini-clear-btn"');
    expect(src).toContain('data-testid="provider-clear-btn"');
    // ConfirmCard is the ONLY component rendered in place of each Clear
    // button once confirmation is pending (2 usages: Gemini + generic).
    expect(src.match(/<ConfirmCard/g)?.length).toBeGreaterThanOrEqual(2);
    // Switching provider resets any pending clear confirmation.
    expect(src).toContain("setConfirmingClear(false)");
  });
});
