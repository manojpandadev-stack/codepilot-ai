/**
 * M7 — Tracked terminal session streaming tests.
 *
 * Real processes (node -e snippets) prove the streaming contract:
 *   TerminalSession → terminal.* events → manager fan-out (correlation)
 *   → command history; with isolation, cancellation, UTF-8, and bounds.
 *
 * The authoritative streaming proof: a stdout EVENT arrives BEFORE the
 * process completes (first-output timestamp < completion timestamp), with
 * no polling anywhere in the path.
 */
import { describe, it, expect } from "vitest";
import { TerminalSession } from "../packages/tool-engine/src/m7/terminal-session";
import type { TerminalStreamEventWithCorrelation } from "../packages/tool-engine/src/m3/terminal-stream";
import {
  TerminalSessionManager,
} from "../apps/vscode-extension/src/terminal-session-manager";
import type { LiveToolPermissionBridge } from "../packages/tool-engine/src/m4/live-bridge";

/**
 * Build a node -e script that writes the given lines to stdout/stderr with
 * real delays BETWEEN writes, then exits. Implementation: a single `main`
 * function steps through the lines with setTimeout chaining — genuinely
 * time-separated output, which is what the streaming proof requires.
 */
function script(
  lines: Array<{ text: string; stream?: "stdout" | "stderr" }>,
  gapMs = 250,
): string[] {
  const write = (l: { text: string; stream?: "stdout" | "stderr" }): string =>
    l.stream === "stderr"
      ? `process.stderr.write(${JSON.stringify(l.text + "\n")});`
      : `process.stdout.write(${JSON.stringify(l.text + "\n")});`;
  const body = lines
    .map((l, i) =>
      i < lines.length - 1
        ? `${write(l)} setTimeout(next${i + 1}, ${gapMs});`
        : write(l),
    )
    .join("\n  ");
  const fns = lines
    .slice(0, -1)
    .map(
      (_, i) =>
        `function next${i + 1}() {\n  ${lines
          .slice(i + 1)
          .map((l, j) =>
            j < lines.length - i - 2
              ? `${write(l)} setTimeout(next${i + 2}, ${gapMs});`
              : write(l),
          )
          .join("\n  ")}\n}`,
    )
    .join("\n");
  return ["-e", `${fns}\n(function main() {\n  ${body}\n})();`];
}

