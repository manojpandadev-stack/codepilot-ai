/**
 * @codepilot/mcp-manager tests
 *
 * Comprehensive tests for MCP tool namespacing, approval flow,
 * permissions, timeout, cancellation, and execution.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  CodePilotMCPManager,
  MCPApprovalManager,
  createToolId,
  parseToolId,
} from "./index.js";

// ============================================================================
// Tool ID Helpers
// ============================================================================

describe("MCP Tool ID Helpers", () => {
  it("createToolId combines server and tool name", () => {
    expect(createToolId("postgres", "query")).toBe("postgres:query");
    expect(createToolId("my-server", "read_file")).toBe("my-server:read_file");
  });

  it("parseToolId splits correctly", () => {
    expect(parseToolId("postgres:query")).toEqual({
      serverName: "postgres",
      toolName: "query",
    });
    expect(parseToolId("my-server:read_file")).toEqual({
      serverName: "my-server",
      toolName: "read_file",
    });
  });

  it("parseToolId returns null for invalid IDs", () => {
    expect(parseToolId("no-colon")).toBeNull();
    expect(parseToolId(":leading")).toBeNull();
    expect(parseToolId("trailing:")).toBeNull();
    expect(parseToolId("")).toBeNull();
  });
});

// ============================================================================
// MCPApprovalManager
// ============================================================================

describe("MCPApprovalManager", () => {
  let manager: MCPApprovalManager;

  beforeEach(() => {
    manager = new MCPApprovalManager({ defaultTimeoutMs: 5000 });
  });

  it("creates a pending approval request", () => {
    const { request } = manager.requestApproval(
      "postgres",
      "query",
      { sql: "SELECT * FROM users" },
      "medium",
    );

    expect(request.requestId).toMatch(/^mcp-approval-/);
    expect(request.serverName).toBe("postgres");
    expect(request.toolName).toBe("query");
    expect(request.toolId).toBe("postgres:query");
    expect(request.status).toBe("pending");
    expect(request.riskLevel).toBe("medium");
    expect(manager.isPending(request.requestId)).toBe(true);
    expect(manager.getPendingRequests()).toHaveLength(1);
  });

  it("resolves with approval", async () => {
    const { request, promise } = manager.requestApproval(
      "fs",
      "read_file",
      { path: "/tmp/test.txt" },
    );

    setTimeout(() => {
      manager.resolveRequest(request.requestId, { approved: true, reason: "User approved" });
    }, 10);

    const resolution = await promise;
    expect(resolution.approved).toBe(true);
    expect(resolution.reason).toBe("User approved");
    expect(manager.isPending(request.requestId)).toBe(false);
  });

  it("resolves with rejection", async () => {
    const { request, promise } = manager.requestApproval(
      "fs",
      "delete_file",
      { path: "/tmp/important.txt" },
      "high",
    );

    setTimeout(() => {
      manager.resolveRequest(request.requestId, { approved: false, reason: "Too dangerous" });
    }, 10);

    const resolution = await promise;
    expect(resolution.approved).toBe(false);
    expect(resolution.reason).toBe("Too dangerous");
  });

  it("returns false for already-resolved request", () => {
    const { request } = manager.requestApproval("s", "t", {});

    manager.resolveRequest(request.requestId, { approved: true });
    expect(manager.resolveRequest(request.requestId, { approved: true })).toBe(false);
  });

  it("times out after default timeout", async () => {
    const fastManager = new MCPApprovalManager({ defaultTimeoutMs: 50 });
    const { request, promise } = fastManager.requestApproval("s", "t", {});

    const resolution = await promise;
    expect(resolution.approved).toBe(false);
    expect(resolution.reason).toContain("timed out");
    expect(request.status).toBe("expired");
    expect(fastManager.isPending(request.requestId)).toBe(false);
    fastManager.dispose();
  });

  it("times out with custom timeout", async () => {
    const { request, promise } = manager.requestApproval(
      "s",
      "t",
      {},
      "low",
      50, // 50ms
    );

    const resolution = await promise;
    expect(resolution.approved).toBe(false);
    expect(resolution.reason).toContain("timed out");
    expect(request.status).toBe("expired");
  });

  it("cancels all pending requests", async () => {
    const { request: r1, promise: p1 } = manager.requestApproval("s", "t1", {});
    const { promise: p2 } = manager.requestApproval("s", "t2", {});

    const cancelled = manager.cancelAll();
    expect(cancelled).toHaveLength(2);
    expect(cancelled[0]!.status).toBe("cancelled");
    expect(cancelled[1]!.status).toBe("cancelled");
    expect(manager.getPendingRequests()).toHaveLength(0);

    const res1 = await p1;
    expect(res1.approved).toBe(false);
    expect(res1.reason).toContain("Cancelled");

    // p2 should also resolve
    const res2 = await p2;
    expect(res2.approved).toBe(false);
    void r1; // suppress unused warning
  });

  it("cancels a specific request", async () => {
    const { request: r1 } = manager.requestApproval("s", "t1", {});
    const { request: r2, promise: p2 } = manager.requestApproval("s", "t2", {});

    const success = manager.cancelRequest(r1.requestId);
    expect(success).toBe(true);
    expect(manager.getPendingRequests()).toHaveLength(1);

    // r2 is still pending
    expect(manager.isPending(r2.requestId)).toBe(true);

    // Resolve r2
    manager.resolveRequest(r2.requestId, { approved: true });
    const res2 = await p2;
    expect(res2.approved).toBe(true);
  });

  it("returns false when cancelling non-existent request", () => {
    expect(manager.cancelRequest("non-existent-id")).toBe(false);
  });

  it("marks request as executed", () => {
    const { request } = manager.requestApproval("s", "t", {});
    manager.resolveRequest(request.requestId, { approved: true });

    manager.markExecuted(request.requestId);
    const resolved = manager.getResolvedRequests();
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved[resolved.length - 1]!.status).toBe("executed");
  });

  it("marks request as failed", () => {
    const { request } = manager.requestApproval("s", "t", {});
    manager.resolveRequest(request.requestId, { approved: true });

    manager.markFailed(request.requestId);
    const resolved = manager.getResolvedRequests();
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved[resolved.length - 1]!.status).toBe("failed");
  });

  it("cleans up on dispose", () => {
    const fastManager = new MCPApprovalManager({ defaultTimeoutMs: 50 });
    fastManager.requestApproval("s", "t", {});
    fastManager.dispose();
    expect(fastManager.getPendingRequests()).toHaveLength(0);
  });
});

// ============================================================================
// CodePilotMCPManager
// ============================================================================

describe("CodePilotMCPManager", () => {
  let manager: CodePilotMCPManager;

  beforeEach(() => {
    manager = new CodePilotMCPManager({ approvalTimeoutMs: 5000 });
  });

  // --- Server Management (unit-level, no real MCP server) ---

  it("adds and lists servers", async () => {
    await manager.addServer({
      name: "test-server",
      transport: "stdio",
      command: "echo",
      args: ["hello"],
      enabled: false,
    });

    const servers = manager.listServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]!.name).toBe("test-server");
    expect(servers[0]!.enabled).toBe(false);
  });

  it("removes a server", async () => {
    await manager.addServer({
      name: "test-server",
      transport: "stdio",
      command: "echo",
      enabled: false,
    });
    await manager.removeServer("test-server");
    expect(manager.listServers()).toHaveLength(0);
  });

  it("enables and disables servers", async () => {
    await manager.addServer({
      name: "s1",
      transport: "stdio",
      command: "echo",
      enabled: false,
    });

    expect(manager.getServer("s1")?.enabled).toBe(false);
    await manager.enableServer("s1");
    expect(manager.getServer("s1")?.enabled).toBe(true);
    await manager.disableServer("s1");
    expect(manager.getServer("s1")?.enabled).toBe(false);
  });

  // --- Tool Permissions ---

  it("sets and gets tool permission by ID", () => {
    manager.setToolPermission("postgres:query", "auto");
    expect(manager.getToolPermission("postgres:query")).toBe("auto");

    manager.setToolPermission("postgres:query", "blocked");
    expect(manager.getToolPermission("postgres:query")).toBe("blocked");
  });

  it("defaults to auto when no permission set", () => {
    expect(manager.getToolPermission("unknown:tool")).toBe("auto");
  });

  it("setServerPermission sets all tools from that server", () => {
    // Manually push tools since we can't connect to a real server
    (manager as unknown as { tools: typeof manager.getTools extends () => infer R ? R extends Array<infer T> ? T[] : never : never }).tools = [
      { id: "s1:read", name: "read", description: "", inputSchema: {}, serverName: "s1" },
      { id: "s1:write", name: "write", description: "", inputSchema: {}, serverName: "s1" },
      { id: "s2:query", name: "query", description: "", inputSchema: {}, serverName: "s2" },
    ];

    manager.setServerPermission("s1", "approval");

    expect(manager.getToolPermission("s1:read")).toBe("approval");
    expect(manager.getToolPermission("s1:write")).toBe("approval");
    expect(manager.getToolPermission("s2:query")).toBe("auto"); // unaffected
  });

  it("returns all permissions", () => {
    manager.setToolPermission("a:b", "auto");
    manager.setToolPermission("c:d", "blocked");

    const perms = manager.getAllPermissions();
    expect(perms).toHaveLength(2);
    expect(perms.find((p) => p.toolId === "a:b")?.permission).toBe("auto");
    expect(perms.find((p) => p.toolId === "c:d")?.permission).toBe("blocked");
  });

  // --- Tool Lookup ---

  it("findToolById finds the correct tool", () => {
    (manager as unknown as { tools: Array<{ id: string; name: string; description: string; inputSchema: Record<string, unknown>; serverName: string }> }).tools = [
      { id: "s1:read", name: "read", description: "Read file", inputSchema: {}, serverName: "s1" },
      { id: "s2:query", name: "query", description: "SQL query", inputSchema: {}, serverName: "s2" },
    ];

    expect(manager.findToolById("s1:read")?.description).toBe("Read file");
    expect(manager.findToolById("s2:query")?.description).toBe("SQL query");
    expect(manager.findToolById("s1:query")).toBeUndefined();
  });

  it("findTool finds by server+name", () => {
    (manager as unknown as { tools: Array<{ id: string; name: string; description: string; inputSchema: Record<string, unknown>; serverName: string }> }).tools = [
      { id: "s1:read", name: "read", description: "R", inputSchema: {}, serverName: "s1" },
      { id: "s2:read", name: "read", description: "R2", inputSchema: {}, serverName: "s2" },
    ];

    expect(manager.findTool("s1", "read")?.id).toBe("s1:read");
    expect(manager.findTool("s2", "read")?.id).toBe("s2:read");
  });

  it("tool name collisions are isolated by server namespace", () => {
    (manager as unknown as { tools: Array<{ id: string; name: string; description: string; inputSchema: Record<string, unknown>; serverName: string }> }).tools = [
      { id: "server-a:query", name: "query", description: "A", inputSchema: {}, serverName: "server-a" },
      { id: "server-b:query", name: "query", description: "B", inputSchema: {}, serverName: "server-b" },
    ];

    const toolA = manager.findToolById("server-a:query");
    const toolB = manager.findToolById("server-b:query");

    expect(toolA?.description).toBe("A");
    expect(toolB?.description).toBe("B");
    expect(toolA?.id).not.toBe(toolB?.id);
  });

  // --- Tool Execution ---

  it("returns error for unknown tool", async () => {
    const { result } = await manager.executeTool("unknown:tool", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not found");
  });

  it("blocks execution for disabled server", async () => {
    await manager.addServer({
      name: "disabled-server",
      transport: "stdio",
      command: "echo",
      enabled: false,
    });

    (manager as unknown as { tools: Array<{ id: string; name: string; description: string; inputSchema: Record<string, unknown>; serverName: string }> }).tools.push({
      id: "disabled-server:tool1",
      name: "tool1",
      description: "T1",
      inputSchema: {},
      serverName: "disabled-server",
    });

    const { result } = await manager.executeTool("disabled-server:tool1", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("disabled");
  });

  it("blocks execution for blocked permission", async () => {
    (manager as unknown as { tools: Array<{ id: string; name: string; description: string; inputSchema: Record<string, unknown>; serverName: string }>; servers: Map<string, { name: string; enabled: boolean; transport: string }> }).tools = [
      { id: "s1:dangerous", name: "dangerous", description: "", inputSchema: {}, serverName: "s1" },
    ];
    (manager as unknown as { servers: Map<string, { name: string; enabled: boolean; transport: string }> }).servers.set("s1", { name: "s1", enabled: true, transport: "stdio" });

    manager.setToolPermission("s1:dangerous", "blocked");

    const { result } = await manager.executeTool("s1:dangerous", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("blocked");
  });

  it("returns approval request for approval-required tool", async () => {
    (manager as unknown as { tools: Array<{ id: string; name: string; description: string; inputSchema: Record<string, unknown>; serverName: string }>; servers: Map<string, { name: string; enabled: boolean; transport: string }> }).tools = [
      { id: "s1:write", name: "write", description: "", inputSchema: {}, serverName: "s1" },
    ];
    (manager as unknown as { servers: Map<string, { name: string; enabled: boolean; transport: string }> }).servers.set("s1", { name: "s1", enabled: true, transport: "stdio" });

    manager.setToolPermission("s1:write", "approval");

    const { result, approvalRequest, approvalPromise } = await manager.executeTool(
      "s1:write",
      { path: "/tmp/file.txt", content: "hello" },
    );

    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain("requires approval");
    expect(approvalRequest).toBeDefined();
    expect(approvalRequest!.serverName).toBe("s1");
    expect(approvalRequest!.toolName).toBe("write");
    expect(approvalRequest!.toolId).toBe("s1:write");
    expect(approvalRequest!.status).toBe("pending");
    expect(approvalPromise).toBeDefined();

    // Clean up
    manager.getApprovalManager().cancelRequest(approvalRequest!.requestId);
  });

  it("bypasses approval when forceApproved is true", async () => {
    (manager as unknown as { tools: Array<{ id: string; name: string; description: string; inputSchema: Record<string, unknown>; serverName: string }>; servers: Map<string, { name: string; enabled: boolean; transport: string }> }).tools = [
      { id: "s1:exec", name: "exec", description: "", inputSchema: {}, serverName: "s1" },
    ];
    (manager as unknown as { servers: Map<string, { name: string; enabled: boolean; transport: string }> }).servers.set("s1", { name: "s1", enabled: true, transport: "stdio" });

    manager.setToolPermission("s1:exec", "approval");

    const { result, approvalRequest } = await manager.executeTool(
      "s1:exec",
      {},
      { forceApproved: true },
    );

    // No approval request because forceApproved bypasses it
    expect(approvalRequest).toBeUndefined();
    // Result is error because server not connected, but approval was bypassed
    expect(result.content[0]!.text).toContain("not connected");
  });

  // --- Approval Manager Access ---

  it("exposes approval manager", () => {
    const am = manager.getApprovalManager();
    expect(am).toBeInstanceOf(MCPApprovalManager);
  });

  // --- Cancel All Approvals ---

  it("cancelAllApprovals cancels pending approvals", () => {
    const cancelled = manager.cancelAllApprovals();
    expect(cancelled).toHaveLength(0); // No pending
  });

  // --- Close ---

  it("close cleans up everything", async () => {
    await manager.close();
    expect(manager.getApprovalManager().getPendingRequests()).toHaveLength(0);
  });

  // --- Audit ---

  it("records audit entries", async () => {
    (manager as unknown as { tools: Array<{ id: string; name: string; description: string; inputSchema: Record<string, unknown>; serverName: string }>; servers: Map<string, { name: string; enabled: boolean; transport: string }> }).tools = [
      { id: "s1:bad", name: "bad", description: "", inputSchema: {}, serverName: "s1" },
    ];
    (manager as unknown as { servers: Map<string, { name: string; enabled: boolean; transport: string }> }).servers.set("s1", { name: "s1", enabled: true, transport: "stdio" });
    manager.setToolPermission("s1:bad", "blocked");

    await manager.executeTool("s1:bad", {});

    const log = manager.getAuditLog();
    expect(log.length).toBeGreaterThan(0);
    expect(log[log.length - 1]!.tool).toBe("bad");
    expect(log[log.length - 1]!.action).toContain("blocked");
  });
});

// ============================================================================
// Full Approval Lifecycle
// ============================================================================

describe("MCP Full Approval Lifecycle", () => {
  it("complete flow: request → pending → approve → execute", async () => {
    const am = new MCPApprovalManager({ defaultTimeoutMs: 5000 });

    const { request, promise } = am.requestApproval(
      "postgres",
      "delete_table",
      { table: "users" },
      "high",
    );

    expect(request.status).toBe("pending");
    expect(am.isPending(request.requestId)).toBe(true);

    // Simulate user approving
    const approved = am.resolveRequest(request.requestId, {
      approved: true,
      reason: "Confirmed by admin",
    });
    expect(approved).toBe(true);

    const resolution = await promise;
    expect(resolution.approved).toBe(true);

    // Mark as executed
    am.markExecuted(request.requestId);
    const resolved = am.getResolvedRequests();
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved[resolved.length - 1]!.status).toBe("executed");

    am.dispose();
  });

  it("complete flow: request → pending → reject", async () => {
    const am = new MCPApprovalManager({ defaultTimeoutMs: 5000 });

    const { request, promise } = am.requestApproval(
      "fs",
      "delete_file",
      { path: "/etc/passwd" },
      "high",
    );

    const approved = am.resolveRequest(request.requestId, {
      approved: false,
      reason: "Destructive operation denied",
    });
    expect(approved).toBe(true);

    const resolution = await promise;
    expect(resolution.approved).toBe(false);
    expect(resolution.reason).toContain("denied");

    am.dispose();
  });

  it("complete flow: request → timeout → auto-reject", async () => {
    const am = new MCPApprovalManager({ defaultTimeoutMs: 30 });

    const { request, promise } = am.requestApproval("s", "t", {});

    const resolution = await promise;
    expect(resolution.approved).toBe(false);
    expect(resolution.reason).toContain("timed out");
    expect(request.status).toBe("expired");

    am.dispose();
  });

  it("complete flow: request → cancel → rejected", async () => {
    const am = new MCPApprovalManager({ defaultTimeoutMs: 5000 });

    const { promise } = am.requestApproval("s", "t", {});

    am.cancelAll();
    const resolution = await promise;
    expect(resolution.approved).toBe(false);
    expect(resolution.reason).toContain("Cancelled");

    am.dispose();
  });
});
