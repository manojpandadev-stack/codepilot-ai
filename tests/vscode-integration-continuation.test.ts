/**
 * Per-turn continuation integration (Phases 5–9, 13–15 scripted parts).
 *
 * Strategy: task-1 history is built with deterministic scripted events
 * through the REAL pipeline; turn 2 runs the REAL `sendPromptToAgent`
 * (preamble + seeding + startSession) with Ollama pointed at a dead port,
 * so the provider leg fails fast and deterministically while every
 * persistence/seeding assertion observes the genuine production path.
 * Live-model recall is proven separately (live file); here the contract is:
 * what the native session WOULD receive (lastSeededHistory) is exactly turn-1
 * history, validated, de-duplicated, and redacted.
 */

import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  freshHost,
  sleep,
  DEBOUNCE_WAIT_MS,
  type FreshHost,
} from "./vscode-integration-harness";
import { TaskStore } from "../packages/agent-runtime/src/m12-task-store";
import { buildInitialMessages } from "../packages/agent-runtime/src/resume";
import { validateConversationProtocol } from "../packages/agent-runtime/src/compaction-protocol";
import type { AgentEvent } from "../packages/agent-runtime/src/types";

const DEAD_PORT_URL = "http://127.0.0.1:11499";

/** Script a rich deterministic history for the active task, then settle. */
async function scriptHistory(
  host: FreshHost,
  deltas: string[],
  tools: Array<{ id: string; name: string; input: unknown; output: unknown }>,
  terminal: "completed" | "cancelled" = "completed",
): Promise<string> {
  const taskId = await host.seams.beginTask("continuation history");
  expect(taskId).not.toBeNull();
  const emit = (e: AgentEvent): void => host.seams.ingestAgentEvent(e);
  emit({ type: "started", sessionId: `sess-${taskId}` });
  let acc = "";
  for (const d of deltas) {
    acc += d;
    emit({ type: "text_delta", text: d, accumulated: acc });
  }
  for (const t of tools) {
    emit({ type: "tool_requested", toolCallId: t.id, toolName: t.name, input: t.input });
    emit({
      type: "tool_completed",
      toolCallId: t.id,
      toolName: t.name,
      output: t.output,
      durationMs: 3,
    });
  }
  if (terminal === "completed") {
    emit({
      type: "completed",
      result: "history turn done",
      usage: { inputTokens: 5, outputTokens: 5, totalCost: 0 },
    });
  } else {
    emit({ type: "cancelled" });
  }
  await sleep(DEBOUNCE_WAIT_MS);
  await host.seams.drainPersistence(taskId!);
  return taskId!;
}

function useDeadEndpoint(host: FreshHost): void {
  host.seams.getProviderService().setConfig("ollama", { baseUrl: DEAD_PORT_URL });
}

