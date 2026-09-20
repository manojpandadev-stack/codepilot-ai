/**
 * Unit tests for the run_commands streaming integration.
 *
 * The VS Code runtime injects the M7 streaming shell executor as
 * `streamingCommandRunner`, so run_commands shares the ONE streaming
 * terminal path with `bash` instead of completion-only collection. These
 * tests prove the tool-level contract with a mock runner (the streaming
 * executor itself has its own tests; the live E2E proves the real pipe).
 */

import { describe, it, expect, vi } from "vitest";
import { createCodePilotBuiltinTools } from "./builtin-tools.js";
import { CommandExecutionService } from "@codepilot/tool-engine";

describe("run_commands streaming integration", () => {
  it("routes commands through the injected streaming runner with toolCallId and signal", async () => {
    const runner = vi.fn(
      async (input: { command: string }) => `out:${input.command}`,
    );
    const tools = createCodePilotBuiltinTools({
      cwd: process.cwd(),
      enableBash: false,
      streamingCommandRunner: runner,
    });
    const tool = tools.find((t) => t.name === "run_commands");
    expect(tool).toBeDefined();

    const controller = new AbortController();
    const result = await tool!.execute(
      { command: "echo FIRST" },
      { toolCallId: "call-1", signal: controller.signal },
    );
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0]![0]).toMatchObject({
      command: "echo FIRST",
      toolCallId: "call-1",
      signal: controller.signal,
    });
    expect(String(result)).toContain("$ echo FIRST");
    expect(String(result)).toContain("out:echo FIRST");
  });

  it("runs batched commands sequentially through the runner and joins them", async () => {
    const seen: string[] = [];
    const tools = createCodePilotBuiltinTools({
      cwd: process.cwd(),
      enableBash: false,
      streamingCommandRunner: async (input) => {
        seen.push(input.command);
        return `result-for-${input.command}`;
      },
    });
    const tool = tools.find((t) => t.name === "run_commands")!;
    const result = await tool.execute(
      { commands: ["cmd-one", "cmd-two"] },
      { toolCallId: "call-2" },
    );
    expect(seen).toEqual(["cmd-one", "cmd-two"]);
    const text = String(result);
    expect(text.indexOf("result-for-cmd-one")).toBeGreaterThan(-1);
    expect(text.indexOf("result-for-cmd-two")).toBeGreaterThan(
      text.indexOf("result-for-cmd-one"),
    );
  });

  it("propagates runner failures so dispatch maps them to tool errors", async () => {
    const tools = createCodePilotBuiltinTools({
      cwd: process.cwd(),
      enableBash: false,
      streamingCommandRunner: async () => {
        throw new Error("[Command exited with code 3]\nboom");
      },
    });
    const tool = tools.find((t) => t.name === "run_commands")!;
    await expect(
      tool.execute({ command: "failing" }, { toolCallId: "call-3" }),
    ).rejects.toThrow(/exited with code 3/);
  });

  it(
    "falls back to completion-oriented collection when no runner is injected (headless)",
    { timeout: 20_000 },
    async () => {
      // Real CommandExecutionService — proves the headless path still executes
      // a real process through service.run with unchanged (raw-spawn)
      // semantics: the whole string is the executable, args empty. `hostname`
      // is a single token that exits immediately on Windows and POSIX.
      const tools = createCodePilotBuiltinTools({
        cwd: process.cwd(),
        enableBash: false,
      });
      const tool = tools.find((t) => t.name === "run_commands")!;
      const result = await tool.execute({ command: "hostname" }, {});
      const text = String(result);
      expect(text).toContain("$ hostname");
      expect(text).not.toContain("timed out");
      expect(text).not.toContain("Command cancelled");
    },
  );

  it("the runtime-facing factory keeps bash/run_commands in the model tool names", () => {
    const tools = createCodePilotBuiltinTools({
      cwd: process.cwd(),
      enableBash: false,
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("run_commands");
    expect(CommandExecutionService).toBeDefined();
  });
});
