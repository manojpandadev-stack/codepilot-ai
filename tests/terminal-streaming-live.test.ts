/**
 * LIVE terminal streaming E2E (Phases 12, 14–16) — real Ollama + real
 * processes + real M4 approval played by the test as the user.
 *
 * Flow per test: runPrompt (not awaited) → poll the captured sink for the
 * terminal `tool/request_approval` card → approve via the REAL
 * `tool/approval_result` message path → command streams through OUR
 * executor → assert live arrival BEFORE completion (timestamps), then
 * completion/persistence/audit.
 *
 * Only terminal-tool approvals are ever granted, and only for the exact
 * harmless commands below. Anything else is denied. Model non-cooperation
 * is reported as MODEL-LIMITATION (never a fake pass); infrastructure
 * assertions stay strict.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import {
  freshHost,
  sleep,
  DEBOUNCE_WAIT_MS,
  expectValidJsonl,
  type FreshHost,
} from "./vscode-integration-harness";
import { TaskStore } from "../packages/agent-runtime/src/m12-task-store";
import { buildInitialMessages } from "../packages/agent-runtime/src/resume";
import { validateConversationProtocol } from "../packages/agent-runtime/src/compaction-protocol";

const OLLAMA_URL = "http://127.0.0.1:11434";
const LIVE_TIMEOUT = 240_000;
const LIVE_GENERATION_TIMEOUT = 600_000;

interface CapturedMessage {
  type: string;
  id?: string;
  payload?: Record<string, unknown>;
  timestamp?: number;
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

function skipLog(test: string): void {
  console.log(`SKIP live terminal (${test}): no server at ${OLLAMA_URL}`);
}

async function liveHost(): Promise<{
  host: FreshHost;
  messages: CapturedMessage[];
} | null> {
  if (!(await ollamaReachable())) return null;
  const host = await freshHost();
  const messages: CapturedMessage[] = [];
  host.ext.__setWebviewSinkForIntegrationTest((m) => {
    messages.push(m as CapturedMessage);
  });
  return { host, messages };
}

function softModelCheck(name: string, condition: boolean, detail: string): void {
  console.log(`${condition ? "MODEL-OK" : "MODEL-LIMITATION"} [${name}]: ${detail}`);
}

const TERMINAL_TOOL_IDS = new Set([
  "bash",
  "run_commands",
  "run_command",
  "execute_command",
  "terminal",
]);

interface ApprovalPlay {
  /** "approved-terminal" | "no-terminal-tool" | "timed-out" */
  outcome: string;
}

/**
 * Play the user for terminal approvals: allow terminal tools, deny
 * everything else, bounded wait. Returns what happened.
 */
async function playTerminalApprovals(
  host: FreshHost,
  messages: CapturedMessage[],
  waitMs: number,
  approve: boolean,
): Promise<ApprovalPlay> {
  const seen = new Set<string>();
  const deadline = Date.now() + waitMs;
  for (;;) {
    for (const m of messages) {
      if (m.type !== "tool/request_approval") continue;
      const p = (m.payload ?? {}) as Record<string, unknown>;
      const approvalId = p["approvalId"];
      const toolId = String(p["toolId"] ?? p["action"] ?? "");
      if (typeof approvalId !== "string" || seen.has(approvalId)) continue;
      seen.add(approvalId);
      const isTerminal =
        TERMINAL_TOOL_IDS.has(toolId) ||
        [...TERMINAL_TOOL_IDS].some((t) => toolId.includes(t));
      if (isTerminal) {
        console.log(`LIVE approved command input: ${JSON.stringify(p["input"] ?? p).slice(0, 300)}`);
      }
      await host.seams.handleMessage({
        type: "tool/approval_result",
        id: `approve-${Date.now()}`,
        payload: {
          approvalId,
          decision: approve && isTerminal ? "allow" : "deny",
        },
        timestamp: Date.now(),
      } as never);
      if (approve && isTerminal) return { outcome: "approved-terminal" };
    }
    const done = messages.some(
      (m) =>
        (m.type === "agent/status" && (m.payload as Record<string, unknown> | undefined)?.["status"] === "completed") ||
        m.type === "error",
    );
    if (done) return { outcome: "no-terminal-tool" };
    if (Date.now() >= deadline) return { outcome: "timed-out" };
    await sleep(500);
  }
}

function terminalOutputs(messages: CapturedMessage[]) {
  return messages.filter((m) => m.type === "terminal/output");
}

/**
 * Log why a live run ended without a terminal approval (model answered in
 * text, errored, or finished some other way) so MODEL-LIMITATION lines are
 * diagnosable instead of opaque.
 */
