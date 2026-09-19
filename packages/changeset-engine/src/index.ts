/**
 * @codepilot/changeset-engine
 *
 * Real ChangeSet lifecycle for CodePilot AI.
 * Manages proposed file changes, user approval, conflict detection,
 * and safe application of patches to the workspace.
 *
 * Security: All paths proposed via onWriteProposal MUST be validated using
 * the canonical SecurityValidator BEFORE creating a ChangeSet. Invalid paths
 * are rejected at staging time, not just at apply time.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, isAbsolute, relative, resolve as resolvePath } from "path";
import type { FileMutationService } from "./m5/file-mutation.js";
import { hashContent } from "./m5/diff-engine.js";

// ============================================================================
// Simple path validation (F-08) - inlined to avoid circular dependencies
// ============================================================================

const DEFAULT_SENSITIVE_PATHS = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".npmrc",
  ".pypirc",
  "id_rsa",
  "id_ed25519",
  "id_dsa",
  ".aws/credentials",
  ".aws/config",
  ".ssh/config",
  "netrc",
  ".netrc",
  "credentials.json",
  "secrets.json",
  "serviceAccountKey.json",
  "service-account-key.json",
  ".gnupg",
  "credentials.xml",
  ".azure/accessTokens.json",
  ".azure/azureProfile.json",
  "token.json",
  ".claude-code-router/config.json",
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Simple path validator for ChangeSet staging (F-08).
 * Validates that proposed paths are safe before creating a ChangeSet.
 */
export class SimplePathValidator {
  private readonly workspaceRoot: string;
  private readonly sensitivePatterns: RegExp[];

  constructor(workspaceRoot: string, extraSensitivePaths?: string[]) {
    this.workspaceRoot = resolvePath(workspaceRoot);
    const allPaths = [...DEFAULT_SENSITIVE_PATHS, ...(extraSensitivePaths ?? [])];
    this.sensitivePatterns = allPaths.map(
      (p) => new RegExp(escapeRegex(p) + "$", "i"),
    );
  }

  validatePath(rawPath: string): { allowed: boolean; reason?: string } {
    if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
      return { allowed: false, reason: "Path must be a non-empty string" };
    }

    // Reject null bytes (path traversal / injection)
    if (rawPath.includes("\x00")) {
      return { allowed: false, reason: "Path contains null bytes" };
    }

    const trimmed = rawPath.trim();
    
    // Reject absolute paths
    if (isAbsolute(trimmed)) {
      return {
        allowed: false,
        reason: `Absolute paths are not permitted: ${trimmed}`,
      };
    }

    // Reject Windows drive paths
    if (/^[a-zA-Z]:/.test(trimmed)) {
      return {
        allowed: false,
        reason: `Windows drive paths are not permitted: ${trimmed}`,
      };
    }

    // Reject UNC paths
    if (trimmed.startsWith("\\\\") || trimmed.startsWith("//")) {
      return {
        allowed: false,
        reason: `UNC/network paths are not permitted: ${trimmed}`,
      };
    }

    // Resolve relative to workspace root
    const resolved = resolvePath(this.workspaceRoot, trimmed);

    // Verify it's within workspace
    const rel = relative(this.workspaceRoot, resolved);
    if (
      rel === ".." ||
      rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(rel)
    ) {
      return {
        allowed: false,
        reason: `Path escapes workspace boundary: ${trimmed}`,
      };
    }

    // Check sensitive paths
    const relNormalized = rel.replace(/\\/g, "/");
    for (const pattern of this.sensitivePatterns) {
      if (pattern.test(relNormalized)) {
        return {
          allowed: false,
          reason: `Access to sensitive file denied: ${relNormalized}`,
        };
      }
    }

    return { allowed: true };
  }
}

// ============================================================================
// Types
// ============================================================================

export type ChangeStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "applied"
  | "failed"
  | "rolled_back"
  | "conflict";

export interface FileChange {
  id: string;
  filePath: string;
  originalContent: string;
  proposedContent: string;
  originalHash: string;
  diff: string;
  status: ChangeStatus;
  createdAt: number;
  updatedAt: number;
  checkpointId?: string;
  conflictInfo?: ConflictInfo;
}

export interface ConflictInfo {
  reason: string;
  currentHash: string;
  expectedHash: string;
}

export interface ChangeSet {
  id: string;
  taskId: string;
  changes: FileChange[];
  createdAt: number;
  status:
    "pending" | "partially_applied" | "fully_applied" | "rejected" | "failed";
}

