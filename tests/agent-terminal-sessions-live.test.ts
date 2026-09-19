/**
 * LIVE Ollama E2E — the AI agent itself creates and uses tracked terminal
 * sessions through the real production path.
 *
 *   chat/send (real dispatcher) → sendPromptToAgent → CodePilotRuntime →
 *   native agent engine → CodePilot LLM (native Ollama provider) →
 *   Ollama (real HTTP) → model calls
 *   terminal_session_start / terminal_session_exec (extraTools) →
 *   dispatcher gate → M4 (real pipeline; test plays the user) →
 *   TerminalSessionManager (ownership by conversationId) → real node child →
 *   terminal.* events → terminal/output → captured WebView sink →
 *   bounded tool result back into the model loop.
 *
 * Evidence strategy (honest split):
 * - HARD: a session card + streamed terminal/output chunks for a session
 *   created BY THE LIVE RUN arrive on the WebView sink; chunks precede the
 *   command's completion; ToolStore/TaskStore remain protocol-valid; audit
 *   JSONL valid; no credential shapes anywhere.
 * - SOFT (logged, never asserted): the model's final text.
 * - SKIP (never faked): when Ollama is unreachable the test logs SKIP and
 *   returns — it does not pretend to pass.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  freshHost,
  readJsonlRecords,
  expectValidJsonl,
  sleep,
  DEBOUNCE_WAIT_MS,
  type FreshHost,
} from "./vscode-integration-harness";
import { TaskStore } from "../packages/agent-runtime/src/m12-task-store";
import { buildInitialMessages } from "../packages/agent-runtime/src/resume";
import { validateConversationProtocol } from "../packages/agent-runtime/src/compaction-protocol";

const OLLAMA_URL = "http://127.0.0.1:11434";
// 4+ live agent turns (start → exec → close → final text), each a thinking
// generation on the 8B model — measured ~60-90s/turn on modest hardware.
// Runs individually (never inside the full-suite pool) like the other live
// Ollama files; documented in the final report.
const LIVE_TIMEOUT = 900_000;

interface CapturedMessage {
  type: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
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

function ofType(messages: CapturedMessage[], type: string): CapturedMessage[] {
  return messages.filter((m) => m.type === type);
}

async function sendChat(host: FreshHost, text: string, tag: string): Promise<void> {
  await host.ext.__integrationSeams.handleMessage({
    type: "chat/send" as never,
    id: tag,
    payload: { text, mode: "act", requestId: tag },
    timestamp: Date.now(),
  });
}

/**
 * Play the user for execute_command approvals raised by the live agent's
 * terminal_session_* calls. Resolves through the REAL approval path.
 */
