/**
 * M4 Security Invariants tests.
 * These tests verify that security boundaries CANNOT be bypassed by any means.
 */
import { describe, it, expect } from "vitest";
import { M4PermissionPipeline } from "./integration.js";
import { SecurityValidator } from "./security-validator.js";

describe("M4 Security Invariants", () => {
  describe("DENY always blocks", () => {
    it("deny decision never executes", async () => {
      const pipeline = new M4PermissionPipeline({
        workspaceRoot: "/workspace",
        presentApproval: async () => ({ decision: "allow", scope: "once" }),
      });
      pipeline.policyEngine.addPolicy({
        id: "deny-all",
        actions: ["write_file"],
        decision: "deny",
        scope: "single_execution",
        priority: 1000,
        enabled: true,
      });
      const result = await pipeline.evaluate({
        toolId: "write_file",
        executionId: "exec-1",
        input: { path: "src/foo.ts" },
        cwd: "/workspace",
      });
      expect(result.approved).toBe(false);
      expect(result.decision).toBe("deny");
    });

    it("deny_session decision never executes", async () => {
      const pipeline = new M4PermissionPipeline({
        workspaceRoot: "/workspace",
        presentApproval: async () => ({ decision: "allow", scope: "once" }),
      });
      pipeline.policyEngine.addPolicy({
        id: "session-deny",
        actions: ["write_file"],
        decision: "deny_session",
        scope: "session",
        priority: 1000,
        enabled: true,
      });
      const result = await pipeline.evaluate({
        toolId: "write_file",
        executionId: "exec-1",
        sessionId: "blocked",
        input: { path: "src/foo.ts" },
        cwd: "/workspace",
      });
      expect(result.approved).toBe(false);
    });
  });

  describe("Security validation always enforced", () => {
    it("path traversal blocked even with autoApproveReads", async () => {
      const pipeline = new M4PermissionPipeline({
        workspaceRoot: "/workspace",
        autoApproveReads: true,
        presentApproval: async () => ({ decision: "allow", scope: "once" }),
      });
      const result = await pipeline.evaluate({
        toolId: "read_file",
        executionId: "exec-1",
        input: { path: "../../../etc/shadow" },
        cwd: "/workspace",
      });
      expect(result.approved).toBe(false);
    });

    it("write outside workspace blocked even after user approval", async () => {
      const pipeline = new M4PermissionPipeline({
        workspaceRoot: "/workspace",
        presentApproval: async () => ({ decision: "allow", scope: "once" }),
      });
      const promise = pipeline.evaluate({
        toolId: "write_file",
        executionId: "exec-1",
        input: { path: "/etc/passwd" },
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
  });

  describe("Filesystem security cannot be overridden", () => {
    it("absolute path outside workspace is blocked", () => {
      const validator = new SecurityValidator({ workspaceRoot: "/workspace" });
      const result = validator.validate("write_file", { path: "/etc/hosts" });
      expect(result.allowed).toBe(false);
    });

    it("symlink-style traversal is blocked", () => {
      const validator = new SecurityValidator({ workspaceRoot: "/workspace" });
      const result = validator.validate("read_file", {
        path: "subdir/../../etc/passwd",
      });
      expect(result.allowed).toBe(false);
    });

    it("null byte injection is blocked", () => {
      const validator = new SecurityValidator({ workspaceRoot: "/workspace" });
      const result = validator.validate("read_file", {
        path: "foo.txt\x00.sh",
      });
      expect(result.allowed).toBe(false);
    });
  });

  describe("Approval state invariants", () => {
    it("expired approval blocks execution", async () => {
      const pipeline = new M4PermissionPipeline({
        workspaceRoot: "/workspace",
        approvalTimeoutMs: 100,
        presentApproval: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { decision: "allow", scope: "once" };
        },
      });
      const result = await pipeline.evaluate({
        toolId: "write_file",
        executionId: "exec-1",
        input: { path: "src/foo.ts" },
        cwd: "/workspace",
      });
      expect(result.approved).toBe(false);
    });

    it("cancelled approval blocks execution", async () => {
      const pipeline = new M4PermissionPipeline({
        workspaceRoot: "/workspace",
        presentApproval: async () => ({ decision: "allow", scope: "once" }),
      });
      const promise = pipeline.evaluate({
        toolId: "write_file",
        executionId: "exec-1",
        input: { path: "src/foo.ts" },
        cwd: "/workspace",
      });
      const pending = pipeline.approvalManager.listPending();
      if (pending.length > 0) {
        pipeline.approvalManager.cancel(pending[0]!.approvalId);
      }
      const result = await promise;
      expect(result.approved).toBe(false);
    });
  });
});
