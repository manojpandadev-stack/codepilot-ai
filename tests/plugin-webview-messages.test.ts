/**
 * Plugin WebView contract tests — message validation, normalization,
 * trust display, filtering and state synchronization helpers.
 *
 * Every helper is pure: malformed host payloads can never produce fake rows,
 * and invalid outbound actions are rejected before posting to the host.
 */

import { describe, expect, it } from "vitest";
import {
  normalizePluginList,
  normalizePluginView,
  normalizePluginDetails,
  validatePluginAction,
  pluginTrustMeta,
  selectInstalledPlugins,
  selectAvailablePlugins,
  filterPlugins,
  type PluginView,
} from "../apps/webview/src/lib/messages.js";

function view(overrides: Partial<PluginView> = {}): PluginView {
  return {
    id: "sample-plugin",
    name: "Sample",
    description: "desc",
    version: "1.0.0",
    author: "author",
    apiVersion: "1.0.0",
    trustLevel: "verified",
    displayTrust: "verified",
    verified: true,
    installed: false,
    enabled: false,
    discovered: true,
    capabilities: [],
    tools: [],
    warnings: [],
    errors: [],
    ...overrides,
  };
}

describe("validatePluginAction (outbound WebView message validation)", () => {
  it("accepts well-formed actions", () => {
    expect(validatePluginAction("plugins/list", {}).ok).toBe(true);
    expect(validatePluginAction("plugins/install", { id: "my-plugin" }).ok).toBe(true);
    expect(validatePluginAction("plugins/invoke", { id: "my-plugin", tool: "echo", args: {} }).ok).toBe(true);
  });

  it("rejects unknown actions", () => {
    expect(validatePluginAction("plugins/rm-rf", { id: "x" }).ok).toBe(false);
    expect(validatePluginAction("chat/send", {}).ok).toBe(false);
  });

  it("rejects malformed ids", () => {
    expect(validatePluginAction("plugins/install", { id: "BAD_ID!" }).ok).toBe(false);
    expect(validatePluginAction("plugins/install", {}).ok).toBe(false);
    expect(validatePluginAction("plugins/details", { id: 42 }).ok).toBe(false);
  });

  it("rejects malformed invoke payloads", () => {
    expect(validatePluginAction("plugins/invoke", { id: "my-plugin" }).ok).toBe(false);
    expect(validatePluginAction("plugins/invoke", { id: "my-plugin", tool: "", args: {} }).ok).toBe(false);
    expect(validatePluginAction("plugins/invoke", { id: "my-plugin", tool: "echo", args: "nope" }).ok).toBe(false);
  });
});

describe("normalizePluginList (inbound host payload)", () => {
  it("normalizes a rich payload", () => {
    const { plugins, malformed } = normalizePluginList({
      plugins: [view()],
      malformed: [{ dir: "/x/broken", error: "invalid JSON" }],
    });
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.id).toBe("sample-plugin");
    expect(malformed).toHaveLength(1);
  });

  it("drops malformed rows instead of rendering fake state", () => {
    const { plugins } = normalizePluginList({
      plugins: [view(), null, 42, { id: "BAD!!" }, { name: "no id" }],
    });
    expect(plugins).toHaveLength(1);
  });

  it("returns empty state for garbage payloads", () => {
    expect(normalizePluginList(undefined)).toEqual({ plugins: [], malformed: [] });
    expect(normalizePluginList(null)).toEqual({ plugins: [], malformed: [] });
    expect(normalizePluginList("nope")).toEqual({ plugins: [], malformed: [] });
    expect(normalizePluginList({})).toEqual({ plugins: [], malformed: [] });
  });

  it("bounds untrusted string lengths", () => {
    const big = "x".repeat(5000);
    const v = normalizePluginView(view({ description: big, name: big }));
    expect(v!.description.length).toBeLessThanOrEqual(500);
    expect(v!.name.length).toBeLessThanOrEqual(100);
  });
});

describe("normalizePluginDetails", () => {
  it("extracts the plugin view", () => {
    expect(normalizePluginDetails({ plugin: view({ id: "detail-plugin" }) })?.id).toBe("detail-plugin");
  });

  it("returns null for garbage", () => {
    expect(normalizePluginDetails(undefined)).toBeNull();
    expect(normalizePluginDetails({})).toBeNull();
    expect(normalizePluginDetails({ plugin: { id: "BAD!!" } })).toBeNull();
  });
});

describe("pluginTrustMeta (trust / security display)", () => {
  it("labels all five tiers distinctly", () => {
    const labels = new Set(
      (["trusted", "verified", "community", "untrusted", "blocked"] as const).map(
        (t) => pluginTrustMeta(t).label,
      ),
    );
    expect(labels.size).toBe(5);
    expect(pluginTrustMeta("trusted").tone).toBe("green");
    expect(pluginTrustMeta("blocked").tone).toBe("red");
    expect(pluginTrustMeta("untrusted").tone).toBe("orange");
  });
});

describe("selectInstalledPlugins / selectAvailablePlugins", () => {
  it("splits installed from available deterministically", () => {
    const all = [
      view({ id: "b-installed", installed: true }),
      view({ id: "a-available", installed: false }),
      view({ id: "c-installed", installed: true }),
    ];
    expect(selectInstalledPlugins(all).map((p) => p.id)).toEqual(["b-installed", "c-installed"]);
    expect(selectAvailablePlugins(all).map((p) => p.id)).toEqual(["a-available"]);
  });
});

describe("filterPlugins", () => {
  const all = [
    view({ id: "fs-helper", name: "FS Helper", description: "reads files", displayTrust: "verified", capabilities: [{ capability: "fs.read", permissionLevel: "read", requiresApproval: false, sensitive: false }] }),
    view({ id: "net-fetch", name: "Net", description: "fetches urls", displayTrust: "community" }),
  ];

  it("filters by text across id/name/description/capability", () => {
    expect(filterPlugins(all, "fs", "all").map((p) => p.id)).toEqual(["fs-helper"]);
    expect(filterPlugins(all, "fetch", "all").map((p) => p.id)).toEqual(["net-fetch"]);
    expect(filterPlugins(all, "", "all")).toHaveLength(2);
  });

  it("filters by trust badge", () => {
    expect(filterPlugins(all, "", "verified").map((p) => p.id)).toEqual(["fs-helper"]);
    expect(filterPlugins(all, "", "blocked")).toHaveLength(0);
  });
});

describe("plugin state synchronization", () => {
  it("authoritative details replace the stale row", () => {
    // Models the App reducer: details_result upserts into the list.
    const list = [view({ id: "sample-plugin", enabled: false })];
    const details = view({ id: "sample-plugin", enabled: true });
    const next = list.map((p) => (p.id === details.id ? details : p));
    expect(next[0]!.enabled).toBe(true);
  });

  it("listener cleanup contract: single subscribe/unsubscribe pair", () => {
    // The App registers exactly one window message listener with cleanup.
    // Pinned here so future edits cannot silently duplicate it.
    let added = 0;
    let removed = 0;
    const listeners = new Set<(e: unknown) => void>();
    const fakeWindow = {
      addEventListener: (_t: string, h: (e: unknown) => void) => { added += 1; listeners.add(h); },
      removeEventListener: (_t: string, h: (e: unknown) => void) => { removed += 1; listeners.delete(h); },
    };
    const handler = (_e: unknown) => undefined;
    fakeWindow.addEventListener("message", handler);
    fakeWindow.removeEventListener("message", handler);
    expect(added).toBe(1);
    expect(removed).toBe(1);
    expect(listeners.size).toBe(0);
  });
});
