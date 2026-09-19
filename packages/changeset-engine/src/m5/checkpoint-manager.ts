/**
 * @codepilot/changeset-engine — M5 CheckpointManager
 *
 * Checkpoints capture recoverable file state before/after groups of mutations.
 * Restore and revert NEVER touch the filesystem directly — every inverse
 * operation is dispatched through FileMutationService.execute(), which applies
 * the injected PathGuard (M3/M4-backed in production), optimistic concurrency
 * checks, validation, diff generation and change tracking.
 *
 * Conflict policy: a file is only restorable when its current content hash
 * matches the state our own tracked changes produced. If the file was modified
 * externally after the checkpoint (hash matches neither the checkpoint nor the
 * latest tracked change), restore reports a CONFLICT instead of destroying
 * user work.
 */

import * as fs from "node:fs";
import { hashContent } from "./diff-engine.js";
import { M5Error } from "./errors.js";
import type { FileMutationService } from "./file-mutation.js";
import type {
  Checkpoint,
  CheckpointFile,
  M5Event,
  MutationOp,
  RestoreFileResult,
  RestoreResult,
  TrackedChange,
} from "./types.js";

// ============================================================================
// Options
// ============================================================================

export interface CheckpointManagerOptions {
  /** Shared FileMutationService (all inverse ops flow through it). */
  mutation: FileMutationService;
  /** Host event sink (mapped onto the event-engine by callers). */
  onEvent?: (event: M5Event) => void;
  /** Max checkpoints retained (default 50, trims to 25). */
  maxCheckpoints?: number;
  /** Max files captured per checkpoint (default 200). */
  maxFilesPerCheckpoint?: number;
  /** Max total content bytes captured per checkpoint (default 8 MiB). */
  snapshotBudgetBytes?: number;
}

const DEFAULT_MAX_CHECKPOINTS = 50;
const DEFAULT_MAX_FILES = 200;
const DEFAULT_SNAPSHOT_BUDGET = 8 * 1_048_576;

/** Options for restore / revert operations. */
export interface RestoreOptions {
  taskId?: string;
  sessionId?: string;
  signal?: AbortSignal;
}

// ============================================================================
// CheckpointManager
// ============================================================================

export class CheckpointManager {
  private readonly mutation: FileMutationService;
  private readonly onEvent?: (event: M5Event) => void;
  private readonly maxCheckpoints: number;
  private readonly maxFiles: number;
  private readonly snapshotBudget: number;
  private readonly checkpoints = new Map<string, Checkpoint>();
  private seq = 0;

  constructor(options: CheckpointManagerOptions) {
    this.mutation = options.mutation;
    this.onEvent = options.onEvent;
    this.maxCheckpoints = options.maxCheckpoints ?? DEFAULT_MAX_CHECKPOINTS;
    this.maxFiles = options.maxFilesPerCheckpoint ?? DEFAULT_MAX_FILES;
    this.snapshotBudget =
      options.snapshotBudgetBytes ?? DEFAULT_SNAPSHOT_BUDGET;
  }

  // ---- Queries ----

  listCheckpoints(taskId?: string): Checkpoint[] {
    const all = [...this.checkpoints.values()].sort(
      (a, b) => a.timestamp - b.timestamp,
    );
    return taskId ? all.filter((c) => c.taskId === taskId) : all;
  }

  getCheckpoint(checkpointId: string): Checkpoint | undefined {
    return this.checkpoints.get(checkpointId);
  }

  // ---- Creation ----

  /**
   * Create a checkpoint. Captures current content of every file affected by
   * the task's applied changes (or an explicit `files` list), plus the change
   * IDs applied since the previous checkpoint of the same task. Deterministic:
   * identical repository state produces identical checkpoint metadata.
   */
  createCheckpoint(input: {
    taskId: string;
    sessionId?: string;
    description: string;
    /** Explicit workspace-relative paths (default: task's affected files). */
    files?: string[];
    signal?: AbortSignal;
  }): Checkpoint {
    const affected = this.resolveAffectedFiles(input.taskId, input.files);
    if (affected.length > this.maxFiles) {
      throw new M5Error(
        "VALIDATION",
        `checkpoint exceeds ${this.maxFiles} files`,
        { details: { files: String(affected.length) } },
      );
    }

    const files: CheckpointFile[] = [];
    let budget = this.snapshotBudget;
    for (const rel of affected) {
      if (input.signal?.aborted) {
        throw new M5Error("CANCELLED", "checkpoint cancelled", { path: rel });
      }
      const abs = this.mutation.absolutePath(rel);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const content = fs.readFileSync(abs, "utf8");
        const bytes = Buffer.byteLength(content, "utf8");
        if (bytes > budget) {
          throw new M5Error(
            "VALIDATION",
            "checkpoint snapshot budget exceeded",
            { path: rel, details: { bytes: String(bytes) } },
          );
        }
        budget -= bytes;
        files.push({
          path: rel,
          content,
          hash: hashContent(content),
          existed: true,
        });
      } else {
        files.push({ path: rel, existed: false });
      }
    }

