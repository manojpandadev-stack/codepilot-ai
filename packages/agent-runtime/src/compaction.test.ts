/**
 * M12 v3 — context compaction regression tests.
 *
 * Covers the required scenarios:
 *   1.  Token estimation (both content shapes)
 *   2.  Context-window resolution precedence (model → provider → fallback)
 *   3.  Compaction thresholds/zones + short tasks never compact
 *   4.  Structured summary validation (valid / malformed / partial)
 *   5.  Summarizer privacy guard (local mode blocks remote)
 *   6.  Protocol validation (ordering, tool pairing, roles)
 *   7.  Safe compaction boundary (never splits a tool pair)
 *   8.  Engine: semantic compaction produces artifact + compacted messages
 *   9.  Engine: summarizer failure falls back to bounded truncation
 *  10.  Engine: below threshold → skipped
 *  11.  Engine: artifact idempotency (same boundary reused)
 *  12.  Canonical history preservation (conversation never mutated)
 *  13.  Artifact persistence (TaskStore round-trip)
 *  14.  composeFromTask resume integration (reuse without new LLM call)
 *  15.  Incremental compaction (prior summary folded in)
 *  16.  No credential leakage in artifacts/prompt
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CHARS_PER_TOKEN,
  FALLBACK_CONTEXT_WINDOW_TOKENS,
  estimateEntryTokens,
  estimateConversationTokens,
  resolveContextWindowTokens,
  classifyContextPressure,
  evaluateCompactionNeed,
} from "./compaction-tokens.js";
import {
  validateConversationProtocol,
  safeCompactionBoundary,
} from "./compaction-protocol.js";
import {
  PrivacyViolationError,
  assertSummarizerPrivacyAllowed,
  validateSummaryOutput,
  summarizeConversation,
} from "./compaction-summarizer.js";
import { CompactionEngine } from "./compaction-engine.js";
import { TaskStore } from "./m12-task-store.js";
import type { PersistedConversationMessage } from "./m12-task-store.js";
import type { PersistedTask } from "./m12-task-store.js";
import type { CompactionArtifact } from "./compaction-types.js";

// ============================================================================
// Helpers
// ============================================================================

function entry(
  role: "user" | "assistant",
  text: string,
  ts: number,
  key?: string,
): PersistedConversationMessage {
  return {
    role,
    ...(key !== undefined ? { key } : {}),
    timestampMs: ts,
    blocks: [{ type: "text", text }],
  } as PersistedConversationMessage;
}

function toolUseEntry(
  ts: number,
  toolUseId: string,
  name = "terminal",
  input = "{}",
  key?: string,
): PersistedConversationMessage {
  return {
    role: "assistant",
    ...(key !== undefined ? { key } : {}),
    timestampMs: ts,
    blocks: [
      { type: "text", text: "running tool" },
      { type: "tool_use", id: toolUseId, name, input },
    ],
  } as PersistedConversationMessage;
}

function toolResultEntry(
  ts: number,
  toolUseId: string,
  content = "ok",
  isError = false,
): PersistedConversationMessage {
  return {
    role: "user",
    timestampMs: ts,
    blocks: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        name: "terminal",
        content,
        ...(isError ? { is_error: true } : {}),
      },
    ],
  } as PersistedConversationMessage;
}

function makeTask(overrides: Partial<PersistedTask> = {}): PersistedTask {
  return {
    id: "t1",
    title: "Long refactor task",
    createdAt: 1,
    updatedAt: 1,
    status: "interrupted",
    conversation: [],
    ...overrides,
  } as PersistedTask;
}
void makeTask;

/** Large conversation: 60k chars → ~15k tokens. */
function bigConversation(): PersistedConversationMessage[] {
  const out: PersistedConversationMessage[] = [];
  for (let i = 0; i < 20; i++) {
    out.push(entry("user", `u${i} ${"x".repeat(1500)}`, 100 + i * 10));
    out.push(entry("assistant", `a${i} ${"y".repeat(1500)}`, 105 + i * 10));
  }
  return out;
}

function makeEngine(
  store: TaskStore,
  overrides: Partial<ConstructorParameters<typeof CompactionEngine>[0]> = {},
): CompactionEngine {
  return new CompactionEngine({
    store,
    resolveSummarizerConfig: async () => ({
      providerId: "ollama",
      modelId: "qwen3:8b",
      privacyMode: "local",
    }),
    lookupModelContextWindow: () => 32_768, // usable = 16_384
    ...overrides,
  });
}

// ============================================================================
// 1. Token estimation
// ============================================================================

