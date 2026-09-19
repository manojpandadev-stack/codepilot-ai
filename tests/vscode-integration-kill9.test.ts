/**
 * Kill-9 / subprocess recovery test (Phase 4).
 *
 * Spawns a REAL child node process running the built (dist) packages, which
 * writes realistic TaskStore + audit data and then exits(137) abnormally —
 * no dispose, no drain — with torn bytes left on both files. The parent
 * (this test) then performs startup recovery in a fresh process context and
 * validates every required property.
 *
 * Windows-safe: child_process.execFile with process.execPath (no shell),
 * node path APIs, exit-code assertion (137 = abnormal). No Unix signals.
 */

import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TaskStore } from "../packages/agent-runtime/src/m12-task-store";
import { PersistentAuditLogger } from "../packages/tool-engine/src/m3/audit-logger";
import { readJsonlRecords, expectValidJsonl } from "./vscode-integration-harness";

function runChild(storageDir: string): Promise<{ code: number | null }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        path.join(__dirname, "vscode-integration-kill9-child.mjs"),
        storageDir,
      ],
      { timeout: 60_000 },
      (error, _stdout, _stderr) => {
        // Abnormal exit surfaces as an error with `.code` — that IS the
        // assertion input (the child must die abnormally, not cleanly).
        if (error && "code" in (error as object)) {
          resolve({ code: (error as { code: number }).code });
          return;
        }
        if (error) {
          reject(error);
          return;
        }
        resolve({ code: 0 });
      },
    );
  });
}

describe("kill-9 subprocess recovery", () => {
  it("abnormal child exit recovers: tasks, quarantine, audit, idempotency", async () => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-k9-"));
    try {
      const { code } = await runChild(storageDir);
      // The child died abnormally (SIGKILL equivalent), never cleanly.
      expect(code).toBe(137);

      const summary = JSON.parse(
        fs.readFileSync(path.join(storageDir, "kill9-summary.json"), "utf8"),
      ) as {
        doneTaskId: string;
        runningTaskId: string;
        corruptTaskId: string;
        flushedAuditIds: string[];
        lostAuditIds: string[];
      };
      const tasksDir = path.join(storageDir, "tasks");
      const auditFile = path.join(storageDir, "audit", "tool-audit.jsonl");

      // ---- Fresh-process recovery (parent = the new process) ----
      const store = new TaskStore(tasksDir);
      const recovered = await store.markInterruptedOnStartup();
      expect(recovered).toBe(1);

      // Completed task: byte-identical, never touched by recovery.
      const done = await store.get(summary.doneTaskId);
      expect(done?.status).toBe("completed");
      const doneBlocks = (done?.conversation ?? []).flatMap((e) => e.blocks ?? []);
      expect(doneBlocks.filter((b) => b.type === "tool_use")).toHaveLength(1);
      expect(doneBlocks.filter((b) => b.type === "tool_result")).toHaveLength(1);

      // Running task: recoverable as interrupted, partial text intact.
      const running = await store.get(summary.runningTaskId);
      expect(running?.status).toBe("interrupted");
      const runningBlocks = (running?.conversation ?? []).flatMap(
        (e) => e.blocks ?? [],
      );
      expect(
        runningBlocks.some(
          (b) => b.type === "text" && b.text === "half an answer",
        ),
      ).toBe(true);

      // Corrupt task file: quarantined (*.corrupt), never crashes listing.
      expect(
        fs.existsSync(path.join(tasksDir, `${summary.corruptTaskId}.json.corrupt`)),
      ).toBe(true);
      expect(await store.get(summary.corruptTaskId)).toBeNull();
      const listed = await store.list();
      expect(listed.find((t) => t.id === summary.corruptTaskId)).toBeUndefined();
      expect(listed.map((t) => t.id).sort()).toEqual(
        [summary.doneTaskId, summary.runningTaskId].sort(),
      );

      // Audit: fresh logger truncates the torn tail; flushed records survive,
      // the unflushed in-memory tail is lost (bounded, by design).
      const auditDir = path.join(storageDir, "audit");
      const adapter = {
        directory: () => auditDir,
        readFile: (name: string) => {
          try {
            return fs.readFileSync(path.join(auditDir, name), "utf8");
          } catch {
            return null;
          }
        },
        appendLine: (name: string, line: string) =>
          fs.appendFileSync(path.join(auditDir, name), line, "utf8"),
        removeFile: (name: string) => {
          fs.rmSync(path.join(auditDir, name), { force: true });
        },
        listFiles: () =>
          fs
            .readdirSync(auditDir, { withFileTypes: true })
            .filter((e) => e.isFile())
            .map((e) => ({
              name: e.name,
              size: fs.statSync(path.join(auditDir, e.name)).size,
            })),
        sync: () => {},
      };
      const audit = new PersistentAuditLogger(adapter);
      expectValidJsonl(auditFile);
      const records = readJsonlRecords(auditFile) as Array<{ executionId?: string }>;
      expect(records.map((r) => r.executionId)).toEqual(summary.flushedAuditIds);
      expect(
        records.some((r) => summary.lostAuditIds.includes(r.executionId ?? "")),
      ).toBe(false);
      await audit.dispose();

      // Recovery is idempotent: second pass changes nothing.
      const snapBefore = fs.readFileSync(
        path.join(tasksDir, `${summary.runningTaskId}.json`),
        "utf8",
      );
      expect(await new TaskStore(tasksDir).markInterruptedOnStartup()).toBe(0);
      expect(
        fs.readFileSync(path.join(tasksDir, `${summary.runningTaskId}.json`), "utf8"),
      ).toBe(snapBefore);
    } finally {
      fs.rmSync(storageDir, { recursive: true, force: true });
    }
  });
});
