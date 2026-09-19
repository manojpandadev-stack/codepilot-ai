/**
 * @codepilot/changeset-engine — M5 FileMutationService
 *
 * Executes file mutations (create/write/modify/delete/rename/move/directory
 * ops) with workspace-relative path guarding, optimistic concurrency (content
 * hashes), atomic writes, structured errors, per-op validation, diff metadata
 * and change tracking.
 *
 * SECURITY: this module is deliberately security-agnostic. Path/sensitive-file
 * enforcement is delegated to the injected PathGuard — in production the
 * tool-engine M5 adapter supplies a guard backed by the M3 WorkspaceBoundary +
 * M4 SecurityValidator, and every mutation is dispatched through the existing
 * M3 ToolExecutionService → M4 Permission Pipeline before reaching this code.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Buffer } from "node:buffer";
import { computeDiff, hashContent } from "./diff-engine.js";
import type { FileOperation } from "./diff-engine.js";
import { M5Error, toM5Error } from "./errors.js";
import type {
  MutationBatchResult,
  MutationKind,
  MutationOp,
  MutationRequest,
  MutationStatus,
  MutationValidation,
  TrackedChange,
  M5Event,
  MutationOutcome,
} from "./types.js";

// ============================================================================
// Security port (implemented by tool-engine via M3/M4 primitives)
// ============================================================================

/**
 * Path security port. `guard` must normalize the workspace-relative path and
 * throw an M5Error (INVALID_PATH / OUTSIDE_WORKSPACE / SENSITIVE_FILE) when
 * the path may not be touched. `isSensitive` flags files that must never be
 * mutated even when inside the workspace.
 */
export interface PathGuard {
  guard(workspaceRelativePath: string): string;
  isSensitive(workspaceRelativePath: string): boolean;
}

// ============================================================================
// Options
// ============================================================================

export interface FileMutationServiceOptions {
  workspaceRoot: string;
  pathGuard: PathGuard;
  /** Max bytes of content stored per snapshot side (default 1 MiB). */
  snapshotBudgetBytes?: number;
  /** Max ops per batch (default 50). */
  maxOpsPerBatch?: number;
  /** Max tracked changes retained (default 1000, trims to 500). */
  maxTrackedChanges?: number;
  /** Context lines embedded in stored unified diffs (default 3). */
  diffContext?: number;
  /** Max chars of unified diff text stored per change (default 20_000). */
  maxDiffChars?: number;
  /** Host event sink (mapped onto the event-engine by callers). */
  onEvent?: (event: M5Event) => void;
}

const DEFAULT_SNAPSHOT_BUDGET = 1_048_576;
const DEFAULT_MAX_OPS = 50;
const DEFAULT_MAX_CHANGES = 1_000;
const DEFAULT_DIFF_CONTEXT = 3;
const DEFAULT_MAX_DIFF_CHARS = 20_000;

// ============================================================================
// FileMutationService
// ============================================================================

export class FileMutationService {
  readonly workspaceRoot: string;
  private readonly guard: PathGuard;
  private readonly snapshotBudget: number;
  private readonly maxOps: number;
  private readonly maxChanges: number;
  private readonly diffContext: number;
  private readonly maxDiffChars: number;
  private readonly onEvent?: (event: M5Event) => void;
  private readonly ledger: TrackedChange[] = [];
  private seq = 0;

  constructor(options: FileMutationServiceOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.guard = options.pathGuard;
    this.snapshotBudget =
      options.snapshotBudgetBytes ?? DEFAULT_SNAPSHOT_BUDGET;
    this.maxOps = options.maxOpsPerBatch ?? DEFAULT_MAX_OPS;
    this.maxChanges = options.maxTrackedChanges ?? DEFAULT_MAX_CHANGES;
    this.diffContext = options.diffContext ?? DEFAULT_DIFF_CONTEXT;
    this.maxDiffChars = options.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS;
    this.onEvent = options.onEvent;
  }

  // ---- Ledger queries ----

