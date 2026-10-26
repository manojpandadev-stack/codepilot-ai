/**
 * Live-cloud-test command — fail-closed paths (hermetic).
 *
 * `runLiveCloudTest` runs inside the real extension host against the real
 * SecretStorage slot. These tests prove it never touches the network when
 * it must not: no saved key, Local-only privacy, or a local provider
 * selected. The SUCCESS path (real inference with the user's saved key)
 * can only run inside the user's actual VS Code via the Command Palette
 * ("CodePilot: Live Cloud Test (Saved Credentials)") and is reported, not
 * automated here — automating it would require the real key.
 */
import { describe, expect, it, vi } from "vitest";
import {
  freshHost,
  type FreshHost,
} from "./vscode-integration-harness";

describe("runLiveCloudTest fail-closed paths", () => {
  it(
    "no saved key: returns without any network request",
    async () => {
      const host: FreshHost = await freshHost();
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        await host.seams.handleMessage({
          type: "settings/set",
          id: "wv-lc-prov",
          payload: { key: "provider", value: "openrouter" },
          timestamp: Date.now(),
        });
        await host.seams.handleMessage({
          type: "privacy/confirm",
          id: "wv-lc-priv",
          payload: { mode: "cloud" },
          timestamp: Date.now(),
        });
        const callsBefore = fetchSpy.mock.calls.length;
        await host.seams.runLiveCloudTest();
        const remote = fetchSpy.mock.calls
          .slice(callsBefore)
          .filter((args) => {
            const url = String(args[0] ?? "");
            return (
              !url.includes("localhost") && !url.includes("127.0.0.1")
            );
          });
        expect(remote).toEqual([]);
      } finally {
        fetchSpy.mockRestore();
        await host.ext.deactivate().catch(() => {});
        host.cleanup();
      }
    },
    30_000,
  );

  it(
    "Local-only privacy with a saved key: returns without any network request",
    async () => {
      const host: FreshHost = await freshHost();
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        await host.seams
          .getProviderService()
          .setCredential("openrouter", "sk-or-test-key-not-real");
        await host.seams.handleMessage({
          type: "settings/set",
          id: "wv-lc-prov2",
          payload: { key: "provider", value: "openrouter" },
          timestamp: Date.now(),
        });
        // Privacy stays local (default) — never flipped.
        const callsBefore = fetchSpy.mock.calls.length;
        await host.seams.runLiveCloudTest();
        const remote = fetchSpy.mock.calls
          .slice(callsBefore)
          .filter((args) => {
            const url = String(args[0] ?? "");
            return (
              !url.includes("localhost") && !url.includes("127.0.0.1")
            );
          });
        expect(remote).toEqual([]);
      } finally {
        fetchSpy.mockRestore();
        await host.ext.deactivate().catch(() => {});
        host.cleanup();
      }
    },
    30_000,
  );

  it(
    "local provider selected: returns without any network request",
    async () => {
      const host: FreshHost = await freshHost();
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        await host.seams.handleMessage({
          type: "settings/set",
          id: "wv-lc-prov3",
          payload: { key: "provider", value: "ollama" },
          timestamp: Date.now(),
        });
        await host.seams.handleMessage({
          type: "privacy/confirm",
          id: "wv-lc-priv3",
          payload: { mode: "cloud" },
          timestamp: Date.now(),
        });
        const callsBefore = fetchSpy.mock.calls.length;
        await host.seams.runLiveCloudTest();
        const remote = fetchSpy.mock.calls
          .slice(callsBefore)
          .filter((args) => {
            const url = String(args[0] ?? "");
            return (
              !url.includes("localhost") && !url.includes("127.0.0.1")
            );
          });
        expect(remote).toEqual([]);
      } finally {
        fetchSpy.mockRestore();
        await host.ext.deactivate().catch(() => {});
        host.cleanup();
      }
    },
    30_000,
  );
});