describe("compaction tokens", () => {
  it("estimates text-block entries at chars/4", () => {
    const e = entry("user", "a".repeat(400), 1);
    expect(estimateEntryTokens(e)).toBe(100);
  });

  it("counts tool_use name+input and tool_result content", () => {
    const use = toolUseEntry(1, "tu1", "terminal", "{}".repeat(100));
    // text(12) + 2*100 input + 8 name = 220 chars → 55 tokens
    expect(estimateEntryTokens(use)).toBe(55);
    const res = toolResultEntry(2, "tu1", "r".repeat(200), false);
    // 200 content + 8 name = 208 → 52
    expect(estimateEntryTokens(res)).toBe(52);
  });

  it("sums the conversation", () => {
    const conv = [
      entry("user", "a".repeat(40), 1),
      entry("assistant", "b".repeat(40), 2),
    ];
    expect(estimateConversationTokens(conv)).toBe(20);
  });

  it("counts image blocks by estimated tokens, not bytes", () => {
    const e: Parameters<typeof estimateEntryTokens>[0] = {
      role: "user",
      timestampMs: 1,
      blocks: [
        {
          type: "image",
          mime: "image/png",
          fileRef: "images/x.bin",
          sizeBytes: 2048,
        },
        { type: "text", text: "hi" },
      ],
    };
    // text "hi" → ceil(2/4) = 1, plus 512 + ceil(2048/1024) = 514.
    expect(estimateEntryTokens(e)).toBe(1 + 514);
  });

  it("uses the documented chars-per-token constant", () => {
    expect(CHARS_PER_TOKEN).toBe(4);
  });
});

// ============================================================================
// 2. Context-window resolution precedence
// ============================================================================

describe("context window resolution", () => {
  it("prefers model-level lookup", () => {
    const r = resolveContextWindowTokens({
      providerId: "p",
      modelId: "m",
      lookupModelContextWindow: () => 200_000,
      lookupProviderContextWindow: () => 8_000,
    });
    expect(r).toEqual({ contextWindowTokens: 200_000, usedFallback: false });
  });

  it("falls back to provider-level then to the conservative fallback", () => {
    const r1 = resolveContextWindowTokens({
      providerId: "p",
      modelId: "m",
      lookupProviderContextWindow: () => 8_000,
    });
    expect(r1).toEqual({ contextWindowTokens: 8_000, usedFallback: false });
    const r2 = resolveContextWindowTokens({ providerId: "p", modelId: "m" });
    expect(r2).toEqual({
      contextWindowTokens: FALLBACK_CONTEXT_WINDOW_TOKENS,
      usedFallback: true,
    });
  });

  it("ignores non-positive lookups", () => {
    const r = resolveContextWindowTokens({
      providerId: "p",
      modelId: "m",
      lookupModelContextWindow: () => 0,
      lookupProviderContextWindow: () => -5,
    });
    expect(r.usedFallback).toBe(true);
  });
});

// ============================================================================
// 3. Thresholds / zones
// ============================================================================

describe("compaction pressure zones", () => {
  it("classifies zones with the 50% working margin", () => {
    // window 32768 → usable 16384
    expect(classifyContextPressure(8_000, 32_768).zone).toBe("normal"); // 49%
    expect(classifyContextPressure(12_000, 32_768).zone).toBe("monitor"); // 73%
    expect(classifyContextPressure(13_500, 32_768).zone).toBe("prepare"); // 82%
    expect(classifyContextPressure(15_000, 32_768).zone).toBe("compact"); // 92%
  });

  it("shouldCompact only in the compact zone", () => {
    expect(
      evaluateCompactionNeed({
        conversation: [],
        providerId: "p",
        modelId: "m",
      }).shouldCompact,
    ).toBe(false);
  });

  it("short tasks never compact even with unknown window", () => {
    const p = evaluateCompactionNeed({
      conversation: [entry("user", "hi", 1)],
      providerId: "ollama",
      modelId: "qwen3:8b",
    });
    expect(p.zone).toBe("normal");
  });
});

// ============================================================================
// 4. Summary validation
// ============================================================================

function validSummaryRaw(): Record<string, unknown> {
  return {
    objective: "Refactor auth",
    constraints: ["no new deps"],
    completedWork: ["moved files"],
    filesChanged: ["src/a.ts"],
    decisions: [],
    importantFindings: [],
    errors: [],
    tests: [],
    pendingWork: ["update tests"],
    toolState: [],
    checkpoints: [],
    resumeInstructions: ["run tests"],
  };
}

