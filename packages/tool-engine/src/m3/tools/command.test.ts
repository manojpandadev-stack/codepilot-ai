/**
 * execute_command / terminal_output / kill_process tests.
 * Uses the local node binary so commands run on Windows, Linux and macOS.
 */
import { describe, expect, it } from "vitest";
import { WorkspaceBoundary } from "../workspace-boundary.js";
import {
  CommandExecutionPolicy,
  CommandExecutionService,
} from "../command-execution.js";
import { createCommandTools, TerminalStore } from "./command.js";
import { makeCtx, tempWorkspace } from "../testing-helpers.js";

const NODE = process.execPath;

function setup(overrides: { policy?: CommandExecutionPolicy } = {}) {
  const ws = tempWorkspace({ "sub/file.txt": "x" });
  const boundary = new WorkspaceBoundary(ws.root);
  const service = new CommandExecutionService();
  const policy = overrides.policy ?? new CommandExecutionPolicy();
  const store = new TerminalStore(20);
  const tools = createCommandTools(boundary, service, policy, store);
  const executeCommand = tools[0]!;
  const terminalOutput = tools[1]!;
  const killProcess = tools[2]!;
  return {
    ws,
    boundary,
    service,
    policy,
    store,
    executeCommand,
    terminalOutput,
    killProcess,
  };
}

function approvingCtx(overrides: Record<string, unknown> = {}) {
  return makeCtx({
    requestApproval: async () => ({ approved: true, scope: "once" }),
    ...overrides,
  });
}

describe("execute_command", () => {
  it("runs a structured command and returns stdout + exit code", async () => {
    const s = setup();
    try {
      const { ctx } = approvingCtx();
      const out = (await s.executeCommand.execute(
        { command: NODE, args: ["-e", "process.stdout.write('hello world')"] },
        ctx,
      )) as { exitCode: number; stdout: string; stderr: string };
      expect(out.exitCode).toBe(0);
      expect(out.stdout).toContain("hello world");
      expect(s.store.size()).toBe(1);
    } finally {
      s.ws.cleanup();
    }
  });

  it("streams output through progress events", async () => {
    const s = setup();
    try {
      const { state, ctx } = approvingCtx();
      await s.executeCommand.execute(
        {
          command: NODE,
          args: ["-e", "process.stdout.write('chunk1\\nchunk2')"],
        },
        ctx,
      );
      expect(state.progresses.length).toBeGreaterThan(0);
      const joined = state.progresses.map((p) => p.message ?? "").join(" ");
      expect(joined).toContain("chunk1");
      expect(joined).toContain("finished");
    } finally {
      s.ws.cleanup();
    }
  });

  it("reports non-zero exit codes with COMMAND_FAILED", async () => {
    const s = setup();
    try {
      const { ctx } = approvingCtx();
      const err = await catchErr(
        s.executeCommand.execute(
          { command: NODE, args: ["-e", "process.exit(3)"] },
          ctx,
        ),
      );
      expect(err?.code).toBe("COMMAND_FAILED");
      expect(err?.message).toContain("3");
    } finally {
      s.ws.cleanup();
    }
  });

  it("hard-blocks dangerous commands via the policy", async () => {
    const s = setup();
    try {
      const { ctx } = approvingCtx();
      const err = await catchErr(
        s.executeCommand.execute({ command: "rm", args: ["-rf", "/"] }, ctx),
      );
      expect(err?.code).toBe("PERMISSION_DENIED");
      expect(err?.message).toContain("blocked by policy");
    } finally {
      s.ws.cleanup();
    }
  });

  it("requests approval for commands not on the allow list", async () => {
    const s = setup();
    try {
      let asked = 0;
      const { ctx } = makeCtx({
        requestApproval: async () => {
          asked += 1;
          return { approved: false, reason: "no" };
        },
      });
      const err = await catchErr(
        s.executeCommand.execute(
          { command: NODE, args: ["-e", "console.log(1)"] },
          ctx,
        ),
      );
      expect(asked).toBe(1);
      expect(err?.code).toBe("PERMISSION_DENIED");
    } finally {
      s.ws.cleanup();
    }
  });

  it("runs in the specified cwd and layers env vars", async () => {
    const s = setup();
    try {
      const { ctx } = approvingCtx();
      const out = (await s.executeCommand.execute(
        {
          command: NODE,
          args: [
            "-e",
            "console.log(process.cwd()); console.log(process.env.MY_VAR)",
          ],
          cwd: "sub",
          env: { MY_VAR: "hello-env" },
        },
        ctx,
      )) as { stdout: string };
      expect(out.stdout).toContain("sub");
      expect(out.stdout).toContain("hello-env");
    } finally {
      s.ws.cleanup();
    }
  });

  it("times out long-running commands and terminates them", async () => {
    const s = setup();
    try {
      const { ctx } = approvingCtx();
      const err = await catchErr(
        s.executeCommand.execute(
          {
            command: NODE,
            args: ["-e", "setTimeout(() => {}, 20000)"],
            timeoutMs: 300,
          },
          ctx,
        ),
      );
      expect(err?.code).toBe("TIMEOUT");
    } finally {
      s.ws.cleanup();
    }
  });

  it("rejects a cwd outside the workspace", async () => {
    const s = setup();
    try {
      const { ctx } = approvingCtx();
      const err = await catchErr(
        s.executeCommand.execute(
          { command: NODE, args: [], cwd: "../outside" },
          ctx,
        ),
      );
      expect(err?.code).toBe("PATH_SECURITY");
    } finally {
      s.ws.cleanup();
    }
  });

  it("redacts secrets from stored output", async () => {
    const s = setup();
    try {
      const { ctx } = approvingCtx();
      await s.executeCommand.execute(
        {
          command: NODE,
          args: ["-e", "console.log('apiKey=sk-abcdefghijklmnop')"],
        },
        ctx,
      );
      const rec = s.store.recent(1)[0]!;
      expect(rec.stdout).not.toContain("sk-abcdefghijklmnop");
      expect(rec.stdout).toContain("[REDACTED]");
    } finally {
      s.ws.cleanup();
    }
  });
});

describe("terminal_output", () => {
  it("returns recent records and looks up by execution id", async () => {
    const s = setup();
    try {
      const { ctx } = approvingCtx();
      await s.executeCommand.execute(
        { command: NODE, args: ["-e", "console.log('first')"] },
        ctx,
      );
      const rec = s.store.recent(1)[0]!;
      const { ctx: outCtx } = makeCtx();
      const out = (await s.terminalOutput.execute(
        { executionId: rec.executionId },
        outCtx,
      )) as {
        outputs: Array<{ command: string }>;
        count: number;
      };
      expect(out.count).toBe(1);
      expect(out.outputs[0]!.command.length).toBeGreaterThan(0);
    } finally {
      s.ws.cleanup();
    }
  });
});

describe("kill_process", () => {
  it("rejects invalid pids", async () => {
    const s = setup();
    try {
      const { ctx } = makeCtx();
      const err = await catchErr(s.killProcess.execute({ pid: -5 }, ctx));
      expect(err?.code).toBe("VALIDATION");
    } finally {
      s.ws.cleanup();
    }
  });
});

async function catchErr(
  promise: Promise<unknown>,
): Promise<{ code: string; message: string } | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    return {
      code: (err as { code: string }).code,
      message: (err as { message: string }).message,
    };
  }
}
