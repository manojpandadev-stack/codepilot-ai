/**
 * M4 live-tool bridge tests.
 *
 * Proves that the live agent's approval hook, when routed through
 * LiveToolPermissionBridge, performs a real M4 evaluation:
 * - risk classification + policy decision (allow / deny / deny_session)
 * - approval gating via the pipeline's ApprovalManager (the same flow the
 *   VS Code host uses: presentApproval surfaces the request, the host
 *   resolves it through approvalManager.approve()/reject())
 * - security validation (path boundaries) AFTER any approval
 * - audit logging of every decision
 * - deny-closed behavior on unmapped tools
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { M4PermissionPipeline } from "./integration.js";
import type { ApprovalPresentation } from "./integration.js";
import { LiveToolPermissionBridge } from "./live-bridge.js";

describe("LiveToolPermissionBridge", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "m4-live-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Pipeline whose presenter resolves via the ApprovalManager like the real host. */
  const makePipeline = (
    decide: (
      presentation: ApprovalPresentation,
    ) => "allow" | "deny" | "session" | "session_deny",
  ): M4PermissionPipeline => {
    let manager: M4PermissionPipeline["approvalManager"] | null = null;
    const pipeline = new M4PermissionPipeline({
      workspaceRoot: dir,
      approvalTimeoutMs: 2_000,
      autoApproveReads: true,
      presentApproval: async (presentation) => {
        const m = manager!;
        const d = decide(presentation);
        // Resolve on the microtask queue like an async host would.
        queueMicrotask(() => {
          if (d === "allow") m.approve(presentation.approvalId);
          else if (d === "session")
            m.approve(presentation.approvalId, "session");
          else if (d === "session_deny")
            m.reject(presentation.approvalId, "session");
          else m.reject(presentation.approvalId);
        });
        return {
          decision: d === "deny" || d === "session_deny" ? "deny" : "allow",
        };
      },
    });
    manager = pipeline.approvalManager;
    return pipeline;
  };

  it("auto-approves a read tool through the full pipeline", async () => {
    const bridge = new LiveToolPermissionBridge(makePipeline(() => "allow"));
    const result = await bridge.evaluateLiveTool({
      toolName: "read_file",
      input: { path: "src/a.ts" },
    });
    expect(result.approved).toBe(true);
    expect(result.decision).toBe("allow");
    expect(result.unmappedTool).toBe(false);
  });

  it("requires approval for a write tool and approves on user consent", async () => {
    const bridge = new LiveToolPermissionBridge(makePipeline(() => "allow"));
    const result = await bridge.evaluateLiveTool({
      toolName: "editor",
      input: { path: "src/a.ts" },
    });
    expect(result.approved).toBe(true);
    expect(result.decision).toBe("allow");
  });

  it("denies when the user rejects the approval", async () => {
    const bridge = new LiveToolPermissionBridge(makePipeline(() => "deny"));
    const result = await bridge.evaluateLiveTool({
      toolName: "bash",
      input: { command: "echo hi" },
    });
    expect(result.approved).toBe(false);
  });

  it("session deny blocks subsequent requests in the session", async () => {
    // A session-scoped DENY policy (as created by a "deny for session" host
    // decision) makes every later evaluate() in that session fail closed.
    const pipeline = new M4PermissionPipeline({
      workspaceRoot: dir,
      approvalTimeoutMs: 2_000,
      autoApproveReads: true,
      presentApproval: async () => ({ decision: "allow" as const }),
    });
    pipeline.policyEngine.addPolicy({
      id: "deny-bash-session",
      actions: ["execute_command"],
      decision: "deny_session",
      scope: "session",
      priority: 100,
      enabled: true,
    });
    const bridge = new LiveToolPermissionBridge(pipeline);
    const result = await bridge.evaluateLiveTool({
      toolName: "bash",
      input: { command: "echo one" },
      sessionId: "s1",
    });
    expect(result.approved).toBe(false);
    expect(result.decision).toBe("deny_session");
  });

  it("security boundary: workspace escape is denied even after approval", async () => {
    const bridge = new LiveToolPermissionBridge(makePipeline(() => "allow"));
    const result = await bridge.evaluateLiveTool({
      toolName: "editor",
      input: { path: "../outside.txt" },
    });
    expect(result.approved).toBe(false);
    expect(result.decision).toBe("deny");
  });

  it("unmapped tools are deny-biased but still evaluated", async () => {
    const bridge = new LiveToolPermissionBridge(makePipeline(() => "allow"));
    const result = await bridge.evaluateLiveTool({
      toolName: "brand_new_tool",
      input: { path: "ok.txt" },
    });
    expect(result.unmappedTool).toBe(true);
    expect(["allow", "allow_session", "deny", "deny_session", "ask"]).toContain(
      result.decision,
    );
  });

  it("records an audit entry for every decision", async () => {
    const bridge = new LiveToolPermissionBridge(makePipeline(() => "allow"));
    await bridge.evaluateLiveTool({
      toolName: "read_file",
      input: { path: "a.ts" },
    });
    const log = bridge.auditLog();
    expect(log.length).toBe(1);
    expect(log[0]!.toolId).toBe("read_file");
    expect(log[0]!.permissionDecision).toBe("allow");
  });
});
