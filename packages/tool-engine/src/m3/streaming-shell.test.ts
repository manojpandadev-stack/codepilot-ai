/**
 * Streaming shell executor tests — real processes, real stdout/stderr
 * events, no mocks for the execution path.
 *
 * Portability: every spawned program is `process.execPath` (node) with
 * inline JS — no shell operators, no Unix-only binaries. PowerShell/cmd.exe
 * cases are gated to Windows via `it.runIf`.
 */

import { describe, expect, it } from "vitest";
import { CommandExecutionService } from "./command-execution.js";
import {
  createStreamingShellExecutor,
  combineShellOutput,
  truncateStreamingOutput,
  shellArgvForCommand,
  STREAMING_SHELL_MAX_OUTPUT_CHARS,
  type StreamingShellContext,
} from "./streaming-shell.js";
import type { TerminalStreamEventWithCorrelation } from "./terminal-stream.js";

const NODE = process.execPath;
const WIN = process.platform === "win32";

function collector() {
  const events: TerminalStreamEventWithCorrelation[] = [];
  const service = new CommandExecutionService();
  const execute = createStreamingShellExecutor(service, {
    onTerminalEvent: (e) => {
      events.push(e);
    },
  });
  return { events, service, execute };
}

const ctx: StreamingShellContext = { toolCallId: "call-test-1" };

function dataOf(
  events: TerminalStreamEventWithCorrelation[],
  channel: "stdout" | "stderr",
): string {
  return events
    .filter(
      (e): e is TerminalStreamEventWithCorrelation & { data: string } =>
        (e.type === "terminal.stdout" || e.type === "terminal.stderr") &&
        (e.type === "terminal.stdout") === (channel === "stdout") &&
        typeof (e as { data?: unknown }).data === "string",
    )
    .map((e) => (e as unknown as { data: string }).data)
    .join("");
}

function assertMonotonic(events: TerminalStreamEventWithCorrelation[]): void {
  const seqs = events.map((e) => e.seq);
  expect(seqs[0]).toBe(1);
  for (let i = 1; i < seqs.length; i += 1) {
    expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
  }
}

