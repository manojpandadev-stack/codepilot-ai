/**
 * @codepilot/mcp-manager
 *
 * MCP server management for CodePilot AI.
 * Wraps the @modelcontextprotocol/sdk with CodePilot-specific
 * namespacing, approval flow, permission management, and audit logging.
 *
 * Tool identity is ALWAYS `serverName:toolName` to avoid collisions.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { lookup as dnsLookup } from "node:dns/promises";
import { scrubSecretsText } from "@codepilot/shared";

export {
  MCPConfigStore,
  REDACTED_ENV_PLACEHOLDER,
  redactEnvForPersistence,
  restoreEnvFromPersistence,
  redactHeadersForPersistence,
} from "./config-store.js";

// ============================================================================
// Types
// ============================================================================

export interface MCPServerConfig {
  name: string;
  transport: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Extra HTTP headers for remote transports (e.g. gateway tokens).
   * Treated as secrets: redacted on persistence like env values.
   */
  headers?: Record<string, string>;
  url?: string;
  enabled: boolean;
  /** Execution timeout for tool calls in ms (default below). */
  timeout?: number;
  /**
   * Deadline for the initialize/connect handshake (ms). A server that starts
   * but never completes the MCP handshake must not hang the host.
   */
  connectTimeoutMs?: number;
}

/** Default deadline for one MCP tool call (server `timeout` overrides). */
export const DEFAULT_MCP_CALL_TIMEOUT_MS = 120_000;
/** Default deadline for the initialize/connect handshake. */
export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 15_000;

export interface MCPTool {
  /** Globally unique: `serverName:toolName` */
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName: string;
}

export interface MCPToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export type MCPServerHealthStatus = "connected" | "disconnected" | "error";

export interface MCPServerHealth {
  status: MCPServerHealthStatus;
  connectedAt?: number;
  toolCount: number;
  lastError?: string;
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPPrompt {
  name: string;
  description?: string;
}

export type ToolPermissionLevel = "auto" | "approval" | "blocked";

export interface ToolPermissionPolicy {
  toolId: string;
  permission: ToolPermissionLevel;
}

// ---- Approval Types ----

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled"
  | "executed"
  | "failed";

export interface MCPApprovalRequest {
  requestId: string;
  serverName: string;
  toolName: string;
  toolId: string;
  arguments: Record<string, unknown>;
  riskLevel: "low" | "medium" | "high";
  createdAt: number;
  timeoutMs: number;
  status: ApprovalStatus;
}

export interface MCPApprovalResolution {
  approved: boolean;
  reason?: string;
}

// ============================================================================
// MCP Approval Manager
// ============================================================================

export class MCPApprovalManager {
  private pendingRequests = new Map<
    string,
    {
      request: MCPApprovalRequest;
      resolve: (resolution: MCPApprovalResolution) => void;
      timer: ReturnType<typeof setTimeout> | null;
    }
  >();

  private resolvedRequests: MCPApprovalRequest[] = [];
  private defaultTimeoutMs: number;

