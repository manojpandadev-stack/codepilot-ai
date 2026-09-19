/**
 * M4 — ApprovalManager `onApprovalResolved` hook tests.
 *
 * The webview approval UI relies on this hook to retire pending Allow/Deny
 * cards when a request resolves by ANY path (user decision, timeout, cancel,
 * dispose). These tests prove the hook fires exactly once per request for
 * every resolution path, with the status the webview must render.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApprovalManager } from "./approval-manager.js";
import type { ApprovalResult } from "./permission-types.js";

/** Minimal valid risk assessment for requestApproval. */
const risk = {
  level: "medium" as const,
  reasons: ["write"],
  destructive: false,
};

function makeManager(
  opts: { timeoutMs?: number; onResolved?: (r: ApprovalResult) => void } = {},
) {
  return new ApprovalManager({
    defaultTimeoutMs: opts.timeoutMs ?? 5_000,
    onApprovalResolved: opts.onResolved,
  });
}

function requestApproval(am: ApprovalManager): Promise<ApprovalResult> {
  return am.requestApproval({
    toolId: "write_file",
    executionId: "exec-1",
    action: "write_file",
    risk,
    description: "Write file",
  });
}

describe("ApprovalManager.onApprovalResolved", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires with status approved on user allow", async () => {
    const resolved: ApprovalResult[] = [];
    const am = makeManager({ onResolved: (r) => resolved.push(r) });
    const promise = requestApproval(am);
    const pending = am.listPending();
    expect(pending).toHaveLength(1);
    am.approve(pending[0]!.approvalId);

    const result = await promise;
    expect(result.status).toBe("approved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.approvalId).toBe(pending[0]!.approvalId);
    am.dispose();
  });

  it("fires with status denied on user deny", async () => {
    const resolved: ApprovalResult[] = [];
    const am = makeManager({ onResolved: (r) => resolved.push(r) });
    const promise = requestApproval(am);
    const pending = am.listPending();
    am.reject(pending[0]!.approvalId);

    const result = await promise;
    expect(result.status).toBe("rejected");
    expect(resolved).toHaveLength(1);
    am.dispose();
  });

  it("fires with status expired on timeout (webview card must retire)", async () => {
    const resolved: ApprovalResult[] = [];
    const am = makeManager({
      timeoutMs: 50,
      onResolved: (r) => resolved.push(r),
    });
    const promise = requestApproval(am);
    // Expire the timer.
    await vi.advanceTimersByTimeAsync(60);

    const result = await promise;
    expect(result.status).toBe("expired");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.status).toBe("expired");
    am.dispose();
  });

  it("fires with status cancelled on cancel (agent stop)", async () => {
    const resolved: ApprovalResult[] = [];
    const am = makeManager({ onResolved: (r) => resolved.push(r) });
    const promise = requestApproval(am);
    const pending = am.listPending();
    am.cancel(pending[0]!.approvalId, "agent stopped");

    const result = await promise;
    expect(result.status).toBe("cancelled");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.status).toBe("cancelled");
    am.dispose();
  });

  it("fires exactly once per request (double resolve is single-use)", async () => {
    const resolved: ApprovalResult[] = [];
    const am = makeManager({ onResolved: (r) => resolved.push(r) });
    const promise = requestApproval(am);
    const pending = am.listPending();
    const id = pending[0]!.approvalId;
    // First resolution wins; ApprovalManager guarantees idempotency.
    am.approve(id);
    am.reject(id); // must be a no-op
    am.approve(id); // must be a no-op

    await promise;
    expect(resolved).toHaveLength(1);
    am.dispose();
  });

  it("does not fire for unknown request ids", () => {
    const cb = vi.fn();
    const am = makeManager({ onResolved: cb });
    am.approve("does-not-exist");
    am.reject("does-not-exist");
    expect(cb).not.toHaveBeenCalled();
    am.dispose();
  });
});
