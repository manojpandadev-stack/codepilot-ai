import { describe, it, expect } from "vitest";
import {
  resolveWorkspacePath,
  applyEditorOperation,
  parseEditorInput,
  formatStagedResult,
} from "./write-tools.js";

// ============================================================================
// Path safety (Feature Group 25 — path traversal / workspace escape)
// ============================================================================

describe("resolveWorkspacePath", () => {
  it("resolves a relative path inside the workspace", () => {
    const r = resolveWorkspacePath("src/app.ts", "C:/proj");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.absolutePath).toBe("C:/proj/src/app.ts");
    expect(r.relativePath).toBe("src/app.ts");
  });

  it("rejects parent-directory traversal", () => {
    const r = resolveWorkspacePath("../../etc/passwd", "C:/proj");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("traversal");
  });

  it("rejects absolute paths outside the workspace", () => {
    expect(resolveWorkspacePath("C:/Windows/System32", "C:/proj").ok).toBe(false);
    expect(resolveWorkspacePath("/etc/hosts", "C:/proj").ok).toBe(false);
    expect(resolveWorkspacePath("\\\\server\\share\\x", "C:/proj").ok).toBe(false);
  });

  it("rejects empty paths and '.' segments", () => {
    expect(resolveWorkspacePath("", "C:/proj").ok).toBe(false);
    expect(resolveWorkspacePath("./src/app.ts", "C:/proj").ok).toBe(false);
  });
});

// ============================================================================
// In-memory editor operations (Feature Group 8 — smart file operations)
// ============================================================================

describe("applyEditorOperation", () => {
  it("creates a new file when no original content exists", () => {
    const r = applyEditorOperation(undefined, { op: "create", new_string: "CodePilot AI test" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toBe("CodePilot AI test");
  });

  it("str_replace replaces the first occurrence only", () => {
    const r = applyEditorOperation("a b a", { op: "str_replace", old_string: "a", new_string: "X" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toBe("X b a");
  });

  it("replace_all replaces every occurrence", () => {
    const r = applyEditorOperation("a b a", { op: "replace_all", old_string: "a", new_string: "X" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toBe("X b X");
  });

  it("insert places new_string before old_string", () => {
    const r = applyEditorOperation("hello", { op: "insert", old_string: "hello", new_string: "// hi\n" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toBe("// hi\nhello");
  });

  it("delete removes the matched text", () => {
    const r = applyEditorOperation("keep it keep", { op: "delete", old_string: " it" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toBe("keep keep");
  });

  it("fails when old_string is not found", () => {
    const r = applyEditorOperation("abc", { op: "str_replace", old_string: "zzz", new_string: "y" });
    expect(r.ok).toBe(false);
  });
});

// ============================================================================
// parseEditorInput — staged proposals (Feature Group 13 — Act mode / ChangeSet)
// ============================================================================

describe("parseEditorInput", () => {
  it("stages a brand-new file proposal without touching the filesystem", () => {
    const r = parseEditorInput(
      { file_path: "codepilot-test.txt", old_string: "", new_string: "CodePilot AI test" },
      "C:/ws",
      () => undefined
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0]!.relativePath).toBe("codepilot-test.txt");
    expect(r.proposals[0]!.proposedContent).toBe("CodePilot AI test");
  });

  it("applies edits against the original file content supplied by the caller", () => {
    const r = parseEditorInput(
      { file_path: "src/app.ts", old_string: "old", new_string: "new" },
      "C:/ws",
      () => "const old = 1;"
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposals[0]!.proposedContent).toBe("const new = 1;");
  });

  it("rejects a proposal targeting a path outside the workspace", () => {
    const r = parseEditorInput(
      { file_path: "../../escape.txt", old_string: "", new_string: "x" },
      "C:/ws",
      () => undefined
    );
    expect(r.ok).toBe(false);
  });
});

describe("formatStagedResult", () => {
  it("mentions the ChangeSet id and that no file was modified", () => {
    const out = formatStagedResult("editor", "cs-1", [
      { filePath: "codepilot-test.txt", relativePath: "codepilot-test.txt", proposedContent: "hi" },
    ]);
    expect(out).toContain("cs-1");
    expect(out).toContain("No file was modified");
  });
});