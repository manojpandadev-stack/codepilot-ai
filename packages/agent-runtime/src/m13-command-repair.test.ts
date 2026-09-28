/**
 * Command-level failure repair tests (Phase 12, FEATURE_GAP row 14).
 *
 * Covers: failure classification, deterministic transforms, bounded
 * attempts, the loop guard, M4-denial handling, and persisted history
 * (atomic write, reload, corrupt quarantine).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MAX_AUTO_REPAIR_ATTEMPTS,
  CommandRepairLoop,
  classifyCommandFailure,
  commandFailureSignature,
  planCommandRepair,
  runTerminalToolRepair,
} from "./m13-command-repair.js";

const dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-repair-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe("classifyCommandFailure", () => {
  it("classifies transient infrastructure failures", () => {
    expect(
      classifyCommandFailure("Command timed out after 30000ms")
        .classification,
    ).toBe("transient");
    expect(
      classifyCommandFailure("fetch failed: ECONNRESET").classification,
    ).toBe("transient");
    expect(
      classifyCommandFailure("HTTP 429 rate limit").classification,
    ).toBe("transient");
  });

  it("classifies DNS/network failures separately", () => {
    expect(
      classifyCommandFailure("getaddrinfo ENOTFOUND example.com")
        .classification,
    ).toBe("network");
  });

  it("extracts a safe package name from Cannot find module errors", () => {
    const result = classifyCommandFailure(
      "node:internal/modules/cjs: Cannot find module 'left-pad'",
    );
    expect(result.classification).toBe("missing_module");
    expect(result.missingModule).toBe("left-pad");
  });

  it("never treats relative paths or URLs as installable modules", () => {
    expect(
      classifyCommandFailure("Cannot find module './local-helper'")
        .classification,
    ).toBe("non_recoverable");
    expect(
      classifyCommandFailure("Cannot find module 'https://evil.example/x'")
        .classification,
    ).toBe("non_recoverable");
  });

  it("treats syntax/permission/unknown-command failures as non-recoverable", () => {
    expect(
      classifyCommandFailure("SyntaxError: Unexpected token").classification,
    ).toBe("non_recoverable");
    expect(
      classifyCommandFailure("EACCES: permission denied").classification,
    ).toBe("non_recoverable");
    expect(
      classifyCommandFailure("command not found: frobnicate").classification,
    ).toBe("non_recoverable");
  });
});

describe("planCommandRepair", () => {
  it("retries the same command for transient/network failures", () => {
    expect(planCommandRepair("npm test", "transient")).toBe("npm test");
    expect(planCommandRepair("curl https://x", "network")).toBe(
      "curl https://x",
    );
  });

  it("prepends npm install for a missing module (once)", () => {
    expect(
      planCommandRepair("node build.js", "missing_module", "left-pad"),
    ).toBe("npm install left-pad && node build.js");
    // Second transform refused — one install per command.
    expect(
      planCommandRepair(
        "npm install left-pad && node build.js",
        "missing_module",
        "left-pad",
        true,
      ),
    ).toBeNull();
  });

  it("returns null for non-recoverable classes", () => {
    expect(planCommandRepair("npm test", "non_recoverable")).toBeNull();
  });
});

describe("CommandRepairLoop", () => {
  it("succeeds without repair when the command works first try", async () => {
    const runner = vi.fn(async (cmd: string) => `out:${cmd}`);
    const loop = new CommandRepairLoop();
    const outcome = await loop.run("npm test", runner);
    expect(outcome.status).toBe("recovered");
    expect(outcome.attempts).toHaveLength(1);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures with the same command until recovery", async () => {
    const calls: string[] = [];
    const runner = vi.fn(async (cmd: string) => {
      calls.push(cmd);
      if (calls.length < 2) throw new Error("Command timed out after 30000ms");
      return "ok";
    });
    const loop = new CommandRepairLoop();
    const outcome = await loop.run("npm test", runner);
    expect(outcome.status).toBe("recovered");
    expect(outcome.output).toBe("ok");
    expect(calls).toEqual(["npm test", "npm test"]);
    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.attempts[0]?.failureClass).toBe("transient");
  });

  it("transforms missing-module failures and reruns the new command", async () => {
    const calls: string[] = [];
    const runner = vi.fn(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "node build.js") {
        throw new Error("Cannot find module 'left-pad'");
      }
      return "installed+ok";
    });
    const loop = new CommandRepairLoop();
    const outcome = await loop.run("node build.js", runner);
    expect(outcome.status).toBe("recovered");
    expect(calls).toEqual([
      "node build.js",
      "npm install left-pad && node build.js",
    ]);
  });

  it("never reruns non-recoverable failures", async () => {
    const runner = vi.fn(async () => {
      throw new Error("SyntaxError: Unexpected token");
    });
    const loop = new CommandRepairLoop();
    const outcome = await loop.run("npm test", runner);
    expect(outcome.status).toBe("non_recoverable");
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("stops after MAX_AUTO_REPAIR_ATTEMPTS reruns (exhausted)", async () => {
    const runner = vi.fn(async () => {
      throw new Error("Command timed out after 30000ms");
    });
    // Raise the loop-guard repeat ceiling above the attempt cap so the
    // attempt cap is the binding constraint (the guard counts the original
    // attempt too).
    const loop = new CommandRepairLoop({
      maxSameSignatureRepeats: MAX_AUTO_REPAIR_ATTEMPTS + 1,
    });
    const outcome = await loop.run("npm test", runner);
    expect(outcome.status).toBe("exhausted");
    // maxAttempts TOTAL attempts (1 original + maxAttempts-1 reruns).
    expect(runner).toHaveBeenCalledTimes(MAX_AUTO_REPAIR_ATTEMPTS);
  });

  it("records transformed-command rerun failures and stays bounded", async () => {
    const calls: string[] = [];
    const runner = vi.fn(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "node build.js") {
        throw new Error("Cannot find module 'left-pad'");
      }
      // The transformed command keeps failing transiently; the loop guard
      // stops the repeated signature instead of looping forever.
      throw new Error("Command timed out after 30000ms");
    });
    const loop = new CommandRepairLoop();
    const outcome = await loop.run("node build.js", runner);
    expect(outcome.status).toBe("exhausted");
    expect(calls).toEqual([
      "node build.js",
      "npm install left-pad && node build.js",
      "npm install left-pad && node build.js",
    ]);
    expect(outcome.attempts).toHaveLength(3);
    expect(outcome.attempts[0]?.failureClass).toBe("missing_module");
    expect(outcome.attempts[1]?.failureClass).toBe("transient");
  });

  it("loop guard stops repeated identical signatures early", async () => {
    const runner = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND api.example.com");
    });
    const loop = new CommandRepairLoop({ maxSameSignatureRepeats: 2 });
    const outcome = await loop.run("curl https://api.example.com", runner);
    expect(outcome.status).toBe("exhausted");
    // Signature repeated twice → guard stops before the attempt cap.
    expect(runner.mock.calls.length).toBeLessThan(1 + MAX_AUTO_REPAIR_ATTEMPTS);
  });

  it("persists history across loop instances and reloads it", async () => {
    const dir = tmpDir();
    const persistPath = path.join(dir, "repair.json");
    const runner = vi.fn(async () => {
      throw new Error("Command timed out after 30000ms");
    });
    const first = new CommandRepairLoop({ persistPath });
    await first.run("npm test", runner);
    expect(fs.existsSync(persistPath)).toBe(true);

    const second = new CommandRepairLoop({ persistPath });
    const records = second.listRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.command).toBe("npm test");
    expect(records[0]?.attempts.length).toBeGreaterThan(0);
  });

  it("quarantines a corrupt history file instead of throwing", () => {
    const dir = tmpDir();
    const persistPath = path.join(dir, "repair.json");
    fs.writeFileSync(persistPath, "{not-json", "utf8");
    const loop = new CommandRepairLoop({ persistPath });
    expect(loop.listRecords()).toEqual([]);
    expect(
      fs.readdirSync(dir).some((n) => n.includes(".corrupt-")),
    ).toBe(true);
  });
});

describe("runTerminalToolRepair", () => {
  it("repairs terminal tool failures through the injected runner", async () => {
    const calls: string[] = [];
    const decision = await runTerminalToolRepair(
      {
        loop: new CommandRepairLoop(),
        isTerminalTool: (name) => name === "run_commands",
        extractCommand: (input) =>
          typeof (input as { command?: unknown }).command === "string"
            ? ((input as { command: string }).command)
            : null,
        executeRepair: async (cmd) => {
          calls.push(cmd);
          if (calls.length < 2) {
            throw new Error("Command timed out after 30000ms");
          }
          return "recovered";
        },
      },
      {
        toolCallId: "call-1",
        toolName: "run_commands",
        input: { command: "npm test" },
        output: "Command timed out after 30000ms",
      },
    );
    expect(decision.action).toBe("repair");
    if (decision.action === "repair") {
      expect(decision.outcome.status).toBe("recovered");
    }
    expect(calls).toEqual(["npm test", "npm test"]);
  });

  it("declines non-terminal tools and unknown commands", async () => {
    const base = {
      loop: new CommandRepairLoop(),
      isTerminalTool: () => false,
      extractCommand: () => "npm test",
      executeRepair: async () => "ok",
    };
    const notTerminal = await runTerminalToolRepair(base, {
      toolCallId: "c1",
      toolName: "read_files",
      input: {},
      output: "boom",
    });
    expect(notTerminal.action).toBe("none");

    const unknownCommand = await runTerminalToolRepair(
      { ...base, isTerminalTool: () => true, extractCommand: () => null },
      {
        toolCallId: "c2",
        toolName: "run_commands",
        input: {},
        output: "boom",
      },
    );
    expect(unknownCommand.action).toBe("none");
  });

  it("signatures are stable per class+command", () => {
    expect(commandFailureSignature("npm test", "transient")).toBe(
      commandFailureSignature("npm test", "transient"),
    );
    expect(commandFailureSignature("npm test", "transient")).not.toBe(
      commandFailureSignature("npm test", "network"),
    );
  });
});
