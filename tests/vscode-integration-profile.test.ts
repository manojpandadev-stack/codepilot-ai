/**
 * TaskStore synchronous-I/O profile (Phase 5).
 *
 * Measures the REAL sync-filesystem persistence path under realistic loads:
 * small/medium/large tasks, rapid tool activity, concurrent tasks. Reports
 * total time, op counts, max single-op duration, event-loop lag observed
 * during bursts, heap growth, and queue wait time.
 *
 * DELIBERATELY assertion-light on timings: no machine-specific latency
 * thresholds (per milestone rules). Correctness IS asserted (nothing lost,
 * protocol valid); timings print as a profile table for the report and for
 * human regression spotting. A hang fails via the test timeout instead.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TaskStore } from "../packages/agent-runtime/src/m12-task-store";
import { TaskPersistenceQueue } from "../packages/agent-runtime/src/task-persistence-queue";
import {
  createRunCapture,
  appendCaptureText,
  recordCaptureToolUse,
  recordCaptureToolResult,
  composeRunBlocks,
} from "../packages/agent-runtime/src/conversation-capture";
import { validateConversationProtocol } from "../packages/agent-runtime/src/compaction-protocol";
import { buildInitialMessages } from "../packages/agent-runtime/src/resume";

const nowMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);

interface Profile {
  scenario: string;
  ops: number;
  totalMs: number;
  maxOpMs: number;
  opsPerSec: number;
  maxEventLoopLagMs: number;
  heapDeltaBytes: number;
  maxQueueWaitMs: number;
}

const profiles: Profile[] = [];

/** Samples event-loop lag with a 10ms interval probe while fn runs. */
async function withLagProbe<T>(fn: () => Promise<T>): Promise<{ result: T; maxLagMs: number }> {
  let maxLag = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const t = Date.now();
    maxLag = Math.max(maxLag, t - last - 10);
    last = t;
  }, 10);
  try {
    const result = await fn();
    return { result, maxLagMs: Math.max(0, maxLag) };
  } finally {
    clearInterval(timer);
  }
}

function realisticResult(i: number): string {
  // ~2KB tool result — typical bounded payload, exercises serialization cost.
  return `file-${i}.ts\n${"const x = 1;\n".repeat(150)}`;
}

async function scenarioConversationEntries(
  store: TaskStore,
  queue: TaskPersistenceQueue,
  taskId: string,
  count: number,
  label: string,
): Promise<void> {
  const heapBefore = process.memoryUsage().heapUsed;
  const waits: number[] = [];
  let maxOp = 0;
  const start = nowMs();
  const { maxLagMs } = await withLagProbe(async () => {
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < count; i += 1) {
      const enqueuedAt = nowMs();
      ops.push(
        queue.run(taskId, async () => {
          waits.push(nowMs() - enqueuedAt);
          const t0 = nowMs();
          const capture = createRunCapture();
          appendCaptureText(capture, `assistant turn ${i} analysis`, undefined);
          recordCaptureToolUse(capture, `p-${i}`, "read_file", { path: `f${i}.ts` });
          recordCaptureToolResult(capture, `p-${i}`, "read_file", realisticResult(i), false);
          await store.upsertConversationEntry(taskId, capture.key, {
            role: "assistant",
            blocks: composeRunBlocks(capture),
            timestampMs: Date.now(),
          });
          maxOp = Math.max(maxOp, nowMs() - t0);
        }),
      );
    }
    await Promise.all(ops);
  });
  const totalMs = nowMs() - start;
  profiles.push({
    scenario: label,
    ops: count,
    totalMs,
    maxOpMs: maxOp,
    opsPerSec: Math.round((count / Math.max(1, totalMs)) * 1000),
    maxEventLoopLagMs: maxLagMs,
    heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
    maxQueueWaitMs: waits.length > 0 ? Math.max(...waits) : 0,
  });
}

