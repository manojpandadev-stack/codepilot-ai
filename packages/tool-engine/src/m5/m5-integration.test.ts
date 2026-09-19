/**
 * M5 ↔ M3/M4 integration tests.
 *
 * Proves the M5 security contract at the execution boundary:
 *
 *   ToolRegistry → ToolExecutionService → M4PermissionPipeline
 *     (RiskEngine → PermissionPolicyEngine → ApprovalManager → SecurityValidator)
 *   → FileMutationService (M5PathGuard per-op) → real fs mutation
 *
 * Every test asserts the same core invariant: without an M4-approved decision
 * there is no filesystem mutation. Deny / reject / cancel / timeout /
 * boundary-fail all leave the workspace untouched.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { M5Event } from "@codepilot/changeset-engine";
import { ToolAuditLogger } from "../m3/audit-logger.js";
import { ToolExecutionService } from "../m3/executor.js";
import type { ToolResult } from "../m3/lifecycle.js";
import { ToolPermissionManager } from "../m3/permission-manager.js";
import { ToolRegistry } from "../m3/registry.js";
import { M4PermissionPipeline } from "../m4/integration.js";
import type {
  ApprovalPresentation,
  UserApprovalChoice,
} from "../m4/integration.js";
import { createM5Toolset } from "./tools.js";
import type { M5Toolchain } from "./tools.js";

// ============================================================================
// Harness
// ============================================================================

function mkWorkspaceRoot(): string {
  // realpathSync avoids Windows 8.3 short-name mismatches in path guards.
  return fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "m5-integration-")),
  );
}

interface TestEnv {
  root: string;
  toolchain: M5Toolchain;
  registry: ToolRegistry;
  audit: ToolAuditLogger;
  m4: M4PermissionPipeline;
  executor: ToolExecutionService;
  events: M5Event[];
  cleanup: () => void;
}

function createEnv(
  opts: {
    approvalTimeoutMs?: number;
    presentApproval?: (
      request: ApprovalPresentation,
    ) => Promise<UserApprovalChoice>;
  } = {},
): TestEnv {
  const root = mkWorkspaceRoot();
  const events: M5Event[] = [];
  const { toolchain, tools } = createM5Toolset({
    workspaceRoot: root,
    onEvent: (event) => events.push(event),
  });
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);

  // Reference resolved after construction (presentApproval runs only during
  // evaluate(), never during the constructor).
  const ref: { pipeline: M4PermissionPipeline } = {
    pipeline: undefined as unknown as M4PermissionPipeline,
  };

  const m4 = new M4PermissionPipeline({
    workspaceRoot: root,
    approvalTimeoutMs: opts.approvalTimeoutMs ?? 5000,
    presentApproval:
      opts.presentApproval ??
      ((request: ApprovalPresentation) => {
        // Default test user: approve through the real ApprovalManager —
        // the exact path the VS Code host uses for user decisions.
        ref.pipeline.approvalManager.approve(
          request.approvalId,
          "single_execution",
          "test auto-approve",
        );
        return Promise.resolve<UserApprovalChoice>({
          decision: "allow",
          scope: "once",
        });
      }),
  });
  ref.pipeline = m4;

  const audit = new ToolAuditLogger({ consoleLevel: "off" });
  const executor = new ToolExecutionService(
    registry,
    new ToolPermissionManager(),
    audit,
    { defaultTimeoutMs: 30_000 },
    m4,
  );

  return {
    root,
    toolchain,
    registry,
    audit,
    m4,
    executor,
    events,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** Run `fn` with a fresh env, always cleaning the temp workspace up. */
async function withEnv(
  opts: Parameters<typeof createEnv>[0],
  fn: (env: TestEnv) => Promise<void>,
): Promise<void> {
  const env = createEnv(opts);
  try {
    await fn(env);
  } finally {
    env.cleanup();
  }
}

const abs = (root: string, rel: string): string => path.join(root, rel);

