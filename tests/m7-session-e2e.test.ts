/**
 * M7 — REAL E2E: tracked terminal session streaming through the production
 * extension host (no Ollama needed).
 *
 * Path proven:
 *   WebView message `terminal/start`
 *   → extension host handler
 *   → M4 pipeline (RiskEngine → PolicyEngine → ApprovalManager; the test
 *     plays the user by resolving `tool/request_approval` with
 *     `tool/approval_result`)
 *   → TerminalSessionManager.start → TerminalSession spawn (real node child)
 *   → terminal.* events → manager fan-out → extension `terminal/output`
 *   → captured WebView sink.
 *
 * THE authoritative streaming proof at the FULL-STACK level: the timestamp
 * of the first `terminal/output` message is strictly BEFORE the timestamp of
 * the completion `terminal/result` message. No polling anywhere.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-m7-e2e-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * Play the user for terminal approvals: resolve every terminal-ish approval
 * card with `allow` until `stopWhen` fires. Resolves through the REAL
 * `tool/approval_result` message path.
 */
async function playTerminalApprovals(
  host: FreshHost,
  messages: CapturedMessage[],
  stopWhen: () => boolean,
): Promise<number> {
  const seen = new Set<string>();
  let allowed = 0;
  const terminalIds = ["bash", "run_commands", "run_command", "execute_command", "terminal"];
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
      await host.seams.handleMessage({
        type: "tool/approval_result",
        id: `approve-${Date.now()}`,
        payload: { approvalId, decision: "allow" },
        timestamp: Date.now(),
      });
      allowed += 1;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  return allowed;
}

/**
 * Play the user for terminal approvals with a bounded wait (denies nothing;
 * only terminal-ish tools are ever allowed).
 */
