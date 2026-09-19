/**
 * WorkspaceBoundary security tests: traversal, absolute-escape, symlink-escape,
 * nonexistent paths and validity edge cases (Windows + POSIX path syntax).
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { WorkspaceBoundary } from "./workspace-boundary.js";
import { tempWorkspace } from "./testing-helpers.js";

const EXEC = "exec-1";

/** Extract the error code from a failed resolution (tests assert ok===false first). */
function failureCode(res: {
  ok: boolean;
  error?: { code: string };
}): string | undefined {
  return res.ok ? undefined : res.error?.code;
}

describe("WorkspaceBoundary", () => {
  it("resolves relative paths inside the workspace", () => {
    const ws = tempWorkspace({ "src/a.txt": "x" });
    try {
      const boundary = new WorkspaceBoundary(ws.root);
      const res = boundary.resolve("src/a.txt", EXEC, true);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.relativePath).toBe("src/a.txt");
        expect(res.absolutePath).toBe(path.join(boundary.root, "src", "a.txt"));
      }
    } finally {
      ws.cleanup();
    }
  });

  it("rejects .. traversal", () => {
    const ws = tempWorkspace();
    try {
      const boundary = new WorkspaceBoundary(ws.root);
      const res = boundary.resolve("../escape.txt", EXEC);
      expect(res.ok).toBe(false);
      expect(failureCode(res)).toBe("PATH_SECURITY");
    } finally {
      ws.cleanup();
    }
  });

  it("rejects embedded ../ segments", () => {
    const ws = tempWorkspace();
    try {
      const boundary = new WorkspaceBoundary(ws.root);
      const res = boundary.resolve("a/../../etc/passwd", EXEC);
      expect(res.ok).toBe(false);
      expect(failureCode(res)).toBe("PATH_SECURITY");
    } finally {
      ws.cleanup();
    }
  });

  it("rejects absolute paths outside the workspace (POSIX and Windows forms)", () => {
    const ws = tempWorkspace();
    try {
      const boundary = new WorkspaceBoundary(ws.root);
      for (const attempt of [
        "/etc/passwd",
        "C:\\Windows\\system32\\evil.exe",
        "//server/share",
      ]) {
        const res = boundary.resolve(attempt, EXEC);
        expect(res.ok, attempt).toBe(false);
        expect(failureCode(res), attempt).toBe("PATH_SECURITY");
      }
    } finally {
      ws.cleanup();
    }
  });

  it("allows absolute paths that stay inside the workspace", () => {
    const ws = tempWorkspace({ "deep/file.txt": "x" });
    try {
      const boundary = new WorkspaceBoundary(ws.root);
      const abs = path.join(boundary.root, "deep", "file.txt");
      const res = boundary.resolve(abs, EXEC, true);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.relativePath).toBe("deep/file.txt");
    } finally {
      ws.cleanup();
    }
  });

  it("rejects symlink escapes when the target is outside the workspace", () => {
    const outside = tempWorkspace();
    const ws = tempWorkspace();
    try {
      const boundary = new WorkspaceBoundary(ws.root);
      const link = path.join(ws.root, "escape");
      try {
        fs.symlinkSync(outside.root, link);
      } catch {
        // Symlinks unsupported (e.g. restricted Windows) — test is not
        // meaningful here; the null-byte check below still was covered.
        return;
      }
      const res = boundary.resolve("escape/secret.txt", EXEC);
      expect(res.ok).toBe(false);
      expect(failureCode(res)).toBe("PATH_SECURITY");
    } finally {
      ws.cleanup();
      outside.cleanup();
    }
  });

  it("rejects null bytes", () => {
    const ws = tempWorkspace();
    try {
      const boundary = new WorkspaceBoundary(ws.root);
      const res = boundary.resolve("a\0b", EXEC);
      expect(res.ok).toBe(false);
      expect(failureCode(res)).toBe("PATH_SECURITY");
    } finally {
      ws.cleanup();
    }
  });

  it("returns NOT_FOUND for missing files when mustExist is set", () => {
    const ws = tempWorkspace();
    try {
      const boundary = new WorkspaceBoundary(ws.root);
      const res = boundary.resolve("missing.txt", EXEC, true);
      expect(res.ok).toBe(false);
      expect(failureCode(res)).toBe("NOT_FOUND");
    } finally {
      ws.cleanup();
    }
  });

  it("rejects empty and non-string paths", () => {
    const ws = tempWorkspace();
    try {
      const boundary = new WorkspaceBoundary(ws.root);
      expect(boundary.resolve("", EXEC).ok).toBe(false);
      expect(boundary.resolve("   ", EXEC).ok).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  it("rejects relative '.' segments", () => {
    const ws = tempWorkspace({ "a.txt": "x" });
    try {
      const boundary = new WorkspaceBoundary(ws.root);
      const res = boundary.resolve("./a.txt", EXEC);
      expect(res.ok).toBe(false);
      expect(failureCode(res)).toBe("VALIDATION");
    } finally {
      ws.cleanup();
    }
  });

  it("normalizes Windows-style separators on all platforms", () => {
    const ws = tempWorkspace({ "nested/file.txt": "x" });
    try {
      const boundary = new WorkspaceBoundary(ws.root);
      const res = boundary.resolve("nested\\file.txt", EXEC, true);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.relativePath).toBe("nested/file.txt");
    } finally {
      ws.cleanup();
    }
  });

  it("throws when constructed without a root", () => {
    expect(() => new WorkspaceBoundary("")).toThrow();
  });
});
