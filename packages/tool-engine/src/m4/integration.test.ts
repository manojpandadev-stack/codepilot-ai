/**
 * M4 Permission Pipeline integration tests.
 * Tests the full pipeline: RiskEngine → PermissionPolicyEngine → ApprovalManager → SecurityValidator.
 */
import { describe, it, expect, vi } from "vitest";
import { M4PermissionPipeline } from "./integration.js";
import type {
  ApprovalPresentation,
  UserApprovalChoice,
} from "./integration.js";

function createPipeline(
  overrides: {
    autoApproveReads?: boolean;
    approveCallback?: (
      request: ApprovalPresentation,
    ) => Promise<UserApprovalChoice>;
  } = {},
) {
  const presentApproval =
    overrides.approveCallback ??
    (async () => ({ decision: "allow", scope: "once" as const }));
  return new M4PermissionPipeline({
    workspaceRoot: "/workspace",
    approvalTimeoutMs: 5000,
    autoApproveReads: overrides.autoApproveReads ?? true,
    presentApproval,
  });
}

describe("M4PermissionPipeline", () => {
  it("auto-approves read_file by default", async () => {
    const pipeline = createPipeline();
    const result = await pipeline.evaluate({
      toolId: "read_file",
      executionId: "exec-1",
      input: { path: "src/foo.ts" },
      cwd: "/workspace",
    });
    expect(result.approved).toBe(true);
    expect(result.decision).toBe("allow");
  });

  it("auto-approves list_directory by default", async () => {
    const pipeline = createPipeline();
    const result = await pipeline.evaluate({
      toolId: "list_directory",
      executionId: "exec-1",
      input: { path: "src" },
      cwd: "/workspace",
    });
    expect(result.approved).toBe(true);
  });

  it("requires approval for write_file", async () => {
    const presentApproval = vi.fn((_request: ApprovalPresentation) => {
      return new Promise<UserApprovalChoice>(() => {});
    });
    const pipeline = createPipeline({ approveCallback: presentApproval });
    const promise = pipeline.evaluate({
      toolId: "write_file",
      executionId: "exec-1",
      input: { path: "src/foo.ts" },
      cwd: "/workspace",
    });
    // Wait for the approval to be requested
    expect(presentApproval).toHaveBeenCalled();
    // Simulate user approving via ApprovalManager
    const pending = pipeline.approvalManager.listPending();
    expect(pending.length).toBe(1);
    pipeline.approvalManager.approve(
      pending[0]!.approvalId,
      "single_execution",
      "User approved",
    );
    const result = await promise;
    expect(result.approved).toBe(true);
  });

  it("denies when user rejects approval", async () => {
    const pipeline = createPipeline({
      approveCallback: async () => ({
        decision: "deny" as const,
        scope: "once" as const,
      }),
    });
    const promise = pipeline.evaluate({
      toolId: "write_file",
      executionId: "exec-1",
      input: { path: "src/foo.ts" },
      cwd: "/workspace",
    });
    // Simulate user rejecting via ApprovalManager
    const pending = pipeline.approvalManager.listPending();
    expect(pending.length).toBe(1);
    pipeline.approvalManager.reject(
      pending[0]!.approvalId,
      "single_execution",
      "User rejected",
    );
    const result = await promise;
    expect(result.approved).toBe(false);
    expect(result.decision).toBe("deny");
  });

  it("blocks path traversal even with autoApproveReads", async () => {
    const pipeline = createPipeline();
    const result = await pipeline.evaluate({
      toolId: "read_file",
      executionId: "exec-1",
      input: { path: "../../../etc/passwd" },
      cwd: "/workspace",
    });
    expect(result.approved).toBe(false);
    expect(result.decision).toBe("deny");
  });

  it("enforces workspace boundary on write", async () => {
    const pipeline = createPipeline({
      approveCallback: async () => ({
        decision: "allow" as const,
        scope: "once" as const,
      }),
    });
    const promise = pipeline.evaluate({
      toolId: "write_file",
      executionId: "exec-1",
      input: { path: "/etc/hosts" },
      cwd: "/workspace",
    });
    // Approve the request (but boundary should still block)
    const pending = pipeline.approvalManager.listPending();
    if (pending.length > 0) {
      pipeline.approvalManager.approve(pending[0]!.approvalId);
    }
    const result = await promise;
    expect(result.approved).toBe(false);
  });

  it("includes risk assessment in decision", async () => {
    const pipeline = createPipeline();
    const result = await pipeline.evaluate({
      toolId: "read_file",
      executionId: "exec-1",
      input: { path: "src/foo.ts" },
      cwd: "/workspace",
    });
    expect(result.risk).toBeDefined();
    expect(result.risk.level).toBe("low");
  });

  it("includes approvalId when approval is required", async () => {
    const pipeline = createPipeline({
      approveCallback: async () => ({
        decision: "allow" as const,
        scope: "once" as const,
      }),
    });
    const promise = pipeline.evaluate({
      toolId: "write_file",
      executionId: "exec-1",
      input: { path: "src/foo.ts" },
      cwd: "/workspace",
    });
    const pending = pipeline.approvalManager.listPending();
    expect(pending.length).toBe(1);
    pipeline.approvalManager.approve(pending[0]!.approvalId);
    const result = await promise;
    expect(result.approvalId).toBeDefined();
  });
});
