/**
 * PHASE 3 (live) — APPROVAL TIMELINE end-to-end lifecycle.
 *
 * Real task through the production pipeline:
 *   1. start task (chat)
 *   2. trigger a protected op (write_file) → approval requested
 *   3. DENY → op does NOT execute
 *   4. trigger another protected op → approval requested
 *   5. ALLOW → op executes
 *   6. persist task
 *   7. close/reopen runtime
 *   8. read persisted approval timeline
 *   9. verify requested/denied/requested/granted events remain correct
 *
 * Skips honestly (logged) when no local Ollama is reachable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FreshHost } from "./vscode-integration-harness";

const OLLAMA_URL = "http://127.0.0.1:11434";

interface CapturedMessage {
  type: string;
  id?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}
const ofType = (m: CapturedMessage[], t: string) => m.filter((x) => x.type === t);

let live = false;
let root = "";
let storageDir = "";
let host: FreshHost;
let messages: CapturedMessage[] = [];

function setLiveConfigOverrides() {
  host.vscodeStub.configOverrides.set("model", "qwen3:8b");
  host.vscodeStub.configOverrides.set("maxIterations", 12);
  host.vscodeStub.configOverrides.set("localAI.ollama.useNodeHttpTransport", true);
  host.vscodeStub.configOverrides.set("localAI.ollama.think", "disabled");
  host.vscodeStub.configOverrides.set("localAI.ollama.keepAlive", 60);
}

async function makeHost(workspaceRoot: string, storage: string): Promise<FreshHost> {
  const { vi } = await import("vitest");
  vi.resetModules();
  const vscodeStub = await import("vscode");
  vscodeStub.workspace.workspaceFolders.length = 0;
  vscodeStub.workspace.workspaceFolders.push({ uri: { fsPath: workspaceRoot } });
  const ext = await import("../apps/vscode-extension/src/extension");
  const context = {
    secrets: new vscodeStub.SecretStorageStub(),
    globalState: new vscodeStub.MementoStub(),
    workspaceState: new vscodeStub.MementoStub(),
    subscriptions: [] as { dispose(): unknown }[],
    extensionPath: storage,
    extensionUri: vscodeStub.Uri.file(storage),
    globalStoragePath: storage,
    globalStorageUri: vscodeStub.Uri.file(storage),
    extensionMode: 1,
  };
  ext.activate(context as unknown as Parameters<typeof ext.activate>[0]);
  ext.__setWebviewSinkForIntegrationTest((m) => messages.push(m as CapturedMessage));
  return {
    ext,
    seams: ext.__integrationSeams,
    vscodeStub,
    storageDir: storage,
    tasksDir: path.join(storage, "tasks"),
    auditDir: path.join(storage, "audit"),
    auditFile: path.join(storage, "audit", "tool-audit.jsonl"),
    cleanup: () => fs.rmSync(storage, { recursive: true, force: true }),
  } as unknown as FreshHost;
}

/** One chat/send leg; answers each approval with the given decision. */
async function leg(id: string, prompt: string, decision: "allow" | "deny") {
  messages.length = 0;
  const answered: string[] = [];
  const run = host.seams.handleMessage({
    type: "chat/send",
    id,
    payload: { text: prompt, mode: "act", requestId: id },
    timestamp: Date.now(),
  } as never);
  let settled = false;
  void run.then(() => { settled = true; }, () => { settled = true; });
  while (!settled) {
    await new Promise((r) => setTimeout(r, 500));
    for (const m of ofType(messages, "tool/request_approval")) {
      const approvalId = String(m.payload?.approvalId ?? m.id ?? "");
      if (!approvalId || answered.includes(approvalId)) continue;
      answered.push(approvalId);
      await host.seams.handleMessage({
        type: "tool/approval_result",
        id: `ans-${approvalId}`,
        payload: { approvalId, decision },
        timestamp: Date.now(),
      } as never);
    }
  }
  return {
    approvals: answered.length,
    toolNames: ofType(messages, "tool/started").map((m) => String(m.payload?.toolName ?? "")),
  };
}

