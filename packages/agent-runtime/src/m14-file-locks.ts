/**
 * M14 — Multi-agent file-conflict prevention.
 *
 * The orchestrator runs agents in parallel (bounded concurrency). Two agents
 * mutating the same file concurrently would corrupt M5 changesets. This
 * module provides a per-workspace file-lock registry:
 *
 * - Orchestrated agents must acquire locks on every file they intend to
 *   mutate BEFORE mutating. Acquisition is all-or-nothing (atomic batch).
 * - Locks are released on task completion/failure/cancellation.
 * - A task that cannot acquire its full lock set waits (bounded) or fails
 *   with a typed conflict error — it never partially mutates.
 *
 * This is a coordination layer only: actual mutations still go through
 * M4 permission + M5 file engine, unchanged.
 */

export class FileConflictError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly files: string[],
    public readonly holderTaskId: string,
  ) {
    super(
      `Task ${taskId} cannot lock ${files.join(", ")} — held by task ${holderTaskId}`,
    );
    this.name = "FileConflictError";
  }
}

interface LockEntry {
  holderTaskId: string;
  acquiredAtMs: number;
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

export class FileLockRegistry {
  private locks = new Map<string, LockEntry>();
  private waiters: Array<() => void> = [];

  /**
   * Try to acquire ALL files for a task atomically. Either every file is
   * locked or none are. Returns the list of locked (normalized) files.
   * Throws FileConflictError if any file is held by another live task.
   */
  acquire(taskId: string, files: readonly string[]): string[] {
    const normalized = [...new Set(files.map(normalize))];
    const conflicts = new Map<string, string>();
    for (const file of normalized) {
      const holder = this.locks.get(file);
      if (holder && holder.holderTaskId !== taskId) {
        conflicts.set(file, holder.holderTaskId);
      }
    }
    if (conflicts.size > 0) {
      const [file, holder] = [...conflicts.entries()][0] ?? ["?", "?"];
      throw new FileConflictError(taskId, [file], holder);
    }
    // Re-entrant for the same task: idempotent.
    const now = Date.now();
    for (const file of normalized) {
      this.locks.set(file, { holderTaskId: taskId, acquiredAtMs: now });
    }
    return normalized;
  }

  /** Try-acquire variant: returns null instead of throwing on conflict. */
  tryAcquire(taskId: string, files: readonly string[]): string[] | null {
    try {
      return this.acquire(taskId, files);
    } catch {
      return null;
    }
  }

  /** Acquire with bounded waiting until files free up or timeout. */
  async acquireWithWait(
    taskId: string,
    files: readonly string[],
    timeoutMs = 30_000,
  ): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        return this.acquire(taskId, files);
      } catch {
        if (Date.now() >= deadline)
          throw new Error(`lock wait timeout for task ${taskId}`);
        await new Promise<void>((resolve) => {
          const waiter = (): void => {
            resolve();
          };
          this.waiters.push(waiter);
          setTimeout(resolve, Math.min(50, deadline - Date.now()));
        });
      }
    }
  }

  /** Release every lock held by a task (completion/failure/cancellation). */
  release(taskId: string): void {
    for (const [file, entry] of this.locks) {
      if (entry.holderTaskId === taskId) this.locks.delete(file);
    }
    this.notifyWaiters();
  }

  /** Release specific files for a task. */
  releaseFiles(taskId: string, files: readonly string[]): void {
    for (const file of files.map(normalize)) {
      const entry = this.locks.get(file);
      if (entry?.holderTaskId === taskId) this.locks.delete(file);
    }
    this.notifyWaiters();
  }

  /** Which task holds a file (normalized), if any. */
  holder(file: string): string | undefined {
    return this.locks.get(normalize(file))?.holderTaskId;
  }

  /** All locks held by a task. */
  locksFor(taskId: string): string[] {
    return [...this.locks.entries()]
      .filter(([, entry]) => entry.holderTaskId === taskId)
      .map(([file]) => file);
  }

  /** Detect and clear locks from dead tasks (crash recovery). */
  reapStale(
    maxAgeMs: number,
    isTaskAlive: (taskId: string) => boolean,
  ): string[] {
    const stale: string[] = [];
    for (const [file, entry] of this.locks) {
      if (
        !isTaskAlive(entry.holderTaskId) ||
        Date.now() - entry.acquiredAtMs > maxAgeMs
      ) {
        stale.push(`${file} (${entry.holderTaskId})`);
        this.locks.delete(file);
      }
    }
    if (stale.length > 0) this.notifyWaiters();
    return stale;
  }

  private notifyWaiters(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }
}
