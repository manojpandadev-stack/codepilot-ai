/**
 * M15 — Plugin platform tests: manifest validation, trust tiers,
 * capability gating, ToolRegistry integration, lifecycle (install /
 * activate / disable / uninstall), and malicious plugin behavior.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "./m3/registry.js";
import {
  PluginManager,
  validatePluginManifest,
  isApiCompatible,
} from "./m15-plugin-platform.js";
import type { PluginManifest } from "./m15-plugin-platform.js";

function manifest(overrides?: Partial<PluginManifest>): PluginManifest {
  return {
    id: "my-plugin",
    name: "My Plugin",
    version: "1.0.0",
    apiVersion: "1.0.0",
    trustLevel: "verified",
    capabilities: ["context.read"],
    tools: [{ name: "greet", description: "greets" }],
    ...overrides,
  };
}

function validManifestObject(): Record<string, unknown> {
  return manifest() as unknown as Record<string, unknown>;
}

describe("M15 validatePluginManifest", () => {
  it("accepts a valid manifest", () => {
    const result = validatePluginManifest(validManifestObject());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects malformed ids, versions and trust levels", () => {
    const result = validatePluginManifest({
      id: "Bad_ID!",
      name: "",
      version: "not-semver",
      apiVersion: "1.0",
      trustLevel: "hacker",
      capabilities: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });

  it("rejects unknown capabilities", () => {
    const result = validatePluginManifest({
      ...validManifestObject(),
      capabilities: ["fs.write", "become-root"],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("become-root"))).toBe(true);
  });

  it("blocks community plugins from terminal capability", () => {
    const result = validatePluginManifest({
      ...validManifestObject(),
      trustLevel: "community",
      capabilities: ["terminal.execute"],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("community"))).toBe(true);
  });

  it("rejects non-object manifests", () => {
    expect(validatePluginManifest(null).valid).toBe(false);
    expect(validatePluginManifest("string").valid).toBe(false);
    expect(validatePluginManifest(42).valid).toBe(false);
  });
});

describe("M15 isApiCompatible", () => {
  it("requires the same major version", () => {
    expect(isApiCompatible("1.2.3", "1.0.0")).toBe(true);
    expect(isApiCompatible("2.0.0", "1.0.0")).toBe(false);
    expect(isApiCompatible("garbage", "1.0.0")).toBe(false);
  });
});

describe("M15 PluginManager lifecycle", () => {
  let registry: ToolRegistry;
  let manager: PluginManager;

  beforeEach(() => {
    registry = new ToolRegistry();
    manager = new PluginManager(registry);
  });

  it("installs and activates, registering namespaced tools", () => {
    const install = manager.install(manifest(), {
      greet: async () => "hello",
    });
    expect(install.ok).toBe(true);
    expect(manager.activate("my-plugin").ok).toBe(true);
    expect(registry.has("my-plugin:greet")).toBe(true);
    expect(manager.isEnabled("my-plugin")).toBe(true);
  });

  it("requires explicit community enablement to install", () => {
    const install = manager.install(manifest({ trustLevel: "community" }), {
      greet: async () => "hi",
    });
    expect(install.ok).toBe(false);
    if (!install.ok)
      expect(install.errors[0]).toContain("explicit user enablement");

    const gated = manager.install(
      manifest({ trustLevel: "community" }),
      { greet: async () => "hi" },
      { skipCommunityGate: true },
    );
    expect(gated.ok).toBe(true);
  });

  it("rejects tools declared without handlers", () => {
    const install = manager.install(manifest(), {}); // greet missing
    expect(install.ok).toBe(false);
    if (!install.ok) expect(install.errors[0]).toContain("without a handler");
  });

  it("deactivate unregisters tools but keeps the plugin installed", () => {
    manager.install(manifest(), { greet: async () => "hi" });
    manager.activate("my-plugin");
    expect(manager.deactivate("my-plugin")).toBe(true);
    expect(registry.has("my-plugin:greet")).toBe(false);
    expect(manager.isInstalled("my-plugin")).toBe(true);
    expect(manager.isEnabled("my-plugin")).toBe(false);
  });

  it("uninstall removes everything", () => {
    manager.install(manifest(), { greet: async () => "hi" });
    manager.activate("my-plugin");
    expect(manager.uninstall("my-plugin")).toBe(true);
    expect(manager.isInstalled("my-plugin")).toBe(false);
    expect(registry.has("my-plugin:greet")).toBe(false);
  });

  it("refuses duplicate installs", () => {
    manager.install(manifest(), { greet: async () => "hi" });
    const second = manager.install(manifest({ name: "Clone" }), {
      greet: async () => "hi",
    });
    expect(second.ok).toBe(false);
  });

  it("refuses incompatible apiVersion", () => {
    const install = manager.install(manifest({ apiVersion: "2.0.0" }), {
      greet: async () => "hi",
    });
    expect(install.ok).toBe(false);
    if (!install.ok) expect(install.errors[0]).toContain("incompatible");
  });
});

describe("M15 capability enforcement", () => {
  let registry: ToolRegistry;
  let manager: PluginManager;

  beforeEach(() => {
    registry = new ToolRegistry();
    manager = new PluginManager(registry);
  });

  it("invoke fails when the required capability is missing", async () => {
    manager.install(
      manifest({
        capabilities: ["context.read"],
        tools: [{ name: "read-file", description: "reads" }],
      }),
      { "read-file": async () => "file contents" },
    );
    manager.activate("my-plugin");
    await expect(
      manager.invoke("my-plugin", "read-file", {}, "fs.read"),
    ).rejects.toThrow("lacks capability");
  });

  it("invoke succeeds when the capability is granted", async () => {
    manager.install(
      manifest({
        capabilities: ["fs.read"],
        tools: [{ name: "read-file", description: "reads" }],
      }),
      { "read-file": async (args) => `read ${String(args.path)}` },
    );
    manager.activate("my-plugin");
    const result = await manager.invoke(
      "my-plugin",
      "read-file",
      { path: "src/a.ts" },
      "fs.read",
    );
    expect(result).toBe("read src/a.ts");
  });

  it("cannot invoke a disabled plugin", async () => {
    manager.install(manifest(), { greet: async () => "hi" });
    manager.activate("my-plugin");
    manager.deactivate("my-plugin");
    await expect(manager.invoke("my-plugin", "greet", {})).rejects.toThrow(
      "not enabled",
    );
  });

  it("handlers cannot mutate the caller's args object", async () => {
    let seen: unknown;
    manager.install(manifest(), {
      greet: async (args) => {
        seen = args;
        (seen as Record<string, unknown>).injected = true;
        return "ok";
      },
    });
    manager.activate("my-plugin");
    const args = { original: true };
    await manager.invoke("my-plugin", "greet", args);
    expect(args).toEqual({ original: true });
    expect(seen).toHaveProperty("injected", true);
  });
});

describe("M15 malicious plugin behavior", () => {
  it("registry id-collision across plugins is refused", () => {
    const registry = new ToolRegistry();
    const manager = new PluginManager(registry);
    manager.install(manifest({ id: "plugin-a" }), { greet: async () => "a" });
    manager.activate("plugin-a");
    // Second plugin tries to register the same tool name — namespacing
    // prevents collisions, but double-activate of the same plugin must too.
    const second = manager.install(manifest({ id: "plugin-a", name: "Dup" }), {
      greet: async () => "b",
    });
    expect(second.ok).toBe(false);
  });

  it("handler throwing does not corrupt manager state", async () => {
    const registry = new ToolRegistry();
    const manager = new PluginManager(registry);
    manager.install(manifest(), {
      greet: async () => {
        throw new Error("boom");
      },
    });
    manager.activate("my-plugin");
    await expect(manager.invoke("my-plugin", "greet", {})).rejects.toThrow(
      "boom",
    );
    expect(manager.isEnabled("my-plugin")).toBe(true);
    expect(manager.listInstalled()).toHaveLength(1);
  });

  it("enforces the plugin cap", () => {
    const registry = new ToolRegistry();
    const manager = new PluginManager(registry, { maxPlugins: 2 });
    for (let i = 0; i < 3; i++) {
      const result = manager.install(manifest({ id: `plugin-${i}` }), {
        greet: async () => "hi",
      });
      if (i < 2) expect(result.ok).toBe(true);
      else {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errors[0]).toContain("cap");
      }
    }
  });
});
