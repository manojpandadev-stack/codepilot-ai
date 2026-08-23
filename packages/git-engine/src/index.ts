/**
 * @codepilot/git-engine
 *
 * Git intelligence for CodePilot AI. Provides repository status, diff analysis,
 * checkpoint management, and commit message generation.
 */

import simpleGit, {
  type SimpleGit,
  type StatusResult,
  type DiffResult,
} from "simple-git";
import type { CheckpointInfo, FileChange } from "@codepilot/shared";

// ============================================================================
// Git Status
// ============================================================================

export interface GitStatusInfo {
  current: string | null;
  tracking: string | null;
  ahead: number;
  behind: number;
  staged: FileChange[];
  modified: FileChange[];
  deleted: FileChange[];
  renamed: Array<{ from: string; to: string }>;
  untracked: string[];
  conflicted: string[];
  isClean: boolean;
}

// ============================================================================
// Git Engine
// ============================================================================

/**
 * Git engine providing repository intelligence, diffs, checkpoints,
 * and commit management for CodePilot AI.
 */
export class GitEngine {
  private git: SimpleGit;
  private checkpoints: Map<string, CheckpointInfo> = new Map();

  constructor(workingDir: string) {
    this.git = simpleGit(workingDir);
  }

  /**
   * Check if the directory is a git repository.
   */
  async isRepository(): Promise<boolean> {
    try {
      await this.git.status();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get repository status.
   */
  async getStatus(): Promise<GitStatusInfo> {
    const status: StatusResult = await this.git.status();

    return {
      current: status.current,
      tracking: status.tracking,
      ahead: status.ahead,
      behind: status.behind,
      staged: status.staged.map((file) => ({
        path: file,
        status: "modified" as const,
        additions: 0,
        deletions: 0,
      })),
      modified: status.modified.map((file) => ({
        path: file,
        status: "modified" as const,
        additions: 0,
        deletions: 0,
      })),
      deleted: status.deleted.map((file) => ({
        path: file,
        status: "deleted" as const,
        additions: 0,
        deletions: 0,
      })),
      renamed: status.renamed.map((r) => ({ from: r.from, to: r.to })),
      untracked: status.not_added,
      conflicted: status.conflicted,
      isClean: status.isClean(),
    };
  }

  /**
   * Get the diff for a specific file or all changes.
   */
  async getDiff(file?: string): Promise<string> {
    if (file) {
      return this.git.diff(["--", file]);
    }
    return this.git.diff();
  }

  /**
   * Get the diff with stat summary.
   */
  async getDiffStat(file?: string): Promise<DiffResult> {
    if (file) {
      return this.git.diffSummary(["--", file]);
    }
    return this.git.diffSummary();
  }

  /**
   * Get staged diff.
   */
  async getStagedDiff(): Promise<string> {
    return this.git.diff(["--cached"]);
  }

  /**
   * Get recent commit log.
   */
  async getLog(
    count = 10,
  ): Promise<
    Array<{ hash: string; date: string; message: string; author: string }>
  > {
    const log = await this.git.log({ maxCount: count });
    return log.all.map((entry) => ({
      hash: entry.hash,
      date: entry.date,
      message: entry.message,
      author: entry.author_name,
    }));
  }

  /**
   * Create a checkpoint (git stash or commit).
   */
  async createCheckpoint(description: string): Promise<CheckpointInfo> {
    const status = await this.getStatus();
    const checkpointId = `cp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    let commitHash: string | null = null;

    // Stage all changes
    if (!status.isClean) {
      await this.git.add(".");
      const result = await this.git.commit(
        `[CodePilot] Checkpoint: ${description}`,
      );
      commitHash = result.commit;
    }

    const checkpoint: CheckpointInfo = {
      id: checkpointId,
      gitCommitHash: commitHash,
      files: [
        ...status.staged.map((f) => f.path),
        ...status.modified.map((f) => f.path),
        ...status.deleted.map((f) => f.path),
        ...status.untracked,
      ],
      timestamp: Date.now(),
      taskId: null,
      description,
    };

    this.checkpoints.set(checkpointId, checkpoint);
    return checkpoint;
  }

  /**
   * Restore to a checkpoint.
   */
  async restoreCheckpoint(checkpointId: string): Promise<boolean> {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) return false;

    if (checkpoint.gitCommitHash) {
      // Reset to the checkpoint commit
      await this.git.reset(["--hard", checkpoint.gitCommitHash]);
      return true;
    }

    return false;
  }

  /**
   * Compare current state to a checkpoint.
   */
  async compareCheckpoint(checkpointId: string): Promise<{
    added: string[];
    modified: string[];
    removed: string[];
  } | null> {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint || !checkpoint.gitCommitHash) return null;

    try {
      const diff = await this.git.diff([
        "--name-status",
        checkpoint.gitCommitHash,
        "HEAD",
      ]);

      const added: string[] = [];
      const modified: string[] = [];
      const removed: string[] = [];

      const lines = diff.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        const [status, ...parts] = line.split("\t");
        const filePath = parts.join("\t");
        if (!filePath) continue;

        switch (status) {
          case "A":
            added.push(filePath);
            break;
          case "M":
          case "R":
            modified.push(filePath);
            break;
          case "D":
            removed.push(filePath);
            break;
        }
      }

      return { added, modified, removed };
    } catch {
      return null;
    }
  }

  /**
   * List all checkpoints.
   */
  listCheckpoints(): CheckpointInfo[] {
    return Array.from(this.checkpoints.values());
  }

  /**
   * Generate a commit message based on staged changes.
   */
  async generateCommitMessage(): Promise<string> {
    void (await this.getStagedDiff()); // staged diff available for analysis
    const status = await this.getStatus();

    const parts: string[] = [];
    const fileCount = status.staged.length;

    if (fileCount <= 3) {
      const fileNames = status.staged.map(
        (f) => f.path.split("/").pop() ?? f.path,
      );
      parts.push(`Update ${fileNames.join(", ")}`);
    } else {
      parts.push(`Update ${fileCount} files`);
    }

    // Check for common patterns
    const hasNewFiles = status.staged.some((f) => f.status === "added");
    const hasDeletedFiles = status.staged.some((f) => f.status === "deleted");

    if (hasNewFiles) parts.push("Add new files");
    if (hasDeletedFiles) parts.push("Remove files");

    return parts.join(": ") || "CodePilot changes";
  }

  /**
   * Create a commit with the given message.
   */
  async commit(message: string): Promise<string> {
    await this.git.add(".");
    const result = await this.git.commit(message);
    return result.commit;
  }
}