  /** All tracked changes, oldest first (optionally filtered by task). */
  listChanges(taskId?: string): TrackedChange[] {
    const all = [...this.ledger];
    return taskId ? all.filter((c) => c.taskId === taskId) : all;
  }

  /** Latest applied (non-reverted, non-failed) change touching a path. */
  latestChangeFor(relPath: string, taskId?: string): TrackedChange | undefined {
    const all = this.listChanges(taskId).filter(
      (c) =>
        c.status === "applied" && (c.path === relPath || c.oldPath === relPath),
    );
    return all[all.length - 1];
  }

  getChange(changeId: string): TrackedChange | undefined {
    return this.ledger.find((c) => c.changeId === changeId);
  }

  /** Absolute path for a guarded workspace-relative path. */
  absolutePath(relPath: string): string {
    return path.join(this.workspaceRoot, relPath);
  }

  // ---- Batch execution ----

  async execute(request: MutationRequest): Promise<MutationBatchResult> {
    const startedAt = Date.now();
    const batchId = this.nextId("batch");
    if (request.ops.length > this.maxOps) {
      throw new M5Error("VALIDATION", `batch exceeds ${this.maxOps} ops`, {
        details: { ops: String(request.ops.length) },
      });
    }
    this.emit({
      kind: "FILE_CHANGE_STARTED",
      eventId: batchId,
      taskId: request.taskId,
      sessionId: request.sessionId,
      timestamp: startedAt,
      payload: { ops: request.ops.length },
    });

    const outcomes: MutationOutcome[] = [];
    const applied: TrackedChange[] = [];
    const allOrNothing = request.allOrNothing ?? true;
    let aborted = false;

    for (const op of request.ops) {
      if (aborted) {
        outcomes.push({
          op,
          ok: false,
          error: {
            code: "CANCELLED",
            message: "skipped: batch aborted after earlier failure",
          },
        });
        continue;
      }
      if (request.signal?.aborted) {
        aborted = true;
        outcomes.push({
          op,
          ok: false,
          error: { code: "CANCELLED", message: "cancelled before execution" },
        });
        continue;
      }
      if (request.deadline !== undefined && Date.now() > request.deadline) {
        aborted = true;
        outcomes.push({
          op,
          ok: false,
          error: {
            code: "TIMEOUT",
            message: "batch deadline exceeded before execution",
          },
        });
        continue;
      }
      const outcome = this.executeOp(op, request, batchId);
      outcomes.push(outcome);
      const change = outcome.changeId
        ? this.getChange(outcome.changeId)
        : undefined;
      if (change && change.status === "applied") applied.push(change);
      if (!outcome.ok && allOrNothing) aborted = true;
    }

    const completedAt = Date.now();
    const ok = outcomes.every((o) => o.ok);
    this.emit({
      kind: ok ? "FILE_CHANGE_COMPLETED" : "FILE_CHANGE_FAILED",
      eventId: batchId,
      taskId: request.taskId,
      sessionId: request.sessionId,
      timestamp: completedAt,
      payload: {
        applied: applied.length,
        failed: outcomes.filter((o) => !o.ok).length,
      },
    });

    return {
      taskId: request.taskId,
      ...(request.sessionId !== undefined
        ? { sessionId: request.sessionId }
        : {}),
      outcomes,
      applied,
      ok,
      startedAt,
      completedAt,
    };
  }

  // ---- Per-op execution ----

