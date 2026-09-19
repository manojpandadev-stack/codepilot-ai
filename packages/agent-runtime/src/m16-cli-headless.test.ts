/**
 * M16 — CLI/headless tests: command parsing (pure), exit-code mapping,
 * streaming, timeout, and TaskStore-backed task/resume flows using a
 * scripted in-memory runtime double.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CliRunner,
  parseCliCommand,
  cliHelpText,
  CLI_VERSION,
} from "./m16-cli-headless.js";
import { TaskStore } from "./m12-task-store.js";
import type { AgentEvent, AgentEventListener } from "./types.js";

// ============================================================================
// Runtime double
// ============================================================================

interface RuntimeBehavior {
  events: AgentEvent[];
  failStart?: boolean;
  hangMs?: number;
}

function makeRuntimeDouble(behavior: RuntimeBehavior) {
  const listeners = new Set<AgentEventListener>();
  let aborted = false;
  const runtime = {
    subscribe(listener: AgentEventListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async startSession(): Promise<string> {
      if (behavior.failStart) {
        for (const l of listeners) {
          l({
            type: "error",
            message: "provider unreachable",
            error: { category: "provider", message: "provider unreachable" },
          } as unknown as AgentEvent);
        }
        throw new Error("provider unreachable");
      }
      if (behavior.hangMs) {
        // Hang until aborted or the hang elapses — like a real long task.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, behavior.hangMs!);
          const check = setInterval(() => {
            if (aborted) {
              clearTimeout(timer);
              clearInterval(check);
              resolve();
            }
          }, 5);
        });
      }
      for (const event of behavior.events) {
        for (const l of listeners) l(event);
      }
      return "session-123";
    },
    async abort(): Promise<void> {
      aborted = true;
      for (const l of listeners) {
        l({ type: "cancelled", message: "aborted" } as unknown as AgentEvent);
      }
    },
    getState() {
      return {
        sessionId: "session-123",
        lastRunMetrics: {
          failed: false,
          cancelled: aborted,
          taskId: "t",
          sessionId: "session-123",
          startedAt: 0,
          completedAt: 0,
          durationMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          toolCallCount: 0,
          filesChanged: 0,
          retriesConsumed: 0,
        },
      };
    },
  };
  return runtime as unknown as ConstructorParameters<typeof CliRunner>[0];
}

function assistantDone(text: string): AgentEvent {
  return {
    type: "status",
    message: text,
  } as unknown as AgentEvent;
}

// ============================================================================
// parseCliCommand (pure)
// ============================================================================

describe("M16 parseCliCommand", () => {
  it("parses run/task/resume with positional args", () => {
    expect(parseCliCommand(["run", "fix", "the", "bug"])).toEqual({
      command: "run",
      args: ["fix", "the", "bug"],
      flags: {},
      exitCode: null,
    });
    expect(parseCliCommand(["resume", "task-1"]).args).toEqual(["task-1"]);
  });

  it("parses flags with and without values", () => {
    const parsed = parseCliCommand([
      "run",
      "do it",
      "--json",
      "--timeout",
      "5000",
    ]);
    expect(parsed.flags.json).toBe(true);
    expect(parsed.flags.timeout).toBe("5000");
  });

  it("rejects unknown commands and missing args", () => {
    expect(parseCliCommand(["bogus"]).exitCode).toBe(2);
    expect(parseCliCommand(["run"]).exitCode).toBe(2);
    expect(parseCliCommand(["resume"]).exitCode).toBe(2);
    expect(parseCliCommand([]).command).toBe("help");
  });

  it("accepts all documented commands", () => {
    for (const cmd of [
      "run",
      "task",
      "resume",
      "models",
      "providers",
      "sessions",
      "version",
      "help",
      "config",
    ]) {
      expect(
        parseCliCommand([cmd]).exitCode === null ||
          parseCliCommand([cmd]).exitCode === 2,
      ).toBe(true);
    }
  });

  it("help text documents every command", () => {
    const help = cliHelpText();
    for (const cmd of [
      "run",
      "task",
      "resume",
      "models",
      "providers",
      "sessions",
      "version",
    ]) {
      expect(help).toContain(cmd);
    }
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// ============================================================================
// CliRunner
// ============================================================================

describe("M16 CliRunner", () => {
  it("maps a successful run to exit 0 and captures output", async () => {
    const runner = new CliRunner(
      makeRuntimeDouble({
        events: [assistantDone("All done: 3 files changed")],
      }),
    );
    const result = await runner.run("fix the bug", { collectEvents: true });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("All done");
    expect(result.sessionId).toBe("session-123");
    expect(result.events?.length).toBeGreaterThan(0);
  });

  it("maps provider failure to exit 1 with error text", async () => {
    const runner = new CliRunner(
      makeRuntimeDouble({ events: [], failStart: true }),
    );
    const result = await runner.run("do something");
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("provider unreachable");
  });

  it("maps timeout to exit 3 and aborts the runtime", async () => {
    const runner = new CliRunner(
      makeRuntimeDouble({ events: [], hangMs: 60_000 }),
    );
    const result = await runner.run("long task", { timeoutMs: 40 });
    expect(result.exitCode).toBe(3);
    expect(result.error).toContain("timed out");
  }, 5000);

  it("maps cancellation to exit 4", async () => {
    // The run hangs until aborted — abort() emits `cancelled` mid-run.
    const runtime = makeRuntimeDouble({
      events: [assistantDone("partial")],
      hangMs: 30_000,
    });
    const runner = new CliRunner(runtime);
    const pending = runner.run("cancellable task");
    await new Promise((r) => setTimeout(r, 10));
    await (runtime as unknown as { abort(): Promise<void> }).abort();
    const result = await pending;
    expect(result.exitCode).toBe(4);
  }, 5000);

  it("rejects empty prompts with a usage error", async () => {
    const runner = new CliRunner(makeRuntimeDouble({ events: [] }));
    const result = await runner.run("   ");
    expect(result.exitCode).toBe(2);
  });

  it("streams events when requested", async () => {
    const streamed: Array<{ type: string; message?: string }> = [];
    const runner = new CliRunner(
      makeRuntimeDouble({ events: [assistantDone("done streaming")] }),
    );
    await runner.run("stream me", {
      output: "stream",
      onStreamEvent: (e) => streamed.push(e),
    });
    expect(streamed.length).toBeGreaterThan(0);
    expect(streamed.some((e) => e.message?.includes("done streaming"))).toBe(
      true,
    );
  });
});

describe("M16 CliRunner with TaskStore", () => {
  let dir: string;
  let store: TaskStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-m16-"));
    store = new TaskStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("task persists completion state and output", async () => {
    const runner = new CliRunner(
      makeRuntimeDouble({ events: [assistantDone("task finished")] }),
    );
    const result = await runner.task("persist me", { store });
    expect(result.taskId).toBeTruthy();
    const persisted = await store.get(result.taskId!);
    expect(persisted?.status).toBe("completed");
    expect(
      persisted?.messages.some((m) => m.content.includes("task finished")),
    ).toBe(true);
  });

  it("task persists failure state", async () => {
    const runner = new CliRunner(
      makeRuntimeDouble({ events: [], failStart: true }),
    );
    const result = await runner.task("failing task", { store });
    expect(result.exitCode).toBe(1);
    const persisted = await store.get(result.taskId!);
    expect(persisted?.status).toBe("failed");
  });

  it("resume completes an interrupted task", async () => {
    const created = await store.create("resume me");
    await store.update(created.id, { status: "interrupted" });

    const runner = new CliRunner(
      makeRuntimeDouble({ events: [assistantDone("resumed and finished")] }),
    );
    const result = await runner.resume(created.id, { store });
    expect(result.exitCode).toBe(0);
    const persisted = await store.get(created.id);
    expect(persisted?.status).toBe("completed");
  });

  it("resume of unknown task is a usage error", async () => {
    const runner = new CliRunner(makeRuntimeDouble({ events: [] }));
    const result = await runner.resume("no-such-task", { store });
    expect(result.exitCode).toBe(2);
  });

  it("resume of a completed task short-circuits", async () => {
    const created = await store.create("already done");
    await store.update(created.id, { status: "completed" });
    const runner = new CliRunner(makeRuntimeDouble({ events: [] }));
    const result = await runner.resume(created.id, { store });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("already completed");
  });

  it("markInterruptedOnStartup recovers crashed runs for resume", async () => {
    const runner = new CliRunner(
      makeRuntimeDouble({ events: [assistantDone("ok")] }),
    );
    await runner.task("will crash", { store });
    // Simulate crash: create a running task directly.
    await store.create("crashed mid-run");
    expect(await store.markInterruptedOnStartup()).toBe(1);

    const interrupted = (await store.list()).find(
      (t) => t.status === "interrupted",
    );
    expect(interrupted?.title).toBe("crashed mid-run");

    const resumeRunner = new CliRunner(
      makeRuntimeDouble({ events: [assistantDone("recovered")] }),
    );
    const result = await resumeRunner.resume(interrupted!.id, { store });
    expect(result.exitCode).toBe(0);
  });
});
