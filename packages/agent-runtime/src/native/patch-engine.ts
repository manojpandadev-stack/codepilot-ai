/**
 * CodePilot patch engine — independent parser/previewer for the Codex-style
 * `*** Begin Patch` format consumed by the `apply_patch` tool.
 *
 * Written from the PUBLIC, widely documented format (Add File / Update File /
 * Delete File sections with @@ context hunk markers). No Cline code is used;
 * the behavior contract is: given a patch and the current workspace, produce
 * per-file proposed content WITHOUT touching the filesystem — exactly what
 * the ChangeSet staging bridge (`write-tools.ts`) previews.
 *
 * Supported operations:
 *   *** Add File: path      → content lines follow until next `*** ` header
 *   *** Delete File: path   → file is removed
 *   *** Update File: path   → context hunks:
 *         @@ optional-classifier
 *            context line
 *         -  removed line
 *         +  added line
 *       A hunk replaces the FIRST occurrence of its context block in the
 *       current content (standard search/replace patch semantics). An empty
 *       context with only `+` lines appends.
 */

export interface PatchFileChange {
  /** Absolute path of the affected file. */
  path: string;
  relativePath: string;
  kind: "add" | "update" | "delete";
  /** Current content (add: undefined; delete: current bytes as utf8). */
  original?: string;
  /** Proposed content (delete: undefined). */
  proposed?: string;
}

export interface PatchParseResult {
  ok: boolean;
  changes?: PatchFileChange[];
  error?: string;
}

const HEADER = "*** Begin Patch";
const END_MARKER = "*** End Patch";

function stripEndMarker(lines: string[]): string[] {
  if (lines.length > 0 && lines[lines.length - 1]!.trim() === END_MARKER) {
    return lines.slice(0, -1);
  }
  return lines;
}

