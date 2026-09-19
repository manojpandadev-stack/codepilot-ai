/**
 * Agent-initiated tracked terminal session tests.
 *
 * Real processes (node -e scripts) through TerminalSessionManager's agent
 * container model prove:
 *   - session creation / exec / status / stop / close lifecycle
 *   - ownership (taskId) enforcement host-side (NOT_FOUND for foreign tasks)
 *   - per-command M4 evaluation (decision tokens; no session-level grants)
 *   - streaming: stdout EVENTS arrive BEFORE command completion (timestamps)
 *   - multi-command sessions (C1→C2→C3 in one sessionId, ordered history)
 *   - multi-session isolation (no cross-session output)
 *   - cancellation, closed-session rejection, limits, event correlation
 */
import { describe, it, expect } from "vitest";
import {
  TerminalSessionManager,
  type M4DecisionToken,
} from "../apps/vscode-extension/src/terminal-session-manager";
import type { LiveToolPermissionBridge } from "../packages/tool-engine/src/m4/live-bridge";
import type { TerminalStreamEventWithCorrelation } from "../packages/tool-engine/src/m3/terminal-stream";

const TASK_A = "conv-task-a";
const TASK_B = "conv-task-b";

/** Bridge stub: allow unless the command matches `deny`. */
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

/** Record every decision token the beforeTool gate stages (test stand-in). */
function stageToken(
  mgr: TerminalSessionManager,
  command: string,
  approved = true,
): void {
  const token: M4DecisionToken = {
    command,
    approved,
    decision: approved ? "allow" : "deny",
    reason: approved ? "staged allow" : "staged deny",
    issuedAt: Date.now(),
  };
  mgr.stageDecisionToken(token);
}

/**
 * Chained node -e script that writes lines with real gaps between writes —
 * genuinely time-separated output for the streaming proof.
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

/** Event collector wired at manager construction (pre-spawn sink). */
function makeSink() {
  const events: Array<{
    event: TerminalStreamEventWithCorrelation;
    at: number;
  }> = [];
  return {
    events,
    attach(mgr: TerminalSessionManager) {
      mgr.setEventSink((e) => {
        events.push({
          event: e as TerminalStreamEventWithCorrelation,
          at: Date.now(),
        });
      });
    },
  };
}

