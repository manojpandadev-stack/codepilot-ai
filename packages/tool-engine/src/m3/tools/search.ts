/**
 * @codepilot/tool-engine — M3 built-in search tools
 *
 * search_files (file name/glob search) and search_text (content search).
 *
 * Scanning is bounded: ignored directories (node_modules, .git, build output)
 * are skipped, per-file reads are capped, and hard limits cap both scanned
 * files and returned results so large repositories cannot stall the agent.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolContext, ToolDefinition } from "../types.js";
import { toolError } from "../types.js";
import type { WorkspaceBoundary } from "../workspace-boundary.js";

export const MAX_SCANNED_FILES = 20_000;
export const MAX_RESULTS = 200;
export const MAX_DEPTH = 12;
export const CONTENT_READ_CAP = 4 * 1_048_576; // 4 MiB per file

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".venv",
  "venv",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".idea",
  ".vscode",
  ".codepilot",
]);

interface WalkOptions {
  onFile: (rel: string) => void;
  maxDepth?: number;
  maxScanned?: number;
  ctx: ToolContext;
}

/** Iterative workspace-aware walk with cancellation + scan budget. */
function walkWorkspace(
  root: string,
  walk: WalkOptions,
): { scanned: number; truncated: boolean } {
  const maxDepth = walk.maxDepth ?? MAX_DEPTH;
  const maxScanned = walk.maxScanned ?? MAX_SCANNED_FILES;
  let scanned = 0;
  let truncated = false;
  const stack: Array<{ rel: string; depth: number }> = [{ rel: "", depth: 0 }];

  while (stack.length > 0) {
    if (walk.ctx.signal.aborted) {
      truncated = true;
      break;
    }
    const current = stack.pop()!;
    if (current.depth > maxDepth) continue;
    const abs = current.rel === "" ? root : path.join(root, current.rel);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue; // unreadable dir → skip, never abort the whole search
    }
    for (const entry of entries) {
      if (walk.ctx.signal.aborted) {
        truncated = true;
        break;
      }
      if (++scanned > maxScanned) {
        truncated = true;
        break;
      }
      const childRel =
        current.rel === "" ? entry.name : `${current.rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        stack.push({ rel: childRel, depth: current.depth + 1 });
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        // Symlinked files resolve through the boundary when accessed; we never
        // descend into symlinked directories (cycle risk).
        walk.onFile(childRel);
      }
    }
    if (walk.ctx.signal.aborted) break;
  }
  return { scanned, truncated };
}

/** Convert a `*`/`?` glob into an anchored case-insensitive RegExp. */
export function globToRegex(glob: string): RegExp {
  let pattern = "";
  for (const ch of glob) {
    if (ch === "*") {
      pattern += ".*";
    } else if (ch === "?") {
      pattern += ".";
    } else {
      pattern += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`, "i");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clampInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

// ============================================================================
// search_files
// ============================================================================

export function createSearchFilesTool(
  boundary: WorkspaceBoundary,
): ToolDefinition<
  { pattern: string; path?: string; maxResults?: number },
  unknown
> {
  return {
    id: "search_files",
    name: "Search Files",
    description:
      "Find files by name. Supports `*`/`?` glob patterns or plain substring matches. Ignores build/vendor directories.",
    category: "search",
    version: "1.0.0",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "Glob (e.g. *.test.ts) or substring to match against file names",
        },
        path: {
          type: "string",
          description: "Optional subdirectory to scope the search to",
        },
        maxResults: {
          type: "number",
          description: `Maximum results (default ${MAX_RESULTS})`,
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        matches: { type: "array", items: { type: "object" } },
        count: { type: "number" },
        truncated: { type: "boolean" },
      },
      required: ["matches", "count", "truncated"],
    },
    capabilities: ["cancellable", "idempotent"],
    permission: {
      level: "read",
      requiresApproval: false,
      rationale: "Search for file names in the workspace",
    },
    idempotent: true,
    async execute(input, ctx): Promise<unknown> {
      const pattern = input.pattern;
      if (typeof pattern !== "string" || pattern.trim().length === 0) {
        throw toolError(
          "VALIDATION",
          "pattern must be a non-empty string",
          ctx.executionId,
          {
            recoverable: false,
          },
        );
      }
      let rootRel = "";
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
        rootRel = res.relativePath;
      }
      const root =
        rootRel === "." || rootRel === ""
          ? boundary.root
          : path.join(boundary.root, rootRel);
      const hasGlob = /[*?]/.test(pattern);
      const matcher = hasGlob
        ? globToRegex(pattern)
        : new RegExp(escapeRegex(pattern), "i");
      const maxResults = clampInt(input.maxResults) ?? MAX_RESULTS;

      const matches: Array<{ path: string }> = [];
      const walked = walkWorkspace(root, {
        ctx,
        onFile: (rel) => {
          const name = path.posix.basename(rel);
          if (matches.length < maxResults && matcher.test(name)) {
            matches.push({ path: rel });
          }
        },
      });
      ctx.progress({
        message: `Searched ${walked.scanned} entries for "${pattern}"`,
      });
      return {
        matches,
        count: matches.length,
        truncated: walked.truncated || matches.length >= maxResults,
      };
    },
  };
}