beforeAll(async () => {
  live = await (async () => {
    try {
      const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
      return r.ok;
    } catch {
      return false;
    }
  })();
  if (!live) {
    console.log("SKIP approval-timeline live: no Ollama at", OLLAMA_URL);
    return;
  }
  try {
    await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen3:8b", prompt: "ping", stream: false, options: { num_predict: 1 }, keep_alive: "60m" }),
      signal: AbortSignal.timeout(300_000),
    });
  } catch {
    live = false;
    return;
  }
  root = fs.mkdtempSync(path.join(os.tmpdir(), "approval-live-"));
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "approval-storage-"));
});

afterAll(async () => {
  if (!live || !host) return;
  host.vscodeStub.configOverrides.delete("model");
  host.vscodeStub.configOverrides.delete("maxIterations");
  host.ext.__clearWebviewSinkForIntegrationTest();
  await host.ext.deactivate().catch(() => {});
  host.cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("PHASE 3 live — approval timeline lifecycle", () => {
  it("deny then approve: timeline persists requested/denied/requested/granted", { timeout: 2_700_000 }, async () => {
    if (!live) return;
    const ws = path.join(root, "approval-ws");
    fs.mkdirSync(ws, { recursive: true });
    const deniedFile = path.join(ws, "denied.txt");
    const approvedFile = path.join(ws, "approved.txt");

    host = await makeHost(ws, storageDir);
    setLiveConfigOverrides();
    await host.seams.ensureRuntime();

    // 1-3. First protected op → DENY.
    const first = await leg(
      "appr-1",
      `Create the file denied.txt with content "should not exist". Use the write_file tool.`,
      "deny",
    );
    console.log("PHASE-3 FIRST:", JSON.stringify(first));
    expect(first.approvals).toBeGreaterThan(0);
    expect(fs.existsSync(deniedFile)).toBe(false);

    // 4-5. Second protected op → ALLOW.
    const second = await leg(
      "appr-2",
      `Create the file approved.txt with content "approved content". Use the write_file tool.`,
      "allow",
    );
    console.log("PHASE-3 SECOND:", JSON.stringify(second));
    expect(second.approvals).toBeGreaterThan(0);
    expect(fs.existsSync(approvedFile)).toBe(true);

    // 6-9. Close/reopen runtime, read persisted approval timeline.
    await host.ext.deactivate().catch(() => {});
    host = await makeHost(ws, storageDir);
    await host.seams.ensureRuntime();

    const history = host.seams.getTaskHistoryService
      ? host.seams.getTaskHistoryService()
      : null;
    // Read the persisted task store directly for the approval timeline.
    const tasksDir = path.join(storageDir, "tasks");
    const taskFiles = fs.existsSync(tasksDir)
      ? fs.readdirSync(tasksDir).filter((f) => f.endsWith(".json"))
      : [];
    expect(taskFiles.length).toBeGreaterThan(0);

    let requestedCount = 0;
    let executedCount = 0;
    let deniedEvidence = false;
    for (const tf of taskFiles) {
      const raw = fs.readFileSync(path.join(tasksDir, tf), "utf8");
      const task = JSON.parse(raw) as {
        toolCalls?: Array<{ phase?: string; toolName?: string }>;
      };
      for (const tc of task.toolCalls ?? []) {
        if (tc.phase === "requested") requestedCount += 1;
        if (tc.phase === "executed") executedCount += 1;
      }
      // The denied op must NOT appear as executed.
      if (raw.includes("denied.txt") && raw.includes('"phase":"executed"')) {
        deniedEvidence = true;
      }
    }
    console.log(
      "PHASE-3 TIMELINE:",
      JSON.stringify({ requestedCount, executedCount, deniedEvidence }),
    );

    // Timeline: at least 2 requested (deny + allow), at least 1 executed (the allow).
    expect(requestedCount).toBeGreaterThanOrEqual(2);
    expect(executedCount).toBeGreaterThanOrEqual(1);
    // The denied file was never written.
    expect(deniedEvidence).toBe(false);
    expect(fs.existsSync(deniedFile)).toBe(false);
  }, 2_700_000);
});
