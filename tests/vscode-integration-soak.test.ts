/**
 * Persistence soak (Phases 8–9): scripted realistic load through the REAL
 * extension pipeline (same `forwardAgentEvent` + queue + TaskStore the live
 * runs use), then large-task reload + double recovery.
 *
 * Load shape is honest about what it is: persistence workload (user text,
 * assistant text, tool_use/tool_result pairs, terminal events, 3 tasks),
 * NOT 1700 LLM calls. The persistence path is identical once events exist —
 * the live file proves the event source separately. No machine-specific
 * latency thresholds: correctness is asserted, timings print as evidence.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  freshHost,
  reopenHost,
  readJsonlRecords,
  expectValidJsonl,
  sleep,
  DEBOUNCE_WAIT_MS,
} from "./vscode-integration-harness";
import { TaskStore } from "../packages/agent-runtime/src/m12-task-store";
import { buildInitialMessages } from "../packages/agent-runtime/src/resume";
import { validateConversationProtocol } from "../packages/agent-runtime/src/compaction-protocol";

const nowMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);

function realisticResult(i: number): string {
  return `file-${i}.ts\n${"const x = compute(i);\n".repeat(80)}`;
}

describe("persistence soak + large reload", () => {
  it("200/500/1000 entries across 3 tasks stay exact, then reload validates", { timeout: 300_000 }, async () => {
    const host = await freshHost();
    try {
      const sizes = [200, 500, 1000];
      const taskIds: string[] = [];
      const splits: Array<{ entries: number; ms: number }> = [];
      const heapBefore = process.memoryUsage().heapUsed;
      let lagMax = 0;
      let lastProbe = Date.now();
      const lagTimer = setInterval(() => {
        const t = Date.now();
        lagMax = Math.max(lagMax, t - lastProbe - 10);
        lastProbe = t;
      }, 10);

      const overallStart = nowMs();
      try {
        for (let t = 0; t < sizes.length; t += 1) {
          const n = sizes[t]!;
          const taskId = await host.seams.beginTask(`soak task ${t} (${n})`);
          expect(taskId).not.toBeNull();
          taskIds.push(taskId!);
          host.seams.ingestAgentEvent({ type: "started", sessionId: `soak-${t}` });
          const splitStart = nowMs();
          for (let i = 0; i < n; i += 1) {
            const id = `soak-${t}-${i}`;
            host.seams.ingestAgentEvent({
              type: "tool_requested",
              toolCallId: id,
              toolName: "read_file",
              input: { path: `src/f${i}.ts` },
            });
            // Assistant text interleaved every 4th tool (mixed workload).
            if (i % 4 === 0) {
              host.seams.ingestAgentEvent({
                type: "text_delta",
                text: `turn ${i} `,
                accumulated: `turns ${(i / 4) | 0}`,
              });
            }
            host.seams.ingestAgentEvent({
              type: "tool_completed",
              toolCallId: id,
              toolName: "read_file",
              output: realisticResult(i),
              durationMs: 2,
            });
          }
          host.seams.ingestAgentEvent({
            type: "completed",
            result: `soak ${t} done`,
            usage: { inputTokens: n * 10, outputTokens: n * 20, totalCost: 0 },
          });
          splits.push({ entries: n, ms: nowMs() - splitStart });
        }
      } finally {
        clearInterval(lagTimer);
      }
      const ingestMs = nowMs() - overallStart;

      // Settle everything (debounce + queue), then verify.
      await sleep(DEBOUNCE_WAIT_MS);
      for (const id of taskIds) await host.seams.drainPersistence(id);
      const totalMs = nowMs() - overallStart;

      const store = new TaskStore(host.tasksDir);
      let totalUses = 0;
      let totalResults = 0;
      for (let t = 0; t < sizes.length; t += 1) {
        const task = await store.get(taskIds[t]!);
        expect(task?.status).toBe("completed");
        const blocks = (task?.conversation ?? []).flatMap((e) => e.blocks ?? []);
        const uses = blocks.filter((b) => b.type === "tool_use");
        const results = blocks.filter((b) => b.type === "tool_result");
        // Exact: no lost entries, no duplicates (one use + one result per id).
        expect(uses).toHaveLength(sizes[t]!);
        expect(results).toHaveLength(sizes[t]!);
        expect(new Set(uses.map((b) => b.type === "tool_use" && b.id)).size).toBe(sizes[t]!);
        totalUses += uses.length;
        totalResults += results.length;
        expect(validateConversationProtocol(buildInitialMessages(task!)).valid).toBe(true);
      }
      expect(totalUses).toBe(1700);
      expect(totalResults).toBe(1700);

      // Every task file is well-formed JSON; queue is idle everywhere.
      for (const id of taskIds) {
        JSON.parse(fs.readFileSync(path.join(host.tasksDir, `${id}.json`), "utf8"));
        expect(host.seams.getPersistenceQueue().isIdle(id)).toBe(true);
      }
      const diskBytes = fs
        .readdirSync(host.tasksDir)
        .reduce((s, f) => s + fs.statSync(path.join(host.tasksDir, f)).size, 0);

      console.log(
        `SOAK splits(ms per batch): ${splits.map((s) => `${s.entries}:${s.ms}`).join(" ")} | ingest ${ingestMs}ms total ${totalMs}ms | disk ${Math.round(diskBytes / 1024)}KB | lag ${Math.max(0, lagMax)}ms | heap +${Math.round((process.memoryUsage().heapUsed - heapBefore) / 1024)}KB`,
      );

      // ---- Phase 9: reload the largest task fresh, resume + recovery ----
      const reopened = await reopenHost(host.storageDir);
      try {
        const fresh = new TaskStore(host.tasksDir);
        const largest = await fresh.get(taskIds[2]!);
        expect(largest).not.toBeNull();
        // Resume context composes + validates on the reloaded record.
        const wire = buildInitialMessages(largest!);
        expect(wire.length).toBeGreaterThan(0);
        expect(validateConversationProtocol(wire).valid).toBe(true);
        // Compaction metadata stays valid alongside the large history.
        await fresh.addCompactionArtifact(taskIds[2]!, {
          id: "soak-artifact",
          createdAtMs: Date.now(),
          mode: "summary",
          summarizedMessageCount: 100,
          tokensBefore: 50000,
          tokensAfter: 500,
          summary: "soak head",
        } as never);
        const withArtifact = await fresh.get(taskIds[2]!);
        expect(withArtifact?.compactions?.map((a) => a.id)).toEqual(["soak-artifact"]);
        // Audit side reads clean.
        expectValidJsonl(host.auditFile);
        readJsonlRecords(host.auditFile);
        // Startup recovery twice: completed soak tasks byte-identical.
        const snap = fs.readFileSync(path.join(host.tasksDir, `${taskIds[2]!}.json`), "utf8");
        expect(await fresh.markInterruptedOnStartup()).toBe(0);
        expect(await new TaskStore(host.tasksDir).markInterruptedOnStartup()).toBe(0);
        expect(fs.readFileSync(path.join(host.tasksDir, `${taskIds[2]!}.json`), "utf8")).toBe(snap);
      } finally {
        await reopened.ext.deactivate();
      }
    } finally {
      await sleep(DEBOUNCE_WAIT_MS);
      host.cleanup();
    }
  });
});
