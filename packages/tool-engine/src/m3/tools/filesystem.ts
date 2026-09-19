/**
 * @codepilot/tool-engine — M3 built-in filesystem tools
 *
 * read_file · write_file · edit_file · delete_file · move_file
 *
 * Every filesystem access goes through WorkspaceBoundary (traversal /
 * absolute-escape / symlink-escape are rejected before any syscall).
 * Writes are atomic (temp file + rename, same directory). Reads are
 * byte-capped so huge files are never loaded whole into memory.
 *
 * Semantic validation is done inside execute() so ToolErrors carry the real
 * executionId (schema-level validation is handled by the registry).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolContext, ToolDefinition } from "../types.js";
import { toolError } from "../types.js";
import type { WorkspaceBoundary } from "../workspace-boundary.js";

export const DEFAULT_READ_CAP_BYTES = 1_048_576; // 1 MiB
export const MAX_WRITE_BYTES = 8 * 1_048_576; // 8 MiB

// ============================================================================
// Shared helpers
// ============================================================================

function checkAborted(ctx: ToolContext, at: string): void {
  if (ctx.signal.aborted) {
    throw toolError(
      "CANCELLED",
      `Cancelled${at ? ` ${at}` : ""}`,
      ctx.executionId,
      { recoverable: false },
    );
  }
}

function resolveForRead(
  boundary: WorkspaceBoundary,
  raw: unknown,
  ctx: ToolContext,
): { absolutePath: string; relativePath: string } {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw toolError(
      "VALIDATION",
      "path must be a non-empty string",
      ctx.executionId,
      {
        recoverable: false,
      },
    );
  }
  const res = boundary.resolve(raw, ctx.executionId, true);
  if (!res.ok) throw res.error;
  return { absolutePath: res.absolutePath, relativePath: res.relativePath };
}

function resolveForWrite(
  boundary: WorkspaceBoundary,
  raw: unknown,
  ctx: ToolContext,
): { absolutePath: string; relativePath: string } {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw toolError(
      "VALIDATION",
      "path must be a non-empty string",
      ctx.executionId,
      {
        recoverable: false,
      },
    );
  }
  const res = boundary.resolve(raw, ctx.executionId, false);
  if (!res.ok) throw res.error;
  return { absolutePath: res.absolutePath, relativePath: res.relativePath };
}

/** Atomic write: temp file in the same directory, then rename. */
export function atomicWrite(absolutePath: string, content: string): void {
  const dir = path.dirname(absolutePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.cp-tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.writeFileSync(tmp, content, "utf8");
  try {
    fs.renameSync(tmp, absolutePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // temp cleanup is best-effort
    }
    throw err;
  }
}

/** Byte-capped read (never loads the whole file when larger than the cap). */
export function readCapped(
  absolutePath: string,
  capBytes: number,
): {
  content: string;
  size: number;
  truncated: boolean;
} {
  const fd = fs.openSync(absolutePath, "r");
  let content = "";
  let truncated = false;
  try {
    const size = fs.fstatSync(fd).size;
    const toRead = Math.min(size, capBytes);
    if (toRead > 0) {
      const buf = Buffer.alloc(toRead);
      let read = 0;
      while (read < toRead) {
        const n = fs.readSync(fd, buf, read, toRead - read, -1);
        if (n <= 0) break;
        read += n;
      }
      content = buf.subarray(0, read).toString("utf8");
    }
    truncated = size > toRead;
    return { content, size, truncated };
  } finally {
    fs.closeSync(fd);
  }
}

// ============================================================================
// read_file
// ============================================================================

export function createReadFileTool(
  boundary: WorkspaceBoundary,
): ToolDefinition<{ path: string; maxBytes?: number }, unknown> {
  return {
    id: "read_file",
    name: "Read File",
    description:
      "Read a file from the workspace. Content is byte-capped: large files return the first maxBytes bytes with truncated=true.",
    category: "filesystem",
    version: "1.0.0",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path, relative to the workspace root",
        },
        maxBytes: {
          type: "number",
          description: `Maximum bytes to read (default ${DEFAULT_READ_CAP_BYTES})`,
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        size: { type: "number" },
        truncated: { type: "boolean" },
      },
      required: ["path", "content", "size", "truncated"],
    },
    capabilities: ["cancellable", "idempotent"],
    permission: {
      level: "read",
      requiresApproval: false,
      rationale: "Read a file from the workspace",
    },
    idempotent: true,
    async execute(input, ctx): Promise<unknown> {
      checkAborted(ctx, "before read_file");
      const { absolutePath, relativePath } = resolveForRead(
        boundary,
        input.path,
        ctx,
      );
      let cap = input.maxBytes ?? DEFAULT_READ_CAP_BYTES;
      if (!Number.isFinite(cap) || cap <= 0) cap = DEFAULT_READ_CAP_BYTES;
      const { content, size, truncated } = readCapped(absolutePath, cap);
      ctx.progress({ message: `Read ${relativePath}` });
      return {
        path: relativePath,
        content,
        size,
        truncated,
      };
    },
  };
}

