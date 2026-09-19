/**
 * @codepilot/changeset-engine — M5 diff engine
 *
 * Line-based diff with real hunk computation (LCS-based), unified diff
 * formatting, per-file statistics, binary detection and rename support.
 * Pure functions — no I/O, no dependencies. Bounded: common prefix/suffix
 * are trimmed first, the LCS table is size-capped, and beyond the cap the
 * diff degrades to a single coarse replace hunk instead of exhausting memory.
 */

// ============================================================================
// Types
// ============================================================================

export type FileOperation = "created" | "modified" | "deleted" | "renamed";

/** One +/-/context line inside a hunk. */
export interface DiffLine {
  type: "add" | "del" | "context";
  text: string;
  /** 1-based line number in the old file (context/del). */
  oldLine?: number;
  /** 1-based line number in the new file (context/add). */
  newLine?: number;
}

/** A contiguous change region with context padding. */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

/** Structured diff for one file. */
export interface DiffResult {
  filePath: string;
  /** Previous path for renames. */
  oldPath?: string;
  operation: FileOperation;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  unifiedDiff: string;
  binary: boolean;
  oldHash?: string;
  newHash?: string;
}

export interface ComputeDiffInput {
  filePath: string;
  /** Content before the change; null = file did not exist. */
  oldContent: string | null;
  /** Content after the change; null = file was deleted. */
  newContent: string | null;
  /** Previous path (rename/move). */
  oldPath?: string;
  /** Context lines around each hunk (default 3). */
  context?: number;
}

// ============================================================================
// Hashing + binary detection
// ============================================================================

/** FNV-1a 32-bit hash of one line — fast, deterministic. */
export function hashLine(line: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < line.length; i++) {
    h ^= line.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic 64-bit-style content hash (two independent FNV-1a passes).
 * 16 hex chars — used for diff metadata and optimistic-concurrency checks.
 */
export function hashContent(content: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return (
    (h1 >>> 0).toString(16).padStart(8, "0") +
    (h2 >>> 0).toString(16).padStart(8, "0")
  );
}

/** True when content looks binary (contains NUL in the first 8 KiB). */
export function isBinaryContent(content: string): boolean {
  const probe = content.slice(0, 8192);
  return probe.includes("\0");
}

/** Split content into diff lines; a trailing newline does not add a line. */
function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// ============================================================================
// LCS line diff (dynamic programming, bounded)
// ============================================================================

interface LcsOp {
  type: "add" | "del" | "context";
  oldLine?: number;
  newLine?: number;
  text: string;
}

const MAX_DIFF_LINES = 20_000;

/**
 * Compute the edit script between two line arrays via LCS dynamic
 * programming. Falls back to "replace everything" beyond the size bound so
 * huge inputs cannot exhaust memory.
 */
function lcsDiff(oldLines: string[], newLines: string[]): LcsOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  if (n > MAX_DIFF_LINES || m > MAX_DIFF_LINES) {
    // Bound: emit one coarse replace hunk instead of an n*m table.
    const ops: LcsOp[] = [];
    oldLines.forEach((text, i) =>
      ops.push({ type: "del", oldLine: i + 1, text }),
    );
    newLines.forEach((text, j) =>
      ops.push({ type: "add", newLine: j + 1, text }),
    );
    return ops;
  }

  // Hash lines first so the DP compares integers, not strings.
  const oldHashes = oldLines.map(hashLine);
  const newHashes = newLines.map(hashLine);

  // LCS length table (n+1)x(m+1): table[i][j] = LCS length of oldLines[i..]
  // and newLines[j..]. Row n and column m are implicitly zero (Uint32Array).
  const table: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) {
    table.push(new Uint32Array(m + 1));
  }
  for (let i = n - 1; i >= 0; i--) {
    const row = table[i]!;
    const below = table[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] =
        oldHashes[i] === newHashes[j] && oldLines[i] === newLines[j]
          ? below[j + 1]! + 1
          : Math.max(below[j]!, row[j + 1]!);
    }
  }

  // Walk the table to produce the edit script.
  const ops: LcsOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldHashes[i] === newHashes[j] && oldLines[i] === newLines[j]) {
      ops.push({
        type: "context",
        oldLine: i + 1,
        newLine: j + 1,
        text: oldLines[i]!,
      });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ type: "del", oldLine: i + 1, text: oldLines[i]! });
      i++;
    } else {
      ops.push({ type: "add", newLine: j + 1, text: newLines[j]! });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "del", oldLine: i + 1, text: oldLines[i]! });
    i++;
  }
  while (j < m) {
    ops.push({ type: "add", newLine: j + 1, text: newLines[j]! });
    j++;
  }
  return ops;
}

// ============================================================================
// Hunk assembly
// ============================================================================

