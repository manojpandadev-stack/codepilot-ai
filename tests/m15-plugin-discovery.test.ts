/**
 * M15 — plugin discovery integration (production entry point).
 *
 * Proves PluginManager.discover() finds valid manifests on disk, skips
 * malformed/non-plugin directories without crashing, and that discovered
 * community plugins still cannot activate without explicit user enablement.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  PluginManager,
  validatePluginManifest,
} from "../packages/tool-engine/src/m15-plugin-platform";
import { ToolRegistry } from "../packages/tool-engine/src/m3/registry";

let dir: string;

function makeManifest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "sample-plugin",
    name: "Sample Plugin",
    version: "1.0.0",
    apiVersion: "1.0.0",
    trustLevel: "verified",
    capabilities: ["fs.read"],
    tools: [{ name: "greet", description: "Say hello" }],
    ...overrides,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-m15-disc-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("M15 plugin discovery", () => {
  it("discovers a valid plugin manifest from disk", () => {
    const pluginDir = path.join(dir, "sample-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "codepilot.plugin.json"),
      JSON.stringify(makeManifest()),
      "utf8",
    );

    const found = PluginManager.discover(dir);
    expect(found).toHaveLength(1);
    expect(found[0]!.manifest.id).toBe("sample-plugin");
    expect(found[0]!.manifest.trustLevel).toBe("verified");
  });

  it("skips malformed manifests and non-plugin directories without crashing", () => {
    fs.mkdirSync(path.join(dir, "broken"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "broken", "codepilot.plugin.json"),
      "{ not json",
      "utf8",
    );
    fs.mkdirSync(path.join(dir, "empty"), { recursive: true });
    fs.writeFileSync(path.join(dir, "loose.txt"), "not a plugin", "utf8");

    const found = PluginManager.discover(dir);
    expect(found).toHaveLength(0);
  });

  it("installing a discovered community plugin still requires the enablement gate", () => {
    const pluginDir = path.join(dir, "community-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    const manifest = makeManifest({
      id: "community-plugin",
      trustLevel: "community",
    });
    fs.writeFileSync(
      path.join(pluginDir, "codepilot.plugin.json"),
      JSON.stringify(manifest),
      "utf8",
    );

    const found = PluginManager.discover(dir);
    expect(found).toHaveLength(1);

    const registry = new ToolRegistry();
    const manager = new PluginManager(registry);
    // Auto-installing a discovered community plugin must FAIL.
    const refused = manager.install(found[0]!.manifest, {
      greet: () => ({ message: "hi" }),
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.errors[0]).toContain("explicit user enablement");
    }
    // Explicit opt-in succeeds.
    const accepted = manager.install(
      found[0]!.manifest,
      {
        greet: () => ({ message: "hi" }),
      },
      { skipCommunityGate: true },
    );
    expect(accepted.ok).toBe(true);
    expect(manager.isInstalled("community-plugin")).toBe(true);
  });
});
