/**
 * @codepilot/tool-engine — M5 tool bindings
 *
 * Exposes the M5 FileMutationService / CheckpointManager as M3 ToolDefinitions so
 * file mutations flow through the single, audited execution path — there is no
 * alternate filesystem route:
 *
 *   ToolRegistry → ToolExecutionService (→ M4PermissionPipeline.evaluate)
 *                        └─(deny/boundary-fail)→ tool never runs, NO fs mutation
 *                        └─(approved)          → tool.execute()
 *                                              → FileMutationService.execute()
 *                                                 → PathGuard(M3 WorkspaceBoundary +
 *                                                    M4 SecurityValidator) per-op
 *                                                    → real fs mutation
 *
 * The M4 integration layer already maps every M5 tool id to a PermissionAction
 * (write_file for mutators, read_file for read-only inspectors) in
 * m4/integration.ts TOOL_ID_ACTION_MAP, so mutating tools require approval
 * unless an explicit policy says otherwise. The FileMutationService's own
 * M5PathGuard provides a second, independent boundary check (defense in depth).
 *
 * Checkpoint restore / revert NEVER touch the filesystem directly — they
 * dispatch inverse mutations through FileMutationService.execute(), so every
 * restore/revert is guarded, validated and tracked exactly like a live edit.
 */

import * as fs from "node:fs";
import type {
  Checkpoint,
  CheckpointFile,
  DiffResult,
  M5Event,
  MutationOp,
  RestoreFileResult,
} from "@codepilot/changeset-engine";
import {
  CheckpointManager,
  FileMutationService,
  computeDiff,
} from "@codepilot/changeset-engine";
import type { ToolContext, ToolDefinition } from "../m3/types.js";
import { toolError } from "../m3/types.js";
import { WorkspaceBoundary } from "../m3/workspace-boundary.js";
import { SecurityValidator } from "../m4/security-validator.js";
import { M5PathGuard } from "./security-adapter.js";

// ============================================================================
// Toolchain
// ============================================================================

export interface M5ToolOptions {
  /** Workspace root — every filesystem access is bounded to it. */
  workspaceRoot: string;
  /** Optional M5 event sink (host maps onto the event-engine). */
  onEvent?: (event: M5Event) => void;
}

/**
 * The wired M5 subsystem. A single shared FileMutationService keeps the change
 * ledger and checkpoint state coherent across all M5 tools.
 */
export interface M5Toolchain {
  workspaceRoot: string;
  boundary: WorkspaceBoundary;
  security: SecurityValidator;
  pathGuard: M5PathGuard;
  mutation: FileMutationService;
  checkpoints: CheckpointManager;
}

/**
 * Build the M5 toolchain backed by M3 WorkspaceBoundary + M4 SecurityValidator
 * (the production PathGuard). Constructing this is side-effect-free aside from
 * creating the in-memory services.
 */
export function createM5Toolchain(options: M5ToolOptions): M5Toolchain {
  const boundary = new WorkspaceBoundary(options.workspaceRoot);
  const security = new SecurityValidator({
    workspaceRoot: options.workspaceRoot,
  });
  const pathGuard = new M5PathGuard({ boundary, security });
  const mutation = new FileMutationService({
    workspaceRoot: options.workspaceRoot,
    pathGuard,
    onEvent: options.onEvent,
  });
  const checkpoints = new CheckpointManager({
    mutation,
    onEvent: options.onEvent,
  });
  return {
    workspaceRoot: options.workspaceRoot,
    boundary,
    security,
    pathGuard,
    mutation,
    checkpoints,
  };
}

// ============================================================================
// Shared helpers
// ============================================================================

function taskIdOf(ctx: ToolContext): string {
  return ctx.taskId ?? ctx.executionId;
}

function checkpointFile(
  cp: Checkpoint,
  relPath: string,
): CheckpointFile | undefined {
  return cp.files.find((f) => f.path === relPath);
}

function makeApplyFileChanges(t: M5Toolchain): ToolDefinition<
  { path: string; content: string; expectedHash?: string },
  {
    path: string;
    changeId: string;
    kind: string;
    newHash: string;
    error?: { code: string; message: string };
  }