// ============================================================================
// write_file
// ============================================================================

export function createWriteFileTool(
  boundary: WorkspaceBoundary,
): ToolDefinition<{ path: string; content: string }, unknown> {
  return {
    id: "write_file",
    name: "Write File",
    description:
      "Atomically write a file inside the workspace (creates parent directories, never touches paths outside the boundary).",
    category: "filesystem",
    version: "1.0.0",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Target path, relative to the workspace root",
        },
        content: { type: "string", description: "Full file content to write" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        bytesWritten: { type: "number" },
      },
      required: ["path", "bytesWritten"],
    },
    capabilities: [],
    permission: {
      level: "write",
      requiresApproval: true,
      rationale: "Write or overwrite a file in the workspace",
    },
    idempotent: false,
    async execute(input, ctx): Promise<unknown> {
      checkAborted(ctx, "before write_file");
      if (typeof input.content !== "string") {
        throw toolError(
          "VALIDATION",
          "content must be a string",
          ctx.executionId,
          {
            recoverable: false,
          },
        );
      }
      const bytes = Buffer.byteLength(input.content, "utf8");
      if (bytes > MAX_WRITE_BYTES) {
        throw toolError(
          "VALIDATION",
          `content exceeds the ${MAX_WRITE_BYTES} byte write limit (${bytes} bytes)`,
          ctx.executionId,
          { recoverable: false },
        );
      }
      const { absolutePath, relativePath } = resolveForWrite(
        boundary,
        input.path,
        ctx,
      );
      atomicWrite(absolutePath, input.content);
      ctx.progress({ message: `Wrote ${relativePath} (${bytes} bytes)` });
      return { path: relativePath, bytesWritten: bytes };
    },
  };
}

// ============================================================================
// edit_file
// ============================================================================

export function createEditFileTool(
  boundary: WorkspaceBoundary,
): ToolDefinition<
  { path: string; search: string; replace: string; occurrence?: number },
  unknown
> {
  return {
    id: "edit_file",
    name: "Edit File",
    description:
      "Replace an exact text occurrence in a file. When the search text appears more than once, occurrence (1-based) is required.",
    category: "filesystem",
    version: "1.0.0",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path, relative to the workspace root",
        },
        search: {
          type: "string",
          description: "Exact text to find (must match verbatim)",
        },
        replace: { type: "string", description: "Replacement text" },
        occurrence: {
          type: "number",
          description:
            "1-based occurrence index; required when search matches more than once",
        },
      },
      required: ["path", "search", "replace"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        matched: { type: "number" },
        occurrence: { type: "number" },
      },
      required: ["path", "matched", "occurrence"],
    },
    capabilities: [],
    permission: {
      level: "write",
      requiresApproval: true,
      rationale: "Modify a file in the workspace",
    },
    idempotent: false,
    async execute(input, ctx): Promise<unknown> {
      checkAborted(ctx, "before edit_file");
      if (typeof input.search !== "string" || input.search.length === 0) {
        throw toolError(
          "VALIDATION",
          "search must be a non-empty string",
          ctx.executionId,
          {
            recoverable: false,
          },
        );
      }
      if (typeof input.replace !== "string") {
        throw toolError(
          "VALIDATION",
          "replace must be a string",
          ctx.executionId,
          {
            recoverable: false,
          },
        );
      }
      const { absolutePath, relativePath } = resolveForRead(
        boundary,
        input.path,
        ctx,
      );
      const stat = fs.statSync(absolutePath);
      if (stat.size > MAX_WRITE_BYTES) {
        throw toolError(
          "VALIDATION",
          `file is too large to edit (${stat.size} bytes > ${MAX_WRITE_BYTES})`,
          ctx.executionId,
          { recoverable: false },
        );
      }
      const content = fs.readFileSync(absolutePath, "utf8");
      const occurrences: number[] = [];
      let idx = content.indexOf(input.search);
      while (idx !== -1) {
        occurrences.push(idx);
        idx = content.indexOf(input.search, idx + input.search.length);
      }
      if (occurrences.length === 0) {
        throw toolError(
          "NOT_FOUND",
          `Search text not found in ${relativePath}`,
          ctx.executionId,
        );
      }
      let targetIdx = occurrences[0] ?? 0;
      if (occurrences.length > 1) {
        const occ = input.occurrence;
        if (
          typeof occ !== "number" ||
          !Number.isInteger(occ) ||
          occ < 1 ||
          occ > occurrences.length
        ) {
          throw toolError(
            "VALIDATION",
            `search text appears ${occurrences.length} times in ${relativePath} — provide occurrence 1..${occurrences.length}`,
            ctx.executionId,
            { recoverable: false },
          );
        }
        targetIdx = occurrences[occ - 1] ?? targetIdx;
      }
      const updated =
        content.slice(0, targetIdx) +
        input.replace +
        content.slice(targetIdx + input.search.length);
      atomicWrite(absolutePath, updated);
      ctx.progress({
        message: `Edited ${relativePath} (${occurrences.length} match(es))`,
      });
      return {
        path: relativePath,
        matched: occurrences.length,
        occurrence: occurrences.length > 1 ? input.occurrence : 1,
      };
    },
  };
}