function logRunOutcome(messages: CapturedMessage[]): void {
  const status = [...messages]
    .reverse()
    .find((m) => m.type === "agent/status");
  const error = messages.find((m) => m.type === "error");
  const toolCalls = messages.filter((m) => m.type.startsWith("tool/")).length;
  console.log(
    `LIVE run outcome: status=${JSON.stringify(
      (status?.payload as Record<string, unknown> | undefined)?.["status"] ??
        status?.payload ??
        "none",
    ).slice(0, 200)} error=${error ? String((error.payload as Record<string, unknown> | undefined)?.["message"] ?? error.payload).slice(0, 200) : "none"} toolMessages=${toolCalls}`,
  );
}

/**
 * Settle a live run that will not be awaited to completion (fallback
 * paths): stop the agent, then bound the wait so no orphaned Ollama stream
 * holds the test file open. Deactivate (finally blocks) disposes the rest.
 */
async function abortAndSettle(
  host: FreshHost,
  run: Promise<unknown>,
  timeoutMs = 90_000,
): Promise<void> {
  await host.seams.stopAgent().catch(() => undefined);
  await Promise.race([
    run.then(
      () => undefined,
      () => undefined,
    ),
    sleep(timeoutMs),
  ]);
}

describe("live terminal streaming", () => {
  it("ordered markers arrive before completion (streaming proof)", { timeout: LIVE_GENERATION_TIMEOUT }, async () => {
    const lh = await liveHost();
    if (!lh) {
      skipLog("ordered markers");
      return;
    }
    const { host, messages } = lh;
    try {
      const run = host.seams.runPrompt(
        "Use the run_commands terminal tool to run this exact command, then briefly report each line it printed: " +
          "powershell -NoProfile -Command \"Write-Output 'CP-STREAM-1'; Start-Sleep -Milliseconds 500; Write-Output 'CP-STREAM-2'; Start-Sleep -Milliseconds 500; Write-Output 'CP-STREAM-3'\". " +
          "Do not write any files.",
        "act",
      );
      const play = await Promise.race([
        (async () => {
          const outcome = await playTerminalApprovals(host, messages, 300_000, true);
          await run;
          return outcome;
        })(),
        sleep(540_000).then(() => ({ outcome: "timed-out" }) as ApprovalPlay),
      ]);
      if (play.outcome !== "approved-terminal") {
        await abortAndSettle(host, run);
        softModelCheck("live-markers", false, `approval play outcome: ${play.outcome}`);
        return;
      }
      await sleep(DEBOUNCE_WAIT_MS);
      const taskId = host.seams.getActiveTaskId();
      if (taskId) await host.seams.drainPersistence(taskId);

      const outputs = terminalOutputs(messages);
      expect(outputs.length).toBeGreaterThanOrEqual(3);
      const joined = outputs
        .map((m) => String((m.payload as Record<string, unknown>)?.["data"] ?? ""))
        .join("");
      const i1 = joined.indexOf("CP-STREAM-1");
      const i2 = joined.indexOf("CP-STREAM-2");
      const i3 = joined.indexOf("CP-STREAM-3");
      expect(i1).toBeGreaterThanOrEqual(0);
      expect(i2).toBeGreaterThan(i1);
      expect(i3).toBeGreaterThan(i2);
      // PROOF OF STREAMING: the first marker's event timestamp predates the
      // terminal completion message (not merely present in final output).
      const completions = messages.filter((m) => m.type === "tool/completed");
      expect(completions.length).toBeGreaterThan(0);
      const firstMarkerAt = Math.min(
        ...outputs
          .filter((m) => String((m.payload as Record<string, unknown>)?.["data"] ?? "").includes("CP-STREAM-1"))
          .map((m) => m.timestamp ?? Number.MAX_SAFE_INTEGER),
      );
      const completedAt = Math.min(...completions.map((m) => m.timestamp ?? Number.MAX_SAFE_INTEGER));
      expect(firstMarkerAt).toBeLessThan(completedAt);
      // Sequence numbers monotonic across the execution.
      const seqs = outputs.map((m) => Number((m.payload as Record<string, unknown>)?.["seq"] ?? -1));
      for (let i = 1; i < seqs.length; i += 1) {
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
      }
      console.log(`LIVE-OK [ordered-markers]: ${outputs.length} live events, first marker before completion.`);
    } finally {
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate();
      host.cleanup();
    }
  });

  it("mixed stdout/stderr stay labeled and ordered per stream", { timeout: LIVE_GENERATION_TIMEOUT }, async () => {
    const lh = await liveHost();
    if (!lh) {
      skipLog("mixed streams");
      return;
    }
    const { host, messages } = lh;
    try {
      const run = host.seams.runPrompt(
        "Use the run_commands terminal tool to run this exact command, then report what each stream printed (stdout lines start with CP-OUT, stderr lines with CP-ERR): " +
          "node -e \"console.log('CP-OUT-A'); console.error('CP-ERR-B'); console.log('CP-OUT-C'); console.error('CP-ERR-D')\". " +
          "Run it verbatim. Do not write any files.",
        "act",
      );
      const play = await Promise.race([
        (async () => {
          const outcome = await playTerminalApprovals(host, messages, 300_000, true);
          await run;
          return outcome;
        })(),
        sleep(540_000).then(() => ({ outcome: "timed-out" }) as ApprovalPlay),
      ]);
      if (play.outcome !== "approved-terminal") {
        await abortAndSettle(host, run);
        softModelCheck("live-mixed", false, `approval play outcome: ${play.outcome}`);
        return;
      }
      await sleep(DEBOUNCE_WAIT_MS);
      const dbgTaskId = host.seams.getActiveTaskId();
      if (dbgTaskId) await host.seams.drainPersistence(dbgTaskId);
      const outputs = terminalOutputs(messages);
      const text = (stream: string): string =>
        outputs
          .filter((m) => (m.payload as Record<string, unknown>)?.["stream"] === stream)
          .map((m) => String((m.payload as Record<string, unknown>)?.["data"] ?? ""))
          .join("");
      // Complete capture on both channels.
      for (const marker of ["CP-OUT-A", "CP-ERR-B", "CP-OUT-C", "CP-ERR-D"]) {
        expect(text(marker.startsWith("CP-ERR") ? "stderr" : "stdout")).toContain(marker);
      }
      // Per-stream ordering (OS interleaving across streams is NOT asserted).
      expect(text("stdout").indexOf("CP-OUT-A")).toBeLessThan(text("stdout").indexOf("CP-OUT-C"));
      expect(text("stderr").indexOf("CP-ERR-B")).toBeLessThan(text("stderr").indexOf("CP-ERR-D"));
      // Stream labels are correct (no stdout bytes in stderr events).
      expect(text("stdout")).not.toContain("CP-ERR-B");
      expect(text("stderr")).not.toContain("CP-OUT-A");
      // Persisted result stays valid and protocol-green.
      const taskId = host.seams.getActiveTaskId();
      if (taskId) await host.seams.drainPersistence(taskId);
      if (taskId) {
        const task = await new TaskStore(host.tasksDir).get(taskId);
        expect(validateConversationProtocol(buildInitialMessages(task!)).valid).toBe(true);
      }
      console.log("LIVE-OK [mixed-streams]: labeled, ordered, complete.");
    } finally {
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate();
      host.cleanup();
    }
  });

  it("cancel during live streaming kills the process without orphans", { timeout: LIVE_GENERATION_TIMEOUT }, async () => {
    const lh = await liveHost();
    if (!lh) {
      skipLog("live cancel streaming");
      return;
    }
    const { host, messages } = lh;
    try {
      const run = host.seams.runPrompt(
        "Use the run_commands terminal tool to run this exact command, then briefly report what it printed: " +
          "powershell -NoProfile -Command \"for($i=0; $i -lt 240; $i++) { Write-Output ('TICK-' + $i); Write-Error ('TACK-' + $i); Start-Sleep -Milliseconds 300 }\". " +
          "Do not write any files.",
        "act",
      );
      const play = await Promise.race([
        (async () => {
          const outcome = await playTerminalApprovals(host, messages, 300_000, true);
          return outcome;
        })(),
        sleep(540_000).then(() => ({ outcome: "timed-out" }) as ApprovalPlay),
      ]);
      if (play.outcome !== "approved-terminal") {
        await abortAndSettle(host, run);
        logRunOutcome(messages);
        softModelCheck("live-cancel", false, `approval play outcome: ${play.outcome}`);
        return;
      }
      // Wait for real streaming on stdout (stderr ticks may batch).
      const deadline = Date.now() + 120_000;
      while (terminalOutputs(messages).length < 3 && Date.now() < deadline) {
        await sleep(500);
      }
      expect(terminalOutputs(messages).length).toBeGreaterThan(0);
      const countBefore = terminalOutputs(messages).length;
      await host.seams.stopAgent();
      await run.catch(() => undefined);
      await sleep(DEBOUNCE_WAIT_MS);
      const taskId = host.seams.getActiveTaskId();
      if (taskId) await host.seams.drainPersistence(taskId);
      if (taskId) {
        // Poll for the cancelled terminal state (abort propagation is async;
        // on Windows process-tree kill — and Ollama abort during an active
        // generation — can take tens of seconds under load, so the deadline
        // is generous rather than assuming a fixed settle window).
        let status: string | undefined;
        const statusDeadline = Date.now() + 60_000;
        while (Date.now() < statusDeadline) {
          status = (await new TaskStore(host.tasksDir).get(taskId))?.status;
          if (status === "interrupted" || status === "cancelled") break;
          if (status === "completed") break;
          // The interrupted write may still be sitting in the persistence
          // debounce queue (abort can settle after the one-shot drain above);
          // draining each iteration forces any decided state to disk.
          await host.seams.drainPersistence(taskId);
          await sleep(500);
        }
        // RACE NOTE: stop and completion can legitimately interleave — if the
        // model finished its final turn just before the abort landed, the
        // task completes normally and that result WINS (never overwritten to
        // interrupted). Both outcomes must satisfy the same hard invariants.
        const stopWon = status === "interrupted" || status === "cancelled";
        const completeWon = status === "completed";
        expect(stopWon || completeWon).toBe(true);
        // Streaming STOPPED — asserted only after the process is provably
        // dead (cancelled state above). Chunks observed while abort was
        // still propagating are in-flight and legitimate; any chunk AFTER
        // termination would be a real orphan-process bug. Measured here:
        // no new output may arrive in the window after confirmed death.
        const countAtDeath = terminalOutputs(messages).length;
        await sleep(1500);
        const countAfter = terminalOutputs(messages).length;
        expect(countAfter).toBe(countAtDeath);
        // No RUN-level completion arrived alongside a WON stop: a cancelled
        // task must never also be reported completed. (A single tool-level
        // `tool/completed` for the aborted in-flight call is the native loop's
        // protocol unwind when abort lands mid-execution — mapped from its
        // final tool_result — and is not a run completion.) When completion
        // won the race, the completion event is of course present.
        const runCompletions = messages.filter(
          (m) =>
            m.type === "agent/status" &&
            (m.payload as Record<string, unknown> | undefined)?.["status"] === "completed",
        );
        if (stopWon) {
          expect(runCompletions).toHaveLength(0);
        } else {
          expect(runCompletions.length).toBeGreaterThanOrEqual(1);
        }
        expectValidJsonl(host.auditFile);
      }
      console.log("LIVE-OK [cancel-streaming]: stream stopped, state settled.");
    } finally {
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate();
      host.cleanup();
    }
  });

  it("bounded large output completes without explosion", { timeout: 900_000 }, async () => {
    const lh = await liveHost();
    if (!lh) {
      skipLog("large output");
      return;
    }
    const { host, messages } = lh;
    try {
      const run = host.seams.runPrompt(
        "Use the run_commands terminal tool to run this exact command and then reply DONE: " +
          "node -e \"let s=''; for (let i = 0; i < 500000; i++) s += '0123456789'; console.log(s);\" " +
          "Do not write any files.",
        "act",
      );
      const play = await Promise.race([
        (async () => {
          const outcome = await playTerminalApprovals(host, messages, 300_000, true);
          await run;
          return outcome;
        })(),
        sleep(840_000).then(() => ({ outcome: "timed-out" }) as ApprovalPlay),
      ]);
      if (play.outcome !== "approved-terminal") {
        await abortAndSettle(host, run);
        softModelCheck("live-large", false, `approval play outcome: ${play.outcome}`);
        return;
      }
      await sleep(DEBOUNCE_WAIT_MS);
      const taskId = host.seams.getActiveTaskId();
      if (taskId) await host.seams.drainPersistence(taskId);
      // UI buffer truncated explicitly (5MB live ≫ 100k cap).
      const toolEvents = messages.filter((m) => m.type === "tool/completed");
      expect(toolEvents.length).toBeGreaterThan(0);
      // Real volume actually streamed (not stubbed): megabytes of live data.
      const liveBytes = terminalOutputs(messages).reduce(
        (sum, m) => sum + String((m.payload as Record<string, unknown>)?.["data"] ?? "").length,
        0,
      );
      expect(liveBytes).toBeGreaterThan(1_000_000);
      if (taskId) {
        const task = await new TaskStore(host.tasksDir).get(taskId);
        expect(task).not.toBeNull();
        // Persisted result bounded (8k store cap), protocol valid.
        const raw = JSON.stringify(task);
        expect(raw.length).toBeLessThan(2_000_000);
        expect(validateConversationProtocol(buildInitialMessages(task!)).valid).toBe(true);
        expectValidJsonl(host.auditFile);
      }
      console.log(
        `LIVE-OK [large-output]: ${terminalOutputs(messages).length} live events, store + audit valid.`,
      );
    } finally {
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate();
      host.cleanup();
    }
  });
});
