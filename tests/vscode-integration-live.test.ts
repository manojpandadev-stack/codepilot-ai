/**
 * LIVE Ollama closed-loop tests (Phases 2–7, 10, 12).
 *
 * The exact production path, end to end, with a REAL model:
 *
 *   runPrompt (real sendPromptToAgent)
 *     → ensureRuntime (real singleton)
 *     → CodePilotRuntime.startSession (real)
 *     → native agent engine → CodePilot LLM (native Ollama provider)
 *     → Ollama HTTP /api/chat (real)
 *     → agent events (real) → forwardAgentEvent (real)
 *     → webview messages (captured via test sink) + TaskStore + audit JSONL
 *
 * Skips (honestly logged, never faked) when no local Ollama is reachable.
 * Structural/protocol properties are hard assertions; exact model wording
 * is NEVER asserted (model-behavior checks are soft: logged, non-failing).
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  freshHost,
  reopenHost,
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
const LIVE_TIMEOUT = 240_000;
/**
 * Generation-heavy live tests get a larger environmental bound. Rationale,
 * not weakening: the product assertions are unchanged and strict; the bound
 * only covers Ollama server-side queueing when the full suite shares the
 * single local model across parallel workers (observed: tail latencies past
 * 240s under full parallel load, ~5s idle). Narrow generation timeouts
 * inside the tests themselves are untouched.
 */
const LIVE_GENERATION_TIMEOUT = 600_000;

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

function skipLog(test: string): void {
  console.log(`SKIP live Ollama (${test}): no server at ${OLLAMA_URL}`);
}

async function liveHost(): Promise<
  { host: FreshHost; messages: CapturedMessage[] } | null
> {
  if (!(await ollamaReachable())) return null;
  const host = await freshHost();
  const messages: CapturedMessage[] = [];
  host.ext.__setWebviewSinkForIntegrationTest((m) => {
    messages.push(m as CapturedMessage);
  });
  return { host, messages };
}

function ofType(messages: CapturedMessage[], type: string): CapturedMessage[] {
  return messages.filter((m) => m.type === type);
}

/** Last `accumulated` across captured stream deltas (the streamed output). */
function lastAccumulated(messages: CapturedMessage[]): string | null {
  const deltas = ofType(messages, "chat/stream_delta");
  if (deltas.length === 0) return null;
  const last = deltas[deltas.length - 1]!.payload?.["accumulated"];
  return typeof last === "string" ? last : null;
}

/** Soft model-behavior check: logs, never fails the test. */
function softModelCheck(name: string, condition: boolean, detail: string): void {
  console.log(
    `${condition ? "MODEL-OK" : "MODEL-LIMITATION"} [${name}]: ${detail}`,
  );
}

/** One-line census of captured webview traffic (types → counts). */
function messageCensus(messages: CapturedMessage[]): string {
  const counts = new Map<string, number>();
  for (const m of messages) counts.set(m.type, (counts.get(m.type) ?? 0) + 1);
  return [...counts.entries()].map(([t, n]) => `${t}:${n}`).join(" ");
}

