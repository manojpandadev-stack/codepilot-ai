/**
 * LIVE qwen2.5-coder:3b tool-calling behavior — the exact production path:
 *
 *   seams.runPrompt (real sendPromptToAgent)
 *     → CodePilotRuntime.startSession (real singleton)
 *     → native agent engine → Ollama HTTP /api/chat (real, live model)
 *     → tool dispatch → M4 approval (real webview flow, auto-answered
 *       through the REAL tool/approval_result handler) → execution
 *     → tool results → final answer → captured webview messages
 *
 * Three prompts, each in ACT mode on a temp workspace:
 *   1. read the safe file `tool-live-notes.txt` and report its first line
 *   2. "Run node --version using the terminal."
 *   3. create tool-test.txt containing TOOL_OK (write path, M4-approved,
 *      then applied through the REAL diff/accept_all webview handler)
 *
 * HONESTY CONTRACT: assertions are on PIPELINE facts only (run completed,
 * whether a STRUCTURED tool call occurred, what executed). Model WORDING is
 * never asserted. Every prompt records a per-prompt observation printed as
 * JSON, so the report is accurate whether or not this small model emits
 * structured tool calls. A prose-only answer is a PASSING test that records
 * structuredToolCallOccurred:false — exactly the reliability signal this
 * suite measures over time.
 *
 * Skips (honestly logged, never faked) when no local Ollama is reachable.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FreshHost } from "./vscode-integration-harness";

const OLLAMA_URL = "http://127.0.0.1:11434";
const LIVE_TIMEOUT = 600_000;

interface CapturedMessage {
  type: string;
  id?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

interface Observation {
  model: string;
  mode: string;
  prompt: string;
  structuredToolCallOccurred: boolean;
  toolNames: string[];
  m4ApprovalAppeared: boolean;
  executionResults: string[];
  finalResponse: string;
  elapsedMs: number;
}

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

function skipLog(test: string): void {
  console.log(`SKIP live Ollama (${test}): no server at ${OLLAMA_URL}`);
}

const ofType = (msgs: CapturedMessage[], type: string): CapturedMessage[] =>
  msgs.filter((m) => m.type === type);

/**
 * Live host with a TEMP WORKSPACE: the stub's workspaceFolders is set BEFORE
 * extension activation so the M4 pipeline and the runtime both bind to it.
 * Mirrors the harness's freshHost() with that one hook in between.
 */
async function liveHost(
  workspaceRoot: string,
): Promise<{ host: FreshHost; messages: CapturedMessage[] } | null> {
  if (!(await ollamaReachable())) return null;
  const { vi } = await import("vitest");
  vi.resetModules();
  const vscodeStub = await import("vscode");
  vscodeStub.workspace.workspaceFolders.length = 0;
  vscodeStub.workspace.workspaceFolders.push({ uri: { fsPath: workspaceRoot } });
  const ext = await import("../apps/vscode-extension/src/extension");
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-live3b-"));
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
  const messages: CapturedMessage[] = [];
  ext.__setWebviewSinkForIntegrationTest((m) => {
    messages.push(m as CapturedMessage);
  });
  const host = {
    ext,
    seams: ext.__integrationSeams,
    vscodeStub,
    storageDir,
    tasksDir: path.join(storageDir, "tasks"),
    auditDir: path.join(storageDir, "audit"),
    auditFile: path.join(storageDir, "audit", "tool-audit.jsonl"),
    cleanup: () => fs.rmSync(storageDir, { recursive: true, force: true }),
  } as unknown as FreshHost;
  return { host, messages };
}