// ============================================================================
// search_text
// ============================================================================

export function createSearchTextTool(
  boundary: WorkspaceBoundary,
): ToolDefinition<
  {
    query: string;
    path?: string;
    glob?: string;
    ignoreCase?: boolean;
    maxResults?: number;
  },
  unknown
> {
  return {
    id: "search_text",
    name: "Search Text",
    description:
      "Find lines matching a text query across workspace files. Binary files are skipped, per-file reads are capped, and scan/result limits are enforced.",
    category: "search",
    version: "1.0.0",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text to search for (plain substring)",
        },
        path: {
          type: "string",
          description: "Optional subdirectory to scope the search to",
        },
        glob: {
          type: "string",
          description: "Optional file glob filter, e.g. *.ts",
        },
        ignoreCase: {
          type: "boolean",
          description: "Case-insensitive match (default true)",
        },
        maxResults: {
          type: "number",
          description: `Maximum results (default ${MAX_RESULTS})`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        matches: { type: "array", items: { type: "object" } },
        count: { type: "number" },
        truncated: { type: "boolean" },
      },
      required: ["matches", "count", "truncated"],
    },
    capabilities: ["cancellable", "idempotent"],
    permission: {
      level: "read",
      requiresApproval: false,
      rationale: "Search file contents in the workspace",
    },
    idempotent: true,
    async execute(input, ctx): Promise<unknown> {
      const query = input.query;
      if (typeof query !== "string" || query.trim().length === 0) {
        throw toolError(
          "VALIDATION",
          "query must be a non-empty string",
          ctx.executionId,
          {
            recoverable: false,
          },
        );
      }
      let rootRel = "";
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
        rootRel = res.relativePath;
      }
      const root =
        rootRel === "." || rootRel === ""
          ? boundary.root
          : path.join(boundary.root, rootRel);
      const glob =
        typeof input.glob === "string" && input.glob.trim().length > 0
          ? globToRegex(input.glob)
          : null;
      const ignoreCase = input.ignoreCase !== false;
      const needle = ignoreCase ? query.toLowerCase() : query;
      const maxResults = clampInt(input.maxResults) ?? MAX_RESULTS;

      const matches: Array<{ path: string; line: number; text: string }> = [];
      let truncated = false;

      const walked = walkWorkspace(root, {
        ctx,
        onFile: (rel) => {
          if (matches.length >= maxResults) return;
          if (glob && !glob.test(path.posix.basename(rel))) return;
          const abs = path.join(root, rel);
          let content: string;
          try {
            content = fs.readFileSync(abs, "utf8");
          } catch {
            return; // binary or unreadable → skip
          }
          if (content.includes("\0")) return; // binary sniff
          if (content.length > CONTENT_READ_CAP) {
            content = content.slice(0, CONTENT_READ_CAP);
          }
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= maxResults) {
              truncated = true;
              return;
            }
            const lineText = lines[i] ?? "";
            if (lineText.length > 2_000) continue; // skip minified mega-lines
            const tested = ignoreCase ? lineText.toLowerCase() : lineText;
            if (tested.includes(needle)) {
              matches.push({
                path: rel,
                line: i + 1,
                text: lineText,
              });
            }
          }
        },
      });
      truncated = truncated || walked.truncated;

      ctx.progress({
        message: `Searched ${walked.scanned} entries for "${query}"`,
      });
      return { matches, count: matches.length, truncated };
    },
  };
}

// ============================================================================
// Factory
// ============================================================================

export function createSearchTools(
  boundary: WorkspaceBoundary,
): ToolDefinition[] {
  return [createSearchFilesTool(boundary), createSearchTextTool(boundary)];
}
