/**
 * Live MCP loopback (real SDK transports, real processes/sockets, no mocks).
 *
 * - stdio: a fixture MCP server (SDK McpServer + StdioServerTransport) is
 *   spawned as a real child process; the manager connects, discovers tools,
 *   executes, times out, and aborts through the genuine transport.
 * - streamable-http: an in-test node:http server fronts McpServer via the
 *   WebStandard transport with per-session server instances; the manager
 *   connects over real HTTP to 127.0.0.1 (also proving loopback servers
 *   pass the SSRF guard).
 *
 * SSE shares the validated URL gate and the shared call deadline; it is
 * covered by unit tests (no separate live SSE server is bundled).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CodePilotMCPManager,
  validateMcpServerUrl,
} from "./index.js";

/** Absolute file URLs so the fixture resolves the SDK without node_modules. */
function sdkFileUrl(subpath: string): string {
  const req = createRequire(import.meta.url);
  return pathToFileURL(req.resolve(`@modelcontextprotocol/sdk/${subpath}`)).href;
}

function fixtureSource(): string {
  const mcp = sdkFileUrl("server/mcp.js");
  const stdio = sdkFileUrl("server/stdio.js");
  return [
    `import { McpServer } from ${JSON.stringify(mcp)};`,
    `import { StdioServerTransport } from ${JSON.stringify(stdio)};`,
    `const server = new McpServer({ name: "loopback", version: "0.0.0" });`,
    `server.tool("ping", async () => ({ content: [{ type: "text", text: "pong-live" }] }));`,
    `server.tool("hang", async () => new Promise(() => {}));`,
    `server.resource("cfg", "config://app", async () => ({ contents: [{ uri: "config://app", text: "loopback-config" }] }));`,
    `await server.connect(new StdioServerTransport());`,
    ``,
  ].join("\n");
}

describe(
  "MCP stdio loopback (live child process)",
  () => {
    let dir = "";
    let manager: CodePilotMCPManager | null = null;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-mcp-stdio-"));
      manager = new CodePilotMCPManager();
    });

    afterEach(async () => {
      await manager?.close().catch(() => undefined);
      manager = null;
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("connects, discovers, executes, times out, and aborts for real", async () => {
      const fixture = path.join(dir, "server.mjs");
      fs.writeFileSync(fixture, fixtureSource(), "utf8");
      await manager!.addServer({
        name: "loop",
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        enabled: true,
      });
      expect(manager!.getServerStatus("loop").status).toBe("connected");
      const tools = manager!.getTools().map((t) => t.name);
      expect(tools).toContain("ping");
      expect(tools).toContain("hang");

      const pong = await manager!.executeApprovedTool(
        "loop:ping",
        {},
        { timeoutMs: 15_000 },
      );
      expect(pong.isError).not.toBe(true);
      expect(JSON.stringify(pong.content)).toContain("pong-live");

      const slow = await manager!.executeApprovedTool(
        "loop:hang",
        {},
        { timeoutMs: 800 },
      );
      expect(slow.isError).toBe(true);
      expect(JSON.stringify(slow.content)).toContain("timed out");

      const controller = new AbortController();
      const pending = manager!.executeApprovedTool(
        "loop:hang",
        {},
        { signal: controller.signal },
      );
      controller.abort();
      const cancelled = await pending;
      expect(cancelled.isError).toBe(true);

      const res = await manager!.readResource("loop", "config://app", {
        forceApproved: true,
        timeoutMs: 15_000,
      });
      expect(res.isError).toBe(false);
      expect(res.contents[0]?.text).toBe("loopback-config");
    }, 90_000);
  },
);

describe(
  "MCP streamable-http loopback (live localhost server)",
  () => {
    let httpServer: http.Server | null = null;
    let manager: CodePilotMCPManager | null = null;
    let port = 0;

    beforeEach(async () => {
      const makeServer = () => {
        const server = new McpServer({ name: "loopback-http", version: "0.0.0" });
        server.tool("ping", async () => ({
          content: [{ type: "text", text: "pong-http" }],
        }));
        server.tool("hang", async () => new Promise(() => {}));
        return server;
      };
      // Stateful sessions: one McpServer per client session (the SDK binds
      // exactly one transport per server instance).
      const sessions = new Map<
        string,
        {
          server: McpServer;
          transport: WebStandardStreamableHTTPServerTransport;
        }
      >();
      httpServer = http.createServer(async (req, res) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = Buffer.concat(chunks);
          const sessionId = req.headers["mcp-session-id"];
          let entry =
            typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
          if (!entry) {
            const server = makeServer();
            const transport = new WebStandardStreamableHTTPServerTransport({
              onsessioninitialized: (sid) => {
                sessions.set(sid, { server, transport });
              },
              onsessionclosed: (sid) => {
                sessions.delete(sid);
                void server.close().catch(() => undefined);
              },
            });
            await server.connect(transport);
            entry = { server, transport };
          }
          const webReq = new Request(`http://127.0.0.1:${port}/mcp`, {
            method: req.method,
            headers: req.headers as Record<string, string>,
            body:
              req.method === "GET" ||
              req.method === "DELETE" ||
              body.length === 0
                ? undefined
                : body,
          });
          const webRes = await entry.transport.handleRequest(webReq);
          const headers: Record<string, string> = {};
          webRes.headers.forEach((v, k) => {
            headers[k] = v;
          });
          res.writeHead(webRes.status, headers);
          res.end(Buffer.from(await webRes.arrayBuffer()));
        } catch (err) {
          res.writeHead(500);
          res.end(
            err instanceof Error ? err.message : "loopback handler error",
          );
        }
      });
      await new Promise<void>((resolve) => {
        httpServer!.listen(0, "127.0.0.1", () => resolve());
      });
      const addr = httpServer.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      port = addr.port;
      manager = new CodePilotMCPManager();
    });

    afterEach(async () => {
      await manager?.close().catch(() => undefined);
      manager = null;
      await new Promise<void>((resolve) => {
        if (!httpServer) {
          resolve();
          return;
        }
        httpServer.close(() => resolve());
      });
      httpServer = null;
    });

    it("connects over HTTP, discovers, executes, and enforces the deadline", async () => {
      const url = `http://127.0.0.1:${port}/mcp`;
      // Loopback is explicitly permitted by the SSRF guard.
      expect(await validateMcpServerUrl(url)).toEqual({ ok: true });
      await manager!.addServer({
        name: "httploop",
        transport: "streamable-http",
        url,
        headers: { "X-Loopback-Probe": "yes" },
        enabled: true,
      });
      expect(manager!.getServerStatus("httploop").status).toBe("connected");
      expect(manager!.getTools().map((t) => t.name)).toContain("ping");

      const pong = await manager!.executeApprovedTool(
        "httploop:ping",
        {},
        { timeoutMs: 20_000 },
      );
      expect(pong.isError).not.toBe(true);
      expect(JSON.stringify(pong.content)).toContain("pong-http");

      const slow = await manager!.executeApprovedTool(
        "httploop:hang",
        {},
        { timeoutMs: 800 },
      );
      expect(slow.isError).toBe(true);
      expect(JSON.stringify(slow.content)).toContain("timed out");
    }, 90_000);
  },
);