/** Observe ONE live prompt end-to-end and print the honest evidence JSON. */
async function observePrompt(
  host: FreshHost,
  messages: CapturedMessage[],
  prompt: string,
): Promise<Observation> {
  const started = Date.now();
  messages.length = 0; // observations cover only this prompt

  const run = host.seams.runPrompt(prompt, "act");
  let runSettled = false;
  void run.then(
    () => {
      runSettled = true;
    },
    () => {
      runSettled = true;
    },
  );

  // Auto-answer M4 approval cards through the REAL webview handler.
  const seenApprovals = new Set<string>();
  while (!runSettled) {
    await new Promise((r) => setTimeout(r, 500));
    for (const m of ofType(messages, "tool/request_approval")) {
      const approvalId = String(m.payload?.approvalId ?? m.id ?? "");
      if (!approvalId || seenApprovals.has(approvalId)) continue;
      seenApprovals.add(approvalId);
      await host.seams.handleMessage({
        type: "tool/approval_result",
        id: `ans-${approvalId}`,
        payload: { approvalId, decision: "allow" },
        timestamp: Date.now(),
      } as never);
    }
  }

  const toolStarted = ofType(messages, "tool/started");
  const toolCompleted = ofType(messages, "tool/completed");
  const toolFailed = ofType(messages, "tool_failed");
  const deltas = ofType(messages, "chat/stream_delta");
  const finalResponse =
    deltas
      .map((m) => String(m.payload?.accumulated ?? ""))
      .sort((a, b) => b.length - a.length)[0] ?? "";

  const observation: Observation = {
    model: "qwen2.5-coder:3b",
    mode: "act",
    prompt,
    structuredToolCallOccurred: toolStarted.length > 0,
    toolNames: toolStarted.map((m) => String(m.payload?.toolName ?? "")),
    m4ApprovalAppeared: seenApprovals.size > 0,
    executionResults: [
      ...toolCompleted.map(
        (m) =>
          `${m.payload?.toolName}: ${String(m.payload?.output ?? "").slice(0, 160)}`,
      ),
      ...toolFailed.map(
        (m) =>
          `FAILED ${m.payload?.toolName}: ${String(m.payload?.error ?? "").slice(0, 160)}`,
      ),
    ],
    finalResponse: finalResponse.slice(0, 400),
    elapsedMs: Date.now() - started,
  };
  console.log("LIVE-3B OBSERVATION:", JSON.stringify(observation, null, 2));
  return observation;
}

describe("LIVE qwen2.5-coder:3b tool-calling behavior", () => {
  it("read / terminal / create prompts through the real production path", { timeout: LIVE_TIMEOUT }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phase12-ws-"));
    const lh = await liveHost(dir);
    if (!lh) {
      skipLog("qwen2.5-coder:3b behavior");
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }
    const { host, messages } = lh;
    try {
      // Pin the model BEFORE the runtime singleton is created.
      host.vscodeStub.configOverrides.set("model", "qwen2.5-coder:3b");
      await host.seams.ensureRuntime();

      // ---- Test 1: file read -------------------------------------------
      fs.writeFileSync(
        path.join(dir, "tool-live-notes.txt"),
        "FIRST-LINE-MARKER-9137\nsecond line\n",
        "utf8",
      );
      const obs1 = await observePrompt(
        host,
        messages,
        "Read the file tool-live-notes.txt and tell me its first line.",
      );

      // ---- Test 2: terminal --------------------------------------------
      const obs2 = await observePrompt(
        host,
        messages,
        "Run node --version using the terminal.",
      );

      // ---- Test 3: create a file (write path) ---------------------------
      const obs3 = await observePrompt(
        host,
        messages,
        "Create a file named tool-test.txt containing exactly the text TOOL_OK.",
      );

      // Apply the latest staged ChangeSet through the REAL webview command,
      // exactly as the user's Changes-tab button does.
      const changeSetId = String(ofType(messages, "diff/created").at(-1)?.payload?.changeSetId ?? "");
      let applied = 0;
      if (changeSetId) {
        messages.length = 0;
        await host.seams.handleMessage({
          type: "diff/accept_all",
          id: "apply-1",
          payload: { changeSetId },
          timestamp: Date.now(),
        } as never);
        applied = Number(ofType(messages, "diff/result").at(-1)?.payload?.applied ?? 0);
      }

      // ---- PIPELINE assertions (never model wording) --------------------
      expect(obs1.finalResponse.length > 0).toBe(true);
      expect(obs2.finalResponse.length > 0).toBe(true);
      expect(obs3.finalResponse.length > 0).toBe(true);

      const created = path.join(dir, "tool-test.txt");
      if (changeSetId && applied > 0) {
        expect(fs.readFileSync(created, "utf8")).toContain("TOOL_OK");
      }

      console.log(
        "LIVE-3B SUMMARY:",
        JSON.stringify(
          {
            read: { toolCall: obs1.structuredToolCallOccurred, tools: obs1.toolNames, elapsedMs: obs1.elapsedMs },
            terminal: { toolCall: obs2.structuredToolCallOccurred, tools: obs2.toolNames, elapsedMs: obs2.elapsedMs },
            create: {
              toolCall: obs3.structuredToolCallOccurred,
              tools: obs3.toolNames,
              staged: changeSetId || null,
              applied,
              elapsedMs: obs3.elapsedMs,
            },
          },
          null,
          2,
        ),
      );
    } finally {
      host.vscodeStub.configOverrides.delete("model");
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate().catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
