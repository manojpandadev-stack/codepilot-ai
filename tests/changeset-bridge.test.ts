import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangeSetManager } from "../packages/changeset-engine/src/index.js";
import { parseEditorInput } from "../packages/agent-runtime/src/index.js";

// ============================================================================
// ChangeSet staging bridge — end to end (Phase 1 Tests 7–11, Phase 2 FG 13/18)
//
// The agent writes through the ChangeSet engine: staged proposals are pending,
// approval applies to disk, rejection changes nothing, rollback restores the
// snapshot, and external modifications produce a conflict that never
// overwrites the user's newer content.
// ============================================================================

let dir: string;
let ws: string;

function buildWorkspace(): void {
  dir = mkdtempSync(join(tmpdir(), "cp-bridge-"));
  ws = join(dir, "ws");
  mkdirSync(ws, { recursive: true });
}

function readOriginal(abs: string): string | undefined {
  return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
}

function stage(mgr: ChangeSetManager, filePath: string, proposedContent: string) {
  const abs = join(ws, filePath);
  const original = readOriginal(abs);
  const input = original !== undefined
    ? { file_path: filePath, old_string: original, new_string: proposedContent }
    : { file_path: filePath, old_string: "", new_string: proposedContent };
  const parsed = parseEditorInput(input, ws, readOriginal);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error);
  return mgr.createChangeSet(
    "tool:editor",
    parsed.proposals.map((p) => ({ filePath: p.relativePath, proposedContent: p.proposedContent }))
  );
}

beforeEach(() => buildWorkspace());
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ChangeSet staging bridge", () => {
  it("holds a new-file proposal pending; reject writes nothing; approve writes on disk", () => {
    const mgr = new ChangeSetManager({ workspaceRoot: ws });
    const cs = stage(mgr, "codepilot-test.txt", "CodePilot AI test");
    expect(cs.status).toBe("pending");
    expect(existsSync(join(ws, "codepilot-test.txt"))).toBe(false);
    expect(mgr.getChangeSet(cs.id)!.changes[0]!.diff).toContain("CodePilot AI test");

    // Approve → file written.
    const res = mgr.acceptChange(cs.id, cs.changes[0]!.id);
    expect(res.success).toBe(true);
    expect(existsSync(join(ws, "codepilot-test.txt"))).toBe(true);
    expect(readFileSync(join(ws, "codepilot-test.txt"), "utf8")).toBe("CodePilot AI test");
    expect(mgr.getChangeSet(cs.id)!.changes[0]!.status).toBe("applied");
  });

  it("reject never touches the filesystem", () => {
    const mgr = new ChangeSetManager({ workspaceRoot: ws });
    const cs = stage(mgr, "reject-me.txt", "should not appear");
    expect(mgr.rejectChange(cs.id, cs.changes[0]!.id)).toBe(true);
    expect(existsSync(join(ws, "reject-me.txt"))).toBe(false);
    expect(mgr.getChangeSet(cs.id)!.changes[0]!.status).toBe("rejected");
  });

  it("rollback restores the stored original snapshot", () => {
    const target = join(ws, "notes.txt");
    writeFileSync(target, "original line\n", "utf8");

    const mgr = new ChangeSetManager({ workspaceRoot: ws });
    const cs = stage(mgr, "notes.txt", "edited line\n");

    const apply = mgr.acceptChange(cs.id, cs.changes[0]!.id);
    expect(apply.success).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("edited line\n");

    const rb = mgr.rollbackChange(cs.id, cs.changes[0]!.id);
    expect(rb.success).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("original line\n");
  });

  it("conflict detection never overwrites newer user content", () => {
    const target = join(ws, "shared.txt");
    writeFileSync(target, "v1\n", "utf8");

    const mgr = new ChangeSetManager({ workspaceRoot: ws });
    const cs = stage(mgr, "shared.txt", "v2\n");

    // External modification between staging and approval.
    writeFileSync(target, "NEWER USER CONTENT\n", "utf8");

    const res = mgr.acceptChange(cs.id, cs.changes[0]!.id);
    expect(res.success).toBe(false);
    expect(res.error).toContain("modified externally");
    expect(readFileSync(target, "utf8")).toBe("NEWER USER CONTENT\n");
    expect(mgr.getChangeSet(cs.id)!.changes[0]!.status).toBe("conflict");
  });
});