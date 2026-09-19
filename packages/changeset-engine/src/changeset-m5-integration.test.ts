/**
 * Integration: ChangeSet accept/rollback MUST dispatch through M5's
 * FileMutationService (path guard, optimistic concurrency, atomic writes,
 * tracked-change ledger, events) — never raw fs writes.
 *
 * Regression guards against the audited S2 finding reappearing: a raw
 * `writeFileSync` in the accept path would leave `mutation.listChanges()`
 * empty, which these tests assert can never happen.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ChangeSetManager } from "./index.js";
import { FileMutationService } from "./m5/file-mutation.js";
import type { PathGuard } from "./m5/file-mutation.js";

const guard: PathGuard = {
  guard(rel: string) {
    if (
      !rel ||
      rel.includes("..") ||
      rel.startsWith("/") ||
      /^[A-Za-z]:/.test(rel)
    ) {
      throw new Error(`guard rejected: ${rel}`);
    }
    return rel.replace(/\\/g, "/");
  },
  isSensitive: (rel: string) => /(^|\/)\.env/.test(rel),
};

describe("ChangeSet → M5 FileMutationService integration", () => {
  let dir: string;
  let csm: ChangeSetManager;
  let mutation: FileMutationService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cs-m5-"));
    mutation = new FileMutationService({
      workspaceRoot: dir,
      pathGuard: guard,
    });
    csm = new ChangeSetManager({ workspaceRoot: dir, mutation });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("modify of existing file goes through FileMutationService", async () => {
    const p = join(dir, "code.ts");
    require("fs").writeFileSync(p, "export const a = 1;\n", "utf8");
    const cs = csm.createChangeSet("t1", [
      { filePath: "code.ts", proposedContent: "export const a = 2;\n" },
    ]);
    const res = await csm.acceptChange(cs.id, cs.changes[0]!.id);
    expect(res.success).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("export const a = 2;\n");
    // Proof of the M5 path: the mutation is in the tracked ledger.
    expect(mutation.listChanges().length).toBe(1);
    expect(mutation.listChanges()[0]!.path).toBe("code.ts");
    expect(mutation.listChanges()[0]!.status).toBe("applied");
  });

  it("create of new file goes through FileMutationService", async () => {
    const cs = csm.createChangeSet("t2", [
      { filePath: "new/file.ts", proposedContent: "export {};\n" },
    ]);
    const res = await csm.acceptChange(cs.id, cs.changes[0]!.id);
    expect(res.success).toBe(true);
    expect(existsSync(join(dir, "new/file.ts"))).toBe(true);
    expect(mutation.listChanges().length).toBe(1);
    expect(mutation.listChanges()[0]!.kind).toBe("create");
  });

  it("rollback routes the inverse op through FileMutationService", async () => {
    const p = join(dir, "rb.txt");
    require("fs").writeFileSync(p, "before\n", "utf8");
    const cs = csm.createChangeSet("t3", [
      { filePath: "rb.txt", proposedContent: "after\n" },
    ]);
    await csm.acceptChange(cs.id, cs.changes[0]!.id);
    const rb = await csm.rollbackChange(cs.id, cs.changes[0]!.id);
    expect(rb.success).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("before\n");
    // apply + inverse = two tracked mutations
    expect(mutation.listChanges().length).toBe(2);
  });

  it("rollback of a created file deletes it via M5", async () => {
    const cs = csm.createChangeSet("t4", [
      { filePath: "created.txt", proposedContent: "x\n" },
    ]);
    await csm.acceptChange(cs.id, cs.changes[0]!.id);
    expect(existsSync(join(dir, "created.txt"))).toBe(true);
    const rb = await csm.rollbackChange(cs.id, cs.changes[0]!.id);
    expect(rb.success).toBe(true);
    expect(existsSync(join(dir, "created.txt"))).toBe(false);
    expect(mutation.listChanges().some((c) => c.kind === "delete")).toBe(true);
  });

  it("optimistic concurrency: external modification aborts the accept (M5, no partial state)", async () => {
    const p = join(dir, "conflict.ts");
    require("fs").writeFileSync(p, "v1\n", "utf8");
    const cs = csm.createChangeSet("t5", [
      { filePath: "conflict.ts", proposedContent: "v2\n" },
    ]);
    // External modification after ChangeSet creation → conflict at accept.
    require("fs").writeFileSync(p, "v1-EXTERNAL\n", "utf8");
    const res = await csm.acceptChange(cs.id, cs.changes[0]!.id);
    expect(res.success).toBe(false);
    expect(cs.changes[0]!.status).toBe("conflict");
    expect(readFileSync(p, "utf8")).toBe("v1-EXTERNAL\n");
  });

  it("path escape is rejected (ChangeSetManager boundary, before M5)", () => {
    // Defense-in-depth: the lexical boundary fires at ChangeSet creation;
    // the M5 guard would reject it again at write time.
    expect(() =>
      csm.createChangeSet("t6", [
        { filePath: "../escape.txt", proposedContent: "evil\n" },
      ]),
    ).toThrow(/escapes workspace boundary/i);
    expect(existsSync(join(dir, "../escape.txt"))).toBe(false);
  });

  it("sensitive files are rejected by the M5 guard", async () => {
    const cs = csm.createChangeSet("t7", [
      { filePath: ".env", proposedContent: "SECRET=1\n" },
    ]);
    const res = await csm.acceptChange(cs.id, cs.changes[0]!.id);
    expect(res.success).toBe(false);
  });

  it("events fire from the M5 path for accepted changes", async () => {
    const events: string[] = [];
    const m = new FileMutationService({
      workspaceRoot: dir,
      pathGuard: guard,
      onEvent: (e) => events.push(String((e as { kind?: string }).kind)),
    });
    const manager = new ChangeSetManager({ workspaceRoot: dir, mutation: m });
    const cs = manager.createChangeSet("t8", [
      { filePath: "evt.txt", proposedContent: "hello\n" },
    ]);
    await manager.acceptChange(cs.id, cs.changes[0]!.id);
    expect(events.some((k) => k === "FILE_CHANGE_STARTED")).toBe(true);
    expect(events.some((k) => k === "FILE_CHANGE_COMPLETED")).toBe(true);
  });

  it("delete-kind changes are applied through M5", async () => {
    const p = join(dir, "gone.txt");
    require("fs").writeFileSync(p, "delete me\n", "utf8");
    // A ChangeSet change with empty proposed content models a delete.
    const cs = csm.createChangeSet("t9", [
      { filePath: "gone.txt", proposedContent: "" },
    ]);
    const res = await csm.acceptChange(cs.id, cs.changes[0]!.id);
    expect(res.success).toBe(true);
    // Empty-content change routes as a modify to empty content (not a raw
    // unlink) — the file exists with empty content, tracked by M5.
    expect(mutation.listChanges().length).toBe(1);
    expect(readFileSync(p, "utf8")).toBe("");
  });
});
