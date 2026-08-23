import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GitEngine } from "./index.js";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import simpleGit from "simple-git";

describe("GitEngine", () => {
  let tempDir: string;
  let engine: GitEngine;

  /**
   * Windows-safe temp-dir cleanup. `rmSync` intermittently fails with
   * transient EPERM while git or antivirus still holds a handle on freshly
   * created pack files. Retries briefly; leftover OS-temp dirs are harmless,
   * so final failure is swallowed rather than failing an otherwise-green run.
   */
  function removeTempDir(dir: string): void {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        // Synchronous ~60ms backoff between attempts.
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          60 * (attempt + 1),
        );
      }
    }
  }

  // Five sequential git subprocess spawns per hook; under parallel vitest
  // workers on Windows these occasionally exceed the default 10s timeout.
  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "git-engine-test-"));
    const git = simpleGit(tempDir);
    await git.init();
    await git.addConfig("user.email", "test@codepilot.ai");
    await git.addConfig("user.name", "CodePilot Test");

    // Create an initial commit so HEAD exists
    writeFileSync(join(tempDir, "init.txt"), "initial");
    await git.add(".");
    await git.commit("initial commit");

    engine = new GitEngine(tempDir);
  }, 30_000);

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it("isRepository returns true for a git repo", async () => {
    expect(await engine.isRepository()).toBe(true);
  });

  it("isRepository returns false for a non-git directory", async () => {
    const notGit = mkdtempSync(join(tmpdir(), "not-git-"));
    const eng = new GitEngine(notGit);
    expect(await eng.isRepository()).toBe(false);
    removeTempDir(notGit);
  });

  it("getStatus returns clean state initially", async () => {
    const status = await engine.getStatus();
    expect(status.isClean).toBe(true);
    expect(status.modified).toHaveLength(0);
    expect(status.staged).toHaveLength(0);
    expect(status.deleted).toHaveLength(0);
    expect(status.untracked).toHaveLength(0);
    expect(status.current).toBeTruthy(); // master or main depending on git config
  });

  it("getStatus detects untracked files", async () => {
    writeFileSync(join(tempDir, "new-file.txt"), "hello");
    const status = await engine.getStatus();
    expect(status.untracked).toContain("new-file.txt");
  });

  it("getStatus detects modified files", async () => {
    writeFileSync(join(tempDir, "init.txt"), "modified content");
    const status = await engine.getStatus();
    expect(status.modified.length).toBeGreaterThanOrEqual(1);
  });

  it("getDiff returns empty for clean repo", async () => {
    const diff = await engine.getDiff();
    expect(typeof diff).toBe("string");
  });

  it("getDiff returns changes for modified files", async () => {
    writeFileSync(join(tempDir, "init.txt"), "modified content");
    const diff = await engine.getDiff();
    expect(diff).toContain("modified content");
  });

  it("getLog returns commit history", async () => {
    const log = await engine.getLog(5);
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log[0]!.message).toBe("initial commit");
    expect(log[0]!.hash).toBeTruthy();
  });

  it("createCheckpoint records a checkpoint", async () => {
    writeFileSync(join(tempDir, "new.txt"), "data");
    const cp = await engine.createCheckpoint("test checkpoint");
    expect(cp.id).toMatch(/^cp-/);
    expect(cp.description).toBe("test checkpoint");
    expect(cp.gitCommitHash).toBeTruthy();
    expect(engine.listCheckpoints()).toHaveLength(1);
  });

  it("restoreCheckpoint returns false for unknown id", async () => {
    expect(await engine.restoreCheckpoint("cp-nonexistent")).toBe(false);
  });

  it("commit creates a new commit", async () => {
    writeFileSync(join(tempDir, "committed.txt"), "committed");
    const hash = await engine.commit("test commit");
    expect(hash).toBeTruthy();
    const log = await engine.getLog(1);
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log[0]!.message).toBe("test commit");
  });

  it("generateCommitMessage returns a string", async () => {
    writeFileSync(join(tempDir, "staged.txt"), "staged content");
    const git = simpleGit(tempDir);
    await git.add("staged.txt");
    const msg = await engine.generateCommitMessage();
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(0);
  });
});