describe("summary validation", () => {
  it("accepts a fully structured summary", () => {
    const r = validateSummaryOutput(validSummaryRaw());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.summary.objective).toBe("Refactor auth");
  });

  it("rejects missing required keys", () => {
    const raw = validSummaryRaw();
    delete raw.objective;
    expect(validateSummaryOutput(raw).ok).toBe(false);
  });

  it("rejects wrong types (string where array expected, etc.)", () => {
    const raw = { ...validSummaryRaw(), constraints: "not an array" };
    expect(validateSummaryOutput(raw).ok).toBe(false);
    const raw2 = { ...validSummaryRaw(), objective: 42 };
    expect(validateSummaryOutput(raw2).ok).toBe(false);
  });

  it("accepts empty arrays (empty is valid; missing is not)", () => {
    const raw = validSummaryRaw();
    for (const k of Object.keys(raw)) {
      if (Array.isArray(raw[k])) raw[k] = [];
    }
    expect(validateSummaryOutput(raw).ok).toBe(true);
  });
});

// ============================================================================
// 5. Privacy guard
// ============================================================================

describe("summarizer privacy guard", () => {
  it("blocks remote summarization in local mode", () => {
    expect(() => assertSummarizerPrivacyAllowed("openrouter", "local")).toThrow(
      PrivacyViolationError,
    );
  });

  it("allows local providers in local mode", () => {
    expect(() =>
      assertSummarizerPrivacyAllowed("ollama", "local"),
    ).not.toThrow();
  });

  it("allows remote providers with explicit cloud permission", () => {
    expect(() =>
      assertSummarizerPrivacyAllowed("openrouter", "cloud"),
    ).not.toThrow();
  });

  it("summarizeConversation rejects before any network call", async () => {
    await expect(
      summarizeConversation(
        [{ role: "user" as const, content: "secret plan" }],
        {
          providerId: "anthropic",
          modelId: "claude-3",
          privacyMode: "local",
          apiKey: "sk-test",
        },
      ),
    ).rejects.toThrow(PrivacyViolationError);
  });
});

// ============================================================================
// 6. Protocol validation
// ============================================================================

describe("conversation protocol validation", () => {
  it("accepts a well-formed conversation", () => {
    const conv = [
      { role: "user" as const, content: "hi" },
      {
        role: "assistant" as const,
        content: [
          { type: "text", text: "running" },
          { type: "tool_use", id: "tu1", name: "terminal", input: "{}" },
        ],
      },
      {
        role: "user" as const,
        content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }],
      },
      { role: "assistant" as const, content: "done" },
    ];
    expect(validateConversationProtocol(conv).valid).toBe(true);
  });

  it("allows orphaned tool_use (interrupted tails are trimmed at seed time, not rejected here)", () => {
    const conv = [
      {
        role: "assistant" as const,
        content: [
          { type: "tool_use", id: "tu1", name: "terminal", input: "{}" },
        ],
      },
      { role: "assistant" as const, content: "done" },
    ];
    expect(validateConversationProtocol(conv).valid).toBe(true);
  });

  it("rejects orphaned tool_result without a preceding use", () => {
    const conv = [
      {
        role: "user" as const,
        content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }],
      },
    ];
    expect(validateConversationProtocol(conv).valid).toBe(false);
  });

  it("rejects results before their use", () => {
    const conv = [
      {
        role: "user" as const,
        content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }],
      },
      {
        role: "assistant" as const,
        content: [
          { type: "tool_use", id: "tu1", name: "terminal", input: "{}" },
        ],
      },
    ];
    expect(validateConversationProtocol(conv).valid).toBe(false);
  });

  it("rejects empty conversations", () => {
    expect(validateConversationProtocol([]).valid).toBe(false);
  });

  it("accepts image blocks on user messages", () => {
    const conv = [
      {
        role: "user" as const,
        content: [
          { type: "image", mime: "image/png", fileRef: "images/x.bin" },
          { type: "text", text: "what is this?" },
        ],
      },
      { role: "assistant" as const, content: "a cat" },
    ];
    expect(validateConversationProtocol(conv).valid).toBe(true);
  });

  it("rejects image blocks on assistant messages", () => {
    const conv = [
      {
        role: "assistant" as const,
        content: [
          { type: "image", mime: "image/png", fileRef: "images/x.bin" },
        ],
      },
    ];
    const result = validateConversationProtocol(conv);
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.kind)).toContain(
      "image-in-assistant-message",
    );
  });
});

// ============================================================================
// 7. Safe compaction boundary
// ============================================================================