describe("agent tracked terminal sessions — lifecycle", () => {
  it("start → exec → exec → exec: three commands share one sessionId with ordered history", async () => {
    const mgr = new TerminalSessionManager(process.cwd());
    const sink = makeSink();
    sink.attach(mgr);
    const created = mgr.startAgentSession({ taskId: TASK_A });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { sessionId } = created;
    const bridge = makeBridge();

    const commands = ["FIRST", "SECOND", "THIRD"];
    const results = [];
    for (const word of commands) {
      stageToken(mgr, `echo ${word}`);
      const r = await mgr.execInSession(
        { sessionId, taskId: TASK_A, command: `echo ${word}` },
        bridge,
      );
      expect(r.ok).toBe(true);
      if (r.ok) results.push(r.result);
    }
    expect(results.map((r) => r.stdout.trim())).toEqual(commands);
    expect(results.map((r) => r.index)).toEqual([1, 2, 3]);
    expect(new Set(results.map((r) => r.sessionId))).toEqual(new Set([sessionId]));

    const view = mgr.agentSessionStatus(sessionId, TASK_A);
    expect(view).not.toBeNull();
    expect(view!.commandCount).toBe(3);
    expect(view!.commands.map((c) => c.index)).toEqual([1, 2, 3]);
    expect(view!.commands.map((c) => c.command)).toEqual([
      "echo FIRST",
      "echo SECOND",
      "echo THIRD",
    ]);
    // All commands ran under the same session id in the event stream.
    const sessionIds = new Set(
      sink.events.map((e) => e.event.sessionId),
    );
    expect(sessionIds).toEqual(new Set([sessionId]));
  });

  it("status view reports open/running state", async () => {
    const mgr = new TerminalSessionManager(process.cwd());
    mgr.setEventSink(() => {});
    const created = mgr.startAgentSession({ taskId: TASK_A });
    if (!created.ok) throw new Error(created.error);
    const view0 = mgr.agentSessionStatus(created.sessionId, TASK_A);
    expect(view0!.open).toBe(true);
    expect(view0!.runningIndex).toBeNull();
    expect(view0!.commandCount).toBe(0);
    // Long-running command — status while it runs (multi-line script keeps
    // the process alive waiting between writes).
    const longScript = script(
      [
        { text: "still-working-1" },
        { text: "still-working-2" },
      ],
      30_000,
    );
    stageToken(mgr, "node (long)");
    const pending = mgr.execInSession(
      {
        sessionId: created.sessionId,
        taskId: TASK_A,
        command: "node",
        args: longScript,
      },
      makeBridge(),
    );
    await new Promise((r) => setTimeout(r, 500));
    const view1 = mgr.agentSessionStatus(created.sessionId, TASK_A);
    expect(view1!.runningIndex).toBe(1);
    mgr.stopAgentSessionCommand(created.sessionId, TASK_A);
    const r = await pending;
    expect(r.ok).toBe(true);
  });

  it("close prevents further execution", async () => {
    const mgr = new TerminalSessionManager(process.cwd());
    mgr.setEventSink(() => {});
    const created = mgr.startAgentSession({ taskId: TASK_A });
    if (!created.ok) throw new Error(created.error);
    expect(mgr.closeAgentSession(created.sessionId, TASK_A)).toBe(true);
    stageToken(mgr, "echo after-close");
    const r = await mgr.execInSession(
      { sessionId: created.sessionId, taskId: TASK_A, command: "echo after-close" },
      makeBridge(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("CLOSED");
  });
});

describe("agent tracked terminal sessions — ownership security", () => {
  it("task B cannot exec into task A's session (NOT_FOUND-like FORBIDDEN)", async () => {
    const mgr = new TerminalSessionManager(process.cwd());
    mgr.setEventSink(() => {});
    const created = mgr.startAgentSession({ taskId: TASK_A });
    if (!created.ok) throw new Error(created.error);

    stageToken(mgr, "echo hijack");
    const r = await mgr.execInSession(
      { sessionId: created.sessionId, taskId: TASK_B, command: "echo hijack" },
      makeBridge(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("FORBIDDEN");
      expect(r.error).toContain("different task");
    }
    // No process ran: the session history stays empty.
    expect(mgr.agentSessionStatus(created.sessionId, TASK_A)!.commandCount).toBe(0);
  });

  it("unknown sessionId fails safely", async () => {
    const mgr = new TerminalSessionManager(process.cwd());
    mgr.setEventSink(() => {});
    const r = await mgr.execInSession(
      { sessionId: "agent-ts-does-not-exist", taskId: TASK_A, command: "echo x" },
      makeBridge(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("NOT_FOUND");
  });

  it("forged/invalid taskId is rejected without touching the session", async () => {
    const mgr = new TerminalSessionManager(process.cwd());
    mgr.setEventSink(() => {});
    const created = mgr.startAgentSession({ taskId: TASK_A });
    if (!created.ok) throw new Error(created.error);
    for (const badTaskId of ["", " ", undefined as unknown as string]) {
      const r = await mgr.execInSession(
        { sessionId: created.sessionId, taskId: badTaskId, command: "echo x" },
        makeBridge(),
      );
      expect(r.ok).toBe(false);
    }
    expect(mgr.agentSessionStatus(created.sessionId, TASK_A)!.commandCount).toBe(0);
  });

  it("status for another task's session returns null (indistinguishable from unknown)", () => {
    const mgr = new TerminalSessionManager(process.cwd());
    mgr.setEventSink(() => {});
    const created = mgr.startAgentSession({ taskId: TASK_A });
    if (!created.ok) throw new Error(created.error);
    expect(mgr.agentSessionStatus(created.sessionId, TASK_B)).toBeNull();
    expect(mgr.agentSessionStatus("no-such-session", TASK_B)).toBeNull();
  });

  it("close/stop from a foreign task is rejected", () => {
    const mgr = new TerminalSessionManager(process.cwd());
    mgr.setEventSink(() => {});
    const created = mgr.startAgentSession({ taskId: TASK_A });
    if (!created.ok) throw new Error(created.error);
    expect(mgr.closeAgentSession(created.sessionId, TASK_B)).toBe(false);
    expect(mgr.stopAgentSessionCommand(created.sessionId, TASK_B)).toBe(false);
    // Still open and usable by the owner.
    expect(mgr.agentSessionStatus(created.sessionId, TASK_A)!.open).toBe(true);
  });

  it("cancelAgentSessionsForTask closes only the owning task's sessions", () => {
    const mgr = new TerminalSessionManager(process.cwd());
    mgr.setEventSink(() => {});
    const a = mgr.startAgentSession({ taskId: TASK_A });
    const b = mgr.startAgentSession({ taskId: TASK_B });
    if (!a.ok || !b.ok) throw new Error("setup failed");
    expect(mgr.cancelAgentSessionsForTask(TASK_A)).toBe(1);
    expect(mgr.agentSessionStatus(a.sessionId, TASK_A)!.open).toBe(false);
    expect(mgr.agentSessionStatus(b.sessionId, TASK_B)!.open).toBe(true);
  });
});

describe("agent tracked terminal sessions — M4 per-command", () => {
  it("denied command produces NO process (bridge denial)", async () => {
    const mgr = new TerminalSessionManager(process.cwd());
    mgr.setEventSink(() => {});
    const created = mgr.startAgentSession({ taskId: TASK_A });
    if (!created.ok) throw new Error(created.error);
    const bridge = makeBridge((cmd) => cmd.includes("dangerous"));
    const r = await mgr.execInSession(
      { sessionId: created.sessionId, taskId: TASK_A, command: "echo dangerous" },
      bridge,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("M4_DENIED");
      expect(r.error).toContain("denied by policy");
    }
    expect(mgr.agentSessionStatus(created.sessionId, TASK_A)!.commandCount).toBe(0);
    // Session still usable afterwards.
    stageToken(mgr, "echo ok");
    const ok = await mgr.execInSession(
      { sessionId: created.sessionId, taskId: TASK_A, command: "echo ok" },
      makeBridge(),
    );
    expect(ok.ok).toBe(true);
  });

  it("staged deny token blocks without a process", async () => {
    const mgr = new TerminalSessionManager(process.cwd());
    mgr.setEventSink(() => {});
    const created = mgr.startAgentSession({ taskId: TASK_A });
    if (!created.ok) throw new Error(created.error);
    stageToken(mgr, "echo denied-by-beforeTool", false);
    const r = await mgr.execInSession(
      { sessionId: created.sessionId, taskId: TASK_A, command: "echo denied-by-beforeTool" },
      makeBridge(), // would allow — the token must deny
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("staged deny");
  });

  it("decision token is single-use and bound to the exact command", async () => {
    const mgr = new TerminalSessionManager(process.cwd());
    mgr.setEventSink(() => {});
    const created = mgr.startAgentSession({ taskId: TASK_A });
    if (!created.ok) throw new Error(created.error);
    // Token staged for command X; call requests command Y — token must NOT
    // apply, and the fallback bridge (allow) runs instead.
    stageToken(mgr, "echo X");
    const r = await mgr.execInSession(
      { sessionId: created.sessionId, taskId: TASK_A, command: "echo Y" },
      makeBridge(),
    );
    expect(r.ok).toBe(true); // fallback allowed it (token not consumed for Y)
    // Token for X was never consumed by Y — but consuming X again works once.
    stageToken(mgr, "echo X");
    const r1 = await mgr.execInSession(
      { sessionId: created.sessionId, taskId: TASK_A, command: "echo X" },
      makeBridge((c) => c === "echo X"), // fallback would DENY X
    );
    expect(r1.ok).toBe(true); // allowed by the staged token, not the bridge
    const r2 = await mgr.execInSession(
      { sessionId: created.sessionId, taskId: TASK_A, command: "echo X" },
      makeBridge((c) => c === "echo X"), // token consumed — fallback denies
    );
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe("M4_DENIED");
  });

  it("expired tokens are never consumed", async () => {
    const mgr = new TerminalSessionManager(process.cwd());
    mgr.setEventSink(() => {});
    const created = mgr.startAgentSession({ taskId: TASK_A });
    if (!created.ok) throw new Error(created.error);
    stageToken(mgr, "echo stale");
    // Forge expiry by rewriting the issued time.
    const key = "echo stale";
    // Access the private map via staging a fresh token with old timestamp:
    mgr.stageDecisionToken({
      command: key,
      approved: true,
      issuedAt: Date.now() - 120_000,
    });
    const r = await mgr.execInSession(
      { sessionId: created.sessionId, taskId: TASK_A, command: "echo stale" },
      makeBridge((c) => c === "echo stale"), // fallback denies → proves expiry
    );
    expect(r.ok).toBe(false);
  });

  it("no fallback bridge → exec refuses (deny-closed)", async () => {
    // The manager API requires a bridge object; simulate a bridge whose
    // evaluation throws (pipeline unavailable) — result must be denied.
    const mgr = new TerminalSessionManager(process.cwd());
    mgr.setEventSink(() => {});
    const created = mgr.startAgentSession({ taskId: TASK_A });
    if (!created.ok) throw new Error(created.error);
    const throwingBridge = {
      evaluateLiveTool: async () => {
        throw new Error("pipeline unavailable");
      },
    } as unknown as LiveToolPermissionBridge;
    const r = await mgr.execInSession(
      { sessionId: created.sessionId, taskId: TASK_A, command: "echo x" },
      throwingBridge,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("M4_DENIED");
  });
});

describe("agent tracked terminal sessions — streaming & isolation", () => {
  it("STREAMING PROOF: stdout events arrive before completion (timestamps)", async () => {
    const mgr = new TerminalSessionManager(process.cwd());
    const sink = makeSink();
    sink.attach(mgr);
    const created = mgr.startAgentSession({ taskId: TASK_A });
    if (!created.ok) throw new Error(created.error);
    stageToken(mgr, "node (streaming)");
    const argv = script([
      { text: "M7-1" },
      { text: "M7-2" },
      { text: "M7-3" },
    ], 300);
    const r = await mgr.execInSession(
      { sessionId: created.sessionId, taskId: TASK_A, command: "node", args: argv },
      makeBridge(),
    );
    expect(r.ok).toBe(true);
    const doneAt = r.ok ? r.result.completedAt : 0;
    const chunks = sink.events.filter(
      (e) => e.event.type === "terminal.stdout",
    );
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      expect(c.at).toBeLessThan(doneAt);
    }
    // Chunks carry session correlation and monotonically increasing seq.
    const seqs = chunks.map((c) => (c.event as unknown as { seq: number }).seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(new Set(chunks.map((c) => c.event.sessionId))).toEqual(
      new Set([created.sessionId]),
    );
    const text = chunks
      .map((c) => ((c.event as unknown as { data?: string }).data ?? ""))
      .join("");
    expect(text).toContain("M7-1");
    expect(text).toContain("M7-3");
  }, 20_000);

  it("two concurrent sessions never cross outputs", async () => {
    const mgr = new TerminalSessionManager(process.cwd());
    const sink = makeSink();
    sink.attach(mgr);
    const a = mgr.startAgentSession({ taskId: TASK_A });
    const b = mgr.startAgentSession({ taskId: TASK_B });
    if (!a.ok || !b.ok) throw new Error("setup failed");
    stageToken(mgr, "node (A)");
    stageToken(mgr, "node (B)");
    const argvA = script([{ text: "FROM-A-1" }, { text: "FROM-A-2" }], 300);
    const argvB = script([{ text: "FROM-B-1" }, { text: "FROM-B-2" }], 300);
    const [ra, rb] = await Promise.all([
      mgr.execInSession(
        { sessionId: a.sessionId, taskId: TASK_A, command: "node", args: argvA },
        makeBridge(),
      ),
      mgr.execInSession(
        { sessionId: b.sessionId, taskId: TASK_B, command: "node", args: argvB },
        makeBridge(),
      ),
    ]);
    expect(ra.ok && rb.ok).toBe(true);
    // All events tagged FROM-A belong only to session A, and vice versa.
    const bySession = new Map<string, string>();
    for (const e of sink.events) {
      if (e.event.type !== "terminal.stdout") continue;
      const data = (e.event as unknown as { data?: string }).data ?? "";
      bySession.set(e.event.sessionId, (bySession.get(e.event.sessionId) ?? "") + data);
    }
    expect(bySession.get(a.sessionId)).toContain("FROM-A-1");
    expect(bySession.get(a.sessionId)).toContain("FROM-A-2");
    expect(bySession.get(a.sessionId)).not.toContain("FROM-B");
    expect(bySession.get(b.sessionId)).toContain("FROM-B-1");
    expect(bySession.get(b.sessionId)).toContain("FROM-B-2");
    expect(bySession.get(b.sessionId)).not.toContain("FROM-A");
  }, 20_000);

  it("cancellation during streaming: terminal.cancelled exactly once, result reports cancelled", async () => {
    const mgr = new TerminalSessionManager(process.cwd());
    const sink = makeSink();
    sink.attach(mgr);
    const created = mgr.startAgentSession({ taskId: TASK_A });
    if (!created.ok) throw new Error(created.error);
    stageToken(mgr, "node (cancel)");
    const argv = script(
      [
        { text: "before-cancel-1" },
        { text: "before-cancel-2" },
        { text: "before-cancel-3" },
      ],
      400,
    );
    const pending = mgr.execInSession(
      { sessionId: created.sessionId, taskId: TASK_A, command: "node", args: argv },
      makeBridge(),
    );
    // Wait for the first chunk, then cancel via session stop.
    await new Promise((r) => setTimeout(r, 700));
    expect(mgr.stopAgentSessionCommand(created.sessionId, TASK_A)).toBe(true);
    const r = await pending;
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.cancelled).toBe(true);
    }
    const cancels = sink.events.filter(
      (e) => e.event.type === "terminal.cancelled",
    );
    expect(cancels.length).toBe(1);
  }, 20_000);

  it("high-volume output (1000 chunks) completes with bounded history", async () => {
    const mgr = new TerminalSessionManager(process.cwd(), {
      maxHistoryBytes: 2_000,
    });
    mgr.setEventSink(() => {});
    const created = mgr.startAgentSession({ taskId: TASK_A });
    if (!created.ok) throw new Error(created.error);
    const code = `for (let i = 0; i < 1000; i++) { process.stdout.write("chunk-" + i + "\\n"); }`;
    stageToken(mgr, "node (flood)");
    const r = await mgr.execInSession(
      { sessionId: created.sessionId, taskId: TASK_A, command: "node", args: ["-e", code] },
      makeBridge(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.status).toBe("exited");
      expect(r.result.exitCode).toBe(0);
      // History bounded: result tail is capped with explicit truncation.
      expect(r.result.stdout.length).toBeLessThanOrEqual(8_000);
      expect(r.result.truncated).toBe(true);
    }
    // History record stored bounded too.
    const hist = mgr.listHistory();
    const last = hist[hist.length - 1];
    expect(last.outputTruncated).toBe(true);
    expect(last.stdoutTail.length).toBeLessThanOrEqual(2_000);
  }, 30_000);

  it("empty/history bounds: session completed list caps at maxHistoryEntries", async () => {
    const mgr = new TerminalSessionManager(process.cwd(), {
      maxHistoryEntries: 3,
    });
    mgr.setEventSink(() => {});
    const created = mgr.startAgentSession({ taskId: TASK_A });
    if (!created.ok) throw new Error(created.error);
    for (let i = 1; i <= 5; i++) {
      stageToken(mgr, `echo run-${i}`);
      const r = await mgr.execInSession(
        { sessionId: created.sessionId, taskId: TASK_A, command: `echo run-${i}` },
        makeBridge(),
      );
      expect(r.ok).toBe(true);
    }
    const view = mgr.agentSessionStatus(created.sessionId, TASK_A)!;
    expect(view.commandCount).toBe(3);
    // Oldest entries evicted; latest retained.
    expect(view.commands.map((c) => c.index)).toEqual([3, 4, 5]);
  }, 30_000);
});

describe("agent tracked terminal sessions — argument validation", () => {
  it("rejects empty command and oversized command", async () => {
    const mgr = new TerminalSessionManager(process.cwd());
    mgr.setEventSink(() => {});
    const created = mgr.startAgentSession({ taskId: TASK_A });
    if (!created.ok) throw new Error(created.error);
    const r1 = await mgr.execInSession(
      { sessionId: created.sessionId, taskId: TASK_A, command: "   " },
      makeBridge(),
    );
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.code).toBe("INVALID");
    const r2 = await mgr.execInSession(
      { sessionId: created.sessionId, taskId: TASK_A, command: "x".repeat(5000) },
      makeBridge(),
    );
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe("INVALID");
  });

  it("agent session cap is enforced", () => {
    const mgr = new TerminalSessionManager(process.cwd());
    mgr.setEventSink(() => {});
    let created = 0;
    let lastError = "";
    for (let i = 0; i < 6; i++) {
      const r = mgr.startAgentSession({ taskId: `task-${i}` });
      if (r.ok) created++;
      else lastError = r.error;
    }
    expect(created).toBe(4); // MAX_AGENT_SESSIONS
    expect(lastError).toContain("limit");
  });
});
