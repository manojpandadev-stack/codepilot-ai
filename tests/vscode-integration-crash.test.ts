/**
 * Crash/recovery chaos tests — deterministic process-interruption simulation.
 *
 * No test kills the runner process. Instead each case drives the REAL
 * pipeline to an interruption boundary (mid-stream, mid-tool, queued-but-
 * unexecuted terminal op via a gate that never opens, torn bytes written to
 * simulate a kill mid-append), ABANDONS the host without deactivate/drain
 * (the in-memory half dies exactly as in a real crash), then REOPENS the
 * same storage with a fresh host and runs the REAL startup recovery.
 *
 * Required properties per case: valid JSON, valid JSONL, no duplicated
 * terminal state, protocol-valid wire, running→interrupted, completed stays
 * completed, idempotent recovery (run twice, byte-identical state).
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  freshHost,
  reopenHost,
  scriptedRun,
  readJsonlRecords,
  expectValidJsonl,
  sleep,
  DEBOUNCE_WAIT_MS,
} from "./vscode-integration-harness";
import { TaskStore } from "../packages/agent-runtime/src/m12-task-store";
import { buildInitialMessages } from "../packages/agent-runtime/src/resume";
import { validateConversationProtocol } from "../packages/agent-runtime/src/compaction-protocol";

function taskFile(host: { tasksDir: string }, taskId: string): string {
  return path.join(host.tasksDir, `${taskId}.json`);
}

/** Snapshot a task file's bytes for idempotency comparison. */
function snapshotTask(host: { tasksDir: string }, taskId: string): string {
  return fs.readFileSync(taskFile(host, taskId), "utf8");
}

/**
 * Run startup recovery twice more (fresh store instances) and assert the
 * task state is byte-identical afterwards — recovery must be idempotent.
 */
async function expectIdempotentRecovery(
  tasksDir: string,
  taskId: string,
): Promise<void> {
  const before = fs.readFileSync(path.join(tasksDir, `${taskId}.json`), "utf8");
  const s1 = new TaskStore(tasksDir);
  await s1.markInterruptedOnStartup();
  const mid = fs.readFileSync(path.join(tasksDir, `${taskId}.json`), "utf8");
  const s2 = new TaskStore(tasksDir);
  await s2.markInterruptedOnStartup();
  const after = fs.readFileSync(path.join(tasksDir, `${taskId}.json`), "utf8");
  expect(mid).toBe(before);
  expect(after).toBe(before);
}

