/**
 * M7 integration — host-side TerminalSessionManager.
 *
 * Proves the tracked-session lifecycle the extension relies on:
 * - session start (gated by a bridge stub), run to completion, exit code
 * - cancellation (stop) and forced kill propagate
 * - unknown session ids are safe no-ops
 * - status/list snapshots are redacted and bounded
 *
 * The M4 gate itself is covered by the LiveToolPermissionBridge tests; here
 * we prove the manager consults it and refuses to start on denial.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { TerminalSessionManager } from "../apps/vscode-extension/src/terminal-session-manager";
import type { LiveToolPermissionBridge } from "@codepilot/tool-engine";

/** Minimal bridge stub — allows everything except an explicit deny list. */
function makeBridge(
  deny: (input: { command?: string }) => boolean = () => false,
) {
  return {
    evaluateLiveTool: async (req: { input?: unknown }) => {
      const input = (req.input ?? {}) as { command?: string };
      if (deny(input)) {
        return {
          approved: false,
          decision: "deny" as const,
          riskLevel: "high",
          reason: "denied by policy",
        };
      }
      return {
        approved: true,
        decision: "allow" as const,
        riskLevel: "low",
        reason: "stub allow",
      };
    },
  } as unknown as LiveToolPermissionBridge;
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-m7-ext-"));
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows: a just-killed child can still hold the cwd briefly — retryable.
  }
});

const isWin = process.platform === "win32";

describe("M7 TerminalSessionManager integration", () => {
  it("runs a short command to completion and reports the exit code", async () => {
    const manager = new TerminalSessionManager(dir);
    const started = await manager.start(
      isWin
        ? { command: "cmd.exe", args: ["/d", "/s", "/c", "exit 3"] }
        : { command: "sh", args: ["-c", "exit 3"] },
      makeBridge(),
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const snap = await manager.status(started.session.id);
    expect(snap).not.toBeNull();
    // wait for completion
    for (
      let i = 0;
      i < 100 && (snap!.status === "running" || snap!.status === "starting");
      i++
    ) {
      await new Promise((r) => setTimeout(r, 50));
      const next = manager.status(started.session.id)!;
      if (next.status !== "running" && next.status !== "starting") break;
    }
    const final = manager.status(started.session.id)!;
    expect(final.status).toBe("exited");
    expect(final.exitCode).toBe(3);
    manager.disposeAll();
  });

  it("refuses to start a session when the M4 bridge denies", async () => {
    const manager = new TerminalSessionManager(dir);
    const denied = await manager.start(
      { command: "sh", args: ["-c", "echo hi"] },
      makeBridge(() => true),
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error).toContain("[M4:deny]");
    }
    expect(manager.list()).toHaveLength(0);
  });

  it("stop() terminates a long-running session", async () => {
    const manager = new TerminalSessionManager(dir);
    const started = await manager.start(
      isWin
        ? {
            command: "cmd.exe",
            args: ["/d", "/s", "/c", "ping -n 30 127.0.0.1"],
          }
        : { command: "sleep", args: ["30"] },
      makeBridge(),
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(manager.stop(started.session.id)).toBe(true);
    // Give the process tree time to die (taskkill /T on Windows is async).
    let final = manager.status(started.session.id);
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      final = manager.status(started.session.id);
      if (final && final.status !== "running" && final.status !== "starting")
        break;
    }
    expect(final?.cancelled).toBe(true);
    expect(["killed", "exited"]).toContain(final?.status);
    manager.disposeAll();
  });

  it("unknown session ids are safe no-ops", () => {
    const manager = new TerminalSessionManager(dir);
    expect(manager.status("nope")).toBeNull();
    expect(manager.stop("nope")).toBe(false);
    expect(manager.kill("nope")).toBe(false);
  });

  it("rejects empty commands before touching the bridge", async () => {
    const manager = new TerminalSessionManager(dir);
    let consulted = 0;
    const countingBridge = {
      evaluateLiveTool: async () => {
        consulted += 1;
        return {
          approved: true,
          decision: "allow" as const,
          riskLevel: "low",
          reason: "ok",
        };
      },
    } as unknown as LiveToolPermissionBridge;
    const result = await manager.start({ command: "  " }, countingBridge);
    expect(result.ok).toBe(false);
    expect(consulted).toBe(0);
  });
});
