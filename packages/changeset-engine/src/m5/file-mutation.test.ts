/**
 * M5 FileMutationService tests: every mutation kind, path security via the
 * injected guard, optimistic concurrency, atomic writes, structured errors,
 * change tracking, events, cancellation and deadlines.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { FileMutationService } from "./file-mutation.js";
import type { M5Event } from "./types.js";
import { tempWorkspace, testPathGuard } from "./testing.js";

function service(
  root: string,
  overrides: { onEvent?: (e: M5Event) => void } = {},
): FileMutationService {
  return new FileMutationService({
    workspaceRoot: root,
    pathGuard: testPathGuard(root),
    onEvent: overrides.onEvent,
  });
}

describe("FileMutationService — content ops", () => {
  it("creates a file, validating content and tracking the change", async () => {
    const ws = tempWorkspace();
    try {
      const svc = service(ws.root);
      const batch = await svc.execute({
        taskId: "t1",
        ops: [{ kind: "create", path: "a.txt", content: "hello" + "\n" }],
      });
      expect(batch.ok).toBe(true);
      expect(fs.readFileSync(path.join(ws.root, "a.txt"), "utf8")).toBe(
        "hello" + "\n",
      );
      const change = batch.applied[0]!;
      expect(change.kind).toBe("create");
      expect(change.status).toBe("applied");
      expect(change.validation?.ok).toBe(true);
      expect(change.oldHash).toBeUndefined();
      expect(change.newHash).toBeDefined();
      expect(svc.getChange(change.changeId)).toBe(change);
    } finally {
      ws.cleanup();
    }
  });

  it("writes and modifies a file with optimistic concurrency", async () => {
    const ws = tempWorkspace({ "a.txt": "v1" + "\n" });
    try {
      const svc = service(ws.root);
      const first = await svc.execute({
        taskId: "t1",
        ops: [{ kind: "write", path: "a.txt", content: "v2" + "\n" }],
      });
      expect(first.ok).toBe(true);
      const firstChange = first.applied[0]!;
      expect(firstChange.kind).toBe("write");

      const bad = await svc.execute({
        taskId: "t1",
        ops: [
          {
            kind: "modify",
            path: "a.txt",
            content: "v3" + "\n",
            expectedHash: "WRONG",
          },
        ],
      });
      expect(bad.ok).toBe(false);
      expect(bad.outcomes[0]?.error?.code).toBe("CONCURRENT_MODIFICATION");
      expect(fs.readFileSync(path.join(ws.root, "a.txt"), "utf8")).toBe(
        "v2" + "\n",
      );

      const good = await svc.execute({
        taskId: "t1",
        ops: [
          {
            kind: "modify",
            path: "a.txt",
            content: "v3" + "\n",
            expectedHash: firstChange.newHash,
          },
        ],
      });
      expect(good.ok).toBe(true);
      expect(good.applied[0]?.diff?.operation).toBe("modified");
      expect(fs.readFileSync(path.join(ws.root, "a.txt"), "utf8")).toBe(
        "v3" + "\n",
      );
    } finally {
      ws.cleanup();
    }
  });

  it("treats identical content writes as applied no-ops", async () => {
    const ws = tempWorkspace({ "a.txt": "same" + "\n" });
    try {
      const svc = service(ws.root);
      const batch = await svc.execute({
        taskId: "t1",
        ops: [{ kind: "write", path: "a.txt", content: "same" + "\n" }],
      });
      expect(batch.ok).toBe(true);
      expect(batch.applied[0]?.diff).toBeUndefined(); // no diff for a no-op
      expect(fs.readFileSync(path.join(ws.root, "a.txt"), "utf8")).toBe(
        "same" + "\n",
      );
    } finally {
      ws.cleanup();
    }
  });

  it("deletes a file and reverifies on disk", async () => {
    const ws = tempWorkspace({ "a.txt": "bye" + "\n" });
    try {
      const svc = service(ws.root);
      const batch = await svc.execute({
        taskId: "t1",
        ops: [{ kind: "delete", path: "a.txt" }],
      });
      expect(batch.ok).toBe(true);
      expect(batch.applied[0]?.validation?.checks.deleted).toBe(true);
      expect(fs.existsSync(path.join(ws.root, "a.txt"))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });
});
describe("FileMutationService — rename and directory ops", () => {
  it("renames and moves files", async () => {
    const ws = tempWorkspace({ "old.txt": "data" + "\n" });
    try {
      const svc = service(ws.root);
      const renamed = await svc.execute({
        taskId: "t1",
        ops: [{ kind: "rename", path: "old.txt", to: "new.txt" }],
      });
      expect(renamed.ok).toBe(true);
      expect(renamed.applied[0]?.oldPath).toBe("old.txt");
      expect(fs.existsSync(path.join(ws.root, "new.txt"))).toBe(true);
      expect(fs.existsSync(path.join(ws.root, "old.txt"))).toBe(false);

      const moved = await svc.execute({
        taskId: "t1",
        ops: [{ kind: "move", path: "new.txt", to: "sub/deep/new.txt" }],
      });
      expect(moved.ok).toBe(true);
      expect(
        fs.readFileSync(path.join(ws.root, "sub", "deep", "new.txt"), "utf8"),
      ).toBe("data" + "\n");
    } finally {
      ws.cleanup();
    }
  });

  it("creates and deletes directories", async () => {
    const ws = tempWorkspace();
    try {
      const svc = service(ws.root);
      const created = await svc.execute({
        taskId: "t1",
        ops: [{ kind: "create_directory", path: "x/y" }],
      });
      expect(created.ok).toBe(true);
      expect(fs.statSync(path.join(ws.root, "x", "y")).isDirectory()).toBe(
        true,
      );

      const deleted = await svc.execute({
        taskId: "t1",
        ops: [{ kind: "delete_directory", path: "x/y" }],
      });
      expect(deleted.ok).toBe(true);
      expect(fs.existsSync(path.join(ws.root, "x", "y"))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  it("reports missing files with FILE_NOT_FOUND and records failure", async () => {
    const ws = tempWorkspace();
    try {
      const svc = service(ws.root);
      const batch = await svc.execute({
        taskId: "t1",
        ops: [{ kind: "delete", path: "nope.txt" }],
      });
      expect(batch.ok).toBe(false);
      expect(batch.outcomes[0]?.error?.code).toBe("FILE_NOT_FOUND");
      expect(svc.listChanges("t1").every((c) => c.status === "failed")).toBe(
        true,
      );
    } finally {
      ws.cleanup();
    }
  });
});

describe("FileMutationService — path security", () => {
  it("rejects traversal, absolute paths, null bytes and sensitive files", async () => {
    const ws = tempWorkspace();
    try {
      const svc = service(ws.root);
      const ops = [
        { kind: "create" as const, path: "../escape.txt", content: "x" },
        { kind: "create" as const, path: "/etc/evil.txt", content: "x" },
        {
          kind: "create" as const,
          path: "a" + String.fromCharCode(0) + "b.txt",
          content: "x",
        },
        { kind: "write" as const, path: ".env", content: "SECRET=1" },
      ];
      for (const op of ops) {
        const batch = await svc.execute({ taskId: "t1", ops: [op] });
        expect(batch.ok).toBe(false);
        const code = batch.outcomes[0]?.error?.code;
        expect([
          "INVALID_PATH",
          "OUTSIDE_WORKSPACE",
          "SENSITIVE_FILE",
        ]).toContain(code);
      }
      expect(fs.existsSync(path.join(ws.root, "escape.txt"))).toBe(false);
      expect(fs.existsSync(path.join(ws.root, ".env"))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  it("rejects destination paths outside the workspace for renames", async () => {
    const ws = tempWorkspace({ "a.txt": "x" });
    try {
      const svc = service(ws.root);
      const batch = await svc.execute({
        taskId: "t1",
        ops: [{ kind: "rename", path: "a.txt", to: "../../outside.txt" }],
      });
      expect(batch.ok).toBe(false);
      expect(batch.outcomes[0]?.error?.code).toBe("OUTSIDE_WORKSPACE");
    } finally {
      ws.cleanup();
    }
  });
});
describe("FileMutationService — batches, events, deadlines", () => {
  it("all-or-nothing aborts the remaining batch after a failed op", async () => {
    const ws = tempWorkspace();
    try {
      const svc = service(ws.root);
      const batch = await svc.execute({
        taskId: "t1",
        ops: [
          { kind: "create", path: "kept.txt", content: "ok" },
          { kind: "delete", path: "missing.txt" },
          { kind: "create", path: "never.txt", content: "nope" },
        ],
        allOrNothing: true,
      });
      expect(batch.ok).toBe(false);
      // The first op was applied; the failure stops the remaining ops.
      expect(batch.applied).toHaveLength(1);
      expect(batch.outcomes[1]?.error?.code).toBe("FILE_NOT_FOUND");
      expect(batch.outcomes[2]?.error?.code).toBe("CANCELLED");
      expect(fs.existsSync(path.join(ws.root, "kept.txt"))).toBe(true);
      expect(fs.existsSync(path.join(ws.root, "never.txt"))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  it("allows best-effort batches when allOrNothing is false", async () => {
    const ws = tempWorkspace();
    try {
      const svc = service(ws.root);
      const batch = await svc.execute({
        taskId: "t1",
        ops: [
          { kind: "create", path: "kept.txt", content: "ok" },
          { kind: "delete", path: "missing.txt" },
        ],
        allOrNothing: false,
      });
      expect(batch.ok).toBe(false);
      expect(batch.applied).toHaveLength(1);
      expect(fs.existsSync(path.join(ws.root, "kept.txt"))).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it("emits lifecycle and diff events, and failure events on error", async () => {
    const ws = tempWorkspace();
    try {
      const events: M5Event[] = [];
      const svc = service(ws.root, { onEvent: (e) => events.push(e) });
      await svc.execute({
        taskId: "t1",
        ops: [{ kind: "create", path: "a.txt", content: "hi" + "\n" }],
      });
      const kinds = events.map((e) => e.kind);
      expect(kinds).toContain("FILE_CHANGE_STARTED");
      expect(kinds).toContain("FILE_CHANGE_COMPLETED");
      expect(kinds).toContain("DIFF_GENERATED");
      await svc.execute({
        taskId: "t1",
        ops: [{ kind: "delete", path: "missing.txt" }],
      });
      expect(events.map((e) => e.kind)).toContain("FILE_CHANGE_FAILED");
    } finally {
      ws.cleanup();
    }
  });

  it("cancellation via an aborted signal prevents execution", async () => {
    const ws = tempWorkspace();
    try {
      const svc = service(ws.root);
      const batch = await svc.execute({
        taskId: "t1",
        ops: [{ kind: "create", path: "a.txt", content: "x" }],
        signal: AbortSignal.abort(),
      });
      expect(batch.ok).toBe(false);
      expect(batch.outcomes[0]?.error?.code).toBe("CANCELLED");
      expect(fs.existsSync(path.join(ws.root, "a.txt"))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  it("a past deadline fails the batch with TIMEOUT", async () => {
    const ws = tempWorkspace();
    try {
      const svc = service(ws.root);
      const batch = await svc.execute({
        taskId: "t1",
        ops: [{ kind: "create", path: "a.txt", content: "x" }],
        deadline: Date.now() - 1,
      });
      expect(batch.ok).toBe(false);
      expect(batch.outcomes[0]?.error?.code).toBe("TIMEOUT");
      expect(fs.existsSync(path.join(ws.root, "a.txt"))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });
});