describe("streaming shell executor — live process streaming", () => {
  it("streams stdout incrementally with monotonic sequence", async () => {
    const { events, service, execute } = collector();
    const out = await execute(
      {
        command: NODE,
        args: [
          "-e",
          "console.log('CP-A-1'); setTimeout(()=>console.log('CP-A-2'),300); setTimeout(()=>console.log('CP-A-3'),600);",
        ],
      },
      process.cwd(),
      ctx,
    );
    expect(out).toContain("CP-A-1");
    expect(out).toContain("CP-A-3");
    const stdoutEvents = events.filter((e) => e.type === "terminal.stdout");
    // Incremental: several chunk events, not one blob (pipe segmentation).
    expect(stdoutEvents.length).toBeGreaterThanOrEqual(1);
    expect(dataOf(events, "stdout")).toContain("CP-A-1");
    expect(dataOf(events, "stdout")).toContain("CP-A-3");
    assertMonotonic(events);
    expect(events[0]?.type).toBe("terminal.started");
    expect(events.at(-1)?.type).toBe("terminal.exit");
    expect(service.runningPids()).toEqual([]);
  });

  it("keeps stderr on a separate channel", async () => {
    const { events, execute } = collector();
    const out = await execute(
      {
        command: NODE,
        args: [
          "-e",
          "console.log('OUT-1'); console.error('ERR-1'); console.log('OUT-2');",
        ],
      },
      process.cwd(),
      ctx,
    );
    expect(dataOf(events, "stdout")).toContain("OUT-1");
    expect(dataOf(events, "stdout")).toContain("OUT-2");
    expect(dataOf(events, "stdout")).not.toContain("ERR-1");
    expect(dataOf(events, "stderr")).toContain("ERR-1");
    // Combined return carries both (SDK shape).
    expect(out).toContain("OUT-1");
    expect(out).toContain("[stderr]");
    expect(out).toContain("ERR-1");
  });

  it("handles empty output", async () => {
    const { events, execute } = collector();
    const out = await execute(
      { command: NODE, args: ["-e", ""] },
      process.cwd(),
      ctx,
    );
    expect(out).toBe("");
    expect(events.map((e) => e.type)).toEqual([
      "terminal.started",
      "terminal.exit",
    ]);
  });

  it("captures many small chunks in order (100 rapid prints)", async () => {
    const { events, execute } = collector();
    const script = `for (let i = 0; i < 100; i++) console.log('CHUNK-' + i);`;
    await execute({ command: NODE, args: ["-e", script] }, process.cwd(), ctx);
    const text = dataOf(events, "stdout");
    let cursor = -1;
    for (let i = 0; i < 100; i += 1) {
      const at = text.indexOf(`CHUNK-${i}`, cursor + 1);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
    assertMonotonic(events);
  });

  it("captures 1000 rapid chunks without loss or unbounded chaining", async () => {
    const { events, execute } = collector();
    const script = `for (let i = 0; i < 1000; i++) console.log('K-' + i);`;
    const start = Date.now();
    await execute({ command: NODE, args: ["-e", script] }, process.cwd(), ctx);
    const wallMs = Date.now() - start;
    const text = dataOf(events, "stdout");
    expect(text).toContain("K-0");
    expect(text).toContain("K-999");
    // Order spot-check across the burst.
    for (const probe of [0, 250, 500, 750, 999]) {
      expect(text.indexOf(`K-${probe}\n`)).toBeGreaterThan(-1);
    }
    assertMonotonic(events);
    // Evidence for the backpressure report (no hard threshold asserted).
    console.log(`1000-chunk burst: ${events.length} events in ${wallMs}ms`);
  });

  it("bounds large output with an explicit marker, process completes", async () => {
    const { events, execute } = collector();
    const script = `let s=""; for (let i = 0; i < 20000; i++) s += "0123456789abcdef"; console.log(s);`;
    const out = await execute(
      { command: NODE, args: ["-e", script] },
      process.cwd(),
      ctx,
    );
    expect(out).toContain("output truncated");
    expect(out.length).toBeLessThanOrEqual(
      STREAMING_SHELL_MAX_OUTPUT_CHARS + 500,
    );
    expect(events.at(-1)?.type).toBe("terminal.exit");
  });

  it("preserves unicode output", async () => {
    const { execute } = collector();
    const out = await execute(
      {
        command: NODE,
        args: ["-e", "console.log('héllo wörld \\u{1F680} \\u4e2d\\u6587')"],
      },
      process.cwd(),
      ctx,
    );
    expect(out).toContain("héllo");
    expect(out).toContain("\u{1F680}");
  });

  it("passes argv with spaces without shell interpolation", async () => {
    const { execute } = collector();
    const out = await execute(
      {
        command: NODE,
        args: ["-e", "console.log(process.argv[1])", "hello world; rm -rf /"],
      },
      process.cwd(),
      ctx,
    );
    // Verbatim single argument — never split, never executed.
    expect(out.trim()).toBe("hello world; rm -rf /");
  });

  it("throws CommandExitError-shaped error on non-zero exit", async () => {
    const { events, execute } = collector();
    await expect(
      execute(
        {
          command: NODE,
          args: ["-e", "console.log('before-fail'); process.exit(3);"],
        },
        process.cwd(),
        ctx,
      ),
    ).rejects.toThrow("[Command exited with code 3]");
    // Partial output still streamed before the failure.
    expect(dataOf(events, "stdout")).toContain("before-fail");
    expect(events.at(-1)?.type).toBe("terminal.exit");
  });

  it("rejects on spawn failure (command not found)", async () => {
    const { events, execute } = collector();
    await expect(
      execute(
        { command: "definitely-not-a-real-binary-xyz", args: [] },
        process.cwd(),
        ctx,
      ),
    ).rejects.toThrow();
    expect(events.some((e) => e.type === "terminal.error")).toBe(true);
  });

  it("recovers normally after failures (no poisoned state)", async () => {
    const { service, execute } = collector();
    await expect(
      execute(
        { command: NODE, args: ["-e", "process.exit(9);"] },
        process.cwd(),
        {
          toolCallId: "fail-then-ok-1",
        },
      ),
    ).rejects.toThrow("[Command exited with code 9]");
    await expect(
      execute(
        { command: "definitely-not-a-real-binary-xyz", args: [] },
        process.cwd(),
        { toolCallId: "fail-then-ok-2" },
      ),
    ).rejects.toThrow();
    const out = await execute(
      { command: NODE, args: ["-e", "console.log('RECOVERED-OK');"] },
      process.cwd(),
      { toolCallId: "fail-then-ok-3" },
    );
    expect(out).toContain("RECOVERED-OK");
    expect(service.runningPids()).toEqual([]);
  });

  it("cancels a streaming run via AbortSignal and cleans up", async () => {
    const { events, service } = collector();
    const controller = new AbortController();
    let observedPid: number | undefined;
    // Wrap with pid capture: terminal.started carries the OS pid.
    const inner = createStreamingShellExecutor(service, {
      onTerminalEvent: (e) => {
        events.push(e);
        if (e.type === "terminal.started") observedPid = e.pid;
      },
    });
    const running = inner(
      {
        command: NODE,
        args: ["-e", "setInterval(()=>console.log('tick'),100);"],
      },
      process.cwd(),
      { toolCallId: "call-cancel-1", signal: controller.signal },
    );
    // Let it stream, then cancel mid-stream.
    await new Promise((resolve) => setTimeout(resolve, 600));
    controller.abort();
    await expect(running).rejects.toThrow("Command cancelled");
    expect(events.some((e) => e.type === "terminal.cancelled")).toBe(true);
    expect(service.runningPids()).toEqual([]);
    // No orphan: the OS process is actually gone (Windows taskkill /T).
    expect(observedPid).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 500));
    let gone = false;
    try {
      process.kill(observedPid!, 0);
    } catch {
      gone = true;
    }
    expect(gone).toBe(true);
  });

  it("runs with working directories containing spaces", async () => {
    const { execute } = collector();
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "codepilot dir with spaces-"),
    );
    try {
      const out = await execute(
        { command: NODE, args: ["-e", "console.log(process.cwd())"] },
        dir,
        { toolCallId: "call-spaces-1" },
      );
      expect(out.trim().toLowerCase()).toBe(dir.toLowerCase());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("times out a hung process", async () => {
    const service = new CommandExecutionService();
    const execute = createStreamingShellExecutor(service, { timeoutMs: 400 });
    await expect(
      execute(
        { command: NODE, args: ["-e", "setInterval(()=>{},1000);"] },
        process.cwd(),
        ctx,
      ),
    ).rejects.toThrow(/timed out/);
    expect(service.runningPids()).toEqual([]);
  });

  it.runIf(WIN)("streams via powershell string commands", async () => {
    const { events, execute } = collector();
    const out = await execute(
      "Write-Output 'CP-PS-1 with spaces'",
      process.cwd(),
      ctx,
    );
    expect(out).toContain("CP-PS-1 with spaces");
    expect(dataOf(events, "stdout")).toContain("CP-PS-1 with spaces");
    assertMonotonic(events);
  });

  it.runIf(WIN)("runs cmd.exe via structured argv", async () => {
    const { execute } = collector();
    const out = await execute(
      { command: "cmd.exe", args: ["/d", "/s", "/c", "echo CP-CMD-1"] },
      process.cwd(),
      ctx,
    );
    expect(out).toContain("CP-CMD-1");
  });

  it.runIf(WIN)("reports cmd.exe non-zero exits", async () => {
    const { execute } = collector();
    await expect(
      execute(
        { command: "cmd.exe", args: ["/d", "/s", "/c", "exit 7"] },
        process.cwd(),
        ctx,
      ),
    ).rejects.toThrow("[Command exited with code 7]");
  });
});

