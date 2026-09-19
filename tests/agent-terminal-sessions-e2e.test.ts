/**
 * Agent-initiated tracked terminal sessions — REAL full-stack E2E through
 * the production extension host.
 *
 * Path proven per test:
 *   agent tool call (AgentTool.execute, conversationId-scoped)
 *     → TerminalSessionManager (agent container, ownership enforced)
 *     → per-command M4 (REAL pipeline: RiskEngine → PolicyEngine →
 *       ApprovalManager → SecurityValidator; the test plays the user via
 *       `tool/approval_result`)
 *     → TerminalSession (REAL node child process)
 *     → terminal.* events → manager fan-out → extension `terminal/output`
 *     → captured WebView sink.
 *
 * The timestamp proof: streamed `terminal/output` messages arrive strictly
 * BEFORE the command completes (result built after the final event).
 */
import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { freshHost, type FreshHost } from "./vscode-integration-harness";

interface CapturedMessage {
  type: string;
  id?: string;
  payload?: Record<string, unknown>;
  timestamp?: number;
  [key: string]: unknown;
}

let keepHost: FreshHost | null = null;
const tempDirs: string[] = [];

afterAll(async () => {
  if (keepHost) {
    await keepHost.ext.deactivate().catch(() => {});
    keepHost = null;
  }
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows: recently-killed children can hold a cwd briefly.
    }
  }
});

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-ats-e2e-"));
  tempDirs.push(dir);
  return dir;
}

/** The owning agent conversation (ownership key for every tool call). */
const CONVERSATION_ID = "e2e-conversation-1";

/** Build the five agent tools from the live extension seams. */
function getTools(host: FreshHost) {
  const tools = host.seams.getAgentTerminalSessionTools();
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    start: byName.get("terminal_session_start")!,
    exec: byName.get("terminal_session_exec")!,
    status: byName.get("terminal_session_status")!,
    stop: byName.get("terminal_session_stop")!,
    close: byName.get("terminal_session_close")!,
  };
}

/** Native-shaped tool context for ownership. */
function ctx(signal: AbortSignal) {
  return {
    agentId: "e2e-agent",
    conversationId: CONVERSATION_ID,
    signal,
  };
}

/** base64-embedded node script (survives any shell quoting on Windows). */
function nodeCommand(lines: string[], gapMs = 250): string {
  // Chain one timer per gap so EVERY marker is separated from the next by
  // gapMs: OS pipe reads then observe one chunk per marker instead of
  // coalescing back-to-back writes into a single chunk (the previous shape
  // gapped only the first marker, which made per-exec chunk counts
  // timing-fragile under parallel load).
  let script = `process.stdout.write(${JSON.stringify(lines[lines.length - 1]! + "\n")});`;
  for (let i = lines.length - 2; i >= 0; i--) {
    script =
      `process.stdout.write(${JSON.stringify(lines[i]! + "\n")});` +
      `setTimeout(()=>{${script}},${gapMs});`;
  }
  const b64 = Buffer.from(script, "utf8").toString("base64");
  return `node -e "eval(Buffer.from('${b64}','base64').toString('utf8'))"`;
}

/**
 * Play the user: resolve every pending execute_command-ish approval card via
 * the REAL `tool/approval_result` message path. `decision` selects the
 * user's answer; stops when `stopWhen` fires.
 */