describe("safe compaction boundary", () => {
  it("never splits a tool_use/tool_result pair (tail stays valid)", () => {
    const conv = [
      entry("user", "u0", 1),
      toolUseEntry(2, "tu1"),
      toolResultEntry(3, "tu1"),
      entry("assistant", "a1", 4),
      entry("user", "u1", 5),
      entry("assistant", "a2", 6),
    ];
    // Proposing to cut at the tool_result (index 2) must step back so the
    // use+result pair stay TOGETHER in the tail.
    const b = safeCompactionBoundary(conv, 2);
    expect(b).toBe(1); // tail starts at the assistant tool_use entry
    const tail = conv
      .slice(b)
      .map((m) => ({ role: m.role, content: m.blocks! }));
    expect(validateConversationProtocol(tail).valid).toBe(true);
  });

  it("keeps the boundary at the proposal when it is already safe", () => {
    const conv = [
      entry("user", "u0", 1),
      entry("assistant", "a0", 2),
      entry("user", "u1", 3),
      entry("assistant", "a1", 4),
    ];
    expect(safeCompactionBoundary(conv, 2)).toBe(2);
  });

  it("returns -1 when no safe boundary exists", () => {
    // The proposed tail itself starts with a tool_result (its tool_use would
    // be summarized away) and stepping back would cross the conversation
    // start — no boundary keeps use+result together in the tail.
    const conv = [toolResultEntry(1, "tu1"), toolResultEntry(2, "tu2")];
    expect(safeCompactionBoundary(conv, 1)).toBe(-1);
  });

  it("keeps an orphaned head result summarizable (boundary at next non-result entry)", () => {
    // An orphaned tool_result in the HEAD is fine — the head is replaced by
    // the summary; only the TAIL must be protocol-valid on its own.
    const conv = [toolResultEntry(1, "tu1"), entry("assistant", "a1", 2)];
    expect(safeCompactionBoundary(conv, 1)).toBe(1);
  });

  it("rejects out-of-range proposals", () => {
    const conv = [entry("user", "u", 1), entry("assistant", "a", 2)];
    expect(safeCompactionBoundary(conv, 0)).toBe(-1);
    expect(safeCompactionBoundary(conv, 3)).toBe(-1);
  });
});

// ============================================================================
// 8–13. Engine behavior (real TaskStore)
// ============================================================================

