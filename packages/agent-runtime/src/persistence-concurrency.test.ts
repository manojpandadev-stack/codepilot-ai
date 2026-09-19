/**
 * M12 v4 — persistence concurrency tests.
 *
 * Proves the per-task serialized persistence mechanism (TaskPersistenceQueue
 * + in-memory run capture + TaskStore upsert):
 *
 *  1. Two simultaneous tool completions.
 *  2. Reverse completion ordering.
 *  3. 10 concurrent tool completions.
 *  4. Assistant + tool event concurrency.
 *  5. Status transition during persistence.
 *  6. Persistence failure observability + chain survival.
 *  7. Cancellation during persistence (no permanent lock).
 *  8. Two independent tasks persisting simultaneously.
 *  9. Resume after concurrent events (protocol fidelity).
 *
 * The harness mirrors the production host pattern exactly: events mutate ONE
 * in-memory capture, and every store mutation for a task goes through
 * `queue.run(taskId, …)` — the store is only ever written, never
 * read-modify-written by the harness.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TaskStore } from "./m12-task-store.js";
import { TaskPersistenceQueue } from "./task-persistence-queue.js";
import { buildInitialMessages } from "./resume.js";
import { validateConversationProtocol } from "./compaction-protocol.js";
import {
  createRunCapture,
  appendCaptureText,
  recordCaptureToolUse,
  recordCaptureToolResult,
  composeRunBlocks,
  type RunCaptureState,
} from "./conversation-capture.js";

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-persist-conc-"));
}

const tick = (ms = 0): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Production-shaped flush: compose from memory, upsert through the queue.
 * Returns the queue outcome (never throws).
 */
function flushThroughQueue(
  queue: TaskPersistenceQueue,
  store: TaskStore,
  taskId: string,
  capture: RunCaptureState,
) {
  capture.dirty = false;
  return queue.run(taskId, async () => {
    const blocks = composeRunBlocks(capture);
    if (blocks.length === 0) return "empty";
    await store.upsertConversationEntry(taskId, capture.key, {
      role: "assistant",
      blocks,
      timestampMs: Date.now(),
    });
    return "flushed";
  });
}