/** Minimal bridge stub (allows unless denied) — same shape as M7 tests. */
function makeBridge(deny: (cmd: string) => boolean = () => false) {
  return {
    evaluateLiveTool: async (req: { input?: unknown }) => {
      const input = (req.input ?? {}) as { command?: string };
      if (deny(input.command ?? "")) {
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

/**
 * Collect events with timestamps for the session's whole lifetime. The
 * listener is passed as a PRE-SPAWN option, so terminal.started and early
 * output are never missed.
 */
function makeCollector() {
  const events: Array<{
    event: TerminalStreamEventWithCorrelation;
    at: number;
  }> = [];
  const onEvent = (event: unknown): void => {
    events.push({
      event: event as TerminalStreamEventWithCorrelation,
      at: Date.now(),
    });
  };
  return { events, onEvent };
}

/** Wait until the manager reports the session no longer running. */
async function waitSettled(
  manager: TerminalSessionManager,
  id: string,
  timeoutMs = 20_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const s = manager.status(id);
    if (s && s.status !== "running" && s.status !== "starting") return;
    if (Date.now() - start > timeoutMs) throw new Error("session settle timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("M7 TerminalSession — typed terminal.* events", () => {
  it("streams stdout events BEFORE completion (authoritative proof)", async () => {
    const { events, onEvent } = makeCollector();
    const session = new TerminalSession({
      command: "node",
      args: script([{ text: "M7-1" }, { text: "M7-2" }, { text: "M7-3" }]),
      onEvent,
    }).start();
    const final = await session.wait();

    // Process actually completed.
    expect(final.status).toBe("exited");
    expect(final.exitCode).toBe(0);

    // Streaming contract: started first, multiple stdout events, monotonic seq.
    const types = events.map((e) => e.event.type);
    expect(types[0]).toBe("terminal.started");
    const stdout = events.filter((e) => e.event.type === "terminal.stdout");
    expect(stdout.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].event.seq).toBeGreaterThan(events[i - 1].event.seq);
    }
    const last = events[events.length - 1];
    expect(last.event.type).toBe("terminal.exit");

    // THE PROOF: the first chunk was emitted strictly before the exit event.
    expect(stdout[0].at).toBeLessThan(last.at);

    // Content arrived in order (carried by events, not polled).
    const text = stdout.map((e) => (e.event as { data: string }).data).join("");
    expect(text).toContain("M7-1");
    expect(text).toContain("M7-3");
  });

  it("labels stdout and stderr correctly with per-stream content", async () => {
    const { events, onEvent } = makeCollector();
    const session = new TerminalSession({
      command: "node",
      args: script([
        { text: "out-hello" },
        { text: "err-boom", stream: "stderr" },
        { text: "out-again" },
      ]),
      onEvent,
    }).start();
    await session.wait();

    const outs = events
      .filter((e) => e.event.type === "terminal.stdout")
      .map((e) => (e.event as { data: string }).data)
      .join("");
    const errs = events
      .filter((e) => e.event.type === "terminal.stderr")
      .map((e) => (e.event as { data: string }).data)
      .join("");
    expect(outs).toContain("out-hello");
    expect(outs).toContain("out-again");
    expect(errs).toContain("err-boom");
    // No cross-contamination.
    expect(outs).not.toContain("err-boom");
    expect(errs).not.toContain("out-hello");
  });

  it("decodes UTF-8 characters split across chunk boundaries", async () => {
    // 'é' is 2 bytes, '€' is 3 bytes, '𝕏' is 4 bytes. The script writes the
    // payload ONE BYTE AT A TIME so the pipe really splits multi-byte
    // sequences — the stream decoder must reassemble them.
    const code = `
const bytes = Buffer.from("caf\u00e9-\u20ac-\u{1D54F}-done", "utf8");
let i = 0;
function step() {
  if (i < bytes.length) {
    process.stdout.write(bytes.subarray(i, i + 1));
    i++;
    setTimeout(step, 1);
  }
}
step();
`;
    const { events, onEvent } = makeCollector();
    const session = new TerminalSession({
      command: "node",
      args: ["-e", code],
      onEvent,
    }).start();
    const final = await session.wait();
    expect(final.exitCode).toBe(0);
    const text = events
      .filter((e) => e.event.type === "terminal.stdout")
      .map((e) => (e.event as { data: string }).data)
      .join("");
    expect(text).toBe("café-€-𝕏-done");
    expect(text).not.toContain("\uFFFD");
  });

  it("cancellation emits terminal.cancelled exactly once and stops output", async () => {
    const { events, onEvent } = makeCollector();
    const session = new TerminalSession({
      command: "node",
      args: script([{ text: "before-cancel" }, { text: "after-cancel" }], 1500),
      onEvent,
    }).start();
    // Wait for the first chunk, then cancel while the process still runs.
    await new Promise<void>((resolve) => {
      const unsub = session.onEvent((e) => {
        if (e.type === "terminal.stdout") {
          unsub();
          resolve();
        }
      });
    });
    session.cancel();
    const final = await session.wait();
    expect(final.cancelled).toBe(true);
    expect(final.status).toBe("killed");
    const cancellations = events.filter((e) => e.event.type === "terminal.cancelled");
    expect(cancellations).toHaveLength(1);
    // No post-cancel content from the second (delayed) line.
    const cancelAt = cancellations[0].at;
    for (const { event, at } of events) {
      if (event.type === "terminal.stdout" && at > cancelAt) {
        expect((event as { data: string }).data).not.toContain("after-cancel");
      }
    }
  });

  it("timeout emits terminal.timeout and terminates the process", async () => {
    const { events, onEvent } = makeCollector();
    const session = new TerminalSession({
      command: "node",
      args: ["-e", "setInterval(() => process.stdout.write('tick\\n'), 100);"],
      timeoutMs: 600,
      onEvent,
    }).start();
    const final = await session.wait();
    expect(final.status).toBe("timedOut");
    expect(final.timedOut).toBe(true);
    expect(events.filter((e) => e.event.type === "terminal.timeout")).toHaveLength(1);
    // Streaming happened before the timeout (ticks were emitted live).
    expect(events.some((e) => e.event.type === "terminal.stdout")).toBe(true);
  });

  it("non-zero exit preserves the real exit code in terminal.exit", async () => {
    const { events, onEvent } = makeCollector();
    const session = new TerminalSession({
      command: "node",
      args: ["-e", "process.stderr.write('boom\\n'); process.exit(3);"],
      onEvent,
    }).start();
    const final = await session.wait();
    expect(final.exitCode).toBe(3);
    const exits = events.filter((e) => e.event.type === "terminal.exit");
    expect(exits).toHaveLength(1);
    expect((exits[0].event as { exitCode: number }).exitCode).toBe(3);
    // stderr content streamed with the stderr label.
    expect(
      events.some(
        (e) =>
          e.event.type === "terminal.stderr" &&
          (e.event as { data: string }).data.includes("boom"),
      ),
    ).toBe(true);
  });

  it("bounded retention: snapshot output is capped while live events still stream", async () => {
    const { events, onEvent } = makeCollector();
    const session = new TerminalSession({
      command: "node",
      args: [
        "-e",
        "for (let i = 0; i < 20000; i++) process.stdout.write('x'.repeat(40) + '\\n');",
      ],
      maxOutputBytes: 20_000,
      onEvent,
    }).start();
    const final = await session.wait();
    expect(final.exitCode).toBe(0);
    // Snapshot (retained history) is bounded.
    expect(final.stdout.length).toBeLessThanOrEqual(20_500);
    // Live events still streamed everything (retention ≠ suppression).
    const streamedBytes = events
      .filter((e) => e.event.type === "terminal.stdout")
      .reduce((sum, e) => sum + (e.event as { byteCount: number }).byteCount, 0);
    expect(streamedBytes).toBeGreaterThan(400_000);
  });

  it("emits exactly one terminal.started and one terminal-status event", async () => {
    const { events, onEvent } = makeCollector();
    const session = new TerminalSession({
      command: "node",
      args: ["-e", "process.stdout.write('ok');"],
      onEvent,
    }).start();
    await session.wait();
    expect(events.filter((e) => e.event.type === "terminal.started")).toHaveLength(1);
    const terminalStatuses = events.filter((e) =>
      ["terminal.exit", "terminal.cancelled", "terminal.timeout", "terminal.error"].includes(
        e.event.type,
      ),
    );
    expect(terminalStatuses).toHaveLength(1);
  });
});

describe("M7 TerminalSessionManager — fan-out, correlation, history", () => {
  it("fans out correlated events per session and records history", async () => {
    const manager = new TerminalSessionManager(process.cwd());
    const received: Array<TerminalStreamEventWithCorrelation & { sessionId?: string }> = [];
    manager.setEventSink((e) =>
      received.push(e as TerminalStreamEventWithCorrelation & { sessionId?: string }),
    );
    const audit: Array<{ phase: string; approved?: boolean }> = [];
    manager.setAuditHook((entry) =>
      audit.push({ phase: entry.phase, approved: entry.approved }),
    );

    const started = await manager.start(
      {
        command: "node",
        args: script([{ text: "fan-1" }, { text: "fan-2" }], 200),
        taskId: "task-A",
      },
      makeBridge(),
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const sid = started.session.id;
    await waitSettled(manager, sid);

    // Correlation: every event carries sessionId + executionId + taskId.
    const mine = received.filter((e) => e.sessionId === sid);
    expect(mine.length).toBeGreaterThan(2);
    for (const e of mine) {
      expect(e.executionId).toBe(sid);
      expect(e.taskId).toBe("task-A");
      expect(typeof e.timestamp).toBe("number");
    }
    const seqs = mine.map((e) => e.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
    expect(seqs[0]).toBe(1);

    // Audit lifecycle: requested → decision → started → completed.
    const phases = audit.map((a) => a.phase);
    expect(phases).toContain("requested");
    expect(phases).toContain("decision");
    expect(phases).toContain("started");
    expect(phases).toContain("completed");

    // History: one record, bounded, with command + status.
    const record = manager.listHistory().find((h) => h.sessionId === sid);
    expect(record).toBeDefined();
    expect(record!.command).toBe("node");
    expect(record!.status).toBe("exited");
    expect(record!.exitCode).toBe(0);
    expect(record!.stdoutTail).toContain("fan-1");
    expect(record!.stdoutTail.length).toBeLessThanOrEqual(8_100);

    manager.disposeAll();
  });

  it("isolates sessions: each session's events carry only its own sessionId", async () => {
    const manager = new TerminalSessionManager(process.cwd());
    const received: Array<TerminalStreamEventWithCorrelation & { sessionId?: string }> = [];
    manager.setEventSink((e) =>
      received.push(e as TerminalStreamEventWithCorrelation & { sessionId?: string }),
    );

    const a = await manager.start(
      { command: "node", args: script([{ text: "A-1" }, { text: "A-2" }], 250) },
      makeBridge(),
    );
    const b = await manager.start(
      { command: "node", args: script([{ text: "B-1" }, { text: "B-2" }], 250) },
      makeBridge(),
    );
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    await Promise.all([waitSettled(manager, a.session.id), waitSettled(manager, b.session.id)]);

    const aEvents = received.filter((e) => e.sessionId === a.session.id);
    const bEvents = received.filter((e) => e.sessionId === b.session.id);
    expect(aEvents.length).toBeGreaterThan(0);
    expect(bEvents.length).toBeGreaterThan(0);
    const aText = aEvents
      .filter((e) => e.type === "terminal.stdout")
      .map((e) => (e as { data: string }).data)
      .join("");
    const bText = bEvents
      .filter((e) => e.type === "terminal.stdout")
      .map((e) => (e as { data: string }).data)
      .join("");
    expect(aText).toContain("A-1");
    expect(aText).not.toContain("B-1");
    expect(bText).toContain("B-1");
    expect(bText).not.toContain("A-1");
    // History carries separate records.
    const history = manager.listHistory();
    expect(history.find((h) => h.sessionId === a.session.id)?.stdoutTail).toContain("A-1");
    expect(history.find((h) => h.sessionId === b.session.id)?.stdoutTail).toContain("B-1");

    manager.disposeAll();
  });

  it("cancellation fans out one terminal.cancelled and history records it", async () => {
    const manager = new TerminalSessionManager(process.cwd());
    const received: TerminalStreamEventWithCorrelation[] = [];
    manager.setEventSink((e) => received.push(e));

    const started = await manager.start(
      { command: "node", args: script([{ text: "early" }, { text: "never" }], 1500) },
      makeBridge(),
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const sid = started.session.id;
    // Wait for the first chunk via the SINK (streaming, not polling output).
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (
          received.some((e) => e.type === "terminal.stdout" && e.executionId === sid)
        ) {
          resolve();
        } else {
          setTimeout(check, 20);
        }
      };
      check();
    });
    expect(manager.stop(sid)).toBe(true);
    await waitSettled(manager, sid);
    expect(
      received.filter((e) => e.type === "terminal.cancelled" && e.executionId === sid),
    ).toHaveLength(1);
    expect(manager.listHistory().find((h) => h.sessionId === sid)?.cancelled).toBe(true);
    manager.disposeAll();
  });

  it("denies M4-rejected commands and never starts a session", async () => {
    const manager = new TerminalSessionManager(process.cwd());
    const received: TerminalStreamEventWithCorrelation[] = [];
    manager.setEventSink((e) => received.push(e));
    const result = await manager.start(
      { command: "sh", args: ["-c", "echo nope"] },
      makeBridge(() => true),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("[M4:deny]");
    expect(manager.list()).toHaveLength(0);
    expect(received).toHaveLength(0);
    manager.disposeAll();
  });

  it("history stays bounded under maxHistoryEntries", async () => {
    const manager = new TerminalSessionManager(process.cwd(), {
      maxHistoryEntries: 3,
    });
    for (let i = 0; i < 5; i++) {
      const started = await manager.start(
        { command: "node", args: ["-e", "process.exit(0)"] },
        makeBridge(),
      );
      if (!started.ok) break;
      await waitSettled(manager, started.session.id, 10_000);
    }
    expect(manager.listHistory().length).toBeLessThanOrEqual(3);
    manager.disposeAll();
  });

  it("disposeAll detaches the sink and clears state (no leaks)", async () => {
    const manager = new TerminalSessionManager(process.cwd());
    let sinkCalls = 0;
    manager.setEventSink(() => {
      sinkCalls += 1;
    });
    await manager.start(
      { command: "node", args: script([{ text: "leak-1" }]) },
      makeBridge(),
    );
    manager.disposeAll();
    const callsBefore = sinkCalls;
    // After dispose the sink is detached — no further events can arrive.
    await new Promise((r) => setTimeout(r, 150));
    expect(sinkCalls).toBe(callsBefore);
    expect(manager.list()).toHaveLength(0);
    expect(manager.listHistory()).toHaveLength(0);
  });
});
