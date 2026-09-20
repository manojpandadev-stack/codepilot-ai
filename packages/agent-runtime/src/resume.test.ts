/**
 * M12 v2 — verbatim resume regression tests.
 *
 * Covers the resume-contract scenarios from the audit:
 *   1.  Full conversation reconstruction (round-trip to wire shape)
 *   2.  Message ordering preservation
 *   3.  Tool call + tool result restoration (incl. re-split to protocol shape)
 *   4.  Provider/model restoration plan (task config wins when known)
 *   5.  NO credentials in the provider plan (host re-resolves them)
 *   6.  No API-key persistence (redaction through conversation capture)
 *   7.  Completed-task rejection
 *   8.  Corrupt/partial task handling (quarantine, no crash)
 *   9.  Resume after cancellation (interrupted → resumable, fidelity info)
 *  11.  Fidelity classification (FULL / PARTIAL / LIMITED) is honest
 *  12.  Provider plan falls back when the task provider is unknown
 *  14.  Duplicate message prevention (keyed upsert is idempotent)
 *  15.  Backward compatibility with v1 TaskStore records
 *  16.  Wire-shape invariants (tool_result follows its assistant tool_use)
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  TaskStore,
  type PersistedTask,
  type PersistedConversationMessage,
} from "./m12-task-store.js";
import {
  buildInitialMessages,
  classifyResumeFidelity,
  planProviderRestore,
} from "./resume.js";

describe("verbatim resume — reconstruction", () => {
  let dir: string;
  let store: TaskStore;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-resume-"));
    store = new TaskStore(dir);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("1. reconstructs a full conversation round-trip (user → assistant+tools)", async () => {
    const task = await store.create("Explain the repo");
    await store.appendMessage(task.id, "user", "Inspect the project");
    await store.upsertConversationEntry(task.id, "run-1", {
      role: "assistant",
      blocks: [
        { type: "text", text: "I will read the files." },
        {
          type: "tool_use",
          id: "call_1",
          name: "read_file",
          input: '{"path":"a.ts"}',
        },
        {
          type: "tool_result",
          tool_use_id: "call_1",
          name: "read_file",
          content: "file body",
        },
      ],
      timestampMs: Date.now(),
    });
    const reloaded = await store.get(task.id);
    expect(reloaded).not.toBeNull();
    const msgs = buildInitialMessages(reloaded!);
    expect(msgs.length).toBe(3);
    expect(msgs[0]).toMatchObject({
      role: "user",
      content: "Inspect the project",
    });
    expect(msgs[1]).toMatchObject({ role: "assistant" });
    const blocks = msgs[1]!.content as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual(["text", "tool_use"]);
    // Tool result re-split into a following USER message (protocol shape).
    expect(msgs[2]!.role).toBe("user");
    const resultBlocks = msgs[2]!.content as Array<{ type: string }>;
    expect(resultBlocks.map((b) => b.type)).toEqual(["tool_result"]);
  });

  it("2. preserves message ordering across mixed entries", async () => {
    const task = await store.create("Ordering");
    await store.appendMessage(task.id, "user", "first");
    await store.upsertConversationEntry(task.id, "run-a", {
      role: "assistant",
      blocks: [{ type: "text", text: "reply A" }],
      timestampMs: 1,
    });
    await store.appendMessage(task.id, "user", "second");
    await store.upsertConversationEntry(task.id, "run-b", {
      role: "assistant",
      blocks: [{ type: "text", text: "reply B" }],
      timestampMs: 2,
    });
    const reloaded = (await store.get(task.id))!;
    const msgs = buildInitialMessages(reloaded);
    expect(
      msgs.map((m) =>
        typeof m.content === "string"
          ? m.content
          : (m.content[0] as { text?: string }).text,
      ),
    ).toEqual(["first", "reply A", "second", "reply B"]);
  });

  it("2b. preserves image blocks on user entries (fileRef form)", async () => {
    const task = await store.create("Image resume");
    await store.upsertConversationEntry(task.id, "run-img", {
      role: "user",
      timestampMs: 3,
      blocks: [
        {
          type: "image",
          mime: "image/png",
          fileRef: "images/abc123.bin",
          name: "shot.png",
          sizeBytes: 1200,
        },
        { type: "text", text: "what is this?" },
      ],
    });
    const reloaded = (await store.get(task.id))!;
    const msgs = buildInitialMessages(reloaded);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe("user");
    const content = msgs[0]!.content as Array<{ type: string }>;
    // Images first (deterministic provider ordering), then text.
    expect(content.map((b) => b.type)).toEqual(["image", "text"]);
    expect(content[0]).toMatchObject({
      mime: "image/png",
      fileRef: "images/abc123.bin",
    });
    // No inline bytes leak into the persisted/resumed form.
    expect(JSON.stringify(msgs)).not.toContain("dataBase64");
  });

  it("2c. image-only user entries still seed (no empty message)", async () => {
    const task = await store.create("Image only");
    await store.upsertConversationEntry(task.id, "run-img2", {
      role: "user",
      timestampMs: 4,
      blocks: [
        {
          type: "image",
          mime: "image/jpeg",
          fileRef: "images/def456.bin",
        },
      ],
    });
    const reloaded = (await store.get(task.id))!;
    const msgs = buildInitialMessages(reloaded);
    expect(msgs).toHaveLength(1);
    expect(
      (msgs[0]!.content as Array<{ type: string }>).map((b) => b.type),
    ).toEqual(["image"]);
  });

  it("3. parses bounded tool inputs back to objects; non-JSON omitted (not guessed)", async () => {
    const task = await store.create("Inputs");
    await store.upsertConversationEntry(task.id, "run-1", {
      role: "assistant",
      blocks: [
        {
          type: "tool_use",
          id: "c1",
          name: "search",
          input: '{"query":"foo","limit":5}',
        },
        {
          type: "tool_use",
          id: "c2",
          name: "broken",
          input: "not json at all…",
        },
        { type: "tool_use", id: "c3", name: "noinput" },
      ],
      timestampMs: Date.now(),
    });
    const reloaded = (await store.get(task.id))!;
    const msgs = buildInitialMessages(reloaded);
    const blocks = msgs[0]!.content as Array<{
      type: string;
      id?: string;
      input?: Record<string, unknown>;
    }>;
    expect(blocks[0]).toMatchObject({
      id: "c1",
      input: { query: "foo", limit: 5 },
    });
    expect(blocks.find((b) => b.id === "c2")!.input).toEqual({});
    expect(blocks.find((b) => b.id === "c3")!.input).toEqual({});
  });

  it("14. keyed upsert is idempotent — no duplicate conversation entries", async () => {
    const task = await store.create("Idempotent");
    const entry = {
      role: "assistant" as const,
      blocks: [{ type: "text" as const, text: "v1" }],
      timestampMs: 1,
    };
    await store.upsertConversationEntry(task.id, "run-1", entry);
    await store.upsertConversationEntry(task.id, "run-1", {
      ...entry,
      blocks: [{ type: "text", text: "v2 longer content" }],
    });
    const reloaded = (await store.get(task.id))!;
    expect(reloaded.conversation?.length).toBe(1);
    expect(reloaded.conversation?.[0]?.blocks?.[0]).toEqual({
      type: "text",
      text: "v2 longer content",
    });
  });
});

describe("verbatim resume — fidelity classification", () => {
  it("11a. v1 record (no conversation) → LIMITED, never overclaims", () => {
    const v1: PersistedTask = {
      id: "task-1-x",
      createdAtMs: 1,
      updatedAtMs: 2,
      status: "interrupted",
      title: "old task",
      messages: [{ role: "user", content: "hi", timestampMs: 1 }],
    };
    const info = classifyResumeFidelity(v1);
    expect(info.fidelity).toBe("LIMITED");
    expect(info.reason).toMatch(/continuation prompt/i);
    expect(buildInitialMessages(v1)).toEqual([]);
  });

  it("11b. v2 ending on assistant entry → PARTIAL", () => {
    const t: PersistedTask = {
      id: "task-2-x",
      createdAtMs: 1,
      updatedAtMs: 2,
      status: "interrupted",
      title: "t",
      messages: [],
      conversation: [
        { role: "user", text: "go", timestampMs: 1 },
        {
          role: "assistant",
          blocks: [{ type: "text", text: "working…" }],
          timestampMs: 2,
        },
      ],
    };
    expect(classifyResumeFidelity(t).fidelity).toBe("PARTIAL");
  });

  it("11c. v2 ending on clean user boundary → FULL", () => {
    const t: PersistedTask = {
      id: "task-3-x",
      createdAtMs: 1,
      updatedAtMs: 2,
      status: "interrupted",
      title: "t",
      messages: [],
      conversation: [
        { role: "user", text: "go", timestampMs: 1 },
        {
          role: "assistant",
          blocks: [{ type: "text", text: "done" }],
          timestampMs: 2,
        },
        { role: "user", text: "now do the rest", timestampMs: 3 },
      ],
    };
    expect(classifyResumeFidelity(t).fidelity).toBe("FULL");
  });
});

describe("verbatim resume — provider restoration", () => {
  const base: PersistedTask = {
    id: "task-4-x",
    createdAtMs: 1,
    updatedAtMs: 2,
    status: "interrupted",
    title: "t",
    messages: [],
  };

  it("4. task provider/model win when the provider is known", () => {
    const task: PersistedTask = {
      ...base,
      modelConfig: {
        providerId: "openrouter",
        modelId: "nvidia/nemotron-3.5-lightning:free",
      },
    };
    const plan = planProviderRestore(
      task,
      "ollama",
      (id) => id === "openrouter",
    );
    expect(plan).toMatchObject({
      providerId: "openrouter",
      modelId: "nvidia/nemotron-3.5-lightning:free",
      source: "task",
    });
  });

  it("12. unknown task provider falls back to current with an honest note", () => {
    const task: PersistedTask = {
      ...base,
      modelConfig: { providerId: "extinct-provider", modelId: "m" },
    };
    const plan = planProviderRestore(task, "ollama", () => false);
    expect(plan.source).toBe("current");
    expect(plan.providerId).toBe("ollama");
    expect(plan.notes[0]).toMatch(/no longer available/);
  });

  it("5. plan never carries credentials", () => {
    const task: PersistedTask = {
      ...base,
      modelConfig: { providerId: "openai-native", apiKey: "sk-SUPERSECRET" },
    };
    const plan = planProviderRestore(task, "ollama", () => true);
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain("sk-SUPERSECRET");
    expect(plan).not.toHaveProperty("apiKey");
  });
});

describe("verbatim resume — store mechanics", () => {
  let dir: string;
  let store: TaskStore;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-resume-mech-"));
    store = new TaskStore(dir);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("6. secrets are redacted from captured conversation blocks", async () => {
    const task = await store.create("Secrets");
    await store.upsertConversationEntry(task.id, "run-1", {
      role: "assistant",
      blocks: [
        {
          type: "tool_use",
          id: "c1",
          name: "write",
          input: '{"content":"token=ghp_abcdefghijklmnopqrs012345"}',
        },
      ],
      timestampMs: Date.now(),
    });
    const reloaded = (await store.get(task.id))!;
    const raw = fs.readFileSync(path.join(dir, `${task.id}.json`), "utf8");
    expect(raw).not.toContain("ghp_abcdefghijklmnopqrs012345");
    expect(reloaded.conversation?.length).toBe(1);
  });

  it("7. beginResume rejects completed/archived tasks", async () => {
    const done = await store.create("Done");
    await store.update(done.id, { status: "completed" });
    expect(await store.beginResume(done.id)).toBeNull();
  });

  it("9. resume after cancellation: interrupted task flips to running with generation bump", async () => {
    const task = await store.create("Cancelled");
    await store.update(task.id, { status: "interrupted" });
    const before = (await store.get(task.id))!;
    const resumed = await store.beginResume(task.id);
    expect(resumed).not.toBeNull();
    expect(resumed!.status).toBe("running");
    expect(resumed!.resumeGeneration).toBe((before.resumeGeneration ?? 0) + 1);
  });

  it("15. v1 record round-trips through read without corruption (backward compat)", async () => {
    const v1Record = {
      id: "task-999-legacy",
      createdAtMs: 1,
      updatedAtMs: 2,
      status: "interrupted",
      title: "legacy",
      messages: [{ role: "user", content: "old", timestampMs: 1 }],
    };
    fs.writeFileSync(
      path.join(dir, "task-999-legacy.json"),
      JSON.stringify(v1Record),
      "utf8",
    );
    const loaded = await store.get("task-999-legacy");
    expect(loaded).not.toBeNull();
    expect(loaded!.conversation).toBeUndefined();
    expect(loaded!.resumeGeneration).toBeUndefined();
    expect(classifyResumeFidelity(loaded!).fidelity).toBe("LIMITED");
  });

  it("8. corrupt task file is quarantined, listing stays functional", async () => {
    fs.writeFileSync(
      path.join(dir, "task-888-corrupt.json"),
      "{ broken",
      "utf8",
    );
    const loaded = await store.get("task-888-corrupt");
    expect(loaded).toBeNull();
    expect(fs.existsSync(path.join(dir, "task-888-corrupt.json.corrupt"))).toBe(
      true,
    );
    const all = await store.list();
    expect(all.every((t) => t.id !== "task-888-corrupt")).toBe(true);
  });

  it("16. oversized tool output is bounded before persistence", async () => {
    const bounded = new TaskStore(dir, { maxToolOutputChars: 200 });
    const task = await bounded.create("Bounded");
    await bounded.upsertConversationEntry(task.id, "run-1", {
      role: "assistant",
      blocks: [
        {
          type: "tool_result",
          tool_use_id: "c1",
          name: "read",
          content: "x".repeat(10_000),
        },
      ],
      timestampMs: Date.now(),
    });
    const raw = fs.readFileSync(path.join(dir, `${task.id}.json`), "utf8");
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThan(4_000);
    expect(raw).toContain("[truncated]");
  });

  it("conversation entry bound includes modelId/providerId metadata", async () => {
    const task = await store.create("Meta");
    await store.upsertConversationEntry(task.id, "run-1", {
      role: "assistant",
      blocks: [{ type: "text", text: "hi" }],
      modelId: "qwen3:8b",
      providerId: "ollama",
      timestampMs: Date.now(),
    });
    const reloaded = (await store.get(task.id))!;
    expect(reloaded.conversation?.[0]?.modelId).toBe("qwen3:8b");
    expect(reloaded.conversation?.[0]?.providerId).toBe("ollama");
  });
});

describe("verbatim resume — wire invariants", () => {
  it("16b. tool_result always follows its tool_use in the wire output", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-resume-inv-"));
    const store = new TaskStore(dir);
    try {
      const task = await store.create("Invariants");
      await store.upsertConversationEntry(task.id, "r1", {
        role: "assistant",
        blocks: [
          { type: "tool_use", id: "a", name: "t1", input: "{}" },
          { type: "tool_result", tool_use_id: "a", name: "t1", content: "ok" },
          { type: "tool_use", id: "b", name: "t2", input: "{}" },
          {
            type: "tool_result",
            tool_use_id: "b",
            name: "t2",
            content: "err",
            is_error: true,
          },
        ],
        timestampMs: 1,
      });
      const reloaded = (await store.get(task.id))!;
      const msgs = buildInitialMessages(reloaded);
      // One assistant entry with two tool_use → ONE assistant wire message,
      // followed by ONE user message carrying both results (protocol-valid:
      // all tool results follow all calls of the same assistant turn).
      const seq = msgs.map((m) => ({
        role: m.role,
        kinds: (Array.isArray(m.content) ? m.content : []).map((b) => b.type),
      }));
      expect(seq).toEqual([
        { role: "assistant", kinds: ["tool_use", "tool_use"] },
        { role: "user", kinds: ["tool_result", "tool_result"] },
      ]);
      const errBlock = (msgs[1]!.content as Array<{ is_error?: boolean }>)[1]!;
      expect(errBlock.is_error).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("type shape: PersistedConversationMessage accepts the documented fields", () => {
    const entry: PersistedConversationMessage = {
      role: "assistant",
      text: "plain",
      timestampMs: 1,
      key: "run-x",
    };
    expect(entry.key).toBe("run-x");
  });
});