describe("persistence concurrency — per-task serialization", () => {
  let dir: string;
  let store: TaskStore;
  let queue: TaskPersistenceQueue;

  beforeEach(() => {
    dir = makeDir();
    store = new TaskStore(dir);
    queue = new TaskPersistenceQueue();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("1. two simultaneous tool completions both persist", async () => {
    const task = await store.create("two tools");
    const capture = createRunCapture();
    recordCaptureToolUse(capture, "call-A", "read_file", { path: "a.ts" });
    recordCaptureToolUse(capture, "call-B", "read_file", { path: "b.ts" });

    // Both completions arrive "at once": neither awaits the other.
    recordCaptureToolResult(capture, "call-A", "read_file", "contents-a", false);
    const flushA = flushThroughQueue(queue, store, task.id, capture);
    recordCaptureToolResult(capture, "call-B", "read_file", "contents-b", false);
    const flushB = flushThroughQueue(queue, store, task.id, capture);
    const [outA, outB] = await Promise.all([flushA, flushB]);
    expect(outA.ok).toBe(true);
    expect(outB.ok).toBe(true);

    const loaded = await store.get(task.id);
    const entry = loaded?.conversation?.find((e) => e.key === capture.key);
    const results = (entry?.blocks ?? []).filter((b) => b.type === "tool_result");
    expect(results).toHaveLength(2);
    expect(results.map((b) => b.type === "tool_result" && b.tool_use_id).sort()).toEqual([
      "call-A",
      "call-B",
    ]);
  });

  it("2. reverse completion ordering keeps both results paired", async () => {
    const task = await store.create("reverse order");
    const capture = createRunCapture();
    // Requested A then B…
    recordCaptureToolUse(capture, "call-A", "bash", { command: "slow" });
    recordCaptureToolUse(capture, "call-B", "bash", { command: "fast" });
    // …but B completes first.
    recordCaptureToolResult(capture, "call-B", "bash", "fast-out", false);
    const flushB = flushThroughQueue(queue, store, task.id, capture);
    recordCaptureToolResult(capture, "call-A", "bash", "slow-out", false);
    const flushA = flushThroughQueue(queue, store, task.id, capture);
    await Promise.all([flushA, flushB]);

    const loaded = await store.get(task.id);
    const entry = loaded?.conversation?.find((e) => e.key === capture.key);
    const blocks = entry?.blocks ?? [];
    const uses = blocks.filter((b) => b.type === "tool_use");
    const results = blocks.filter((b) => b.type === "tool_result");
    expect(uses).toHaveLength(2);
    expect(results).toHaveLength(2);
    // Every result pairs with a use of the same id — no orphans, no dups.
    const useIds = new Set(
      uses.map((b) => (b.type === "tool_use" ? b.id : "")),
    );
    for (const r of results) {
      expect(r.type).toBe("tool_result");
      if (r.type === "tool_result") {
        expect(useIds.has(r.tool_use_id)).toBe(true);
      }
    }
    expect(useIds.size).toBe(2);
  });

  it("3. ten concurrent tool completions lose nothing", async () => {
    const task = await store.create("ten tools");
    const capture = createRunCapture();
    for (let i = 0; i < 10; i += 1) {
      recordCaptureToolUse(capture, `call-${i}`, "read_file", { path: `f${i}.ts` });
    }
    const flushes = [];
    for (let i = 0; i < 10; i += 1) {
      recordCaptureToolResult(capture, `call-${i}`, "read_file", `out-${i}`, false);
      flushes.push(flushThroughQueue(queue, store, task.id, capture));
    }
    const outcomes = await Promise.all(flushes);
    expect(outcomes.every((o) => o.ok)).toBe(true);

    const loaded = await store.get(task.id);
    const entry = loaded?.conversation?.find((e) => e.key === capture.key);
    const blocks = entry?.blocks ?? [];
    expect(blocks.filter((b) => b.type === "tool_use")).toHaveLength(10);
    expect(blocks.filter((b) => b.type === "tool_result")).toHaveLength(10);
  });

  it("4. assistant text + tool events persist together without corruption", async () => {
    const task = await store.create("assistant plus tools");
    const capture = createRunCapture();
    appendCaptureText(capture, "Let me read both files.", undefined);
    const textFlush = flushThroughQueue(queue, store, task.id, capture);
    recordCaptureToolUse(capture, "call-A", "read_file", { path: "a.ts" });
    recordCaptureToolResult(capture, "call-A", "read_file", "aaa", false);
    const toolFlush = flushThroughQueue(queue, store, task.id, capture);
    appendCaptureText(capture, "Let me read both files. Done.", "Let me read both files. Done.");
    const textFlush2 = flushThroughQueue(queue, store, task.id, capture);
    await Promise.all([textFlush, toolFlush, textFlush2]);

    const loaded = await store.get(task.id);
    const entry = loaded?.conversation?.find((e) => e.key === capture.key);
    const blocks = entry?.blocks ?? [];
    // Serialized flushes converge: the LAST flush wrote the full state.
    expect(blocks.filter((b) => b.type === "text")).toHaveLength(1);
    expect(blocks.filter((b) => b.type === "tool_use")).toHaveLength(1);
    expect(blocks.filter((b) => b.type === "tool_result")).toHaveLength(1);
    const text = blocks.find((b) => b.type === "text");
    expect(text?.type === "text" && text.text).toBe("Let me read both files. Done.");
  });

  it("5. status transition during persistence stays deterministic", async () => {
    const task = await store.create("status race");
    const capture = createRunCapture();
    appendCaptureText(capture, "working…", undefined);
    recordCaptureToolUse(capture, "call-A", "bash", { command: "make" });
    recordCaptureToolResult(capture, "call-A", "bash", "ok", false);

    // Conversation flushes in flight…
    const flush1 = flushThroughQueue(queue, store, task.id, capture);
    const flush2 = flushThroughQueue(queue, store, task.id, capture);
    // …then the terminal op (flush + log + status), ordered AFTER them.
    const terminal = queue.run(task.id, async () => {
      const blocks = composeRunBlocks(capture);
      await store.upsertConversationEntry(task.id, capture.key, {
        role: "assistant",
        blocks,
        timestampMs: Date.now(),
      });
      await store.appendMessage(task.id, "assistant", "done");
      await store.update(task.id, { status: "completed" });
      return "terminal";
    });
    const outcomes = await Promise.all([flush1, flush2, terminal]);
    expect(outcomes.every((o) => o.ok)).toBe(true);

    const loaded = await store.get(task.id);
    expect(loaded?.status).toBe("completed");
    expect(loaded?.messages.at(-1)?.content).toBe("done");
    const entry = loaded?.conversation?.find((e) => e.key === capture.key);
    expect(entry?.blocks?.filter((b) => b.type === "tool_result")).toHaveLength(1);
    expect(queue.isIdle(task.id)).toBe(true);
  });

  it("6. persistence failure is observable and never blocks the chain", async () => {
    const task = await store.create("failure");
    const failing = await queue.run(task.id, async () => {
      throw new Error("disk exploded");
    });
    expect(failing.ok).toBe(false);
    expect(failing.cancelled).toBeUndefined();
    expect(failing.error).toContain("disk exploded");

    // The chain survives: a later op for the same task still runs.
    const capture = createRunCapture();
    appendCaptureText(capture, "after failure", undefined);
    const next = await flushThroughQueue(queue, store, task.id, capture);
    expect(next.ok).toBe(true);
    expect(next.value).toBe("flushed");
    const loaded = await store.get(task.id);
    expect(
      loaded?.conversation?.find((e) => e.key === capture.key)?.blocks,
    ).toHaveLength(1);
  });

  it("7. cancellation during persistence never permanently locks the queue", async () => {
    const task = await store.create("cancel race");
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    // A slow op holds the chain…
    const slow = queue.run(task.id, async () => {
      await slowGate;
      return "slow-done";
    });
    // …a second op queues behind it…
    const queued = queue.run(task.id, async () => "should-be-cancelled");
    await tick(10);
    expect(queue.pendingCount(task.id)).toBe(2);
    // …cancellation skips the queued-but-not-started op…
    queue.cancel(task.id);
    releaseSlow();
    expect((await slow).ok).toBe(true);
    const cancelledOutcome = await queued;
    expect(cancelledOutcome.ok).toBe(false);
    expect(cancelledOutcome.cancelled).toBe(true);
    // …the queue drains (cleanup runs on the settle microtask — one
    // macrotask tick is enough), and a later run starts a fresh chain.
    await tick(10);
    expect(queue.isIdle(task.id)).toBe(true);
    const after = await queue.run(task.id, async () => {
      await store.update(task.id, { status: "completed" });
      return "recovered";
    });
    expect(after.ok).toBe(true);
    expect((await store.get(task.id))?.status).toBe("completed");
    await tick(10);
    expect(queue.isIdle(task.id)).toBe(true);
  });

  it("8. two independent tasks persist simultaneously without cross-talk", async () => {
    const taskA = await store.create("task A");
    const taskB = await store.create("task B");
    const capA = createRunCapture();
    const capB = createRunCapture();
    appendCaptureText(capA, "text-A", undefined);
    appendCaptureText(capB, "text-B", undefined);
    recordCaptureToolUse(capA, "call-A", "bash", { command: "a" });
    recordCaptureToolUse(capB, "call-B", "bash", { command: "b" });

    // Track overlap: both tasks' ops must be in flight at the same time
    // (no global lock serializing different tasks).
    let inFlight = 0;
    let maxInFlight = 0;
    const tracked = (
      taskId: string,
      capture: RunCaptureState,
      gateMs: number,
    ) =>
      queue.run(taskId, async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await tick(gateMs);
        const blocks = composeRunBlocks(capture);
        await store.upsertConversationEntry(taskId, capture.key, {
          role: "assistant",
          blocks,
          timestampMs: Date.now(),
        });
        inFlight -= 1;
        return taskId;
      });
    const [outA, outB] = await Promise.all([
      tracked(taskA.id, capA, 30),
      tracked(taskB.id, capB, 30),
    ]);
    expect(outA.ok && outB.ok).toBe(true);
    expect(maxInFlight).toBe(2);

    const loadedA = await store.get(taskA.id);
    const loadedB = await store.get(taskB.id);
    const textOf = (t: typeof loadedA, key: string) =>
      t?.conversation
        ?.find((e) => e.key === key)
        ?.blocks?.find((b) => b.type === "text");
    expect(textOf(loadedA, capA.key)?.type === "text" && (textOf(loadedA, capA.key) as { text: string }).text).toBe(
      "text-A",
    );
    expect(textOf(loadedB, capB.key)?.type === "text" && (textOf(loadedB, capB.key) as { text: string }).text).toBe(
      "text-B",
    );
  });

  it("9. resume after concurrent tool events stays protocol-correct", async () => {
    const task = await store.create("resume me");
    await store.appendMessage(task.id, "user", "read both files");
    const capture = createRunCapture();
    // tool_use(A), tool_use(B), tool_result(A), tool_result(B) — the exact
    // interleaving the milestone calls out — persisted concurrently.
    recordCaptureToolUse(capture, "call-A", "read_file", { path: "a.ts" });
    recordCaptureToolUse(capture, "call-B", "read_file", { path: "b.ts" });
    recordCaptureToolResult(capture, "call-A", "read_file", "contents-a", false);
    const f1 = flushThroughQueue(queue, store, task.id, capture);
    recordCaptureToolResult(capture, "call-B", "read_file", "contents-b", false);
    const f2 = flushThroughQueue(queue, store, task.id, capture);
    await Promise.all([f1, f2]);
    await store.update(task.id, { status: "interrupted" });

    // New store instance simulates a restart.
    const revived = new TaskStore(dir);
    const resumed = await revived.get(task.id);
    expect(resumed).not.toBeNull();
    const wire = buildInitialMessages(resumed!);
    // User seed + assistant(tool_use A,B) + user(tool_result A,B).
    expect(wire).toHaveLength(3);
    expect(wire[0]?.role).toBe("user");
    const assistant = wire[1]!;
    expect(assistant.role).toBe("assistant");
    expect(Array.isArray(assistant.content)).toBe(true);
    const useIds = (assistant.content as Array<{ type: string; id?: string }>)
      .filter((b) => b.type === "tool_use")
      .map((b) => b.id)
      .sort();
    expect(useIds).toEqual(["call-A", "call-B"]);
    const results = wire[2]!;
    expect(results.role).toBe("user");
    const resultIds = (
      results.content as Array<{ type: string; tool_use_id?: string }>
    )
      .filter((b) => b.type === "tool_result")
      .map((b) => b.tool_use_id)
      .sort();
    expect(resultIds).toEqual(["call-A", "call-B"]);
    // The repo's own strict protocol validator agrees.
    expect(validateConversationProtocol(wire).valid).toBe(true);
  });

  it("same-task ops execute in submission order even when the first is slow", async () => {
    const task = await store.create("ordering");
    const order: string[] = [];
    const first = queue.run(task.id, async () => {
      await tick(30);
      order.push("first");
      return 1;
    });
    const second = queue.run(task.id, async () => {
      order.push("second");
      return 2;
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });
});
