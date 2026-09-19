/**
 * @codepilot/tool-engine — M4 SecurityValidator
 *
 * Centralized security validation that sits between the ApprovalManager
 * and actual tool execution. Even when a permission has been granted, the
 * security validator enforces hard boundaries:
 *
 *   - Workspace boundary enforcement (path traversal prevention)
 *   - Command safety analysis
 *   - Secret/sensitive path detection
 *
 * Security validation CANNOT be bypassed by permission approval. Permission
 * authorizes an operation; security validation ensures it stays within bounds.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PermissionAction } from "./permission-types.js";

export interface SecurityValidationResult {
  allowed: boolean;
  reason?: string;
  sanitizedPreview?: Record<string, unknown>;
}

export interface SecurityValidatorOptions {
  workspaceRoot: string;
  sensitivePaths?: string[];
  resolveSymlinks?: boolean;
}

const DEFAULT_SENSITIVE_PATHS = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".npmrc",
  ".pypirc",
  "id_rsa",
  "id_ed25519",
  "id_dsa",
  ".aws/credentials",
  ".aws/config",
  ".ssh/config",
  "netrc",
  ".netrc",
  "credentials.json",
  "secrets.json",
  "serviceAccountKey.json",
  "service-account-key.json",
  ".gnupg",
  "credentials.xml",
  ".azure/accessTokens.json",
  ".azure/azureProfile.json",
  "token.json",
  ".claude-code-router/config.json",
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class SecurityValidator {
  private readonly _workspaceRoot: string;
  private readonly sensitivePatterns: RegExp[];
  private readonly resolveSymlinks: boolean;

  constructor(options: SecurityValidatorOptions) {
    this._workspaceRoot = path.resolve(options.workspaceRoot);
    const extraPaths = options.sensitivePaths ?? [];
    const allPaths = [...DEFAULT_SENSITIVE_PATHS, ...extraPaths];
    this.sensitivePatterns = allPaths.map(
      (p) => new RegExp(escapeRegex(p) + "$", "i"),
    );
    this.resolveSymlinks = options.resolveSymlinks ?? true;
  }

  /** The resolved workspace root path. */
  get workspaceRoot(): string {
    return this._workspaceRoot;
  }

  validatePath(rawPath: string): SecurityValidationResult {
    if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
      return { allowed: false, reason: "Path must be a non-empty string" };
    }

    // Reject null bytes (path traversal / injection)
    if (rawPath.includes("\x00")) {
      return { allowed: false, reason: "Path contains null bytes" };
    }

    const trimmed = rawPath.trim();
    // Reject absolute paths outright
    if (path.isAbsolute(trimmed)) {
      return {
        allowed: false,
        reason: `Absolute paths are not permitted: ${trimmed}`,
      };
    }

    // Reject Windows drive paths (C:, D:, etc.)
    if (/^[a-zA-Z]:/.test(trimmed)) {
      return {
        allowed: false,
        reason: `Windows drive paths are not permitted: ${trimmed}`,
      };
    }

    // Reject UNC paths
    if (trimmed.startsWith("\\\\") || trimmed.startsWith("//")) {
      return {
        allowed: false,
        reason: `UNC/network paths are not permitted: ${trimmed}`,
      };
    }

    // Resolve relative to workspace root
    const resolved = path.resolve(this.workspaceRoot, trimmed);

    // Canonicalize to catch traversal
    let canonical: string;
    try {
      canonical = this.resolveSymlinks ? fs.realpathSync(resolved) : resolved;
    } catch {
      // File may not exist yet — use resolved path
      canonical = resolved;
    }

    // Verify it's within workspace
    // Normalize to forward slashes so sensitive-path patterns (which use
    // forward slashes) match on Windows where path.relative uses backslashes.
    const rel = path.relative(this.workspaceRoot, canonical).replace(/\\/g, "/");
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return {
        allowed: false,
        reason: `Path escapes workspace boundary: ${trimmed}`,
      };
    }

    // Check sensitive paths
    for (const pattern of this.sensitivePatterns) {
      if (pattern.test(rel)) {
        return {
          allowed: false,
          reason: `Access to sensitive file denied: ${rel}`,
        };
      }
    }

    return { allowed: true, sanitizedPreview: { path: rel } };
  }

  validateCommand(command: string): SecurityValidationResult {
    if (typeof command !== "string" || command.trim().length === 0) {
      return { allowed: false, reason: "Command must be a non-empty string" };
    }

    // Redact potential secrets from command
    const secretPatterns = [
      /sk-[a-zA-Z0-9]{20,}/g,
      /Bearer\s+[a-zA-Z0-9\-._~+\/]+/g,
      /token[=:]\s*["']?[a-zA-Z0-9\-._~+\/]{20,}["']?/gi,
      /password[=:]\s*["']?[^\s"']+["']?/gi,
      /secret[=:]\s*["']?[^\s"']+["']?/gi,
    ];

    let sanitized = command;
    for (const pattern of secretPatterns) {
      sanitized = sanitized.replace(pattern, "[REDACTED]");
    }

    return {
      allowed: true,
      sanitizedPreview: { command: sanitized },
    };
  }

  validate(
    action: PermissionAction,
    metadata?: Record<string, unknown>,
  ): SecurityValidationResult {
    switch (action) {
      case "read_file":
      case "write_file":
      case "edit_file":
      case "delete_file":
      case "move_file":
      case "create_directory":
        return this.validatePath(
          (metadata?.path as string) ?? (metadata?.target as string) ?? "",
        );
      case "list_directory":
      case "search_files":
      case "search_text":
        return this.validatePath((metadata?.path as string) ?? "");
      case "execute_command":
        return this.validateCommand((metadata?.command as string) ?? "");
      default:
        return { allowed: true };
    }
  }
}