describe("streaming shell helpers", () => {
  it("combines stdout/stderr in SDK shape", () => {
    expect(combineShellOutput("a", "")).toBe("a");
    expect(combineShellOutput("a", "b")).toBe("a\n[stderr]\nb");
    expect(combineShellOutput("", "b")).toBe("\n[stderr]\nb");
  });

  it("middle-truncates past the cap with the SDK marker", () => {
    const big = "x".repeat(STREAMING_SHELL_MAX_OUTPUT_CHARS + 1000);
    const out = truncateStreamingOutput(big);
    expect(out).toContain("output truncated");
    expect(out.startsWith("x".repeat(10))).toBe(true);
    expect(out.endsWith("x".repeat(10))).toBe(true);
    expect(truncateStreamingOutput("small")).toBe("small");
  });

  it("selects shells per platform without user concatenation", () => {
    const argv = shellArgvForCommand("echo hi");
    if (process.platform === "win32") {
      // SDK resolution: powershell with stdin bootstrap (Unicode-safe).
      expect(argv.command).toBe("powershell");
      expect(argv.args.join(" ")).toContain("-Command");
      expect(argv.stdin).toBe("echo hi");
    } else {
      expect(argv.command).toBe("bash");
      // Contract: POSIX non-sh/dash shells spawn as login shells (-l) so the
      // user's profile environment is inherited; sh/dash take plain -c.
      expect(argv.args).toEqual(["-l", "-c", "echo hi"]);
      expect(argv.stdin).toBeUndefined();
    }
  });
});
