/**
 * PHASE 2 (live) — FILE DELETION through the REAL production pipeline.
 *
 * Disposable workspace with three files: temporary.txt (the deletion
 * target), keeper.txt and config.json (untouched neighbors, hash-pinned).
 * The model is asked in ACT mode to delete temporary.txt. Two legs:
 *
 *   A. APPROVE  → delete_file staged → ChangeSet → accept → file ABSENT,
 *                 neighbors byte-identical (SHA-256 pinned before/after)
 *   B. REJECT   → delete_file staged → approval DENIED → file REMAINS,
 *                 neighbors byte-identical
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
const LEG_TIMEOUT = 2_700_000;

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

function sha256(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/** One chat/send leg with a per-leg approval policy. */
async function leg(legName: string, prompt: string, policy: "allow-all" | "deny-all") {
  messages.length = 0;
  const answered: string[] = [];
  const run = host.seams.handleMessage({
    type: "chat/send",
    id: `del-${legName}`,
    payload: { text: prompt, mode: "act", requestId: `del-${legName}` },
    timestamp: Date.now(),
  } as never);
  let settled = false;
  void run.then(() => { settled = true; }, () => { settled = true; });
  while (!settled) {
    await new Promise((r) => setTimeout(r, 500));
    for (const m of ofType(messages, "tool/request_approval")) {
      const id = String(m.payload?.approvalId ?? m.id ?? "");
      if (!id || answered.includes(id)) continue;
      answered.push(id);
      await host.seams.handleMessage({
        type: "tool/approval_result",
        id: `ans-${id}`,
        payload: { approvalId: id, decision: policy === "allow-all" ? "allow" : "deny" },
        timestamp: Date.now(),
      } as never);
    }
  }
  const toolNames = ofType(messages, "tool/started").map((m) => String(m.payload?.toolName ?? ""));
  const csIds = [...new Set(ofType(messages, "diff/created").map((m) => String(m.payload?.changeSetId ?? "")))];
  return { toolNames, approvals: answered.length, csIds };
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
    console.log("SKIP deletion live legs: no Ollama at", OLLAMA_URL);
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "deletion-live-"));
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "deletion-storage-"));
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

describe("P2 live — ACT-mode file deletion (approve & reject paths)", () => {
  it("A. APPROVE: delete_file staged → accepted → file absent, neighbors byte-identical", { timeout: LEG_TIMEOUT }, async () => {
    if (!live) return;
    const ws = path.join(root, "delete-approve");
    fs.mkdirSync(path.join(ws, "sandbox", "delete-test"), { recursive: true });
    fs.writeFileSync(path.join(ws, "sandbox", "delete-test", "temporary.txt"), "disposable content v1\n", "utf8");
    fs.writeFileSync(path.join(ws, "sandbox", "delete-test", "keeper.txt"), "keep me exact\n", "utf8");
    fs.writeFileSync(path.join(ws, "sandbox", "delete-test", "config.json"), "{}\n", "utf8");
    const target = path.join(ws, "sandbox", "delete-test", "temporary.txt");
    const keeperHash = sha256(path.join(ws, "sandbox", "delete-test", "keeper.txt"));
    const configHash = sha256(path.join(ws, "sandbox", "delete-test", "config.json"));

    host = await makeHost(ws, storageDir);
    setLiveConfigOverrides();
    await host.seams.ensureRuntime();

    const r = await leg(
      "approve",
      "Delete the file sandbox/delete-test/temporary.txt. It is a disposable scratch file — remove it from the project.",
      "allow-all",
    );
    console.log("P2-A EVIDENCE:", JSON.stringify(r, null, 2));
    expect(r.toolNames).toContain("delete_file");
    expect(r.csIds.length).toBeGreaterThan(0);

    // Accept through the REAL webview path.
    for (const csId of r.csIds) {
      messages.length = 0;
      await host.seams.handleMessage({
        type: "diff/accept_all",
        id: `p2a-accept-${csId}`,
        payload: { changeSetId: csId },
        timestamp: Date.now(),
      } as never);
    }

    expect(fs.existsSync(target)).toBe(false);
    expect(sha256(path.join(ws, "sandbox", "delete-test", "keeper.txt"))).toBe(keeperHash);
    expect(sha256(path.join(ws, "sandbox", "delete-test", "config.json"))).toBe(configHash);
  }, LEG_TIMEOUT);

  it("B. REJECT: denial leaves the file untouched and neighbors byte-identical", { timeout: LEG_TIMEOUT }, async () =>
    {
    if (!live) return;
    const ws = path.join(root, "delete-reject");
    fs.mkdirSync(path.join(ws, "sandbox", "delete-test"), { recursive: true });
    fs.writeFileSync(path.join(ws, "sandbox", "delete-test", "temporary.txt"), "disposable content v2\n", "utf8");
    fs.writeFileSync(path.join(ws, "sandbox", "delete-test", "keeper.txt"), "keep me exact too\n", "utf8");
    const target = path.join(ws, "sandbox", "delete-test", "temporary.txt");
    const beforeHash = sha256(target);
    const keeperHash = sha256(path.join(ws, "sandbox", "delete-test", "keeper.txt"));

    host = await makeHost(ws, storageDir);
    setLiveConfigOverrides();
    await host.seams.ensureRuntime();

    const r = await leg(
      "reject",
      "Delete the file sandbox/delete-test/temporary.txt. It is a disposable scratch file — remove it from the project.",
      "deny-all",
    );
    console.log("P2-B EVIDENCE:", JSON.stringify(r, null, 2));
    expect(r.toolNames).toContain("delete_file");

    // No accept is performed — but also assert nothing landed on disk.
    expect(fs.existsSync(target)).toBe(true);
    expect(sha256(target)).toBe(beforeHash);
    expect(sha256(path.join(ws, "sandbox", "delete-test", "keeper.txt"))).toBe(keeperHash);
  }, LEG_TIMEOUT);
});
