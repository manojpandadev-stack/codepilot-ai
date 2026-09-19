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

export {
  MCPConfigStore,
  REDACTED_ENV_PLACEHOLDER,
  redactEnvForPersistence,
  restoreEnvFromPersistence,
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
  url?: string;
  enabled: boolean;
  timeout?: number;
}

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
      const client = new Client({ name: "codepilot-ai", version: "0.1.0" });
      await client.connect(transport);
      return client;
    }

    if (config.transport === "streamable-http") {
      if (!config.url || !/^https?:\/\//i.test(config.url)) {
        throw new Error(
          `streamable-http transport requires an http(s) url for server '${config.name}'`,
        );
      }
      const transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: buildHttpHeaders(config) },
      });
      const client = new Client({ name: "codepilot-ai", version: "0.1.0" });
      await client.connect(transport);
      return client;
    }

    if (config.transport === "sse") {
      if (!config.url || !/^https?:\/\//i.test(config.url)) {
        throw new Error(
          `sse transport requires an http(s) url for server '${config.name}'`,
        );
      }
      const transport = new SSEClientTransport(new URL(config.url), {
        requestInit: { headers: buildHttpHeaders(config) },
      });
      const client = new Client({ name: "codepilot-ai", version: "0.1.0" });
      await client.connect(transport);
      return client;
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
      result: await this.callToolDirect(tool, input),
    };
  }

  /**
   * Directly execute an MCP tool (after approval has been obtained).
   */
  async executeApprovedTool(
    toolId: string,
    input: Record<string, unknown>,
  ): Promise<MCPToolResult> {
    const tool = this.findToolById(toolId);
    if (!tool) {
      return {
        content: [{ type: "text", text: `MCP tool not found: ${toolId}` }],
        isError: true,
      };
    }
    return this.callToolDirect(tool, input);
  }

  /**
   * Core tool call to the MCP server.
   */
  private async callToolDirect(
    tool: MCPTool,
    input: Record<string, unknown>,
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

    try {
      const result = await client.callTool({
        name: tool.name,
        arguments: input,
      });
      this.audit({
        timestamp: Date.now(),
        server: tool.serverName,
        tool: tool.name,
        action: "success",
      });
      return {
        content:
          (result.content as Array<{ type: string; text?: string }>) ?? [],
        isError: result.isError as boolean | undefined,
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
    options?: { forceApproved?: boolean },
  ): Promise<{
    contents: Array<{ uri: string; text?: string; mimeType?: string }>;
    isError: boolean;
  }> {
    const client = this.clients.get(name);
    if (!client) {
      return { contents: [], isError: true };
    }
    const permission = this.getToolPermission(`server:${name}`);
    if (permission === "blocked" && !options?.forceApproved) {
      return { contents: [], isError: true };
    }
    try {
      const result = await client.readResource({ uri });
      const contents = (result.contents ?? []).map((c) => ({
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
    this.auditLog.push(entry);
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
  return headers;
}
