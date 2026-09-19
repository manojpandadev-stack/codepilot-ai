/**
 * Continuity UX — host message-flow tests (Phase 12).
 *
 * Drives the REAL `handleWebviewMessage` dispatcher through the
 * `handleMessage` seam and observes the REAL `continuity/state` snapshots on
 * the captured webview sink. No React rendering involved — the contract
 * under test is the typed host↔webview message flow the UI consumes
 * (validator unit tests live in continuity-messages.test.ts).
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import {
  freshHost,
  reopenHost,
  sleep,
  DEBOUNCE_WAIT_MS,
  type FreshHost,
} from "./vscode-integration-harness";
import { TaskStore } from "../packages/agent-runtime/src/m12-task-store";
import type { AgentEvent } from "../packages/agent-runtime/src/types";

interface ContinuityState {
  active: boolean;
  chainLength: number;
  currentTaskId: string | null;
  turns: Array<{
    taskId: string;
    turn: number;
    title: string;
    status: string;
    createdAtMs: number;
    updatedAtMs: number;
    compacted: boolean;
    trimmed: boolean;
  }>;
  compacted: boolean;
  truncated: boolean;
}

type CapturedHost = FreshHost & {
  captured: Array<{ type: string; payload?: unknown }>;
};

/** Last `continuity/state` payload observed on the host's sink. */
function lastState(host: CapturedHost): ContinuityState | null {
  const found = [...host.captured]
    .reverse()
    .find((m) => m.type === "continuity/state");
  return (found?.payload ?? null) as ContinuityState | null;
}

async function hostWithCapture(): Promise<CapturedHost> {
  const host = await freshHost();
  const captured: Array<{ type: string; payload?: unknown }> = [];
  host.ext.__setWebviewSinkForIntegrationTest((m) => {
    captured.push(m as { type: string; payload?: unknown });
  });
  return Object.assign(host, { captured });
}

async function send(host: FreshHost, type: string, payload: unknown = {}): Promise<void> {
  await host.seams.handleMessage({
    type: type as never,
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    payload,
    timestamp: Date.now(),
  } as never);
}

async function teardown(host: CapturedHost): Promise<void> {
  host.ext.__clearWebviewSinkForIntegrationTest();
  await host.ext.deactivate().catch(() => {});
  host.cleanup();
}