// ============================================================================
// delete_file
// ============================================================================

export function createDeleteFileTool(
  boundary: WorkspaceBoundary,
): ToolDefinition<{ path: string }, unknown> {
  return {
    id: "delete_file",
    name: "Delete File",
    description: "Permanently delete a file inside the workspace.",
    category: "filesystem",
    version: "1.0.0",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path, relative to the workspace root",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        deleted: { type: "boolean" },
      },
      required: ["path", "deleted"],
    },
    capabilities: [],
    permission: {
      level: "destructive",
      requiresApproval: true,
      rationale: "Permanently delete a file",
    },
    idempotent: false,
    async execute(input, ctx): Promise<unknown> {
      checkAborted(ctx, "before delete_file");
      const { absolutePath, relativePath } = resolveForRead(
        boundary,
        input.path,
        ctx,
      );
      const stat = fs.statSync(absolutePath);
      if (stat.isDirectory()) {
        throw toolError(
          "VALIDATION",
          `${relativePath} is a directory — delete_file only removes files`,
          ctx.executionId,
          { recoverable: false },
        );
      }
      fs.unlinkSync(absolutePath);
      return { path: relativePath, deleted: true };
    },
  };
}

// ============================================================================
// move_file
// ============================================================================

export function createMoveFileTool(
  boundary: WorkspaceBoundary,
): ToolDefinition<{ source: string; destination: string }, unknown> {
  return {
    id: "move_file",
    name: "Move / Rename File",
    description:
      "Move or rename a file inside the workspace. Never overwrites an existing destination.",
    category: "filesystem",
    version: "1.0.0",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Existing file path" },
        destination: { type: "string", description: "New file path" },
      },
      required: ["source", "destination"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        destination: { type: "string" },
      },
      required: ["source", "destination"],
    },
    capabilities: [],
    permission: {
      level: "destructive",
      requiresApproval: true,
      rationale: "Move or rename a file",
    },
    idempotent: false,
    async execute(input, ctx): Promise<unknown> {
      checkAborted(ctx, "before move_file");
      const source = resolveForRead(boundary, input.source, ctx);
      const destination = resolveForWrite(boundary, input.destination, ctx);
      if (source.absolutePath === destination.absolutePath) {
        throw toolError(
          "VALIDATION",
          "source and destination are the same path",
          ctx.executionId,
          {
            recoverable: false,
          },
        );
      }
      if (fs.existsSync(destination.absolutePath)) {
        throw toolError(
          "PATH_SECURITY",
          `destination already exists — refusing to overwrite: ${destination.relativePath}`,
          ctx.executionId,
        );
      }
      fs.mkdirSync(path.dirname(destination.absolutePath), { recursive: true });
      fs.renameSync(source.absolutePath, destination.absolutePath);
      ctx.progress({
        message: `Moved ${source.relativePath} → ${destination.relativePath}`,
      });
      return {
        source: source.relativePath,
        destination: destination.relativePath,
      };
    },
  };
}

// ============================================================================
// Factory
// ============================================================================

export function createFilesystemTools(
  boundary: WorkspaceBoundary,
): ToolDefinition[] {
  return [
    createReadFileTool(boundary),
    createWriteFileTool(boundary),
    createEditFileTool(boundary),
    createDeleteFileTool(boundary),
    createMoveFileTool(boundary),
  ];
}