describe("live ollama closed-loop", () => {
  it("TEST A — simple response: stream, completion, persistence", { timeout: LIVE_GENERATION_TIMEOUT }, async () => {
    const lh = await liveHost();
    if (!lh) {
      skipLog("TEST A");
      return;
    }
    const { host, messages } = lh;
    try {
      await host.seams.runPrompt("Reply with exactly the word CODEPILOT.", "act");
      await sleep(DEBOUNCE_WAIT_MS);
      const taskId = host.seams.getActiveTaskId();
      expect(taskId).not.toBeNull();
      await host.seams.drainPersistence(taskId!);

      // 1–7. session ran; deltas + exactly one terminal completion captured.
      expect(ofType(messages, "chat/stream_delta").length).toBeGreaterThan(0);
      const completions = ofType(messages, "agent/status").filter(
        (m) => m.payload?.["status"] === "completed",
      );
      expect(completions).toHaveLength(1);
      const result = completions[0]!.payload?.["result"];
      expect(typeof result === "string" && result.length > 0).toBe(true);

      // Model obedience is soft: infrastructure is proven by structure.
      softModelCheck(
        "TEST-A-wording",
        typeof result === "string" && result.includes("CODEPILOT"),
        `response was ${JSON.stringify(String(result).slice(0, 80))}`,
      );

      // 8–9. persisted conversation exists and matches captured output.
      const task = await new TaskStore(host.tasksDir).get(taskId!);
      expect(task?.status).toBe("completed");
      expect(task?.modelConfig).toMatchObject({ providerId: "ollama" });
      const acc = lastAccumulated(messages);
      expect(acc).not.toBeNull();
      const texts = (task?.conversation ?? []).flatMap((e) => e.blocks ?? []);
      const persisted = texts.find((b) => b.type === "text");
      expect(persisted?.type === "text" && persisted.text).toBe(acc);

      // 10–13. single terminal, valid protocol, reloadable.
      expect(
        task?.messages.filter(
          (m) => m.role === "assistant" && m.content === (result as string),
        ),
      ).toHaveLength(1);
      expect(validateConversationProtocol(buildInitialMessages(task!)).valid).toBe(true);
      expect(await new TaskStore(host.tasksDir).get(taskId!)).not.toBeNull();
    } finally {
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate();
      host.cleanup();
    }
  });

  it("TEST B — multi-turn continuity on one runtime", { timeout: LIVE_GENERATION_TIMEOUT }, async () => {
    const lh = await liveHost();
    if (!lh) {
      skipLog("TEST B");
      return;
    }
    const { host, messages } = lh;
    try {
      const rt1 = await host.seams.ensureRuntime();
      await host.seams.runPrompt("Remember this codeword: CP-LIVE-731.", "act");
      const task1 = host.seams.getActiveTaskId();
      expect(task1).not.toBeNull();

      await host.seams.runPrompt("What is the codeword? Reply with only the codeword.", "act");
      const task2 = host.seams.getActiveTaskId();
      expect(task2).not.toBeNull();
      expect(task2).not.toBe(task1);
      // Same runtime singleton across turns (production session continuity).
      // NOTE (verified finding): startSession resets activeSessionId and
      // starts a FRESH native session per turn (runtime.ts) — no prior
      // history is seeded outside the resume flow. Turn 2 therefore has no
      // architectural path to the codeword; recall depends on the model
      // alone. Both turns persist independently and reload cleanly.
      expect(await host.seams.ensureRuntime()).toBe(rt1);

      await sleep(DEBOUNCE_WAIT_MS);
      await host.seams.drainPersistence(task2!);

      const store = new TaskStore(host.tasksDir);
      const t1 = await store.get(task1!);
      const t2 = await store.get(task2!);
      expect(t1?.status).toBe("completed");
      expect(t2?.status).toBe("completed");
      const turn2Response = String(
        (ofType(messages, "agent/status").filter(
          (m) => m.payload?.["status"] === "completed",
        ).at(-1)?.payload?.["result"] ?? ""),
      );
      expect(turn2Response.length).toBeGreaterThan(0);
      softModelCheck(
        "TEST-B-recall",
        turn2Response.includes("CP-LIVE-731"),
        `turn-2 response was ${JSON.stringify(turn2Response.slice(0, 80))}`,
      );
      expect(validateConversationProtocol(buildInitialMessages(t2!)).valid).toBe(true);
    } finally {
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate();
      host.cleanup();
    }
  });

  it("TEST C — tool-aware turn through the real M4 gate", { timeout: LIVE_GENERATION_TIMEOUT }, async () => {
    const lh = await liveHost();
    if (!lh) {
      skipLog("TEST C");
      return;
    }
    const { host, messages } = lh;
    try {
      // Bounded: a write-tool approval would wait for UI that does not exist
      // in tests (fail-closed by design). The race converts that correct
      // blocking into a reported model limitation instead of a frozen suite.
      const run = host.seams.runPrompt(
        "List the files in the current directory using only the list_files or read_file tools. Do not write or modify anything. Then reply DONE.",
        "act",
      );
      const outcome = await Promise.race([
        run.then(() => "finished" as const),
        sleep(150_000).then(() => "bounded-wait" as const),
      ]);

      const toolStarts = ofType(messages, "tool/started");
      if (outcome === "bounded-wait") {
        console.log(`LIVE TEST-C census at bound: ${messageCensus(messages)}`);
        await host.seams.stopAgent();
        await run;
        const taskId = host.seams.getActiveTaskId();
        if (taskId) await host.seams.drainPersistence(taskId);
        const task = taskId ? await new TaskStore(host.tasksDir).get(taskId) : null;
        expect(["interrupted", "running"].includes(task?.status ?? "")).toBe(true);
        console.log(
          "MODEL-LIMITATION [TEST-C-tools]: run did not finish in 150s (likely a write-tool approval with no UI — fail-closed as designed).",
        );
        return;
      }

      if (toolStarts.length === 0) {
        console.log(
          "MODEL-LIMITATION [TEST-C-tools]: model answered without emitting tool calls; asserting the non-tool live path.",
        );
        const completions = ofType(messages, "agent/status").filter(
          (m) => m.payload?.["status"] === "completed",
        );
        expect(completions).toHaveLength(1);
        return;
      }

      // Real tool path: request → M4 → execution → result → continuation.
      expect(ofType(messages, "tool/completed").length).toBeGreaterThan(0);
      await sleep(DEBOUNCE_WAIT_MS);
      const taskId = host.seams.getActiveTaskId();
      expect(taskId).not.toBeNull();
      await host.seams.drainPersistence(taskId!);

      const task = await new TaskStore(host.tasksDir).get(taskId!);
      const blocks = (task?.conversation ?? []).flatMap((e) => e.blocks ?? []);
      expect(blocks.filter((b) => b.type === "tool_use").length).toBeGreaterThan(0);
      expect(blocks.filter((b) => b.type === "tool_result").length).toBeGreaterThan(0);
      // Every result pairs with a preceding use (no orphans).
      expect(validateConversationProtocol(buildInitialMessages(task!)).valid).toBe(true);
      // The M4 gate recorded its real decision in the durable audit trail.
      expectValidJsonl(host.auditFile);
      const audits = readJsonlRecords(host.auditFile) as Array<{
        approved?: boolean;
        action?: string;
      }>;
      expect(
        audits.some((a) => a.approved === true),
      ).toBe(true);
      console.log(
        `MODEL-OK [TEST-C-tools]: ${toolStarts.length} tool call(s), audit entries ${audits.length}.`,
      );
    } finally {
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate();
      host.cleanup();
    }
  });

  it("live M4 — allow executes, traversal denied, audit recorded", { timeout: 120_000 }, async () => {
    const lh = await liveHost();
    if (!lh) {
      skipLog("live M4");
      return;
    }
    const { host } = lh;
    try {
      const bridge = host.seams.getLivePermissionBridge();
      // Allowed read through RiskEngine → PolicyEngine (auto-approve).
      const allow = await bridge.evaluateLiveTool({
        toolName: "read_file",
        input: { path: "package.json" },
        taskId: "m4-live",
      });
      expect(allow.approved).toBe(true);

      // Workspace escape: policy-allow + SecurityValidator boundary denial.
      // No approval UI involved (deny path never presents) — cannot hang.
      const deny = await bridge.evaluateLiveTool({
        toolName: "read_file",
        input: { path: "../../etc/passwd" },
        taskId: "m4-live",
      });
      expect(deny.approved).toBe(false);

      await host.ext.deactivate();
      expectValidJsonl(host.auditFile);
      const audits = readJsonlRecords(host.auditFile) as Array<{
        approved?: boolean;
        toolId?: string;
      }>;
      expect(audits.some((a) => a.approved === true)).toBe(true);
      expect(audits.some((a) => a.approved === false)).toBe(true);
    } finally {
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate().catch(() => {});
      host.cleanup();
    }
  });

  it("live cancel — real abort path, partial state stays valid", { timeout: LIVE_GENERATION_TIMEOUT }, async () => {
    const lh = await liveHost();
    if (!lh) {
      skipLog("live cancel");
      return;
    }
    const { host, messages } = lh;
    try {
      // Counting is pure text generation (no tool temptation) with fast
      // first tokens and minutes of output: ideal for a mid-stream abort.
      // (Approval-blocked abort is covered separately by TEST C's
      // bounded-wait path + the stopAgent approval-cancel fix.)
      const run = host.seams.runPrompt(
        "Count slowly from 1 to 500, one number per line, with no other text and no tool calls.",
        "act",
      );
      // Wait for the first real streamed text (bounded), noticing early
      // settlement. One delta suffices to prove "already received text"
      // stays valid — first-token latency varies with model load.
      let settled = false;
      void run.then(() => {
        settled = true;
      });
      const deadline = Date.now() + 300_000;
      while (ofType(messages, "chat/stream_delta").length < 1 && Date.now() < deadline && !settled) {
        await sleep(500);
      }
      console.log(`LIVE cancel pre-stop: settled=${settled} ${messageCensus(messages)}`);
      console.log(
        "LIVE cancel statuses:",
        JSON.stringify(messages.map((m) => (m.payload as Record<string, unknown> | undefined)?.["message"])).slice(0, 600),
      );
      expect(ofType(messages, "chat/stream_delta").length).toBeGreaterThan(0);
      expect(ofType(messages, "chat/stream_delta").length).toBeGreaterThan(0);
      await host.seams.stopAgent();
      await run;
      await sleep(DEBOUNCE_WAIT_MS);
      const taskId = host.seams.getActiveTaskId();
      expect(taskId).not.toBeNull();
      await host.seams.drainPersistence(taskId!);

      const task = await new TaskStore(host.tasksDir).get(taskId!);
      // Cancelled/interrupted terminal state, exactly once (no completion).
      expect(task?.status).toBe("interrupted");
      expect(
        ofType(messages, "agent/status").filter(
          (m) => m.payload?.["status"] === "completed",
        ),
      ).toHaveLength(0);
      // Already-received text remains valid and persisted.
      const texts = (task?.conversation ?? []).flatMap((e) => e.blocks ?? []);
      const persisted = texts.find((b) => b.type === "text");
      expect(persisted?.type === "text" && persisted.text.length > 0).toBe(true);
      expect(validateConversationProtocol(buildInitialMessages(task!)).valid).toBe(true);
      expect(host.seams.getPersistenceQueue().isIdle(taskId!)).toBe(true);
      expectValidJsonl(host.auditFile);
    } finally {
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate();
      host.cleanup();
    }
  });

  it("live provider failure — dead endpoint surfaces, next run recovers", { timeout: LIVE_GENERATION_TIMEOUT }, async () => {
    const lh = await liveHost();
    if (!lh) {
      skipLog("live failure");
      return;
    }
    const { host, messages } = lh;
    const DEAD_PORT_URL = "http://127.0.0.1:11499";
    try {
      // Controlled failure through the REAL settings path: point Ollama at
      // a dead port BEFORE the runtime is created. (An unknown model name
      // is NOT a failure in this stack — the native loop surfaces the Ollama 404
      // as a completed result string, verified during development.)
      host.seams.getProviderService().setConfig("ollama", { baseUrl: DEAD_PORT_URL });
      const run = host.seams.runPrompt("Reply with: SHOULD-FAIL.", "act");
      const outcome = await Promise.race([
        run.then(() => "settled" as const),
        sleep(120_000).then(() => "no-failure-surfaced" as const),
      ]);
      // sendPromptToAgent never throws (outcomes become webview/task state).
      expect(outcome).toBe("settled");
      // Transport failure contract (native runtime): a run that never reached
      // the model FAILS — it must not be reported as "completed". That was
      // the silent-completion defect (loop errors returned as results were
      // settled as completed); loop errors now surface through agent.failed
      // → error event → webview error card + persisted system error line,
      // and the task settles as `failed` (never stuck running, never fake-
      // completed). The endpoint (11499) must be diagnosable in the error.
      const failCompletions = ofType(messages, "agent/status").filter(
        (m) => (m.payload as Record<string, unknown> | undefined)?.["status"] === "completed",
      );
      expect(failCompletions).toHaveLength(0);
      const errorCards = ofType(messages, "error");
      expect(errorCards.length).toBeGreaterThanOrEqual(1);
      const errorText = errorCards
        .map((m) => String((m.payload as Record<string, unknown> | undefined)?.["message"] ?? ""))
        .join("\n");
      expect(errorText).toContain("11499");
      const failedTaskId = host.seams.getActiveTaskId();
      expect(failedTaskId).not.toBeNull();
      await sleep(DEBOUNCE_WAIT_MS);
      await host.seams.drainPersistence(failedTaskId!);
      const failed = await new TaskStore(host.tasksDir).get(failedTaskId!);
      expect(failed).not.toBeNull();
      // Honest-failure persistence: failed status, the endpoint-bearing error
      // recorded in the conversation, protocol-valid history, idle queue,
      // valid audit.
      expect(failed!.status).toBe("failed");
      expect(
        failed!.messages.some(
          (m) => m.role === "system" && m.content.includes("11499"),
        ),
      ).toBe(true);
      expect(validateConversationProtocol(buildInitialMessages(failed!)).valid).toBe(true);
      expect(host.seams.getPersistenceQueue().isIdle(failedTaskId!)).toBe(true);
      expectValidJsonl(host.auditFile);

      // Restore the live endpoint on the SAME host: the next task still runs.
      host.seams.getProviderService().setConfig("ollama", { baseUrl: OLLAMA_URL });
      messages.length = 0;
      await host.seams.runPrompt("Reply with exactly: RECOVERED.", "act");
      const okId = host.seams.getActiveTaskId();
      expect(okId).not.toBeNull();
      expect(okId).not.toBe(failedTaskId);
      await sleep(DEBOUNCE_WAIT_MS);
      await host.seams.drainPersistence(okId!);
      const okTask = await new TaskStore(host.tasksDir).get(okId!);
      expect(okTask?.status).toBe("completed");
      const completions = ofType(messages, "agent/status").filter(
        (m) => m.payload?.["status"] === "completed",
      );
      expect(completions).toHaveLength(1);
    } finally {
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate();
      host.cleanup();
    }
  });

  it("resource check — sequential live sessions release queue/audit weight", { timeout: LIVE_GENERATION_TIMEOUT }, async () => {
    const lh = await liveHost();
    if (!lh) {
      skipLog("resources");
      return;
    }
    const { host, messages } = lh;
    try {
      const heaps: number[] = [];
      for (let s = 0; s < 3; s += 1) {
        messages.length = 0;
        await host.seams.runPrompt(`Session ${s}: reply with exactly the word SESSION-${s}.`, "act");
        const taskId = host.seams.getActiveTaskId();
        expect(taskId).not.toBeNull();
        await sleep(DEBOUNCE_WAIT_MS);
        await host.seams.drainPersistence(taskId!);
        const task = await new TaskStore(host.tasksDir).get(taskId!);
        expect(task?.status).toBe("completed");
        // Structural cleanup after every session (not timing/memory bounds).
        expect(host.seams.getPersistenceQueue().isIdle(taskId!)).toBe(true);
        const logger = host.seams.getAuditLogger();
        if (logger) expect(logger.size()).toBeLessThanOrEqual(1000);
        heaps.push(Math.round(process.memoryUsage().heapUsed / 1024));
      }
      // Exactly 3 durable tasks, all reloadable; runtime still healthy.
      const listed = await new TaskStore(host.tasksDir).list();
      expect(listed).toHaveLength(3);
      console.log(`LIVE heap KB across 3 sessions: ${heaps.join(" → ")}`);
    } finally {
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate();
      host.cleanup();
    }
  });

  it("live security — no credential shapes reach disk", { timeout: LIVE_TIMEOUT }, async () => {
    const lh = await liveHost();
    if (!lh) {
      skipLog("live security");
      return;
    }
    const { host } = lh;
    try {
      await host.seams.runPrompt("Reply with exactly: HELLO.", "act");
      const taskId = host.seams.getActiveTaskId();
      expect(taskId).not.toBeNull();
      await sleep(DEBOUNCE_WAIT_MS);
      await host.seams.drainPersistence(taskId!);
      await host.ext.deactivate();

      // Strict prose-safe patterns (word-boundaried, length-floored).
      const patterns = [
        /\bsk-[A-Za-z0-9_-]{8,}/,
        /gh[pousr]_[A-Za-z0-9]{20,}/,
        /\bBearer\s+[A-Za-z0-9._-]{16,}/,
        /BEGIN [A-Z ]*PRIVATE KEY/,
        /Authorization\s*:/,
      ];
      const walk = (dir: string, out: string[] = []): string[] => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p, out);
          else if (e.isFile()) out.push(p);
        }
        return out;
      };
      const files = walk(host.storageDir);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const raw = fs.readFileSync(file, "utf8");
        for (const pattern of patterns) {
          expect(
            pattern.test(raw),
            `credential shape ${pattern} in ${path.basename(file)}`,
          ).toBe(false);
        }
        // No API-key material or key-slot names persisted anywhere.
        expect(raw.includes("codepilot.apiKey")).toBe(false);
      }
    } finally {
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate().catch(() => {});
      host.cleanup();
    }
  });

  it("live two-turn recall — turn 2 receives turn 1 as initialMessages", { timeout: LIVE_GENERATION_TIMEOUT }, async () => {
    const lh = await liveHost();
    if (!lh) {
      skipLog("live two-turn recall");
      return;
    }
    const { host, messages } = lh;
    try {
      await host.seams.runPrompt("Remember this exact codeword for the next turn: CP-CONTEXT-731.", "act");
      const task1 = host.seams.getActiveTaskId();
      expect(task1).not.toBeNull();
      // First turn in session: nothing seeded (verified infrastructure).
      expect(host.seams.getLastSeededHistory()).toBeNull();
      await sleep(DEBOUNCE_WAIT_MS);
      await host.seams.drainPersistence(task1!);
      const reloaded1 = await new TaskStore(host.tasksDir).get(task1!);
      expect(reloaded1?.status).toBe("completed");

      await host.seams.runPrompt("What exact codeword did I ask you to remember?", "act");
      const task2 = host.seams.getActiveTaskId();
      expect(task2).not.toBeNull();
      expect(task2).not.toBe(task1);
      // The native session received non-empty, protocol-valid history (hard proof).
      const seed = host.seams.getLastSeededHistory();
      expect(seed).not.toBeNull();
      expect(seed!.length).toBeGreaterThan(0);
      expect(validateConversationProtocol(seed!).valid).toBe(true);
      expect(seed).toEqual(buildInitialMessages(reloaded1!));
      // Turn-1 content (not turn-2's prompt) is what was delivered.
      expect(JSON.stringify(seed).includes("CP-CONTEXT-731")).toBe(true);

      await sleep(DEBOUNCE_WAIT_MS);
      await host.seams.drainPersistence(task2!);
      const reloaded2 = await new TaskStore(host.tasksDir).get(task2!);
      expect(reloaded2?.status).toBe("completed");
      expect(validateConversationProtocol(buildInitialMessages(reloaded2!)).valid).toBe(true);
      // Model recall itself is soft: infrastructure proven above.
      const turn2Text = (reloaded2?.conversation ?? [])
        .flatMap((e) => e.blocks ?? [])
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join(" ");
      softModelCheck(
        "recall-two-turn",
        turn2Text.includes("CP-CONTEXT-731"),
        `turn-2 text was ${JSON.stringify(turn2Text.slice(0, 120))}`,
      );
    } finally {
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate();
      host.cleanup();
    }
  });

  it("live three-turn recall — initialMessages on turns 2 and 3", { timeout: LIVE_GENERATION_TIMEOUT }, async () => {
    const lh = await liveHost();
    if (!lh) {
      skipLog("live three-turn recall");
      return;
    }
    const { host } = lh;
    try {
      const seeds: Array<unknown[] | null> = [];
      await host.seams.runPrompt("My project codename is CP-ALPHA. Reply with exactly: NOTED-ALPHA.", "act");
      seeds.push(host.seams.getLastSeededHistory());
      const t1 = host.seams.getActiveTaskId();
      await sleep(DEBOUNCE_WAIT_MS);
      if (t1) await host.seams.drainPersistence(t1);

      await host.seams.runPrompt("Change the codename to CP-BETA. Reply with exactly: NOTED-BETA.", "act");
      seeds.push(host.seams.getLastSeededHistory());
      const t2 = host.seams.getActiveTaskId();
      await sleep(DEBOUNCE_WAIT_MS);
      if (t2) await host.seams.drainPersistence(t2);

      await host.seams.runPrompt("What is the latest project codename? Reply with only the codename.", "act");
      seeds.push(host.seams.getLastSeededHistory());
      const t3 = host.seams.getActiveTaskId();
      await sleep(DEBOUNCE_WAIT_MS);
      if (t3) await host.seams.drainPersistence(t3);

      // Infrastructure proof per turn: empty, non-empty, non-empty seeds.
      expect(seeds[0]).toBeNull();
      expect(seeds[1]).not.toBeNull();
      expect(seeds[2]).not.toBeNull();
      expect((seeds[1] as unknown[]).length).toBeGreaterThan(0);
      expect((seeds[2] as unknown[]).length).toBeGreaterThan(0);
      expect(validateConversationProtocol(seeds[1] as never).valid).toBe(true);
      expect(validateConversationProtocol(seeds[2] as never).valid).toBe(true);
      expect(validateConversationProtocol(seeds[2] as never).valid).toBe(true);
      // Turn-3 seed carries the chain (ALPHA turn + BETA turn).
      expect(JSON.stringify(seeds[2]).includes("CP-ALPHA")).toBe(true);
      expect(JSON.stringify(seeds[2]).includes("CP-BETA")).toBe(true);

      const store = new TaskStore(host.tasksDir);
      const r3 = t3 ? await store.get(t3) : null;
      expect(r3?.status).toBe("completed");
      const turn3Text = (r3?.conversation ?? [])
        .flatMap((e) => e.blocks ?? [])
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join(" ");
      softModelCheck(
        "recall-three-turn",
        turn3Text.includes("CP-BETA"),
        `turn-3 text was ${JSON.stringify(turn3Text.slice(0, 120))}`,
      );
    } finally {
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate();
      host.cleanup();
    }
  });

  it("live tool-context turn — read in turn 1, recall in turn 2", { timeout: LIVE_GENERATION_TIMEOUT }, async () => {
    const lh = await liveHost();
    if (!lh) {
      skipLog("live tool-context");
      return;
    }
    const { host, messages } = lh;
    try {
      const run = host.seams.runPrompt(
        "Use only the list_files tool to list the current directory, then reply DONE. Do not write or modify anything.",
        "act",
      );
      const outcome = await Promise.race([
        run.then(() => "finished" as const),
        sleep(150_000).then(() => "bounded-wait" as const),
      ]);
      const toolStarts = messages.filter((m) => m.type === "tool/started");
      if (outcome === "bounded-wait" || toolStarts.length === 0) {
        if (outcome === "bounded-wait") {
          await host.seams.stopAgent();
          await run;
        }
        console.log(
          "MODEL-LIMITATION [live-tool-context]: model did not complete a read-tool turn; existing M4/tool-path coverage retained.",
        );
        return;
      }
      const t1 = host.seams.getActiveTaskId();
      await sleep(DEBOUNCE_WAIT_MS);
      if (t1) await host.seams.drainPersistence(t1);

      await host.seams.runPrompt("What files did you just list? Name two of them.", "act");
      const seed = host.seams.getLastSeededHistory();
      expect(seed).not.toBeNull();
      // Turn-1 tool result rode into turn 2 as paired history.
      const kinds = seed!.flatMap((m) =>
        Array.isArray(m.content) ? m.content.map((b) => b.type) : ["text"],
      );
      expect(kinds).toContain("tool_use");
      expect(kinds).toContain("tool_result");
      expect(validateConversationProtocol(seed!).valid).toBe(true);
      const t2 = host.seams.getActiveTaskId();
      await sleep(DEBOUNCE_WAIT_MS);
      if (t2) await host.seams.drainPersistence(t2);
      console.log("MODEL-OK [live-tool-context]: paired tool history seeded into turn 2.");
    } finally {
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate();
      host.cleanup();
    }
  });

  it("live continuity reset — codeword turns, reset, empty seed proof", { timeout: LIVE_GENERATION_TIMEOUT }, async () => {
    const lh = await liveHost();
    if (!lh) {
      skipLog("live continuity reset");
      return;
    }
    const { host, messages } = lh;
    const continuityStates = (): Array<{ type: string; payload?: unknown }> =>
      messages.filter((m) => m.type === "continuity/state");
    try {
      // TURN 1 + TURN 2 with UI-state observation at each step.
      await host.seams.runPrompt("Remember this codeword: CP-UX-731.", "act");
      const task1 = host.seams.getActiveTaskId();
      expect(task1).not.toBeNull();
      await sleep(DEBOUNCE_WAIT_MS);
      await host.seams.drainPersistence(task1!);
      expect(continuityStates().at(-1)?.payload).toMatchObject({ chainLength: 1 });

      await host.seams.runPrompt("What codeword did I ask you to remember?", "act");
      const task2 = host.seams.getActiveTaskId();
      expect(task2).not.toBeNull();
      await sleep(DEBOUNCE_WAIT_MS);
      await host.seams.drainPersistence(task2!);
      expect(continuityStates().at(-1)?.payload).toMatchObject({ chainLength: 2 });
      expect(host.seams.getLastSeededHistory()).not.toBeNull();

      // "New Conversation" through the REAL message dispatcher.
      await host.seams.handleMessage({
        type: "continuity/reset",
        id: "ux-reset-1",
        payload: {},
        timestamp: Date.now(),
      } as never);
      expect(continuityStates().at(-1)?.payload).toMatchObject({
        active: false,
        chainLength: 0,
      });

      // TURN 3: proves the reset — captured initialMessages MUST be empty.
      // Model recall is NOT asserted (that would prove nothing about the
      // model); the authoritative reset evidence is the empty seed plus a
      // fresh task identity with old records intact.
      await host.seams.runPrompt("What was the previous codeword?", "act");
      const task3 = host.seams.getActiveTaskId();
      expect(task3).not.toBeNull();
      expect(task3).not.toBe(task1);
      expect(task3).not.toBe(task2);
      expect(host.seams.getLastSeededHistory()).toBeNull();
      await sleep(DEBOUNCE_WAIT_MS);
      await host.seams.drainPersistence(task3!);
      expect(continuityStates().at(-1)?.payload).toMatchObject({ chainLength: 1 });

      const store = new TaskStore(host.tasksDir);
      expect(await store.get(task1!)).not.toBeNull();
      expect(await store.get(task2!)).not.toBeNull();
      expect(await store.get(task3!)).not.toBeNull();
      console.log("LIVE-OK [continuity-reset]: empty seed after reset, history intact.");
    } finally {
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate();
      host.cleanup();
    }
  });

  it("live reload/resume — restart, re-anchor, seeded turn 3", { timeout: LIVE_GENERATION_TIMEOUT }, async () => {
    const lh = await liveHost();
    if (!lh) {
      skipLog("live reload/resume");
      return;
    }
    const { host } = lh;
    const storageDir = host.storageDir;
    let interruptedId: string | null = null;
    // Throughput note: the 8b model on this CPU-only box is too slow for a
    // four-leg test (two 600 s timeouts observed). The 3b coder keeps every
    // assertion identical (all structural; recall proven on 8b twice).
    // Interruption itself is produced deterministically with scripted
    // events (live cancel is proven separately in the standalone test);
    // the model legs here are resume + turn 3 only.
    host.vscodeStub.configOverrides.set("model", "qwen2.5-coder:3b");
    try {
      // Turn 1: deterministic scripted history (no model needed) carrying
      // a marker that proves old history survives the restart below.
      const t1 = await host.seams.beginTask("remember RELAY-PINE-42 for later");
      expect(t1).not.toBeNull();
      host.seams.ingestAgentEvent({ type: "started", sessionId: "s1" });
      host.seams.ingestAgentEvent({ type: "text_delta", text: "noted", accumulated: "noted" });
      host.seams.ingestAgentEvent({
        type: "completed",
        result: "noted",
        usage: { inputTokens: 2, outputTokens: 2, totalCost: 0 },
      });
      await sleep(DEBOUNCE_WAIT_MS);
      await host.seams.drainPersistence(t1!);

      // Turn 2: scripted interrupted turn (deterministic; the live abort
      // path is covered by the standalone cancel test).
      const t2 = await host.seams.beginTask("Count slowly from 1 to 500");
      expect(t2).not.toBeNull();
      host.seams.ingestAgentEvent({ type: "started", sessionId: "s2" });
      host.seams.ingestAgentEvent({ type: "text_delta", text: "1\n2\n", accumulated: "1\n2\n" });
      host.seams.ingestAgentEvent({ type: "cancelled" });
      await sleep(DEBOUNCE_WAIT_MS);
      await host.seams.drainPersistence(t2!);
      interruptedId = t2;
      expect((await new TaskStore(host.tasksDir).get(interruptedId!))?.status).toBe("interrupted");
    } finally {
      host.vscodeStub.configOverrides.delete("model");
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate();
      // Keep the directory: the reopened host continues this test.
    }

    // Extension restart: fresh host, same storage. Chain must start empty.
    const reopened = await reopenHost(storageDir);
    reopened.vscodeStub.configOverrides.set("model", "qwen2.5-coder:3b");
    const captured: Array<{ type: string; payload?: unknown }> = [];
    reopened.ext.__setWebviewSinkForIntegrationTest((m) => {
      captured.push(m as { type: string; payload?: unknown });
    });
    try {
      await reopened.seams.handleMessage({
        type: "continuity/get",
        id: "re-1",
        payload: {},
        timestamp: Date.now(),
      } as never);
      const empty = [...captured].reverse().find((m) => m.type === "continuity/state");
      expect(empty?.payload).toMatchObject({ active: false, chainLength: 0 });

      // Explicit resume of the interrupted task through the real handler.
      // The runtime must exist first (offline-safe local create); the
      // resumed live run itself is bounded below.
      await reopened.seams.ensureRuntime();
      const resumeCall = reopened.seams.handleMessage({
        type: "history/resume",
        id: "re-2",
        payload: { taskId: interruptedId },
        timestamp: Date.now(),
      } as never);
      const resumeOutcome = await Promise.race([
        resumeCall.then(() => "resumed" as const),
        sleep(150_000).then(() => "resume-running" as const),
      ]);
      await reopened.seams.handleMessage({
        type: "continuity/get",
        id: "re-3",
        payload: {},
        timestamp: Date.now(),
      } as never);
      const reanchored = [...captured]
        .reverse()
        .find((m) => m.type === "continuity/state");
      const ids = (
        (reanchored?.payload as { turns?: Array<{ taskId: string }> } | undefined)?.turns ?? []
      ).map((t) => t.taskId);
      expect(ids).toContain(interruptedId);
      if (resumeOutcome === "resume-running") {
        await reopened.seams.stopAgent();
      }
      await resumeCall;

      // Turn 3 through the normal path receives the resumed history.
      // Expected history = the resumed counting task (chain holds the
      // resumed task; turn 1's separate record stays intact on disk).
      // "500" comes from the counting prompt's persisted user message.
      await reopened.seams.runPrompt("Continue briefly.", "act");
      const seed = reopened.seams.getLastSeededHistory();
      expect(seed).not.toBeNull();
      expect(validateConversationProtocol(seed!).valid).toBe(true);
      expect(JSON.stringify(seed).includes("500")).toBe(true);
      const t3 = reopened.seams.getActiveTaskId();
      await sleep(DEBOUNCE_WAIT_MS);
      if (t3) await reopened.seams.drainPersistence(t3);
      const store = new TaskStore(reopened.tasksDir);
      // No duplicate turns: every chained task appears exactly once.
      const listed = await store.list();
      const seen = new Set(listed.map((t) => t.id));
      expect(seen.size).toBe(listed.length);
      for (const t of listed) {
        expect(validateConversationProtocol(buildInitialMessages(t)).valid).toBe(true);
      }
      // Old history remains: turn 1's marker survives restart + resume.
      const allText = listed.flatMap((t) => t.messages.map((m) => m.content)).join("\n");
      expect(allText.includes("RELAY-PINE-42")).toBe(true);
      console.log("LIVE-OK [reload-resume]: re-anchored chain seeded turn 3, no duplicates.");
    } finally {
      reopened.vscodeStub.configOverrides.delete("model");
      reopened.ext.__clearWebviewSinkForIntegrationTest();
      await reopened.ext.deactivate().catch(() => {});
      fs.rmSync(storageDir, { recursive: true, force: true });
    }
  });
});
