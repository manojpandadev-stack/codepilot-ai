/**
 * Shared VS Code integration harness (test-only, no production code).
 *
 * Boots the REAL extension module (`apps/vscode-extension/src/extension.ts`)
 * against an isolated temporary `globalStorage` directory, using the
 * `vscode` module stub (vitest alias). Each `freshHost()` call resets the
 * vitest module registry first, so every host gets pristine extension
 * singletons bound to its own storage — a faithful activate → run →
 * deactivate cycle per test.
 *
 * WHAT IS REAL vs SIMULATED
 * - REAL: activate()/deactivate(), M4 pipeline init, TaskStore (+ crash-safe
 *   writes, quarantine, markInterruptedOnStartup), TaskPersistenceQueue
 *   (incl. drain/drainAll), CaptureFlushScheduler debounce, PersistentAuditLogger
 *   JSONL sink + rotation + redaction, LiveToolPermissionBridge decisions,
 *   resume builders (buildInitialMessages / fidelity classification).
 * - SIMULATED: the LLM/provider event source. Scripted AgentEvents (user,
 *   text deltas, tool_requested/completed/failed, terminal) are fed through
 *   the REAL `forwardAgentEvent` pipeline via the `__integrationSeams`
 *   export — the same function the live runtime subscribes to.
 *
 * Windows-safe: tmp dirs via os.tmpdir(), node path.join, no shell.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { vi } from "vitest";
import type * as ExtensionModule from "../apps/vscode-extension/src/extension";
import type { AgentEvent } from "../packages/agent-runtime/src/types";

export const DEBOUNCE_WAIT_MS = 450;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface FreshHost {
  ext: typeof ExtensionModule;
  seams: ExtensionModule.IntegrationSeams;
  /** The exact `vscode` stub instance this host's extension module resolved. */
  vscodeStub: typeof import("vscode");
  storageDir: string;
  tasksDir: string;
  auditDir: string;
  auditFile: string;
  cleanup: () => void;
}

/** Boot a fresh extension host against isolated storage. */
export async function freshHost(): Promise<FreshHost> {
  vi.resetModules();
  // NOTE: intentionally NOT statically importing the stub or the extension —
  // after resetModules the registry is fresh, so these dynamic imports are
  // the exact instances the extension module itself resolves.
  const vscodeStub = await import("vscode");
  const ext = await import("../apps/vscode-extension/src/extension");

  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-int-"));
  return activateAgainst(ext, vscodeStub, storageDir, true);
}

function activateAgainst(
  ext: typeof import("../apps/vscode-extension/src/extension"),
  vscodeStub: typeof import("vscode"),
  storageDir: string,
  ownsDir: boolean,
): FreshHost {
  const context = {
    secrets: new vscodeStub.SecretStorageStub(),
    globalState: new vscodeStub.MementoStub(),
    workspaceState: new vscodeStub.MementoStub(),
    subscriptions: [] as { dispose(): unknown }[],
    extensionPath: storageDir,
    extensionUri: vscodeStub.Uri.file(storageDir),
    globalStoragePath: storageDir,
    globalStorageUri: vscodeStub.Uri.file(storageDir),
    extensionMode: 1,
  };
  ext.activate(
    context as unknown as Parameters<typeof ext.activate>[0],
  );

  const tasksDir = path.join(storageDir, "tasks");
  const auditDir = path.join(storageDir, "audit");
  return {
    ext,
    seams: ext.__integrationSeams,
    vscodeStub,
    storageDir,
    tasksDir,
    auditDir,
    auditFile: path.join(auditDir, "tool-audit.jsonl"),
    cleanup: () => {
      if (ownsDir) fs.rmSync(storageDir, { recursive: true, force: true });
    },
  };
}

/**
 * Crash-style reopen: a NEW host (fresh module state, fresh queue) against
 * the SAME storage dir — exactly what an extension-host restart does.
 * Waits for the fire-and-forget startup recovery to settle, then returns.
 * `ownsDir` controls whether cleanup() removes the directory.
 */
export async function reopenHost(
  storageDir: string,
  ownsDir = false,
): Promise<FreshHost> {
  vi.resetModules();
  const vscodeStub = await import("vscode");
  const ext = await import("../apps/vscode-extension/src/extension");
  const host = activateAgainst(ext, vscodeStub, storageDir, ownsDir);
  // Startup recovery (markInterruptedOnStartup) is fire-and-forget in
  // activate(); sync-fs work settles in microtasks — this wait is generous.
  await sleep(150);
  return host;
}

export interface ScriptedTool {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  fail?: boolean;
  error?: string;
}

export interface ScriptedRun {
  title: string;
  deltas?: string[];
  tools?: ScriptedTool[];
  terminal: "completed" | "error" | "cancelled";
  resultText?: string;
}

/**
 * Drive a deterministic simulated agent run through the REAL event pipeline,
 * then settle: wait out the streaming debounce and drain the queue.
 * Returns the task id.
 */
export async function scriptedRun(
  host: FreshHost,
  run: ScriptedRun,
): Promise<string> {
  const { seams } = host;
  const taskId = await seams.beginTask(run.title);
  if (!taskId) throw new Error("beginTask failed — TaskStore unavailable");

  const emit = (event: AgentEvent): void => seams.ingestAgentEvent(event);
  emit({ type: "started", sessionId: `sess-${taskId}` });
  let acc = "";
  for (const d of run.deltas ?? []) {
    acc += d;
    emit({ type: "text_delta", text: d, accumulated: acc });
  }
  for (const t of run.tools ?? []) {
    emit({
      type: "tool_requested",
      toolCallId: t.id,
      toolName: t.name,
      input: t.input,
    });
    if (t.fail) {
      emit({
        type: "tool_failed",
        toolCallId: t.id,
        toolName: t.name,
        error: t.error ?? "boom",
      });
    } else {
      emit({
        type: "tool_completed",
        toolCallId: t.id,
        toolName: t.name,
        output: t.output,
        durationMs: 5,
      });
    }
  }
  if (run.terminal === "completed") {
    emit({
      type: "completed",
      result: run.resultText ?? "done",
      usage: { inputTokens: 10, outputTokens: 20, totalCost: 0 },
    });
  } else if (run.terminal === "error") {
    emit({ type: "error", error: run.resultText ?? "boom", recoverable: false });
  } else {
    emit({ type: "cancelled" });
  }

  // Settle: debounce timer (300ms production) must fire, then queued ops drain.
  await sleep(DEBOUNCE_WAIT_MS);
  await seams.drainPersistence(taskId);
  // One more lap: a flush enqueued by the debounce may itself have been
  // followed by nothing — drain is idempotent, so this is just certainty.
  await seams.drainPersistence(taskId);
  return taskId;
}

/** Read every JSONL record from a file (fresh from disk, not via the sink). */
export function readJsonlRecords(file: string): unknown[] {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

/** Assert a file is valid JSONL — every non-empty line parses. */
export function expectValidJsonl(file: string): void {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, "utf8");
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    JSON.parse(line);
  }
  // No torn tail: file must end with a newline when non-empty.
  if (raw.length > 0 && !raw.endsWith("\n")) {
    throw new Error(`torn final JSONL line in ${file}`);
  }
}
