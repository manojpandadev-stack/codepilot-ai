/**
 * Regression — transient rename locks during TaskStore's atomic write.
 *
 * On Windows, antivirus/indexer hooks can briefly hold the task JSON,
 * making the tmp+rename step fail with EPERM (observed as an intermittent
 * full-suite failure in tests/task-history-service.test.ts, stack:
 * TaskStore.appendMessage → TaskStore.write → fs.renameSync). This suite
 * injects the lock DETERMINISTICALLY (mocked node:fs renameSync failing
 * with EPERM) and pins that:
 *  - a transient EPERM is retried and the write still lands atomically;
 *  - retries are BOUNDED — a persistently locked file surfaces the
 *    original error instead of hanging.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TaskStore } from "./m12-task-store.js";

const hooks = vi.hoisted(() => ({
  /** Total renameSync invocations seen (tmp + non-tmp). */
  renameCalls: 0,
  /** How many upcoming `.tmp-` renames should fail with a fake EPERM. */
  failTmpRenames: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (
      from: Parameters<typeof actual.renameSync>[0],
      to: Parameters<typeof actual.renameSync>[1],
    ) => {
      hooks.renameCalls += 1;
      if (hooks.failTmpRenames > 0 && String(from).includes(".tmp-")) {
        hooks.failTmpRenames -= 1;
        const err = new Error(
          "EPERM: operation not permitted, rename",
        ) as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      return actual.renameSync(from, to);
    },
  };
});

let dir: string;

beforeEach(() => {
  hooks.renameCalls = 0;
  hooks.failTmpRenames = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-rename-retry-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("TaskStore write — transient rename-lock resilience", () => {
  it("retries a transient EPERM and still persists the message", async () => {
    const store = new TaskStore(path.join(dir, "tasks"));
    const task = await store.create("retry me");
    const callsAfterCreate = hooks.renameCalls;
    // The next tmp+rename cycle (appendMessage) hits a transient lock.
    hooks.failTmpRenames = 1;

    const updated = await store.appendMessage(task.id, "user", "hello world");

    expect(updated?.messages.some((m) => m.content === "hello world")).toBe(
      true,
    );
    // Locked attempt + successful retry, on top of create()'s own rename.
    expect(hooks.renameCalls).toBe(callsAfterCreate + 2);
    // Atomic durability: the record on disk contains the message.
    const reread = await store.get(task.id);
    expect(reread?.messages.some((m) => m.content === "hello world")).toBe(
      true,
    );
  });

  it("surfaces the original error once retries are exhausted", async () => {
    const store = new TaskStore(path.join(dir, "tasks"));
    const task = await store.create("fail hard");
    hooks.failTmpRenames = Number.MAX_SAFE_INTEGER;

    await expect(
      store.appendMessage(task.id, "user", "never lands"),
    ).rejects.toMatchObject({ code: "EPERM" });
  });
});