export interface ChangeSetOptions {
  workspaceRoot: string;
  onStatusChange?: (change: FileChange) => void;
  /**
   * Canonical mutation path (M5). When provided, accept/rollback writes are
   * dispatched through FileMutationService — path guard, optimistic
   * concurrency, atomic writes, tracked changes, events — instead of raw
   * fs writes. Omitting it falls back to the legacy direct-write path.
   */
  mutation?: FileMutationService;
  /**
   * F-08: Simple path validator for staging-time path validation.
   * When provided, all proposed paths are validated before creating a ChangeSet.
   */
  securityValidator?: SimplePathValidator;
}

// ============================================================================
// Diff Generation
// ============================================================================

export function generateDiff(
  original: string,
  proposed: string,
  _filePath: string,
): string {
  const origLines = original.split("\n");
  const propLines = proposed.split("\n");
  const diff: string[] = [];
  const maxLines = Math.max(origLines.length, propLines.length);

  let i = 0;
  while (i < maxLines) {
    if (origLines[i] === propLines[i]) {
      diff.push(` ${origLines[i]}`);
      i++;
    } else {
      // Find next matching line
      let foundMatch = false;
      for (let j = i; j < Math.min(i + 20, maxLines); j++) {
        if (origLines[j] === propLines[i]) {
          // Removed lines
          for (let k = i; k < j; k++) {
            diff.push(`-${origLines[k] ?? ""}`);
          }
          i = j;
          foundMatch = true;
          break;
        }
      }
      if (!foundMatch) {
        if (i < origLines.length) {
          diff.push(`-${origLines[i]}`);
        }
        if (i < propLines.length) {
          diff.push(`+${propLines[i]}`);
        }
        i++;
      }
    }
  }

  return diff.join("\n");
}

// hashContent is imported from the M5 diff engine so ChangeSet hashes use
// the same algorithm FileMutationService validates expectedHash against.

// ============================================================================
// ChangeSetManager
// ============================================================================

export class ChangeSetManager {
  private changeSets = new Map<string, ChangeSet>();
  private options: ChangeSetOptions;
  private readonly mutation?: FileMutationService;
  private readonly pathValidator?: SimplePathValidator;

  constructor(options: ChangeSetOptions) {
    this.options = options;
    this.mutation = options.mutation;
    // F-08: Initialize path validator if securityValidator is provided
    if (options.securityValidator) {
      this.pathValidator = options.securityValidator as unknown as SimplePathValidator;
    }
  }