async function playTerminalApprovalsUntil(
  host: FreshHost,
  messages: CapturedMessage[],
  waitMs: number,
): Promise<number> {
  const deadline = Date.now() + waitMs;
  return playTerminalApprovals(host, messages, () => Date.now() > deadline);
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

describe("M7 session streaming — full-stack E2E", () => {
  it(
    "terminal/start → M4 → real process → terminal/output streams BEFORE completion",
    { timeout: 60_000 },
    async () => {
      const host = await freshHost();
      keepHost = host;
      const messages: CapturedMessage[] = [];
      host.ext.__setWebviewSinkForIntegrationTest((m) =>
        messages.push(m as CapturedMessage),
      );
      const workspace = makeTempWorkspace();
      void workspace;

      // The child prints three time-separated lines. The node script is
      // embedded base64 and decoded inside an eval wrapper — the b64 payload
      // survives any shell quoting (the raw script's parentheses do not).
      const nodeScript = [
        "process.stdout.write('E2E-1\\n');",
        "setTimeout(() => process.stdout.write('E2E-2\\n'), 250);",
        "setTimeout(() => process.stdout.write('E2E-3\\n'), 500);",
      ].join("");
      const b64 = Buffer.from(nodeScript, "utf8").toString("base64");
      const command = `node -e "eval(Buffer.from('${b64}','base64').toString('utf8'))"`;

      // Start a tracked session through the REAL message handler.
      host.seams.handleMessage({
        type: "terminal/start",
        id: `m7-e2e-${Date.now()}`,
        payload: { command },
        timestamp: Date.now(),
      });

      // Play the user: M4 asks for execute_command (high-risk → ASK) BEFORE
      // the session spawns. Approvals run until the session starts streaming.
      let streaming = false;
      const approvalsPromise = playTerminalApprovals(host, messages, () => streaming);

      // First streamed chunk through the WebView sink (sessionId-scoped).
      const firstChunk = await waitFor(
        () => {
          const found = messages.find(
            (m) =>
              m.type === "terminal/output" &&
              (m.payload as Record<string, unknown> | undefined)?.["sessionId"],
          ) as CapturedMessage | undefined;
          if (found) streaming = true;
          return found;
        },
        20_000,
        "first terminal/output for a tracked session",
      );
      await approvalsPromise;
      const sessionId = String(firstChunk.payload?.["sessionId"]);
      expect(sessionId).toBeTruthy();

      // Session card + lifecycle updates arrive on terminal/result.
      const startedCard = await waitFor(
        () =>
          messages.find(
            (m) =>
              m.type === "terminal/result" &&
              (m.payload as Record<string, unknown> | undefined)?.["session"] &&
              ((m.payload as Record<string, unknown>)["session"] as Record<string, unknown>)[
                "id"
              ] === sessionId,
          ) as CapturedMessage | undefined,
        10_000,
        "terminal/result start card",
      );
      expect(startedCard).toBeTruthy();

      // The completion event for THIS session (exit/cancelled/timeout).
      const completion = await waitFor(
        () =>
          messages.find(
            (m) =>
              m.type === "terminal/result" &&
              (m.payload as Record<string, unknown> | undefined)?.["sessionId"] ===
                sessionId &&
              ["terminal.exit", "terminal.cancelled", "terminal.timeout"].includes(
                String((m.payload as Record<string, unknown>)["event"]),
              ),
          ) as CapturedMessage | undefined,
        20_000,
        "terminal/result lifecycle completion",
      );

      // THE PROOF: streamed output strictly precedes completion.
      const firstChunkAt = firstChunk.timestamp ?? 0;
      const completionAt = completion.timestamp ?? Number.MAX_SAFE_INTEGER;
      expect(firstChunkAt).toBeGreaterThan(0);
      expect(firstChunkAt).toBeLessThan(completionAt);

      // All streamed output for this session arrived (via events, not polling).
      const chunks = messages.filter(
        (m) =>
          m.type === "terminal/output" &&
          (m.payload as Record<string, unknown>)?.["sessionId"] === sessionId,
      );
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      const seqs = chunks.map((m) => Number((m.payload as Record<string, unknown>)["seq"]));
      for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
      const data = chunks
        .map((m) => String((m.payload as Record<string, unknown>)["data"]))
        .join("");
      expect(data).toContain("E2E-1");
      expect(data).toContain("E2E-2");
      expect(data).toContain("E2E-3");

      // The WebView validator accepts every captured chunk (boundary contract).
      const { validateTerminalOutput } = await import("../apps/webview/src/lib/messages");
      for (const chunk of chunks) {
        expect(validateTerminalOutput(chunk.payload)).not.toBeNull();
      }

      // Status + history through the real handler paths.
      host.seams.handleMessage({
        type: "terminal/status",
        id: `m7-status-${Date.now()}`,
        payload: {},
        timestamp: Date.now(),
      });
      const statusResult = await waitFor(
        () =>
          messages.find((m) => m.type === "terminal/status_result") as
            | CapturedMessage
            | undefined,
        10_000,
        "terminal/status_result",
      );
      const sessions = (statusResult!.payload as Record<string, unknown>)["sessions"] as
        | Array<Record<string, unknown>>
        | undefined;
      expect(Array.isArray(sessions)).toBe(true);
      const mine = sessions!.find((s) => s["id"] === sessionId);
      expect(mine).toBeDefined();

      host.seams.handleMessage({
        type: "terminal/history",
        id: `m7-history-${Date.now()}`,
        payload: {},
        timestamp: Date.now(),
      });
      const historyResult = await waitFor(
        () =>
          messages.find((m) => m.type === "terminal/history_result") as
            | CapturedMessage
            | undefined,
        10_000,
        "terminal/history_result",
      );
      const history = (historyResult!.payload as Record<string, unknown>)["history"] as
        | Array<Record<string, unknown>>
        | undefined;
      const record = history?.find((h) => h["sessionId"] === sessionId);
      expect(record).toBeDefined();
      expect(String(record!["command"])).toContain("node");
      expect(String(record!["stdoutTail"])).toContain("E2E-1");

      void approvalsPromise;
      host.ext.__clearWebviewSinkForIntegrationTest();
    },
  );

  it(
    "M4 denial: a denied session start produces NO session and NO output",
    { timeout: 45_000 },
    async () => {
      const host = await freshHost();
      const messages: CapturedMessage[] = [];
      host.ext.__setWebviewSinkForIntegrationTest((m) =>
        messages.push(m as CapturedMessage),
      );

      host.seams.handleMessage({
        type: "terminal/start",
        id: `m7-deny-${Date.now()}`,
        payload: { command: "node -e \"process.stdout.write('should-not-run')\"" },
        timestamp: Date.now(),
      });
      // Deny every approval card for this host.
      const deadline = Date.now() + 8_000;
      const seen = new Set<string>();
      while (Date.now() < deadline) {
        for (const m of messages) {
          if (m.type !== "tool/request_approval") continue;
          const approvalId = (m.payload as Record<string, unknown> | undefined)?.[
            "approvalId"
          ];
          if (typeof approvalId !== "string" || seen.has(approvalId)) continue;
          seen.add(approvalId);
          void host.seams
            .handleMessage({
              type: "tool/approval_result",
              id: `deny-${Date.now()}`,
              payload: { approvalId, decision: "deny" },
              timestamp: Date.now(),
            })
            .catch(() => {});
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 500));

      const sessions = messages.filter(
        (m) =>
          m.type === "terminal/result" &&
          (m.payload as Record<string, unknown> | undefined)?.["session"],
      );
      expect(sessions).toHaveLength(0);
      const outputs = messages.filter((m) => m.type === "terminal/output");
      expect(outputs).toHaveLength(0);
      host.ext.__clearWebviewSinkForIntegrationTest();
    },
  );

  it(
    "cancellation through terminal/stop terminates the process and emits terminal.cancelled once",
    { timeout: 45_000 },
    async () => {
      const host = await freshHost();
      const messages: CapturedMessage[] = [];
      host.ext.__setWebviewSinkForIntegrationTest((m) =>
        messages.push(m as CapturedMessage),
      );
      const workspace = makeTempWorkspace();

      const command =
        "node -e \"process.stdout.write('C-1\\n'); setTimeout(() => process.stdout.write('C-2\\n'), 8000);\"";
      host.seams.handleMessage({
        type: "terminal/start",
        id: `m7-cancel-${Date.now()}`,
        payload: { command },
        timestamp: Date.now(),
      });
      // Allow the terminal approval (M4 ASK path), then wait for C-1.
      let streaming = false;
      const approvalsPromise = playTerminalApprovals(host, messages, () => streaming);
      const firstChunk = await waitFor(
        () => {
          const found = messages.find(
            (m) =>
              m.type === "terminal/output" &&
              String((m.payload as Record<string, unknown> | undefined)?.["data"]).includes(
                "C-1",
              ),
          ) as CapturedMessage | undefined;
          if (found) streaming = true;
          return found;
        },
        20_000,
        "first chunk C-1",
      );
      await approvalsPromise;
      const sessionId = String(firstChunk.payload?.["sessionId"]);

      // Cancel through the REAL stop handler.
      host.seams.handleMessage({
        type: "terminal/stop",
        id: `m7-stop-${Date.now()}`,
        payload: { sessionId },
        timestamp: Date.now(),
      });
      const cancelled = await waitFor(
        () =>
          messages.find(
            (m) =>
              m.type === "terminal/result" &&
              (m.payload as Record<string, unknown> | undefined)?.["sessionId"] ===
                sessionId &&
              String((m.payload as Record<string, unknown>)["event"]) ===
                "terminal.cancelled",
          ) as CapturedMessage | undefined,
        15_000,
        "terminal.cancelled lifecycle event",
      );
      expect(cancelled).toBeTruthy();
      // Exactly one cancelled event for this session.
      const cancelCount = messages.filter(
        (m) =>
          m.type === "terminal/result" &&
          (m.payload as Record<string, unknown> | undefined)?.["sessionId"] ===
            sessionId &&
          String((m.payload as Record<string, unknown>)["event"]) === "terminal.cancelled",
      ).length;
      expect(cancelCount).toBe(1);
      // The second (8s-delayed) line never streamed.
      const lateData = messages.find(
        (m) =>
          m.type === "terminal/output" &&
          String((m.payload as Record<string, unknown> | undefined)?.["data"]).includes(
            "C-2",
          ),
      );
      expect(lateData).toBeUndefined();
      host.ext.__clearWebviewSinkForIntegrationTest();
    },
  );
});