  private executeOp(
    op: MutationOp,
    request: MutationRequest,
    batchId: string,
  ): MutationOutcome {
    const changeId = this.nextId("chg");
    try {
      // Path security first — guard both source and destination.
      const relPath = this.guard.guard(op.path);
      if (this.guard.isSensitive(relPath)) {
        throw new M5Error("SENSITIVE_FILE", `path is protected: ${relPath}`, {
          path: relPath,
        });
      }
      const toRel = op.to !== undefined ? this.guard.guard(op.to) : undefined;
      if (toRel !== undefined && this.guard.isSensitive(toRel)) {
        throw new M5Error("SENSITIVE_FILE", `path is protected: ${toRel}`, {
          path: toRel,
        });
      }

      const change = this.applyMutation(op, relPath, toRel, {
        changeId,
        batchId,
        taskId: request.taskId,
        sessionId: request.sessionId,
      });
      this.record(change);
      return { op, changeId, ok: true };
    } catch (err) {
      const m5 = toM5Error(err, op.path);
      const failed: TrackedChange = {
        changeId,
        taskId: request.taskId,
        ...(request.sessionId !== undefined
          ? { sessionId: request.sessionId }
          : {}),
        kind: op.kind,
        path: op.path,
        ...(op.to !== undefined ? { oldPath: op.to } : {}),
        timestamp: Date.now(),
        status: "failed",
        error: m5.toJSON(),
      };
      this.record(failed);
      this.emit({
        kind: "FILE_CHANGE_FAILED",
        eventId: changeId,
        taskId: request.taskId,
        sessionId: request.sessionId,
        timestamp: failed.timestamp,
        payload: { error: m5.toJSON() },
      });
      return { op, ok: false, error: m5.toJSON() };
    }
  }

  /** Dispatch one guarded op to its fs implementation and build the record. */
  private applyMutation(
    op: MutationOp,
    relPath: string,
    toRel: string | undefined,
    ctx: {
      changeId: string;
      batchId: string;
      taskId: string;
      sessionId?: string;
    },
  ): TrackedChange {
    const abs = this.absolutePath(relPath);
    switch (op.kind) {
      case "create":
        return this.mutateContent(op, relPath, abs, ctx, {
          requireExists: false,
          requireAbsent: true,
          opLabel: "create",
        });
      case "write":
        return this.mutateContent(op, relPath, abs, ctx, {
          requireExists: false,
          requireAbsent: false,
          opLabel: "write",
        });
      case "modify":
        return this.mutateContent(op, relPath, abs, ctx, {
          requireExists: true,
          requireAbsent: false,
          opLabel: "modify",
        });
      case "delete":
        return this.mutateDelete(op, relPath, abs, ctx);
      case "rename":
      case "move":
        return this.mutateRename(op, relPath, abs, toRel, ctx);
      case "create_directory":
        return this.mutateCreateDirectory(relPath, abs, ctx);
      case "delete_directory":
        return this.mutateDeleteDirectory(relPath, abs, ctx);
    }
  }