  constructor(options?: { defaultTimeoutMs?: number }) {
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Create a new approval request and return a Promise that resolves
   * when the user approves/rejects, or the request times out / is cancelled.
   */
  requestApproval(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    riskLevel: "low" | "medium" | "high" = "medium",
    timeoutMs?: number,
  ): { request: MCPApprovalRequest; promise: Promise<MCPApprovalResolution> } {
    const toolId = `${serverName}:${toolName}`;
    const actualTimeout = timeoutMs ?? this.defaultTimeoutMs;

    const request: MCPApprovalRequest = {
      requestId: `mcp-approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      serverName,
      toolName,
      toolId,
      arguments: args,
      riskLevel,
      createdAt: Date.now(),
      timeoutMs: actualTimeout,
      status: "pending",
    };

    const promise = new Promise<MCPApprovalResolution>((resolve) => {
      const timer = setTimeout(() => {
        request.status = "expired";
        this.pendingRequests.delete(request.requestId);
        this.resolvedRequests.push(request);
        resolve({ approved: false, reason: "Approval request timed out" });
      }, actualTimeout);

      this.pendingRequests.set(request.requestId, {
        request,
        resolve,
        timer,
      });
    });

    return { request, promise };
  }

  /**
   * Resolve a pending approval request (called when user clicks Approve/Reject).
   * Returns false if the request was already resolved/cancelled/expired.
   */
  resolveRequest(
    requestId: string,
    resolution: MCPApprovalResolution,
  ): boolean {
    const entry = this.pendingRequests.get(requestId);
    if (!entry) return false; // Already resolved, expired, or cancelled

    // Clear the timeout timer
    if (entry.timer) clearTimeout(entry.timer);

    entry.request.status = resolution.approved ? "approved" : "rejected";
    this.resolvedRequests.push(entry.request);
    this.pendingRequests.delete(requestId);
    entry.resolve(resolution);
    return true;
  }

  /**
   * Cancel all pending approval requests (called when agent is stopped).
   */
  cancelAll(): MCPApprovalRequest[] {
    const cancelled: MCPApprovalRequest[] = [];

    for (const [, entry] of this.pendingRequests) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.request.status = "cancelled";
      this.resolvedRequests.push(entry.request);
      entry.resolve({ approved: false, reason: "Cancelled by user" });
      cancelled.push(entry.request);
    }

    this.pendingRequests.clear();
    return cancelled;
  }

  /**
   * Cancel a specific approval request.
   */
  cancelRequest(requestId: string): boolean {
    const entry = this.pendingRequests.get(requestId);
    if (!entry) return false;

    if (entry.timer) clearTimeout(entry.timer);
    entry.request.status = "cancelled";
    this.resolvedRequests.push(entry.request);
    this.pendingRequests.delete(requestId);
    entry.resolve({ approved: false, reason: "Cancelled" });
    return true;
  }

  /**
   * Mark an approved request as executed.
   */
  markExecuted(requestId: string): void {
    const req = this.resolvedRequests.find((r) => r.requestId === requestId);
    if (req && req.status === "approved") {
      req.status = "executed";
    }
  }

  /**
   * Mark an approved request as failed.
   */
  markFailed(requestId: string): void {
    const req = this.resolvedRequests.find((r) => r.requestId === requestId);
    if (req && req.status === "approved") {
      req.status = "failed";
    }
  }

  /**
   * Get all currently pending approval requests.
   */
  getPendingRequests(): MCPApprovalRequest[] {
    return Array.from(this.pendingRequests.values()).map((e) => e.request);
  }

  /**
   * Get resolved (non-pending) requests.
   */
  getResolvedRequests(limit = 50): MCPApprovalRequest[] {
    return this.resolvedRequests.slice(-limit);
  }

  /**
   * Check if a specific request is still pending.
   */
  isPending(requestId: string): boolean {
    return this.pendingRequests.has(requestId);
  }

  /**
   * Clean up all timers.
   */
  dispose(): void {
    for (const [, entry] of this.pendingRequests) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.pendingRequests.clear();
  }
}

// ============================================================================
// MCP Manager
// ============================================================================

export class CodePilotMCPManager {
  private servers = new Map<string, MCPServerConfig>();
  private clients = new Map<string, Client>();
  private tools: MCPTool[] = [];
  private toolPermissions: Map<string, ToolPermissionLevel> = new Map();
  private approvalManager: MCPApprovalManager;
  private auditLog: AuditEntry[] = [];
  private health = new Map<string, MCPServerHealth>();
  private resources = new Map<string, MCPResource[]>();
  private prompts = new Map<string, MCPPrompt[]>();

  constructor(options?: { approvalTimeoutMs?: number }) {
    this.approvalManager = new MCPApprovalManager({
      defaultTimeoutMs: options?.approvalTimeoutMs,
    });
  }

  // ---- Server Management ----

  async addServer(config: MCPServerConfig): Promise<void> {
    this.servers.set(config.name, config);
    this.health.set(config.name, {
      status: "disconnected",
      toolCount: 0,
    });
    if (config.enabled) {
      await this.connectServer(config.name);
    }
  }

  async removeServer(name: string): Promise<void> {
    await this.disconnectServer(name);
    this.servers.delete(name);
    this.tools = this.tools.filter((t) => t.serverName !== name);
    this.health.delete(name);
    this.resources.delete(name);
    this.prompts.delete(name);
  }

  async enableServer(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (server) {
      server.enabled = true;
      await this.connectServer(name);
    }
  }

  async disableServer(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (server) {
      server.enabled = false;
      await this.disconnectServer(name);
    }
  }

  /** Reconnect a server (disconnect + connect). Returns the new state. */
  async reconnect(name: string): Promise<MCPServerHealth> {
    await this.disconnectServer(name);
    await this.connectServer(name);
    return this.getServerStatus(name);
  }

  listServers(): MCPServerConfig[] {
    return Array.from(this.servers.values());
  }

  getServer(name: string): MCPServerConfig | undefined {
    return this.servers.get(name);
  }

  // ---- Connection ----

  async connectServer(name: string): Promise<boolean> {
    const config = this.servers.get(name);
    if (!config || !config.enabled) return false;

    let client: Client;
    try {
      client = await this.createConnectedClient(config);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.health.set(name, {
        status: "error",
        toolCount: 0,
        lastError: msg,
      });
      this.audit({
        timestamp: Date.now(),
        server: name,
        tool: "*",
        action: "connect_failed",
        detail: msg,
      });
      return false;
    }

    this.clients.set(name, client);
    await this.afterConnect(name, config, client);
    return true;
  }

  /**
   * Build the transport for a server config and connect a client.
   * Unsupported or misconfigured transports throw explicitly — never a
   * silent fallback to a different transport type.
   */
  private async createConnectedClient(
    config: MCPServerConfig,
  ): Promise<Client> {
    const connectDeadline =
      config.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS;
    const connectWithDeadline = async (
      transport: Parameters<Client["connect"]>[0],
    ): Promise<Client> => {
      const client = new Client({ name: "codepilot-ai", version: "0.1.0" });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          client.connect(transport),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `MCP server '${config.name}' connect deadline exceeded (${connectDeadline}ms) — handshake never completed`,
                  ),
                ),
              connectDeadline,
            );
          }),
        ]);
        return client;
      } catch (err) {
        try {
          await client.close();
        } catch {
          // Ignore — the transport is already broken.
        }
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    if (config.transport === "stdio") {
      if (!config.command) {
        throw new Error(
          `stdio transport requires a command for server '${config.name}'`,
        );
      }
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: config.env as Record<string, string>,
      });
      return connectWithDeadline(transport);
    }

    if (config.transport === "streamable-http") {
      if (!config.url || !/^https?:\/\//i.test(config.url)) {
        throw new Error(
          `streamable-http transport requires an http(s) url for server '${config.name}'`,
        );
      }
      const verdict = await validateMcpServerUrl(config.url);
      if (!verdict.ok) {
        throw new Error(
          `MCP server '${config.name}' URL rejected: ${verdict.reason}`,
        );
      }
      const transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: buildHttpHeaders(config) },
      });
      return connectWithDeadline(transport);
    }

    if (config.transport === "sse") {
      if (!config.url || !/^https?:\/\//i.test(config.url)) {
        throw new Error(
          `sse transport requires an http(s) url for server '${config.name}'`,
        );
      }
      const verdict = await validateMcpServerUrl(config.url);
      if (!verdict.ok) {
        throw new Error(
          `MCP server '${config.name}' URL rejected: ${verdict.reason}`,
        );
      }
      const transport = new SSEClientTransport(new URL(config.url), {
        requestInit: { headers: buildHttpHeaders(config) },
      });
      return connectWithDeadline(transport);
    }

    throw new Error(
      `unsupported MCP transport '${String(config.transport)}' for server '${config.name}'`,
    );
  }

  /** Shared post-connect discovery: tools, resources, prompts, health, audit. */
  private async afterConnect(
    name: string,
    _config: MCPServerConfig,
    client: Client,
  ): Promise<void> {
    const response = await client.listTools();
    for (const tool of response.tools) {
      const toolName = tool.name;
      const toolId = `${name}:${toolName}`;
      this.tools.push({
        id: toolId,
        name: toolName,
        description: tool.description ?? "",
        inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {},
        serverName: name,
      });
    }

    this.health.set(name, {
      status: "connected",
      connectedAt: Date.now(),
      toolCount: response.tools.length,
    });

    // Optional capability discovery: resources and prompts.
    try {
      const res = await client.listResources();
      this.resources.set(
        name,
        res.resources.map((r) => ({
          uri: r.uri,
          name: r.name ?? "",
          description: r.description ?? undefined,
          mimeType: r.mimeType ?? undefined,
        })),
      );
    } catch {
      this.resources.set(name, []);
    }
    try {
      const prompts = await client.listPrompts();
      this.prompts.set(
        name,
        prompts.prompts.map((p) => ({
          name: p.name,
          description: p.description ?? undefined,
        })),
      );
    } catch {
      this.prompts.set(name, []);
    }

    this.audit({
      timestamp: Date.now(),
      server: name,
      tool: "*",
      action: "connected",
      detail: `Discovered ${response.tools.length} tools`,
    });
  }

  async disconnectServer(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client) {
      try {
        await client.close();
      } catch {
        // Ignore close errors
      }
      this.clients.delete(name);
    }
    this.health.set(name, { status: "disconnected", toolCount: 0 });
    this.resources.delete(name);
    this.prompts.delete(name);
  }

  // ---- Tool Discovery ----

  getTools(): MCPTool[] {
    return [...this.tools];
  }

  getToolsForServer(serverName: string): MCPTool[] {
    return this.tools.filter((t) => t.serverName === serverName);
  }

  /**
   * Find a tool by its globally unique ID (serverName:toolName).
   */
  findToolById(toolId: string): MCPTool | undefined {
    return this.tools.find((t) => t.id === toolId);
  }

  /**
   * Find a tool by server name + tool name.
   */
  findTool(serverName: string, toolName: string): MCPTool | undefined {
    return this.tools.find(
      (t) => t.serverName === serverName && t.name === toolName,
    );
  }

  // ---- Tool Execution ----

  /**
   * Execute an MCP tool by its globally unique ID.
   * Respects permissions, approval flow, and server connectivity.
   *
   * For "approval" tools: returns a pending request + promise
   * that the caller must resolve through the approval manager.
   */
  async executeTool(
    toolId: string,
    input: Record<string, unknown>,
    options?: {
      /** If true, skip approval (e.g. already approved). Force-apply is separate from auto. */
      forceApproved?: boolean;
      /** Risk level override for approval flow */
      riskLevel?: "low" | "medium" | "high";
      /** Custom timeout for approval (ms) */
      approvalTimeoutMs?: number;
      /** Deadline for the tool call itself (default: server timeout or 120s). */
      timeoutMs?: number;
      /** Aborts the in-flight tool call. */
      signal?: AbortSignal;
    },
  ): Promise<{
    result: MCPToolResult;
    approvalRequest?: MCPApprovalRequest;
    approvalPromise?: Promise<MCPApprovalResolution>;
  }> {
    const tool = this.findToolById(toolId);
    if (!tool) {
      return {
        result: {
          content: [{ type: "text", text: `MCP tool not found: ${toolId}` }],
          isError: true,
        },
      };
    }

    // Check if server is disabled
    const serverConfig = this.servers.get(tool.serverName);
    if (!serverConfig?.enabled) {
      this.audit({
        timestamp: Date.now(),
        server: tool.serverName,
        tool: tool.name,
        action: "blocked_server_disabled",
      });
      return {
        result: {
          content: [
            {
              type: "text",
              text: `MCP server '${tool.serverName}' is disabled`,
            },
          ],
          isError: true,
        },
      };
    }

    // Check permission via PolicyEngine-compatible lookup
    const permission = this.getToolPermission(toolId);

    if (permission === "blocked") {
      this.audit({
        timestamp: Date.now(),
        server: tool.serverName,
        tool: tool.name,
        action: "blocked_by_policy",
      });
      return {
        result: {
          content: [
            {
              type: "text",
              text: `MCP tool '${toolId}' is blocked by security policy`,
            },
          ],
          isError: true,
        },
      };
    }

    if (permission === "approval" && !options?.forceApproved) {
      // Create approval request — caller must resolve through WebView
      const { request, promise } = this.approvalManager.requestApproval(
        tool.serverName,
        tool.name,
        input,
        options?.riskLevel ?? "medium",
        options?.approvalTimeoutMs,
      );

      this.audit({
        timestamp: Date.now(),
        server: tool.serverName,
        tool: tool.name,
        action: "approval_required",
        detail: request.requestId,
      });

      return {
        result: {
          content: [
            { type: "text", text: `MCP tool '${toolId}' requires approval` },
          ],
          isError: false,
        },
        approvalRequest: request,
        approvalPromise: promise,
      };
    }

    // Execute immediately (auto-approved or force-approved)
    return {
      result: await this.callToolDirect(tool, input, {
        ...(options?.timeoutMs !== undefined
          ? { timeoutMs: options.timeoutMs }
          : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      }),
    };
  }

  /**
   * Directly execute an MCP tool (after approval has been obtained).
   */
  async executeApprovedTool(
    toolId: string,
    input: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<MCPToolResult> {
    const tool = this.findToolById(toolId);
    if (!tool) {
      return {
        content: [{ type: "text", text: `MCP tool not found: ${toolId}` }],
        isError: true,
      };
    }
    return this.callToolDirect(tool, input, options);
  }

  /**
   * Race one MCP operation against a deadline and an abort signal.
   * Shared by tool calls and resource reads so a hung server can neither
   * wedge the caller nor outlive cancellation.
   */
  private withMcpDeadline<T>(
    operation: Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ result: T } | { timedOut: true } | { aborted: true }> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutGate = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      if (timer.unref) timer.unref();
    });
    const abortGate =
      signal === undefined
        ? null
        : new Promise<{ aborted: true }>((resolve) => {
            if (signal.aborted) {
              resolve({ aborted: true });
              return;
            }
            signal.addEventListener(
              "abort",
              () => resolve({ aborted: true }),
              { once: true },
            );
          });
    return Promise.race([
      operation.then((result) => ({ result })),
      timeoutGate,
      ...(abortGate ? [abortGate] : []),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /**
   * Core tool call to the MCP server.
   *
   * Bounded by a deadline (server `timeout` or the 120s default) and
   * abortable via `signal`: a hung server can neither wedge the caller
   * nor outlive cancellation. Timeouts and aborts are audited and surface
   * as errors, never hangs.
   */
  private async callToolDirect(
    tool: MCPTool,
    input: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<MCPToolResult> {
    const client = this.clients.get(tool.serverName);
    if (!client) {
      this.audit({
        timestamp: Date.now(),
        server: tool.serverName,
        tool: tool.name,
        action: "server_not_connected",
      });
      return {
        content: [
          {
            type: "text",
            text: `MCP server not connected: ${tool.serverName}`,
          },
        ],
        isError: true,
      };
    }

    const serverConfig = this.servers.get(tool.serverName);
    const timeoutMs =
      options?.timeoutMs ?? serverConfig?.timeout ?? DEFAULT_MCP_CALL_TIMEOUT_MS;

    try {
      const outcome = await this.withMcpDeadline(
        client.callTool({
          name: tool.name,
          arguments: input,
        }),
        timeoutMs,
        options?.signal,
      );
      if ("timedOut" in outcome) {
        this.audit({
          timestamp: Date.now(),
          server: tool.serverName,
          tool: tool.name,
          action: "timeout",
          detail: `no response within ${timeoutMs}ms`,
        });
        return {
          content: [
            {
              type: "text",
              text: `MCP tool '${tool.name}' timed out after ${timeoutMs}ms`,
            },
          ],
          isError: true,
        };
      }
      if ("aborted" in outcome) {
        this.audit({
          timestamp: Date.now(),
          server: tool.serverName,
          tool: tool.name,
          action: "cancelled",
        });
        return {
          content: [
            { type: "text", text: `MCP tool '${tool.name}' was cancelled` },
          ],
          isError: true,
        };
      }
      const call = outcome.result;
      this.audit({
        timestamp: Date.now(),
        server: tool.serverName,
        tool: tool.name,
        action: "success",
      });
      return {
        content:
          (call.content as Array<{ type: string; text?: string }>) ?? [],
        isError: call.isError as boolean | undefined,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.audit({
        timestamp: Date.now(),
        server: tool.serverName,
        tool: tool.name,
        action: "error",
        detail: msg,
      });
      return {
        content: [{ type: "text", text: msg }],
        isError: true,
      };
    }
  }

  // ---- Permissions ----

  /**
   * Set permission for a tool by its globally unique ID.
   */
  setToolPermission(toolId: string, permission: ToolPermissionLevel): void {
    this.toolPermissions.set(toolId, permission);
  }

  /**
   * Set permission for all tools from a given server.
   */
  setServerPermission(
    serverName: string,
    permission: ToolPermissionLevel,
  ): void {
    for (const tool of this.tools) {
      if (tool.serverName === serverName) {
        this.toolPermissions.set(tool.id, permission);
      }
    }
  }

  /**
   * Get permission for a tool by its globally unique ID.
   * Falls back to server-level permission, then "auto".
   */
  getToolPermission(toolId: string): ToolPermissionLevel {
    // Check exact tool-level permission first
    const toolLevel = this.toolPermissions.get(toolId);
    if (toolLevel) return toolLevel;

    // Check server-level permission
    const tool = this.findToolById(toolId);
    if (tool) {
      const serverLevel = this.toolPermissions.get(`server:${tool.serverName}`);
      if (serverLevel) return serverLevel;
    }

    return "auto";
  }

  /**
   * Get all permission settings.
   */
  getAllPermissions(): ToolPermissionPolicy[] {
    const result: ToolPermissionPolicy[] = [];
    for (const [toolId, permission] of this.toolPermissions) {
      result.push({ toolId, permission });
    }
    return result;
  }

  // ---- Health, Resources and Prompts ----

  /** Current health of a server (undefined when the server is unknown). */
  getServerStatus(name: string): MCPServerHealth {
    return this.health.get(name) ?? { status: "disconnected", toolCount: 0 };
  }

  /** Health for every configured server. */
  listServerStatuses(): Array<{ name: string; health: MCPServerHealth }> {
    return Array.from(this.servers.keys()).map((name) => ({
      name,
      health: this.getServerStatus(name),
    }));
  }

  /** Resources exposed by a connected server. */
  listResources(name: string): MCPResource[] {
    return this.resources.get(name) ?? [];
  }

  /** Read a resource from a connected server (requires approval). */
  async readResource(
    name: string,
    uri: string,
    options?: {
      forceApproved?: boolean;
      riskLevel?: "low" | "medium" | "high";
      approvalTimeoutMs?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<{
    contents: Array<{ uri: string; text?: string; mimeType?: string }>;
    isError: boolean;
    approvalRequest?: MCPApprovalRequest;
    approvalPromise?: Promise<MCPApprovalResolution>;
  }> {
    const client = this.clients.get(name);
    if (!client) {
      return { contents: [], isError: true };
    }
    const permission = this.getToolPermission(`server:${name}`);
    if (permission === "blocked" && !options?.forceApproved) {
      this.audit({
        timestamp: Date.now(),
        server: name,
        tool: "resource",
        action: "blocked_by_policy",
      });
      return { contents: [], isError: true };
    }
    // Approval parity with tool execution: resource reads expose
    // server-side data and must pass the same user decision.
    if (permission === "approval" && !options?.forceApproved) {
      const { request, promise } = this.approvalManager.requestApproval(
        name,
        "resource",
        { uri },
        options?.riskLevel ?? "medium",
        options?.approvalTimeoutMs,
      );
      this.audit({
        timestamp: Date.now(),
        server: name,
        tool: "resource",
        action: "approval_required",
        detail: request.requestId,
      });
      return { contents: [], isError: false, approvalRequest: request, approvalPromise: promise };
    }
    try {
      const outcome = await this.withMcpDeadline(
        client.readResource({ uri }),
        options?.timeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS,
        options?.signal,
      );
      if ("timedOut" in outcome || "aborted" in outcome) {
        this.audit({
          timestamp: Date.now(),
          server: name,
          tool: "resource",
          action: "timedOut" in outcome ? "timeout" : "cancelled",
        });
        return { contents: [], isError: true };
      }
      const contents = (outcome.result.contents ?? []).map((c) => ({
        uri: c.uri,
        text: "text" in c && typeof c.text === "string" ? c.text : undefined,
        mimeType: c.mimeType ?? undefined,
      }));
      return { contents, isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.audit({
        timestamp: Date.now(),
        server: name,
        tool: "*",
        action: "resource_read_failed",
        detail: msg,
      });
      return { contents: [], isError: true };
    }
  }

  /** Prompts exposed by a connected server. */
  listPrompts(name: string): MCPPrompt[] {
    return this.prompts.get(name) ?? [];
  }

  // ---- Approval Manager Access ----

  getApprovalManager(): MCPApprovalManager {
    return this.approvalManager;
  }

  // ---- Audit ----

  private audit(entry: AuditEntry): void {
    // Detail carries raw error text/URLs — scrub secret-shaped fragments
    // before the record lands in the ring.
    const safe: AuditEntry = {
      ...entry,
      ...(entry.detail !== undefined
        ? { detail: scrubSecretsText(entry.detail).slice(0, 2000) }
        : {}),
    };
    this.auditLog.push(safe);
    if (this.auditLog.length > 1000) {
      this.auditLog = this.auditLog.slice(-1000);
    }
  }

  getAuditLog(limit = 50): AuditEntry[] {
    return this.auditLog.slice(-limit);
  }

  // ---- Cleanup ----

  async close(): Promise<void> {
    this.approvalManager.cancelAll();
    this.approvalManager.dispose();
    for (const [name] of this.clients) {
      await this.disconnectServer(name);
    }
  }

  cancelAllApprovals(): MCPApprovalRequest[] {
    return this.approvalManager.cancelAll();
  }
}

// ============================================================================
// Audit Types
// ============================================================================

export interface AuditEntry {
  timestamp: number;
  server: string;
  tool: string;
  action: string;
  detail?: string;
}

// ============================================================================
// MCP Tool ID Helpers
// ============================================================================

/**
 * Create a globally unique MCP tool ID from server name + tool name.
 */
export function createToolId(serverName: string, toolName: string): string {
  return `${serverName}:${toolName}`;
}

/**
 * Parse a tool ID back into server name + tool name.
 * Returns null if the format is invalid.
 */
export function parseToolId(
  toolId: string,
): { serverName: string; toolName: string } | null {
  const idx = toolId.indexOf(":");
  if (idx <= 0 || idx >= toolId.length - 1) return null;
  return {
    serverName: toolId.slice(0, idx),
    toolName: toolId.slice(idx + 1),
  };
}

/**
 * HTTP transport headers: only non-secret config fields (a bearer token
 * supplied via the redacted env round-trip) are forwarded. Env values that
 * were persisted redacted are restored by MCPConfigStore before connect.
 */
function buildHttpHeaders(config: MCPServerConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = config.env?.["MCP_AUTH_TOKEN"];
  if (token && token !== "[REDACTED]") {
    headers["Authorization"] = `Bearer ${token}`;
  }
  // Operator-supplied custom headers (e.g. gateway keys). Values are
  // treated as secrets everywhere downstream (redacted persistence, never
  // logged verbatim).
  for (const [key, value] of Object.entries(config.headers ?? {})) {
    if (typeof key === "string" && typeof value === "string" && key && value) {
      headers[key] = value;
    }
  }
  return headers;
}

/**
 * Hostnames/IP literals that must never be an MCP remote endpoint:
 * cloud metadata services (credential theft). Loopback and private ranges
 * are ALLOWED — operators explicitly configure local/dev servers, and
 * localhost MCP servers are the common case.
 */
const MCP_FORBIDDEN_HOSTS: readonly string[] = [
  "169.254.169.254",
  "169.254.169.123",
  "100.100.100.200",
  "metadata.google.internal",
  "metadata.google.internal.",
  "[::ffff:169.254.169.254]",
  "[::ffff:a9fe:a9fe]",
];

const MCP_FORBIDDEN_IPV6: readonly string[] = [
  "::ffff:169.254.169.254",
  "::ffff:169.254.169.123",
  "::ffff:100.100.100.200",
];

/** Resolver shape (injectable for deterministic tests). */
export type MCPDnsResolver = (
  hostname: string,
) => Promise<Array<{ address: string }>>;

async function defaultMcpDnsResolver(
  hostname: string,
): Promise<Array<{ address: string }>> {
  const records = await dnsLookup(hostname, { all: true });
  return records.map((r) => ({ address: r.address }));
}

function normalizeMcpHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

function isMcpForbiddenLiteral(host: string): boolean {
  const h = normalizeMcpHost(host);
  if ((MCP_FORBIDDEN_HOSTS as readonly string[]).includes(h)) return true;
  // Bracketed IPv6 literals.
  const unbracketed = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if ((MCP_FORBIDDEN_IPV6 as readonly string[]).includes(unbracketed)) {
    return true;
  }
  return false;
}

/**
 * Validate a remote MCP server URL before connecting.
 *
 * - http(s) only, no credentials in the URL (userinfo rejected).
 * - Cloud-metadata endpoints rejected textually (no DNS needed).
 * - The hostname is resolved and every address re-checked: metadata hits
 *   reject (DNS-rebinding guard). Resolution failure rejects fail-closed.
 * - Loopback/private addresses are permitted: the operator configures MCP
 *   servers explicitly, and local servers are the norm.
 */
export async function validateMcpServerUrl(
  url: string,
  resolve: MCPDnsResolver = defaultMcpDnsResolver,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "invalid MCP server URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `MCP URL protocol ${parsed.protocol} not allowed (http/https only)`,
    };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "credentials in MCP server URL are not allowed" };
  }
  if (isMcpForbiddenLiteral(parsed.hostname)) {
    return {
      ok: false,
      reason: `MCP server host ${parsed.hostname} is forbidden (metadata endpoint)`,
    };
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolve(parsed.hostname);
  } catch {
    return {
      ok: false,
      reason: `MCP server host ${parsed.hostname} does not resolve`,
    };
  }
  if (addresses.length === 0) {
    return {
      ok: false,
      reason: `MCP server host ${parsed.hostname} does not resolve`,
    };
  }
  for (const { address } of addresses) {
    if (isMcpForbiddenLiteral(address)) {
      return {
        ok: false,
        reason: `MCP server host ${parsed.hostname} resolves to a forbidden metadata address`,
      };
    }
  }
  return { ok: true };
}
