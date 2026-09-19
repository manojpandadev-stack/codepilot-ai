/**
 * @codepilot/changeset-engine — M5 change-tracking model
 *
 * Strongly-typed records for every file mutation, plus checkpoints.
 * Names deliberately avoid collisions with the pre-M5 ChangeSet model
 * (`FileChange`, `ChangeStatus`) exported from the package root.
 */

import type { FileOperation } from "./diff-engine.js";

// ============================================================================
// Mutation operations
// ============================================================================

/** Logical mutation kinds supported by the FileMutationService. */
export type MutationKind =
  | "create"
  | "write"
  | "modify"
  | "delete"
  | "rename"
  | "move"
  | "create_directory"
  | "delete_directory";

/** One requested mutation, workspace-relative, guarded before execution. */
export interface MutationOp {
  kind: MutationKind;
  /** Workspace-relative target path (file or directory). */
  path: string;
  /** Destination path for rename/move (workspace-relative). */
  to?: string;
  /** New content for create/write/modify (UTF-8). */
  content?: string;
  /**
   * Optimistic-concurrency guard: hash the caller believes the file currently
   * has. Required for `modify`; if present for `write`/`delete`/`rename`/
   * `move` a mismatch aborts with CONCURRENT_MODIFICATION.
   */
  expectedHash?: string;
}

export interface MutationRequest {
  taskId: string;
  sessionId?: string;
  ops: MutationOp[];
  /** Abort all remaining ops (between-op cancellation points). */
  signal?: AbortSignal;
  /** Wall-clock deadline (ms since epoch) for the whole batch. */
  deadline?: number;
  /** Abort the batch when the first op fails (default: true). */
  allOrNothing?: boolean;
}

// ============================================================================
// Change records
// ============================================================================

/** Lifecycle of a tracked mutation. */
export type MutationStatus = "applied" | "failed" | "reverted" | "conflict";

/** Validation verdict attached to every applied mutation. */
export interface MutationValidation {
  ok: boolean;
  /** Individual check results, e.g. "exists", "hash_match", "boundary_ok". */
  checks: Record<string, boolean>;
  failureReason?: string;
}

/** Structured record of one executed (or failed) mutation. */
export interface TrackedChange {
  changeId: string;
  taskId: string;
  sessionId?: string;
  /** Set when the change belongs to a checkpoint window. */
  checkpointId?: string;
  kind: MutationKind;
  /** Workspace-relative target path (post-mutation location). */
  path: string;
  /** Previous path for rename/move. */
  oldPath?: string;
  oldHash?: string;
  newHash?: string;
  /**
   * Content snapshots for undo. Deduplicated by policy: stored only when the
   * operation needs them for revert (create/delete/modify/write/rename), and
   * only when the content fits the snapshot budget.
   */
  oldContent?: string;
  newContent?: string;
  timestamp: number;
  status: MutationStatus;
  /** Diff metadata (never embeds full file content). */
  diff?: {
    operation: FileOperation;
    additions: number;
    deletions: number;
    binary: boolean;
    /** Unified diff text, capped at `maxDiffChars`. */
    unifiedDiff?: string;
  };
  validation?: MutationValidation;
  error?: { code: string; message: string };
}

/** Outcome of one op inside a batch. */
export interface MutationOutcome {
  op: MutationOp;
  changeId?: string;
  ok: boolean;
  error?: { code: string; message: string; path?: string };
}

export interface MutationBatchResult {
  taskId: string;
  sessionId?: string;
  outcomes: MutationOutcome[];
  applied: TrackedChange[];
  ok: boolean;
  startedAt: number;
  completedAt: number;
}

// ============================================================================
// Checkpoints
// ============================================================================

/** Immutable snapshot of one file at checkpoint time. */
export interface CheckpointFile {
  path: string;
  /** Present when the file existed at checkpoint time. */
  content?: string;
  hash?: string;
  existed: boolean;
}

export type CheckpointStatus = "active" | "restored" | "superseded";

export interface Checkpoint {
  checkpointId: string;
  taskId: string;
  sessionId?: string;
  timestamp: number;
  description: string;
  /** Files captured at checkpoint time (bounded). */
  files: CheckpointFile[];
  /** Change IDs applied after this checkpoint (for targeted revert). */
  changeIds: string[];
  status: CheckpointStatus;
}

// ============================================================================
// Restore / revert results
// ============================================================================

export type RestoreFileStatus = "restored" | "skipped" | "conflict" | "failed";

export interface RestoreFileResult {
  path: string;
  status: RestoreFileStatus;
  reason?: string;
  changeId?: string;
}

export interface RestoreResult {
  checkpointId: string;
  results: RestoreFileResult[];
  restored: number;
  skipped: number;
  conflicts: number;
  failed: number;
  ok: boolean;
  timestamp: number;
}

// ============================================================================
// Core M5 events (host maps these onto the event-engine)
// ============================================================================

export type M5EventKind =
  | "CHECKPOINT_CREATED"
  | "FILE_CHANGE_STARTED"
  | "FILE_CHANGE_COMPLETED"
  | "FILE_CHANGE_FAILED"
  | "DIFF_GENERATED"
  | "RESTORE_STARTED"
  | "RESTORE_COMPLETED"
  | "RESTORE_CONFLICT"
  | "RESTORE_FAILED"
  | "CHANGE_REVERTED";

export interface M5Event {
  kind: M5EventKind;
  /** Deterministic correlation id (changeId / checkpointId / batch id). */
  eventId: string;
  taskId?: string;
  sessionId?: string;
  timestamp: number;
  payload: Record<string, unknown>;
}