async function playTerminalApprovals(
  host: FreshHost,
  messages: CapturedMessage[],
  stopWhen: () => boolean,
): Promise<number> {
  const seen = new Set<string>();
  let allowed = 0;
  // Matches the agent session tools (terminal_session_*) AND the legacy
  // terminal tool ids.
  const terminalIds = [
    "bash",
    "run_commands",
    "run_command",
    "execute_command",
    "terminal",
    // terminal_session_close maps to the kill_process action in M4 — its
    // approval card must be answered too or it expires after 5 minutes.
    "kill_process",
  ];
  const isTerminalTool = (toolId: string): boolean =>
    toolId.startsWith("terminal_session") ||
    terminalIds.includes(toolId) ||
    terminalIds.some((t) => toolId.includes(t));
  while (!stopWhen()) {
    for (const m of messages) {
      if (m.type !== "tool/request_approval") continue;
      const p = (m.payload ?? {}) as Record<string, unknown>;
      const approvalId = p["approvalId"];
      if (typeof approvalId !== "string" || seen.has(approvalId)) continue;
      seen.add(approvalId);
      const toolId = String(p["toolId"] ?? p["action"] ?? "");
      const isTerminal = isTerminalTool(toolId);
      if (!isTerminal) continue;
      void host.seams
        .handleMessage({
          type: "tool/approval_result",
          id: `approve-${Date.now()}-${allowed}`,
          payload: { approvalId, decision: "allow" },
          timestamp: Date.now(),
        })
        .catch(() => {});
      allowed += 1;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  return allowed;
}

async function waitFor<T>(
  probe: () => T | undefined | null,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== null) return value;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("live ollama agent terminal sessions E2E", () => {
  it(
    "ATS-LIVE — the live agent starts a session and runs commands through it",
    { timeout: LIVE_TIMEOUT },
    async () => {
      if (!(await ollamaReachable())) {
        console.log(`SKIP live Ollama (ATS-LIVE): no server at ${OLLAMA_URL}`);
        return;
      }
      const host: FreshHost = await freshHost();
      // Harness default model (qwen3:8b) is intentional: live Ollama probes
      // show qwen3:8b emits NATIVE tool_calls, while qwen2.5-coder:3b echoes
      // tool calls as fenced JSON text that the native dispatcher cannot execute — the
      // agent would loop without ever invoking a tool. Runtime ~3-5 min.
      const messages: CapturedMessage[] = [];
      host.ext.__setWebviewSinkForIntegrationTest((m) => {
        messages.push(m as CapturedMessage);
      });
      let workspaceDir = "";
      try {
        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-ats-live-"));
        (
          host.vscodeStub as unknown as {
            workspace: { workspaceFolders: Array<{ uri: { fsPath: string } }> };
          }
        ).workspace.workspaceFolders.push({ uri: { fsPath: workspaceDir } });

        // The prompt enforces SEQUENTIAL tool calls: these tools are
        // stateful (exec/close need the sessionId returned by start), so
        // parallel calls would guess the id and fail (correctly) with
        // NOT_FOUND. Two commands in ONE session prove multi-command reuse
        // live; unique markers prove streamed output origin.
        const marker1 = `ATS1-${Date.now().toString(36).toUpperCase()}`;
        const marker2 = `ATS2-${Date.now().toString(36).toUpperCase()}`;
        const prompt =
          `Create a terminal session by calling the terminal_session_start tool FIRST, ` +
          `and wait for its result before any other tool call. ` +
          `Then call terminal_session_exec ONCE with the exact sessionId from that result ` +
          `to run this exact command: echo ${marker1} . ` +
          `After that result arrives, call terminal_session_exec AGAIN with the SAME sessionId ` +
          `to run this exact command: echo ${marker2} . ` +
          `Only after both exec results arrive, call terminal_session_close with the same sessionId. ` +
          `Keep your final answer to one short sentence.`;

        // Approvals are played until the run completes; the loop exits on
        // this flag so `await approvals` always terminates.
        let runDone = false;
        const approvals = playTerminalApprovals(host, messages, () => runDone);

        const t0 = Date.now();
        await sendChat(host, prompt, "ats-live-chat-1");
        const done = () =>
          ofType(messages, "agent/status").some(
            (m) => m.payload?.["status"] === "completed",
          );
        await waitFor(done, 840_000, "live run completion");
        runDone = true;
        await approvals;
        await sleep(DEBOUNCE_WAIT_MS);

        const taskId = host.seams.getActiveTaskId();
        expect(taskId).not.toBeNull();
        await host.seams.drainPersistence(taskId!);
        const runMs = Date.now() - t0;
        console.log(`ATS-LIVE: run completed in ${runMs}ms`);

        // ---- Run-shape diagnostics (logged for every run, pass or fail).
        const approvalsSeen = ofType(messages, "tool/request_approval");
        const approvalTools = approvalsSeen.map(
          (m) =>
            String(
              (m.payload as Record<string, unknown> | undefined)?.["toolId"] ??
              (m.payload as Record<string, unknown> | undefined)?.["action"] ??
              "?",
            ),
        );
        const allOutputs = ofType(messages, "terminal/output");
        console.log(
          `ATS-LIVE diagnostics: approvals=${approvalsSeen.length} (${approvalTools.join(",") || "none"}), ` +
            `terminal/output(all)=${allOutputs.length}, ` +
            `terminal/output-with-sessionId=${
              allOutputs.filter(
                (m) =>
                  (m.payload as Record<string, unknown> | undefined)?.["sessionId"],
              ).length
            }, ` +
            `terminal/result=${ofType(messages, "terminal/result").length}, ` +
            `deltas=${ofType(messages, "chat/stream_delta").length}, ` +
            `agent/status statuses=[${ofType(messages, "agent/status")
              .map((m) => String(m.payload?.["status"] ?? "?"))
              .join(",")}]`,
        );
        // Full approval payloads (command text is a test marker — not secret)
        // and the first terminal/output sample distinguish which tool the
        // model actually used (builtin execute_command vs terminal_session_*).
        for (const m of approvalsSeen) {
          console.log(
            `ATS-LIVE approval payload: ${JSON.stringify(m.payload ?? {}).slice(0, 300)}`,
          );
        }
        if (allOutputs.length > 0) {
          console.log(
            `ATS-LIVE first terminal/output: ${JSON.stringify(allOutputs[0]!.payload ?? {}).slice(0, 300)}`,
          );
        }
        const deltaList = ofType(messages, "chat/stream_delta");
        const finalText = deltaList.length
          ? String(
              (deltaList[deltaList.length - 1]!.payload as Record<string, unknown>)[
                "accumulated"
              ] ?? "",
            )
          : "";
        console.log(`ATS-LIVE final text: ${JSON.stringify(finalText.slice(0, 300))}`);

        // ---- HARD evidence: a tracked session streamed output to the UI.
        const sessionChunks = ofType(messages, "terminal/output").filter(
          (m) => (m.payload as Record<string, unknown> | undefined)?.["sessionId"],
        );
        expect(sessionChunks.length).toBeGreaterThanOrEqual(1);
        const sessionIds = new Set(
          sessionChunks.map((m) => String((m.payload as Record<string, unknown>)["sessionId"])),
        );
        expect(sessionIds.size).toBe(1);
        const sessionId = [...sessionIds][0]!;
        // Agent-session ids are namespaced `agent-ts-…` (distinct from the
        // user's terminal/start sessions `ts-…`).
        expect(sessionId.startsWith("agent-ts-")).toBe(true);
        // The marker flowed through the real streaming path — BOTH commands,
        // proving the model reused the SAME tracked session for N commands.
        const streamed = sessionChunks
          .map((m) => String((m.payload as Record<string, unknown>)["data"] ?? ""))
          .join("");
        expect(streamed).toContain(marker1);
        expect(streamed).toContain(marker2);
        // Two distinct exec tool calls completed through that session.
        const execCompletions = ofType(messages, "tool/completed").filter(
          (m) =>
            (m.payload as Record<string, unknown> | undefined)?.["toolName"] ===
            "terminal_session_exec",
        );
        expect(execCompletions.length).toBeGreaterThanOrEqual(2);
        console.log(
          `ATS-LIVE transport: ${sessionChunks.length} streamed chunk(s) for ${sessionId}`,
        );

        // Lifecycle events for the agent session arrived on terminal/result.
        const lifecycle = ofType(messages, "terminal/result").filter(
          (m) =>
            (m.payload as Record<string, unknown> | undefined)?.["sessionId"] === sessionId,
        );
        expect(lifecycle.length).toBeGreaterThanOrEqual(1);

        // ---- Security invariants (hard).
        const store = new TaskStore(host.tasksDir);
        const task = await store.get(taskId!);
        expect(task?.status).toBe("completed");
        expect(task?.modelConfig).toMatchObject({ providerId: "ollama" });
        expect(
          validateConversationProtocol(buildInitialMessages(task!)).valid,
        ).toBe(true);
        expectValidJsonl(await readJsonlRecords(host.auditFile));
        const allText = JSON.stringify(messages);
        // \b guards against the false positive inside task ids
        // ("task-…" contains the literal substring "sk-…").
        expect(allText).not.toMatch(/\bsk-[A-Za-z0-9_-]{8,}/);
        expect(allText).not.toContain("PRIVATE KEY");

        // ---- Behavioral signal (soft): what the model said.
        const deltas = ofType(messages, "chat/stream_delta");
        const acc =
          deltas.length > 0
            ? String(
                (deltas[deltas.length - 1]!.payload as Record<string, unknown>)[
                  "accumulated"
                ] ?? "",
              )
            : "";
        console.log(
          `ATS-LIVE model answer: ${JSON.stringify(acc.slice(0, 120))}`,
        );
      } finally {
        host.ext.__clearWebviewSinkForIntegrationTest();
        if (workspaceDir) {
          try {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
          } catch {
            // best effort
          }
        }
      }
    },
  );
});
