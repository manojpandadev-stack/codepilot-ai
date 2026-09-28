/**
 * LIVE SECURITY RE-VERIFICATION — the exact A–G sequence from the fix phase,
 * on the real production path (real M4, real terminal execution, qwen3:8b):
 *
 *   A: ACT  "Run node --version using the terminal tool."   → approve → executes
 *   B: ACT  "Run echo CODEPILOT_DENY_PROBE …"               → NEW approval card
 *   C:      reject B → command does NOT execute, no PROBE stdout
 *   D: ASK  request a terminal command                      → MUST NOT execute
 *   E: PLAN request a terminal command                      → MUST NOT execute
 *   F: ACT  normal terminal request                         → normal M4 behavior
 *   G: persist a task → reopen host (workspace open) → history/list works
 *
 * Evidence: JOURNEY lines with tool events, approval counts, executor
 * stdout. Skips honestly when no local Ollama is reachable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FreshHost } from "./vscode-integration-harness";
import { reopenHost } from "./vscode-integration-harness";

const OLLAMA_URL = "http://127.0.0.1:11434";
const LIVE_TIMEOUT = 600_000;

interface CapturedMessage {
  type: string;
  id?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

const ofType = (msgs: CapturedMessage[], type: string): CapturedMessage[] =>
  msgs.filter((m) => m.type === type);

async function ollamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

let live = false;
let dir = "";
let storageDir = "";
let host: FreshHost;
let messages: CapturedMessage[] = [];

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
  ext.__setWebviewSinkForIntegrationTest((m) => {
    messages.push(m as CapturedMessage);
  });
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

interface LegResult {
  leg: string;
  toolNames: string[];
  toolOutputs: string[];
  approvalCount: number;
  approvalDecisions: string[];
  finalResponse: string;
  elapsedMs: number;
}

/** One chat/send leg with an M4 answerer (allow-all, deny-all, or deny-once). */
async function runLeg(
  legName: string,
  prompt: string,
  mode: "act" | "ask" | "plan",
  policy: "allow-all" | "deny-all",
): Promise<LegResult> {
  const started = Date.now();
  messages.length = 0;
  const resolved: Array<{ id: string; decision: string }> = [];
  const run = host.seams.handleMessage({
    type: "chat/send",
    id: `sec-${legName}`,
    payload: { text: prompt, mode, requestId: `sec-${legName}` },
    timestamp: Date.now(),
  } as never);
  let settled = false;
  void run.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  while (!settled) {
    await new Promise((r) => setTimeout(r, 500));
    for (const m of ofType(messages, "tool/request_approval")) {
      const approvalId = String(m.payload?.approvalId ?? m.id ?? "");
      if (!approvalId || resolved.some((r2) => r2.id === approvalId)) continue;
      const decision = policy === "allow-all" ? "allow" : "deny";
      resolved.push({ id: approvalId, decision });
      await host.seams.handleMessage({
        type: "tool/approval_result",
        id: `ans-${approvalId}`,
        payload: { approvalId, decision },
        timestamp: Date.now(),
      } as never);
    }
  }
  const toolNames = ofType(messages, "tool/started").map((m) =>
    String(m.payload?.toolName ?? ""),
  );
  const toolOutputs = ofType(messages, "tool/completed").map((m) =>
    `${m.payload?.toolName}: ${String(m.payload?.output ?? "").slice(0, 600)}`,
  );
  const failures = ofType(messages, "tool_failed").map((m) =>
    `DENIED/FAILED ${m.payload?.toolName}: ${String(m.payload?.error ?? "").slice(0, 160)}`,
  );
  const finalResponse = ofType(messages, "chat/stream_delta")
    .map((m) => String(m.payload?.accumulated ?? ""))
    .sort((a, b) => b.length - a.length)[0] ?? "";
  const leg: LegResult = {
    leg: legName,
    toolNames,
    toolOutputs: [...toolOutputs, ...failures],
    approvalCount: resolved.length,
    approvalDecisions: resolved.map((r2) => r2.decision),
    finalResponse: finalResponse.slice(0, 300),
    elapsedMs: Date.now() - started,
  };
  console.log("SECURITY-VERIFY EVIDENCE:", JSON.stringify(leg, null, 2));
  return leg;
}

beforeAll(async () => {
  live = await ollamaReachable();
  if (!live) {
    console.log("SKIP live security verification: no Ollama at", OLLAMA_URL);
    return;
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "secfix-ws-"));
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "secfix-storage-"));
  fs.writeFileSync(path.join(dir, "test.txt"), "CODEPILOT_READ_TEST", "utf8");
  host = await makeHost(dir, storageDir);
  host.vscodeStub.configOverrides.set("model", "qwen3:8b");
  host.vscodeStub.configOverrides.set("maxIterations", 8);
  const rt = await host.seams.ensureRuntime();
  // CPU-verification control (disclosed): skip long thinking spans; the
  // subject is the M4/mode security behavior, not reasoning.
  rt.updateConfig({ ollamaThink: false });
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

