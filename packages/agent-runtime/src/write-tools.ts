/**
 * @codepilot/agent-runtime — write-tools
 *
 * ChangeSet staging bridge for write-capable agent tools (`editor`,
 * `apply_patch`). These pure helpers compute the *proposed* content of a file
 * edit in memory WITHOUT touching the filesystem. The host (VS Code extension)
 * registers each proposal with its ChangeSetManager, which holds it in
 * "pending" state. The file is written ONLY when the user approves the
 * ChangeSet in the Changes tab.
 *
 * Security invariants:
 *  - No write happens here — ever.
 *  - Every path is validated against the workspace root (no traversal, no
 *    escape to absolute paths outside the workspace).
 *  - Text edits are applied in memory; oversized inputs are rejected.
 */

import { computePatchChanges } from "@cline/core";

// ============================================================================
// Path safety
// ============================================================================

export const MAX_PROPOSED_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB per file

export interface ResolvedPathResult {
  ok: true;
  /** Normalized path joined onto the workspace root. */
  absolutePath: string;
  /** Path relative to the workspace root (forward slashes). */
  relativePath: string;
}

export function resolveWorkspacePath(
  filePath: string,
  cwd: string
): ResolvedPathResult | { ok: false; error: string } {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return { ok: false, error: "Empty file path" };
  }
  const trimmed = filePath.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Empty file path" };
  }
  // Reject Windows-absolute (C:\), UNC, and POSIX absolute paths outright.
  if (
    /^[a-zA-Z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith("\\\\") ||
    trimmed.startsWith("/")
  ) {
    return { ok: false, error: `Absolute path outside workspace is not allowed: ${trimmed}` };
  }
  // Normalize separators and reject traversal.
  const normalized = trimmed.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((s) => s.length > 0);
  if (segments.includes("..")) {
    return { ok: false, error: `Path traversal is not allowed: ${trimmed}` };
  }
  if (segments.some((s) => s === ".")) {
    return { ok: false, error: `Relative path segments are not allowed: ${trimmed}` };
  }
  const relativePath = segments.join("/");
  const absolutePath = `${cwd.replace(/[\\/]+$/, "")}/${relativePath}`;
  return { ok: true, absolutePath, relativePath };
}

// ============================================================================
// In-memory editor operations (classic Cline editor grammar)
// ============================================================================

export type EditorOp =
  | { op: "str_replace" | "insert" | "replace_all" | "delete"; old_string: string; new_string?: string }
  | { op: "create"; new_string: string };

export interface EditorOperationResult {
  ok: true;
  content: string;
  changed: boolean;
  summary: string;
}

/**
 * Apply a single classic editor operation to the given original content.
 * Pure — never reads or writes the filesystem.
 */
export function applyEditorOperation(
  original: string | undefined,
  rawOp: Record<string, unknown>
): EditorOperationResult | { ok: false; error: string } {
  const op = String(rawOp.op ?? "str_replace");
  const oldString = typeof rawOp.old_string === "string" ? rawOp.old_string : undefined;
  const newString = typeof rawOp.new_string === "string" ? rawOp.new_string : undefined;

  // ---- create: brand-new file -------------------------------------------
  if (op === "create" || (op === "str_replace" && !oldString && original === undefined)) {
    if (original !== undefined && original.length > 0) {
      return { ok: false, error: "create failed: file already exists" };
    }
    const content = newString ?? oldString ?? "";
    if (Buffer.byteLength(content, "utf8") > MAX_PROPOSED_FILE_BYTES) {
      return { ok: false, error: "create failed: proposed content exceeds size limit" };
    }
    return { ok: true, content, changed: true, summary: "created file" };
  }

  // ---- str_replace / insert / delete / replace_all -----------------------
  if (oldString === undefined) {
    return { ok: false, error: `editor ${op} requires old_string` };
  }
  if (original === undefined) {
    return { ok: false, error: `${op} failed: file does not exist` };
  }
  const count = original.split(oldString).length - 1;
  if (count === 0) {
    return { ok: false, error: `${op} failed: old_string not found in file` };
  }

  let content: string;
  let summary: string;
  switch (op) {
    case "replace_all":
      content = original.split(oldString).join(newString ?? "");
      summary = `replaced all ${count} occurrences`;
      break;
    case "delete":
      content = original.split(oldString).join("");
      summary = `deleted ${count} occurrence(s)`;
      break;
    case "insert":
      // new_string is inserted immediately BEFORE old_string.
      if (newString === undefined) {
        return { ok: false, error: "insert requires new_string" };
      }
      content = original.split(oldString).join(`${newString}${oldString}`);
      summary = `inserted before ${count} occurrence(s)`;
      break;
    case "str_replace":
    default:
      if (newString === undefined) {
        return { ok: false, error: "str_replace requires new_string" };
      }
      // Replace only the first occurrence (unless replace_all was requested).
      const first = original.indexOf(oldString);
      content = original.slice(0, first) + newString + original.slice(first + oldString.length);
      summary = "replaced first occurrence";
      break;
  }
  if (Buffer.byteLength(content, "utf8") > MAX_PROPOSED_FILE_BYTES) {
    return { ok: false, error: `${op} failed: resulting content exceeds size limit` };
  }
  return { ok: true, content, changed: content !== original, summary };
}

