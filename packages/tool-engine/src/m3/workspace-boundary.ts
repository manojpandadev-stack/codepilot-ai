/**
 * @codepilot/tool-engine — M3 workspace boundary security
 *
 * Canonical workspace path resolution. Rejects absolute paths, `..` traversal,
 * drive/UNC escapes and (via realpath) symlink escapes — on Windows and POSIX.
 * All filesystem tools must go through this before touching disk.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { toolError, type ToolError } from "./types.js";

export type PathResolution =
  | { ok: true; absolutePath: string; relativePath: string }
  | { ok: false; error: ToolError };

export class WorkspaceBoundary {
  /** Canonical (realpath'd) workspace root. */
  readonly root: string;

  constructor(root: string) {
    if (!root || typeof root !== "string") {
      throw new Error("WorkspaceBoundary requires a non-empty root");
    }
    let canonical = path.resolve(root);
    try {
      // The root itself may be a symlink (e.g. /tmp on macOS, mapped drives).
      canonical = fs.realpathSync.native(canonical);
    } catch {
      // Root may not exist yet — keep the resolved absolute path.
    }
    this.root = canonical;
  }

  /**
   * Resolve a user/model-supplied path against the workspace boundary.
   * Accepts relative paths and absolute paths *inside* the workspace.
   */
  resolve(
    input: string,
    executionId: string,
    mustExist = false,
  ): PathResolution {
    if (typeof input !== "string" || input.trim().length === 0) {
      return {
        ok: false,
        error: toolError(
          "VALIDATION",
          "Path must be a non-empty string",
          executionId,
          {
            recoverable: false,
          },
        ),
      };
    }
    const trimmed = input.trim();
    const isWinAbsolute = /^[a-zA-Z]:[\\/]/.test(trimmed);
    const isUnc = trimmed.startsWith("\\\\") || trimmed.startsWith("//");
    const isPosixAbsolute = trimmed.startsWith("/");
    // Null bytes are never legitimate in paths.
    if (trimmed.includes("\0")) {
      return {
        ok: false,
        error: toolError(
          "PATH_SECURITY",
          "Path contains a null byte",
          executionId,
        ),
      };
    }

    let candidate: string;
    if (isWinAbsolute || isUnc || isPosixAbsolute) {
      candidate = path.resolve(trimmed);
      // Absolute paths are allowed only when they stay inside the workspace.
      if (!this.contains(candidate)) {
        return {
          ok: false,
          error: toolError(
            "PATH_SECURITY",
            `Absolute path outside workspace is not allowed: ${trimmed}`,
            executionId,
          ),
        };
      }
    } else {
      // Relative — normalize and reject traversal up front.
      const normalized = trimmed.replace(/\\/g, "/");
      const segments = normalized.split("/").filter((s) => s.length > 0);
      if (segments.includes("..")) {
        return {
          ok: false,
          error: toolError(
            "PATH_SECURITY",
            `Path traversal (..) is not allowed: ${trimmed}`,
            executionId,
          ),
        };
      }
      if (segments.some((s) => s === ".")) {
        return {
          ok: false,
          error: toolError(
            "VALIDATION",
            `Relative '.' segments are not allowed: ${trimmed}`,
            executionId,
            { recoverable: false },
          ),
        };
      }
      candidate = path.resolve(this.root, ...segments);
    }

    // Canonical containment: resolve symlinks (path then nearest existing
    // ancestor) and re-check the boundary. This defeats symlink escapes.
    const canonical = this.canonicalize(candidate);
    if (!this.contains(canonical)) {
      return {
        ok: false,
        error: toolError(
          "PATH_SECURITY",
          `Resolved path escapes the workspace boundary: ${trimmed}`,
          executionId,
        ),
      };
    }

    const relativePath = path
      .relative(this.root, canonical)
      .replace(/\\/g, "/");
    if (mustExist && !fs.existsSync(canonical)) {
      return {
        ok: false,
        error: toolError(
          "NOT_FOUND",
          `Path does not exist: ${relativePath}`,
          executionId,
        ),
      };
    }
    return {
      ok: true,
      absolutePath: canonical,
      relativePath: relativePath || ".",
    };
  }

  /** True when `p` is exactly the root or a strict descendant of it. */
  contains(p: string): boolean {
    const rel = path.relative(this.root, p);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }

  /**
   * Best-effort canonicalization: realpath the deepest existing ancestor so
   * that symlinked directories resolve to their target inside the boundary.
   */
  private canonicalize(p: string): string {
    let current = p;
    try {
      return fs.realpathSync.native(current);
    } catch {
      // Path (or an ancestor) doesn't exist — walk up to the first ancestor
      // that exists, realpath it, then re-join the remainder.
      const remainder: string[] = [];
      let dir = path.dirname(current);
      let base = path.basename(current);
      while (dir !== path.dirname(dir)) {
        remainder.unshift(base);
        try {
          const real = fs.realpathSync.native(dir);
          return path.join(real, ...remainder);
        } catch {
          base = path.basename(dir);
          dir = path.dirname(dir);
        }
      }
      return p;
    }
  }
}