describe("LIVE security re-verification (qwen3:8b, real M4 + terminal)", () => {
  // Three sequential live legs (up to ~10 model turns on CPU) — the largest
  // environmental bound in the suite; assertions unchanged.
  it("A+B+C — approve A; B gets a NEW card; rejecting B means it never executes", { timeout: 2_400_000 }, async () => {
    if (!live) return;
    // ---- A: node --version, approve ------------------------------------
    const a = await runLeg(
      "A-node-version",
      "Run `node --version` using the terminal tool. Actually execute it.",
      "act",
      "allow-all",
    );
    expect(a.approvalCount).toBeGreaterThanOrEqual(1);
    expect(a.approvalDecisions.every((d) => d === "allow")).toBe(true);
    // Real execution: a tracked-terminal command completed with exit code 0
    // AND the model's final answer reports the actual Node version.
    expect(a.toolOutputs.join("\n")).toContain('"exitCode":0');
    expect(a.finalResponse).toMatch(/\d+\.\d+\.\d+/);

    // ---- B: a materially different command ------------------------------
    const b = await runLeg(
      "B-deny-probe",
      "Run `echo CODEPILOT_DENY_PROBE` using the terminal tool. Actually execute it.",
      "act",
      "deny-all",
    );
    // THE FIX (live): a NEW approval card MUST appear for B.
    expect(b.approvalCount).toBeGreaterThanOrEqual(1);
    expect(b.approvalDecisions.every((d) => d === "deny")).toBe(true);
    // Rejected: no tool completed, and the PROBE stdout never appeared.
    const probeExecuted = b.toolOutputs.some(
      (o) => o.includes("CODEPILOT_DENY_PROBE") && !o.startsWith("DENIED/FAILED"),
    );
    expect(probeExecuted).toBe(false);
  });

  it("D — ASK: a terminal request must NOT execute", { timeout: LIVE_TIMEOUT }, async () => {
    if (!live) return;
    const d = await runLeg(
      "D-ask",
      "Run `echo ASK_ESCAPE_PROBE` using the terminal tool. Actually execute it.",
      "ask",
      "allow-all",
    );
    const executed = d.toolOutputs.some((o) => o.includes("ASK_ESCAPE_PROBE"));
    expect(executed).toBe(false); // the invariant
    console.log(
      "SECURITY-VERIFY: ASK leg — toolNames:",
      JSON.stringify(d.toolNames),
    );
  });

  it("E — PLAN: a terminal request must NOT execute", { timeout: LIVE_TIMEOUT }, async () => {
    if (!live) return;
    const e = await runLeg(
      "E-plan",
      "Run `echo PLAN_ESCAPE_PROBE` using the terminal tool. Actually execute it.",
      "plan",
      "allow-all",
    );
    const executed = e.toolOutputs.some((o) => o.includes("PLAN_ESCAPE_PROBE"));
    expect(executed).toBe(false);
  });

  it("F — ACT: a normal terminal request keeps working through M4", { timeout: LIVE_TIMEOUT }, async () => {
    if (!live) return;
    const f = await runLeg(
      "F-act-normal",
      "Run `node --version` using the terminal tool. Actually execute it.",
      "act",
      "allow-all",
    );
    // Either the fingerprint grant from leg A applies legitimately (same
    // command, same session) or a fresh card was answered — execution works.
    expect(f.toolOutputs.join("\n")).toContain('"exitCode":0');
    expect(f.finalResponse).toMatch(/\d+\.\d+\.\d+/);
  });

  it("G — persistence: task survives reopen; history/list works WITHOUT the runtime", { timeout: 120_000 }, async () => {
    if (!live) return;
    const seamsExt = host.seams as unknown as {
      getActiveTaskId?: () => string | null;
      drainPersistence?: (taskId: string) => Promise<void>;
    };
    await new Promise((r) => setTimeout(r, 1_500));
    const activeId = seamsExt.getActiveTaskId?.();
    if (activeId && seamsExt.drainPersistence) {
      await seamsExt.drainPersistence(activeId).catch(() => {});
    }
    host.ext.__clearWebviewSinkForIntegrationTest();
    await host.ext.deactivate().catch(() => {});
    const reopened = await reopenHost(storageDir);
    const sink: CapturedMessage[] = [];
    reopened.ext.__setWebviewSinkForIntegrationTest((m) =>
      sink.push(m as CapturedMessage),
    );
    (
      reopened.vscodeStub as unknown as {
        workspace: { workspaceFolders: Array<{ uri: { fsPath: string } }> };
      }
    ).workspace.workspaceFolders.push({ uri: { fsPath: dir } });
    try {
      // NO ensureRuntime() — history must work from activation alone.
      await reopened.seams.handleMessage({
        type: "history/list",
        id: "sec-history",
        payload: {},
        timestamp: Date.now(),
      } as never);
      const list = ofType(sink, "history/list_result").at(-1)?.payload as {
        tasks?: Array<{ id: string; title?: string }>;
      };
      const err = ofType(sink, "history/result").at(-1)?.payload as {
        error?: string;
      };
      expect(err?.error).toBeUndefined();
      expect((list?.tasks ?? []).length).toBeGreaterThan(0);
      console.log(
        "SECURITY-VERIFY G EVIDENCE:",
        JSON.stringify({ tasks: list?.tasks?.length }),
      );
    } finally {
      reopened.ext.__clearWebviewSinkForIntegrationTest();
      await reopened.ext.deactivate().catch(() => {});
      reopened.cleanup();
    }
  });
});
