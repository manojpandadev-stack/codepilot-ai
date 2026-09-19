/**
 * M7 — Terminal session tests.
 *
 * Uses `node -e` snippets as portable long-running processes. Timing bounds
 * are deliberately generous to keep the suite deterministic.
 */
import { describe, it, expect } from "vitest";
import { TerminalSession, detectShell } from "./terminal-session.js";

const SLEEP_LONG = "setTimeout(() => {}, 60_000);";

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("TerminalSession", () => {
  it("runs a command and captures stdout with exit code 0", async () => {
    const session = new TerminalSession({
      command: "node",
      args: ["-e", "process.stdout.write('hello from session');"],
    }).start();
    const snapshot = await session.wait();
    expect(snapshot.exitCode).toBe(0);
    expect(snapshot.stdout).toContain("hello from session");
    expect(snapshot.status).toBe("exited");
  });

  it("captures stderr and non-zero exit codes", async () => {
    const session = new TerminalSession({
      command: "node",
      args: ["-e", "process.stderr.write('boom'); process.exit(3);"],
    }).start();
    const snapshot = await session.wait();
    expect(snapshot.exitCode).toBe(3);
    expect(snapshot.stderr).toContain("boom");
  });

  it("cancels a running session (graceful termination)", async () => {
    const session = new TerminalSession({
      command: "node",
      args: ["-e", SLEEP_LONG],
    }).start();
    await waitFor(() => session.snapshot().status === "running");
    session.cancel();
    const snapshot = await session.wait();
    expect(snapshot.cancelled).toBe(true);
    expect(["killed", "exited"]).toContain(snapshot.status);
  });

  it("kills a session that exceeds the timeout", async () => {
    const session = new TerminalSession({
      command: "node",
      args: ["-e", SLEEP_LONG],
      timeoutMs: 500,
    }).start();
    const snapshot = await session.wait();
    expect(snapshot.timedOut).toBe(true);
    expect(snapshot.status).toBe("timedOut");
  });

  it("caps output buffers to protect memory", async () => {
    const session = new TerminalSession({
      command: "node",
      args: ["-e", "process.stdout.write('x'.repeat(2_000_000));"],
      maxOutputBytes: 100_000,
    }).start();
    const snapshot = await session.wait();
    expect(snapshot.exitCode).toBe(0);
    expect(snapshot.stdout.length).toBe(100_000);
  });

  it("redacts secrets from captured output", async () => {
    const session = new TerminalSession({
      command: "node",
      args: [
        "-e",
        "process.stdout.write('token=ghp_1234567890123456789012345678901234567890');",
      ],
    }).start();
    const snapshot = await session.wait();
    expect(snapshot.stdout).not.toContain("ghp_1234567890");
    expect(snapshot.stdout).toContain("[REDACTED]");
  });

  it("streams output through listeners", async () => {
    const session = new TerminalSession({
      command: "node",
      args: [
        "-e",
        "process.stdout.write('chunk1'); setTimeout(() => process.stdout.write('chunk2'), 50);",
      ],
    }).start();
    const chunks: string[] = [];
    session.onOutput((text) => chunks.push(text));
    await session.wait();
    expect(chunks.join("")).toContain("chunk1");
    expect(chunks.join("")).toContain("chunk2");
  });
});

describe("detectShell", () => {
  it("returns a shell descriptor for the current platform", () => {
    const shell = detectShell();
    expect(shell.shell.length).toBeGreaterThan(0);
    expect(shell.args.length).toBeGreaterThan(0);
    expect(shell.name.length).toBeGreaterThan(0);
  });

  it("uses COMSPEC on Windows", () => {
    const shell = detectShell("win32");
    expect(shell.name).toBe("cmd");
    expect(shell.args).toContain("/c");
  });

  it("falls back to /bin/sh on POSIX", () => {
    const shell = detectShell("linux");
    expect(shell.args).toContain("-c");
  });
});
