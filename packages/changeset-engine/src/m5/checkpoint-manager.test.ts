/**
 * M5 CheckpointManager tests: create/list/get, restore to checkpoint state,
 * skipped already-at-state files, conflict detection for external edits,
 * individual revert, task revert, checkpoint metadata removal and events.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CheckpointManager } from "./checkpoint-manager.js";
import { FileMutationService } from "./file-mutation.js";
import type { M5Event } from "./types.js";
import { tempWorkspace, testPathGuard } from "./testing.js";

function rig(root: string): {
  mutation: FileMutationService;
  checkpoints: CheckpointManager;
  events: M5Event[];
} {
  const events: M5Event[] = [];
  const mutation = new FileMutationService({
    workspaceRoot: root,
    pathGuard: testPathGuard(root),
  });
  const checkpoints = new CheckpointManager({
    mutation,
    onEvent: (e) => events.push(e),
  });
  return { mutation, checkpoints, events };
}

describe("CheckpointManager — creation and queries", () => {
  it("captures affected files with content and hashes", async () => {
    const ws = tempWorkspace({ "a.txt": "v1" + "\n", "b.txt": "keep" + "\n" });
    try {
      const { mutation, checkpoints } = rig(ws.root);
      await mutation.execute({
        taskId: "t1",
        ops: [{ kind: "write", path: "a.txt", content: "v1" + "\n" }],
      });
      const cp = checkpoints.createCheckpoint({
        taskId: "t1",
        description: "baseline",
      });
      expect(cp.checkpointId).toMatch(/^cp-/);
      expect(cp.status).toBe("active");
      const a = cp.files.find((f) => f.path === "a.txt");
      expect(a?.existed).toBe(true);
      expect(a?.content).toBe("v1" + "\n");
      expect(a?.hash).toBeDefined();
      expect(checkpoints.getCheckpoint(cp.checkpointId)).toBe(cp);
      expect(checkpoints.listCheckpoints("t1")).toContain(cp);
    } finally {
      ws.cleanup();
    }
  });

  it("captures newly applied changes in changeIds", async () => {
    const ws = tempWorkspace({ "a.txt": "v1" + "\n" });
    try {
      const { mutation, checkpoints } = rig(ws.root);
      await mutation.execute({
        taskId: "t1",
        ops: [{ kind: "write", path: "a.txt", content: "chg" + "\n" }],
      });
      const cp = checkpoints.createCheckpoint({
        taskId: "t1",
        description: "after change",
      });
      expect(cp.changeIds.length).toBeGreaterThan(0);
      const change = mutation.getChange(cp.changeIds[0]!);
      expect(change?.checkpointId).toBe(cp.checkpointId);
    } finally {
      ws.cleanup();
    }
  });

  it("supports explicit file lists", async () => {
    const ws = tempWorkspace({ "a.txt": "x" + "\n", "b.txt": "y" + "\n" });
    try {
      const { checkpoints } = rig(ws.root);
      const cp = checkpoints.createCheckpoint({
        taskId: "t1",
        description: "explicit",
        files: ["a.txt"],
      });
      expect(cp.files.map((f) => f.path)).toEqual(["a.txt"]);
      expect(checkpoints.listCheckpoints()).toHaveLength(1);
    } finally {
      ws.cleanup();
    }
  });
});
describe("CheckpointManager — restore and revert", () => {
  it("restores files to the checkpoint state through the mutation service", async () => {
    const ws = tempWorkspace({ "a.txt": "v0" + "\n" });
    try {
      const { mutation, checkpoints, events } = rig(ws.root);
      // Establish the baseline so the checkpoint can capture it.
      await mutation.execute({
        taskId: "t1",
        ops: [{ kind: "write", path: "a.txt", content: "v1" + "\n" }],
      });
      const cp = checkpoints.createCheckpoint({
        taskId: "t1",
        description: "before",
      });
      await mutation.execute({
        taskId: "t1",
        ops: [{ kind: "write", path: "a.txt", content: "v2" + "\n" }],
      });
      expect(fs.readFileSync(path.join(ws.root, "a.txt"), "utf8")).toBe(
        "v2" + "\n",
      );

      const result = await checkpoints.restoreCheckpoint(cp.checkpointId);
      expect(result.ok).toBe(true);
      expect(result.restored).toBe(1);
      expect(result.conflicts).toBe(0);
      expect(result.results[0]?.status).toBe("restored");
      expect(fs.readFileSync(path.join(ws.root, "a.txt"), "utf8")).toBe(
        "v1" + "\n",
      );
      expect(checkpoints.getCheckpoint(cp.checkpointId)?.status).toBe(
        "restored",
      );
      expect(events.map((e) => e.kind)).toContain("RESTORE_STARTED");
      expect(events.map((e) => e.kind)).toContain("RESTORE_COMPLETED");
    } finally {
      ws.cleanup();
    }
  });

  it("skips files already at checkpoint state", async () => {
    const ws = tempWorkspace({ "a.txt": "v1" + "\n" });
    try {
      const { mutation, checkpoints } = rig(ws.root);
      await mutation.execute({
        taskId: "t1",
        ops: [{ kind: "write", path: "a.txt", content: "v1" + "\n" }],
      });
      const cp = checkpoints.createCheckpoint({
        taskId: "t1",
        description: "before",
      });
      const result = await checkpoints.restoreCheckpoint(cp.checkpointId);
      expect(result.ok).toBe(true);
      expect(result.skipped).toBe(1);
      expect(result.results[0]?.reason).toBe("already at checkpoint state");
    } finally {
      ws.cleanup();
    }
  });

  it("reports CONFLICT for files modified externally after the checkpoint", async () => {
    const ws = tempWorkspace({ "a.txt": "v1" + "\n" });
    try {
      const { mutation, checkpoints, events } = rig(ws.root);
      await mutation.execute({
        taskId: "t1",
        ops: [{ kind: "write", path: "a.txt", content: "v1" + "\n" }],
      });
      const cp = checkpoints.createCheckpoint({
        taskId: "t1",
        description: "before",
      });
      fs.writeFileSync(
        path.join(ws.root, "a.txt"),
        "EXTERNAL EDIT" + "\n",
        "utf8",
      );

      const result = await checkpoints.restoreCheckpoint(cp.checkpointId);
      expect(result.ok).toBe(true); // conflicts do not fail the batch
      expect(result.conflicts).toBe(1);
      expect(result.results[0]?.reason).toContain("externally modified");
      expect(fs.readFileSync(path.join(ws.root, "a.txt"), "utf8")).toBe(
        "EXTERNAL EDIT" + "\n",
      );
      expect(events.map((e) => e.kind)).toContain("RESTORE_CONFLICT");
    } finally {
      ws.cleanup();
    }
  });

  it("reverts a single change to its pre-change content", async () => {
    const ws = tempWorkspace({ "a.txt": "orig" + "\n" });
    try {
      const { mutation, checkpoints, events } = rig(ws.root);
      await mutation.execute({
        taskId: "t1",
        ops: [{ kind: "write", path: "a.txt", content: "edited" + "\n" }],
      });
      const cp = checkpoints.createCheckpoint({
        taskId: "t1",
        description: "after edit",
      });
      expect(cp.changeIds).toHaveLength(1);
      const changeId = cp.changeIds[0]!;

      const result = await checkpoints.revertChange(changeId);
      expect(result.status).toBe("restored");
      expect(fs.readFileSync(path.join(ws.root, "a.txt"), "utf8")).toBe(
        "orig" + "\n",
      );
      expect(mutation.getChange(changeId)?.status).toBe("reverted");
      expect(events.map((e) => e.kind)).toContain("CHANGE_REVERTED");
    } finally {
      ws.cleanup();
    }
  });
});
describe("CheckpointManager — revert edge cases", () => {
  it("reverts a delete back to the original content", async () => {
    const ws = tempWorkspace({ "a.txt": "keep me" + "\n" });
    try {
      const { mutation, checkpoints } = rig(ws.root);
      await mutation.execute({
        taskId: "t1",
        ops: [{ kind: "delete", path: "a.txt" }],
      });
      const cp = checkpoints.createCheckpoint({
        taskId: "t1",
        description: "after delete",
      });
      const result = await checkpoints.revertChange(cp.changeIds[0]!);
      expect(result.status).toBe("restored");
      expect(fs.readFileSync(path.join(ws.root, "a.txt"), "utf8")).toBe(
        "keep me" + "\n",
      );
    } finally {
      ws.cleanup();
    }
  });

  it("reverts all task changes oldest first", async () => {
    const ws = tempWorkspace({ "a.txt": "a0" + "\n", "b.txt": "b0" + "\n" });
    try {
      const { mutation, checkpoints } = rig(ws.root);
      await mutation.execute({
        taskId: "t1",
        ops: [{ kind: "write", path: "a.txt", content: "a1" + "\n" }],
      });
      await mutation.execute({
        taskId: "t1",
        ops: [{ kind: "write", path: "b.txt", content: "b1" + "\n" }],
      });
      const result = await checkpoints.revertTaskChanges("t1");
      expect(result.ok).toBe(true);
      expect(fs.readFileSync(path.join(ws.root, "a.txt"), "utf8")).toBe(
        "a0" + "\n",
      );
      expect(fs.readFileSync(path.join(ws.root, "b.txt"), "utf8")).toBe(
        "b0" + "\n",
      );
    } finally {
      ws.cleanup();
    }
  });

  it("surfaces CONFLICT when reverting a change whose file was edited externally", async () => {
    const ws = tempWorkspace({ "a.txt": "orig" + "\n" });
    try {
      const { mutation, checkpoints } = rig(ws.root);
      await mutation.execute({
        taskId: "t1",
        ops: [{ kind: "write", path: "a.txt", content: "edited" + "\n" }],
      });
      const cp = checkpoints.createCheckpoint({
        taskId: "t1",
        description: "after edit",
      });
      fs.writeFileSync(path.join(ws.root, "a.txt"), "EXTERNAL" + "\n", "utf8");
      const result = await checkpoints.revertChange(cp.changeIds[0]!);
      expect(result.status).toBe("conflict");
      expect(fs.readFileSync(path.join(ws.root, "a.txt"), "utf8")).toBe(
        "EXTERNAL" + "\n",
      );
    } finally {
      ws.cleanup();
    }
  });

  it("deletes checkpoint metadata once no longer active", async () => {
    const ws = tempWorkspace({ "a.txt": "v1" + "\n" });
    try {
      const { checkpoints } = rig(ws.root);
      const cp = checkpoints.createCheckpoint({
        taskId: "t1",
        description: "before",
      });
      expect(checkpoints.deleteCheckpoint(cp.checkpointId)).toBe(false); // active
      await checkpoints.restoreCheckpoint(cp.checkpointId);
      expect(checkpoints.deleteCheckpoint(cp.checkpointId)).toBe(true);
      expect(checkpoints.getCheckpoint(cp.checkpointId)).toBeUndefined();
    } finally {
      ws.cleanup();
    }
  });

  it("throws CHECKPOINT_NOT_FOUND for unknown ids", async () => {
    const ws = tempWorkspace();
    try {
      const { checkpoints } = rig(ws.root);
      try {
        await checkpoints.restoreCheckpoint("cp-nope");
        expect.unreachable();
      } catch (err) {
        expect((err as { code: string }).code).toBe("CHECKPOINT_NOT_FOUND");
      }
    } finally {
      ws.cleanup();
    }
  });
});
