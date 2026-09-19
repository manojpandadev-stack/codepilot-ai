/**
 * M14 — File lock registry tests: atomic acquisition, conflict detection,
 * re-entrancy, release semantics, bounded waiting, stale reaping.
 */

import { describe, it, expect } from "vitest";
import { FileConflictError, FileLockRegistry } from "./m14-file-locks.js";

describe("M14 FileLockRegistry", () => {
  it("acquires and reports holders", () => {
    const registry = new FileLockRegistry();
    registry.acquire("task-a", ["src/app.ts"]);
    expect(registry.holder("src/app.ts")).toBe("task-a");
    expect(registry.locksFor("task-a")).toEqual(["src/app.ts"]);
  });

  it("normalizes path separators and case", () => {
    const registry = new FileLockRegistry();
    registry.acquire("task-a", ["src\\App.ts"]);
    expect(registry.holder("SRC/app.ts")).toBe("task-a");
  });

  it("throws FileConflictError when another task holds a file", () => {
    const registry = new FileLockRegistry();
    registry.acquire("task-a", ["src/app.ts"]);
    expect(() => registry.acquire("task-b", ["src/app.ts"])).toThrow(
      FileConflictError,
    );
    try {
      registry.acquire("task-b", ["src/app.ts"]);
    } catch (err) {
      const conflict = err as FileConflictError;
      expect(conflict.taskId).toBe("task-b");
      expect(conflict.holderTaskId).toBe("task-a");
      expect(conflict.files).toContain("src/app.ts");
    }
  });

  it("acquisition is atomic: no partial locks on conflict", () => {
    const registry = new FileLockRegistry();
    registry.acquire("task-a", ["src/one.ts"]);
    try {
      registry.acquire("task-b", ["src/two.ts", "src/one.ts"]);
    } catch {
      // expected
    }
    expect(registry.holder("src/two.ts")).toBeUndefined();
    expect(registry.locksFor("task-b")).toEqual([]);
  });

  it("is re-entrant for the same task", () => {
    const registry = new FileLockRegistry();
    registry.acquire("task-a", ["src/app.ts"]);
    expect(() => registry.acquire("task-a", ["src/app.ts"])).not.toThrow();
  });

  it("tryAcquire returns null instead of throwing", () => {
    const registry = new FileLockRegistry();
    registry.acquire("task-a", ["src/app.ts"]);
    expect(registry.tryAcquire("task-b", ["src/app.ts"])).toBeNull();
    expect(registry.tryAcquire("task-b", ["other.ts"])).toEqual(["other.ts"]);
  });

  it("release frees locks and only the holder's locks", () => {
    const registry = new FileLockRegistry();
    registry.acquire("task-a", ["src/a.ts", "src/b.ts"]);
    registry.acquire("task-b", ["src/c.ts"]);
    registry.release("task-a");
    expect(registry.holder("src/a.ts")).toBeUndefined();
    expect(registry.holder("src/b.ts")).toBeUndefined();
    expect(registry.holder("src/c.ts")).toBe("task-b");
  });

  it("releaseFiles frees only the given files", () => {
    const registry = new FileLockRegistry();
    registry.acquire("task-a", ["src/a.ts", "src/b.ts"]);
    registry.releaseFiles("task-a", ["src/a.ts"]);
    expect(registry.holder("src/a.ts")).toBeUndefined();
    expect(registry.holder("src/b.ts")).toBe("task-a");
  });

  it("wait acquisition succeeds once the holder releases", async () => {
    const registry = new FileLockRegistry();
    registry.acquire("task-a", ["src/app.ts"]);
    const pending = registry.acquireWithWait("task-b", ["src/app.ts"], 2000);
    registry.release("task-a");
    const result = await pending;
    expect(result).toContain("src/app.ts");
  });

  it("wait acquisition times out when the holder never releases", async () => {
    const registry = new FileLockRegistry();
    registry.acquire("task-a", ["src/app.ts"]);
    await expect(
      registry.acquireWithWait("task-b", ["src/app.ts"], 60),
    ).rejects.toThrow("lock wait timeout");
  });

  it("reaps locks from dead tasks", () => {
    const registry = new FileLockRegistry();
    registry.acquire("task-dead", ["src/app.ts"]);
    const reaped = registry.reapStale(60_000, (id) => id !== "task-dead");
    expect(reaped).toHaveLength(1);
    expect(registry.holder("src/app.ts")).toBeUndefined();
  });

  it("keeps locks of live tasks during reaping", () => {
    const registry = new FileLockRegistry();
    registry.acquire("task-live", ["src/app.ts"]);
    const reaped = registry.reapStale(60_000, () => true);
    expect(reaped).toEqual([]);
    expect(registry.holder("src/app.ts")).toBe("task-live");
  });

  it("parallel agents coordinate without deadlock on disjoint files", async () => {
    const registry = new FileLockRegistry();
    const run = async (taskId: string, files: string[]): Promise<void> => {
      await registry.acquireWithWait(taskId, files, 2000);
      registry.release(taskId);
    };
    await Promise.all([
      run("t1", ["src/a.ts"]),
      run("t2", ["src/b.ts"]),
      run("t3", ["src/c.ts"]),
      run("t4", ["src/a.ts", "src/b.ts"]),
    ]);
    expect(registry.locksFor("t1")).toEqual([]);
    expect(registry.locksFor("t4")).toEqual([]);
  });
});