// ============================================================================
// Editor tool input → staged proposals
// ============================================================================

export interface WriteProposal {
  filePath: string;
  relativePath: string;
  proposedContent: string;
}

export type ParseResult = { ok: true; proposals: WriteProposal[] } | { ok: false; error: string };

/**
 * Parse a ClineCore `editor` tool input (classic single-op or `operations`
 * array) into staged proposals. Original file content is supplied via
 * `readOriginal` so this function stays pure.
 */
export function parseEditorInput(
  input: Record<string, unknown>,
  cwd: string,
  readOriginal: (absolutePath: string) => string | undefined
): ParseResult {
  const filePath = typeof input.file_path === "string" ? input.file_path
    : typeof input.filePath === "string" ? input.filePath : "";
  if (!filePath) {
    return { ok: false, error: "editor input missing file_path" };
  }
  const resolved = resolveWorkspacePath(filePath, cwd);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const rawOps = Array.isArray(input.operations) && input.operations.length > 0
    ? input.operations as Record<string, unknown>[]
    : [input];

  let original = readOriginal(resolved.absolutePath);
  const proposal: WriteProposal = { filePath, relativePath: resolved.relativePath, proposedContent: "" };
  const summaries: string[] = [];

  for (const rawOp of rawOps) {
    // Per-operation file_path override (some models repeat it on each op).
    const opFile = typeof rawOp.file_path === "string" ? rawOp.file_path
      : typeof rawOp.filePath === "string" ? rawOp.filePath : filePath;
    if (opFile !== filePath) {
      return { ok: false, error: `editor tool cannot target multiple files in one call (${opFile})` };
    }
    const res = applyEditorOperation(original, rawOp);
    if (!res.ok) return { ok: false, error: res.error };
    original = res.content;
    if (res.changed) summaries.push(res.summary);
  }

  if (original === undefined) {
    return { ok: false, error: "editor produced no file content" };
  }
  proposal.proposedContent = original;
  return { ok: true, proposals: [proposal] };
}

/**
 * Parse a ClineCore `apply_patch` tool input into staged proposals. Uses the
 * core's own `computePatchChanges` preview (which reads current file content)
 * so the staged diff exactly matches what the real executor would apply.
 */
export async function parseApplyPatchInput(
  input: Record<string, unknown>,
  cwd: string
): Promise<ParseResult> {
  const patch = typeof input.patch === "string" ? input.patch : "";
  if (!patch) {
    return { ok: false, error: "apply_patch input missing patch" };
  }
  let computed: Awaited<ReturnType<typeof computePatchChanges>>;
  try {
    computed = await computePatchChanges(patch, cwd);
  } catch (err) {
    return { ok: false, error: `apply_patch parse failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const proposals: WriteProposal[] = [];
  for (const [rawPath, change] of Object.entries(computed.changes)) {
    const resolved = resolveWorkspacePath(rawPath, cwd);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const type = String(change.type ?? "modify");
    if (type === "delete") {
      // Deleting a file → proposed empty content marks it for removal.
      proposals.push({
        filePath: rawPath,
        relativePath: resolved.relativePath,
        proposedContent: "",
      });
      continue;
    }
    const content = change.newContent ?? change.oldContent ?? "";
    if (Buffer.byteLength(content, "utf8") > MAX_PROPOSED_FILE_BYTES) {
      return { ok: false, error: `apply_patch failed: ${rawPath} exceeds size limit` };
    }
    proposals.push({ filePath: rawPath, relativePath: resolved.relativePath, proposedContent: content });
  }

  if (proposals.length === 0) {
    return { ok: false, error: "apply_patch produced no file changes" };
  }
  return { ok: true, proposals };
}

// ============================================================================
// Result formatting (what the model sees after staging)
// ============================================================================

export function formatStagedResult(
  toolName: string,
  changeSetId: string,
  proposals: WriteProposal[]
): string {
  const lines = proposals.map((p) => {
    const label = p.proposedContent.length === 0 ? "deleted" : "updated";
    return `  ${p.relativePath} (${label}, ${p.proposedContent.length} chars)`;
  });
  return [
    `[CodePilot] ${toolName} staged ${proposals.length} file change(s) as ChangeSet ${changeSetId}.`,
    ...lines,
    "No file was modified. Approve the ChangeSet in the Changes tab to apply, or Reject/Rollback to discard.",
  ].join("\n");
}