describe("continuity UX message flow", () => {
  it("1. new conversation starts with empty chain", async () => {
    const host = await hostWithCapture();
    try {
      await send(host, "continuity/get");
      const state = lastState(host);
      expect(state).not.toBeNull();
      expect(state).toMatchObject({ active: false, chainLength: 0, turns: [] });
    } finally {
      await teardown(host);
    }
  });

  it("2-4. turns grow the chain 1 → 2 → 3 with safe metadata", async () => {
    const host = await hostWithCapture();
    try {
      const ids: string[] = [];
      for (const title of ["first question", "second question", "third question"]) {
        const id = await host.seams.beginTask(title);
        expect(id).not.toBeNull();
        ids.push(id!);
        await send(host, "continuity/get");
        const state = lastState(host);
        expect(state?.chainLength).toBe(ids.length);
        expect(state?.active).toBe(true);
      }
      const state = lastState(host)!;
      expect(state.turns.map((t) => t.taskId)).toEqual(ids);
      expect(state.turns.map((t) => t.turn)).toEqual([1, 2, 3]);
      expect(state.turns[0]!.title).toBe("first question");
      expect(state.currentTaskId).toBe(ids[2]);
      // Safe metadata only: no inputs, outputs, or credentials.
      expect(JSON.stringify(state).includes("input")).toBe(false);
    } finally {
      await teardown(host);
    }
  });

  it("5-8. reset clears the chain and preserves everything else", async () => {
    const host = await hostWithCapture();
    try {
      const id1 = await host.seams.beginTask("keep me");
      const id2 = await host.seams.beginTask("keep me too");
      const store = host.seams.getTaskStore();
      await store.update(id1!, { checkpointIds: ["ckpt-1"] });
      const bridge = host.seams.getLivePermissionBridge();
      await bridge.evaluateLiveTool({
        toolName: "read_file",
        input: { path: "a.ts" },
        taskId: id1!,
      });

      // Reset through the real dispatcher.
      await send(host, "continuity/reset");
      const resetAck = [...host.captured]
        .reverse()
        .find((m) => m.type === "continuity/result");
      expect(resetAck?.payload).toMatchObject({ success: true, action: "reset" });
      const state = lastState(host);
      expect(state).toMatchObject({ active: false, chainLength: 0, turns: [] });

      // Nothing historical was destroyed.
      const reopened = new TaskStore(host.tasksDir);
      expect(await reopened.get(id1!)).not.toBeNull();
      expect(await reopened.get(id2!)).not.toBeNull();
      expect((await reopened.get(id1!))?.checkpointIds).toEqual(["ckpt-1"]);
      expect((await reopened.list()).length).toBe(2);
      // Flush the debounced audit tail, then prove the record survived reset.
      await host.seams.getAuditLogger()?.flush();
      expect(fs.existsSync(host.auditFile)).toBe(true);
    } finally {
      await teardown(host);
    }
  });

  it("9. next turn after reset receives empty seed", async () => {
    const host = await hostWithCapture();
    try {
      await host.seams.beginTask("before reset");
      await send(host, "continuity/reset");
      expect(lastState(host)?.chainLength).toBe(0);
      // A fresh preamble after reset starts a new chain of one.
      const id = await host.seams.beginTask("after reset");
      await send(host, "continuity/get");
      const state = lastState(host)!;
      expect(state.chainLength).toBe(1);
      expect(state.turns[0]!.taskId).toBe(id);
    } finally {
      await teardown(host);
    }
  });

  it("10+12. explicit resume re-anchors continuity", async () => {
    const host = await hostWithCapture();
    try {
      const id1 = await host.seams.beginTask("resumable work");
      const emit = (e: AgentEvent): void => host.seams.ingestAgentEvent(e);
      emit({ type: "started", sessionId: "s1" });
      emit({ type: "text_delta", text: "half", accumulated: "half" });
      emit({ type: "cancelled" });
      await sleep(DEBOUNCE_WAIT_MS);
      await host.seams.drainPersistence(id1!);
      // Sanity: interrupted and resumable.
      expect((await new TaskStore(host.tasksDir).get(id1!))?.status).toBe("interrupted");

      // Reset first so re-anchoring is observable (not just appending).
      await send(host, "continuity/reset");
      expect(lastState(host)?.chainLength).toBe(0);

      // Resume needs an initialized runtime (offline-safe local create).
      // Dead endpoint keeps the provider leg fast: re-anchoring runs before
      // startSession, so the chain assertion holds however it settles.
      await host.seams.ensureRuntime();
      host.seams.getProviderService().setConfig("ollama", {
        baseUrl: "http://127.0.0.1:11499",
      });
      // Resume through the REAL history/resume handler. The live provider
      // leg may fail in offline environments; re-anchoring happens before
      // startSession, so the chain assertion holds either way.
      await send(host, "history/resume", { taskId: id1 });
      await send(host, "continuity/get");
      const state = lastState(host)!;
      expect(state.turns.map((t) => t.taskId)).toContain(id1!);
      expect(state.active).toBe(true);
    } finally {
      await teardown(host);
    }
  });

  it("11. extension restart starts with empty active chain", async () => {
    const host = await hostWithCapture();
    const storageDir = host.storageDir;
    await host.seams.beginTask("pre-restart turn");
    await host.seams.beginTask("pre-restart turn two");
    await send(host, "continuity/get");
    expect(lastState(host)?.chainLength).toBe(2);
    // Deactivate WITHOUT cleanup: the directory must survive for reopen.
    host.ext.__clearWebviewSinkForIntegrationTest();
    await host.ext.deactivate().catch(() => {});
    // Fresh host, same storage: chain empty, history intact.
    const reopened = await reopenHost(storageDir);
    const captured: Array<{ type: string; payload?: unknown }> = [];
    reopened.ext.__setWebviewSinkForIntegrationTest((m) => {
      captured.push(m as { type: string; payload?: unknown });
    });
    try {
      await reopened.seams.handleMessage({
        type: "continuity/get" as never,
        id: "t1",
        payload: {},
        timestamp: Date.now(),
      } as never);
      const found = [...captured].reverse().find((m) => m.type === "continuity/state");
      expect(found?.payload).toMatchObject({ active: false, chainLength: 0 });
      const store = new TaskStore(reopened.tasksDir);
      expect((await store.list()).length).toBe(2);
    } finally {
      reopened.ext.__clearWebviewSinkForIntegrationTest();
      await reopened.ext.deactivate().catch(() => {});
      fs.rmSync(storageDir, { recursive: true, force: true });
    }
  });

  it("13-14. provider switch preserves chain; privacy block does not corrupt", async () => {
    const host = await hostWithCapture();
    try {
      const id1 = await host.seams.beginTask("chained work");
      await send(host, "continuity/get");
      expect(lastState(host)?.chainLength).toBe(1);

      // Provider switch (settings path): chain untouched.
      host.seams.getProviderService().setConfig("ollama", { baseUrl: "http://127.0.0.1:11434" });
      await send(host, "continuity/get");
      const after = lastState(host)!;
      expect(after.chainLength).toBe(1);
      expect(after.turns[0]!.taskId).toBe(id1);

      // Privacy-blocked switch attempt leaves chain valid.
      host.vscodeStub.configOverrides.set("provider", "definitely-not-a-provider");
      await send(host, "continuity/get");
      expect(lastState(host)?.chainLength).toBe(1);
      void id1;
    } finally {
      host.vscodeStub.configOverrides.delete("provider");
      await teardown(host);
    }
  });

  it("15. compacted task displays optimized-context state", async () => {
    const host = await hostWithCapture();
    try {
      const id = await host.seams.beginTask("compact me");
      const store = host.seams.getTaskStore();
      await store.addCompactionArtifact(id!, {
        id: "ux-artifact",
        createdAtMs: Date.now(),
        mode: "summary",
        summarizedMessageCount: 5,
        remainingMessageCount: 1,
        tokensBefore: 4000,
        tokensAfter: 300,
        summaryText: "summary",
        sourceRange: { fromIndex: 0, toIndex: 5, toTs: Date.now(), fromTs: 0 },
        summaryVersion: 1,
        reason: "test",
      });
      await send(host, "continuity/get");
      const state = lastState(host)!;
      expect(state.compacted).toBe(true);
      expect(state.turns[0]!.compacted).toBe(true);
    } finally {
      await teardown(host);
    }
  });

  it("16. interrupted turn displays correct state (trimmed, not completed)", async () => {
    const host = await hostWithCapture();
    try {
      const id = await host.seams.beginTask("doomed work");
      const emit = (e: AgentEvent): void => host.seams.ingestAgentEvent(e);
      emit({ type: "started", sessionId: "s1" });
      emit({ type: "text_delta", text: "working", accumulated: "working" });
      emit({ type: "tool_requested", toolCallId: "kz", toolName: "bash", input: { command: "slow" } });
      await sleep(DEBOUNCE_WAIT_MS);
      await host.seams.drainPersistence(id!);
      emit({ type: "cancelled" });
      await sleep(DEBOUNCE_WAIT_MS);
      await host.seams.drainPersistence(id!);

      await send(host, "continuity/get");
      const state = lastState(host)!;
      expect(state.turns[0]!.status).toBe("interrupted");
      // The unpaired tool_use is withheld from future seeds — honestly flagged.
      expect(state.turns[0]!.trimmed).toBe(true);
      expect(state.turns[0]!.status).not.toBe("completed");
    } finally {
      await teardown(host);
    }
  });

  it("17. different tasks do not contaminate each other's chain view", async () => {
    const host = await hostWithCapture();
    try {
      const a = await host.seams.beginTask("alpha topic");
      const b = await host.seams.beginTask("beta topic");
      await send(host, "continuity/get");
      const state = lastState(host)!;
      expect(state.turns.map((t) => t.taskId)).toEqual([a, b]);
      expect(state.turns.map((t) => t.title)).toEqual(["alpha topic", "beta topic"]);
      expect(state.turns.map((t) => t.turn)).toEqual([1, 2]);
    } finally {
      await teardown(host);
    }
  });

  it("18. maximum chain cap is respected", async () => {
    const host = await hostWithCapture();
    try {
      for (let i = 0; i < 12; i += 1) {
        await host.seams.beginTask(`turn ${i}`);
      }
      await send(host, "continuity/get");
      const state = lastState(host)!;
      expect(state.chainLength).toBeLessThanOrEqual(10);
      expect(state.truncated).toBe(true);
      expect(state.turns.map((t) => t.turn)).toEqual(
        state.turns.map((_, k) => k + 1),
      );
    } finally {
      await teardown(host);
    }
  });

  it("19. malformed continuity traffic fails safely", async () => {
    const host = await hostWithCapture();
    try {
      await host.seams.beginTask("real turn");
      await send(host, "continuity/get");
      expect(lastState(host)?.chainLength).toBe(1);
      // Unknown message type: ignored, chain intact.
      await send(host, "continuity/nonexistent", { garbage: true });
      await send(host, "continuity/get");
      expect(lastState(host)?.chainLength).toBe(1);
      // Reset with garbage payload: still resets (payload is ignored by design).
      await send(host, "continuity/reset", "not-an-object");
      expect(lastState(host)?.chainLength).toBe(0);
    } finally {
      await teardown(host);
    }
  });

  it("20. no credentials appear in UI continuity state", async () => {
    const host = await hostWithCapture();
    try {
      await host.seams.beginTask("deploy with Bearer INT-UX-BEARER-9 and key sk-int-UXFAKEFAKE00");
      await send(host, "continuity/get");
      const state = lastState(host)!;
      const json = JSON.stringify(state);
      expect(json.includes("INT-UX-BEARER-9")).toBe(false);
      expect(json.includes("sk-int-UXFAKEFAKE00")).toBe(false);
      // Titles survive in redacted form (defense-in-depth signal).
      expect(json.includes("[REDACTED]")).toBe(true);
    } finally {
      await teardown(host);
    }
  });
});