    const changeIds = this.mutation
      .listChanges(input.taskId)
      .filter((c) => c.status === "applied" && c.checkpointId === undefined)
      .map((c) => c.changeId);

    const checkpointId = this.nextCheckpointId(files);
    const checkpoint: Checkpoint = {
      checkpointId,
      taskId: input.taskId,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      timestamp: Date.now(),
      description: input.description,
      files,
      changeIds,
      status: "active",
    };

    // Attribute newly covered changes to this checkpoint window.
    for (const changeId of changeIds) {
      const change = this.mutation.getChange(changeId);
      if (change) change.checkpointId = checkpointId;
    }

    this.checkpoints.set(checkpointId, checkpoint);
    this.trimCheckpoints();
    this.emit({
      kind: "CHECKPOINT_CREATED",
      eventId: checkpointId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      timestamp: checkpoint.timestamp,
      payload: {
        description: checkpoint.description,
        files: files.length,
        changes: changeIds.length,
      },
    });
    return checkpoint;
  }

  // ---- Restore ----

  /**
   * Restore every file captured in a checkpoint to its checkpoint state.
   * All inverse mutations flow through FileMutationService.execute() (guard,
   * concurrency, validation, tracking). Files modified externally after the
   * checkpoint produce a `conflict` result instead of being overwritten.
   */
  async restoreCheckpoint(
    checkpointId: string,
    options: RestoreOptions = {},
  ): Promise<RestoreResult> {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) {
      throw new M5Error(
        "CHECKPOINT_NOT_FOUND",
        `no checkpoint ${checkpointId}`,
      );
    }
    const taskId = options.taskId ?? checkpoint.taskId;
    const startedAt = Date.now();
    this.emit({
      kind: "RESTORE_STARTED",
      eventId: `restore-${checkpointId}`,
      taskId,
      sessionId: options.sessionId ?? checkpoint.sessionId,
      timestamp: startedAt,
      payload: { checkpointId, files: checkpoint.files.length },
    });

    const results: RestoreFileResult[] = [];
    const ops: MutationOp[] = [];
    for (const file of checkpoint.files) {
      if (options.signal?.aborted) {
        results.push({
          path: file.path,
          status: "failed",
          reason: "cancelled",
        });
        continue;
      }
      const outcome = this.planRestoreOp(checkpoint, file);
      results.push(outcome.result);
      if (outcome.op) ops.push(outcome.op);
    }

    if (ops.length > 0) {
      const batch = await this.mutation.execute({
        taskId,
        sessionId: options.sessionId ?? checkpoint.sessionId,
        ops,
        signal: options.signal,
      });
      // Reconcile executed op outcomes back into the per-file results.
      let opIndex = 0;
      for (let i = 0; i < results.length; i++) {
        const planned = results[i];
        if (!planned || planned.status !== "skipped" || !planned.reason)
          continue;
        if (planned.reason !== "restore planned") continue;
        const outcome = batch.outcomes[opIndex++];
        if (!outcome) continue;
        results[i] = outcome.ok
          ? {
              path: planned.path,
              status: "restored",
              changeId: outcome.changeId,
            }
          : {
              path: planned.path,
              status:
                outcome.error?.code === "CONCURRENT_MODIFICATION"
                  ? "conflict"
                  : "failed",
              reason: outcome.error?.message,
              changeId: outcome.changeId,
            };
      }
    }

    const restored = results.filter((r) => r.status === "restored").length;
    const conflicts = results.filter((r) => r.status === "conflict").length;
    const failed = results.filter((r) => r.status === "failed").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const ok = failed === 0;

    if (ok) {
      checkpoint.status = "restored";
    }
    const kind =
      conflicts > 0
        ? "RESTORE_CONFLICT"
        : ok
          ? "RESTORE_COMPLETED"
          : "RESTORE_FAILED";
    this.emit({
      kind,
      eventId: `restore-${checkpointId}`,
      taskId,
      sessionId: options.sessionId ?? checkpoint.sessionId,
      timestamp: Date.now(),
      payload: { checkpointId, restored, skipped, conflicts, failed },
    });

    return {
      checkpointId,
      results,
      restored,
      skipped,
      conflicts,
      failed,
      ok,
      timestamp: startedAt,
    };
  }

  // ==========================================================================
  // Revert / delete
  // ==========================================================================

  /**
   * Revert a single tracked change by applying its inverse mutation through
   * FileMutationService (path guard + concurrency + validation + tracking).
   */
  async revertChange(
    changeId: string,
    options: RestoreOptions = {},
  ): Promise<RestoreFileResult> {
    const change = this.mutation.getChange(changeId);
    if (!change) {
      throw new M5Error(
        "CHECKPOINT_NOT_FOUND",
        `no tracked change ${changeId}`,
      );
    }
    if (change.status !== "applied") {
      return {
        path: change.path,
        status: "skipped",
        reason: `change is already ${change.status}`,
      };
    }
    const op = this.inverseOpFor(change);
    if (!op) {
      return {
        path: change.path,
        status: "failed",
        reason: "no undo snapshot available for this change",
      };
    }
    const batch = await this.mutation.execute({
      taskId: options.taskId ?? change.taskId,
      sessionId: options.sessionId ?? change.sessionId,
      ops: [op],
      signal: options.signal,
    });
    const outcome = batch.outcomes[0];
    if (outcome?.ok) {
      change.status = "reverted";
      this.emit({
        kind: "CHANGE_REVERTED",
        eventId: `revert-${changeId}`,
        taskId: change.taskId,
        sessionId: change.sessionId,
        timestamp: Date.now(),
        payload: { changeId, path: change.path },
      });
      return { path: change.path, status: "restored", changeId };
    }
    return {
      path: change.path,
      status:
        outcome?.error?.code === "CONCURRENT_MODIFICATION"
          ? "conflict"
          : "failed",
      reason: outcome?.error?.message,
      changeId,
    };
  }

  /** Revert every applied change of a task (oldest first). */
  async revertTaskChanges(
    taskId: string,
    options: RestoreOptions = {},
  ): Promise<{ taskId: string; results: RestoreFileResult[]; ok: boolean }> {
    const changeIds = this.mutation
      .listChanges(taskId)
      .filter((c) => c.status === "applied")
      .map((c) => c.changeId);
    const results: RestoreFileResult[] = [];
    for (const changeId of changeIds) {
      if (options.signal?.aborted) {
        results.push({
          path: changeId,
          status: "failed",
          reason: "cancelled",
        });
        break;
      }
      results.push(await this.revertChange(changeId, { ...options, taskId }));
    }
    return {
      taskId,
      results,
      ok: results.every(
        (r) => r.status === "restored" || r.status === "skipped",
      ),
    };
  }

  /** Delete checkpoint metadata once it is no longer active. */
  deleteCheckpoint(checkpointId: string): boolean {
    const cp = this.checkpoints.get(checkpointId);
    if (!cp || cp.status === "active") return false;
    this.checkpoints.delete(checkpointId);
    return true;
  }
  // ==========================================================================
  // Private helpers
  // ==========================================================================

  /** Deterministic id: monotonic sequence + content-derived shard. */
  private nextCheckpointId(files: CheckpointFile[]): string {
    const sig = files
      .map((f) => `${f.path}:${f.existed ? (f.hash ?? "x") : "-"}`)
      .join("|");
    this.seq += 1;
    return `cp-${this.seq.toString(36)}-${hashContent(sig).slice(0, 10)}`;
  }

  private trimCheckpoints(): void {
    if (this.checkpoints.size <= this.maxCheckpoints) return;
    const sorted = [...this.checkpoints.values()].sort(
      (a, b) => a.timestamp - b.timestamp,
    );
    const keep = Math.floor(this.maxCheckpoints / 2);
    for (let i = 0; i < sorted.length - keep; i++) {
      const cp = sorted[i];
      if (cp) this.checkpoints.delete(cp.checkpointId);
    }
  }

  private emit(event: M5Event): void {
    this.onEvent?.(event);
  }

  /**
   * Files a checkpoint captures: the explicit list when provided, otherwise
   * every workspace-relative path touched by the task's applied changes.
   */
  private resolveAffectedFiles(taskId: string, files?: string[]): string[] {
    const rels = new Set<string>();
    if (files !== undefined) {
      for (const f of files) rels.add(f);
    }
    for (const c of this.mutation.listChanges(taskId)) {
      if (c.status !== "applied") continue;
      rels.add(c.path);
      if (c.oldPath !== undefined) rels.add(c.oldPath);
    }
    return [...rels].sort();
  }
  /**
   * Decide the per-file restore action. Files already at checkpoint state are
   * skipped; files whose current hash matches our own tracked changes produce
   * an inverse op (executed by the batch); everything else is a CONFLICT so
   * external modifications are never silently destroyed.
   */
  private planRestoreOp(
    checkpoint: Checkpoint,
    file: CheckpointFile,
  ): { result: RestoreFileResult; op?: MutationOp } {
    const abs = this.mutation.absolutePath(file.path);
    let curExists = false;
    let curHash: string | undefined;
    try {
      curExists = fs.existsSync(abs) && fs.statSync(abs).isFile();
      if (curExists) curHash = hashContent(fs.readFileSync(abs, "utf8"));
    } catch {
      curExists = false;
      curHash = undefined;
    }

    const applied = this.mutation
      .listChanges(checkpoint.taskId)
      .filter((c) => c.status === "applied");
    const lastForPath = [...applied]
      .reverse()
      .find((c) => c.path === file.path);
    const movedAway = applied.some(
      (c) =>
        c.oldPath === file.path && (c.kind === "rename" || c.kind === "move"),
    );

    if (file.existed) {
      // Checkpoint captured a file with content.
      if (curExists && curHash === file.hash) {
        return {
          result: {
            path: file.path,
            status: "skipped",
            reason: "already at checkpoint state",
          },
        };
      }
      if (curExists) {
        if (
          lastForPath?.newHash !== undefined &&
          lastForPath.newHash === curHash
        ) {
          return {
            result: {
              path: file.path,
              status: "skipped",
              reason: "restore planned",
            },
            op: {
              kind: "write",
              path: file.path,
              content: file.content ?? "",
              expectedHash: curHash,
            },
          };
        }
        return {
          result: {
            path: file.path,
            status: "conflict",
            reason: "externally modified since checkpoint",
          },
        };
      }
      // Checkpoint had the file but it is missing now.
      if (lastForPath?.kind === "delete" || movedAway) {
        return {
          result: {
            path: file.path,
            status: "skipped",
            reason: "restore planned",
          },
          op: { kind: "create", path: file.path, content: file.content ?? "" },
        };
      }
      return {
        result: {
          path: file.path,
          status: "conflict",
          reason: "file missing; not restored",
        },
      };
    }

    // Checkpoint captured a NONEXISTENT path — it was created afterwards.
    if (!curExists) {
      return {
        result: {
          path: file.path,
          status: "skipped",
          reason: "already at checkpoint state",
        },
      };
    }
    if (lastForPath?.newHash !== undefined && lastForPath.newHash === curHash) {
      return {
        result: {
          path: file.path,
          status: "skipped",
          reason: "restore planned",
        },
        op: { kind: "delete", path: file.path, expectedHash: curHash },
      };
    }
    return {
      result: {
        path: file.path,
        status: "conflict",
        reason: "externally modified since checkpoint",
      },
    };
  }

  /** Inverse mutation that undoes an applied change. */
  private inverseOpFor(change: TrackedChange): MutationOp | undefined {
    switch (change.kind) {
      case "create":
        return {
          kind: "delete",
          path: change.path,
          ...(change.newHash !== undefined
            ? { expectedHash: change.newHash }
            : {}),
        };
      case "write":
      case "modify":
        return change.oldContent !== undefined
          ? {
              kind: "write",
              path: change.path,
              content: change.oldContent,
              ...(change.newHash !== undefined
                ? { expectedHash: change.newHash }
                : {}),
            }
          : undefined;
      case "delete":
        return change.oldContent !== undefined
          ? { kind: "create", path: change.path, content: change.oldContent }
          : undefined;
      case "rename":
      case "move":
        return change.oldPath !== undefined
          ? { kind: "rename", path: change.path, to: change.oldPath }
          : undefined;
      case "create_directory":
        return { kind: "delete_directory", path: change.path };
      case "delete_directory":
        return { kind: "create_directory", path: change.path };
    }
  }
}