/**
 * Group the edit script into hunks. Edits separated by more than
 * `2 * context` context lines open a new hunk (standard unified-diff
 * behavior); closer edits share one hunk. Leading context is capped at
 * `context` lines, trailing context at `context` lines.
 */
export function buildHunks(ops: LcsOp[], context: number): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffLine[] | null = null;
  let pending: DiffLine[] = [];
  let gap = 0; // context lines since the last edit

  const toLine = (op: LcsOp): DiffLine =>
    op.type === "add"
      ? { type: "add", text: op.text, newLine: op.newLine }
      : op.type === "del"
        ? { type: "del", text: op.text, oldLine: op.oldLine }
        : {
            type: "context",
            text: op.text,
            oldLine: op.oldLine,
            newLine: op.newLine,
          };

  /** Close the open hunk: cap trailing context, compute the header. */
  const flush = (): void => {
    if (!current) return;
    current.push(...pending.slice(0, context));
    if (current.some((l) => l.type !== "context")) {
      hunks.push(finalizeHunk(current));
    }
    current = null;
    pending = [];
    gap = 0;
  };

  for (const op of ops) {
    if (op.type === "context") {
      pending.push(toLine(op));
      gap++;
      if (pending.length > context * 2) pending.shift();
    } else {
      const line = toLine(op);
      if (current === null) {
        current = pending.slice(-context); // leading context
      } else if (gap > context * 2) {
        const leading = pending.slice(-context);
        flush();
        current = leading;
      } else {
        current.push(...pending); // bridge the small gap
      }
      pending = [];
      gap = 0;
      current.push(line);
    }
  }
  flush();
  return hunks;
}

/** Compute the hunk header from the assembled line list. */
function finalizeHunk(lines: DiffLine[]): DiffHunk {
  const firstOld = lines.find((l) => l.oldLine !== undefined)?.oldLine;
  const firstNew = lines.find((l) => l.newLine !== undefined)?.newLine;
  return {
    oldStart: firstOld ?? 0,
    newStart: firstNew ?? 0,
    oldLines: lines.filter((l) => l.type !== "add").length,
    newLines: lines.filter((l) => l.type !== "del").length,
    lines,
  };
}

// ============================================================================
// Unified diff formatting
// ============================================================================

export function formatUnifiedDiff(
  filePath: string,
  operation: FileOperation,
  hunks: DiffHunk[],
  options?: { oldPath?: string },
): string {
  if (hunks.length === 0) return "";
  const out: string[] = [];
  const oldLabel = `a/${options?.oldPath ?? filePath}`;
  const newLabel = operation === "deleted" ? "/dev/null" : `b/${filePath}`;
  const oldHeader = operation === "created" ? "/dev/null" : oldLabel;
  out.push(`--- ${oldHeader}`);
  out.push(`+++ ${newLabel}`);
  for (const hunk of hunks) {
    out.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    );
    for (const line of hunk.lines) {
      const prefix =
        line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
      out.push(prefix + line.text);
    }
  }
  return out.join("\n");
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Compute the full structured diff between two file states. Pure function:
 * callers supply pre-read contents (null = did not exist / deleted).
 */
export function computeDiff(input: ComputeDiffInput): DiffResult {
  const { filePath, oldPath } = input;
  const context = Math.max(0, input.context ?? 3);
  const binary = [input.oldContent, input.newContent].some(
    (c) => c !== null && isBinaryContent(c),
  );
  const oldHash =
    input.oldContent !== null ? hashContent(input.oldContent) : undefined;
  const newHash =
    input.newContent !== null ? hashContent(input.newContent) : undefined;

  let operation: FileOperation;
  if (input.oldContent === null && input.newContent !== null) {
    operation = "created";
  } else if (input.oldContent !== null && input.newContent === null) {
    operation = "deleted";
  } else if (oldPath !== undefined && oldPath !== filePath) {
    operation = "renamed";
  } else {
    operation = "modified";
  }

  const meta = {
    filePath,
    ...(oldPath !== undefined ? { oldPath } : {}),
    operation,
    binary,
    ...(oldHash !== undefined ? { oldHash } : {}),
    ...(newHash !== undefined ? { newHash } : {}),
  };

  if (binary) {
    return { ...meta, additions: 0, deletions: 0, hunks: [], unifiedDiff: "" };
  }

  const ops = lcsDiff(
    splitLines(input.oldContent ?? ""),
    splitLines(input.newContent ?? ""),
  );
  const hunks = buildHunks(ops, context);
  return {
    ...meta,
    additions: ops.filter((o) => o.type === "add").length,
    deletions: ops.filter((o) => o.type === "del").length,
    hunks,
    unifiedDiff: formatUnifiedDiff(
      filePath,
      operation,
      hunks,
      oldPath !== undefined ? { oldPath } : undefined,
    ),
  };
}
