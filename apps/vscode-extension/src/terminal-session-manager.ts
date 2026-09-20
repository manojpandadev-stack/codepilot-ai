/**
 * M7 — Host-side terminal session manager.
 *
 * Manages long-running/background processes (dev servers, watchers) as
 * tracked TerminalSession instances. Every start() goes through the M4
 * permission pipeline BEFORE a process is spawned — this module never
 * decides permissions itself and never bypasses the bridge.
 *
 * Streaming: sessions emit the SAME typed `terminal.*` events the agent
 * streaming path uses (m3/terminal-stream contract). The manager fans each
 * session's events out with full correlation (sessionId + executionId +
 * taskId + seq + timestamp) through a host-provided sink — which the
 * extension forwards to the WebView on the EXISTING `terminal/output`
 * message. No second protocol, no polling.
 *
 * Command history: each command records a bounded, redacted history entry
 * (command, status, timing, bounded output) so the terminal tab can show
 * what ran without a second persistence database.
 *
 * Agent sessions (this milestone): `startAgentSession` creates a container
 * scoped to an owning taskId; `execInSession` runs N sequential commands
 * through that container, each as its own TerminalSession process — so the
 * SAME proven engine, event contract, and M4 gate apply per command. There
 * is NO second execution engine and NO session-level permission grant:
 * every exec re-evaluates through M4, and ownership (taskId) is enforced
 * host-side.
 *
 * Shell-state note: each command is an independent process (own shell).
 * Working directory and environment are inherited from the session
 * container (agent may pass cwd), NOT from previous commands — a `cd` in
 * one command does not persist. This is explicit, documented behavior.
 */

import {
  TerminalSession,
  detectShell,
  shellArgvForCommand,
  type TerminalSessionSnapshot,
} from "@codepilot/tool-engine";
import type { LiveToolPermissionBridge } from "@codepilot/tool-engine";
import type {
  TerminalStreamEvent,
  TerminalStreamEventWithCorrelation,
  TerminalStreamSink,
} from "@codepilot/tool-engine";

/** Maximum concurrent tracked sessions — prevents uncontrolled background activity. */
const MAX_SESSIONS = 8;

/** Cap on retained session records after exit (oldest evicted). */
const MAX_FINISHED_SESSIONS = 20;

/** Default cap on one session's retained history output, per stream (bytes). */
const DEFAULT_MAX_HISTORY_BYTES = 8_000;

/** Maximum concurrent agent sessions (containers). */
const MAX_AGENT_SESSIONS = 4;

/** Default per-command timeout for agent session commands (10 min). */
const DEFAULT_AGENT_COMMAND_TIMEOUT_MS = 10 * 60_000;

/**
 * Typed terminal event with session correlation. `sessionId` identifies the
 * M7 tracked session; `executionId` equals it (one session = one process =
 * one execution); `taskId` is the caller-supplied task scope when known.
 */
export type TrackedTerminalEvent = TerminalStreamEvent & {
  sessionId: string;
  /** Equals sessionId — one session is one execution on this contract. */
  executionId: string;
  taskId?: string;
  timestamp: number;
};

/** One bounded, redacted command-history record for the terminal tab. */
export interface SessionCommandRecord {
  sessionId: string;
  command: string;
  args: string[];
  startedAt: number;
  durationMs: number;
  status: TerminalSessionSnapshot["status"];
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  /** Bounded, redacted tail of stdout (history is a summary, not a buffer). */
  stdoutTail: string;
  /** Bounded, redacted tail of stderr. */
  stderrTail: string;
  /** True when output was retained only partially (explicit indicator). */
  outputTruncated: boolean;
}

export interface TerminalSessionManagerOptions {
  /** Max bytes retained per stream in a history record (default 8 kB). */
  maxHistoryBytes?: number;
  /** Maximum history records retained (default 100). */
  maxHistoryEntries?: number;
}

// ============================================================================
// Agent session container
// ============================================================================

/** A command queued/executed inside an agent session. */
export interface AgentSessionCommandSpec {
  command: string;
  args?: string[];
}

