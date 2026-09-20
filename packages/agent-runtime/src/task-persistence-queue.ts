/**
 * @codepilot/agent-runtime — per-task persistence serialization
 *
 * TaskStore mutations follow read → mutate → write against one JSON file per
 * task. Concurrent mutations for the SAME task can interleave and silently
 * lose blocks (e.g. a tool_result dropped because another event's write
 * landed between its read and its write).
 *
 * TaskPersistenceQueue serializes mutations PER TASK: ops for one task always
 * execute in enqueue order; ops for different tasks run independently (no
 * global serialization). Cancellation is epoch-based — a cancel() bumps the
 * task's epoch so queued-but-not-started ops resolve as cancelled instead of
 * running late, and the queue state is cleaned up once drained. Nothing is
 * ever permanently locked.
 *
 * TaskStore itself remains the single canonical persistence store; this queue
 * only orders access to it.
 */

/** Outcome of one queued persistence operation. */
export interface TaskPersistenceOutcome<T> {
  ok: boolean;
  /** Present when ok. */
  value?: T;
  /** Present when !ok. */
  error?: string;
  /** True when the op was skipped because the task was cancelled. */
  cancelled?: boolean;
}

interface TaskQueueState {
  /** Settles after every enqueued op so far. */
  chain: Promise<void>;
  /** Bumped by cancel(); ops captured under an older epoch are skipped. */
  epoch: number;
  /** Ops enqueued but not yet settled. */
  pending: number;
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : String(error);
}

export class TaskPersistenceQueue {
  private readonly tasks = new Map<string, TaskQueueState>();

  /**
   * Run `op` after every previously enqueued op for `taskId` has settled.
   * Never throws — failures surface in the outcome, and a failed op never
   * blocks subsequent ops for the same task.
   */
  run<T>(
    taskId: string,
    op: () => Promise<T>,
  ): Promise<TaskPersistenceOutcome<T>> {
    let state = this.tasks.get(taskId);
    if (!state) {
      state = { chain: Promise.resolve(), epoch: 0, pending: 0 };
      this.tasks.set(taskId, state);
    }
    const captured = state;
    const myEpoch = captured.epoch;
    captured.pending += 1;

    const outcome: Promise<TaskPersistenceOutcome<T>> = captured.chain.then(
      () => {
        // Cancelled between enqueue and execution (epoch moved on) — skip.
        if (this.tasks.get(taskId) !== captured || captured.epoch !== myEpoch) {
          return { ok: false, cancelled: true } as TaskPersistenceOutcome<T>;
        }
        return op().then(
          (value) => ({ ok: true, value }) as TaskPersistenceOutcome<T>,
          (error: unknown) =>
            ({
              ok: false,
              error: errorToMessage(error),
            }) as TaskPersistenceOutcome<T>,
        );
      },
    );

    captured.chain = outcome.then(
      () => undefined,
      () => undefined,
    );
    void outcome
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        captured.pending -= 1;
        this.maybeCleanup(taskId, captured);
      });
    return outcome;
  }

  /**
   * Cancel every queued-but-not-started op for `taskId`. Ops already running
   * complete (they cannot be aborted mid-flight safely); their results are
   * still delivered. The queue is cleaned up once drained — a later run() for
   * the task starts a fresh chain (never permanently locked).
   */
  cancel(taskId: string): void {
    const state = this.tasks.get(taskId);
    if (!state) return;
    state.epoch += 1;
    this.maybeCleanup(taskId, state);
  }

  /** Number of ops enqueued but not yet settled for `taskId`. */
  pendingCount(taskId: string): number {
    return this.tasks.get(taskId)?.pending ?? 0;
  }

  /** True when no state and no pending ops exist for `taskId`. */
  isIdle(taskId: string): boolean {
    const state = this.tasks.get(taskId);
    return !state || state.pending === 0;
  }

  /**
   * Resolve when every op submitted for `taskId` *so far* has settled.
   * Queues never reject, so drain never throws. Ops submitted concurrently
   * with the drain may extend it by one lap — the loop re-checks until the
   * task is idle. Used by shutdown paths so deactivation never silently
   * discards terminal persistence.
   */
  async drain(taskId: string): Promise<void> {
    for (;;) {
      const state = this.tasks.get(taskId);
      if (!state) return;
      try {
        await state.chain;
      } catch {
        // The chain itself never rejects; belt and suspenders.
      }
      // Let settle-microtasks (pending accounting, cleanup) run before the
      // idle check — they are queued behind the chain we just awaited.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const current = this.tasks.get(taskId);
      if (!current || current.pending === 0) return;
    }
  }

  /**
   * Drain every tracked task (used by shutdown paths). Never throws.
   * Cancellation is NOT performed: in-flight terminal persistence must
   * complete, not be skipped.
   */
  async drainAll(): Promise<void> {
    // Snapshot keys: drain(taskId) re-checks liveness every lap, so tasks
    // that clean up mid-drain simply resolve.
    await Promise.all(
      [...this.tasks.keys()].map((taskId) => this.drain(taskId)),
    );
  }

  /** Cancel every tracked task and drop all queue state. */
  disposeAll(): void {
    for (const taskId of [...this.tasks.keys()]) {
      this.cancel(taskId);
    }
    this.tasks.clear();
  }

  /** Drop the task's queue state once drained — no permanently locked tasks. */
  private maybeCleanup(taskId: string, state: TaskQueueState): void {
    if (state.pending <= 0 && this.tasks.get(taskId) === state) {
      this.tasks.delete(taskId);
    }
  }
}
