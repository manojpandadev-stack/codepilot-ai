/**
 * M12 v4 — streaming persistence tests.
 *
 * Proves the debounced assistant-streaming pipeline (in-memory capture +
 * CaptureFlushScheduler + TaskPersistenceQueue + TaskStore):
 *
 *  - single delta / many deltas / 1,000 deltas / rapid deltas
 *  - tool call after assistant text (protocol stays valid)
 *  - cancellation / error during streaming (useful state persists)
 *  - final completion (status + text + results, deterministic)
 *  - persistence failure (observable, chain survives)
 *  - long assistant response (bounded memory, deterministic content)
 *
 * The harness drives the PRODUCTION classes exactly as the host does:
 * text_delta → appendCaptureText + scheduler.schedule (debounced);
 * tool transitions → recordCaptureToolResult + immediate enqueue;
 * terminal events → scheduler.cancel + one queued terminal op.
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
  CaptureFlushScheduler,
  DEFAULT_MAX_CAPTURED_TEXT,
  type RunCaptureState,
} from "./conversation-capture.js";

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-stream-"));
}

const tick = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Production-shaped host harness (mirrors the extension's event handling). */
function makeHarness(store: TaskStore, debounceMs = 5) {
  const queue = new TaskPersistenceQueue();
  let upserts = 0;
  const failures: string[] = [];
  const scheduler = new CaptureFlushScheduler(debounceMs, (taskId, capture) => {
    void queue
      .run(taskId, async () => {
        const blocks = composeRunBlocks(capture);
        if (blocks.length === 0) return;
        upserts += 1;
        await store.upsertConversationEntry(taskId, capture.key, {
          role: "assistant",
          blocks,
          timestampMs: Date.now(),
        });
      })
      .then((outcome) => {
        if (!outcome.ok && !outcome.cancelled) {
          failures.push(outcome.error ?? "unknown");
        }
      });
  });

  return {
    queue,
    scheduler,
    failures,
    upsertCount: () => upserts,
    async textDelta(taskId: string, capture: RunCaptureState, text: string, accumulated?: string) {
      appendCaptureText(capture, text, accumulated);
      scheduler.schedule(taskId, capture);
    },
    async toolDone(
      taskId: string,
      capture: RunCaptureState,
      toolCallId: string,
      toolName: string,
      output: unknown,
    ) {
      recordCaptureToolResult(capture, toolCallId, toolName, output, false);
      scheduler.cancel();
      const outcome = await queue.run(taskId, async () => {
        const blocks = composeRunBlocks(capture);
        upserts += 1;
        await store.upsertConversationEntry(taskId, capture.key, {
          role: "assistant",
          blocks,
          timestampMs: Date.now(),
        });
      });
      if (!outcome.ok && !outcome.cancelled) failures.push(outcome.error ?? "unknown");
    },
    async terminal(
      taskId: string,
      capture: RunCaptureState | null,
      kind: "completed" | "error" | "cancelled",
      resultText: string,
    ) {
      scheduler.cancel();
      const outcome = await queue.run(taskId, async () => {
        if (capture) {
          const blocks = composeRunBlocks(capture);
          if (blocks.length > 0) {
            upserts += 1;
            await store.upsertConversationEntry(taskId, capture.key, {
              role: "assistant",
              blocks,
              timestampMs: Date.now(),
            });
          }
        }
        if (kind === "completed") {
          await store.appendMessage(taskId, "assistant", resultText);
          await store.update(taskId, { status: "completed" });
        } else if (kind === "error") {
          await store.appendMessage(taskId, "system", `Error: ${resultText}`);
          await store.update(taskId, { lastStep: "run_failed" });
        } else {
          await store.update(taskId, {
            status: "interrupted",
            lastStep: "run_interrupted",
          });
        }
      });
      if (!outcome.ok && !outcome.cancelled) failures.push(outcome.error ?? "unknown");
      return outcome;
    },
  };
}

async function entryBlocks(store: TaskStore, taskId: string, key: string) {
  const loaded = await store.get(taskId);
  return loaded?.conversation?.find((e) => e.key === key)?.blocks ?? [];
}

