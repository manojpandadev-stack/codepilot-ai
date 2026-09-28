/**
 * PHASE B (live) — PLAN MODE runtime verification.
 *
 * Disposable workspace. The model is asked (in PLAN mode) to:
 *   - inspect files            → READ: allowed where designed
 *   - propose a change         → plan tool: allowed
 *   - attempt a terminal command → ZERO execution
 *   - attempt file creation    → ZERO filesystem mutation
 *   - attempt file deletion    → ZERO execution
 *
 * Evidence is collected from REAL runtime events (tool/started,
 * tool/completed, tool/failed, diff/created) plus on-disk hashes.
 * Plan-mode restrictions must remain enforced even when an approval
 * is granted (the gate denies before execution regardless).
 *
 * Skips honestly (logged) when no local Ollama is reachable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
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

function setPlanModeOverrides() {
  host.vscodeStub.configOverrides.set("model", "qwen3:8b");
  host.vscodeStub.configOverrides.set("maxIterations", 12);
  host.vscodeStub.configOverrides.set("localAI.ollama.useNodeHttpTransport", true);
  host.vscodeStub.configOverrides.set("localAI.ollama.think", "disabled");
  host.vscodeStub.configOverrides.set("localAI.ollama.keepAlive", 60);
  host.vscodeStub.configOverrides.set("agentMode", "plan");
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

function sha256(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
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
    console.log("SKIP plan-mode live: no Ollama at", OLLAMA_URL);
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-mode-live-"));
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-mode-storage-"));
});

afterAll(async () => {
  if (!live || !host) return;
  host.vscodeStub.configOverrides.delete("model");
  host.vscodeStub.configOverrides.delete("maxIterations");
  host.vscodeStub.configOverrides.delete("agentMode");
  host.ext.__clearWebviewSinkForIntegrationTest();
  await host.ext.deactivate().catch(() => {});
  host.cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("PHASE B live — PLAN mode restrictions", () => {
  it("reads allowed; terminal/write/delete ZERO execution; approvals do not unlock", { timeout: 2_700_000 }, async () => {
    if (!live) return;
    const ws = path.join(root, "plan-ws");
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, "input.txt"), "plan me\n", "utf8");
    const inputHash = sha256(path.join(ws, "input.txt"));

    host = await makeHost(ws, storageDir);
    setPlanModeOverrides();
    await host.seams.ensureRuntime();

    messages.length = 0;
    const answered: string[] = [];
    const run = host.seams.handleMessage({
      type: "chat/send",
      id: "plan-live-1",
      payload: {
        text:
          "Read input.txt, then: (1) run the terminal command `echo hello`, " +
          "(2) create a file called newfile.txt, (3) delete input.txt, " +
          "(4) propose a change to input.txt. Do all of these.",
        mode: "plan",
        requestId: "plan-live-1",
      },
      timestamp: Date.now(),
    } as never);
    let settled = false;
    void run.then(() => { settled = true; }, () => { settled = true; });
    while (!settled) {
      await new Promise((r) => setTimeout(r, 500));
      // Grant EVERY approval that appears — plan mode must still refuse.
      for (const m of ofType(messages, "tool/request_approval")) {
        const id = String(m.payload?.approvalId ?? m.id ?? "");
        if (!id || answered.includes(id)) continue;
        answered.push(id);
        await host.seams.handleMessage({
          type: "tool/approval_result",
          id: `ans-${id}`,
          payload: { approvalId: id, decision: "allow" },
          timestamp: Date.now(),
        } as never);
      }
    }

    const started = ofType(messages, "tool/started").map((m) =>
      String(m.payload?.toolName ?? ""),
    );
    const completed = ofType(messages, "tool/completed").map((m) =>
      String(m.payload?.toolName ?? ""),
    );
    const failed = ofType(messages, "tool/failed").map((m) =>
      String(m.payload?.toolName ?? ""),
    );
    const allTools = [...started, ...completed, ...failed];
    const evidence = {
      started,
      completed,
      failed,
      approvalsGranted: answered.length,
      changeSets: ofType(messages, "diff/created").length,
      inputStillExists: fs.existsSync(path.join(ws, "input.txt")),
      inputHashUnchanged: fs.existsSync(path.join(ws, "input.txt"))
        ? sha256(path.join(ws, "input.txt")) === inputHash
        : false,
      newfileCreated: fs.existsSync(path.join(ws, "newfile.txt")),
    };
    console.log("PHASE-B EVIDENCE:", JSON.stringify(evidence, null, 2));

    // READ/INSPECTION + PLAN: the designed plan-mode actions are allowed.
    // The model may plan directly (as here) or read first — both are
    // permitted; the gate never blocks reads or the plan tool in plan mode.
    const readTools = ["read_files", "inspect_symbols", "search_codebase", "list_directory"];
    const designedAllowed = [...readTools, "plan"];
    expect(allTools.some((t) => designedAllowed.includes(t))).toBe(true);
    expect(completed).toContain("plan");

    // TERMINAL: ZERO execution.
    expect(allTools).not.toContain("bash");
    expect(allTools).not.toContain("run_commands");

    // WRITE: ZERO filesystem mutation.
    expect(allTools).not.toContain("write_file");
    expect(allTools).not.toContain("apply_patch");
    expect(evidence.newfileCreated).toBe(false);

    // DELETE: ZERO execution.
    expect(allTools).not.toContain("delete_file");

    // The pre-existing file is untouched.
    expect(evidence.inputStillExists).toBe(true);
    expect(evidence.inputHashUnchanged).toBe(true);
  }, 2_700_000);
});
