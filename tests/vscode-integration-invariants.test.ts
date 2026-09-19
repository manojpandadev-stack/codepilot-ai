/**
 * Persistence invariant tests (Phase 6) — twelve properties that must hold
 * across the real extension pipeline (harness), the real queue, the real
 * TaskStore, and the real audit sink. Each test states its invariant up front.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  freshHost,
  reopenHost,
  scriptedRun,
  readJsonlRecords,
  expectValidJsonl,
} from "./vscode-integration-harness";
import { TaskStore } from "../packages/agent-runtime/src/m12-task-store";
import { PersistentAuditLogger } from "../packages/tool-engine/src/m3/audit-logger";
import type { ToolAuditEntry } from "../packages/tool-engine/src/m3/audit-logger";
import { buildInitialMessages } from "../packages/agent-runtime/src/resume";
import { classifyResumeFidelity } from "../packages/agent-runtime/src/resume";
import { validateConversationProtocol } from "../packages/agent-runtime/src/compaction-protocol";

describe("persistence invariants", () => {
  it("1. exactly one terminal persistence sequence per completed run", async () => {
    const host = await freshHost();
    try {
      const taskId = await scriptedRun(host, {
        title: "one terminal",
        deltas: ["work"],
        terminal: "completed",
        resultText: "FINAL-RESULT",
      });
      const task = await new TaskStore(host.tasksDir).get(taskId);
      expect(task?.status).toBe("completed");
      // One terminal sequence: exactly one assistant log entry with the result.
      expect(
        task?.messages.filter(
          (m) => m.role === "assistant" && m.content === "FINAL-RESULT",
        ),
      ).toHaveLength(1);
    } finally {
      host.cleanup();
    }
  });

  it("2. completion always flushes pending conversation state", async () => {
    const host = await freshHost();
    try {
      const taskId = await host.seams.beginTask("flush on completion");
      host.seams.ingestAgentEvent({ type: "started", sessionId: "s1" });
      // Text + terminal back-to-back: NO debounce wait before completion.
      host.seams.ingestAgentEvent({ type: "text_delta", text: "pending text", accumulated: "pending text" });
      host.seams.ingestAgentEvent({
        type: "completed",
        result: "done",
        usage: { inputTokens: 1, outputTokens: 1, totalCost: 0 },
      });
      await host.seams.drainPersistence(taskId!);
      const task = await new TaskStore(host.tasksDir).get(taskId!);
      const texts = (task?.conversation ?? []).flatMap((e) => e.blocks ?? []);
      expect(texts.some((b) => b.type === "text" && b.text === "pending text")).toBe(true);
    } finally {
      host.cleanup();
    }
  });

  it("3. tool-only run persists tool_use/tool_result with error flags", async () => {
    const host = await freshHost();
    try {
      const taskId = await scriptedRun(host, {
        title: "tool only failed",
        tools: [
          { id: "f1", name: "bash", input: { command: "nope" }, output: "", fail: true, error: "exit 1" },
        ],
        terminal: "completed",
        resultText: "done with failure",
      });
      const task = await new TaskStore(host.tasksDir).get(taskId);
      const blocks = (task?.conversation ?? []).flatMap((e) => e.blocks ?? []);
      expect(blocks.filter((b) => b.type === "tool_use")).toHaveLength(1);
      const result = blocks.find((b) => b.type === "tool_result");
      expect(result?.type === "tool_result" && result.is_error).toBe(true);
      expect(validateConversationProtocol(buildInitialMessages(task!)).valid).toBe(true);
    } finally {
      host.cleanup();
    }
  });

  it("4. assistant + tool run preserves deterministic block order", async () => {
    const host = await freshHost();
    try {
      const taskId = await scriptedRun(host, {
        title: "ordered blocks",
        deltas: ["intro "],
        tools: [
          { id: "o1", name: "read_file", input: { path: "a" }, output: "A" },
          { id: "o2", name: "read_file", input: { path: "b" }, output: "B" },
        ],
        terminal: "completed",
        resultText: "done",
      });
      const task = await new TaskStore(host.tasksDir).get(taskId);
      const entry = task?.conversation?.find((e) =>
        e.blocks?.some((b) => b.type === "tool_use"),
      );
      const kinds = (entry?.blocks ?? []).map((b) => b.type);
      expect(kinds).toEqual(["text", "tool_use", "tool_use", "tool_result", "tool_result"]);
    } finally {
      host.cleanup();
    }
  });

  it("5. multiple tasks do not block each other", async () => {
    const host = await freshHost();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const queue = host.seams.getPersistenceQueue();
      const store = host.seams.getTaskStore();
      const taskA = await store.create("blocked A");
      const taskB = await store.create("free B");
      // Task A wedged behind a gate that never opens in this test…
      void queue.run(taskA.id, () => gate);
      // …task B still drains fully (no global lock).
      const outcome = await queue.run(taskB.id, async () => {
        await store.update(taskB.id, { status: "completed" });
        return "b-done";
      });
      expect(outcome).toMatchObject({ ok: true, value: "b-done" });
      expect((await store.get(taskB.id))?.status).toBe("completed");
    } finally {
      release();
      host.cleanup();
    }
  });

  it("6. task A failure does not poison task B queue", async () => {
    const host = await freshHost();
    try {
      const queue = host.seams.getPersistenceQueue();
      const store = host.seams.getTaskStore();
      const taskA = await store.create("failing A");
      const taskB = await store.create("healthy B");
      const bad = await queue.run(taskA.id, async () => {
        throw new Error("A exploded");
      });
      expect(bad.ok).toBe(false);
      const good = await queue.run(taskB.id, async () => {
        await store.update(taskB.id, { status: "completed" });
        return "b-ok";
      });
      expect(good.ok).toBe(true);
      expect((await store.get(taskB.id))?.status).toBe("completed");
    } finally {
      host.cleanup();
    }
  });

  it("7. queue recovers after a rejected operation", async () => {
    const host = await freshHost();
    try {
      const queue = host.seams.getPersistenceQueue();
      const store = host.seams.getTaskStore();
      const task = await store.create("rejected then ok");
      await queue.run(task.id, async () => {
        throw new Error("nope");
      });
      const next = await queue.run(task.id, async () => {
        await store.update(task.id, { status: "completed" });
        return 42;
      });
      expect(next).toMatchObject({ ok: true, value: 42 });
      // Idle settles on the post-outcome microtask — one macrotask tick.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(queue.isIdle(task.id)).toBe(true);
    } finally {
      host.cleanup();
    }
  });

  it("8. shutdown does not silently discard terminal persistence", async () => {
    const host = await freshHost();
    try {
      const taskId = await host.seams.beginTask("shutdown terminal");
      host.seams.ingestAgentEvent({ type: "started", sessionId: "s1" });
      host.seams.ingestAgentEvent({
        type: "completed",
        result: "terminal-data",
        usage: { inputTokens: 1, outputTokens: 1, totalCost: 0 },
      });
      // Straight to deactivate: no manual drain, no debounce wait.
      await host.ext.deactivate();
      const task = await new TaskStore(host.tasksDir).get(taskId!);
      expect(task?.status).toBe("completed");
      expect(
        task?.messages.some(
          (m) => m.role === "assistant" && m.content === "terminal-data",
        ),
      ).toBe(true);
    } finally {
      host.cleanup();
    }
  });

  it("9. audit rotation does not lose newest records", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-inv-audit-"));
    try {
      const adapter = {
        directory: () => dir,
        readFile: (name: string) => {
          try {
            return fs.readFileSync(path.join(dir, name), "utf8");
          } catch {
            return null;
          }
        },
        appendLine: (name: string, line: string) =>
          fs.appendFileSync(path.join(dir, name), line, "utf8"),
        removeFile: (name: string) => {
          fs.rmSync(path.join(dir, name), { force: true });
        },
        listFiles: () =>
          fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isFile())
            .map((e) => ({
              name: e.name,
              size: fs.statSync(path.join(dir, e.name)).size,
            })),
        sync: () => {},
      };
      const log = new PersistentAuditLogger(adapter, {
        maxFileBytes: 64 * 1024,
        maxTotalBytes: 256 * 1024,
        maxFiles: 4,
      });
      const total = 400;
      for (let i = 0; i < total; i += 1) {
        log.record({
          executionId: `rot-${i}`,
          toolId: "read_file",
          startedAt: i,
          status: "completed",
          retries: 0,
        } as ToolAuditEntry);
        if (i % 20 === 19) await log.flush();
      }
      await log.flush();
      const recovered = log.readPersisted(total);
      // Newest records all survive rotation, oldest-first order intact.
      const ids = recovered.map((r) => r.executionId);
      expect(ids[ids.length - 1]).toBe(`rot-${total - 1}`);
      const nums = ids.map((id) => Number(String(id).slice(4)));
      expect(nums).toEqual([...nums].sort((a, b) => a - b));
      await log.dispose();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("10. torn audit line recovery remains valid at the file level", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-inv-torn-"));
    try {
      const file = path.join(dir, "tool-audit.jsonl");
      fs.writeFileSync(
        file,
        `${JSON.stringify({ executionId: "good", toolId: "t" })}\n{"executionId": "tor`,
        "utf8",
      );
      const adapter = {
        directory: () => dir,
        readFile: (name: string) => {
          try {
            return fs.readFileSync(path.join(dir, name), "utf8");
          } catch {
            return null;
          }
        },
        appendLine: (name: string, line: string) =>
          fs.appendFileSync(path.join(dir, name), line, "utf8"),
        removeFile: (name: string) => {
          fs.rmSync(path.join(dir, name), { force: true });
        },
        listFiles: () =>
          fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isFile())
            .map((e) => ({
              name: e.name,
              size: fs.statSync(path.join(dir, e.name)).size,
            })),
        sync: () => {},
      };
      const log = new PersistentAuditLogger(adapter);
      expect(log.readPersisted(10).map((r) => r.executionId)).toEqual(["good"]);
      log.record({ executionId: "after", toolId: "t", startedAt: 2, status: "completed", retries: 0 } as ToolAuditEntry);
      await log.flush();
      expectValidJsonl(file);
      expect(log.readPersisted(10).map((r) => r.executionId)).toEqual(["good", "after"]);
      await log.dispose();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("11. resume after an interrupted run stays valid with PARTIAL fidelity", async () => {
    const host = await freshHost();
    try {
      const taskId = await host.seams.beginTask("interrupted resume");
      host.seams.ingestAgentEvent({ type: "started", sessionId: "s1" });
      host.seams.ingestAgentEvent({ type: "text_delta", text: "half", accumulated: "half" });
      // Let the debounce land so the assistant entry is durable mid-response…
      await new Promise<void>((resolve) => setTimeout(resolve, 450));
      await host.seams.drainPersistence(taskId!);
      // …then crash: no terminal, no deactivate. Reopen + recover.
      const reopened = await reopenHost(host.storageDir);
      try {
        const task = await new TaskStore(host.tasksDir).get(taskId!);
        expect(task?.status).toBe("interrupted");
        // Mid-response tail: honest PARTIAL, never overclaimed FULL.
        expect(classifyResumeFidelity(task!).fidelity).toBe("PARTIAL");
        expect(validateConversationProtocol(buildInitialMessages(task!)).valid).toBe(true);
      } finally {
        await reopened.ext.deactivate();
      }
    } finally {
      host.cleanup();
    }
  });

  it("12. compaction artifact write stays ordered with persistence ops", async () => {
    const host = await freshHost();
    try {
      const queue = host.seams.getPersistenceQueue();
      const store = host.seams.getTaskStore();
      const task = await store.create("ordered compaction");
      await store.appendMessage(task.id, "user", "work");
      // Conversation op → artifact op → conversation op, all serialized.
      await queue.run(task.id, async () => {
        await store.upsertConversationEntry(task.id, "run-1", {
          role: "assistant",
          blocks: [{ type: "text", text: "first" }],
          timestampMs: Date.now(),
        });
      });
      await queue.run(task.id, async () => {
        await store.addCompactionArtifact(task.id, {
          id: "art-1",
          createdAtMs: Date.now(),
          mode: "summary",
          summarizedMessageCount: 1,
          tokensBefore: 500,
          tokensAfter: 50,
          summary: "s",
        } as never);
      });
      const terminal = await queue.run(task.id, async () => {
        await store.update(task.id, { status: "completed" });
        return "terminal";
      });
      expect(terminal.ok).toBe(true);
      const loaded = await store.get(task.id);
      expect(loaded?.status).toBe("completed");
      expect(loaded?.compactions?.map((a) => a.id)).toEqual(["art-1"]);
      // Canonical history preserved (artifact never rewrites conversation):
      // the mirrored user seed plus the assistant entry.
      expect(loaded?.conversation?.map((e) => e.role)).toEqual([
        "user",
        "assistant",
      ]);
      expect(validateConversationProtocol(buildInitialMessages(loaded!)).valid).toBe(true);
    } finally {
      host.cleanup();
    }
  });
});