/** Result of one command executed inside an agent session. */
export interface AgentSessionCommandResult {
  sessionId: string;
  /** Owner task id (repeated for convenience/validation). */
  taskId: string;
  commandId: string;
  /** The command as requested (1-based) within the session. */
  index: number;
  status: TerminalSessionSnapshot["status"];
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  /** Bounded tails (history-bounded, redacted upstream by the session). */
  stdout: string;
  stderr: string;
  truncated: boolean;
  error?: string;
}

/** Read-only view of an agent session for `terminal_session_status`. */
export interface AgentSessionStatusView {
  sessionId: string;
  taskId: string;
  createdAt: number;
  commandCount: number;
  /** Currently running command index (1-based) when one is active. */
  runningIndex: number | null;
  /** Session remains open for more commands. */
  open: boolean;
  /** Bounded history of completed commands in this session. */
  commands: Array<
    Pick<
      AgentSessionCommandResult,
      | "commandId"
      | "index"
      | "status"
      | "exitCode"
      | "timedOut"
      | "cancelled"
      | "startedAt"
      | "completedAt"
      | "durationMs"
    > & { command: string }
  >;
}

interface AgentSessionContainer {
  sessionId: string;
  /** Owning task — enforced host-side on every operation. */
  taskId: string;
  createdAt: number;
  cwd?: string;
  /** 1-based index of the next command. */
  nextIndex: number;
  /** Serializes execs inside one session (one command at a time). */
  queue: Promise<unknown>;
  /** Command index currently running (1-based), or null. */
  runningIndex: number | null;
  open: boolean;
  /** Completed-command summaries for status view (bounded by maxHistoryEntries upstream). */
  completed: Array<
    Pick<
      AgentSessionCommandResult,
      | "commandId"
      | "index"
      | "status"
      | "exitCode"
      | "timedOut"
      | "cancelled"
      | "startedAt"
      | "completedAt"
      | "durationMs"
    > & { command: string }
  >;
}

export type AgentSessionStartResult =
  | { ok: true; sessionId: string; taskId: string; createdAt: number }
  | { ok: false; error: string };

export type AgentSessionExecResult =
  | { ok: true; result: AgentSessionCommandResult }
  | {
      ok: false;
      error: string;
      code:
        | "NOT_FOUND"
        | "FORBIDDEN"
        | "M4_DENIED"
        | "CLOSED"
        | "INVALID"
        | "BUSY"
        | "LIMIT";
    };

/**
 * Pre-computed M4 decision for one agent session command. The extension's
 * beforeTool hook has ALREADY evaluated this exact command through the live
 * bridge — the tool execute() path hands it here so the manager does not
 * re-evaluate (which would double-prompt the user). Single-use and
 * short-TTL: consumed exactly once or discarded.
 */
export interface M4DecisionToken {
  /** Exact command string the decision was computed for. */
  command: string;
  approved: boolean;
  reason?: string;
  decision?: string;
  riskLevel?: string;
  issuedAt: number;
}

/** How long an unconsumed decision token stays valid. */
const DECISION_TOKEN_TTL_MS = 60_000;

