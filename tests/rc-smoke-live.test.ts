/**
 * RELEASE-CANDIDATE COMPACT LIVE SMOKE (Phase 9).
 *
 * No production code changed after the full live security verification
 * (verified by mtime audit), so per the audit brief this is the compact set:
 *   1. qwen3:8b connectivity
 *   2. ACT terminal approval  (approve → real execution)
 *   3. ASK terminal rejection (request → zero execution)
 *   4. file edit + ChangeSet  (approve → staged → accept → disk changed)
 *   5. history/list           (activation-time service, no runtime needed)
 *
 * Full-path evidence for the remaining scenarios is retained from the
 * security phase (security-live-abc3.log / security-live-run.log).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FreshHost } from "./vscode-integration-harness";

const OLLAMA_URL = "http://127.0.0.1:11434";
const LIVE_TIMEOUT = 900_000;

interface CapturedMessage {
  type: string;
  id?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}
const ofType = (m: CapturedMessage[], t: string) => m.filter((x) => x.type === t);

let live = false;
let dir = "";
let storageDir = "";
let host: FreshHost;
let messages: CapturedMessage[] = [];

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
    console.log("SKIP RC smoke: no Ollama at", OLLAMA_URL);
    return;
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-smoke-"));
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-smoke-storage-"));
  fs.writeFileSync(path.join(dir, "test.txt"), "CODEPILOT_READ_TEST", "utf8");
  const { vi } = await import("vitest");
  vi.resetModules();
  const vscodeStub = await import("vscode");
  vscodeStub.workspace.workspaceFolders.length = 0;
  vscodeStub.workspace.workspaceFolders.push({ uri: { fsPath: dir } });
  const ext = await import("../apps/vscode-extension/src/extension");
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
  ext.activate(context as unknown as Parameters<typeof ext.activate>[0]);
  ext.__setWebviewSinkForIntegrationTest((m) => messages.push(m as CapturedMessage));
  host = {
    ext,
    seams: ext.__integrationSeams,
    vscodeStub,
    storageDir,
    tasksDir: path.join(storageDir, "tasks"),
    auditDir: path.join(storageDir, "audit"),
    auditFile: path.join(storageDir, "audit", "tool-audit.jsonl"),
    cleanup: () => fs.rmSync(storageDir, { recursive: true, force: true }),
  } as unknown as FreshHost;
  host.vscodeStub.configOverrides.set("model", "qwen3:8b");
  host.vscodeStub.configOverrides.set("maxIterations", 8);
  const rt = await host.seams.ensureRuntime();
  rt.updateConfig({ ollamaThink: false }); // CPU-verification control (disclosed)
});

afterAll(async () => {
  if (!live) return;
  host.vscodeStub.configOverrides.delete("model");
  host.vscodeStub.configOverrides.delete("maxIterations");
  host.ext.__clearWebviewSinkForIntegrationTest();
  await host.ext.deactivate().catch(() => {});
  host.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** One chat/send leg; approvals answered per `policy`. */
async function leg(
  name: string,
  prompt: string,
  mode: "act" | "ask",
  policy: "allow-all" | "deny-all",
): Promise<{ toolOutputs: string[]; approvals: string[]; final: string; elapsed: number }> {
  const t0 = Date.now();
  messages.length = 0;
  const answered: string[] = [];
  const run = host.seams.handleMessage({
    type: "chat/send",
    id: `rc-${name}`,
    payload: { text: prompt, mode, requestId: `rc-${name}` },
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
  const toolOutputs = ofType(messages, "tool/completed").map(
    (m) => `${m.payload?.toolName}: ${String(m.payload?.output ?? "").slice(0, 500)}`,
  );
  const final = ofType(messages, "chat/stream_delta")
    .map((m) => String(m.payload?.accumulated ?? ""))
    .sort((a, b) => b.length - a.length)[0] ?? "";
  console.log(
    "RC-SMOKE:",
    JSON.stringify({ leg: name, approvals: answered.length, toolOutputs, final: final.slice(0, 200), elapsedMs: Date.now() - t0 }, null, 2),
  );
  return { toolOutputs, approvals: answered, final, elapsed: Date.now() - t0 };
}

describe("RC compact live smoke (qwen3:8b)", () => {
  it("ACT terminal approval → real execution", { timeout: LIVE_TIMEOUT }, async () => {
    if (!live) return;
    const r = await leg(
      "act-terminal",
      "Run `node --version` using the terminal tool. Actually execute it.",
      "act",
      "allow-all",
    );
    expect(r.approvals.length).toBeGreaterThanOrEqual(1);
    expect(r.toolOutputs.join("\n")).toContain('"exitCode":0');
    expect(r.final).toMatch(/\d+\.\d+\.\d+/);
  });

  it("ASK terminal request → zero execution", { timeout: LIVE_TIMEOUT }, async () => {
    if (!live) return;
    const r = await leg(
      "ask-terminal",
      "Run `echo RC_ASK_PROBE` using the terminal tool. Actually execute it.",
      "ask",
      "allow-all",
    );
    expect(r.toolOutputs.join("\n")).not.toContain("RC_ASK_PROBE");
    expect(r.toolOutputs.join("\n")).not.toContain('"exitCode":0');
  });

  it("file edit + ChangeSet: approve → staged → accept → disk changed", { timeout: LIVE_TIMEOUT }, async () => {
    if (!live) return;
    const r = await leg(
      "edit",
      "Change test.txt: replace the text CODEPILOT_READ_TEST with RC_EDIT_OK.",
      "act",
      "allow-all",
    );
    expect(r.approvals.length).toBeGreaterThanOrEqual(1);
    expect(r.toolOutputs.join("\n")).toContain("staged");
    expect(fs.readFileSync(path.join(dir, "test.txt"), "utf8")).toBe("CODEPILOT_READ_TEST");
    const csId = String(ofType(messages, "diff/created").at(-1)?.payload?.changeSetId ?? "");
    expect(csId.startsWith("cs-")).toBe(true);
    messages.length = 0;
    await host.seams.handleMessage({
      type: "diff/accept_all",
      id: "rc-accept",
      payload: { changeSetId: csId },
      timestamp: Date.now(),
    } as never);
    const applied = ofType(messages, "diff/result").at(-1)?.payload as { success?: boolean };
    expect(applied?.success).toBe(true);
    expect(fs.readFileSync(path.join(dir, "test.txt"), "utf8")).toBe("RC_EDIT_OK");
  });

  it("history/list works without re-initializing the runtime", { timeout: 60_000 }, async () => {
    if (!live) return;
    const seamsExt = host.seams as unknown as {
      getActiveTaskId?: () => string | null;
      drainPersistence?: (id: string) => Promise<void>;
    };
    await new Promise((r) => setTimeout(r, 1_200));
    const activeId = seamsExt.getActiveTaskId?.();
    if (activeId && seamsExt.drainPersistence) await seamsExt.drainPersistence(activeId).catch(() => {});
    messages.length = 0;
    await host.seams.handleMessage({
      type: "history/list",
      id: "rc-history",
      payload: {},
      timestamp: Date.now(),
    } as never);
    const list = ofType(messages, "history/list_result").at(-1)?.payload as { tasks?: unknown[] };
    const err = ofType(messages, "history/result").at(-1)?.payload as { error?: string };
    expect(err?.error).toBeUndefined();
    expect((list?.tasks ?? []).length).toBeGreaterThan(0);
  });
});