  private mutateContent(
    op: MutationOp,
    relPath: string,
    abs: string,
    ctx: {
      changeId: string;
      batchId: string;
      taskId: string;
      sessionId?: string;
    },
    rules: {
      requireExists: boolean;
      requireAbsent: boolean;
      opLabel: "create" | "write" | "modify";
    },
  ): TrackedChange {
    if (op.content === undefined || typeof op.content !== "string") {
      throw new M5Error(
        "VALIDATION",
        `${rules.opLabel} requires string content`,
        {
          path: relPath,
        },
      );
    }
    const existed = fs.existsSync(abs);
    if (existed && fs.statSync(abs).isDirectory()) {
      throw new M5Error("INVALID_PATH", `path is a directory: ${relPath}`, {
        path: relPath,
      });
    }
    if (rules.requireAbsent && existed) {
      throw new M5Error(
        "FILE_ALREADY_EXISTS",
        `file already exists: ${relPath}`,
        {
          path: relPath,
        },
      );
    }
    if (rules.requireExists && !existed) {
      throw new M5Error("FILE_NOT_FOUND", `file not found: ${relPath}`, {
        path: relPath,
      });
    }
    // `modify` MUST carry an optimistic-concurrency guard.
    if (rules.opLabel === "modify" && op.expectedHash === undefined) {
      throw new M5Error(
        "VALIDATION",
        "modify requires expectedHash (optimistic concurrency)",
        { path: relPath },
      );
    }

    const oldContent = existed ? this.readFileSyncUtf8(abs) : null;
    const oldHash = oldContent !== null ? hashContent(oldContent) : undefined;
    if (
      op.expectedHash !== undefined &&
      (!existed || oldHash !== op.expectedHash)
    ) {
      throw new M5Error(
        "CONCURRENT_MODIFICATION",
        `file changed externally since expectedHash: ${relPath}`,
        {
          path: relPath,
          details: {
            expected: op.expectedHash,
            actual: oldHash ?? "<missing>",
          },
        },
      );
    }

    const newHash = hashContent(op.content);
    if (existed && oldHash === newHash && oldContent === op.content) {
      // Identical content — deterministic no-op recorded as applied write.
      const validation: MutationValidation = {
        ok: true,
        checks: { exists: true, hash_match: true, boundary_ok: true },
      };
      return this.buildChange(op, relPath, ctx, {
        kind: op.kind,
        oldHash,
        newHash,
        oldContent: existed ? this.snapshot(oldContent) : undefined,
        validation,
        status: "applied",
      });
    }

    this.atomicWrite(abs, op.content, existed);

    const validation = this.validateContentWrite(abs, newHash, relPath);
    const operation: FileOperation = existed ? "modified" : "created";
    const diff = computeDiff({
      filePath: relPath,
      oldContent,
      newContent: op.content,
      context: this.diffContext,
    });
    this.emitDiffGenerated(ctx, relPath, diff.unifiedDiff.length);
    return this.buildChange(op, relPath, ctx, {
      // A write onto a non-existent file IS a creation — record it as such so
      // the inverse op (delete) is available for revert/checkpoint rollback.
      kind: existed ? op.kind : "create",
      oldHash,
      newHash,
      oldContent: oldContent !== null ? this.snapshot(oldContent) : undefined,
      validation,
      status: "applied",
      diff: {
        operation,
        additions: diff.additions,
        deletions: diff.deletions,
        binary: diff.binary,
        ...(diff.binary
          ? {}
          : diff.unifiedDiff.length <= this.maxDiffChars
            ? { unifiedDiff: diff.unifiedDiff }
            : {}),
      },
    });
  }

  private mutateDelete(
    op: MutationOp,
    relPath: string,
    abs: string,
    ctx: {
      changeId: string;
      batchId: string;
      taskId: string;
      sessionId?: string;
    },
  ): TrackedChange {
    if (!fs.existsSync(abs)) {
      throw new M5Error("FILE_NOT_FOUND", `file not found: ${relPath}`, {
        path: relPath,
      });
    }
    if (fs.statSync(abs).isDirectory()) {
      throw new M5Error(
        "INVALID_PATH",
        `use delete_directory for directories: ${relPath}`,
        { path: relPath },
      );
    }
    const oldContent = this.readFileSyncUtf8(abs);
    const oldHash = hashContent(oldContent);
    if (op.expectedHash !== undefined && oldHash !== op.expectedHash) {
      throw new M5Error(
        "CONCURRENT_MODIFICATION",
        `file changed externally since expectedHash: ${relPath}`,
        {
          path: relPath,
          details: { expected: op.expectedHash, actual: oldHash },
        },
      );
    }
    fs.rmSync(abs, { force: false });
    const validation: MutationValidation = {
      ok: !fs.existsSync(abs),
      checks: { deleted: !fs.existsSync(abs), boundary_ok: true },
      ...(fs.existsSync(abs)
        ? { failureReason: "file still exists after delete" }
        : {}),
    };
    const diff = computeDiff({
      filePath: relPath,
      oldContent,
      newContent: null,
      context: this.diffContext,
    });
    this.emitDiffGenerated(ctx, relPath, diff.unifiedDiff.length);
    return this.buildChange(op, relPath, ctx, {
      kind: "delete",
      oldHash,
      oldContent: this.snapshot(oldContent),
      validation,
      status: "applied",
      diff: {
        operation: "deleted",
        additions: diff.additions,
        deletions: diff.deletions,
        binary: diff.binary,
        ...(diff.binary
          ? {}
          : diff.unifiedDiff.length <= this.maxDiffChars
            ? { unifiedDiff: diff.unifiedDiff }
            : {}),
      },
    });
  }

