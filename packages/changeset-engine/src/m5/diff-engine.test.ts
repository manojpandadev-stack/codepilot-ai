/**
 * M5 diff engine tests: new/modified/deleted/renamed files, additions and
 * deletions, unified diff text and binary detection. All pure functions.
 */
import { describe, expect, it } from "vitest";
import { computeDiff, hashContent, isBinaryContent } from "./diff-engine.js";

describe("computeDiff", () => {
  it("detects a created file with all additions", () => {
    const diff = computeDiff({
      filePath: "src/new.ts",
      oldContent: null,
      newContent: "alpha\nbeta\n",
      context: 3,
    });
    expect(diff.operation).toBe("created");
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(0);
    expect(diff.binary).toBe(false);
    expect(diff.unifiedDiff).toContain("--- /dev/null");
    expect(diff.unifiedDiff).toContain("+++ b/src/new.ts");
    expect(diff.unifiedDiff).toContain("+alpha");
    expect(diff.unifiedDiff).toContain("+beta");
    expect(diff.hunks.length).toBeGreaterThan(0);
  });

  it("detects a deleted file with all deletions", () => {
    const diff = computeDiff({
      filePath: "src/old.ts",
      oldContent: "alpha\nbeta\n",
      newContent: null,
    });
    expect(diff.operation).toBe("deleted");
    expect(diff.additions).toBe(0);
    expect(diff.deletions).toBe(2);
    expect(diff.unifiedDiff).toContain("--- a/src/old.ts");
    expect(diff.unifiedDiff).toContain("+++ /dev/null");
    expect(diff.unifiedDiff).toContain("-alpha");
  });

  it("computes additions and deletions for a modified file", () => {
    const diff = computeDiff({
      filePath: "src/app.ts",
      oldContent: "a\nb\nc\n",
      newContent: "a\nx\nc\n",
      context: 2,
    });
    expect(diff.operation).toBe("modified");
    expect(diff.additions).toBe(1);
    expect(diff.deletions).toBe(1);
    expect(diff.unifiedDiff).toContain("-b");
    expect(diff.unifiedDiff).toContain("+x");
  });

  it("is a no-op diff for identical content", () => {
    const diff = computeDiff({
      filePath: "a.txt",
      oldContent: "same\n",
      newContent: "same\n",
    });
    expect(diff.operation).toBe("modified");
    expect(diff.additions).toBe(0);
    expect(diff.deletions).toBe(0);
    expect(diff.unifiedDiff).toBe("");
  });

  it("reports renames via oldPath", () => {
    const diff = computeDiff({
      filePath: "src/renamed.ts",
      oldPath: "src/original.ts",
      oldContent: "a\n",
      newContent: "a\n",
    });
    expect(diff.operation).toBe("renamed");
    expect(diff.oldPath).toBe("src/original.ts");
    expect(diff.additions).toBe(0);
    expect(diff.deletions).toBe(0);
  });

  it("detects binary content and omits hunks", () => {
    const diff = computeDiff({
      filePath: "bin.dat",
      oldContent: null,
      newContent: "abc\0def",
    });
    expect(diff.binary).toBe(true);
    expect(diff.additions).toBe(0);
    expect(diff.deletions).toBe(0);
    expect(diff.hunks).toEqual([]);
    expect(diff.unifiedDiff).toBe("");
  });

  it("caps context and emits hunk headers", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line${i}`);
    const changed = [...lines];
    changed[20] = "CHANGED";
    const diff = computeDiff({
      filePath: "big.txt",
      oldContent: lines.join("\n") + "\n",
      newContent: changed.join("\n") + "\n",
      context: 1,
    });
    expect(diff.additions).toBe(1);
    expect(diff.deletions).toBe(1);
    const header = diff.hunks[0];
    expect(header?.oldStart).toBe(20);
    expect(diff.unifiedDiff).toContain("-line20");
    expect(diff.unifiedDiff).toContain("+CHANGED");
  });
});

describe("hashContent / isBinaryContent", () => {
  it("hashes deterministically", () => {
    expect(hashContent("hello\n")).toBe(hashContent("hello\n"));
    expect(hashContent("a")).not.toBe(hashContent("b"));
  });

  it("detects NUL bytes as binary", () => {
    expect(isBinaryContent("plain text")).toBe(false);
    expect(isBinaryContent("a\u0000b")).toBe(true);
  });
});
