/**
 * M15 PluginService tests — backend for the Plugin Management UI.
 *
 * Proves, against the REAL chain (PluginManager → ToolRegistry →
 * ToolExecutionService → M4), that the UI:
 *  - discovers / lists / details plugins from real backend state (no fake state)
 *  - installs, enables, disables, uninstalls with backend enforcement
 *  - displays trust tiers and refuses to override them from the UI
 *  - surfaces malformed manifests, capability violations, backend errors
 *  - executes plugin tools ONLY through M4 (deny blocks, handler never runs)
 *  - offers no alternative execution path around the security pipeline
 *  - cleans up listeners/subscriptions (lifecycle)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { PluginService, isValidPluginId } from "../apps/vscode-extension/src/plugin-service";
import { M4PermissionPipeline } from "../packages/tool-engine/src/m4/integration";

let dir: string;
let service: PluginService;

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sample-plugin",
    name: "Sample Plugin",
    description: "A sample plugin for tests",
    author: "CodePilot Tests",
    version: "1.0.0",
    apiVersion: "1.0.0",
    trustLevel: "verified",
    capabilities: ["context.read"],
    tools: [],
    ...overrides,
  };
}

function writePlugin(id: string, content: Record<string, unknown> | string): void {
  const pluginDir = path.join(dir, id);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "codepilot.plugin.json"),
    typeof content === "string" ? content : JSON.stringify(content),
    "utf8",
  );
}

function allowPipeline(): M4PermissionPipeline {
  return new M4PermissionPipeline({
    workspaceRoot: dir,
    presentApproval: async () => ({ decision: "allow", scope: "once" }),
  });
}

function denyReadsPipeline(): M4PermissionPipeline {
  return new M4PermissionPipeline({
    workspaceRoot: dir,
    presentApproval: async () => ({ decision: "allow", scope: "once" }),
    policies: [
      {
        id: "deny-reads",
        actions: ["read_file"],
        decision: "deny",
        scope: "single_execution",
        priority: 1000,
        enabled: true,
      },
    ],
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-plugin-svc-"));
  service = new PluginService();
});

afterEach(() => {
  service.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- discovery
describe("PluginService discovery", () => {
  it("discovers available plugins with full metadata", () => {
    writePlugin("sample-plugin", manifest());
    const result = service.scan(dir);
    expect(result.backendAvailable).toBe(true);
    expect(result.plugins).toHaveLength(1);
    const p = result.plugins[0]!;
    expect(p.id).toBe("sample-plugin");
    expect(p.name).toBe("Sample Plugin");
    expect(p.description).toContain("sample");
    expect(p.version).toBe("1.0.0");
    expect(p.author).toBe("CodePilot Tests");
    expect(p.displayTrust).toBe("verified");
    expect(p.installed).toBe(false);
    expect(p.enabled).toBe(false);
    expect(p.capabilities).toHaveLength(1);
    expect(result.malformed).toHaveLength(0);
  });

  it("reports malformed manifests instead of crashing", () => {
    writePlugin("broken-json", "{ nope");
    writePlugin("broken-schema", manifest({ id: "BAD!!", version: "x" }));
    writePlugin("incompatible-api", manifest({ id: "old-plugin", apiVersion: "9.0.0" }));
    const result = service.scan(dir);
    expect(result.plugins).toHaveLength(0);
    expect(result.malformed).toHaveLength(3);
    expect(result.malformed.some((m) => m.error.includes("invalid JSON"))).toBe(true);
    expect(result.malformed.some((m) => m.error.includes("incompatible"))).toBe(true);
  });

  it("returns empty state for a missing plugins dir", () => {
    const result = service.scan(path.join(dir, "does-not-exist"));
    expect(result.plugins).toHaveLength(0);
    expect(result.malformed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- installed
describe("PluginService installed listing", () => {
  it("installs a tool-less plugin and lists it as installed", () => {
    writePlugin("sample-plugin", manifest());
    service.scan(dir);
    const installed = service.install("sample-plugin");
    expect(installed.ok).toBe(true);
    const listed = service.scan(dir);
    expect(listed.plugins[0]!.installed).toBe(true);
    expect(listed.plugins[0]!.enabled).toBe(false);
  });

  it("install shows installed plugins separately from available", () => {
    writePlugin("sample-plugin", manifest());
    writePlugin("other-plugin", manifest({ id: "other-plugin", name: "Other" }));
    service.scan(dir);
    service.install("sample-plugin");
    const { plugins } = service.scan(dir);
    expect(plugins.find((p) => p.id === "sample-plugin")!.installed).toBe(true);
    expect(plugins.find((p) => p.id === "other-plugin")!.installed).toBe(false);
  });

  it("marks installed-but-undiscovered plugins unavailable", () => {
    writePlugin("sample-plugin", manifest());
    service.scan(dir);
    service.install("sample-plugin");
    fs.rmSync(path.join(dir, "sample-plugin"), { recursive: true, force: true });
    const { plugins } = service.scan(dir);
    const view = plugins.find((p) => p.id === "sample-plugin")!;
    expect(view.installed).toBe(true);
    expect(view.discovered).toBe(false);
    expect(view.errors.some((e) => e.includes("unavailable"))).toBe(true);
  });
});

// ---------------------------------------------------------------- details
describe("PluginService details", () => {
  it("returns metadata, capabilities, tools, trust and install state", () => {
    writePlugin("sample-plugin", manifest({
      capabilities: ["fs.read", "fs.write"],
      tools: [],
    }));
    service.scan(dir);
    service.install("sample-plugin");
    const details = service.details("sample-plugin");
    expect(details.ok).toBe(true);
    if (!details.ok) return;
    expect(details.plugin.capabilities.map((c) => c.capability)).toEqual(["fs.read", "fs.write"]);
    const write = details.plugin.capabilities.find((c) => c.capability === "fs.write")!;
    expect(write.requiresApproval).toBe(true);
    expect(write.permissionLevel).toBe("write");
    expect(details.plugin.displayTrust).toBe("verified");
    expect(details.plugin.installed).toBe(true);
  });

  it("details unknown plugin errors actionably", () => {
    const details = service.details("nope-not-here");
    expect(details.ok).toBe(false);
  });

  it("never exposes secrets in views", () => {
    writePlugin("sample-plugin", manifest({
      description: "desc",
      author: "author",
    }));
    const { plugins } = service.scan(dir);
    const text = JSON.stringify(plugins);
    expect(text).not.toMatch(/api[_-]?key|secret|password|token/i);
  });
});

// ---------------------------------------------------------------- enable/disable/uninstall
describe("PluginService enable / disable / uninstall", () => {
  it("enables and disables, reflecting registry state", () => {
    writePlugin("sample-plugin", manifest());
    service.scan(dir);
    service.install("sample-plugin");
    expect(service.activate("sample-plugin").ok).toBe(true);
    expect(service.scan(dir).plugins[0]!.enabled).toBe(true);
    expect(service.deactivate("sample-plugin").ok).toBe(true);
    expect(service.scan(dir).plugins[0]!.enabled).toBe(false);
  });

  it("enable of unknown/uninstalled plugin fails actionably", () => {
    expect(service.activate("ghost-plugin").ok).toBe(false);
  });

  it("uninstall removes the plugin and refreshes state", () => {
    writePlugin("sample-plugin", manifest());
    service.scan(dir);
    service.install("sample-plugin");
    expect(service.uninstall("sample-plugin").ok).toBe(true);
    const { plugins } = service.scan(dir);
    expect(plugins.find((p) => p.id === "sample-plugin")!.installed).toBe(false);
    expect(service.uninstall("sample-plugin").ok).toBe(false);
  });

  it("uninstall requires confirmation at the UI layer (backend is unconditional)", () => {
    // Backend contract: uninstall is immediate; the WebView must confirm.
    // This test pins the backend half of that contract.
    writePlugin("sample-plugin", manifest());
    service.scan(dir);
    service.install("sample-plugin");
    expect(service.installedCount()).toBe(1);
    service.uninstall("sample-plugin");
    expect(service.installedCount()).toBe(0);
  });
});

// ---------------------------------------------------------------- trust
describe("PluginService trust display", () => {
  it("maps official → trusted, verified → verified", () => {
    writePlugin("official-one", manifest({ id: "official-one", trustLevel: "official" }));
    writePlugin("verified-one", manifest({ id: "verified-one", trustLevel: "verified" }));
    const { plugins } = service.scan(dir);
    expect(plugins.find((p) => p.id === "official-one")!.displayTrust).toBe("trusted");
    expect(plugins.find((p) => p.id === "verified-one")!.displayTrust).toBe("verified");
  });

  it("community shows untrusted until explicitly confirmed", () => {
    writePlugin("comm-plugin", manifest({ id: "comm-plugin", trustLevel: "community", tools: [] }));
    let view = service.scan(dir).plugins[0]!;
    expect(view.displayTrust).toBe("untrusted");
    // UI cannot bypass: install without confirmation fails in the backend.
    expect(service.install("comm-plugin").ok).toBe(false);
    expect(service.install("comm-plugin", { confirmUntrusted: true }).ok).toBe(true);
    view = service.scan(dir).plugins[0]!;
    expect(view.displayTrust).toBe("community");
    // ...and activation without confirmation fails too.
    expect(service.activate("comm-plugin").ok).toBe(false);
    expect(service.activate("comm-plugin", { confirmUntrusted: true }).ok).toBe(true);
  });

  it("community cannot hold terminal capability (blocked at validation)", () => {
    writePlugin("evil-plugin", manifest({
      id: "evil-plugin",
      trustLevel: "community",
      capabilities: ["terminal.execute"],
    }));
    const { plugins, malformed } = service.scan(dir);
    expect(plugins).toHaveLength(0);
    expect(malformed.some((m) => m.error.includes("community"))).toBe(true);
  });
});

// ---------------------------------------------------------------- backend errors
describe("PluginService backend errors", () => {
  it("install of tool-bearing manifest fails with an actionable backend error", () => {
    writePlugin("sample-plugin", manifest({
      capabilities: ["fs.read"],
      tools: [{ name: "greet", description: "says hi" }],
    }));
    service.scan(dir);
    const result = service.install("sample-plugin");
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("handler");
  });

  it("install of undiscoverable plugin fails", () => {
    expect(service.install("ghost-plugin").ok).toBe(false);
  });

  it("invalid ids are rejected everywhere", () => {
    expect(isValidPluginId("BAD_ID!")).toBe(false);
    expect(isValidPluginId("")).toBe(false);
    expect(isValidPluginId(undefined)).toBe(false);
    expect(isValidPluginId("ok-plugin-id")).toBe(true);
    expect(service.install("BAD_ID!").ok).toBe(false);
    expect(service.activate("BAD_ID!").ok).toBe(false);
    expect(service.deactivate("BAD_ID!").ok).toBe(false);
    expect(service.uninstall("BAD_ID!").ok).toBe(false);
  });

  it("invoke fails closed without M4 (backend unavailable)", async () => {
    writePlugin("sample-plugin", manifest());
    service.scan(dir);
    service.install("sample-plugin");
    service.activate("sample-plugin");
    const result = await service.invoke("sample-plugin", "any", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("backend unavailable");
  });
});

// ---------------------------------------------------------------- M4 enforcement
describe("PluginService M4 enforcement (no bypass)", () => {
  function installExecutablePlugin(): { handlerCalls: string[] } {
    const handlerCalls: string[] = [];
    const installed = service.pluginManager.install(
      {
        id: "exec-plugin",
        name: "Exec Plugin",
        version: "1.0.0",
        apiVersion: "1.0.0",
        trustLevel: "verified",
        capabilities: ["context.read"],
        tools: [{ name: "echo", description: "echoes" }],
      },
      {
        echo: async (args) => {
          handlerCalls.push(JSON.stringify(args));
          return { echoed: true };
        },
      },
    );
    expect(installed.ok).toBe(true);
    expect(service.pluginManager.activate("exec-plugin").ok).toBe(true);
    return { handlerCalls };
  }

  it("M4 deny blocks execution and the handler never runs", async () => {
    const { handlerCalls } = installExecutablePlugin();
    service.setM4Pipeline(denyReadsPipeline());
    // plugin tool maps to the read_file action → denied by policy.
    const result = await service.invoke("exec-plugin", "echo", { a: 1 });
    expect(result.ok).toBe(false);
    expect(handlerCalls).toHaveLength(0);
  });

  it("M4 allow executes through the full chain", async () => {
    const { handlerCalls } = installExecutablePlugin();
    service.setM4Pipeline(allowPipeline());
    const result = await service.invoke("exec-plugin", "echo", { a: 1 });
    expect(result.ok).toBe(true);
    expect(handlerCalls).toHaveLength(1);
  });

  it("disabled plugins cannot execute (no stale path)", async () => {
    installExecutablePlugin();
    service.setM4Pipeline(allowPipeline());
    service.pluginManager.deactivate("exec-plugin");
    const result = await service.invoke("exec-plugin", "echo", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not enabled");
  });

  it("unregistered tools cannot execute", async () => {
    installExecutablePlugin();
    service.setM4Pipeline(allowPipeline());
    const result = await service.invoke("exec-plugin", "nope", {});
    expect(result.ok).toBe(false);
  });

  it("capability gate refuses before handler code runs", async () => {
    const calls: string[] = [];
    service.pluginManager.install(
      {
        id: "cap-plugin",
        name: "Cap",
        version: "1.0.0",
        apiVersion: "1.0.0",
        trustLevel: "verified",
        capabilities: ["context.read"],
        tools: [{ name: "read-file", description: "reads" }],
      },
      { "read-file": async () => { calls.push("ran"); return "x"; } },
    );
    service.pluginManager.activate("cap-plugin");
    await expect(
      service.pluginManager.invoke("cap-plugin", "read-file", {}, "fs.read"),
    ).rejects.toThrow("lacks capability");
    expect(calls).toHaveLength(0);
  });

  it("deactivation unregisters tools from the shared registry", () => {
    installExecutablePlugin();
    expect(service.toolRegistry.has("exec-plugin:echo")).toBe(true);
    service.pluginManager.deactivate("exec-plugin");
    expect(service.toolRegistry.has("exec-plugin:echo")).toBe(false);
  });
});

// ---------------------------------------------------------------- state sync + lifecycle
describe("PluginService state synchronization & lifecycle", () => {
  it("persists install/enable intent across restarts", () => {
    const saved: Array<{ id: string; communityConfirmed: boolean; enabled: boolean }> = [];
    const storage = {
      load: () => null,
      save: (s: { installed: Array<{ id: string; communityConfirmed: boolean; enabled: boolean }> }) => {
        saved.length = 0;
        saved.push(...s.installed);
      },
    };
    const first = new PluginService({ storage });
    try {
      writePlugin("sample-plugin", manifest());
      first.scan(dir);
      first.install("sample-plugin");
      first.activate("sample-plugin");
      expect(saved).toHaveLength(1);
      // Simulate restart: new service, same storage, same disk.
      const second = new PluginService({
        storage: { load: () => ({ installed: [...saved] }), save: () => undefined },
      });
      try {
        const { plugins } = second.scan(dir);
        const view = plugins.find((p) => p.id === "sample-plugin")!;
        expect(view.installed).toBe(true);
        expect(view.enabled).toBe(true);
      } finally {
        second.dispose();
      }
    } finally {
      first.dispose();
    }
  });

  it("repeated scan → mutate → dispose cycles do not accumulate state", () => {
    writePlugin("sample-plugin", manifest());
    for (let i = 0; i < 5; i++) {
      service.scan(dir);
      service.install("sample-plugin");
      service.activate("sample-plugin");
      service.deactivate("sample-plugin");
      service.uninstall("sample-plugin");
      expect(service.installedCount()).toBe(0);
    }
    service.dispose();
    service.dispose(); // idempotent
    expect(service.installedCount()).toBe(0);
  });

  it("dispose deactivates everything", () => {
    writePlugin("sample-plugin", manifest());
    service.scan(dir);
    service.install("sample-plugin");
    service.activate("sample-plugin");
    service.dispose();
    expect(service.pluginManager.isEnabled("sample-plugin")).toBe(false);
  });
});