  private mutateRename(
    op: MutationOp,
    relPath: string,
    abs: string,
    toRel: string | undefined,
    ctx: {
      changeId: string;
      batchId: string;
      taskId: string;
      sessionId?: string;
    },
  ): TrackedChange {
    if (toRel === undefined) {
      throw new M5Error("VALIDATION", `${op.kind} requires "to"`, {
        path: relPath,
      });
    }
    if (!fs.existsSync(abs)) {
      throw new M5Error("FILE_NOT_FOUND", `file not found: ${relPath}`, {
        path: relPath,
      });
    }
    if (fs.statSync(abs).isDirectory()) {
      throw new M5Error(
        "INVALID_PATH",
        `only file rename/move is supported: ${relPath}`,
        { path: relPath },
      );
    }
    const toAbs = this.absolutePath(toRel);
    if (fs.existsSync(toAbs)) {
      throw new M5Error(
        "FILE_ALREADY_EXISTS",
        `destination already exists: ${toRel}`,
        { path: toRel },
      );
    }
    const oldContent = this.readFileSyncUtf8(abs);
    const oldHash = hashContent(oldContent);
    if (op.expectedHash !== undefined && oldHash !== op.expectedHash) {
      throw new M5Error(
        "CONCURRENT_MODIFICATION",
        `file changed externally since expectedHash: ${relPath}`,
        {
          path: relPath,
          details: { expected: op.expectedHash, actual: oldHash },
        },
      );
    }
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    fs.renameSync(abs, toAbs);
    const newHash = hashContent(this.readFileSyncUtf8(toAbs));
    const validation: MutationValidation = {
      ok: !fs.existsSync(abs) && fs.existsSync(toAbs),
      checks: {
        source_gone: !fs.existsSync(abs),
        dest_exists: fs.existsSync(toAbs),
        hash_match: fs.existsSync(toAbs) && newHash === oldHash,
        boundary_ok: true,
      },
    };
    return this.buildChange(op, toRel, ctx, {
      kind: op.kind,
      oldPath: relPath,
      oldHash,
      newHash,
      oldContent: this.snapshot(oldContent),
      validation,
      status: "applied",
    });
  }

  private mutateCreateDirectory(
    relPath: string,
    abs: string,
    ctx: {
      changeId: string;
      batchId: string;
      taskId: string;
      sessionId?: string;
    },
  ): TrackedChange {
    const existed = fs.existsSync(abs);
    if (existed && !fs.statSync(abs).isDirectory()) {
      throw new M5Error("INVALID_PATH", `path is a file: ${relPath}`, {
        path: relPath,
      });
    }
    fs.mkdirSync(abs, { recursive: true });
    const validation: MutationValidation = {
      ok: fs.existsSync(abs) && fs.statSync(abs).isDirectory(),
      checks: { exists: fs.existsSync(abs), boundary_ok: true },
    };
    return this.buildChange(
      { kind: "create_directory", path: relPath },
      relPath,
      ctx,
      { kind: "create_directory", validation, status: "applied" },
    );
  }