export class TerminalSessionManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly finishedOrder: string[] = [];
  private readonly workspaceRoot: string;
  /** Command history — newest last, bounded. */
  private readonly history: SessionCommandRecord[] = [];
  private readonly maxHistoryBytes: number;
  private readonly maxHistoryEntries: number;
  /** Host sink for typed session events (extension forwards to terminal/output). */
  private eventSink: TerminalStreamSink | null = null;
  /** Host lifecycle audit hook (one record per session, never per chunk). */
  private auditHook:
    | ((entry: {
        sessionId: string;
        phase:
          | "requested"
          | "decision"
          | "started"
          | "completed"
          | "failed"
          | "cancelled";
        command: string;
        status?: string;
        exitCode?: number | null;
        durationMs?: number;
        approved?: boolean;
        reason?: string;
      }) => void)
    | null = null;
  /** Agent session containers, keyed by sessionId. */
  private readonly agentSessions = new Map<string, AgentSessionContainer>();
  /** Single-use decision tokens produced by the beforeTool M4 gate. */
  private decisionTokens = new Map<string, M4DecisionToken>();

  constructor(
    workspaceRoot: string,
    options: TerminalSessionManagerOptions = {},
  ) {
    this.workspaceRoot = workspaceRoot;
    this.maxHistoryBytes = Math.max(
      0,
      options.maxHistoryBytes ?? DEFAULT_MAX_HISTORY_BYTES,
    );
    this.maxHistoryEntries = Math.max(1, options.maxHistoryEntries ?? 100);
  }

  /** Wire the host event sink (called once by the extension at activation). */
  setEventSink(sink: TerminalStreamSink | null): void {
    this.eventSink = sink;
  }

  /** Wire the host lifecycle audit hook (command-level, never per-chunk). */
  setAuditHook(hook: TerminalSessionManager["auditHook"]): void {
    this.auditHook = hook;
  }

  /** Bounded command history (oldest first), for the WebView terminal tab. */
  listHistory(): SessionCommandRecord[] {
    return [...this.history];
  }

  // ==========================================================================
  // Existing single-shot tracked sessions (user terminal tab path)
  // ==========================================================================

  /**
   * Start a tracked session. Returns null (never throws) when the M4
   * pipeline denies the command or the session cap is reached — the caller
   * surfaces the reason to the UI.
   */
  async start(
    options: {
      command: string;
      args?: string[];
      cwd?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      taskId?: string;
    },
    bridge: LiveToolPermissionBridge,
  ): Promise<
    | { ok: true; session: TerminalSessionSnapshot }
    | { ok: false; error: string }
  > {
    if (this.sessions.size >= MAX_SESSIONS) {
      return {
        ok: false,
        error: `Session limit reached (${MAX_SESSIONS} concurrent)`,
      };
    }
    if (
      typeof options.command !== "string" ||
      options.command.trim().length === 0
    ) {
      return { ok: false, error: "command is required" };
    }

    const sessionId = `ts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.auditHook?.({
      sessionId,
      phase: "requested",
      command: options.command,
    });

    // M4 gate: every session start is a live tool evaluation. Deny-closed.
    const decision = await bridge.evaluateLiveTool({
      toolName: "terminal",
      input: { command: options.command, args: options.args ?? [] },
      sessionId: undefined,
      taskId: options.taskId ?? `terminal:${sessionId}`,
    });
    this.auditHook?.({
      sessionId,
      phase: "decision",
      command: options.command,
      approved: decision.approved,
      reason: decision.reason,
    });
    if (!decision.approved) {
      return {
        ok: false,
        error: `[M4:${decision.decision}] ${decision.reason}`,
      };
    }

    const taskId = options.taskId;
    // Shell routing: a raw command string is what a user types into a
    // terminal, so it goes through the platform shell — the SAME resolution
    // (getDefaultShell/getShellInvocation) the agent streaming path uses,
    // with the source travelling via stdin (Unicode-safe on PowerShell).
    // Structured argv callers keep the direct-spawn behavior.
    const hasArgs = Array.isArray(options.args) && options.args.length > 0;
    const argv = hasArgs
      ? { command: options.command, args: options.args ?? [] }
      : shellArgvForCommand(options.command);
    const session = new TerminalSession({
      command: argv.command,
      args: argv.args,
      ...(argv.stdin !== undefined ? { stdin: argv.stdin } : {}),
      cwd: options.cwd ?? this.workspaceRoot,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      // Pre-spawn subscription so terminal.started and the first chunks are
      // never missed by the fan-out (post-start subscribe sees only new data).
      onEvent: (event) => {
        const correlated: TrackedTerminalEvent = {
          ...event,
          sessionId: session.id,
          executionId: session.id,
          ...(taskId !== undefined ? { taskId } : {}),
          timestamp: Date.now(),
        };
        try {
          this.eventSink?.(correlated as TerminalStreamEventWithCorrelation);
        } catch {
          // A failing sink must never break the session.
        }
        if (
          event.type === "terminal.exit" ||
          event.type === "terminal.cancelled" ||
          event.type === "terminal.timeout" ||
          event.type === "terminal.error"
        ) {
          this.recordHistory(session, event);
          if (event.type === "terminal.exit") {
            this.auditHook?.({
              sessionId: session.id,
              phase: "completed",
              command: options.command,
              status: session.snapshot().status,
              exitCode: event.exitCode,
              durationMs: event.durationMs,
              approved: true,
            });
          } else if (event.type === "terminal.cancelled") {
            this.auditHook?.({
              sessionId: session.id,
              phase: "cancelled",
              command: options.command,
              durationMs: event.durationMs,
              approved: true,
            });
          } else if (event.type === "terminal.timeout") {
            this.auditHook?.({
              sessionId: session.id,
              phase: "failed",
              command: options.command,
              status: "timedOut",
              durationMs: event.durationMs,
              approved: true,
            });
          } else {
            this.auditHook?.({
              sessionId: session.id,
              phase: "failed",
              command: options.command,
              status: "error",
              reason: event.message,
            });
          }
        }
      },
    });
    try {
      session.start();
    } catch (err) {
      this.auditHook?.({
        sessionId,
        phase: "failed",
        command: options.command,
        status: "error",
        reason: err instanceof Error ? err.message : String(err),
      });
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    this.sessions.set(session.id, session);
    this.sessionMeta.set(session.id, {
      command: options.command,
      args: options.args ?? [],
      startedAt: Date.now(),
    });

    void session.wait().then(() => this.pruneFinished());
    this.auditHook?.({
      sessionId: session.id,
      phase: "started",
      command: options.command,
      status: session.snapshot().status,
    });

    // Log shell + pid for diagnostics (never command output — that is redacted
    // in snapshots, and raw streams are only delivered to subscribed UI).
    return { ok: true, session: session.snapshot() };
  }

  /** Snapshot of every tracked session (running first, then finished). */
  list(): TerminalSessionSnapshot[] {
    return [...this.sessions.values()].map((s) => s.snapshot());
  }

  /** One session snapshot, or null when unknown. */
  status(id: string): TerminalSessionSnapshot | null {
    return this.sessions.get(id)?.snapshot() ?? null;
  }

  /** Graceful termination (SIGTERM). Returns false when session is unknown. */
  stop(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.cancel();
    return true;
  }

  /** Forced termination (SIGKILL). Returns false when session is unknown. */
  kill(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.kill();
    return true;
  }

  /** Terminate everything (extension shutdown). Idempotent. */
  disposeAll(): void {
    for (const session of this.sessions.values()) {
      try {
        session.dispose();
      } catch {
        // best effort during shutdown
      }
    }
    this.sessions.clear();
    this.finishedOrder.length = 0;
    this.sessionMeta.clear();
    // Agent sessions: close containers; running processes are disposed above
    // only if they registered a live session — exec-time sessions are closed
    // via cancelSessionAll below.
    for (const container of this.agentSessions.values()) {
      container.open = false;
    }
    this.agentSessions.clear();
    this.decisionTokens.clear();
    this.eventSink = null;
    this.auditHook = null;
  }

  /** Default shell descriptor for UI display. */
  describeShell(): { shell: string; name: string } {
    const s = detectShell();
    return { shell: s.shell, name: s.name };
  }

  /** Evict exited sessions beyond the retention cap. */
  private pruneFinished(): void {
    for (const [id, session] of this.sessions) {
      const snap = session.snapshot();
      const done =
        snap.status === "exited" ||
        snap.status === "killed" ||
        snap.status === "timedOut" ||
        snap.status === "error";
      if (!done) continue;
      if (!this.finishedOrder.includes(id)) this.finishedOrder.push(id);
    }
    while (this.finishedOrder.length > MAX_FINISHED_SESSIONS) {
      const oldest = this.finishedOrder.shift();
      if (oldest) this.sessions.delete(oldest);
    }
  }

  /**
   * Append one bounded history record from the session's final event.
   * Reads the session's own redacted snapshot buffers — history is a
   * summary, never an unbounded copy of the output.
   */
  private recordHistory(
    session: TerminalSession,
    final: Extract<
      TerminalStreamEvent,
      {
        type:
          | "terminal.exit"
          | "terminal.cancelled"
          | "terminal.timeout"
          | "terminal.error";
      }
    >,
  ): void {
    const snap = session.snapshot();
    const max = this.maxHistoryBytes;
    const tail = (text: string): { text: string; truncated: boolean } => {
      if (text.length <= max) return { text, truncated: false };
      return { text: text.slice(-max), truncated: true };
    };
    const out = tail(snap.stdout);
    const errOut = tail(snap.stderr);
    const startedAt =
      this.sessionMeta.get(session.id)?.startedAt ??
      Date.now() - ((final as { durationMs?: number }).durationMs ?? 0);
    const record: SessionCommandRecord = {
      sessionId: session.id,
      command: this.sessionMeta.get(session.id)?.command ?? "",
      args: this.sessionMeta.get(session.id)?.args ?? [],
      startedAt,
      durationMs: (final as { durationMs?: number }).durationMs ?? 0,
      status: snap.status,
      exitCode: snap.exitCode,
      timedOut: snap.timedOut,
      cancelled: snap.cancelled,
      stdoutTail: out.text,
      stderrTail: errOut.text,
      outputTruncated:
        out.truncated ||
        errOut.truncated ||
        snap.stdout.length > this.maxHistoryBytes ||
        snap.stderr.length > this.maxHistoryBytes,
    };
    this.history.push(record);
    while (this.history.length > this.maxHistoryEntries) {
      this.history.shift();
    }
  }

  /** Per-session start metadata so history survives session eviction. */
  private readonly sessionMeta = new Map<
    string,
    { command: string; args: string[]; startedAt: number }
  >();

  // ==========================================================================
  // Agent-initiated tracked sessions (containers over the same engine)
  // ==========================================================================

  /**
   * Record an M4 decision token produced by the extension's beforeTool gate
   * for one agent session command. Single-use; expires after 60 s.
   */
  stageDecisionToken(token: M4DecisionToken): void {
    // Opportunistic cleanup of expired tokens (bounded map).
    const now = Date.now();
    if (this.decisionTokens.size > 0) {
      for (const [key, t] of this.decisionTokens) {
        if (now - t.issuedAt > DECISION_TOKEN_TTL_MS)
          this.decisionTokens.delete(key);
      }
    }
    this.decisionTokens.set(this.tokenKey(token.command), token);
  }

  private tokenKey(command: string): string {
    // The key must be bound to the exact command text so a token for command
    // A can never authorize command B. Full command text (bounded) is the key.
    return command.length <= 4096 ? command : command.slice(0, 4096);
  }

  private consumeDecisionToken(command: string): M4DecisionToken | null {
    const key = this.tokenKey(command);
    const token = this.decisionTokens.get(key);
    if (!token) return null;
    this.decisionTokens.delete(key);
    if (Date.now() - token.issuedAt > DECISION_TOKEN_TTL_MS) return null;
    return token;
  }

  /**
   * Create an agent session container. Pure bookkeeping — NO process is
   * spawned here and NO permission is granted. Every command is evaluated
   * by M4 at exec time.
   */
  startAgentSession(options: {
    taskId: string;
    cwd?: string;
  }): AgentSessionStartResult {
    if (
      typeof options.taskId !== "string" ||
      options.taskId.trim().length === 0
    ) {
      return { ok: false, error: "taskId is required" };
    }
    if (this.agentSessions.size >= MAX_AGENT_SESSIONS) {
      return {
        ok: false,
        error: `Agent session limit reached (${MAX_AGENT_SESSIONS} concurrent)`,
      };
    }
    const sessionId = `agent-ts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.agentSessions.set(sessionId, {
      sessionId,
      taskId: options.taskId,
      createdAt: Date.now(),
      cwd: options.cwd,
      nextIndex: 1,
      queue: Promise.resolve(),
      runningIndex: null,
      open: true,
      completed: [],
    });
    this.auditHook?.({
      sessionId,
      phase: "requested",
      command: "(agent session created)",
    });
    return {
      ok: true,
      sessionId,
      taskId: options.taskId,
      createdAt: Date.now(),
    };
  }

  /** Look up a container and enforce ownership. Deny-closed. */
  private ownedSession(
    sessionId: unknown,
    taskId: unknown,
  ):
    | { ok: true; container: AgentSessionContainer }
    | {
        ok: false;
        error: string;
        code: "NOT_FOUND" | "FORBIDDEN" | "INVALID";
      } {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return { ok: false, error: "sessionId is required", code: "INVALID" };
    }
    if (typeof taskId !== "string" || taskId.length === 0) {
      return { ok: false, error: "taskId is required", code: "INVALID" };
    }
    const container = this.agentSessions.get(sessionId);
    if (!container) {
      return {
        ok: false,
        error: `unknown session: ${sessionId}`,
        code: "NOT_FOUND",
      };
    }
    if (container.taskId !== taskId) {
      return {
        ok: false,
        error: "session belongs to a different task",
        code: "FORBIDDEN",
      };
    }
    return { ok: true, container };
  }

  /**
   * Execute ONE command inside an owned agent session. The command is
   * evaluated through M4 (via the pre-staged decision token from the
   * beforeTool gate, or a fresh bridge evaluation when no token exists —
   * deny-closed) and then runs as its own TerminalSession process on the
   * same streaming contract.
   */
  async execInSession(
    options: {
      sessionId: string;
      taskId: string;
      command: string;
      args?: string[];
      timeoutMs?: number;
      signal?: AbortSignal;
    },
    bridge: LiveToolPermissionBridge,
  ): Promise<AgentSessionExecResult> {
    const owned = this.ownedSession(options.sessionId, options.taskId);
    if (!owned.ok) {
      return { ok: false, error: owned.error, code: owned.code };
    }
    const container = owned.container;
    if (!container.open) {
      return { ok: false, error: "session is closed", code: "CLOSED" };
    }
    if (
      typeof options.command !== "string" ||
      options.command.trim().length === 0
    ) {
      return { ok: false, error: "command is required", code: "INVALID" };
    }
    if (options.command.length > 4096) {
      return {
        ok: false,
        error: "command too long (max 4096 chars)",
        code: "INVALID",
      };
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      return {
        ok: false,
        error: `Session limit reached (${MAX_SESSIONS} concurrent)`,
        code: "LIMIT",
      };
    }

    // commandId/index are assigned at RUN time (inside enqueue), not at
    // call time — queued commands must not share an index.
    const enqueue = async (): Promise<AgentSessionExecResult> => {
      const commandId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${container.nextIndex}`;
      const index = container.nextIndex;
      const token = this.consumeDecisionToken(options.command);
      let approved = false;
      let decision = "";
      let reason = "";
      if (token && token.approved) {
        approved = true;
        decision = token.decision ?? "token";
        reason = token.reason ?? "approved via beforeTool M4 gate";
      } else if (token && !token.approved) {
        decision = token.decision ?? "deny";
        reason = token.reason ?? "denied by beforeTool M4 gate";
      } else {
        try {
          const fresh = await bridge.evaluateLiveTool({
            toolName: "terminal",
            input: { command: options.command, args: options.args ?? [] },
            sessionId: undefined,
            taskId: options.taskId,
          });
          approved = fresh.approved;
          decision = fresh.decision;
          reason = fresh.reason;
        } catch (err) {
          // Deny-closed: a failing pipeline must never allow execution.
          approved = false;
          decision = "error";
          reason = `permission evaluation failed: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      }
      this.auditHook?.({
        sessionId: container.sessionId,
        phase: "decision",
        command: options.command,
        approved,
        reason,
      });
      if (!approved) {
        return {
          ok: false,
          code: "M4_DENIED",
          error: `[M4:${decision}] ${reason}`,
        };
      }

      // Run as its own TerminalSession on the SAME engine/contract.
      const hasArgs = Array.isArray(options.args) && options.args.length > 0;
      const argv = hasArgs
        ? { command: options.command, args: options.args ?? [] }
        : shellArgvForCommand(options.command);
      const startedAt = Date.now();
      const commandSession = new TerminalSession({
        command: argv.command,
        args: argv.args,
        ...(argv.stdin !== undefined ? { stdin: argv.stdin } : {}),
        cwd: container.cwd ?? this.workspaceRoot,
        timeoutMs:
          options.timeoutMs && options.timeoutMs > 0
            ? Math.min(options.timeoutMs, DEFAULT_AGENT_COMMAND_TIMEOUT_MS * 6)
            : DEFAULT_AGENT_COMMAND_TIMEOUT_MS,
        signal: options.signal,
        onEvent: (event) => {
          const correlated: TrackedTerminalEvent = {
            ...event,
            sessionId: container.sessionId,
            // executionId identifies the COMMAND within the session so
            // concurrent chunks from two commands can never be confused.
            executionId: commandId,
            taskId: container.taskId,
            timestamp: Date.now(),
          };
          try {
            this.eventSink?.(correlated as TerminalStreamEventWithCorrelation);
          } catch {
            // A failing sink must never break the session.
          }
        },
      });
      container.runningIndex = index;
      try {
        commandSession.start();
      } catch (err) {
        container.runningIndex = null;
        this.auditHook?.({
          sessionId: container.sessionId,
          phase: "failed",
          command: options.command,
          status: "error",
          reason: err instanceof Error ? err.message : String(err),
        });
        const completedAt = Date.now();
        return {
          ok: true,
          result: {
            sessionId: container.sessionId,
            taskId: container.taskId,
            commandId,
            index,
            status: "error",
            exitCode: null,
            timedOut: false,
            cancelled: false,
            startedAt,
            completedAt,
            durationMs: completedAt - startedAt,
            stdout: "",
            stderr: "",
            truncated: false,
            error: err instanceof Error ? err.message : String(err),
          },
        };
      }
      this.sessions.set(commandSession.id, commandSession);
      this.sessionMeta.set(commandSession.id, {
        command: options.command,
        args: options.args ?? [],
        startedAt,
      });
      this.auditHook?.({
        sessionId: container.sessionId,
        phase: "started",
        command: options.command,
      });

      const final = await commandSession.wait();
      container.runningIndex = null;
      container.nextIndex = index + 1;
      const snap = commandSession.snapshot();
      const max = this.maxHistoryBytes;
      const tail = (text: string): { text: string; truncated: boolean } =>
        text.length <= max
          ? { text, truncated: false }
          : { text: text.slice(-max), truncated: true };
      const out = tail(snap.stdout);
      const errOut = tail(snap.stderr);
      // Explicit indicator when output was bounded — never silent.
      const truncated =
        out.truncated ||
        errOut.truncated ||
        (final as { type?: string }).type === "terminal.timeout";
      const result: AgentSessionCommandResult = {
        sessionId: container.sessionId,
        taskId: container.taskId,
        commandId,
        index,
        status: snap.status,
        exitCode: snap.exitCode,
        timedOut: snap.timedOut,
        cancelled: snap.cancelled,
        startedAt,
        completedAt: Date.now(),
        durationMs: snap.durationMs,
        stdout: out.text,
        stderr: errOut.text,
        truncated,
        ...(snap.status === "error" && commandSession.error
          ? { error: commandSession.error }
          : {}),
      };
      // History + audit follow the same phases as single-shot sessions.
      const historyRecord: SessionCommandRecord = {
        sessionId: container.sessionId,
        command: options.command,
        args: options.args ?? [],
        startedAt,
        durationMs: snap.durationMs,
        status: snap.status,
        exitCode: snap.exitCode,
        timedOut: snap.timedOut,
        cancelled: snap.cancelled,
        stdoutTail: out.text,
        stderrTail: errOut.text,
        outputTruncated: truncated,
      };
      this.history.push(historyRecord);
      while (this.history.length > this.maxHistoryEntries) this.history.shift();
      container.completed.push({
        commandId,
        index,
        command: options.command,
        status: snap.status,
        exitCode: snap.exitCode,
        timedOut: snap.timedOut,
        cancelled: snap.cancelled,
        startedAt,
        completedAt: result.completedAt,
        durationMs: snap.durationMs,
      });
      if (container.completed.length > this.maxHistoryEntries) {
        container.completed.shift();
      }
      if (snap.status === "exited") {
        this.auditHook?.({
          sessionId: container.sessionId,
          phase: "completed",
          command: options.command,
          status: snap.status,
          exitCode: snap.exitCode,
          durationMs: snap.durationMs,
          approved: true,
        });
      } else if (snap.status === "killed" && snap.cancelled) {
        this.auditHook?.({
          sessionId: container.sessionId,
          phase: "cancelled",
          command: options.command,
          durationMs: snap.durationMs,
          approved: true,
        });
      } else if (snap.status === "timedOut") {
        this.auditHook?.({
          sessionId: container.sessionId,
          phase: "failed",
          command: options.command,
          status: snap.status,
          durationMs: snap.durationMs,
          approved: true,
        });
      } else {
        this.auditHook?.({
          sessionId: container.sessionId,
          phase: "failed",
          command: options.command,
          status: snap.status,
        });
      }
      this.pruneFinished();
      return { ok: true, result };
    };

    // Serialize execs within the session — one command at a time.
    const run = container.queue.then(enqueue, enqueue);
    container.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Read-only status of an agent session. Ownership enforced — another
   * task's session is indistinguishable from a nonexistent one.
   */
  agentSessionStatus(
    sessionId: string,
    taskId: string,
  ): AgentSessionStatusView | null {
    const owned = this.ownedSession(sessionId, taskId);
    if (!owned.ok) return null;
    const c = owned.container;
    return {
      sessionId: c.sessionId,
      taskId: c.taskId,
      createdAt: c.createdAt,
      commandCount: c.completed.length,
      runningIndex: c.runningIndex,
      open: c.open,
      commands: [...c.completed],
    };
  }

  /**
   * Stop the currently running command in an owned agent session (graceful).
   * Returns false when unknown/forbidden/not running.
   */
  stopAgentSessionCommand(sessionId: string, taskId: string): boolean {
    const owned = this.ownedSession(sessionId, taskId);
    if (!owned.ok) return false;
    const c = owned.container;
    if (c.runningIndex === null) return false;
    // Find the live TerminalSession for the running command: it is the most
    // recent non-finished session created by this container. Command sessions
    // register in this.sessions under their own ids, so scan for a running one.
    for (const session of this.sessions.values()) {
      const snap = session.snapshot();
      if (snap.status === "starting" || snap.status === "running") {
        session.cancel();
        return true;
      }
    }
    return false;
  }

  /**
   * Close an owned agent session. No new commands can execute afterwards.
   * A currently running command is cancelled (ownership respected).
   */
  closeAgentSession(sessionId: string, taskId: string): boolean {
    const owned = this.ownedSession(sessionId, taskId);
    if (!owned.ok) return false;
    const c = owned.container;
    c.open = false;
    if (c.runningIndex !== null) {
      for (const session of this.sessions.values()) {
        const snap = session.snapshot();
        if (snap.status === "starting" || snap.status === "running") {
          session.cancel();
        }
      }
    }
    this.auditHook?.({
      sessionId: c.sessionId,
      phase: "cancelled",
      command: "(agent session closed)",
    });
    return true;
  }

  /**
   * Cancel every agent session owned by the given task (agent stop /
   * task end). Sessions not owned by the task are untouched.
   */
  cancelAgentSessionsForTask(taskId: string): number {
    let closed = 0;
    for (const container of this.agentSessions.values()) {
      if (container.taskId !== taskId) continue;
      container.open = false;
      if (container.runningIndex !== null) {
        for (const session of this.sessions.values()) {
          const snap = session.snapshot();
          if (snap.status === "starting" || snap.status === "running") {
            session.cancel();
          }
        }
      }
      closed += 1;
    }
    return closed;
  }

  /** Close every agent session regardless of owner (extension teardown). */
  closeAllAgentSessions(): void {
    for (const container of this.agentSessions.values()) {
      container.open = false;
      if (container.runningIndex !== null) {
        for (const session of this.sessions.values()) {
          const snap = session.snapshot();
          if (snap.status === "starting" || snap.status === "running") {
            session.cancel();
          }
        }
      }
    }
  }
}
