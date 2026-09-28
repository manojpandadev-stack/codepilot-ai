/**
 * Phases 6-7 — host-side grounding for the @diff and @terminal composer
 * chips (FEATURE_GAP rows 23 and 26).
 *
 * - formatDiffContextBlock: runs a real bounded git diff against a temp
 *   repository, degrades honestly outside git/null roots, and coerces the
 *   scope (a malformed payload can never smuggle arguments into git).
 * - formatTerminalContextBlock: slices bounded, redacted command-history
 *   records — never raw buffers — and respects the inline budget.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  formatDiffContextBlock,
  formatTerminalContextBlock,
} from "../apps/vscode-extension/src/extension.js";
import type { SessionCommandRecord } from "../apps/vscode-extension/src/terminal-session-manager.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-ground-"));
  dirs.push(dir);
  git(dir, "init");
  git(dir, "config", "user.email", "test@codepilot.local");
  git(dir, "config", "user.name", "CodePilot Test");
  git(dir, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "file.txt"), "one\n");
  git(dir, "add", "file.txt");
  git(dir, "-c", "commit.gpgsign=false", "commit", "-m", "init");
  return dir;
}

function record(
  overrides: Partial<SessionCommandRecord> = {},
): SessionCommandRecord {
  return {
    sessionId: "s1",
    command: "npm test",
    args: ["test"],
    startedAt: 1,
    durationMs: 10,
    status: "exited",
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    stdoutTail: "",
    stderrTail: "",
    outputTruncated: false,
    ...overrides,
  };
}

describe("formatDiffContextBlock (@diff grounding)", () => {
  it("reports honestly when no workspace is open or the folder is not git", async () => {
    expect(await formatDiffContextBlock({ id: "d1", scope: "working" }, null)).toContain(
      "no workspace open",
    );
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-ground-x-"));
    dirs.push(bare);
    const block = await formatDiffContextBlock(
      { id: "d2", scope: "working" },
      bare,
    );
    expect(block).toContain("not a git repository");
    expect(block).toContain("[Attached diff");
  });

  it("injects a bounded diff fence for working-tree changes", async () => {
    const dir = makeRepo();
    fs.appendFileSync(path.join(dir, "file.txt"), "GROUNDING-LINE\n");
    const block = await formatDiffContextBlock(
      { id: "d1", scope: "working" },
      dir,
    );
    expect(block).toContain("[Attached diff — working tree]");
    expect(block).toContain("```diff");
    expect(block).toContain("GROUNDING-LINE");
  });

  it("scopes staged diffs and reports empty scopes honestly", async () => {
    const dir = makeRepo();
    fs.appendFileSync(path.join(dir, "file.txt"), "STAGED-LINE\n");
    // Nothing staged yet.
    const emptyStaged = await formatDiffContextBlock(
      { id: "d1", scope: "staged" },
      dir,
    );
    expect(emptyStaged).toContain("no staged changes");

    git(dir, "add", "file.txt");
    const staged = await formatDiffContextBlock(
      { id: "d2", scope: "staged" },
      dir,
    );
    expect(staged).toContain("[Attached diff — staged changes]");
    expect(staged).toContain("STAGED-LINE");
  });

  it("coerces malformed scopes to the working tree (no arg smuggling)", async () => {
    const dir = makeRepo();
    fs.appendFileSync(path.join(dir, "file.txt"), "COERCED\n");
    const block = await formatDiffContextBlock(
      { id: "d1", scope: "--output=/tmp/pwn" as never },
      dir,
    );
    expect(block).toContain("[Attached diff — working tree]");
    expect(block).toContain("COERCED");
  });
});

describe("formatTerminalContextBlock (@terminal grounding)", () => {
  it("reports honestly when there is no history", () => {
    const block = formatTerminalContextBlock([]);
    expect(block).toContain("no recent terminal commands");
    expect(block).toContain("[Attached terminal output");
  });

  it("renders recent commands with exit codes, tails, and truncation flags", () => {
    const block = formatTerminalContextBlock([
      record({ command: "first", stdoutTail: "first-output" }),
      record({
        command: "failing",
        exitCode: 1,
        stderrTail: "boom",
        outputTruncated: true,
      }),
    ]);
    expect(block).toContain("$ first (exit 0)");
    expect(block).toContain("first-output");
    expect(block).toContain("$ failing (exit 1)");
    expect(block).toContain("stderr:\nboom");
    expect(block).toContain("... [output truncated]");
  });

  it("slices at most the last five records and stays within the budget", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      record({ command: `cmd-${i}`, stdoutTail: `out-${i}` }),
    );
    const block = formatTerminalContextBlock(many);
    expect(block).toContain("$ cmd-8");
    expect(block).not.toContain("cmd-3"); // older than the last five
    expect(block).toContain("cmd-4");

    const huge = formatTerminalContextBlock([
      record({ command: "big", stdoutTail: "x".repeat(200_000) }),
      record({ command: "big2", stdoutTail: "y".repeat(200_000) }),
    ]);
    expect(huge.length).toBeLessThan(60_000);
    expect(huge).toContain("terminal context budget reached");
  });
});