> {
  return {
    id: "apply_file_changes",
    name: "Apply File Changes",
    description:
      "Create or replace a file atomically (workspace-relative). With expectedHash, performs an optimistic-concurrency modify.",
    category: "filesystem",
    version: "1.0.0",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path" },
        content: { type: "string", description: "UTF-8 file content" },
        expectedHash: {
          type: "string",
          description: "Optimistic-concurrency token for modify",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    capabilities: ["atomic", "cancellable"],
    permission: {
      level: "write",
      requiresApproval: true,
      rationale: "Create or overwrite a file in the workspace",
    },
    idempotent: false,
    async execute(input, ctx) {
      const rel = t.pathGuard.guard(input.path); // boundary + sensitive-file check
      const op: MutationOp =
        input.expectedHash !== undefined
          ? {
              kind: "modify",
              path: rel,
              content: input.content,
              expectedHash: input.expectedHash,
            }
          : { kind: "write", path: rel, content: input.content };
      const batch = await t.mutation.execute({
        taskId: taskIdOf(ctx),
        sessionId: ctx.sessionId,
        signal: ctx.signal,
        ops: [op],
      });
      const outcome = batch.outcomes[0];
      if (!outcome || !outcome.ok) {
        throw toolError(
          "IO_ERROR",
          outcome?.error?.message ?? "mutation failed",
          ctx.executionId,
          { recoverable: false },
        );
      }
      const change = outcome.changeId
        ? t.mutation.getChange(outcome.changeId)
        : undefined;
      return {
        path: rel,
        changeId: outcome.changeId ?? "",
        kind: change?.kind ?? op.kind,
        newHash: change?.newHash ?? "",
      };
    },
  };
}

function makeCreateCheckpoint(t: M5Toolchain): ToolDefinition<
  { description?: string; files?: string[] },
  {
    checkpointId: string;
    taskId: string;
    files: number;
    changeIds: number;
    status: string;
    timestamp: number;
  }
> {
  return {
    id: "create_checkpoint",
    name: "Create Checkpoint",
    description:
      "Capture a recoverable, hash-bounded snapshot of workspace files for later restore/revert.",
    category: "filesystem",
    version: "1.0.0",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
      required: [],
      additionalProperties: false,
    },
    capabilities: ["cancellable"],
    permission: {
      level: "read",
      requiresApproval: false,
      rationale: "Snapshot workspace state",
    },
    idempotent: true,
    async execute(input, ctx) {
      // Explicit file lists come from model input — guard every member so a
      // checkpoint can never snapshot (or read) outside the workspace.
      const guardedFiles = (input.files ?? []).map((f) => t.pathGuard.guard(f));
      const cp = t.checkpoints.createCheckpoint({
        taskId: taskIdOf(ctx),
        sessionId: ctx.sessionId,
        description: input.description ?? "checkpoint",
        files: guardedFiles,
        signal: ctx.signal,
      });
      return {
        checkpointId: cp.checkpointId,
        taskId: cp.taskId,
        files: cp.files.length,
        changeIds: cp.changeIds.length,
        status: cp.status,
        timestamp: cp.timestamp,
      };
    },
  };
}

function makeGetDiff(t: M5Toolchain): ToolDefinition<
  { path: string; checkpointId?: string },
  {
    path: string;
    operation: DiffResult["operation"];
    additions: number;
    deletions: number;
    binary: boolean;
    unifiedDiff: string;
  }
> {
  return {
    id: "get_diff",
    name: "Get Diff",
    description:
      "Structured diff of a file (additions/deletions/unified diff). Optionally against a checkpoint.",
    category: "filesystem",
    version: "1.0.0",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        checkpointId: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    capabilities: [],
    permission: {
      level: "read",
      requiresApproval: false,
      rationale: "Preview a file diff",
    },
    idempotent: true,
    async execute(input, ctx) {
      const rel = t.pathGuard.guard(input.path);
      const abs = t.mutation.absolutePath(rel);
      const newContent =
        fs.existsSync(abs) && fs.statSync(abs).isFile()
          ? fs.readFileSync(abs, "utf8")
          : null;
      if (input.checkpointId !== undefined) {
        const cp = t.checkpoints.getCheckpoint(input.checkpointId);
        if (!cp) {
          throw toolError(
            "NOT_FOUND",
            `checkpoint not found: ${input.checkpointId}`,
            ctx.executionId,
            {
              recoverable: false,
            },
          );
        }
        const file = checkpointFile(cp, rel);
        const oldContent = file?.existed ? (file.content ?? null) : null;
        const diff = computeDiff({
          filePath: rel,
          oldContent,
          newContent,
          context: 3,
        });
        return {
          path: rel,
          operation: diff.operation,
          additions: diff.additions,
          deletions: diff.deletions,
          binary: diff.binary,
          unifiedDiff: diff.unifiedDiff,
        };
      }
      const diff = computeDiff({ filePath: rel, oldContent: null, newContent });
      return {
        path: rel,
        operation: diff.operation,
        additions: diff.additions,
        deletions: diff.deletions,
        binary: diff.binary,
        unifiedDiff: diff.unifiedDiff,
      };
    },
  };
}

function makeListCheckpoints(t: M5Toolchain): ToolDefinition<
  { taskId?: string },
  {
    checkpoints: Array<{
      checkpointId: string;
      taskId: string;
      description: string;
      timestamp: number;
      files: number;
      changeIds: number;
      status: string;
    }>;
  }