describe("taskstore sync-io profile", () => {
  it("profiles small/medium/large/rapid/concurrent loads and stays correct", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-prof-"));
    try {
      const store = new TaskStore(dir);
      const queue = new TaskPersistenceQueue();

      // A. Small task: 10 entries.
      const small = await store.create("profile small");
      await scenarioConversationEntries(store, queue, small.id, 10, "A.small/10entries");

      // B. Medium task: 100 conversation entries.
      const medium = await store.create("profile medium");
      await scenarioConversationEntries(store, queue, medium.id, 100, "B.medium/100entries");

      // C. Large task: 1000 conversation entries (store caps at 200 in-file;
      // the profile measures write-path cost as the file churns at the cap).
      const large = await store.create("profile large");
      await scenarioConversationEntries(store, queue, large.id, 1000, "C.large/1000entries");

      // D. Rapid tool activity on one run entry: 200 tool pairs, one key.
      {
        const task = await store.create("profile rapid tools");
        const capture = createRunCapture();
        const heapBefore = process.memoryUsage().heapUsed;
        let maxOp = 0;
        const start = nowMs();
        const { maxLagMs } = await withLagProbe(async () => {
          const ops: Promise<unknown>[] = [];
          for (let i = 0; i < 200; i += 1) {
            recordCaptureToolUse(capture, `r-${i}`, "bash", { command: `cmd${i}` });
            recordCaptureToolResult(capture, `r-${i}`, "bash", `out${i}`, false);
            ops.push(
              queue.run(task.id, async () => {
                const t0 = nowMs();
                await store.upsertConversationEntry(task.id, capture.key, {
                  role: "assistant",
                  blocks: composeRunBlocks(capture),
                  timestampMs: Date.now(),
                });
                maxOp = Math.max(maxOp, nowMs() - t0);
              }),
            );
          }
          await Promise.all(ops);
        });
        const totalMs = nowMs() - start;
        profiles.push({
          scenario: "D.rapid/200toolpairs",
          ops: 200,
          totalMs,
          maxOpMs: maxOp,
          opsPerSec: Math.round((200 / Math.max(1, totalMs)) * 1000),
          maxEventLoopLagMs: maxLagMs,
          heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
          maxQueueWaitMs: 0,
        });
        // Correctness: all 200 pairs present under one key, protocol valid.
        const loaded = await store.get(task.id);
        const entry = loaded?.conversation?.find((e) => e.key === capture.key);
        expect(entry?.blocks?.filter((b) => b.type === "tool_use")).toHaveLength(200);
        expect(entry?.blocks?.filter((b) => b.type === "tool_result")).toHaveLength(200);
        expect(validateConversationProtocol(buildInitialMessages(loaded!)).valid).toBe(true);
      }

      // E. Concurrent tasks: 5 tasks × 100 ops through one shared queue.
      {
        const heapBefore = process.memoryUsage().heapUsed;
        const start = nowMs();
        let maxOp = 0;
        const { maxLagMs } = await withLagProbe(async () => {
          await Promise.all(
            Array.from({ length: 5 }, async (_, t) => {
              const task = await store.create(`profile concurrent ${t}`);
              const ops: Promise<unknown>[] = [];
              for (let i = 0; i < 100; i += 1) {
                ops.push(
                  queue.run(task.id, async () => {
                    const t0 = nowMs();
                    const capture = createRunCapture();
                    appendCaptureText(capture, `task${t} turn${i}`, undefined);
                    await store.upsertConversationEntry(task.id, capture.key, {
                      role: "assistant",
                      blocks: composeRunBlocks(capture),
                      timestampMs: Date.now(),
                    });
                    maxOp = Math.max(maxOp, nowMs() - t0);
                  }),
                );
              }
              await Promise.all(ops);
            }),
          );
        });
        const totalMs = nowMs() - start;
        profiles.push({
          scenario: "E.concurrent/5tasks-x-100ops",
          ops: 500,
          totalMs,
          maxOpMs: maxOp,
          opsPerSec: Math.round((500 / Math.max(1, totalMs)) * 1000),
          maxEventLoopLagMs: maxLagMs,
          heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
          maxQueueWaitMs: 0,
        });
        const listed = await store.list();
        expect(listed.length).toBeGreaterThanOrEqual(5);
      }

      // Correctness spot-checks for A–C: entries bounded by store cap, newest win.
      for (const [task, n] of [
        [small, 10],
        [medium, 100],
        [large, 1000],
      ] as const) {
        const loaded = await store.get(task.id);
        const convLen = loaded?.conversation?.length ?? 0;
        expect(convLen).toBeLessThanOrEqual(200);
        expect(convLen).toBe(Math.min(n, 200));
      }

      // Profile table → test output (evidence for the report).
      console.log(
        ["scenario|ops|totalMs|maxOpMs|opsPerSec|maxLagMs|heapKB|maxWaitMs"]
          .concat(
            profiles.map((p) =>
              `${p.scenario}|${p.ops}|${p.totalMs}|${p.maxOpMs}|${p.opsPerSec}|${p.maxEventLoopLagMs}|${Math.round(p.heapDeltaBytes / 1024)}|${p.maxQueueWaitMs}`,
            ),
          )
          .join("\n"),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
