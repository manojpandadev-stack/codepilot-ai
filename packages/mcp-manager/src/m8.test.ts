/**
 * M8 — MCP Platform tests
 *
 * Covers configuration persistence (secret redaction, atomicity, corruption
 * tolerance), server health tracking, reconnect lifecycle, and
 * resource/prompt discovery state on the manager.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CodePilotMCPManager,
  MCPConfigStore,
  REDACTED_ENV_PLACEHOLDER,
  redactEnvForPersistence,
  restoreEnvFromPersistence,
} from "./index.js";

// ============================================================================
// Env redaction helpers
// ============================================================================

describe("M8 env redaction helpers", () => {
  it("replaces every env value with the placeholder", () => {
    const redacted = redactEnvForPersistence({
      DB_PASSWORD: "hunter2",
      TOKEN: "abc123",
    });
    expect(redacted).toEqual({
      DB_PASSWORD: REDACTED_ENV_PLACEHOLDER,
      TOKEN: REDACTED_ENV_PLACEHOLDER,
    });
  });

  it("restores placeholders as empty strings and keeps other values", () => {
    const restored = restoreEnvFromPersistence({
      DB_PASSWORD: REDACTED_ENV_PLACEHOLDER,
      LOG_LEVEL: "debug",
    });
    expect(restored).toEqual({ DB_PASSWORD: "", LOG_LEVEL: "debug" });
  });

  it("handles undefined env symmetrically", () => {
    expect(redactEnvForPersistence(undefined)).toEqual({});
    expect(restoreEnvFromPersistence(undefined)).toBeUndefined();
  });
});

// ============================================================================
// MCPConfigStore
// ============================================================================

describe("M8 MCPConfigStore", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-mcp-"));
    file = path.join(dir, "servers.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists configs without ever writing env values", async () => {
    const store = new MCPConfigStore(file);
    await store.save([
      {
        name: "db",
        transport: "stdio",
        command: "npx",
        args: ["-y", "server-postgres"],
        env: { DB_PASSWORD: "hunter2" },
        enabled: true,
      },
    ]);

    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain("hunter2");
    expect(raw).toContain(REDACTED_ENV_PLACEHOLDER);
    expect(raw).toContain("server-postgres");
  });

  it("round-trips save/load with env redacted to empty strings", async () => {
    const store = new MCPConfigStore(file);
    await store.save([
      {
        name: "db",
        transport: "stdio",
        command: "npx",
        env: { DB_PASSWORD: "hunter2" },
        enabled: true,
        timeout: 2000,
      },
    ]);

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.name).toBe("db");
    expect(loaded[0]?.env?.DB_PASSWORD).toBe("");
    expect(loaded[0]?.timeout).toBe(2000);
  });

  it("leaves no temp file behind after an atomic save", async () => {
    const store = new MCPConfigStore(file);
    await store.save([
      { name: "a", transport: "stdio", command: "x", enabled: false },
    ]);
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("returns [] for a missing config file", async () => {
    const store = new MCPConfigStore(path.join(dir, "absent.json"));
    expect(await store.load()).toEqual([]);
  });

  it("returns [] instead of throwing on corrupt config", async () => {
    fs.writeFileSync(file, "{ not valid json !!!", "utf8");
    const store = new MCPConfigStore(file);
    expect(await store.load()).toEqual([]);
  });

  it("skips malformed entries instead of failing the whole load", async () => {
    fs.writeFileSync(
      file,
      JSON.stringify([
        { name: "good", transport: "stdio", command: "x", enabled: true },
        null,
        42,
        { nope: true },
      ]),
      "utf8",
    );
    const store = new MCPConfigStore(file);
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.name).toBe("good");
  });
});

// ============================================================================
// Server health / lifecycle on the manager
// ============================================================================

describe("M8 manager health and lifecycle", () => {
  let manager: CodePilotMCPManager;

  beforeEach(() => {
    manager = new CodePilotMCPManager();
  });

  it("unknown servers report disconnected health", () => {
    const health = manager.getServerStatus("never-added");
    expect(health.status).toBe("disconnected");
    expect(health.toolCount).toBe(0);
  });

  it("listServerStatuses covers every configured server", () => {
    manager.addServer({
      name: "a",
      transport: "stdio",
      command: "whatever",
      enabled: false,
    });
    manager.addServer({
      name: "b",
      transport: "stdio",
      command: "whatever",
      enabled: false,
    });

    const statuses = manager.listServerStatuses();
    expect(statuses.map((s) => s.name).sort()).toEqual(["a", "b"]);
    for (const s of statuses) {
      expect(s.health.status).toBe("disconnected");
    }
  });

  it("connecting a disabled server fails without changing health", async () => {
    manager.addServer({
      name: "disabled",
      transport: "stdio",
      command: "whatever",
      enabled: false,
    });
    expect(await manager.connectServer("disabled")).toBe(false);
    expect(manager.getServerStatus("disabled").status).toBe("disconnected");
  });

  it("reconnect on a never-connected server reports error health, not throw", async () => {
    manager.addServer({
      name: "bad",
      transport: "stdio",
      command: "definitely-not-a-real-command-xyz",
      enabled: true,
    });
    const health = await manager.reconnect("bad");
    expect(["error", "disconnected"]).toContain(health.status);
  });

  it("failing connect records lastError for diagnostics", async () => {
    manager.addServer({
      name: "bad",
      transport: "stdio",
      command: "definitely-not-a-real-command-xyz",
      enabled: true,
    });
    await manager.connectServer("bad");
    const health = manager.getServerStatus("bad");
    expect(health.status).toBe("error");
    expect(health.lastError).toBeTruthy();
  });

  it("resources and prompts are empty for servers never connected", () => {
    manager.addServer({
      name: "idle",
      transport: "stdio",
      command: "whatever",
      enabled: false,
    });
    expect(manager.listResources("idle")).toEqual([]);
    expect(manager.listPrompts("idle")).toEqual([]);
  });
});
