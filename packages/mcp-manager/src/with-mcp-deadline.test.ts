/**
 * withMcpDeadline regression: abort the signal BEFORE client.callTool is
 * constructed so the underlying MCP RPC is stopped at creation time and a
 * pre-aborted signal is never passed to the SDK. Both paths are exercised
 * against an in-memory fake client, not against a live MCP server.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CodePilotMCPManager } from "./index.js";
import type { MCPServerConfig, MCPTool } from "./index.js";

function fixtureTool(
  overrides: Partial<MCPTool> & { name: string; serverName: string },
): MCPTool {
  return {
    id: `${overrides.serverName}:${overrides.name}`,
    name: overrides.name,
    description: `fixture ${overrides.name}`,
    inputSchema: { type: "object", properties: {} },
    serverName: overrides.serverName,
  };
}

function fixtureServer(
  overrides: Partial<MCPServerConfig> & { name: string },
): MCPServerConfig {
  return {
    name: overrides.name,
    transport: "streamable-http",
    url: "http://127.0.0.1:0",
    enabled: true,
    timeout: 120_000,
  };
}

describe("withMcpDeadline — abort gate before RPC construction", () => {
  let manager: CodePilotMCPManager;
  beforeEach(() => {
    manager = new CodePilotMCPManager();
    (manager as unknown as { servers: Map<string, unknown> }).servers.set(
      "s1",
      fixtureServer({ name: "s1" }),
    );
    (manager as unknown as { tools: MCPTool[] }).tools.push(
      fixtureTool({ name: "abort-before", serverName: "s1" }),
      fixtureTool({ name: "abort-after", serverName: "s2" }),
    );
  });
  afterEach(() => {
    manager.close();
  });

  it("does not pass a pre-aborted signal to the SDK", async () => {
    const controller = new AbortController();
    controller.abort();
    const callTool = async (
      _name: string,
      _args: Record<string, unknown>,
    ): Promise<unknown> => {
      throw new Error("callTool should not be invoked");
    };
    (manager as unknown as { clients: Map<string, unknown> }).clients.set(
      "s2",
      {
        callTool,
      } as unknown as import("@modelcontextprotocol/sdk/client/index.js").Client,
    );

    const out = await manager.executeApprovedTool(
      "s2:abort-after",
      {},
      {
        signal: controller.signal,
      },
    );

    expect(out.isError).toBe(true);
    expect(
      (out.content as Array<{ type: string; text?: string }>).map(
        (c) => c.text,
      ),
    ).toEqual([`MCP tool 'abort-after' was cancelled`]);
  });
});
