/**
 * ApprovalManager tests: lifecycle, exactly-once semantics, timeout, and disposal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApprovalManager } from "./approval-manager.js";

describe("ApprovalManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a pending approval request", async () => {
    const am = new ApprovalManager({ defaultTimeoutMs: 5000 });
    const promise = am.requestApproval({
      toolId: "write_file",
      executionId: "exec-1",
      action: "write_file",
      risk: { level: "medium", reasons: ["write"], destructive: false },
      description: "Write file",
    });
    expect(promise).toBeInstanceOf(Promise);
    expect(am.pendingCount()).toBe(1);
  });

  it("approves a pending request", async () => {
    const am = new ApprovalManager({ defaultTimeoutMs: 5000 });
    const promise = am.requestApproval({
      toolId: "write_file",
      executionId: "exec-1",
      action: "write_file",
      risk: { level: "medium", reasons: ["write"], destructive: false },
      description: "Write file",
    });
    const pending = am.listPending();
    expect(pending.length).toBe(1);
    const result = am.approve(pending[0]!.approvalId, "single_execution", "OK");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("approved");
    expect(am.pendingCount()).toBe(0);
    const approval = await promise;
    expect(approval.status).toBe("approved");
  });

  it("rejects a pending request", async () => {
    const am = new ApprovalManager({ defaultTimeoutMs: 5000 });
    const promise = am.requestApproval({
      toolId: "write_file",
      executionId: "exec-1",
      action: "write_file",
      risk: { level: "medium", reasons: ["write"], destructive: false },
      description: "Write file",
    });
    const pending = am.listPending();
    am.reject(pending[0]!.approvalId, "single_execution", "No");
    const approval = await promise;
    expect(approval.status).toBe("rejected");
  });

  it("cancels a pending request", async () => {
    const am = new ApprovalManager({ defaultTimeoutMs: 5000 });
    const promise = am.requestApproval({
      toolId: "write_file",
      executionId: "exec-1",
      action: "write_file",
      risk: { level: "medium", reasons: ["write"], destructive: false },
      description: "Write file",
    });
    const pending = am.listPending();
    am.cancel(pending[0]!.approvalId, "User cancelled");
    const approval = await promise;
    expect(approval.status).toBe("cancelled");
  });

  it("expires a pending request after timeout", async () => {
    const am = new ApprovalManager({ defaultTimeoutMs: 5000 });
    const promise = am.requestApproval({
      toolId: "write_file",
      executionId: "exec-1",
      action: "write_file",
      risk: { level: "medium", reasons: ["write"], destructive: false },
      description: "Write file",
    });
    vi.advanceTimersByTime(6000);
    const approval = await promise;
    expect(approval.status).toBe("expired");
  });

  it("approve is idempotent — second call returns the already-resolved result", () => {
    const am = new ApprovalManager({ defaultTimeoutMs: 5000 });
    const promise = am.requestApproval({
      toolId: "write_file",
      executionId: "exec-1",
      action: "write_file",
      risk: { level: "medium", reasons: ["write"], destructive: false },
      description: "Write file",
    });
    const pending = am.listPending();
    const id = pending[0]!.approvalId;
    const first = am.approve(id);
    const second = am.approve(id);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.status).toBe("approved");
    expect(second!.approvalId).toBe(id);
    void promise;
  });

  it("calls onApprovalRequested callback", () => {
    const onRequest = vi.fn();
    const am = new ApprovalManager({
      defaultTimeoutMs: 5000,
      onApprovalRequested: onRequest,
    });
    am.requestApproval({
      toolId: "write_file",
      executionId: "exec-1",
      action: "write_file",
      risk: { level: "medium", reasons: ["write"], destructive: false },
      description: "Write file",
    });
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onRequest.mock.calls[0]![0]!.toolId).toBe("write_file");
  });

  it("disposes all pending approvals", async () => {
    const am = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const promises = [];
    for (let i = 0; i < 3; i++) {
      promises.push(
        am.requestApproval({
          toolId: `tool-${i}`,
          executionId: `exec-${i}`,
          action: "write_file",
          risk: { level: "medium", reasons: ["write"], destructive: false },
          description: `Write ${i}`,
        }),
      );
    }
    expect(am.pendingCount()).toBe(3);
    am.dispose();
    expect(am.pendingCount()).toBe(0);
    for (const p of promises) {
      const result = await p;
      expect(result.status).toBe("cancelled");
    }
  });

  it("getPending returns null for unknown id", () => {
    const am = new ApprovalManager();
    expect(am.getPending("nonexistent")).toBeNull();
  });

  it("listPending returns empty array when no pending", () => {
    const am = new ApprovalManager();
    expect(am.listPending()).toEqual([]);
  });
});
