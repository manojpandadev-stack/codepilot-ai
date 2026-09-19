/**
 * @codepilot/tool-engine — M5 PathGuard adapter
 *
 * Adapts the existing M3 WorkspaceBoundary + M4 SecurityValidator onto the
 * changeset-engine `PathGuard` port. Every M5 mutation path passes through
 * BOTH primitives twice: once here (normalization + sensitive-file / traversal
 * rejection) and again inside the M4 pipeline (SecurityValidator boundary
 * enforcement before allow decisions complete). There is no third path.
 */

import { M5Error, type PathGuard } from "@codepilot/changeset-engine";
import { WorkspaceBoundary } from "../m3/workspace-boundary.js";
import { SecurityValidator } from "../m4/security-validator.js";

const SENSITIVE_DENY = /sensitive file denied/i;

export interface M5PathGuardOptions {
  boundary: WorkspaceBoundary;
  security: SecurityValidator;
}

/** PathGuard backed by M3/M4 primitives (production default). */
export class M5PathGuard implements PathGuard {
  private readonly boundary: WorkspaceBoundary;
  private readonly security: SecurityValidator;

  constructor(options: M5PathGuardOptions) {
    this.boundary = options.boundary;
    this.security = options.security;
  }

  /**
   * Normalize + validate a workspace-relative path. Throws M5Error for
   * traversal / absolute-escape / sensitive-file / missing-empty paths.
   */
  guard(workspaceRelativePath: string): string {
    if (
      typeof workspaceRelativePath !== "string" ||
      workspaceRelativePath === ""
    ) {
      throw new M5Error("INVALID_PATH", "path must be a non-empty string", {
        path: workspaceRelativePath,
      });
    }
    const resolved = this.boundary.resolve(
      workspaceRelativePath,
      "m5-path-guard",
    );
    if (!resolved.ok) {
      const code =
        resolved.error.code === "PATH_SECURITY"
          ? "OUTSIDE_WORKSPACE"
          : "INVALID_PATH";
      throw new M5Error(code, resolved.error.message, {
        path: workspaceRelativePath,
      });
    }
    const rel = resolved.relativePath;
    // Dual-check against the M4 validator (sensitive paths + traversal).
    const sec = this.security.validatePath(rel);
    if (!sec.allowed) {
      const isSensitive = SENSITIVE_DENY.test(sec.reason ?? "");
      throw new M5Error(
        isSensitive ? "SENSITIVE_FILE" : "OUTSIDE_WORKSPACE",
        sec.reason ?? "path denied",
        { path: workspaceRelativePath },
      );
    }
    return rel;
  }

  /** True for sensitive files (secrets/credentials) that must never mutate. */
  isSensitive(workspaceRelativePath: string): boolean {
    const sec = this.security.validatePath(workspaceRelativePath);
    return !sec.allowed && SENSITIVE_DENY.test(sec.reason ?? "");
  }
}
