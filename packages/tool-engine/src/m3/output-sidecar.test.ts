/**
 * outputRef sidecar tests (Phase 7b, FEATURE_GAP row 26).
 *
 * Covers: roundtrip, ref-shape validation (no path traversal, ever),
 * expired-ref errors that leak nothing, secret redaction BEFORE disk,
 * count/byte eviction bounds, the per-file head+tail cap, and the
 * failure-degrading contract (never throws from persist).
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  OUTPUT_REF_PATTERN,
  OUTPUT_SIDECAR_MAX_FILE_CHARS,
  isValidOutputRef,
  persistToolOutput,
  readToolOutput,
} from "./output-sidecar.js";

const cleanup: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-sidecar-"));
  cleanup.push(dir);
  return dir;
}
afterEach(() => {
  while (cleanup.length > 0) {
    fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
  }
});

/**
 * Deterministic, strictly-increasing (with i) but always-past mtimes so
 * oldest-first eviction is stable: the file just written (real mtime =
 * now) can never look older than its predecessors.
 */
function bumpMtime(dir: string, ref: string, i: number): void {
  const file = path.join(dir, `${ref}.txt`);
  const t = new Date(Date.now() - (100 - i) * 1_000);
  fs.utimesSync(file, t, t);
}

describe("output sidecar — roundtrip and ref safety", () => {
  it("persists full output and reads it back under a valid ref", () => {
    const dir = tmpDir();
    const text = "line1\nline2\nline3 with a tail\n";
    const ref = persistToolOutput(text, { dir });
    expect(ref).toBeTruthy();
    expect(ref).toMatch(OUTPUT_REF_PATTERN);
    expect(isValidOutputRef(ref!)).toBe(true);
    expect(readToolOutput(ref!, { dir })).toBe(text);
  });

  it("rejects traversal-shaped and malformed refs before any I/O", () => {
    const dir = tmpDir();
    for (const bad of [
      "../evil",
      "/etc/passwd",
      "a.b",
      "out_A",
      "x",
      "out x",
      "out.txt",
      "..",
    ]) {
      expect(isValidOutputRef(bad), bad).toBe(false);
      expect(() => readToolOutput(bad, { dir })).toThrow(/invalid ref/);
    }
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it("reports expired or unknown refs without leaking paths", () => {
    const dir = tmpDir();
    let caught: Error | undefined;
    try {
      readToolOutput("out_deadbeefdeadbeef", { dir });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/not found or expired/);
    expect(caught?.message).not.toContain(dir);
  });

  it("returns null (not a throw) for empty output", () => {
    expect(persistToolOutput("", { dir: tmpDir() })).toBeNull();
  });
});

describe("output sidecar — redaction before disk", () => {
  it("scrubs credential values before the bytes are written", () => {
    const dir = tmpDir();
    const dirty = "connecting with token=supersecretvalue123 and moving on\n";
    const ref = persistToolOutput(dirty, { dir });
    expect(ref).toBeTruthy();
    const onDisk = readToolOutput(ref!, { dir });
    expect(onDisk).not.toContain("supersecretvalue123");
    expect(onDisk).toContain("[REDACTED]");
    expect(onDisk).toContain("connecting with");
  });
});

describe("output sidecar — bounded store", () => {
  it("evicts oldest files when the count bound is exceeded", () => {
    const dir = tmpDir();
    const refs: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const ref = persistToolOutput(`payload-${i}-${"x".repeat(50)}`, {
        dir,
        maxFiles: 5,
      });
      expect(ref).toBeTruthy();
      bumpMtime(dir, ref!, i);
      refs.push(ref!);
    }
    const files = fs.readdirSync(dir).filter((n) => n.endsWith(".txt"));
    expect(files.length).toBeLessThanOrEqual(5);
    // Newest survives and is readable; oldest has been evicted.
    expect(readToolOutput(refs[7]!, { dir })).toContain("payload-7");
    expect(() => readToolOutput(refs[0]!, { dir })).toThrow(
      /not found or expired/,
    );
  });

  it("evicts oldest files when the byte bound is exceeded", () => {
    const dir = tmpDir();
    const refs: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const ref = persistToolOutput(`b${i}-` + "y".repeat(400), {
        dir,
        maxBytes: 1_200,
      });
      bumpMtime(dir, ref!, i);
      refs.push(ref!);
    }
    const bytes = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".txt"))
      .map((n) => fs.statSync(path.join(dir, n)).size)
      .reduce((a, b) => a + b, 0);
    expect(bytes).toBeLessThanOrEqual(1_200);
    expect(readToolOutput(refs[5]!, { dir })).toContain("b5-");
  });

  it("caps oversized copies at head+tail with a bounded marker", () => {
    const dir = tmpDir();
    const huge = `HEADSTART${"a".repeat(5_100_000)}TAIL-END`;
    const ref = persistToolOutput(huge, { dir });
    expect(ref).toBeTruthy();
    const file = path.join(dir, `${ref}.txt`);
    const stat = fs.statSync(file);
    expect(stat.size).toBeLessThanOrEqual(OUTPUT_SIDECAR_MAX_FILE_CHARS + 400);
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain("HEADSTART");
    expect(content).toContain("TAIL-END");
    expect(content).toContain("sidecar copy bounded");
    expect(content).toContain(`${huge.length} chars total`);
  });
});
