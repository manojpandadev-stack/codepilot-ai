/**
 * M12 — Task persistence tests: create/append/list, crash-safe writes,
 * corruption quarantine, interrupted-task recovery, secret redaction,
 * archive/delete, and resume data integrity.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TaskStore, redactForPersistence } from "./m12-task-store.js";
import { createTaskPlan } from "./task-plan.js";

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-m12-"));
}

describe("M12 redactForPersistence", () => {
  it("redacts secret-shaped object keys", () => {
    const redacted = redactForPersistence({
      apiKey: "sk-abc123def456ghi789",
      password: "hunter2",
      nested: { authToken: "xyz", safe: "value" },
    });
    expect(redacted).toEqual({
      apiKey: "[REDACTED]",
      password: "[REDACTED]",
      nested: { authToken: "[REDACTED]", safe: "value" },
    });
  });

  it("redacts embedded secrets inside free text", () => {
    const redacted = redactForPersistence({
      log: "request failed with key ghp_abcdefghijklmnopqrstuvwxyz012345",
    });
    expect(redacted.log).not.toContain("ghp_");
    expect(redacted.log).toContain("[REDACTED]");
  });

  it("leaves ordinary strings untouched", () => {
    const value = { title: "Fix the login bug", note: "see ticket 1234" };
    expect(redactForPersistence(value)).toEqual(value);
  });

  it("handles circular references without crashing", () => {
    const obj: Record<string, unknown> = { name: "root" };
    obj.self = obj;
    expect(redactForPersistence(obj)).toEqual({
      name: "root",
      self: "[circular]",
    });
  });
});

describe("M12 TaskStore", () => {
  let dir: string;
  let store: TaskStore;

  beforeEach(() => {
    dir = makeDir();
    store = new TaskStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates a task and round-trips it", async () => {
    const task = await store.create("Add validation to registration API");
    const loaded = await store.get(task.id);
    expect(loaded?.title).toBe("Add validation to registration API");
    expect(loaded?.status).toBe("running");
  });

  it("appends messages and enforces the message cap", async () => {
    const task = await store.create("cap test");
    for (let i = 0; i < 10; i++) {
      await store.appendMessage(task.id, "user", `message ${i}`);
    }
    const small = new TaskStore(dir, { maxMessages: 3 });
    await small.appendMessage(task.id, "assistant", "latest");
    const loaded = await small.get(task.id);
    expect(loaded?.messages).toHaveLength(3);
    expect(loaded?.messages[2]?.content).toBe("latest");
  });

  it("lists tasks newest-first", async () => {
    const a = await store.create("first");
    const b = await store.create("second");
    await store.update(a.id, { status: "completed" }); // bumps a past b
    const list = await store.list();
    expect(list[0]?.id).toBe(a.id);
    expect(list[1]?.id).toBe(b.id);
  });

  it("returns null for missing tasks", async () => {
    expect(await store.get("nope")).toBeNull();
  });

  it("quarantines corrupt task files instead of throwing", async () => {
    const task = await store.create("victim");
    const file = path.join(dir, `${task.id}.json`);
    fs.writeFileSync(file, "{ truncated json...", "utf8");
    expect(await store.get(task.id)).toBeNull();
    expect(fs.existsSync(`${file}.corrupt`)).toBe(true);
    // Listing still works and does not include the corrupt file.
    const list = await store.list();
    expect(list.find((t) => t.id === task.id)).toBeUndefined();
  });

  it("marks running tasks interrupted on startup", async () => {
    const a = await store.create("crashed");
    const b = await store.create("done");
    await store.update(b.id, { status: "completed" });
    const count = await store.markInterruptedOnStartup();
    expect(count).toBe(1);
    expect((await store.get(a.id))?.status).toBe("interrupted");
    expect((await store.get(b.id))?.status).toBe("completed");
  });

  it("supports resume data: agentState, touchedFiles, checkpoints", async () => {
    const task = await store.create("resume me");
    await store.appendMessage(task.id, "user", "start work");
    await store.appendMessage(task.id, "assistant", "editing src/app.ts");
    await store.update(task.id, {
      status: "interrupted",
      agentState: { state: "EXECUTING", attempts: 2 },
      touchedFiles: ["src/app.ts"],
      checkpointIds: ["ckpt-1"],
    });

    // New store instance simulates a restart.
    const revived = new TaskStore(dir);
    const resumed = await revived.get(task.id);
    expect(resumed?.status).toBe("interrupted");
    expect(resumed?.agentState).toEqual({ state: "EXECUTING", attempts: 2 });
    expect(resumed?.touchedFiles).toEqual(["src/app.ts"]);
    expect(resumed?.messages).toHaveLength(2);
  });

  it("redacts secrets in modelConfig and agentState before writing", async () => {
    const task = await store.create("secret test", {
      provider: "openai",
      apiKey: "sk-reallysecret123456",
    });
    await store.update(task.id, {
      agentState: { note: "token=ghp_aaaaaaaaaaaaaaaaaaaa" },
    });
    const raw = fs.readFileSync(path.join(dir, `${task.id}.json`), "utf8");
    expect(raw).not.toContain("sk-reallysecret123456");
    expect(raw).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaa");
    expect(raw).toContain("[REDACTED]");
    expect(task.modelConfig?.provider).toBe("openai");
  });

  it("archives and deletes tasks", async () => {
    const task = await store.create("lifecycle");
    await store.archive(task.id);
    expect((await store.get(task.id))?.status).toBe("archived");
    await store.delete(task.id);
    expect(await store.get(task.id)).toBeNull();
  });

  it("rejects path traversal in ids", async () => {
    // basename() neutralizes traversal; nothing should blow up.
    expect(await store.get("../../etc/passwd")).toBeNull();
    expect(await store.delete("..%2F..%2Fetc%2Fpasswd")).toBe(true); // no-op delete
  });
});

describe("M12 staged image attachments", () => {
  let dir: string;
  let store: TaskStore;

  beforeEach(() => {
    dir = makeDir();
    store = new TaskStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const tinyPng = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 73, 69, 78, 68,
    0, 0, 0, 0,
  ]);

  it("stages bytes under the task dir and reads them back", async () => {
    const task = await store.create("image turn");
    const staged = await store.stageImage(task.id, {
      mime: "image/png",
      name: "shot.png",
      sizeBytes: tinyPng.length,
      bytes: tinyPng,
    });
    expect("error" in staged).toBe(false);
    if ("error" in staged) return;
    expect(staged.fileRef.startsWith("images/")).toBe(true);
    expect(staged.fileRef).not.toContain("..");
    const back = store.readStagedImage(task.id, staged.fileRef);
    expect(back).not.toBeNull();
    expect(Array.from(back!)).toEqual(Array.from(tinyPng));
  });

  it("rejects oversized images and enforces the per-task cap", async () => {
    const task = await store.create("limits");
    const big = await store.stageImage(task.id, {
      mime: "image/png",
      name: "big.png",
      sizeBytes: 10_000_000,
      bytes: new Uint8Array(10_000_000),
    });
    expect("error" in big).toBe(true);
    for (let i = 0; i < 8; i++) {
      const r = await store.stageImage(task.id, {
        mime: "image/png",
        name: `s${i}.png`,
        sizeBytes: tinyPng.length,
        bytes: tinyPng,
      });
      expect("error" in r).toBe(false);
    }
    const ninth = await store.stageImage(task.id, {
      mime: "image/png",
      name: "s8.png",
      sizeBytes: tinyPng.length,
      bytes: tinyPng,
    });
    expect("error" in ninth).toBe(true);
  });

  it("rejects traversal and absolute fileRefs on read", async () => {
    const task = await store.create("traversal");
    expect(store.readStagedImage(task.id, "../../etc/passwd")).toBeNull();
    expect(store.readStagedImage(task.id, "/abs/path.bin")).toBeNull();
    expect(store.readStagedImage(task.id, "images/../../x.bin")).toBeNull();
    expect(store.readStagedImage(task.id, "nope.bin")).toBeNull();
    expect(store.readStagedImage(task.id, "")).toBeNull();
  });

  it("persists fileRefs (never bytes) via upserted blocks", async () => {
    const task = await store.create("persist refs");
    const staged = await store.stageImage(task.id, {
      mime: "image/png",
      name: "shot.png",
      sizeBytes: tinyPng.length,
      bytes: tinyPng,
    });
    if ("error" in staged) throw new Error("stage failed");
    await store.upsertConversationEntry(task.id, "turn-1", {
      role: "user",
      timestampMs: Date.now(),
      blocks: [
        {
          type: "image",
          mime: "image/png",
          fileRef: staged.fileRef,
          name: "shot.png",
          sizeBytes: tinyPng.length,
        },
        { type: "text", text: "what is this?" },
      ],
    });
    const reloaded = await store.get(task.id);
    const raw = JSON.stringify(reloaded);
    // No inline bytes anywhere in the persisted record.
    expect(raw).not.toContain("dataBase64");
    const blocks = reloaded?.conversation?.[0]?.blocks ?? [];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      type: "image",
      mime: "image/png",
      fileRef: staged.fileRef,
    });
    // Bytes still resolve from disk for the live request.
    const back = store.readStagedImage(task.id, staged.fileRef);
    expect(back).not.toBeNull();
  });

  it("removes staged images with task delete", async () => {
    const task = await store.create("cleanup");
    const staged = await store.stageImage(task.id, {
      mime: "image/png",
      name: "shot.png",
      sizeBytes: tinyPng.length,
      bytes: tinyPng,
    });
    if ("error" in staged) throw new Error("stage failed");
    await store.delete(task.id);
    expect(store.readStagedImage(task.id, staged.fileRef)).toBeNull();
    expect(fs.existsSync(path.join(dir, task.id, "images"))).toBe(false);
  });
});

// ---------------------------------------------------------------- plan + paused
describe("M12 TaskStore — structured plan persistence", () => {
  let dir: string;
  let store: TaskStore;

  beforeEach(() => {
    dir = makeDir();
    store = new TaskStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists a plan through update() and a restart, and clears it with null", async () => {
    const task = await store.create("plan task");
    const plan = createTaskPlan(
      {
        objective: "Ship it",
        steps: [
          { title: "first", affectedFiles: ["src/a.ts"], validation: "tests" },
          { title: "second", dependsOn: ["step-1"] },
        ],
      },
      Date.now(),
    );
    await store.update(task.id, { plan });
    const revived = new TaskStore(dir);
    const loaded = await revived.get(task.id);
    expect(loaded?.plan?.objective).toBe("Ship it");
    expect(loaded?.plan?.steps.map((s) => s.title)).toEqual([
      "first",
      "second",
    ]);
    expect(loaded?.plan?.steps[0]?.affectedFiles).toEqual(["src/a.ts"]);
    expect(loaded?.plan?.steps[1]?.dependsOn).toEqual(["step-1"]);

    await store.update(task.id, { plan: null });
    expect((await store.get(task.id))?.plan).toBeUndefined();
  });

  it("redacts secrets inside plan text before writing", async () => {
    const task = await store.create("secret plan");
    const plan = createTaskPlan(
      {
        objective: "rotate key sk-reallysecret123456 first",
        steps: [{ title: "a" }],
      },
      Date.now(),
    );
    await store.update(task.id, { plan });
    const raw = fs.readFileSync(path.join(dir, `${task.id}.json`), "utf8");
    expect(raw).not.toContain("sk-reallysecret123456");
    expect(raw).toContain("[REDACTED]");
  });

  it("drops malformed plans on read instead of crashing (normalize)", async () => {
    const task = await store.create("malformed plan");
    const file = path.join(dir, `${task.id}.json`);
    const doc = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    // (a) not an object at all
    doc.plan = "not-a-plan";
    fs.writeFileSync(file, JSON.stringify(doc), "utf8");
    expect((await new TaskStore(dir).get(task.id))?.plan).toBeUndefined();

    // (b) object but structurally invalid (missing objective / steps)
    doc.plan = { steps: "nope" };
    fs.writeFileSync(file, JSON.stringify(doc), "utf8");
    expect((await new TaskStore(dir).get(task.id))?.plan).toBeUndefined();

    // (c) valid shape survives
    doc.plan = { objective: "fine", steps: [{ title: "x" }] };
    fs.writeFileSync(file, JSON.stringify(doc), "utf8");
    expect((await new TaskStore(dir).get(task.id))?.plan?.objective).toBe(
      "fine",
    );
  });

  it("accepts and round-trips the paused status", async () => {
    const task = await store.create("pause me");
    await store.update(task.id, { status: "paused", lastStep: "task_paused" });
    const revived = new TaskStore(dir);
    const loaded = await revived.get(task.id);
    expect(loaded?.status).toBe("paused");
    expect(loaded?.lastStep).toBe("task_paused");
    // paused is NOT a resumable-critical status the startup sweep rewrites:
    const count = await revived.markInterruptedOnStartup();
    expect(count).toBe(0);
    expect((await revived.get(task.id))?.status).toBe("paused");
  });
});
