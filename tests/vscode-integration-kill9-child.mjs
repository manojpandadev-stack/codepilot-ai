/**
 * Kill-9 child: writes realistic TaskStore + audit data, then dies abnormally.
 *
 * Runs under plain node against the BUILT packages (dist), proving the
 * shipped artifacts — not just vitest-transformed src — persist and recover.
 *
 * Protocol: argv[2] = storage dir. Writes a summary JSON file describing
 * what was durably flushed, then:
 *  - appends torn bytes to the audit file (kill mid-append artifact), and
 *  - appends garbage to ONE task file (disk-corruption artifact → quarantine),
 * then exits(137) WITHOUT dispose/drain — the in-memory half (including one
 * unflushed audit record) dies on the spot.
 *
 * Determinism note: a true async kill landing mid-syscall cannot be timed
 * deterministically on any OS (and especially not on Windows CI), so this
 * script produces the precise post-kill artifacts — torn tails, a `running`
 * task, a corrupt file, an unflushed in-memory tail lost by design — and the
 * parent asserts recovery over them. No flakiness by construction.
 *
 * NOTE: TaskStore's own writes are atomic (tmp + rename), so a kill during
 * its write can never tear a task file — it leaves the old or the new file.
 * The garbage-appended task file therefore models *corruption* (quarantine),
 * not a torn store write.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { TaskStore } from "../packages/agent-runtime/dist/m12-task-store.js";
import { PersistentAuditLogger } from "../packages/tool-engine/dist/m3/audit-logger.js";

const storageDir = process.argv[2];
if (!storageDir) {
  console.error("usage: vscode-integration-kill9-child.mjs <storageDir>");
  process.exit(2);
}

const tasksDir = path.join(storageDir, "tasks");
const auditDir = path.join(storageDir, "audit");
fs.mkdirSync(tasksDir, { recursive: true });
fs.mkdirSync(auditDir, { recursive: true });

function nodeAdapter(dir) {
  const file = (name) => path.join(dir, path.basename(name));
  return {
    directory: () => dir,
    readFile: (name) => {
      try {
        return fs.readFileSync(file(name), "utf8");
      } catch {
        return null;
      }
    },
    appendLine: (name, line) => fs.appendFileSync(file(name), line, "utf8"),
    removeFile: (name) => {
      try {
        fs.rmSync(file(name), { force: true });
      } catch {
        // ignore
      }
    },
    listFiles: () => {
      try {
        return fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => {
            let size = 0;
            try {
              size = fs.statSync(path.join(dir, e.name)).size;
            } catch {
              // ignore
            }
            return { name: e.name, size };
          });
      } catch {
        return [];
      }
    },
    sync: () => {},
  };
}

const store = new TaskStore(tasksDir);
const audit = new PersistentAuditLogger(nodeAdapter(auditDir));

// A completed run: fully durable before the kill.
const doneTask = await store.create("kill9 completed run", {
  providerId: "ollama",
  modelId: "qwen3:8b",
});
await store.appendMessage(doneTask.id, "user", "do the thing");
await store.upsertConversationEntry(doneTask.id, "run-k9-done", {
  role: "assistant",
  blocks: [
    { type: "text", text: "Done." },
    { type: "tool_use", id: "k9-call", name: "read_file", input: '{"path":"a"}' },
    {
      type: "tool_result",
      tool_use_id: "k9-call",
      name: "read_file",
      content: "aaa",
    },
  ],
  timestampMs: Date.now(),
});
await store.update(doneTask.id, { status: "completed" });

// A running run: interrupted by the kill, must recover to `interrupted`.
const runningTask = await store.create("kill9 running run");
await store.appendMessage(runningTask.id, "user", "unfinished business");
await store.upsertConversationEntry(runningTask.id, "run-k9-live", {
  role: "assistant",
  blocks: [{ type: "text", text: "half an answer" }],
  timestampMs: Date.now(),
});

// A second running run whose file gets corrupted below (quarantine path).
const corruptTask = await store.create("kill9 corrupt run");
await store.appendMessage(corruptTask.id, "user", "doomed");

// Durable audit records (flushed), then one that stays in memory (lost).
audit.record({
  executionId: "k9-exec-1",
  toolId: "read_file",
  taskId: doneTask.id,
  startedAt: Date.now(),
  completedAt: Date.now(),
  durationMs: 3,
  status: "completed",
  permissionDecision: "approved",
  retries: 0,
  action: "read_file",
  risk: "LOW",
  approved: true,
  safeTarget: "a.ts",
});
await audit.flush();
audit.record({
  executionId: "k9-exec-2-unflushed",
  toolId: "execute_command",
  taskId: runningTask.id,
  startedAt: Date.now(),
  completedAt: Date.now(),
  durationMs: 4,
  status: "completed",
  permissionDecision: "approved",
  retries: 0,
  action: "execute_command",
  risk: "MEDIUM",
  approved: true,
  safeTarget: "npm",
});
// NOTE: deliberately NOT flushed — dies in memory with the process.

// Summary of what IS durable (parent asserts exactly this + recovery).
fs.writeFileSync(
  path.join(storageDir, "kill9-summary.json"),
  JSON.stringify(
    {
      doneTaskId: doneTask.id,
      runningTaskId: runningTask.id,
      corruptTaskId: corruptTask.id,
      flushedAuditIds: ["k9-exec-1"],
      lostAuditIds: ["k9-exec-2-unflushed"],
    },
    null,
    2,
  ),
  "utf8",
);

// Torn audit tail: the kill landing mid-append.
fs.appendFileSync(
  path.join(auditDir, "tool-audit.jsonl"),
  '{"executionId": "k9-torn-frag',
  "utf8",
);
// Corrupt task file: models disk corruption (quarantine design path).
fs.appendFileSync(
  path.join(tasksDir, `${corruptTask.id}.json`),
  "TRUNCATED-BY-KILL",
  "utf8",
);

// Die abnormally: no dispose, no drain, no cleanup.
process.exit(137);
