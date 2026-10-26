/**
 * MCP hung-server regression (Phase 1).
 *
 * A stdio server that SPAWNS but never completes the MCP initialize handshake
 * must not hang the host. The configured connect deadline expires, the
 * connection is aborted with a controlled error, the child process is
 * cleaned up, and the manager remains usable.
 *
 * Also proves a REAL server still connects afterwards (no wedged state).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { CodePilotMCPManager } from "./index.js";

const require = createRequire(import.meta.url);
const SDK_MCP_PATH = require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
const SDK_STDIO_PATH =
  require.resolve("@modelcontextprotocol/sdk/server/stdio.js");
const GOOD_SERVER_SCRIPT = path.join(
  os.tmpdir(),
  `codepilot-mcp-good-${process.pid}.js`,
);

beforeAll(() => {
  // A minimal REAL MCP stdio server (SDK McpServer + StdioServerTransport).
  // Absolute SDK paths so the spawned process resolves them regardless of cwd.
  fs.writeFileSync(
    GOOD_SERVER_SCRIPT,
    [
      `const { McpServer } = require(${JSON.stringify(SDK_MCP_PATH)});`,
      `const { StdioServerTransport } = require(${JSON.stringify(SDK_STDIO_PATH)});`,
      "(async () => {",
      "  const server = new McpServer({ name: 'codepilot-test', version: '1.0.0' });",
      "  server.registerTool('ping', { description: 'ping' }, async () => ({",
      "    content: [{ type: 'text', text: 'pong' }],",
      "  }));",
      "  await server.connect(new StdioServerTransport());",
      "})().catch(() => process.exit(1));",
    ].join("\n"),
    "utf8",
  );
});

afterAll(() => {
  try {
    fs.rmSync(GOOD_SERVER_SCRIPT, { force: true });
  } catch {
    // best-effort
  }
});

describe("MCP hung-server regression", () => {
  it("aborts a hung handshake at the connect deadline and stays usable", async () => {
    const manager = new CodePilotMCPManager({ approvalTimeoutMs: 60_000 });

    // 1. Hung server: spawns, never speaks MCP.
    await manager.addServer({
      name: "hung",
      transport: "stdio",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 60000)"],
      enabled: true,
      connectTimeoutMs: 2_000,
    });

    // 2. Connect → deadline expires → controlled error (no indefinite hang).
    const started = Date.now();
    const connected = await manager.connectServer("hung");
    const elapsed = Date.now() - started;

    expect(connected).toBe(false);
    // The deadline (2s) must bind well under the 30s test timeout.
    expect(elapsed).toBeLessThan(10_000);

    // 3. Health records the error; no leaked connected client.
    const health = manager.getServerStatus("hung");
    expect(health.status).toBe("error");
    expect(health.lastError).toContain("connect deadline");

    // 4. Runtime remains usable: a second attempt also fails at the
    //    deadline (the manager is not wedged by the first failure).
    const second = await manager.connectServer("hung");
    expect(second).toBe(false);

    // 5. A REAL server still connects afterwards (no leaked state).
    await manager.addServer({
      name: "good",
      transport: "stdio",
      command: process.execPath,
      args: [GOOD_SERVER_SCRIPT],
      enabled: true,
      connectTimeoutMs: 10_000,
    });
    const goodConnected = await manager.connectServer("good");
    expect(goodConnected).toBe(true);
    const goodHealth = manager.getServerStatus("good");
    expect(goodHealth.status).toBe("connected");
    expect(goodHealth.toolCount).toBeGreaterThan(0);

    // 6. Cleanup: disconnect both; no leaked state.
    await manager.disconnectServer("hung");
    await manager.disconnectServer("good");
    expect(manager.getServerStatus("good").status).toBe("disconnected");
  }, 30_000);
});
