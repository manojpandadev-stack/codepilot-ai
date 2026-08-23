/**
 * @codepilot/changeset-engine
 *
 * Real ChangeSet lifecycle for CodePilot AI.
 * Manages proposed file changes, user approval, conflict detection,
 * and safe application of patches to the workspace.
 */

import { createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, isAbsolute, relative, resolve as resolvePath } from "path";

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
  status: "pending" | "partially_applied" | "fully_applied" | "rejected" | "failed";
}

export interface ChangeSetOptions {
  workspaceRoot: string;
  onStatusChange?: (change: FileChange) => void;
}

// ============================================================================
// Diff Generation
// ============================================================================

export function generateDiff(original: string, proposed: string, _filePath: string): string {
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

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").substring(0, 16);
}

// ============================================================================
// ChangeSetManager
// ============================================================================

export class ChangeSetManager {
  private changeSets = new Map<string, ChangeSet>();
  private options: ChangeSetOptions;

  constructor(options: ChangeSetOptions) {
    this.options = options;
  }

  /**
   * Create a new ChangeSet from a list of proposed file changes.
   */
  createChangeSet(
    taskId: string,
    changes: Array<{ filePath: string; proposedContent: string }>
  ): ChangeSet {
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
  acceptChange(changeSetId: string, changeId: string): { success: boolean; error?: string } {
    const changeSet = this.changeSets.get(changeSetId);
    if (!changeSet) return { success: false, error: "ChangeSet not found" };

    const change = changeSet.changes.find(c => c.id === changeId);
    if (!change) return { success: false, error: "Change not found" };

    if (change.status !== "pending") {
      return { success: false, error: `Change is ${change.status}, not pending` };
    }

    // Conflict check
    if (!this.checkConflict(change)) {
      return {
        success: false,
        error: change.conflictInfo?.reason ?? "Conflict detected",
      };
    }

    // Apply
    try {
      const fullPath = this.resolvePath(change.filePath);
      const dir = dirname(fullPath);
      // Ensure directory exists
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(fullPath, change.proposedContent, "utf8");
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

    const change = changeSet.changes.find(c => c.id === changeId);
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
  acceptAll(changeSetId: string): { applied: number; failed: number; conflicts: number } {
    const changeSet = this.changeSets.get(changeSetId);
    if (!changeSet) return { applied: 0, failed: 0, conflicts: 0 };

    let applied = 0, failed = 0, conflicts = 0;

    for (const change of changeSet.changes) {
      if (change.status !== "pending") continue;

      const result = this.acceptChange(changeSetId, change.id);
      // Re-read status since acceptChange may have mutated it
      const currentStatus = this.changeSets.get(changeSetId)?.changes.find(c => c.id === change.id)?.status;
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
  rollbackChange(changeSetId: string, changeId: string): { success: boolean; error?: string } {
    const changeSet = this.changeSets.get(changeSetId);
    if (!changeSet) return { success: false, error: "ChangeSet not found" };

    const change = changeSet.changes.find(c => c.id === changeId);
    if (!change) return { success: false, error: "Change not found" };

    if (change.status !== "applied") {
      return { success: false, error: `Can only rollback applied changes (current: ${change.status})` };
    }

    try {
      const fullPath = this.resolvePath(change.filePath);

      if (!existsSync(fullPath)) {
        return { success: false, error: "File no longer exists" };
      }

      // Check that file hasn't been further modified
      const currentContent = this.readFileSafe(fullPath);
      if (currentContent !== change.proposedContent) {
        return {
          success: false,
          error: "File was modified after agent applied this change. Manual rollback required.",
        };
      }

      // Restore original content
      writeFileSync(fullPath, change.originalContent, "utf8");
      change.status = "rolled_back";
      change.updatedAt = Date.now();

      this.updateChangeSetStatus(changeSet);
      this.options.onStatusChange?.(change);

      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
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
    return Array.from(this.changeSets.values()).filter(cs => cs.status === "pending");
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
      workspaceRelativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
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
    const statuses = changeSet.changes.map(c => c.status);
    if (statuses.every(s => s === "applied")) {
      changeSet.status = "fully_applied";
    } else if (statuses.every(s => s === "rejected" || s === "rolled_back")) {
      changeSet.status = "rejected";
    } else if (statuses.some(s => s === "applied")) {
      changeSet.status = "partially_applied";
    } else if (statuses.every(s => s === "failed" || s === "conflict")) {
      changeSet.status = "failed";
    }
  }
}