function joinRelative(cwd: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${base}/${normalized}`;
}

/** Split a patch body into per-file sections keyed by operation + path. */
interface FileSection {
  op: "add" | "update" | "delete";
  path: string;
  lines: string[];
}

function splitSections(lines: string[]): FileSection[] | { error: string } {
  const sections: FileSection[] = [];
  let current: FileSection | null = null;
  for (const line of lines) {
    const addMatch = /^\*\*\* Add File: (.+)$/.exec(line);
    const updateMatch = /^\*\*\* Update File: (.+)$/.exec(line);
    const deleteMatch = /^\*\*\* Delete File: (.+)$/.exec(line);
    if (addMatch) {
      if (current) sections.push(current);
      current = { op: "add", path: addMatch[1]!.trim(), lines: [] };
      continue;
    }
    if (updateMatch) {
      if (current) sections.push(current);
      current = { op: "update", path: updateMatch[1]!.trim(), lines: [] };
      continue;
    }
    if (deleteMatch) {
      if (current) sections.push(current);
      current = { op: "delete", path: deleteMatch[1]!.trim(), lines: [] };
      continue;
    }
    if (!current) {
      // Content before any file header (e.g. blank line) — ignore blanks.
      if (line.trim().length === 0) continue;
      return {
        error: `Unexpected content before file header: "${line.slice(0, 80)}"`,
      };
    }
    current.lines.push(line);
  }
  if (current) sections.push(current);
  return sections;
}

/**
 * Apply one update-file hunk list to `content`. Returns the new content.
 * A hunk is a run of lines starting with ' ', '-', '+' (after the optional
 * `@@` marker). The first hunk's context (space + removed lines) locates the
 * region; removed lines are dropped, added lines inserted.
 */
export type HunkApplyResult =
  { ok: true; value: string } | { ok: false; error: string };

export function applyHunks(
  content: string,
  hunkLines: string[],
): HunkApplyResult {
  const lines = content.split("\n");
  // Group into hunks: each begins at an @@ marker (or at the first +/-/space run).
  const hunks: string[][] = [];
  let current: string[] | null = null;
  for (const line of hunkLines) {
    if (line.startsWith("@@")) {
      if (current) hunks.push(current);
      current = [];
      continue;
    }
    if (line.startsWith(" ") || line.startsWith("-") || line.startsWith("+")) {
      if (!current) current = [];
      current.push(line);
    } else if (line.trim().length === 0 && current) {
      // Blank lines inside a hunk are context lines with a stripped leading
      // space in some emitters — treat as context.
      current.push(" ");
    }
    // Anything else ends the current hunk implicitly (kept for next).
  }
  if (current) hunks.push(current);

  let working = lines;
  for (const hunk of hunks) {
    const context: string[] = [];
    const removed: string[] = [];
    const added: string[] = [];
    for (const l of hunk) {
      if (l.startsWith(" ")) context.push(l.slice(1));
      else if (l.startsWith("-")) {
        context.push(l.slice(1));
        removed.push(l.slice(1));
      } else if (l.startsWith("+")) added.push(l.slice(1));
    }
    if (context.length === 0 && added.length > 0) {
      // Pure append.
      working = [...working, ...added];
      continue;
    }
    if (context.length === 0) {
      return { ok: false, error: "Hunk has no context and no additions" };
    }
    // Find the first occurrence of the full context sequence.
    let at = -1;
    outer: for (let i = 0; i <= working.length - context.length; i++) {
      for (let j = 0; j < context.length; j++) {
        if (working[i + j] !== context[j]) continue outer;
      }
      at = i;
      break;
    }
    if (at < 0) {
      return {
        ok: false,
        error: `Context block not found: "${context.slice(0, 3).join("\\n")}"`,
      };
    }
    // Replace the context block: keep pre-context, apply removals/insertions
    // line-by-line within the matched region.
    const replacement: string[] = [];
    let w = at;
    for (const l of hunk) {
      if (l.startsWith(" ")) {
        replacement.push(working[w]!);
        w++;
      } else if (l.startsWith("-")) {
        w++; // dropped
      } else if (l.startsWith("+")) {
        replacement.push(l.slice(1));
      }
    }
    working = [...working.slice(0, at), ...replacement, ...working.slice(w)];
  }
  return { ok: true, value: working.join("\n") };
}

/**
 * Compute the per-file changes a patch WOULD apply. Reads the current content
 * of existing files via the injected reader (pure — no fs calls here).
 */
export async function computePatchChanges(
  patch: string,
  cwd: string,
  readFile: (absolutePath: string) => string | undefined,
): Promise<PatchParseResult> {
  const text = typeof patch === "string" ? patch : "";
  if (!text.includes(HEADER)) {
    return { ok: false, error: "Patch must start with '*** Begin Patch'" };
  }
  const allLines = text.split(/\r?\n/);
  const beginIdx = allLines.findIndex((l) => l.trim() === HEADER);
  let body = allLines.slice(beginIdx + 1);
  const endIdx = body.findIndex((l) => l.trim() === END_MARKER);
  if (endIdx >= 0) body = body.slice(0, endIdx);
  body = stripEndMarker(body);

  const sections = splitSections(body);
  if ("error" in sections) return { ok: false, error: sections.error };

  const changes: PatchFileChange[] = [];
  for (const section of sections) {
    const absolutePath = joinRelative(cwd, section.path);
    const relativePath = section.path.replace(/\\/g, "/");
    if (section.op === "add") {
      const proposed = section.lines
        .map((l) => (l.startsWith("+") ? l.slice(1) : l))
        .join("\n");
      changes.push({
        path: absolutePath,
        relativePath,
        kind: "add",
        proposed,
      });
      continue;
    }
    if (section.op === "delete") {
      const original = readFile(absolutePath);
      if (original === undefined) {
        return {
          ok: false,
          error: `File to delete not found: ${relativePath}`,
        };
      }
      changes.push({
        path: absolutePath,
        relativePath,
        kind: "delete",
        original,
      });
      continue;
    }
    // update
    const original = readFile(absolutePath);
    if (original === undefined) {
      return { ok: false, error: `File to update not found: ${relativePath}` };
    }
    // Drop leading '+' markers the emitter may prefix Add-style content with
    // inside Update sections? No — Update sections use -/+/space hunks only.
    const applied = applyHunks(original, section.lines);
    if (!applied.ok) {
      return { ok: false, error: `${relativePath}: ${applied.error}` };
    }
    changes.push({
      path: absolutePath,
      relativePath,
      kind: "update",
      original,
      proposed: applied.value,
    });
  }
  return { ok: true, changes };
}
