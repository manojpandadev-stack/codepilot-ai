/**
 * outputRef sidecar — bounded, redacted persistence of FULL tool output
 * (Phase 7b, FEATURE_GAP row 26).
 *
 * When model-facing tool output is truncated (streaming shell 48k cap,
 * run_commands 8k bounds), the full combined output is persisted here and
 * the truncated result carries an `outputRef`. The model retrieves it with
 * the `read_tool_output` builtin (offset + max_chars slicing), so the
 * elided middle is genuinely reachable — not a dead end.
 *
 * Security model:
 * - Secrets are scrubbed (`redactSecrets`) BEFORE anything touches disk;
 *   what is persisted is already redacted, so reads need no filter.
 * - Refs must match OUTPUT_REF_PATTERN (no dots/slashes) — path traversal
 *   is structurally impossible.
 * - Files are written mode 0600; the store is bounded (200 files /
 *   50MB total, oldest evicted) and per-file copies are capped
 *   (head+tail retention past the cap) so the sidecar cannot grow
 *   without limit.
 * - Every failure degrades to `null`/a thrown, specific error — the
 *   sidecar must never break command execution itself.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { redactSecrets } from "./audit-logger.js";

/** Refs are lowercase slug characters only (no `.`/`/` → no traversal). */
export const OUTPUT_REF_PATTERN = /^[a-z0-9_-]{8,64}$/;
/** Maximum retained sidecar files (oldest evicted first). */
export const OUTPUT_SIDECAR_MAX_FILES = 200;
/** Maximum total sidecar bytes (oldest evicted first). */
export const OUTPUT_SIDECAR_MAX_BYTES = 50 * 1024 * 1024;
/** Maximum chars for one persisted copy (head+tail beyond this). */
export const OUTPUT_SIDECAR_MAX_FILE_CHARS = 5_000_000;

export interface OutputSidecarOptions {
  /** Store directory override (tests). Defaults to a OS temp directory. */
  dir?: string;
  /** Retained-file count override (tests). */
  maxFiles?: number;
  /** Retained-byte budget override (tests). */
  maxBytes?: number;
}

export function getOutputSidecarDir(): string {
  return path.join(os.tmpdir(), "codepilot-output-sidecar");
}

export function isValidOutputRef(ref: string): boolean {
  return OUTPUT_REF_PATTERN.test(ref);
}

function boundedCopy(text: string): string {
  if (text.length <= OUTPUT_SIDECAR_MAX_FILE_CHARS) return text;
  const head = Math.ceil(OUTPUT_SIDECAR_MAX_FILE_CHARS / 2);
  const tail = OUTPUT_SIDECAR_MAX_FILE_CHARS - head;
  return (
    `${text.slice(0, head)}\n[... sidecar copy bounded: ${text.length} chars ` +
    `total — elided middle ...]\n${text.slice(-tail)}`
  );
}

/** Evict oldest files until count/byte bounds hold. Best-effort. */
function enforceBounds(dir: string, options?: OutputSidecarOptions): void {
  const maxFiles = options?.maxFiles ?? OUTPUT_SIDECAR_MAX_FILES;
  const maxBytes = options?.maxBytes ?? OUTPUT_SIDECAR_MAX_BYTES;
  try {
    const names = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".txt"))
      .map((n) => {
        const file = path.join(dir, n);
        try {
          const stat = fs.statSync(file);
          return { file, size: stat.size, mtime: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(
        (x): x is { file: string; size: number; mtime: number } => x !== null,
      );
    let total = names.reduce((sum, n) => sum + n.size, 0);
    if (names.length <= maxFiles && total <= maxBytes) {
      return;
    }
    names.sort((a, b) => a.mtime - b.mtime);
    for (const name of names) {
      if (names.length <= maxFiles && total <= maxBytes) {
        break;
      }
      try {
        fs.unlinkSync(name.file);
        total -= name.size;
        names.splice(names.indexOf(name), 1);
      } catch {
        // Ignore — bounds are best-effort.
      }
    }
  } catch {
    // Ignore — bounds are best-effort.
  }
}

/**
 * Persist full (pre-truncation) tool output. Returns the outputRef to
 * quote in the truncated result, or `null` when nothing usable could be
 * persisted (empty output, I/O failure) — callers then simply omit the
 * ref note.
 */
export function persistToolOutput(
  fullOutput: string,
  options?: OutputSidecarOptions,
): string | null {
  try {
    const redacted = redactSecrets(fullOutput);
    if (redacted.length === 0) return null;
    const dir = options?.dir ?? getOutputSidecarDir();
    fs.mkdirSync(dir, { recursive: true });
    const ref = `out_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const file = path.join(dir, `${ref}.txt`);
    fs.writeFileSync(file, boundedCopy(redacted), {
      encoding: "utf8",
      mode: 0o600,
    });
    enforceBounds(dir, options);
    return ref;
  } catch {
    return null;
  }
}

/**
 * Read back a persisted output by ref. Throws a specific, safe error for
 * invalid or expired refs (never leaks paths).
 */
export function readToolOutput(
  ref: string,
  options?: OutputSidecarOptions,
): string {
  const trimmed = ref.trim();
  if (!isValidOutputRef(trimmed)) {
    throw new Error(
      `read_tool_output rejected invalid ref: ${JSON.stringify(ref.slice(0, 80))}`,
    );
  }
  const dir = options?.dir ?? getOutputSidecarDir();
  try {
    return fs.readFileSync(path.join(dir, `${trimmed}.txt`), "utf8");
  } catch {
    throw new Error(`outputRef not found or expired: ${trimmed}`);
  }
}