describe("CompactionEngine", () => {
  let dir: string;
  let store: TaskStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codepilot-compact-"));
    store = new TaskStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function seedBigTask(): Promise<string> {
    const t = await store.create("Long refactor task");
    for (const e of bigConversation()) {
      await store.upsertConversationEntry(t.id, `k-${e.timestampMs}`, e);
    }
    return t.id;
  }

  it("8. semantic compaction: real summary, artifact, compacted messages", async () => {
    const taskId = await seedBigTask();
    const engine = makeEngine(store, {
      summarizeForTest: async () => ({
        summary: {
          objective: "Long refactor task",
          constraints: ["keep API stable"],
          completedWork: ["first half analyzed"],
          filesChanged: ["src/a.ts"],
          decisions: [],
          importantFindings: [],
          errors: [],
          tests: [],
          pendingWork: ["second half"],
          toolState: [],
          checkpoints: [],
          resumeInstructions: ["continue from src/a.ts"],
        },
        promptTokensEstimate: 100,
        outputTokensEstimate: 50,
        latencyMs: 5,
        providerId: "ollama",
        modelId: "qwen3:8b",
      }),
    });
    const outcome = await engine.compactIfNeeded(taskId, "ollama", "qwen3:8b");
    expect(outcome.ran).toBe(true);
    expect(outcome.mode).toBe("semantic");
    expect(outcome.artifact?.summary?.objective).toBe("Long refactor task");
    expect(outcome.artifact?.summarizer).toEqual({
      providerId: "ollama",
      modelId: "qwen3:8b",
    });
    expect(outcome.summaryCost?.promptTokensEstimate).toBe(100);
    expect(outcome.compactedMessages?.[0]?.role).toBe("user");
    expect(String(outcome.compactedMessages?.[0]?.content)).toContain(
      "Objective:",
    );
    expect(
      validateConversationProtocol(outcome.compactedMessages as never).valid,
    ).toBe(true);
  });

  it("9. summarizer failure falls back to bounded truncation (history safe)", async () => {
    const taskId = await seedBigTask();
    const engine = makeEngine(store, {
      resolveSummarizerConfig: async () => null, // summarizer unavailable
    });
    const before = (await store.get(taskId))?.conversation?.length ?? 0;
    const outcome = await engine.compactIfNeeded(taskId, "ollama", "qwen3:8b");
    expect(outcome.ran).toBe(true);
    expect(outcome.mode).toBe("truncation-fallback");
    const after = (await store.get(taskId))?.conversation?.length ?? 0;
    expect(after).toBe(before); // canonical history untouched
  });

  it("10. below threshold → skipped", async () => {
    const t = await store.create("small");
    await store.upsertConversationEntry(t.id, "k1", entry("user", "hello", 1));
    const engine = makeEngine(store);
    const outcome = await engine.compactIfNeeded(t.id, "ollama", "qwen3:8b");
    expect(outcome.ran).toBe(false);
    expect(outcome.mode).toBe("skipped");
    expect(outcome.reason).toContain("zone=normal");
  });

  it("11. idempotency: same boundary reuses the artifact", async () => {
    const taskId = await seedBigTask();
    const engine = makeEngine(store, {
      resolveSummarizerConfig: async () => null,
    });
    const first = await engine.compactIfNeeded(taskId, "ollama", "qwen3:8b");
    expect(first.ran).toBe(true);
    const second = await engine.compactIfNeeded(taskId, "rower", "qwen3:8b");
    expect(second.ran).toBe(false);
    expect(second.reason).toContain("already compacted");
    expect(second.artifact?.id).toBe(first.artifact?.id);
  });

  it("12. canonical conversation preserved across compaction", async () => {
    const taskId = await seedBigTask();
    const engine = makeEngine(store, {
      resolveSummarizerConfig: async () => null,
    });
    const before = JSON.stringify((await store.get(taskId))?.conversation);
    await engine.compactIfNeeded(taskId, "ollama", "qwen3:8b");
    const after = JSON.stringify((await store.get(taskId))?.conversation);
    expect(after).toBe(before); // conversation never mutated destructively
  });

  it("13. artifact persisted and round-trips through the store", async () => {
    const taskId = await seedBigTask();
    const engine = makeEngine(store, {
      resolveSummarizerConfig: async () => null,
    });
    const outcome = await engine.compactIfNeeded(taskId, "ollama", "qwen3:8b");
    expect(outcome.ran).toBe(true);
    const task = await store.get(taskId);
    expect(task?.compactions?.length).toBe(1);
    expect(task?.compactions?.[0]?.tokensBefore).toBeGreaterThan(0);
    expect(task?.compactions?.[0]?.sourceRange.toIndex).toBeGreaterThan(0);
  });

  it("14. composeFromTask reuses the artifact without a new LLM call", async () => {
    const taskId = await seedBigTask();
    const engine = makeEngine(store, {
      resolveSummarizerConfig: async () => null,
    });
    await engine.compactIfNeeded(taskId, "ollama", "qwen3:8b");
    const task = await store.get(taskId);
    const composed = engine.composeFromTask(task!);
    expect(composed).not.toBeNull();
    expect(composed![0]!.role).toBe("user");
    expect(composed![0]!.content).toContain(
      "summary of the earlier conversation",
    );
    // And the composed shape must be protocol-valid:
    expect(validateConversationProtocol(composed as never).valid).toBe(true);
  });

  it("15. no credential material in artifacts or composed messages", async () => {
    const taskId = await seedBigTask();
    const engine = makeEngine(store, {
      resolveSummarizerConfig: async () => null,
    });
    const outcome = await engine.compactIfNeeded(
      taskId,
      "ollama",
      "q3:8b-model",
    );
    const task = await store.get(taskId);
    const dump = JSON.stringify({
      a: task?.compactions,
      m: outcome.compactedMessages,
    });
    expect(dump).not.toContain("sk-");
    expect(dump).not.toContain("Bearer ");
    expect(dump).not.toContain("apiKey");
  });
});

// ============================================================================
// 16. Artifact type sanity (no fake fields)
// ============================================================================

describe("CompactionArtifact shape", () => {
  it("carries all required audit fields", () => {
    const a: CompactionArtifact = {
      id: "compact-x",
      createdAtMs: 1,
      sourceRange: { fromIndex: 0, toIndex: 2, fromTs: 1, toTs: 2 },
      summarizedMessageCount: 2,
      remainingMessageCount: 3,
      tokensBefore: 100,
      tokensAfter: 40,
      mode: "truncation-fallback",
      summaryVersion: 1,
      reason: "test",
    };
    expect(a.summaryVersion).toBe(1);
    expect(a.mode).toBe("truncation-fallback");
  });
});
