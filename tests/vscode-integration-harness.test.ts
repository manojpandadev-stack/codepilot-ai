/**
 * VS Code integration harness — real extension lifecycle, durable-state proof.
 *
 * Boots the REAL extension module per test (fresh module registry + isolated
 * temp globalStorage), drives deterministic scripted agent runs through the
 * REAL `forwardAgentEvent` pipeline, then asserts DURABLE state read fresh
 * from disk (new TaskStore instances + raw file reads — never the live
 * objects' word for it).
 *
 * Phase 2 scenarios: activate→run→deactivate (completion / immediate /
 * cancel / error / tools / multi-task), repeated fresh-storage cycles, audit
 * flush on deactivate, queue settlement, shutdown with pending work.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  freshHost,
  scriptedRun,
  readJsonlRecords,
  expectValidJsonl,
  sleep,
  DEBOUNCE_WAIT_MS,
  type FreshHost,
} from "./vscode-integration-harness";
import { TaskStore } from "../packages/agent-runtime/src/m12-task-store";
import { buildInitialMessages } from "../packages/agent-runtime/src/resume";
import { validateConversationProtocol } from "../packages/agent-runtime/src/compaction-protocol";

async function fullFlowAssertions(host: FreshHost, taskId: string): Promise<void> {
  // ---- TaskStore on disk (fresh instance = reopened storage) ----
  const reopened = new TaskStore(host.tasksDir);
  const task = await reopened.get(taskId);
  expect(task).not.toBeNull();
  expect(task!.status).toBe("completed");
  expect(task!.messages.map((m) => m.role)).toContain("user");
  expect(task!.messages.map((m) => m.role)).toContain("assistant");

  const entry = task!.conversation?.find((e) =>
    e.blocks?.some((b) => b.type === "tool_use"),
  );
  expect(entry).toBeDefined();
  const uses = (entry!.blocks ?? []).filter((b) => b.type === "tool_use");
  const results = (entry!.blocks ?? []).filter((b) => b.type === "tool_result");
  expect(uses.map((b) => (b.type === "tool_use" ? b.id : ""))).toEqual([
    "call-read",
    "call-bash",
  ]);
  expect(
    results.map((b) => (b.type === "tool_result" ? b.tool_use_id : "")),
  ).toEqual(["call-read", "call-bash"]);

  // Resume metadata stays usable: wire messages validate strictly.
  const wire = buildInitialMessages(task!);
  expect(wire.length).toBeGreaterThan(0);
  expect(validateConversationProtocol(wire).valid).toBe(true);

  // ---- Audit JSONL on disk (raw file reads) ----
  expect(fs.existsSync(host.auditFile)).toBe(true);
  expectValidJsonl(host.auditFile);
  const records = readJsonlRecords(host.auditFile) as Array<{
    toolId?: string;
    taskId?: string;
    approved?: boolean;
  }>;
  expect(records.length).toBeGreaterThan(0);
  // The real M4 bridge decision for this run's read tool is persisted.
  const bridgeRecord = records.find((r) => r.toolId === "read_file");
  expect(bridgeRecord).toBeDefined();
  expect(bridgeRecord!.approved).toBe(true);
}

describe("vscode integration — activate → run → deactivate", () => {
  it("full flow: task, conversation, tools, audit, completion, reload", async () => {
    const host = await freshHost();
    try {
      // A REAL M4 decision through the REAL bridge + persistent sink.
      const bridge = host.seams.getLivePermissionBridge();
      const decision = await bridge.evaluateLiveTool({
        toolName: "read_file",
        input: { path: "src/app.ts" },
        sessionId: "sess-int-1",
        taskId: "task-int-1",
      });
      expect(decision.approved).toBe(true);

      const taskId = await scriptedRun(host, {
        title: "integration full flow",
        deltas: ["I will read ", "and run."],
        tools: [
          {
            id: "call-read",
            name: "read_file",
            input: { path: "src/app.ts" },
            output: "file contents here",
          },
          {
            id: "call-bash",
            name: "bash",
            input: { command: "npm test" },
            output: "all green",
          },
        ],
        terminal: "completed",
        resultText: "All done.",
      });

      await fullFlowAssertions(host, taskId);

      // ---- Deactivation flushes, then reload proves durability ----
      await host.ext.deactivate();
      expectValidJsonl(host.auditFile);
      const afterDeactivate = new TaskStore(host.tasksDir);
      expect((await afterDeactivate.get(taskId))?.status).toBe("completed");
      expect(host.seams.getPersistenceQueue().isIdle(taskId)).toBe(true);
    } finally {
      host.cleanup();
    }
  });

  it("deactivate immediately after completion keeps durable state", async () => {
    const host = await freshHost();
    try {
      const taskId = await scriptedRun(host, {
        title: "immediate deactivate",
        deltas: ["quick"],
        terminal: "completed",
        resultText: "done",
      });
      // No extra settling — deactivate itself must settle persistence.
      await host.ext.deactivate();
      const reopened = new TaskStore(host.tasksDir);
      const task = await reopened.get(taskId);
      expect(task?.status).toBe("completed");
      const texts = (task?.conversation ?? []).flatMap((e) => e.blocks ?? []);
      expect(texts.some((b) => b.type === "text")).toBe(true);
    } finally {
      host.cleanup();
    }
  });

  it("cancel → deactivate persists in-flight state as interrupted", async () => {
    const host = await freshHost();
    try {
      const taskId = await scriptedRun(host, {
        title: "cancel flow",
        deltas: ["partial answer"],
        tools: [
          {
            id: "call-1",
            name: "read_file",
            input: { path: "a.ts" },
            output: "aaa",
          },
        ],
        terminal: "cancelled",
      });
      await host.ext.deactivate();
      const reopened = new TaskStore(host.tasksDir);
      const task = await reopened.get(taskId);
      expect(task?.status).toBe("interrupted");
      expect(task?.lastStep).toBe("run_interrupted");
      const blocks = (task?.conversation ?? []).flatMap((e) => e.blocks ?? []);
      expect(blocks.some((b) => b.type === "text")).toBe(true);
      expect(blocks.filter((b) => b.type === "tool_result")).toHaveLength(1);
    } finally {
      host.cleanup();
    }
  });

  it("error → deactivate flags the run and keeps text", async () => {
    const host = await freshHost();
    try {
      const taskId = await scriptedRun(host, {
        title: "error flow",
        deltas: ["starting work"],
        terminal: "error",
        resultText: "provider exploded",
      });
      await host.ext.deactivate();
      const reopened = new TaskStore(host.tasksDir);
      const task = await reopened.get(taskId);
      expect(task?.lastStep).toBe("run_failed");
      expect(task?.messages.at(-1)?.content).toContain("provider exploded");
    } finally {
      host.cleanup();
    }
  });

  it("tool-only run (no assistant text) persists tool_use/tool_result", async () => {
    const host = await freshHost();
    try {
      const taskId = await scriptedRun(host, {
        title: "tools only",
        tools: [
          {
            id: "call-only",
            name: "bash",
            input: { command: "ls" },
            output: "a.ts",
          },
        ],
        terminal: "completed",
        resultText: "listed",
      });
      await host.ext.deactivate();
      const reopened = new TaskStore(host.tasksDir);
      const task = await reopened.get(taskId);
      const blocks = (task?.conversation ?? []).flatMap((e) => e.blocks ?? []);
      expect(blocks.filter((b) => b.type === "tool_use")).toHaveLength(1);
      expect(blocks.filter((b) => b.type === "tool_result")).toHaveLength(1);
      expect(validateConversationProtocol(buildInitialMessages(task!)).valid).toBe(
        true,
      );
    } finally {
      host.cleanup();
    }
  });

  it("multiple tasks → deactivate keeps every task durable", async () => {
    const host = await freshHost();
    try {
      const ids = [
        await scriptedRun(host, {
          title: "task one",
          deltas: ["one"],
          terminal: "completed",
          resultText: "one done",
        }),
        await scriptedRun(host, {
          title: "task two",
          tools: [
            {
              id: "t2-call",
              name: "read_file",
              input: { path: "b.ts" },
              output: "bbb",
            },
          ],
          terminal: "completed",
          resultText: "two done",
        }),
        await scriptedRun(host, {
          title: "task three",
          deltas: ["three"],
          terminal: "cancelled",
        }),
      ];
      await host.ext.deactivate();
      const reopened = new TaskStore(host.tasksDir);
      const statuses = await Promise.all(
        ids.map(async (id) => (await reopened.get(id))?.status),
      );
      expect(statuses).toEqual(["completed", "completed", "interrupted"]);
    } finally {
      host.cleanup();
    }
  });

  it("repeated activate/deactivate cycles use fresh isolated storage", async () => {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const host = await freshHost();
      try {
        const taskId = await scriptedRun(host, {
          title: `cycle ${cycle}`,
          deltas: [`text ${cycle}`],
          terminal: "completed",
          resultText: `done ${cycle}`,
        });
        await host.ext.deactivate();
        // Storage is isolated per cycle: exactly one task file exists.
        const files = fs
          .readdirSync(host.tasksDir)
          .filter((f) => f.endsWith(".json"));
        expect(files).toHaveLength(1);
        const reopened = new TaskStore(host.tasksDir);
        expect((await reopened.get(taskId))?.status).toBe("completed");
        // Audit side is isolated too.
        expectValidJsonl(host.auditFile);
      } finally {
        host.cleanup();
      }
      // Cleanup is complete: nothing leaks between cycles.
      expect(fs.existsSync(host.storageDir)).toBe(false);
    }
  });

  it("audit sink flushes everything pending during deactivate", async () => {
    const host = await freshHost();
    try {
      const bridge = host.seams.getLivePermissionBridge();
      for (let i = 0; i < 5; i += 1) {
        const d = await bridge.evaluateLiveTool({
          toolName: "read_file",
          input: { path: `f${i}.ts` },
          taskId: `t${i}`,
        });
        expect(d.approved).toBe(true);
      }
      // Deactivate WITHOUT any manual flush — dispose must persist the tail.
      await host.ext.deactivate();
      expectValidJsonl(host.auditFile);
      const records = readJsonlRecords(host.auditFile);
      expect(records.length).toBe(5);
    } finally {
      host.cleanup();
    }
  });

  it("persistence queue settles terminal ops before deactivate returns", async () => {
    const host = await freshHost();
    try {
      const taskId = await host.seams.beginTask("settlement check");
      expect(taskId).not.toBeNull();
      host.seams.ingestAgentEvent({ type: "started", sessionId: "s1" });
      host.seams.ingestAgentEvent({ type: "text_delta", text: "hi", accumulated: "hi" });
      host.seams.ingestAgentEvent({
        type: "completed",
        result: "done",
        usage: { inputTokens: 1, outputTokens: 1, totalCost: 0 },
      });
      await host.ext.deactivate();
      const queue = host.seams.getPersistenceQueue();
      expect(queue.pendingCount(taskId!)).toBe(0);
      expect(queue.isIdle(taskId!)).toBe(true);
      const reopened = new TaskStore(host.tasksDir);
      expect((await reopened.get(taskId!))?.status).toBe("completed");
    } finally {
      host.cleanup();
    }
  });

  it("shutdown with persistence work pending does not lose it", async () => {
    const host = await freshHost();
    try {
      const taskId = await host.seams.beginTask("pending shutdown");
      expect(taskId).not.toBeNull();
      host.seams.ingestAgentEvent({ type: "started", sessionId: "s1" });
      // Fire events with NO debounce wait and NO drain, then shut down at once.
      let acc = "";
      for (let i = 0; i < 20; i += 1) {
        acc += `w${i} `;
        host.seams.ingestAgentEvent({ type: "text_delta", text: `w${i} `, accumulated: acc });
      }
      host.seams.ingestAgentEvent({
        type: "completed",
        result: "done",
        usage: { inputTokens: 1, outputTokens: 1, totalCost: 0 },
      });
      await host.ext.deactivate();
      // deactivate awaited drainAll: the terminal op (with final flush) landed.
      const reopened = new TaskStore(host.tasksDir);
      const task = await reopened.get(taskId!);
      expect(task?.status).toBe("completed");
      const texts = (task?.conversation ?? []).flatMap((e) => e.blocks ?? []);
      const full = texts.find((b) => b.type === "text");
      expect(full?.type === "text" && full.text).toBe(acc);
    } finally {
      // Give the orphaned 300ms scheduler timer a chance to fire harmlessly
      // before the storage dir is removed (it targets its own capture).
      await sleep(DEBOUNCE_WAIT_MS);
      host.cleanup();
    }
  });
});