> {
  return {
    id: "list_checkpoints",
    name: "List Checkpoints",
    description: "List captured checkpoints (optionally scoped to a task).",
    category: "filesystem",
    version: "1.0.0",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: [],
      additionalProperties: false,
    },
    capabilities: [],
    permission: {
      level: "read",
      requiresApproval: false,
      rationale: "List checkpoints",
    },
    idempotent: true,
    async execute(input): Promise<{
      checkpoints: Array<{
        checkpointId: string;
        taskId: string;
        description: string;
        timestamp: number;
        files: number;
        changeIds: number;
        status: string;
      }>;
    }> {
      return {
        checkpoints: t.checkpoints.listCheckpoints(input.taskId).map((cp) => ({
          checkpointId: cp.checkpointId,
          taskId: cp.taskId,
          description: cp.description,
          timestamp: cp.timestamp,
          files: cp.files.length,
          changeIds: cp.changeIds.length,
          status: cp.status,
        })),
      };
    },
  };
}

function makeRestoreCheckpoint(t: M5Toolchain): ToolDefinition<
  { checkpointId: string },
  {
    checkpointId: string;
    ok: boolean;
    restored: number;
    skipped: number;
    conflicts: number;
    failed: number;
    results: RestoreFileResult[];
  }
> {
  return {
    id: "restore_checkpoint",
    name: "Restore Checkpoint",
    description:
      "Restore files to a checkpoint state. Detects external modifications (CONFLICT) and never silently overwrites user work.",
    category: "filesystem",
    version: "1.0.0",
    inputSchema: {
      type: "object",
      properties: { checkpointId: { type: "string" } },
      required: ["checkpointId"],
      additionalProperties: false,
    },
    capabilities: ["cancellable"],
    permission: {
      level: "write",
      requiresApproval: true,
      rationale: "Restore workspace files from a checkpoint",
    },
    idempotent: false,
    async execute(input, ctx) {
      const result = await t.checkpoints.restoreCheckpoint(input.checkpointId, {
        taskId: taskIdOf(ctx),
        sessionId: ctx.sessionId,
        signal: ctx.signal,
      });
      return {
        checkpointId: result.checkpointId,
        ok: result.ok,
        restored: result.restored,
        skipped: result.skipped,
        conflicts: result.conflicts,
        failed: result.failed,
        results: result.results,
      };
    },
  };
}

function makeRevertChange(
  t: M5Toolchain,
): ToolDefinition<{ changeId: string }, RestoreFileResult> {
  return {
    id: "revert_change",
    name: "Revert Change",
    description: "Undo a single tracked mutation (restores prior content).",
    category: "filesystem",
    version: "1.0.0",
    inputSchema: {
      type: "object",
      properties: { changeId: { type: "string" } },
      required: ["changeId"],
      additionalProperties: false,
    },
    capabilities: ["cancellable"],
    permission: {
      level: "write",
      requiresApproval: true,
      rationale: "Revert a single file change",
    },
    idempotent: false,
    async execute(input, ctx) {
      return t.checkpoints.revertChange(input.changeId, {
        taskId: taskIdOf(ctx),
        sessionId: ctx.sessionId,
        signal: ctx.signal,
      });
    },
  };
}

function makeRevertTaskChanges(
  t: M5Toolchain,
): ToolDefinition<
  { taskId: string },
  { taskId: string; ok: boolean; results: RestoreFileResult[] }
> {
  return {
    id: "revert_task_changes",
    name: "Revert Task Changes",
    description:
      "Revert every applied change for a task (oldest first), preserving externally-modified files as conflicts.",
    category: "filesystem",
    version: "1.0.0",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false,
    },
    capabilities: ["cancellable"],
    permission: {
      level: "write",
      requiresApproval: true,
      rationale: "Revert all changes made by a task",
    },
    idempotent: false,
    async execute(input, ctx) {
      return t.checkpoints.revertTaskChanges(input.taskId, {
        sessionId: ctx.sessionId,
        signal: ctx.signal,
      });
    },
  };
}

/**
 * Build the M5-backed M3 tools bound to a shared toolchain. Register the
 * returned ToolDefinitions into the existing ToolRegistry — the
 * ToolExecutionService will route each one through M4PermissionPipeline
 * before execute() is ever called.
 */
export function createM5Tools(toolchain: M5Toolchain): ToolDefinition[] {
  return [
    makeApplyFileChanges(toolchain),
    makeCreateCheckpoint(toolchain),
    makeGetDiff(toolchain),
    makeListCheckpoints(toolchain),
    makeRestoreCheckpoint(toolchain),
    makeRevertChange(toolchain),
    makeRevertTaskChanges(toolchain),
  ];
}

/**
 * Build both the M5 toolchain and the bound M5 tools for a workspace. Convenience
 * for hosts (e.g. the VS Code extension) that wire M5 into the M3 execution path.
 */
export function createM5Toolset(options: M5ToolOptions): {
  toolchain: M5Toolchain;
  tools: ToolDefinition[];
} {
  const toolchain = createM5Toolchain(options);
  return { toolchain, tools: createM5Tools(toolchain) };
}