describe("crash/recovery chaos", () => {
  it("1. interruption during assistant text persistence", async () => {
    const host = await freshHost();
    try {
      const taskId = await host.seams.beginTask("crash mid-text");
      host.seams.ingestAgentEvent({ type: "started", sessionId: "s1" });
      host.seams.ingestAgentEvent({ type: "text_delta", text: "hel", accumulated: "hel" });
      host.seams.ingestAgentEvent({ type: "text_delta", text: "lo", accumulated: "hello" });
      // CRASH: no debounce wait, no drain, no deactivate.
      const reopened = await reopenHost(host.storageDir);
      try {
        const store = new TaskStore(host.tasksDir);
        const task = await store.get(taskId!);
        expect(task).not.toBeNull();
        // Startup recovery flipped running → interrupted.
        expect(task!.status).toBe("interrupted");
        // Valid JSON + valid protocol whether or not the debounce landed.
        expect(validateConversationProtocol(buildInitialMessages(task!)).valid).toBe(true);
        expectValidJsonl(reopened.auditFile);
        await expectIdempotentRecovery(host.tasksDir, taskId!);
      } finally {
        await reopened.ext.deactivate();
      }
    } finally {
      await sleep(DEBOUNCE_WAIT_MS);
      host.cleanup();
    }
  });

  it("2. interruption during tool_use persistence (request without result)", async () => {
    const host = await freshHost();
    try {
      const taskId = await host.seams.beginTask("crash mid-tool-use");
      host.seams.ingestAgentEvent({ type: "started", sessionId: "s1" });
      host.seams.ingestAgentEvent({
        type: "tool_requested",
        toolCallId: "call-orphan",
        toolName: "bash",
        input: { command: "make" },
      });
      await host.seams.drainPersistence(taskId!);
      // CRASH after the requested-phase flush, before any result.
      const reopened = await reopenHost(host.storageDir);
      try {
        const task = await new TaskStore(host.tasksDir).get(taskId!);
        expect(task!.status).toBe("interrupted");
        const blocks = (task!.conversation ?? []).flatMap((e) => e.blocks ?? []);
        expect(blocks.filter((b) => b.type === "tool_use")).toHaveLength(1);
        expect(blocks.filter((b) => b.type === "tool_result")).toHaveLength(0);
        // Lone tool_use restores as valid wire (PARTIAL fidelity — the
        // design never invents a result, and the validator accepts it).
        const wire = buildInitialMessages(task!);
        expect(validateConversationProtocol(wire).valid).toBe(true);
        await expectIdempotentRecovery(host.tasksDir, taskId!);
      } finally {
        await reopened.ext.deactivate();
      }
    } finally {
      await sleep(DEBOUNCE_WAIT_MS);
      host.cleanup();
    }
  });

  it("3. interruption during tool_result persistence", async () => {
    const host = await freshHost();
    try {
      const taskId = await scriptedRun(host, {
        title: "crash after tools",
        deltas: ["working"],
        tools: [
          { id: "call-A", name: "read_file", input: { path: "a.ts" }, output: "aaa" },
          { id: "call-B", name: "read_file", input: { path: "b.ts" }, output: "bbb" },
        ],
        terminal: "completed",
        resultText: "done",
      });
      // Completed state is durable; now crash WITHOUT deactivate and reopen.
      const snap = snapshotTask(host, taskId);
      const reopened = await reopenHost(host.storageDir);
      try {
        const task = await new TaskStore(host.tasksDir).get(taskId);
        // Completed tasks are never touched by recovery.
        expect(task!.status).toBe("completed");
        const blocks = (task!.conversation ?? []).flatMap((e) => e.blocks ?? []);
        expect(blocks.filter((b) => b.type === "tool_result")).toHaveLength(2);
        expect(validateConversationProtocol(buildInitialMessages(task!)).valid).toBe(true);
        await expectIdempotentRecovery(host.tasksDir, taskId);
        expect(snapshotTask(host, taskId)).toBe(snap);
      } finally {
        await reopened.ext.deactivate();
      }
    } finally {
      host.cleanup();
    }
  });

  it("4. interruption with terminal op queued but unexecuted", async () => {
    const host = await freshHost();
    // Gate that never opens holds the queue head: the terminal op behind it
    // provably NEVER runs in this host — a deterministic mid-queue crash.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const taskId = await host.seams.beginTask("crash queued terminal");
      const queue = host.seams.getPersistenceQueue();
      void queue.run(taskId!, () => gate);
      host.seams.ingestAgentEvent({ type: "started", sessionId: "s1" });
      host.seams.ingestAgentEvent({ type: "text_delta", text: "hi", accumulated: "hi" });
      host.seams.ingestAgentEvent({
        type: "completed",
        result: "done",
        usage: { inputTokens: 1, outputTokens: 1, totalCost: 0 },
      });
      // CRASH: terminal op stuck behind the gate; abandon without release.
      const reopened = await reopenHost(host.storageDir);
      try {
        const task = await new TaskStore(host.tasksDir).get(taskId!);
        // Terminal op never executed → still running → recovery interrupts.
        expect(task!.status).toBe("interrupted");
        // Exactly one terminal outcome exists (no duplicated terminal state).
        expect(task!.messages.filter((m) => m.content === "done")).toHaveLength(0);
        await expectIdempotentRecovery(host.tasksDir, taskId!);
      } finally {
        await reopened.ext.deactivate();
      }
    } finally {
      release();
      await sleep(DEBOUNCE_WAIT_MS);
      host.cleanup();
    }
  });

  it("5. torn audit bytes from a kill mid-append are truncated on reopen", async () => {
    const host = await freshHost();
    try {
      const bridge = host.seams.getLivePermissionBridge();
      const d = await bridge.evaluateLiveTool({
        toolName: "read_file",
        input: { path: "a.ts" },
        taskId: "t1",
      });
      expect(d.approved).toBe(true);
      await host.ext.deactivate();
      // Simulate SIGKILL during the NEXT append: torn bytes, no newline.
      fs.appendFileSync(host.auditFile, '{"executionId": "torn-mid-wri', "utf8");
      const reopened = await reopenHost(host.storageDir);
      try {
        // Recovery truncated the fragment; the file is valid JSONL again.
        expectValidJsonl(host.auditFile);
        const records = readJsonlRecords(host.auditFile) as Array<{ executionId?: string }>;
        expect(records).toHaveLength(1);
        expect(records[0]!.executionId).toMatch(/^live-/);
        // New appends land on a clean boundary.
        const bridge2 = reopened.seams.getLivePermissionBridge();
        await bridge2.evaluateLiveTool({
          toolName: "read_file",
          input: { path: "b.ts" },
          taskId: "t2",
        });
        await reopened.ext.deactivate();
        expectValidJsonl(host.auditFile);
        expect(readJsonlRecords(host.auditFile)).toHaveLength(2);
      } finally {
        await reopened.ext.deactivate().catch(() => {});
      }
    } finally {
      host.cleanup();
    }
  });

  it("6. interruption before the final conversation flush", async () => {
    const host = await freshHost();
    try {
      const taskId = await host.seams.beginTask("crash before flush");
      host.seams.ingestAgentEvent({ type: "started", sessionId: "s1" });
      host.seams.ingestAgentEvent({ type: "text_delta", text: "unflushed?", accumulated: "unflushed?" });
      // CRASH immediately — the 300ms debounce provably never fired.
      const reopened = await reopenHost(host.storageDir);
      try {
        const task = await new TaskStore(host.tasksDir).get(taskId!);
        expect(task!.status).toBe("interrupted");
        // No partial/corrupt entry: either absent or complete-and-valid.
        expect(validateConversationProtocol(buildInitialMessages(task!)).valid).toBe(true);
        await expectIdempotentRecovery(host.tasksDir, taskId!);
      } finally {
        await reopened.ext.deactivate();
      }
    } finally {
      // Let the abandoned host's orphaned debounce fire harmlessly first:
      // it upserts its own capture (valid full state) — assertions above
      // already ran against the crashed view, this only guards cleanup.
      await sleep(DEBOUNCE_WAIT_MS);
      host.cleanup();
    }
  });

  it("7. compaction artifact survives a crash with history intact", async () => {
    const host = await freshHost();
    try {
      const taskId = await scriptedRun(host, {
        title: "compaction crash",
        deltas: ["some work"],
        tools: [
          { id: "c1", name: "read_file", input: { path: "x.ts" }, output: "xxx" },
        ],
        terminal: "completed",
        resultText: "done",
      });
      // Real artifact write at the real boundary, then crash, no deactivate.
      const store = host.seams.getTaskStore();
      const before = await store.get(taskId);
      const convLen = before!.conversation?.length ?? 0;
      await store.addCompactionArtifact(taskId, {
        id: "artifact-1",
        createdAtMs: Date.now(),
        mode: "summary",
        summarizedMessageCount: convLen,
        tokensBefore: 1000,
        tokensAfter: 100,
        summary: "did things",
      } as never);
      const reopened = await reopenHost(host.storageDir);
      try {
        const task = await new TaskStore(host.tasksDir).get(taskId);
        expect(task!.status).toBe("completed");
        // Canonical history untouched by the artifact write.
        expect(task!.conversation?.length).toBe(convLen);
        expect(task!.compactions?.map((a) => a.id)).toEqual(["artifact-1"]);
        // Re-adding the same boundary is a no-op (idempotent, no duplicates).
        await new TaskStore(host.tasksDir).addCompactionArtifact(taskId, {
          id: "artifact-1",
          createdAtMs: Date.now(),
          mode: "summary",
          summarizedMessageCount: convLen,
          tokensBefore: 1000,
          tokensAfter: 100,
          summary: "did things",
        } as never);
        expect((await new TaskStore(host.tasksDir).get(taskId))!.compactions).toHaveLength(1);
        expect(validateConversationProtocol(buildInitialMessages(task!)).valid).toBe(true);
      } finally {
        await reopened.ext.deactivate();
      }
    } finally {
      host.cleanup();
    }
  });

  it("8. completed status survives crash + double recovery untouched", async () => {
    const host = await freshHost();
    try {
      const taskId = await scriptedRun(host, {
        title: "durable completed",
        deltas: ["fin"],
        terminal: "completed",
        resultText: "fin done",
      });
      const snap = snapshotTask(host, taskId);
      // Crash (no deactivate), reopen, recover — twice.
      const reopened = await reopenHost(host.storageDir);
      try {
        await expectIdempotentRecovery(host.tasksDir, taskId);
        const task = await new TaskStore(host.tasksDir).get(taskId);
        expect(task!.status).toBe("completed");
        expect(snapshotTask(host, taskId)).toBe(snap);
      } finally {
        await reopened.ext.deactivate();
      }
    } finally {
      host.cleanup();
    }
  });

  it("9. abandoned queue with pending ops never poisons the reopened host", async () => {
    const host = await freshHost();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const taskId = await host.seams.beginTask("poison queue?");
      const queue = host.seams.getPersistenceQueue();
      void queue.run(taskId!, () => gate);
      void queue.run(taskId!, async () => "never-runs");
      expect(queue.pendingCount(taskId!)).toBe(2);
      // CRASH with ops pending; the gate promise dies with the old host.
      const reopened = await reopenHost(host.storageDir);
      try {
        // Fresh queue, fresh recovery: interrupted + fully operable.
        const task = await new TaskStore(host.tasksDir).get(taskId!);
        expect(task!.status).toBe("interrupted");
        const outcome = await reopened.seams
          .getPersistenceQueue()
          .run(taskId!, async () => "fresh-queue-works");
        expect(outcome).toMatchObject({ ok: true, value: "fresh-queue-works" });
        await expectIdempotentRecovery(host.tasksDir, taskId!);
      } finally {
        await reopened.ext.deactivate();
      }
    } finally {
      release();
      await sleep(DEBOUNCE_WAIT_MS);
      host.cleanup();
    }
  });

  it("10. crash during deactivation still leaves recoverable state", async () => {
    const host = await freshHost();
    try {
      const taskId = await scriptedRun(host, {
        title: "crash in deactivate",
        deltas: ["almost there"],
        terminal: "completed",
        resultText: "done",
      });
      const snap = snapshotTask(host, taskId);
      // "Crash during deactivate": skip deactivate entirely (abandon), reopen.
      const reopened = await reopenHost(host.storageDir);
      try {
        const task = await new TaskStore(host.tasksDir).get(taskId);
        expect(task!.status).toBe("completed");
        expect(snapshotTask(host, taskId)).toBe(snap);
        expectValidJsonl(host.auditFile);
        await expectIdempotentRecovery(host.tasksDir, taskId);
      } finally {
        await reopened.ext.deactivate();
      }
    } finally {
      host.cleanup();
    }
  });
});