async function playApprovals(
  host: FreshHost,
  messages: CapturedMessage[],
  decision: "allow" | "deny",
  stopWhen: () => boolean,
): Promise<number> {
  const seen = new Set<string>();
  let count = 0;
  const terminalIds = [
    "bash",
    "run_commands",
    "run_command",
    "execute_command",
    "terminal",
    "kill_process",
  ];
  while (!stopWhen()) {
    for (const m of messages) {
      if (m.type !== "tool/request_approval") continue;
      const p = (m.payload ?? {}) as Record<string, unknown>;
      const approvalId = p["approvalId"];
      if (typeof approvalId !== "string" || seen.has(approvalId)) continue;
      seen.add(approvalId);
      const toolId = String(p["toolId"] ?? p["action"] ?? "");
      const isTerminal =
        terminalIds.includes(toolId) || terminalIds.some((t) => toolId.includes(t));
      if (!isTerminal) continue;
      void host.seams
        .handleMessage({
          type: "tool/approval_result",
          id: `approve-${Date.now()}-${count}`,
          payload: { approvalId, decision },
          timestamp: Date.now(),
        })
        .catch(() => {});
      count += 1;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  return count;
}

/** Bounded variant that plays the user for `waitMs`. */
function playApprovalsFor(
  host: FreshHost,
  messages: CapturedMessage[],
  decision: "allow" | "deny",
  waitMs: number,
): Promise<number> {
  const deadline = Date.now() + waitMs;
  return playApprovals(host, messages, decision, () => Date.now() > deadline);
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
    await new Promise((r) => setTimeout(r, 30));
  }
}

describe("agent tracked terminal sessions — full-stack E2E", () => {
  it(
    "start → exec×3 in ONE session → streaming BEFORE completion → history → close",
    { timeout: 120_000 },
    async () => {
      const host = await freshHost();
      keepHost = host;
      const messages: CapturedMessage[] = [];
      host.ext.__setWebviewSinkForIntegrationTest((m) =>
        messages.push(m as CapturedMessage),
      );
      void makeTempWorkspace();
      const tools = getTools(host);

      // 1. START — creates the container (no process, no approval needed).
      const started = (await tools.start.execute(
        {},
        ctx(new AbortController().signal),
      )) as Record<string, unknown>;
      expect(started["ok"]).toBe(true);
      const sessionId = String(started["sessionId"]);
      expect(sessionId).toBeTruthy();

      // 2. EXEC #1 — real process; the M4 pipeline asks (execute_command is
      // high-risk → ASK) and the test plays the user with "allow".
      const command1 = nodeCommand(["ATS-1", "ATS-2", "ATS-3"], 300);
      const sinkChunks: Array<{ data: string; at: number }> = [];
      const r1Promise = tools.exec.execute(
        { sessionId, command: command1 },
        ctx(new AbortController().signal),
      ) as Promise<Record<string, unknown>>;
      let streaming = false;
      const approvals = playApprovals(host, messages, "allow", () => streaming);

      const firstChunk = await waitFor(
        () => {
          const found = messages.find(
            (m) =>
              m.type === "terminal/output" &&
              (m.payload as Record<string, unknown> | undefined)?.["sessionId"] ===
                sessionId &&
              String(
                (m.payload as Record<string, unknown>)["data"] ?? "",
              ).includes("ATS-1"),
          ) as CapturedMessage | undefined;
          if (found) {
            streaming = true;
            sinkChunks.push({
              data: String((found.payload as Record<string, unknown>)["data"]),
              at: found.timestamp ?? 0,
            });
          }
          return found;
        },
        30_000,
        "first streamed ATS-1 chunk",
      );
      expect(firstChunk).toBeTruthy();
      await approvals;

      // 3. EXEC #2 and #3 — same session, sequential; approvals auto-played.
      const play2 = playApprovalsFor(host, messages, "allow", 15_000);
      const r2 = (await tools.exec.execute(
        { sessionId, command: "echo SECOND-CMD" },
        ctx(new AbortController().signal),
      )) as Record<string, unknown>;
      expect(r2["ok"]).toBe(true);
      expect(String(r2["stdout"])).toContain("SECOND-CMD");
      const play3 = playApprovalsFor(host, messages, "allow", 15_000);
      const r3 = (await tools.exec.execute(
        { sessionId, command: "echo THIRD-CMD" },
        ctx(new AbortController().signal),
      )) as Record<string, unknown>;
      expect(r3["ok"]).toBe(true);
      expect(String(r3["stdout"])).toContain("THIRD-CMD");

      const r1 = await r1Promise;
      expect(r1["ok"]).toBe(true);
      expect(String(r1["stdout"])).toContain("ATS-1");
      expect(String(r1["stdout"])).toContain("ATS-3");
      expect(r1["commandId"]).toBeTruthy();
      expect(r1["index"]).toBe(1);
      expect(r2["index"]).toBe(2);
      expect(r3["index"]).toBe(3);
      // All three share the sessionId.
      expect(r1["sessionId"]).toBe(sessionId);
      expect(r2["sessionId"]).toBe(sessionId);
      expect(r3["sessionId"]).toBe(sessionId);

      // THE STREAMING PROOF (full stack): the ATS-1 chunk message timestamp
      // is strictly BEFORE exec#1's completedAt (result built at completion).
      const firstAt = sinkChunks[0].at;
      expect(firstAt).toBeGreaterThan(0);
      expect(firstAt).toBeLessThan(Number(r1["completedAt"]));

      // All streamed chunks for this session carry correlation + monotonic seq.
      const chunks = messages.filter(
        (m) =>
          m.type === "terminal/output" &&
          (m.payload as Record<string, unknown>)?.["sessionId"] === sessionId,
      );
      expect(chunks.length).toBeGreaterThanOrEqual(3);
      // Sequence is monotonic PER COMMAND (executionId = commandId; each
      // command is its own TerminalSession with its own TerminalSequence).
      const byExec = new Map<string, number[]>();
      for (const m of chunks) {
        const p = m.payload as Record<string, unknown>;
        const execId = String(p["executionId"]);
        byExec.set(execId, [...(byExec.get(execId) ?? []), Number(p["seq"])]);
      }
      for (const seqList of byExec.values()) {
        for (let i = 1; i < seqList.length; i++) {
          expect(seqList[i]).toBeGreaterThan(seqList[i - 1]);
        }
      }
      // exec#1 streamed through at least 3 chunks (ATS-1..3).
      const exec1 = [...byExec.entries()].find(([, seqs]) => seqs.length >= 3);
      expect(exec1).toBeTruthy();
      // taskId correlation = the owning conversation.
      expect(
        new Set(
          chunks.map((m) => (m.payload as Record<string, unknown>)["taskId"]),
        ),
      ).toEqual(new Set([CONVERSATION_ID]));

      // 4. STATUS — bounded per-command history inside the session.
      const status = (await tools.status.execute(
        { sessionId },
        ctx(new AbortController().signal),
      )) as Record<string, unknown>;
      expect(status["ok"]).toBe(true);
      expect(status["commandCount"]).toBe(3);
      const cmds = status["commands"] as Array<Record<string, unknown>>;
      expect(cmds.map((c) => c.index)).toEqual([1, 2, 3]);

      // 5. CLOSE — session rejects further commands.
      const closed = (await tools.close.execute(
        { sessionId },
        ctx(new AbortController().signal),
      )) as Record<string, unknown>;
      expect(closed["ok"]).toBe(true);
      const afterClose = await tools.exec.execute(
        { sessionId, command: "echo after-close" },
        ctx(new AbortController().signal),
      );
      expect((afterClose as Record<string, unknown>)["ok"]).toBe(false);

      host.ext.__clearWebviewSinkForIntegrationTest();
    },
  );

  it(
    "ownership: another conversation CANNOT use the session; denial yields structured M4_DENIED",
    { timeout: 90_000 },
    async () => {
      const host = await freshHost();
      keepHost = host;
      const messages: CapturedMessage[] = [];
      host.ext.__setWebviewSinkForIntegrationTest((m) =>
        messages.push(m as CapturedMessage),
      );
      const tools = getTools(host);

      const started = (await tools.start.execute(
        {},
        ctx(new AbortController().signal),
      )) as Record<string, unknown>;
      const sessionId = String(started["sessionId"]);

      // Foreign conversation: exec / status / close all fail closed.
      const foreignCtx = {
        agentId: "other-agent",
        conversationId: "e2e-conversation-2",
        signal: new AbortController().signal,
      };
      const foreignExec = (await tools.exec.execute(
        { sessionId, command: "echo hijack" },
        foreignCtx,
      )) as Record<string, unknown>;
      expect(foreignExec["ok"]).toBe(false);
      expect(String(foreignExec["error"])).toContain("different task");
      const foreignStatus = (await tools.status.execute(
        { sessionId },
        foreignCtx,
      )) as Record<string, unknown>;
      expect(foreignStatus["ok"]).toBe(false);
      const foreignClose = (await tools.close.execute(
        { sessionId },
        foreignCtx,
      )) as Record<string, unknown>;
      expect(foreignClose["ok"]).toBe(false);
      // Owner's view is unaffected.
      const ownerStatus = (await tools.status.execute(
        { sessionId },
        ctx(new AbortController().signal),
      )) as Record<string, unknown>;
      expect(ownerStatus["ok"]).toBe(true);

      // Per-command M4 denial through the REAL pipeline: the user DENIES the
      // approval card → structured M4_DENIED, no process, session usable.
      const playDeny = playApprovalsFor(host, messages, "deny", 12_000);
      const denied = (await tools.exec.execute(
        { sessionId, command: "echo DENIED-CMD" },
        ctx(new AbortController().signal),
      )) as Record<string, unknown>;
      expect(denied["ok"]).toBe(false);
      expect(String(denied["code"])).toBe("M4_DENIED");
      await playDeny;
      // No history entry, no output for the denied command.
      const status2 = (await tools.status.execute(
        { sessionId },
        ctx(new AbortController().signal),
      )) as Record<string, unknown>;
      expect(status2["commandCount"]).toBe(0);
      const deniedOutput = messages.filter(
        (m) =>
          m.type === "terminal/output" &&
          String((m.payload as Record<string, unknown> | undefined)?.["data"] ?? "").includes(
            "DENIED-CMD",
          ),
      );
      expect(deniedOutput).toHaveLength(0);

      // The session still works after a denial (next command can run).
      const playAllow = playApprovalsFor(host, messages, "allow", 12_000);
      const ok = (await tools.exec.execute(
        { sessionId, command: "echo AFTER-DENY-OK" },
        ctx(new AbortController().signal),
      )) as Record<string, unknown>;
      expect(ok["ok"]).toBe(true);
      await playAllow;

      host.ext.__clearWebviewSinkForIntegrationTest();
    },
  );
});