/** Poll until `check` is true (approval requests surface asynchronously). */
async function waitUntil(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function expectNoFile(root: string, rel: string): void {
  expect(fs.existsSync(abs(root, rel))).toBe(false);
}

function expectDenied(result: ToolResult): void {
  expect(result.status).toBe("denied");
  expect(result.error?.category).toBe("PERMISSION_DENIED");
}

// ============================================================================
// Permission pipeline invariants — mutation only after M4 allows
// ============================================================================

describe("M5 mutations through ToolExecutionService + M4", () => {
  it("approved write mutates the filesystem and records a tracked change", async () => {
    await withEnv({}, async (env) => {
      const result = await env.executor.execute(
        "apply_file_changes",
        { path: "src/a.txt", content: "hello" },
        { taskId: "t1", sessionId: "s1" },
      );
      expect(result.status).toBe("completed");
      expect(fs.readFileSync(abs(env.root, "src/a.txt"), "utf8")).toBe("hello");

      const changeId = (result.output as { changeId: string }).changeId;
      const change = env.toolchain.mutation.getChange(changeId);
      expect(change?.status).toBe("applied");
      expect(change?.taskId).toBe("t1");
      expect(change?.sessionId).toBe("s1");
    });
  });

  it("ASK: nothing is mutated before the user decides; reject leaves workspace untouched", async () => {
    let decide: ((choice: UserApprovalChoice) => void) | undefined;
    const presentations: ApprovalPresentation[] = [];
    const presentApproval = (request: ApprovalPresentation) => {
      presentations.push(request);
      return new Promise<UserApprovalChoice>((resolve) => {
        decide = resolve;
      });
    };
    await withEnv({ presentApproval }, async (env) => {
      const promise = env.executor.execute(
        "apply_file_changes",
        { path: "a.txt", content: "x" },
        { taskId: "t1" },
      );
      await waitUntil(() => presentations.length > 0, "approval presentation");

      // Decision still pending → no filesystem mutation yet.
      expectNoFile(env.root, "a.txt");

      decide!({ decision: "deny", scope: "once", reason: "user said no" });
      const result = await promise;
      expectDenied(result);
      expectNoFile(env.root, "a.txt");
      expect(env.toolchain.mutation.listChanges("t1")).toHaveLength(0);
    });
  });

  it("CANCEL: cancelled approval never reaches the filesystem", async () => {
    const presentApproval = vi.fn(
      () => new Promise<UserApprovalChoice>(() => {}),
    );
    await withEnv({ presentApproval, approvalTimeoutMs: 2000 }, async (env) => {
      const promise = env.executor.execute(
        "apply_file_changes",
        { path: "a.txt", content: "x" },
        { taskId: "t1" },
      );
      await waitUntil(
        () => presentApproval.mock.calls.length > 0,
        "approval presentation",
      );
      expectNoFile(env.root, "a.txt");

      const pending = env.m4.approvalManager.listPending();
      expect(pending).toHaveLength(1);
      env.m4.approvalManager.cancel(pending[0]!.approvalId, "caller cancelled");

      expectDenied(await promise);
      expectNoFile(env.root, "a.txt");
    });
  });

  it("TIMEOUT: expired approval never reaches the filesystem", async () => {
    const presentApproval = vi.fn(
      () => new Promise<UserApprovalChoice>(() => {}),
    );
    await withEnv({ presentApproval, approvalTimeoutMs: 40 }, async (env) => {
      const result = await env.executor.execute(
        "apply_file_changes",
        { path: "a.txt", content: "x" },
        { taskId: "t1" },
      );
      expectDenied(result);
      expectNoFile(env.root, "a.txt");
      expect(env.toolchain.mutation.listChanges("t1")).toHaveLength(0);
    });
  });

  it("DENY: policy-denied action never reaches the filesystem", async () => {
    await withEnv({}, async (env) => {
      env.m4.policyEngine.setAutoApprove("write_file", "deny");
      const result = await env.executor.execute(
        "apply_file_changes",
        { path: "a.txt", content: "x" },
        { taskId: "t1" },
      );
      expectDenied(result);
      expectNoFile(env.root, "a.txt");
      expect(env.toolchain.mutation.listChanges("t1")).toHaveLength(0);
    });
  });

  it("workspace traversal is rejected even when approval would allow it", async () => {
    await withEnv({}, async (env) => {
      const escaped = path.join(
        path.dirname(env.root),
        "m5-escape-should-not-exist.txt",
      );
      fs.rmSync(escaped, { force: true });

      const result = await env.executor.execute(
        "apply_file_changes",
        { path: "../m5-escape-should-not-exist.txt", content: "x" },
        { taskId: "t1" },
      );
      expect(result.status).not.toBe("completed");
      expect(fs.existsSync(escaped)).toBe(false);
      expect(fs.readdirSync(env.root)).toHaveLength(0);
    });
  });

  it("absolute outside-workspace paths are rejected", async () => {
    await withEnv({}, async (env) => {
      const outside = path.join(
        os.tmpdir(),
        "m5-abs-escape-should-not-exist.txt",
      );
      fs.rmSync(outside, { force: true });

      const result = await env.executor.execute(
        "apply_file_changes",
        { path: outside, content: "x" },
        { taskId: "t1" },
      );
      expect(result.status).not.toBe("completed");
      expect(fs.existsSync(outside)).toBe(false);
      expect(fs.readdirSync(env.root)).toHaveLength(0);
    });
  });

  it("null-byte paths are rejected", async () => {
    await withEnv({}, async (env) => {
      const result = await env.executor.execute(
        "apply_file_changes",
        { path: "a\u0000.txt", content: "x" },
        { taskId: "t1" },
      );
      expect(result.status).not.toBe("completed");
      expect(fs.readdirSync(env.root)).toHaveLength(0);
    });
  });

  it("sensitive files are rejected according to policy even with user approval", async () => {
    await withEnv({}, async (env) => {
      const result = await env.executor.execute(
        "apply_file_changes",
        { path: ".env", content: "SECRET=1" },
        { taskId: "t1" },
      );
      expect(result.status).not.toBe("completed");
      expectNoFile(env.root, ".env");
      // No secret value leaked into the error surface.
      expect(JSON.stringify(result.error)).not.toContain("SECRET=1");
    });
  });

  it("mutating M5 tools are classified as write_file and require approval", async () => {
    const presentApproval = vi.fn(
      (_request: ApprovalPresentation) =>
        new Promise<UserApprovalChoice>(() => {}),
    );
    await withEnv({ presentApproval, approvalTimeoutMs: 60 }, async (env) => {
      const promise = env.executor.execute(
        "apply_file_changes",
        { path: "a.txt", content: "x" },
        { taskId: "t1" },
      );
      await waitUntil(
        () => presentApproval.mock.calls.length > 0,
        "approval presentation",
      );
      const request = presentApproval.mock.calls[0]![0] as ApprovalPresentation;
      expect(request.toolId).toBe("apply_file_changes");
      expect(request.action).toBe("write_file");
      expect(request.allowSession).toBe(true);

      expectDenied(await promise); // approval timed out
      expectNoFile(env.root, "a.txt");
    });
  });

  it("restore_checkpoint is classified as a mutation and requires approval", async () => {
    const presentApproval = vi.fn(
      (_request: ApprovalPresentation) =>
        new Promise<UserApprovalChoice>(() => {}),
    );
    await withEnv({ presentApproval, approvalTimeoutMs: 60 }, async (env) => {
      // Seed a checkpoint via the read-only tool (auto-approved).
      const cpResult = await env.executor.execute(
        "create_checkpoint",
        { description: "empty cp" },
        { taskId: "t1" },
      );
      expect(cpResult.status).toBe("completed");
      const checkpointId = (cpResult.output as { checkpointId: string })
        .checkpointId;

      const promise = env.executor.execute(
        "restore_checkpoint",
        { checkpointId },
        { taskId: "t1" },
      );
      await waitUntil(
        () => presentApproval.mock.calls.length > 0,
        "approval presentation",
      );
      const request = presentApproval.mock.calls[0]![0] as ApprovalPresentation;
      expect(request.toolId).toBe("restore_checkpoint");
      expect(request.action).toBe("write_file");

      expectDenied(await promise); // approval timed out
    });
  });

  it("read-only M5 tools complete without surfacing any approval", async () => {
    let surfaced = false;
    const presentApproval = (_request: ApprovalPresentation) => {
      surfaced = true;
      return Promise.resolve<UserApprovalChoice>({
        decision: "allow",
        scope: "once",
      });
    };
    await withEnv({ presentApproval }, async (env) => {
      fs.writeFileSync(abs(env.root, "a.txt"), "hello", "utf8");

      const diff = await env.executor.execute(
        "get_diff",
        { path: "a.txt" },
        { taskId: "t1" },
      );
      expect(diff.status).toBe("completed");

      const cp = await env.executor.execute(
        "create_checkpoint",
        { description: "cp" },
        { taskId: "t1" },
      );
      expect(cp.status).toBe("completed");

      const list = await env.executor.execute(
        "list_checkpoints",
        {},
        { taskId: "t1" },
      );
      expect(list.status).toBe("completed");
      expect(
        (list.output as { checkpoints: unknown[] }).checkpoints,
      ).toHaveLength(1);

      expect(surfaced).toBe(false);
    });
  });
});

// ============================================================================
// Checkpoint / restore / revert end-to-end through the M4-gated path
// ============================================================================

describe("M5 checkpoint / restore / revert through M4", () => {
  it("restore checkpoint reverts the file to its checkpoint state", async () => {
    await withEnv({}, async (env) => {
      // v1 → checkpoint → v2 → restore (all via the executor/M4).
      const write1 = await env.executor.execute(
        "apply_file_changes",
        { path: "a.txt", content: "v1" },
        { taskId: "t1" },
      );
      expect(write1.status).toBe("completed");

      const cp = await env.executor.execute(
        "create_checkpoint",
        { description: "at v1" },
        { taskId: "t1" },
      );
      expect(cp.status).toBe("completed");
      const checkpointId = (cp.output as { checkpointId: string }).checkpointId;

      const write2 = await env.executor.execute(
        "apply_file_changes",
        {
          path: "a.txt",
          content: "v2",
          expectedHash: (write1.output as { newHash: string }).newHash,
        },
        { taskId: "t1" },
      );
      expect(write2.status).toBe("completed");
      expect(fs.readFileSync(abs(env.root, "a.txt"), "utf8")).toBe("v2");

      const restore = await env.executor.execute(
        "restore_checkpoint",
        { checkpointId },
        { taskId: "t1" },
      );
      expect(restore.status).toBe("completed");
      const output = restore.output as { ok: boolean; conflicts: number };
      expect(output.ok).toBe(true);
      expect(output.conflicts).toBe(0);
      expect(fs.readFileSync(abs(env.root, "a.txt"), "utf8")).toBe("v1");
    });
  });

  it("revert_change undoes a single change through the M4 path", async () => {
    await withEnv({}, async (env) => {
      const write1 = await env.executor.execute(
        "apply_file_changes",
        { path: "a.txt", content: "v1" },
        { taskId: "t1" },
      );
      const change1 = (write1.output as { changeId: string }).changeId;

      const write2 = await env.executor.execute(
        "apply_file_changes",
        {
          path: "a.txt",
          content: "v2",
          expectedHash: (write1.output as { newHash: string }).newHash,
        },
        { taskId: "t1" },
      );
      const change2 = (write2.output as { changeId: string }).changeId;
      expect(fs.readFileSync(abs(env.root, "a.txt"), "utf8")).toBe("v2");

      const revert = await env.executor.execute(
        "revert_change",
        { changeId: change2 },
        { taskId: "t1" },
      );
      expect(revert.status).toBe("completed");
      expect(fs.readFileSync(abs(env.root, "a.txt"), "utf8")).toBe("v1");
      expect(env.toolchain.mutation.getChange(change2)?.status).toBe(
        "reverted",
      );

      // Reverting an already-reverted change is a clean no-op skip.
      const skip = await env.executor.execute(
        "revert_change",
        { changeId: change2 },
        { taskId: "t1" },
      );
      expect(skip.status).toBe("completed");
      expect((skip.output as { status: string }).status).toBe("skipped");

      // Revert the original create → file is deleted again.
      const revertCreate = await env.executor.execute(
        "revert_change",
        { changeId: change1 },
        { taskId: "t1" },
      );
      expect(revertCreate.status).toBe("completed");
      expect(fs.existsSync(abs(env.root, "a.txt"))).toBe(false);
    });
  });

  it("revert_task_changes undoes every change of the task", async () => {
    await withEnv({}, async (env) => {
      for (const file of ["f1.txt", "sub/f2.txt"]) {
        const result = await env.executor.execute(
          "apply_file_changes",
          { path: file, content: `content of ${file}` },
          { taskId: "t2" },
        );
        expect(result.status).toBe("completed");
      }
      expect(fs.existsSync(abs(env.root, "f1.txt"))).toBe(true);
      expect(fs.existsSync(abs(env.root, "sub/f2.txt"))).toBe(true);

      const revert = await env.executor.execute(
        "revert_task_changes",
        { taskId: "t2" },
        { taskId: "t2" },
      );
      expect(revert.status).toBe("completed");
      const output = revert.output as { ok: boolean; results: unknown[] };
      expect(output.ok).toBe(true);
      expect(output.results).toHaveLength(2);
      expect(fs.existsSync(abs(env.root, "f1.txt"))).toBe(false);
      expect(fs.existsSync(abs(env.root, "sub/f2.txt"))).toBe(false);
    });
  });

  it("restore detects externally-modified files and reports CONFLICT without overwriting", async () => {
    await withEnv({}, async (env) => {
      const write = await env.executor.execute(
        "apply_file_changes",
        { path: "a.txt", content: "v1" },
        { taskId: "t4" },
      );
      expect(write.status).toBe("completed");

      const cp = await env.executor.execute(
        "create_checkpoint",
        { description: "at v1" },
        { taskId: "t4" },
      );
      const checkpointId = (cp.output as { checkpointId: string }).checkpointId;

      // Simulate an external user edit AFTER the checkpoint (bypasses M5 —
      // exactly what conflict detection exists to protect).
      fs.writeFileSync(abs(env.root, "a.txt"), "user edit", "utf8");

      const restore = await env.executor.execute(
        "restore_checkpoint",
        { checkpointId },
        { taskId: "t4" },
      );
      expect(restore.status).toBe("completed");
      const output = restore.output as {
        ok: boolean;
        conflicts: number;
        restored: number;
        results: Array<{ path: string; status: string; reason?: string }>;
      };
      expect(output.conflicts).toBe(1);
      expect(output.restored).toBe(0);
      const fileResult = output.results[0]!;
      expect(fileResult.status).toBe("conflict");
      expect(fileResult.reason).toBeTruthy();

      // The user's work was NOT overwritten.
      expect(fs.readFileSync(abs(env.root, "a.txt"), "utf8")).toBe("user edit");
    });
  });

  it("emits structured M5 events with correlation ids and audit records the decision", async () => {
    await withEnv({}, async (env) => {
      const result = await env.executor.execute(
        "apply_file_changes",
        { path: "evt.txt", content: "x" },
        { taskId: "t5", sessionId: "s5" },
      );
      expect(result.status).toBe("completed");

      // Structured M5 events carry deterministic correlation ids:
      // FILE_CHANGE_STARTED and FILE_CHANGE_COMPLETED for the same change
      // share the changeId as eventId (correlation, not uniqueness).
      expect(env.events.length).toBeGreaterThan(0);
      const byKind = new Map<string, M5Event>();
      for (const event of env.events) {
        expect(event.eventId).toBeTruthy();
        expect(event.timestamp).toBeGreaterThan(0);
        expect(event.sessionId).toBe("s5");
        byKind.set(event.kind, event);
      }
      const started = byKind.get("FILE_CHANGE_STARTED");
      const completed = byKind.get("FILE_CHANGE_COMPLETED");
      expect(started).toBeDefined();
      expect(completed).toBeDefined();
      // Correlation: both lifecycle events reference the same change.
      expect(completed!.eventId).toBe(started!.eventId);
      expect(completed!.taskId).toBe("t5");

      // The M3 audit logger records the execution with its M4 decision.
      const auditEntries = env.audit
        .list(50)
        .filter((entry) => entry.toolId === "apply_file_changes");
      expect(auditEntries.length).toBeGreaterThan(0);
      expect(auditEntries[0]!.status).toBe("completed");
      expect(auditEntries[0]!.permissionDecision).toBeTruthy();
    });
  });
});