  /**
   * Create a new ChangeSet from a list of proposed file changes.
   * Validates all paths before creating the ChangeSet (F-08).
   */
  createChangeSet(
    taskId: string,
    changes: Array<{ filePath: string; proposedContent: string }>,
  ): ChangeSet {
    // F-08: Validate all proposed paths before creating ChangeSet
    if (this.pathValidator) {
      for (const change of changes) {
        const validation = this.pathValidator.validatePath(change.filePath);
        if (!validation.allowed) {
          throw new Error(`Path validation failed for '${change.filePath}': ${validation.reason}`);
        }
      }
    }

    const changeSetId = `cs-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    const fileChanges: FileChange[] = changes.map((c, i) => {
      const fullPath = this.resolvePath(c.filePath);
      const originalContent = this.readFileSafe(fullPath);
      const originalHash = hashContent(originalContent);
      const diff = generateDiff(originalContent, c.proposedContent, c.filePath);

      return {
        id: `${changeSetId}-${i}`,
        filePath: c.filePath,
        originalContent,
        proposedContent: c.proposedContent,
        originalHash,
        diff,
        status: "pending" as ChangeStatus,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    });

    const changeSet: ChangeSet = {
      id: changeSetId,
      taskId,
      changes: fileChanges,
      createdAt: Date.now(),
      status: "pending",
    };

    this.changeSets.set(changeSetId, changeSet);
    return changeSet;
  }

  /**
   * Check for external file conflicts before applying.
   * Returns true if the file is clean (matches original hash).
   */
  checkConflict(change: FileChange): boolean {
    const fullPath = this.resolvePath(change.filePath);

    if (!existsSync(fullPath)) {
      // New file — no conflict possible
      return true;
    }

    const currentContent = this.readFileSafe(fullPath);
    const currentHash = hashContent(currentContent);

    if (currentHash !== change.originalHash) {
      change.status = "conflict";
      change.conflictInfo = {
        reason: `File "${change.filePath}" was modified externally since the agent proposed this change.`,
        currentHash,
        expectedHash: change.originalHash,
      };
      change.updatedAt = Date.now();
      this.options.onStatusChange?.(change);
      return false;
    }

    return true;
  }

  /**
   * Accept a single change and apply it to the workspace.
   */
  async acceptChange(
    changeSetId: string,
    changeId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const changeSet = this.changeSets.get(changeSetId);
    if (!changeSet)
      return Promise.resolve({ success: false, error: "ChangeSet not found" });

    const change = changeSet.changes.find((c) => c.id === changeId);
    if (!change)
      return Promise.resolve({ success: false, error: "Change not found" });

    if (change.status !== "pending") {
      return Promise.resolve({
        success: false,
        error: `Change is ${change.status}, not pending`,
      });
    }

    // Conflict check
    if (!this.checkConflict(change)) {
      return Promise.resolve({
        success: false,
        error: change.conflictInfo?.reason ?? "Conflict detected",
      });
    }

    // Apply — through the canonical M5 mutation path when configured.
    try {
      if (this.mutation) {
        const existed = existsSync(this.resolvePath(change.filePath));
        const result = await this.mutation.execute({
          taskId: changeSet.taskId,
          ops: [
            existed
              ? {
                  kind: "modify",
                  path: change.filePath,
                  content: change.proposedContent,
                  expectedHash: change.originalHash,
                }
              : {
                  kind: "create",
                  path: change.filePath,
                  content: change.proposedContent,
                },
          ],
          allOrNothing: true,
        });
        if (!result.ok) {
          change.status = "failed";
          change.updatedAt = Date.now();
          this.updateChangeSetStatus(changeSet);
          this.options.onStatusChange?.(change);
          const failure =
            result.outcomes[0]?.error?.message ?? "mutation failed";
          return { success: false, error: failure };
        }
      } else {
        // Legacy direct-write path (no M5 configured — tests only).
        const fullPath = this.resolvePath(change.filePath);
        const dir = dirname(fullPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(fullPath, change.proposedContent, "utf8");
      }
      change.status = "applied";
      change.updatedAt = Date.now();

      this.updateChangeSetStatus(changeSet);
      this.options.onStatusChange?.(change);

      return { success: true };
    } catch (err) {
      change.status = "failed";
      change.updatedAt = Date.now();
      this.updateChangeSetStatus(changeSet);
      this.options.onStatusChange?.(change);
      return { success: false, error: String(err) };
    }
  }

  /**
   * Reject a single change — leave the original file untouched.
   */
  rejectChange(changeSetId: string, changeId: string): boolean {
    const changeSet = this.changeSets.get(changeSetId);
    if (!changeSet) return false;

    const change = changeSet.changes.find((c) => c.id === changeId);
    if (!change) return false;

    change.status = "rejected";
    change.updatedAt = Date.now();

    this.updateChangeSetStatus(changeSet);
    this.options.onStatusChange?.(change);
    return true;
  }

  /**
   * Accept all pending changes in a ChangeSet.
   */
  async acceptAll(changeSetId: string): Promise<{
    applied: number;
    failed: number;
    conflicts: number;
  }> {
    const changeSet = this.changeSets.get(changeSetId);
    if (!changeSet) return { applied: 0, failed: 0, conflicts: 0 };

    let applied = 0,
      failed = 0,
      conflicts = 0;

    for (const change of changeSet.changes) {
      if (change.status !== "pending") continue;

      const result = await this.acceptChange(changeSetId, change.id);
      // Re-read status since acceptChange may have mutated it
      const currentStatus = this.changeSets
        .get(changeSetId)
        ?.changes.find((c) => c.id === change.id)?.status;
      if (result.success) {
        applied++;
      } else if (currentStatus === "conflict") {
        conflicts++;
      } else {
        failed++;
      }
    }

    return { applied, failed, conflicts };
  }

  /**
   * Reject all pending changes in a ChangeSet.
   */
  rejectAll(changeSetId: string): number {
    const changeSet = this.changeSets.get(changeSetId);
    if (!changeSet) return 0;

    let count = 0;
    for (const change of changeSet.changes) {
      if (change.status === "pending") {
        this.rejectChange(changeSetId, change.id);
        count++;
      }
    }
    return count;
  }

  /**
   * Rollback a previously applied change.
   */
  rollbackChange(
    changeSetId: string,
    changeId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const changeSet = this.changeSets.get(changeSetId);
    if (!changeSet)
      return Promise.resolve({ success: false, error: "ChangeSet not found" });

    const change = changeSet.changes.find((c) => c.id === changeId);
    if (!change)
      return Promise.resolve({ success: false, error: "Change not found" });

    if (change.status !== "applied") {
      return Promise.resolve({
        success: false,
        error: `Can only rollback applied changes (current: ${change.status})`,
      });
    }

    const fullPath = this.resolvePath(change.filePath);

    if (!existsSync(fullPath)) {
      return Promise.resolve({
        success: false,
        error: "File no longer exists",
      });
    }

    // Check that file hasn't been further modified
    const currentContent = this.readFileSafe(fullPath);
    if (currentContent !== change.proposedContent) {
      return Promise.resolve({
        success: false,
        error:
          "File was modified after agent applied this change. Manual rollback required.",
      });
    }

    const finish = (): { success: boolean; error?: string } => {
      change.status = "rolled_back";
      change.updatedAt = Date.now();
      this.updateChangeSetStatus(changeSet);
      this.options.onStatusChange?.(change);
      return { success: true };
    };

    // Restore original content — through the canonical M5 path when configured.
    if (this.mutation) {
      return this.mutation
        .execute({
          taskId: changeSet.taskId,
          ops: [
            change.originalContent
              ? {
                  kind: "modify",
                  path: change.filePath,
                  content: change.originalContent,
                  expectedHash: hashContent(change.proposedContent),
                }
              : { kind: "delete", path: change.filePath },
          ],
          allOrNothing: true,
        })
        .then((result) => {
          if (!result.ok) {
            return {
              success: false,
              error: result.outcomes[0]?.error?.message ?? "rollback failed",
            };
          }
          return finish();
        })
        .catch((err: unknown) => ({ success: false, error: String(err) }));
    }

    try {
      writeFileSync(fullPath, change.originalContent, "utf8");
      return Promise.resolve(finish());
    } catch (err) {
      return Promise.resolve({ success: false, error: String(err) });
    }
  }

  /**
   * Get a ChangeSet by ID.
   */
  getChangeSet(id: string): ChangeSet | undefined {
    return this.changeSets.get(id);
  }

  /**
   * Get all pending ChangeSets.
   */
  getPendingChangeSets(): ChangeSet[] {
    return Array.from(this.changeSets.values()).filter(
      (cs) => cs.status === "pending",
    );
  }

  /**
   * Delete a ChangeSet (after it's been fully resolved).
   */
  deleteChangeSet(id: string): boolean {
    const cs = this.changeSets.get(id);
    if (!cs) return false;
    if (cs.status === "pending") return false;
    this.changeSets.delete(id);
    return true;
  }

  // ---- Private helpers ----

  private resolvePath(filePath: string): string {
    const workspaceRoot = resolvePath(this.options.workspaceRoot);
    const fullPath = resolvePath(workspaceRoot, filePath);
    const workspaceRelativePath = relative(workspaceRoot, fullPath);
    if (
      workspaceRelativePath === ".." ||
      workspaceRelativePath.startsWith(
        `..${process.platform === "win32" ? "\\" : "/"}`,
      ) ||
      isAbsolute(workspaceRelativePath)
    ) {
      throw new Error(`Path escapes workspace boundary: ${filePath}`);
    }
    return fullPath;
  }

  private readFileSafe(filePath: string): string {
    try {
      if (!existsSync(filePath)) return "";
      return readFileSync(filePath, "utf8");
    } catch {
      return "";
    }
  }

  private updateChangeSetStatus(changeSet: ChangeSet): void {
    const statuses = changeSet.changes.map((c) => c.status);
    if (statuses.every((s) => s === "applied")) {
      changeSet.status = "fully_applied";
    } else if (statuses.every((s) => s === "rejected" || s === "rolled_back")) {
      changeSet.status = "rejected";
    } else if (statuses.some((s) => s === "applied")) {
      changeSet.status = "partially_applied";
    } else if (statuses.every((s) => s === "failed" || s === "conflict")) {
      changeSet.status = "failed";
    }
  }
}

// ============================================================================
// M5 — File mutation / diff / checkpoints (additive, dependency-free core)
// ============================================================================

// Public re-exports of the M5 subsystem. Each module keeps its own file so the
// core stays trivially testable without any tool-engine/runtime coupling.

export type {
  PathGuard,
  FileMutationServiceOptions,
} from "./m5/file-mutation.js";
export { FileMutationService } from "./m5/file-mutation.js";

export type {
  CheckpointManagerOptions,
  RestoreOptions,
} from "./m5/checkpoint-manager.js";
export { CheckpointManager } from "./m5/checkpoint-manager.js";

export type {
  FileOperation,
  DiffLine,
  DiffHunk,
  DiffResult,
  ComputeDiffInput,
} from "./m5/diff-engine.js";
export {
  hashLine,
  hashContent,
  isBinaryContent,
  buildHunks,
  formatUnifiedDiff,
  computeDiff,
} from "./m5/diff-engine.js";

export type { M5ErrorCode } from "./m5/errors.js";
export { M5Error, toM5Error } from "./m5/errors.js";

export type {
  MutationKind,
  MutationOp,
  MutationRequest,
  MutationStatus,
  MutationValidation,
  TrackedChange,
  MutationOutcome,
  MutationBatchResult,
  CheckpointFile,
  CheckpointStatus,
  Checkpoint,
  RestoreFileStatus,
  RestoreFileResult,
  RestoreResult,
  M5EventKind,
  M5Event,
} from "./m5/types.js";