  private mutateDeleteDirectory(
    relPath: string,
    abs: string,
    ctx: {
      changeId: string;
      batchId: string;
      taskId: string;
      sessionId?: string;
    },
  ): TrackedChange {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new M5Error("FILE_NOT_FOUND", `directory not found: ${relPath}`, {
        path: relPath,
      });
    }
    fs.rmSync(abs, { recursive: true, force: false });
    const validation: MutationValidation = {
      ok: !fs.existsSync(abs),
      checks: { deleted: !fs.existsSync(abs), boundary_ok: true },
      ...(!fs.existsSync(abs)
        ? {}
        : { failureReason: "directory still exists after delete" }),
    };
    return this.buildChange(
      { kind: "delete_directory", path: relPath },
      relPath,
      ctx,
      { kind: "delete_directory", validation, status: "applied" },
    );
  }
  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq.toString(36)}-${Date.now().toString(36)}`;
  }

  private emit(event: M5Event): void {
    this.onEvent?.(event);
  }

  private record(change: TrackedChange): void {
    this.ledger.push(change);
    if (this.ledger.length > this.maxChanges) {
      this.ledger.splice(
        0,
        this.ledger.length - Math.floor(this.maxChanges / 2),
      );
    }
  }

  private readFileSyncUtf8(abs: string): string {
    return fs.readFileSync(abs, "utf8");
  }

  /**
   * Keep content snapshots for undo while they fit the budget; larger files
   * retain hashes only (revert then reports an unavailable snapshot).
   */
  private snapshot(content: string): string | undefined {
    if (Buffer.byteLength(content, "utf8") > this.snapshotBudget) {
      return undefined;
    }
    return content;
  }

  /** Atomic write: temp file in the target directory, then rename into place. */
  private atomicWrite(abs: string, content: string, existed: boolean): void {
    const dir = path.dirname(abs);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(
      dir,
      `.${path.basename(abs)}.m5-${process.pid}-${this.seq}.tmp`,
    );
    try {
      fs.writeFileSync(tmp, content, "utf8");
      if (existed) {
        // Preserve the original mode on the replacement inode.
        try {
          fs.chmodSync(tmp, fs.statSync(abs).mode & 0o7777);
        } catch {
          // Best-effort: ignore chmod failure on platforms without it.
        }
      }
      fs.renameSync(tmp, abs);
    } finally {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // Temp file already moved or never created.
      }
    }
  }

  /** Post-write verification: the file exists and matches the expected hash. */
  private validateContentWrite(
    abs: string,
    expectedHash: string,
    relPath: string,
  ): MutationValidation {
    let exists = false;
    let hashMatch = false;
    try {
      exists = fs.existsSync(abs) && fs.statSync(abs).isFile();
      if (exists) {
        hashMatch = hashContent(this.readFileSyncUtf8(abs)) === expectedHash;
      }
    } catch {
      // Fall through to a failed validation.
    }
    const checks = { exists, hash_match: hashMatch, boundary_ok: true };
    return {
      ok: exists && hashMatch,
      checks,
      ...(exists && hashMatch
        ? {}
        : { failureReason: "post-write validation failed: " + relPath }),
    };
  }

  /** Emit a DIFF_GENERATED event when a mutation produced a diff. */
  private emitDiffGenerated(
    ctx: {
      changeId: string;
      batchId: string;
      taskId: string;
      sessionId?: string;
    },
    relPath: string,
    unifiedLength: number,
  ): void {
    this.emit({
      kind: "DIFF_GENERATED",
      eventId: "diff-" + ctx.changeId,
      taskId: ctx.taskId,
      sessionId: ctx.sessionId,
      timestamp: Date.now(),
      payload: { path: relPath, changeId: ctx.changeId, unifiedLength },
    });
  }

  /**
   * Assemble the structured change record for an applied mutation. Content
   * snapshots are capped by the snapshot budget (see snapshot()).
   */
  private buildChange(
    _op: MutationOp,
    relPath: string,
    ctx: {
      changeId: string;
      batchId: string;
      taskId: string;
      sessionId?: string;
    },
    overrides: {
      kind: MutationKind;
      validation: MutationValidation;
      status: Extract<MutationStatus, "applied">;
      oldHash?: string;
      newHash?: string;
      oldContent?: string;
      oldPath?: string;
      diff?: TrackedChange["diff"];
    },
  ): TrackedChange {
    return {
      changeId: ctx.changeId,
      taskId: ctx.taskId,
      ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
      kind: overrides.kind,
      path: relPath,
      ...(overrides.oldPath !== undefined
        ? { oldPath: overrides.oldPath }
        : {}),
      ...(overrides.oldHash !== undefined
        ? { oldHash: overrides.oldHash }
        : {}),
      ...(overrides.newHash !== undefined
        ? { newHash: overrides.newHash }
        : {}),
      ...(overrides.oldContent !== undefined
        ? { oldContent: overrides.oldContent }
        : {}),
      timestamp: Date.now(),
      status: overrides.status,
      ...(overrides.diff !== undefined ? { diff: overrides.diff } : {}),
      validation: overrides.validation,
    };
  }
}
