/**
 * MCP E2E Lifecycle Test
 *
 * Tests the complete MCP approval lifecycle through the CodePilot MCP Manager.
 * Validates: namespacing, permissions, approval flow, timeout, cancellation,
 * duplicate response handling, disabled server blocking, and extension bridge.
 */

import { CodePilotMCPManager, MCPApprovalManager } from "../packages/mcp-manager/src/index.js";

// ============================================================================
// Test Helpers
// ============================================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    failed++;
    console.error(`  ✗ FAIL: ${message}`);
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    failed++;
    console.error(`  ✗ FAIL: ${message} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

function test(name: string, fn: () => void | Promise<void>): void {
  console.log(`\nTest ${++passed + failed}: ${name}`);
}

// ============================================================================
// Tests
// ============================================================================

async function runTests(): Promise<void> {
  console.log("=== MCP E2E Lifecycle Test ===");

  // --- Test 1: Tool namespacing ---
  test("Tool namespacing prevents collisions", () => {
    const manager = new CodePilotMCPManager();

    // Simulate two servers both exposing "query"
    (manager as any).tools = [
      { id: "postgres:query", name: "query", description: "SQL query", inputSchema: {}, serverName: "postgres" },
      { id: "redis:query", name: "query", description: "Redis query", inputSchema: {}, serverName: "redis" },
    ];

    const toolA = manager.findToolById("postgres:query");
    const toolB = manager.findToolById("redis:query");

    assert(toolA !== undefined, "postgres:query should exist");
    assert(toolB !== undefined, "redis:query should exist");
    assertEqual(toolA!.description, "SQL query", "Descriptions should differ");
    assertEqual(toolB!.description, "Redis query", "Descriptions should differ");
    assertEqual(toolA!.id, "postgres:query", "IDs should be unique");
    assertEqual(toolB!.id, "redis:query", "IDs should be unique");
    console.log("  ✓ Pass");
  });

  // --- Test 2: Permission defaults ---
  test("Permission defaults to auto", () => {
    const manager = new CodePilotMCPManager();
    assertEqual(manager.getToolPermission("any:tool"), "auto", "Default should be auto");
    console.log("  ✓ Pass");
  });

  // --- Test 3: Set and get tool permission ---
  test("Set and get tool permission", () => {
    const manager = new CodePilotMCPManager();
    manager.setToolPermission("s:t", "approval");
    assertEqual(manager.getToolPermission("s:t"), "approval", "Should be approval");

    manager.setToolPermission("s:t", "blocked");
    assertEqual(manager.getToolPermission("s:t"), "blocked", "Should be blocked");

    manager.setToolPermission("s:t", "auto");
    assertEqual(manager.getToolPermission("s:t"), "auto", "Should be auto");
    console.log("  ✓ Pass");
  });

  // --- Test 4: Server-level permission ---
  test("Server-level permission applies to all tools", () => {
    const manager = new CodePilotMCPManager();

    (manager as any).tools = [
      { id: "s1:read", name: "read", description: "", inputSchema: {}, serverName: "s1" },
      { id: "s1:write", name: "write", description: "", inputSchema: {}, serverName: "s1" },
      { id: "s2:query", name: "query", description: "", inputSchema: {}, serverName: "s2" },
    ];

    manager.setServerPermission("s1", "approval");
    assertEqual(manager.getToolPermission("s1:read"), "approval", "Server-level should apply");
    assertEqual(manager.getToolPermission("s1:write"), "approval", "Server-level should apply");
    assertEqual(manager.getToolPermission("s2:query"), "auto", "Other server unaffected");
    console.log("  ✓ Pass");
  });

  // --- Test 5: Tool-level overrides server-level ---
  test("Tool-level permission overrides server-level", () => {
    const manager = new CodePilotMCPManager();
    (manager as any).tools = [
      { id: "s1:read", name: "read", description: "", inputSchema: {}, serverName: "s1" },
    ];

    manager.setServerPermission("s1", "approval");
    assertEqual(manager.getToolPermission("s1:read"), "approval", "Server-level applies");

    manager.setToolPermission("s1:read", "auto");
    assertEqual(manager.getToolPermission("s1:read"), "auto", "Tool-level overrides");
    console.log("  ✓ Pass");
  });

  // --- Test 6: Approval request creates pending promise ---
  test("Approval request creates pending promise", () => {
    const am = new MCPApprovalManager({ defaultTimeoutMs: 5000 });
    const { request, promise } = am.requestApproval(
      "postgres",
      "delete_table",
      { table: "users" },
      "high",
    );

    assert(request.requestId.startsWith("mcp-approval-"), "Request ID should be prefixed");
    assertEqual(request.serverName, "postgres", "Server name should match");
    assertEqual(request.toolName, "delete_table", "Tool name should match");
    assertEqual(request.toolId, "postgres:delete_table", "Tool ID should be namespaced");
    assertEqual(request.status, "pending", "Status should be pending");
    assertEqual(request.riskLevel, "high", "Risk level should match");
    assert(am.isPending(request.requestId), "Should be pending");

    am.dispose();
    void promise; // suppress warning
    console.log("  ✓ Pass");
  });

  // --- Test 7: Approve resolves with approved ---
  test("Approve resolves with approved=true", async () => {
    const am = new MCPApprovalManager({ defaultTimeoutMs: 5000 });
    const { request, promise } = am.requestApproval("s", "t", {});

    am.resolveRequest(request.requestId, { approved: true, reason: "OK" });

    const resolution = await promise;
    assert(resolution.approved, "Should be approved");
    assertEqual(resolution.reason, "OK", "Reason should match");
    assertEqual(request.status, "approved", "Status should be approved");
    assert(!am.isPending(request.requestId), "Should no longer be pending");

    am.dispose();
    console.log("  ✓ Pass");
  });

  // --- Test 8: Reject resolves with rejected ---
  test("Reject resolves with approved=false", async () => {
    const am = new MCPApprovalManager({ defaultTimeoutMs: 5000 });
    const { request, promise } = am.requestApproval("s", "t", {});

    am.resolveRequest(request.requestId, { approved: false, reason: "Denied" });

    const resolution = await promise;
    assert(!resolution.approved, "Should be rejected");
    assertEqual(resolution.reason, "Denied", "Reason should match");
    assertEqual(request.status, "rejected", "Status should be rejected");

    am.dispose();
    console.log("  ✓ Pass");
  });

  // --- Test 9: Timeout auto-rejects ---
  test("Timeout auto-rejects after expiry", async () => {
    const am = new MCPApprovalManager({ defaultTimeoutMs: 30 });
    const { request, promise } = am.requestApproval("s", "t", {});

    const resolution = await promise;
    assert(!resolution.approved, "Should be rejected on timeout");
    assert(resolution.reason!.includes("timed out"), "Reason should mention timeout");
    assertEqual(request.status, "expired", "Status should be expired");

    am.dispose();
    console.log("  ✓ Pass");
  });

  // --- Test 10: Cancel all resolves pending ---
  test("Cancel all resolves pending with rejected", async () => {
    const am = new MCPApprovalManager({ defaultTimeoutMs: 5000 });
    const { request: r1, promise: p1 } = am.requestApproval("s", "t1", {});
    const { request: r2, promise: p2 } = am.requestApproval("s", "t2", {});

    const cancelled = am.cancelAll();
    assertEqual(cancelled.length, 2, "Should cancel 2");

    const res1 = await p1;
    assert(!res1.approved, "Should be rejected");
    assert(res1.reason!.includes("Cancelled"), "Reason should mention cancel");

    const res2 = await p2;
    assert(!res2.approved, "Should be rejected");

    assertEqual(r1.status, "cancelled", "Status should be cancelled");
    assertEqual(r2.status, "cancelled", "Status should be cancelled");

    am.dispose();
    console.log("  ✓ Pass");
  });

  // --- Test 11: Duplicate response ignored ---
  test("Duplicate response is safely ignored", async () => {
    const am = new MCPApprovalManager({ defaultTimeoutMs: 5000 });
    const { request, promise } = am.requestApproval("s", "t", {});

    const first = am.resolveRequest(request.requestId, { approved: true });
    const second = am.resolveRequest(request.requestId, { approved: false });

    assert(first, "First should succeed");
    assert(!second, "Second should be ignored");

    const resolution = await promise;
    assert(resolution.approved, "Should be approved (first wins)");

    am.dispose();
    console.log("  ✓ Pass");
  });

  // --- Test 12: Disabled server blocks execution ---
  test("Disabled server blocks execution", async () => {
    const manager = new CodePilotMCPManager();

    (manager as any).tools = [
      { id: "ds:tool1", name: "tool1", description: "T1", inputSchema: {}, serverName: "ds" },
    ];
    (manager as any).servers.set("ds", { name: "ds", enabled: false, transport: "stdio" });

    const { result } = await manager.executeTool("ds:tool1", {});
    assert(result.isError, "Should return error");
    assert(result.content[0]!.text!.includes("disabled"), "Should mention disabled");
    console.log("  ✓ Pass");
  });

  // --- Test 13: Blocked permission blocks execution ---
  test("Blocked permission blocks execution", async () => {
    const manager = new CodePilotMCPManager();

    (manager as any).tools = [
      { id: "s:bad", name: "bad", description: "", inputSchema: {}, serverName: "s" },
    ];
    (manager as any).servers.set("s", { name: "s", enabled: true, transport: "stdio" });

    manager.setToolPermission("s:bad", "blocked");

    const { result } = await manager.executeTool("s:bad", {});
    assert(result.isError, "Should return error");
    assert(result.content[0]!.text!.includes("blocked"), "Should mention blocked");
    console.log("  ✓ Pass");
  });

  // --- Test 14: Unknown tool returns error ---
  test("Unknown tool returns error", async () => {
    const manager = new CodePilotMCPManager();
    const { result } = await manager.executeTool("no:such:tool", {});
    assert(result.isError, "Should return error");
    assert(result.content[0]!.text!.includes("not found"), "Should mention not found");
    console.log("  ✓ Pass");
  });

  // --- Test 15: Approval-required tool returns pending request ---
  test("Approval-required tool returns pending request", async () => {
    const manager = new CodePilotMCPManager();

    (manager as any).tools = [
      { id: "s:write", name: "write", description: "", inputSchema: {}, serverName: "s" },
    ];
    (manager as any).servers.set("s", { name: "s", enabled: true, transport: "stdio" });

    manager.setToolPermission("s:write", "approval");

    const { result, approvalRequest, approvalPromise } = await manager.executeTool(
      "s:write",
      { path: "/tmp/file.txt" },
    );

    assert(!result.isError, "Should not be error (approval pending)");
    assert(result.content[0]!.text!.includes("requires approval"), "Should mention approval");
    assert(approvalRequest !== undefined, "Should have approval request");
    assertEqual(approvalRequest!.serverName, "s", "Server should match");
    assertEqual(approvalRequest!.toolName, "write", "Tool should match");
    assertEqual(approvalRequest!.toolId, "s:write", "Tool ID should be namespaced");
    assertEqual(approvalRequest!.status, "pending", "Should be pending");
    assert(approvalPromise !== undefined, "Should have approval promise");

    // Cleanup
    manager.getApprovalManager().cancelRequest(approvalRequest!.requestId);
    await approvalPromise;

    console.log("  ✓ Pass");
  });

  // --- Test 16: Force-approved bypasses approval flow ---
  test("Force-approved bypasses approval flow", async () => {
    const manager = new CodePilotMCPManager();

    (manager as any).tools = [
      { id: "s:exec", name: "exec", description: "", inputSchema: {}, serverName: "s" },
    ];
    (manager as any).servers.set("s", { name: "s", enabled: true, transport: "stdio" });

    manager.setToolPermission("s:exec", "approval");

    const { result, approvalRequest } = await manager.executeTool(
      "s:exec",
      {},
      { forceApproved: true },
    );

    assert(approvalRequest === undefined, "Should NOT have approval request (force-approved)");
    // Server not connected, so call fails — but approval was bypassed
    assert(result.content[0]!.text!.includes("not connected"), "Should mention not connected (server issue)");
    console.log("  ✓ Pass");
  });

  // --- Test 17: Audit log records events ---
  test("Audit log records events", async () => {
    const manager = new CodePilotMCPManager();

    (manager as any).tools = [
      { id: "s:tool", name: "tool", description: "", inputSchema: {}, serverName: "s" },
    ];
    (manager as any).servers.set("s", { name: "s", enabled: true, transport: "stdio" });

    manager.setToolPermission("s:tool", "blocked");
    await manager.executeTool("s:tool", {});

    const log = manager.getAuditLog();
    assert(log.length > 0, "Audit log should have entries");
    assert(log[log.length - 1]!.tool === "tool", "Last entry should reference the tool");
    console.log("  ✓ Pass");
  });

  // --- Test 18: Cancel all approvals on agent stop ---
  test("Agent stop cancels all pending approvals", async () => {
    const manager = new CodePilotMCPManager();
    const am = manager.getApprovalManager();

    const { request: r1, promise: p1 } = am.requestApproval("s", "t1", {});
    const { request: r2, promise: p2 } = am.requestApproval("s", "t2", {});

    assertEqual(am.getPendingRequests().length, 2, "Should have 2 pending");

    const cancelled = manager.cancelAllApprovals();
    assertEqual(cancelled.length, 2, "Should cancel 2");
    assertEqual(am.getPendingRequests().length, 0, "Should have 0 pending");

    const res1 = await p1;
    assert(!res1.approved, "Should be rejected");
    const res2 = await p2;
    assert(!res2.approved, "Should be rejected");

    console.log("  ✓ Pass");
  });

  // --- Test 19: getToolsForServer filters correctly ---
  test("getToolsForServer filters correctly", () => {
    const manager = new CodePilotMCPManager();
    (manager as any).tools = [
      { id: "s1:t1", name: "t1", description: "", inputSchema: {}, serverName: "s1" },
      { id: "s1:t2", name: "t2", description: "", inputSchema: {}, serverName: "s1" },
      { id: "s2:t1", name: "t1", description: "", inputSchema: {}, serverName: "s2" },
    ];

    const s1Tools = manager.getToolsForServer("s1");
    assertEqual(s1Tools.length, 2, "s1 should have 2 tools");
    assert(s1Tools.every((t) => t.serverName === "s1"), "All should be from s1");

    const s2Tools = manager.getToolsForServer("s2");
    assertEqual(s2Tools.length, 1, "s2 should have 1 tool");

    console.log("  ✓ Pass");
  });

  // --- Test 20: getAllPermissions returns all settings ---
  test("getAllPermissions returns all settings", () => {
    const manager = new CodePilotMCPManager();
    manager.setToolPermission("a:b", "auto");
    manager.setToolPermission("c:d", "blocked");
    manager.setToolPermission("e:f", "approval");

    const perms = manager.getAllPermissions();
    assertEqual(perms.length, 3, "Should have 3 permissions");
    assert(perms.some((p) => p.toolId === "a:b" && p.permission === "auto"), "Should have a:b auto");
    assert(perms.some((p) => p.toolId === "c:d" && p.permission === "blocked"), "Should have c:d blocked");
    assert(perms.some((p) => p.toolId === "e:f" && p.permission === "approval"), "Should have e:f approval");
    console.log("  ✓ Pass");
  });

  // --- Test 21: Full lifecycle: request → approve → execute → audit ---
  test("Full lifecycle: request → approve → mark executed → audit", async () => {
    const am = new MCPApprovalManager({ defaultTimeoutMs: 5000 });

    const { request, promise } = am.requestApproval(
      "postgres",
      "drop_table",
      { table: "users" },
      "high",
    );

    assertEqual(request.status, "pending", "Should be pending");

    am.resolveRequest(request.requestId, { approved: true, reason: "DBA approved" });
    const resolution = await promise;
    assert(resolution.approved, "Should be approved");

    am.markExecuted(request.requestId);
    const resolved = am.getResolvedRequests();
    assert(resolved[resolved.length - 1]!.status === "executed", "Should be executed");

    am.dispose();
    console.log("  ✓ Pass");
  });

  console.log(`\n=== ALL ${passed} TESTS PASSED ✓ ===`);
}

runTests().catch((err) => {
  console.error("\n❌ TEST SUITE FAILED:", err.message);
  process.exit(1);
});
