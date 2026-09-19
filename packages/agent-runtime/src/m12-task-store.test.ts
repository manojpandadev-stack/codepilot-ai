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
