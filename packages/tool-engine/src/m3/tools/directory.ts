/**
 * @codepilot/tool-engine — M3 built-in directory tools
 *
 * list_directory (bounded recursive listing) and create_directory.
 * Both are workspace-bound; hidden entries are omitted unless requested.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolContext, ToolDefinition } from "../types.js";
import { toolError } from "../types.js";
import type { WorkspaceBoundary } from "../workspace-boundary.js";

export const MAX_LISTING_ENTRIES = 10_000;
export const MAX_LISTING_DEPTH = 4;

export interface DirectoryEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink";
  size?: number;
}

function listRecursive(
  root: string,
  rel: string,
  includeHidden: boolean,
  maxDepth: number,
  budget: { remaining: number },
  out: DirectoryEntry[],
  seen: Set<string>,
): void {
  if (out.length >= MAX_LISTING_ENTRIES || budget.remaining <= 0) return;
  let entries: fs.Dirent[] = [];
  const abs = rel === "" || rel === "." ? root : path.join(root, rel);
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= MAX_LISTING_ENTRIES || budget.remaining <= 0) return;
    if (!includeHidden && entry.name.startsWith(".") && entry.name !== ".")
      continue;
    const childRel =
      rel === "" || rel === "." ? entry.name : `${rel}/${entry.name}`;
    let type: DirectoryEntry["type"] = "file";
    if (entry.isDirectory()) {
      type = "dir";
    } else if (entry.isSymbolicLink()) {
      type = "symlink";
    } else {
      type = "file";
    }
    out.push({ name: entry.name, path: childRel, type });
    budget.remaining--;
    if (type === "dir" && rel.split("/").length < maxDepth) {
      const key = path.resolve(root, childRel);
      if (!seen.has(key)) {
        seen.add(key);
        listRecursive(
          root,
          childRel,
          includeHidden,
          maxDepth,
          budget,
          out,
          seen,
        );
      }
    }
  }
}

function checkAborted(ctx: ToolContext): void {
  if (ctx.signal.aborted) {
    throw toolError("CANCELLED", "Cancelled", ctx.executionId, {
      recoverable: false,
    });
  }
}

function clampDepth(v: unknown): number {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) {
    return Math.min(v, MAX_LISTING_DEPTH);
  }
  return 1;
}

// ============================================================================
// list_directory
// ============================================================================

export function createListDirectoryTool(
  boundary: WorkspaceBoundary,
): ToolDefinition<
  { path?: string; includeHidden?: boolean; maxDepth?: number },
  unknown
> {
  return {
    id: "list_directory",
    name: "List Directory",
    description: `List directory entries (recursive up to maxDepth, ${MAX_LISTING_DEPTH} max). Returns up to ${MAX_LISTING_ENTRIES} entries.`,
    category: "filesystem",
    version: "1.0.0",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Directory path, relative to the workspace root (default: root)",
        },
        includeHidden: {
          type: "boolean",
          description: "Include dot-files/dot-dirs (default false)",
        },
        maxDepth: {
          type: "number",
          description: `Recursion depth (default 1, max ${MAX_LISTING_DEPTH})`,
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        entries: { type: "array", items: { type: "object" } },
        count: { type: "number" },
        truncated: { type: "boolean" },
      },
      required: ["path", "entries", "count", "truncated"],
    },
    capabilities: ["cancellable", "idempotent"],
    permission: {
      level: "read",
      requiresApproval: false,
      rationale: "List a directory in the workspace",
    },
    idempotent: true,
    async execute(input, ctx): Promise<unknown> {
      checkAborted(ctx);
      let rawPath = input.path ?? ".";
      if (typeof rawPath !== "string" || rawPath.trim().length === 0)
        rawPath = ".";
      const res = boundary.resolve(rawPath, ctx.executionId, true);
      if (!res.ok) throw res.error;
      const stat = fs.statSync(res.absolutePath);
      if (!stat.isDirectory()) {
        throw toolError(
          "VALIDATION",
          `${res.relativePath} is not a directory`,
          ctx.executionId,
          {
            recoverable: false,
          },
        );
      }
      const maxDepth = clampDepth(input.maxDepth);
      const out: DirectoryEntry[] = [];
      listRecursive(
        res.absolutePath,
        "",
        input.includeHidden === true,
        maxDepth,
        { remaining: MAX_LISTING_ENTRIES },
        out,
        new Set([res.absolutePath]),
      );
      ctx.progress({
        message: `Listed ${res.relativePath} (${out.length} entries)`,
      });
      return {
        path: res.relativePath,
        entries: out,
        count: out.length,
        truncated: out.length >= MAX_LISTING_ENTRIES,
      };
    },
  };
}

// ============================================================================
// create_directory
// ============================================================================

export function createCreateDirectoryTool(
  boundary: WorkspaceBoundary,
): ToolDefinition<{ path: string }, unknown> {
  return {
    id: "create_directory",
    name: "Create Directory",
    description:
      "Create a directory (and any missing parents) inside the workspace.",
    category: "filesystem",
    version: "1.0.0",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path, relative to the workspace root",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        created: { type: "boolean" },
      },
      required: ["path", "created"],
    },
    capabilities: [],
    permission: {
      level: "write",
      requiresApproval: true,
      rationale: "Create a directory in the workspace",
    },
    idempotent: true,
    async execute(input, ctx): Promise<unknown> {
      checkAborted(ctx);
      const raw = typeof input.path === "string" ? input.path : "";
      const res = boundary.resolve(raw, ctx.executionId, false);
      if (!res.ok) throw res.error;
      const created = !fs.existsSync(res.absolutePath);
      fs.mkdirSync(res.absolutePath, { recursive: true });
      ctx.progress({
        message: created
          ? `Created directory ${res.relativePath}`
          : `Directory ${res.relativePath} already exists`,
      });
      return { path: res.relativePath, created };
    },
  };
}

// ============================================================================
// Factory
// ============================================================================

export function createDirectoryTools(
  boundary: WorkspaceBoundary,
): ToolDefinition[] {
  return [
    createListDirectoryTool(boundary),
    createCreateDirectoryTool(boundary),
  ];
}