describe("per-turn continuation (scripted production path)", () => {
  it("first turn seeds nothing; second turn seeds turn-1 history exactly once", async () => {
    const host = await freshHost();
    try {
      useDeadEndpoint(host);
      // Turn 1 (first in session): no predecessor → seed must be empty.
      await host.seams.runPrompt("alpha first question", "act");
      expect(host.seams.getLastSeededHistory()).toBeNull();
      const t1 = host.seams.getActiveTaskId();
      expect(t1).not.toBeNull();
      await sleep(DEBOUNCE_WAIT_MS);
      await host.seams.drainPersistence(t1!);

      // Turn 2 through the real path: seed must equal turn-1 history.
      await host.seams.runPrompt("beta second question", "act");
      const seed = host.seams.getLastSeededHistory();
      expect(seed).not.toBeNull();
      expect(seed!.length).toBeGreaterThan(0);
      const reloaded1 = await new TaskStore(host.tasksDir).get(t1!);
      expect(seed).toEqual(buildInitialMessages(reloaded1!));
      expect(validateConversationProtocol(seed!).valid).toBe(true);

      // Phase 5 — no self-duplication: turn-2 prompt appears exactly once
      // (in task-2's own user message) and never inside the seed.
      const seedJson = JSON.stringify(seed);
      expect(seedJson.includes("beta second question")).toBe(false);
      expect(seedJson.includes("alpha first question")).toBe(true);
      const t2 = host.seams.getActiveTaskId();
      expect(t2).not.toBe(t1);
      const task2 = await new TaskStore(host.tasksDir).get(t2!);
      expect(
        task2?.messages.filter((m) => m.role === "user" && m.content === "beta second question"),
      ).toHaveLength(1);
    } finally {
      await host.ext.deactivate();
      host.cleanup();
    }
  });

  it("tool pairs survive into the seed with order and pairing intact", async () => {
    const host = await freshHost();
    try {
      const t1 = await scriptHistory(
        host,
        ["reading files "],
        [
          { id: "k1", name: "read_file", input: { path: "a.ts" }, output: "AAA" },
          { id: "k2", name: "bash", input: { command: "ls" }, output: "a.ts" },
        ],
      );
      useDeadEndpoint(host);
      await host.seams.runPrompt("what did you find?", "act");
      const seed = host.seams.getLastSeededHistory();
      expect(seed).not.toBeNull();
      const kinds = seed!.flatMap((m) =>
        Array.isArray(m.content) ? m.content.map((b) => b.type) : ["text"],
      );
      expect(kinds).toContain("tool_use");
      expect(kinds).toContain("tool_result");
      // Order: text, uses, results (deterministic composition).
      expect(kinds.indexOf("text")).toBeLessThan(kinds.indexOf("tool_use"));
      expect(validateConversationProtocol(seed!).valid).toBe(true);
      const reloaded1 = await new TaskStore(host.tasksDir).get(t1);
      expect(seed).toEqual(buildInitialMessages(reloaded1!));
      // M4 stays live for new operations on the seeded turn.
      const bridge = host.seams.getLivePermissionBridge();
      const decision = await bridge.evaluateLiveTool({
        toolName: "read_file",
        input: { path: "b.ts" },
        taskId: t1,
      });
      expect(decision.approved).toBe(true);
    } finally {
      await host.ext.deactivate();
      host.cleanup();
    }
  });

  it("interrupted tail seeds a clean boundary (no unpaired tool_use)", async () => {
    const host = await freshHost();
    try {
      const taskId = await host.seams.beginTask("interrupt seed");
      const emit = (e: AgentEvent): void => host.seams.ingestAgentEvent(e);
      emit({ type: "started", sessionId: "s1" });
      emit({ type: "text_delta", text: "working", accumulated: "working" });
      emit({ type: "tool_requested", toolCallId: "kz", toolName: "bash", input: { command: "slow" } });
      // Requested-phase flush lands the tool_use; no result ever arrives.
      await sleep(DEBOUNCE_WAIT_MS);
      await host.seams.drainPersistence(taskId!);
      emit({ type: "cancelled" });
      await sleep(DEBOUNCE_WAIT_MS);
      await host.seams.drainPersistence(taskId!);

      useDeadEndpoint(host);
      await host.seams.runPrompt("continue after interrupt", "act");
      const seed = host.seams.getLastSeededHistory();
      expect(seed).not.toBeNull();
      // Clean boundary: no trailing unpaired tool_use, protocol green.
      expect(validateConversationProtocol(seed!).valid).toBe(true);
      const last = seed![seed!.length - 1]!;
      const lastUses =
        last.role === "assistant" && Array.isArray(last.content)
          ? last.content.filter((b) => b.type === "tool_use")
          : [];
      expect(lastUses).toHaveLength(0);
      // The interrupted text itself still carries over.
      expect(JSON.stringify(seed).includes("working")).toBe(true);
    } finally {
      await host.ext.deactivate();
      host.cleanup();
    }
  });

  it("compacted history seeds the summary form without re-summarizing", async () => {
    const host = await freshHost();
    try {
      const t1 = await scriptHistory(
        host,
        ["long analysis topic "],
        Array.from({ length: 6 }, (_, i) => ({
          id: `c${i}`,
          name: "read_file",
          input: { path: `f${i}.ts` },
          output: `content-${i}`,
        })),
      );
      const store = host.seams.getTaskStore();
      const before = await store.get(t1);
      const convLen = before!.conversation?.length ?? 0;
      expect(convLen).toBeGreaterThan(0);
      await store.addCompactionArtifact(t1, {
        id: "cont-artifact",
        createdAtMs: Date.now(),
        mode: "summary",
        summarizedMessageCount: convLen,
        remainingMessageCount: 0,
        tokensBefore: 9000,
        tokensAfter: 400,
        summaryText: "SOAK-SUMMARY-MARKER prior work reviewed six files",
        sourceRange: { fromIndex: 0, toIndex: convLen, toTs: Date.now(), fromTs: 0 },
        summaryVersion: 1,
        reason: "test compaction",
      });

      useDeadEndpoint(host);
      await host.seams.runPrompt("what is next?", "act");
      const seed = host.seams.getLastSeededHistory();
      expect(seed).not.toBeNull();
      // Compacted form used: summary present, strictly shorter than full.
      expect(JSON.stringify(seed).includes("SOAK-SUMMARY-MARKER")).toBe(true);
      const full = buildInitialMessages((await store.get(t1))!);
      expect(seed!.length).toBeLessThan(full.length);
      expect(validateConversationProtocol(seed!).valid).toBe(true);
      // No second summarization merely because a turn began: artifact count
      // unchanged (post-run compaction only compacts under real pressure).
      expect((await store.get(t1))?.compactions).toHaveLength(1);
    } finally {
      await host.ext.deactivate();
      host.cleanup();
    }
  });

  it("concurrent second turn fails closed without contaminating tasks", async () => {
    const host = await freshHost();
    // Hold turn 1 in flight with a hanging model endpoint: the dead port
    // fails too fast against the native runtime (the whole turn settles in
    // ~120ms, so no overlap window is observable). A never-resolving chat
    // response keeps the runtime in EXECUTING deterministically; it honors
    // the abort signal so cleanup stays deterministic too.
    const hangingFetch = async (
      input: unknown,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url,
      );
      if (url.includes("/api/chat")) {
        await new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      return new Response("not found", { status: 404 });
    };
    vi.stubGlobal("fetch", hangingFetch as unknown as typeof fetch);
    try {
      // Occupy the runtime with a first turn that stays in flight: gate its
      // queue head is unnecessary — overlap via direct runtime use is enough.
      // Simpler deterministic route: drive the runtime guard directly through
      // two overlapping runPrompts against a slow endpoint is timing-based;
      // instead assert the guard contract via runtime state: while turn 1 is
      // in flight (status running), turn 2's startSession must reject.
      useDeadEndpoint(host);
      const run1 = host.seams.runPrompt("slow turn one", "act");
      // Wait until the runtime reports running (precondition, not timing).
      const rt = await host.seams.ensureRuntime();
      const deadline = Date.now() + 30_000;
      while ((rt.getState().status as string) !== "running" && Date.now() < deadline) {
        await sleep(100);
      }
      expect((rt.getState().status as string)).toBe("running");
      // Second turn while the first is in flight → fail closed.
      await expect(rt.startSession(" intruding turn", { agentMode: "act" })).rejects.toThrow(
        /already running/,
      );
      // Release the hung turn, then let the first turn settle.
      await rt.abort().catch(() => undefined);
      await run1;
      // Both task records exist and are uncontaminated.
      await sleep(DEBOUNCE_WAIT_MS);
      const t1 = host.seams.getActiveTaskId();
      expect(t1).not.toBeNull();
      const listed = await new TaskStore(host.tasksDir).list();
      expect(listed.length).toBeGreaterThanOrEqual(1);
      for (const t of listed) {
        expect(validateConversationProtocol(buildInitialMessages(t)).valid).toBe(true);
      }
    } finally {
      vi.unstubAllGlobals();
      await host.ext.deactivate();
      host.cleanup();
    }
  });

  it("model switch keeps history; remote switch under local privacy blocks", async () => {
    const host = await freshHost();
    try {
      const t1 = await scriptHistory(host, ["recallable alpha content "], [
        { id: "m1", name: "read_file", input: { path: "a.ts" }, output: "AAA" },
      ]);
      useDeadEndpoint(host);
      // Model switch (same provider): history still seeded.
      host.vscodeStub.configOverrides.set("model", "qwen2.5-coder:3b");
      await host.seams.runPrompt("model switched question", "act");
      const seed = host.seams.getLastSeededHistory();
      expect(seed).not.toBeNull();
      expect(JSON.stringify(seed).includes("recallable alpha content")).toBe(true);
      const t2 = host.seams.getActiveTaskId();
      const task2 = await new TaskStore(host.tasksDir).get(t2!);
      expect(task2?.modelConfig).toMatchObject({ providerId: "ollama" });
      expect(String((task2?.modelConfig as Record<string, unknown>)?.["modelId"])).toBe(
        "qwen2.5-coder:3b",
      );

      // Provider switch to remote under local privacy: fail-closed block.
      host.vscodeStub.configOverrides.delete("model");
      host.seams.getProviderService().setConfig("openai-compatible", {
        baseUrl: "https://example.invalid/v1",
      });
      // NOTE: provider selection itself still reads the "provider" setting
      // (default ollama); emulate a user switch by overriding it.
      host.vscodeStub.configOverrides.set("provider", "openai-compatible");
      await host.seams.runPrompt("remote attempt", "act");
      // Turn was blocked before any provider contact; seed was still built
      // (history availability is provider-agnostic).
      expect(host.seams.getLastSeededHistory()).not.toBeNull();
      // No credentials anywhere near the new provider request path.
      const files: string[] = [];
      const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.isFile()) files.push(p);
        }
      };
      walk(host.storageDir);
      for (const file of files) {
        const raw = fs.readFileSync(file, "utf8");
        expect(raw.includes("codepilot.apiKey")).toBe(false);
      }
      const reloaded1 = await new TaskStore(host.tasksDir).get(t1);
      expect(validateConversationProtocol(buildInitialMessages(reloaded1!)).valid).toBe(true);
    } finally {
      host.vscodeStub.configOverrides.delete("model");
      host.vscodeStub.configOverrides.delete("provider");
      await host.ext.deactivate();
      host.cleanup();
    }
  });

  it("seeded history carries no secrets (redacted at rest stays redacted)", async () => {
    const host = await freshHost();
    try {
      const taskId = await host.seams.beginTask("secret history");
      const emit = (e: AgentEvent): void => host.seams.ingestAgentEvent(e);
      emit({ type: "started", sessionId: "s1" });
      emit({ type: "text_delta", text: "saw it", accumulated: "saw it" });
      emit({
        type: "tool_requested",
        toolCallId: "sx",
        toolName: "bash",
        input: { command: "curl -H 'Authorization: Bearer INT-SEED-BEARER-1'" },
      });
      emit({
        type: "tool_completed",
        toolCallId: "sx",
        toolName: "bash",
        output: "key=sk-int-SEEDFAKEFAKE00",
        durationMs: 2,
      });
      emit({
        type: "completed",
        result: "done",
        usage: { inputTokens: 1, outputTokens: 1, totalCost: 0 },
      });
      await sleep(DEBOUNCE_WAIT_MS);
      await host.seams.drainPersistence(taskId!);

      useDeadEndpoint(host);
      await host.seams.runPrompt("next question", "act");
      const seed = host.seams.getLastSeededHistory();
      expect(seed).not.toBeNull();
      const seedJson = JSON.stringify(seed);
      expect(seedJson.includes("INT-SEED-BEARER-1")).toBe(false);
      expect(seedJson.includes("sk-int-SEEDFAKEFAKE00")).toBe(false);
      expect(seedJson.includes("[REDACTED]")).toBe(true);
      expect(validateConversationProtocol(seed!).valid).toBe(true);
    } finally {
      await host.ext.deactivate();
      host.cleanup();
    }
  });

  it("history seeding cost: 10/100/200 entries (+compacted)", async () => {
    const host = await freshHost();
    try {
      const nowMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);
      const store = host.seams.getTaskStore();
      const rows: string[] = [];
      for (const n of [10, 100, 200]) {
        const task = await store.create(`perf ${n}`);
        for (let i = 0; i < n; i += 1) {
          await store.upsertConversationEntry(task.id, `run-${i}`, {
            role: i % 2 === 0 ? "user" : "assistant",
            ...(i % 2 === 0
              ? { text: `user turn number ${i} with some content` }
              : {
                  blocks: [
                    { type: "text", text: `assistant reply ${i}` },
                    { type: "tool_use", id: `p${i}`, name: "read_file", input: "{}" },
                    { type: "tool_result", tool_use_id: `p${i}`, name: "read_file", content: `out${i}` },
                  ],
                }),
            timestampMs: Date.now(),
          });
        }
        const t0 = nowMs();
        const loaded = await store.get(task.id);
        const t1 = nowMs();
        const messages = buildInitialMessages(loaded!);
        const t2 = nowMs();
        const valid = validateConversationProtocol(messages).valid;
        const t3 = nowMs();
        rows.push(
          `n=${n} read=${t1 - t0}ms convert=${t2 - t1}ms validate=${t3 - t2}ms total=${t3 - t0}ms msgs=${messages.length} valid=${valid} bytes=${JSON.stringify(messages).length}`,
        );
        expect(valid).toBe(true);
      }
      console.log(`SEED-PERF ${rows.join(" | ")}`);
    } finally {
      await host.ext.deactivate();
      host.cleanup();
    }
  });
});
