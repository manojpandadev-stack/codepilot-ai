/**
 * privacy/confirm — the EXPLICIT cloud opt-in handler contract.
 *
 * The "Enable cloud access" button must not be a settings-only write:
 *   1. it acknowledges (`privacy/result`, ok:true) so the webview dialog can
 *      close deterministically instead of waiting on a timeout;
 *   2. it PERSISTS the mode — VS Code settings are the authoritative truth, so
 *      a restart must come back in the same mode;
 *   3. it LIVE-APPLIES the mode to an ALREADY-CREATED runtime. This is the
 *      security-critical part: the privacy gate reads the live runtime value
 *      on every request, so a settings-only write leaves "local" in force (and,
 *      in the other direction, leaves cloud traffic silently allowed after the
 *      user switched back to Local).
 *
 * An unknown mode must be rejected — never coerced — so a malformed webview
 * payload cannot widen the privacy boundary.
 */
import { describe, expect, it } from "vitest";
import { freshHost, type FreshHost } from "./vscode-integration-harness";
import type { WebviewMessage } from "@codepilot/shared";

function readMode(host: FreshHost): unknown {
  return host.vscodeStub.workspace
    .getConfiguration("codepilot")
    .get("privacyMode", "local");
}

describe("privacy/confirm handler", () => {
  it(
    "persists, live-applies to an existing runtime, and acknowledges",
    async () => {
      const host: FreshHost = await freshHost();
      const sent: WebviewMessage[] = [];
      try {
        // The runtime exists BEFORE the confirmation — this is the case a
        // settings-only write silently gets wrong.
        const rt = await host.seams.ensureRuntime();
        expect(rt.getProviderSettings().privacyMode).toBe("local");

        host.ext.__setWebviewSinkForIntegrationTest((m) => {
          sent.push(m as WebviewMessage);
        });
        await host.seams.handleMessage({
          type: "privacy/confirm",
          id: "confirm-cloud",
          payload: { mode: "cloud" },
          timestamp: Date.now(),
        });

        // 1. Acknowledged synchronously (no sleep: the UI closes on the ack).
        const ack = sent.find((m) => m.type === "privacy/result");
        expect(ack).toBeDefined();
        expect((ack!.payload as { ok?: boolean }).ok).toBe(true);

        // 2. Persisted.
        expect(readMode(host)).toBe("cloud");

        // 3. Live-applied to the runtime that already existed.
        expect(rt.getProviderSettings().privacyMode).toBe("cloud");

        // Switching back re-blocks live, again without a new runtime.
        await host.seams.handleMessage({
          type: "privacy/confirm",
          id: "confirm-local",
          payload: { mode: "local" },
          timestamp: Date.now(),
        });
        expect(readMode(host)).toBe("local");
        expect(rt.getProviderSettings().privacyMode).toBe("local");
        const acks = sent.filter((m) => m.type === "privacy/result");
        expect(acks.length).toBe(2);
        expect(
          acks.every((m) => (m.payload as { ok?: boolean }).ok === true),
        ).toBe(true);
      } finally {
        host.ext.__clearWebviewSinkForIntegrationTest();
        await host.ext.deactivate().catch(() => {});
        host.cleanup();
      }
    },
    60_000,
  );

  it(
    "rejects an unknown mode without widening the privacy boundary",
    async () => {
      const host: FreshHost = await freshHost();
      const sent: WebviewMessage[] = [];
      try {
        const rt = await host.seams.ensureRuntime();
        host.ext.__setWebviewSinkForIntegrationTest((m) => {
          sent.push(m as WebviewMessage);
        });
        await host.seams.handleMessage({
          type: "privacy/confirm",
          id: "confirm-bogus",
          payload: { mode: "everything-is-fine" },
          timestamp: Date.now(),
        });
        const ack = sent.find((m) => m.type === "privacy/result");
        expect(ack).toBeDefined();
        expect((ack!.payload as { ok?: boolean }).ok).toBe(false);
        // Nothing persisted, nothing applied: still fail-closed Local.
        expect(readMode(host)).toBe("local");
        expect(rt.getProviderSettings().privacyMode).toBe("local");
      } finally {
        host.ext.__clearWebviewSinkForIntegrationTest();
        await host.ext.deactivate().catch(() => {});
        host.cleanup();
      }
    },
    60_000,
  );
});