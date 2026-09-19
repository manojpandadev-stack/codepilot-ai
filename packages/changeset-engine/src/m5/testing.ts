/**
 * @codepilot/changeset-engine — M5 test helpers
 *
 * Minimal temp-workspace + PathGuard used by the M5 core test suites. The
 * guard mirrors the production tool-engine adapter contract (normalize, reject
 * traversal/absolute escapes, flag sensitive files) without importing it, so
 * the changeset-engine core stays dependency-free.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PathGuard } from "./file-mutation.js";
import { M5Error } from "./errors.js";

const SENSITIVE_NAMES = new Set([
  ".env",
  ".env.local",
  ".gitignore",
  ".gitattributes",
  ".git",
  ".npmrc",
]);

/**
 * Create a temp workspace with the given files (`rel -> content`) and return
 * `{ root, cleanup }`. Cleanup is `finally`-safe.
 */
export function tempWorkspace(files?: Record<string, string>): {
  root: string;
  cleanup: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-m5-"));
  if (files) {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
    }
  }
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * PathGuard mirroring the production M3/M4-backed adapter: normalizes the
 * workspace-relative path, rejects traversal/absolute escapes and marks known
 * sensitive files. Deterministic and quick for tests.
 */
export function testPathGuard(root: string): PathGuard {
  return {
    guard(workspaceRelativePath: string): string {
      if (
        typeof workspaceRelativePath !== "string" ||
        workspaceRelativePath === ""
      ) {
        throw new M5Error("INVALID_PATH", "path must be a non-empty string", {
          path: workspaceRelativePath,
        });
      }
      if (workspaceRelativePath.includes("\0")) {
        throw new M5Error("INVALID_PATH", "path contains a null byte", {
          path: workspaceRelativePath,
        });
      }
      const normalized = path.normalize(workspaceRelativePath);
      if (
        normalized.startsWith("..") ||
        path.isAbsolute(normalized) ||
        normalized.includes(`..${path.sep}`)
      ) {
        throw new M5Error(
          "OUTSIDE_WORKSPACE",
          `path escapes workspace: ${workspaceRelativePath}`,
          {
            path: workspaceRelativePath,
          },
        );
      }
      if (normalized === ".") {
        throw new M5Error(
          "INVALID_PATH",
          "path resolves to the workspace root",
          {
            path: workspaceRelativePath,
          },
        );
      }
      const guarded = path.join(root, normalized);
      if (!guarded.startsWith(root + path.sep)) {
        throw new M5Error(
          "OUTSIDE_WORKSPACE",
          `path escapes workspace: ${workspaceRelativePath}`,
          {
            path: workspaceRelativePath,
          },
        );
      }
      return normalized;
    },
    isSensitive(workspaceRelativePath: string): boolean {
      const base = path.basename(workspaceRelativePath);
      if (SENSITIVE_NAMES.has(base)) return true;
      const normalized = path.normalize(workspaceRelativePath);
      const segments = normalized.split(path.sep);
      return (
        segments.some((s) => s === ".git") || segments.some((s) => s === ".env")
      );
    },
  };
}
