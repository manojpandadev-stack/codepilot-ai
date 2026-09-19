/**
 * @codepilot/tool-engine — M3 built-in git tools
 *
 * git_status and git_diff are read-only: they shell out to `git` via the
 * controlled CommandExecutionService with structured args (no string
 * concatenation). Both gracefully report when the workspace is not a git
 * repository instead of throwing raw process errors.
 */

import type { ToolContext, ToolDefinition, ToolError } from "../types.js";
import { toolError } from "../types.js";
import type { WorkspaceBoundary } from "../workspace-boundary.js";
import type { CommandExecutionService } from "../command-execution.js";
import { redactSecrets } from "../audit-logger.js";

export const DEFAULT_DIFF_CAP_BYTES = 262_144; // 256 KiB

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  cancelled: boolean;
}

function checkAborted(ctx: ToolContext): void {
  if (ctx.signal.aborted) {
    throw toolError("CANCELLED", "Cancelled", ctx.executionId, {
      recoverable: false,
    });
  }
}

async function runGit(
  service: CommandExecutionService,
  boundary: WorkspaceBoundary,
  args: string[],
  ctx: ToolContext,
): Promise<GitResult> {
  checkAborted(ctx);
  const out = await service.run(
    { command: "git", args, cwd: boundary.root, timeoutMs: 30_000 },
    { signal: ctx.signal },
  );
  if (out.timedOut) {
    throw toolError("TIMEOUT", `git ${args[0]} timed out`, ctx.executionId, {
      retryable: true,
    });
  }
  if (out.cancelled) {
    throw toolError("CANCELLED", "Cancelled", ctx.executionId, {
      recoverable: false,
    });
  }
  return {
    stdout: out.stdout,
    stderr: out.stderr,
    exitCode: out.exitCode ?? 1,
    timedOut: out.timedOut,
    cancelled: out.cancelled,
  };
}

function gitFailure(
  res: GitResult,
  ctx: ToolContext,
  action: string,
): ToolError {
  const stderr = redactSecrets(res.stderr.trim());
  if (res.exitCode === 128 && /not a git repository/i.test(stderr)) {
    return toolError(
      "UNSUPPORTED",
      "Workspace is not a git repository — git tools are unavailable",
      ctx.executionId,
    );
  }
  return toolError(
    "COMMAND_FAILED",
    `git ${action} failed (exit ${res.exitCode}): ${(stderr || res.stdout).slice(0, 500)}`,
    ctx.executionId,
    { recoverable: true },
  );
}

// ============================================================================
// git_status
// ============================================================================

export function createGitStatusTool(
  boundary: WorkspaceBoundary,
  service: CommandExecutionService,
): ToolDefinition<Record<string, never>, unknown> {
  return {
    id: "git_status",
    name: "Git Status",
    description:
      "Show the working-tree status of the workspace (branch, ahead/behind, changed files).",
    category: "git",
    version: "1.0.0",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        branch: { type: "string" },
        ahead: { type: "number" },
        behind: { type: "number" },
        changes: { type: "array", items: { type: "object" } },
        clean: { type: "boolean" },
      },
      required: ["branch", "changes", "clean"],
    },
    capabilities: ["idempotent"],
    permission: {
      level: "read",
      requiresApproval: false,
      rationale: "Read git working-tree status",
    },
    idempotent: true,
    async execute(_input, ctx): Promise<unknown> {
      const res = await runGit(
        service,
        boundary,
        ["status", "--porcelain=v1", "-b"],
        ctx,
      );
      if (res.exitCode !== 0) throw gitFailure(res, ctx, "status");
      const lines = res.stdout.split("\n").filter((l) => l.length > 0);
      let branch = "";
      let ahead = 0;
      let behind = 0;
      const changes: Array<{ status: string; path: string }> = [];
      for (const line of lines) {
        if (line.startsWith("## ")) {
          const head = line.slice(3);
          const up = head.split("...")[1];
          branch = head.split("...")[0] ?? "";
          if (up) {
            const aheadM = up.match(/ahead (\d+)/);
            const behindM = up.match(/behind (\d+)/);
            if (aheadM) ahead = Number(aheadM[1]);
            if (behindM) behind = Number(behindM[1]);
          }
          continue;
        }
        const code = line.slice(0, 2);
        const filePath = line.slice(3);
        changes.push({ status: code.trim(), path: filePath });
      }
      ctx.progress({
        message: `git status: ${changes.length} change(s) on ${branch || "(detached)"}`,
      });
      return { branch, ahead, behind, changes, clean: changes.length === 0 };
    },
  };
}

// ============================================================================
// git_diff
// ============================================================================

export function createGitDiffTool(
  boundary: WorkspaceBoundary,
  service: CommandExecutionService,
): ToolDefinition<
  { path?: string; staged?: boolean; maxBytes?: number },
  unknown
> {
  return {
    id: "git_diff",
    name: "Git Diff",
    description:
      "Show uncommitted changes (or staged changes) as a diff, with a stat summary.",
    category: "git",
    version: "1.0.0",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Restrict the diff to a workspace-relative path",
        },
        staged: {
          type: "boolean",
          description:
            "Show staged (index) changes instead of working-tree changes",
        },
        maxBytes: {
          type: "number",
          description: `Maximum diff bytes to return (default ${DEFAULT_DIFF_CAP_BYTES})`,
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        diff: { type: "string" },
        stat: { type: "string" },
        truncated: { type: "boolean" },
      },
      required: ["diff", "stat", "truncated"],
    },
    capabilities: ["idempotent"],
    permission: {
      level: "read",
      requiresApproval: false,
      rationale: "Read git diff",
    },
    idempotent: true,
    async execute(input, ctx): Promise<unknown> {
      let relPath: string | null = null;
      if (input.path !== undefined) {
        if (typeof input.path !== "string" || input.path.trim().length === 0) {
          throw toolError(
            "VALIDATION",
            "path must be a non-empty string",
            ctx.executionId,
            {
              recoverable: false,
            },
          );
        }
        const res = boundary.resolve(input.path, ctx.executionId, true);
        if (!res.ok) throw res.error;
        relPath = res.relativePath;
      }
      const cap =
        typeof input.maxBytes === "number" && input.maxBytes > 0
          ? Math.min(input.maxBytes, 4 * 1_048_576)
          : DEFAULT_DIFF_CAP_BYTES;
      const cached = input.staged === true ? "--cached" : null;

      const statArgs = cached
        ? ["diff", "--cached", "--stat"]
        : ["diff", "--stat"];
      const statRes = await runGit(service, boundary, statArgs, ctx);
      if (statRes.exitCode !== 0) throw gitFailure(statRes, ctx, "diff --stat");

      const diffArgs = cached ? ["diff", "--cached"] : ["diff"];
      if (relPath) diffArgs.push("--", relPath);
      const diffRes = await runGit(service, boundary, diffArgs, ctx);
      if (diffRes.exitCode !== 0) throw gitFailure(diffRes, ctx, "diff");

      const diff = diffRes.stdout;
      ctx.progress({ message: `git diff: ${diff.length} bytes` });
      return {
        diff: diff.slice(0, cap),
        stat: statRes.stdout.slice(0, 4_096),
        truncated: diff.length > cap,
      };
    },
  };
}

// ============================================================================
// Factory
// ============================================================================

export function createGitTools(
  boundary: WorkspaceBoundary,
  service: CommandExecutionService,
): ToolDefinition[] {
  return [
    createGitStatusTool(boundary, service),
    createGitDiffTool(boundary, service),
  ];
}