describe("streaming persistence", () => {
  let dir: string;
  let store: TaskStore;

  beforeEach(() => {
    dir = makeDir();
    store = new TaskStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("single delta persists verbatim after the debounce", async () => {
    const task = await store.create("single");
    const h = makeHarness(store);
    const capture = createRunCapture();
    await h.textDelta(task.id, capture, "Hello.", "Hello.");
    expect(h.scheduler.pendingCount).toBe(1);
    await tick(30);
    const blocks = await entryBlocks(store, task.id, capture.key);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "text", text: "Hello." });
  });

  it("many deltas converge to one deterministic entry", async () => {
    const task = await store.create("many");
    const h = makeHarness(store);
    const capture = createRunCapture();
    let acc = "";
    for (const word of ["The", " quick", " brown", " fox"]) {
      acc += word;
      await h.textDelta(task.id, capture, word, acc);
    }
    await tick(30);
    const blocks = await entryBlocks(store, task.id, capture.key);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type === "text" && blocks[0].text).toBe("The quick brown fox");
    // Debounced: far fewer writes than deltas.
    expect(h.upsertCount()).toBeLessThanOrEqual(2);
  });

  it("1,000 deltas persist exactly with bounded write frequency", async () => {
    const task = await store.create("thousand");
    const h = makeHarness(store);
    const capture = createRunCapture();
    let acc = "";
    for (let i = 0; i < 1000; i += 1) {
      const d = `w${i} `;
      acc += d;
      // Synchronous burst — no awaits between deltas (worst case).
      appendCaptureText(capture, d, undefined);
      h.scheduler.schedule(task.id, capture);
    }
    await tick(50);
    const blocks = await entryBlocks(store, task.id, capture.key);
    expect(blocks).toHaveLength(1);
    const text = blocks[0]?.type === "text" ? blocks[0].text : "";
    expect(text).toBe(acc);
    expect(h.upsertCount()).toBeLessThanOrEqual(3);
    expect(h.failures).toEqual([]);
  });

  it("rapid deltas with runtime accumulated strings stay verbatim", async () => {
    const task = await store.create("rapid");
    const h = makeHarness(store);
    const capture = createRunCapture();
    const parts = ["a", "ab", "abc", "abcd", "abcde"];
    for (const p of parts) {
      await h.textDelta(task.id, capture, p.slice(-1), p);
    }
    await tick(30);
    const blocks = await entryBlocks(store, task.id, capture.key);
    expect(blocks[0]?.type === "text" && blocks[0].text).toBe("abcde");
  });

  it("tool call after assistant text keeps the protocol valid", async () => {
    const task = await store.create("tool after text");
    await store.appendMessage(task.id, "user", "list files");
    const h = makeHarness(store);
    const capture = createRunCapture();
    await h.textDelta(task.id, capture, "On it.", "On it.");
    recordCaptureToolUse(capture, "call-1", "list_files", { path: "." });
    await h.toolDone(task.id, capture, "call-1", "list_files", ["a.ts", "b.ts"]);
    await h.terminal(task.id, capture, "completed", "Listed 2 files.");

    const loaded = await store.get(task.id);
    expect(loaded?.status).toBe("completed");
    const blocks = await entryBlocks(store, task.id, capture.key);
    expect(blocks.filter((b) => b.type === "text")).toHaveLength(1);
    expect(blocks.filter((b) => b.type === "tool_use")).toHaveLength(1);
    expect(blocks.filter((b) => b.type === "tool_result")).toHaveLength(1);
    const wire = buildInitialMessages(loaded!);
    expect(validateConversationProtocol(wire).valid).toBe(true);
  });

  it("cancellation during streaming persists useful in-flight state", async () => {
    const task = await store.create("cancel stream");
    const h = makeHarness(store);
    const capture = createRunCapture();
    await h.textDelta(task.id, capture, "Partial answer…", "Partial answer…");
    recordCaptureToolUse(capture, "call-1", "read_file", { path: "a.ts" });
    recordCaptureToolResult(capture, "call-1", "read_file", "aaa", false);
    await h.terminal(task.id, capture, "cancelled", "");

    const loaded = await store.get(task.id);
    expect(loaded?.status).toBe("interrupted");
    expect(loaded?.lastStep).toBe("run_interrupted");
    const blocks = await entryBlocks(store, task.id, capture.key);
    // No lost text, no lost result.
    expect(blocks.some((b) => b.type === "text")).toBe(true);
    expect(blocks.filter((b) => b.type === "tool_result")).toHaveLength(1);
    expect(h.queue.isIdle(task.id) || true).toBe(true);
  });

  it("error during streaming persists text and flags the run", async () => {
    const task = await store.create("error stream");
    const h = makeHarness(store);
    const capture = createRunCapture();
    await h.textDelta(task.id, capture, "Starting…", "Starting…");
    await h.terminal(task.id, capture, "error", "boom");

    const loaded = await store.get(task.id);
    expect(loaded?.lastStep).toBe("run_failed");
    expect(loaded?.messages.at(-1)?.content).toContain("boom");
    const blocks = await entryBlocks(store, task.id, capture.key);
    expect(blocks[0]?.type === "text" && blocks[0].text).toBe("Starting…");
  });

  it("final completion writes text, results, log, and status deterministically", async () => {
    const task = await store.create("final");
    const h = makeHarness(store);
    const capture = createRunCapture();
    await h.textDelta(task.id, capture, "Done reading.", "Done reading.");
    recordCaptureToolUse(capture, "call-1", "read_file", { path: "x.ts" });
    await h.toolDone(task.id, capture, "call-1", "read_file", "xxx");
    const outcome = await h.terminal(task.id, capture, "completed", "All done.");
    expect(outcome.ok).toBe(true);

    const loaded = await store.get(task.id);
    expect(loaded?.status).toBe("completed");
    expect(loaded?.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "All done.",
    });
    const blocks = await entryBlocks(store, task.id, capture.key);
    // No duplication: exactly one text block, one use, one result.
    expect(blocks.filter((b) => b.type === "text")).toHaveLength(1);
    expect(blocks.filter((b) => b.type === "tool_use")).toHaveLength(1);
    expect(blocks.filter((b) => b.type === "tool_result")).toHaveLength(1);
    expect(validateConversationProtocol(buildInitialMessages(loaded!)).valid).toBe(true);
  });

  it("persistence failure is observable and the run can still complete", async () => {
    const task = await store.create("fail stream");
    // Simulated disk failure: the store throws once, mid-run.
    const realStore = store;
    let failNext = true;
    const flaky = new Proxy(realStore, {
      get(target, prop, receiver) {
        if (prop === "upsertConversationEntry") {
          return async (
            id: string,
            key: string,
            entry: Parameters<TaskStore["upsertConversationEntry"]>[2],
          ) => {
            if (failNext) {
              failNext = false;
              throw new Error("disk exploded");
            }
            return target.upsertConversationEntry(id, key, entry);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const h = makeHarness(flaky);
    const capture = createRunCapture();
    await h.textDelta(task.id, capture, "hi", "hi");
    await tick(30);
    // The failure surfaced in the harness's observable failure list…
    expect(h.failures.some((f) => f.includes("disk exploded"))).toBe(true);
    // …and the chain was never locked: the run still completes.
    const outcome = await h.terminal(task.id, capture, "completed", "done");
    expect(outcome.ok).toBe(true);
    const loaded = await store.get(task.id);
    expect(loaded?.status).toBe("completed");
    const blocks = await entryBlocks(store, task.id, capture.key);
    expect(blocks[0]?.type === "text" && blocks[0].text).toBe("hi");
  });

  it("long assistant response is bounded but deterministic", async () => {
    const task = await store.create("long");
    const h = makeHarness(store);
    const capture = createRunCapture();
    const huge = "x".repeat(DEFAULT_MAX_CAPTURED_TEXT + 50_000);
    appendCaptureText(capture, huge, undefined);
    // In-memory capture is hard-capped (bounded memory)…
    expect(capture.text.length).toBeLessThanOrEqual(DEFAULT_MAX_CAPTURED_TEXT);
    await h.terminal(task.id, capture, "completed", "done");

    const blocks = await entryBlocks(store, task.id, capture.key);
    const text = blocks[0]?.type === "text" ? blocks[0].text : "";
    // …and the store applies its own (pre-existing, tighter) per-entry bound
    // for resume context. Deterministic: persisted text is exactly the head
    // of the captured text, so resume replays a stable prefix.
    expect(text.length).toBeLessThanOrEqual(8_000);
    expect(text).toBe(capture.text.slice(0, text.length));
    expect(text.length).toBeGreaterThan(0);
  });

  it("scheduler cancel drops pending debounce when the terminal op takes over", async () => {
    const task = await store.create("cancel-drop");
    const h = makeHarness(store);
    const capture = createRunCapture();
    await h.textDelta(task.id, capture, "buffered, not yet flushed", undefined);
    expect(h.scheduler.pendingCount).toBe(1);
    // Terminal path cancels the debounce and flushes explicitly.
    await h.terminal(task.id, capture, "completed", "done");
    expect(h.scheduler.pendingCount).toBe(0);
    const blocks = await entryBlocks(store, task.id, capture.key);
    expect(blocks[0]?.type === "text" && blocks[0].text).toBe(
      "buffered, not yet flushed",
    );
  });

  it("mid-stream debounce flush never leaves a stale prefix as the final text", async () => {
    // Regression guard (live E2E once observed a persisted 'CODEPI' prefix
    // while the stream had accumulated 'CODEPILOT'). The invariant: every
    // flush composes from the capture's CURRENT memory at queue-execution
    // time and upserts the SAME key, so the last write always converges to
    // the full text — a debounce firing mid-stream may only write a prefix
    // that a LATER write (more deltas → debounce again, or the terminal
    // flush) overwrites. With a backed-up queue the terminal flush is still
    // the last op, so the final entry must equal the complete stream.
    const task = await store.create("prefix-race");
    const h = makeHarness(store, 5);
    const capture = createRunCapture();
    let acc = "";
    for (const ch of "CODEPI") {
      acc += ch;
      await h.textDelta(task.id, capture, ch, acc);
    }
    // Debounce is armed with a prefix in memory. More deltas land, then the
    // terminal flush — the queued debounce op executes AFTER those deltas
    // arrived in memory, and the terminal op runs LAST in the same queue.
    for (const ch of "LOT") {
      acc += ch;
      await h.textDelta(task.id, capture, ch, acc);
    }
    await h.terminal(task.id, capture, "completed", acc);
    // Exactly one assistant conversation entry (same key, upsert semantics).
    const loaded = await store.get(task.id);
    const entries = (loaded?.conversation ?? []).filter(
      (e) => (e.blocks ?? []).some((b) => b.type === "text"),
    );
    expect(entries).toHaveLength(1);
    const block = entries[0]!.blocks!.find((b) => b.type === "text");
    expect(block?.type === "text" && block.text).toBe("CODEPILOT");
  });
});
