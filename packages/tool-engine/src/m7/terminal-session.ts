/**
 * @codepilot/tool-engine — M7 terminal sessions
 *
 * Long-lived process sessions on top of the controlled spawn primitives.
 * A session owns one background process with bounded, secret-redacted output
 * buffers, lifecycle status, graceful/forced termination and timeout.
 *
 * This is NOT a second execution framework: it reuses the same structured
 * argv spawn model as M3 (no shell string interpolation). Sessions are for
 * long-running interactive-ish processes (dev servers, watchers, agents).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { TerminalSequence, Utf8StreamDecoder } from "../m3/terminal-stream.js";
import type { TerminalStreamEvent } from "../m3/terminal-stream.js";

// ============================================================================
// Shell detection
// ============================================================================

export interface ShellDescriptor {
  /** Executable used to run a command string. */
  shell: string;
  /** argv prefix for `sh -c <cmd>` style invocation. */
  args: string[];
  /** Human-readable name for UI display. */
  name: string;
}

/**
 * Detect the platform default shell. Windows resolves COMSPEC (cmd.exe by
 * default); POSIX prefers $SHELL and falls back to /bin/sh.
 */
export function detectShell(
  platform: string = process.platform,
): ShellDescriptor {
  if (platform === "win32") {
    const comspec = process.env.COMSPEC ?? "cmd.exe";
    return { shell: comspec, args: ["/d", "/s", "/c"], name: "cmd" };
  }
  const shell = process.env.SHELL ?? "/bin/sh";
  const name = shell.includes("bash")
    ? "bash"
    : shell.includes("zsh")
      ? "zsh"
      : "sh";
  return { shell, args: ["-c"], name };
}

// ============================================================================
// Session types
// ============================================================================

export type TerminalSessionStatus =
  "starting" | "running" | "exited" | "killed" | "timedOut" | "error";

export interface TerminalSessionOptions {
  /** Executable to run (structured argv — no shell operators). */
  command: string;
  /** Structured argument array. */
  args?: string[];
  /** Raw command string fed to the shell via stdin (shell mode). */
  stdin?: string;
  /** Working directory (defaults to process cwd). */
  cwd?: string;
  /** Extra environment layered over the sanitized base env. */
  env?: Record<string, string>;
  /** Kill the session after this long (default 10 min; 0 disables). */
  timeoutMs?: number;
  /** Per-stream output buffer cap in bytes (default 1 MiB). */
  maxOutputBytes?: number;
  /** External cancellation signal. */
  signal?: AbortSignal;
  /**
   * Typed event listener registered BEFORE the process spawns, so
   * terminal.started and early output are never missed (post-start
   * subscriptions see only new events — no replay).
   */
  onEvent?: SessionEventListener;
}

export interface TerminalSessionSnapshot {
  readonly id: string;
  readonly status: TerminalSessionStatus;
  readonly pid: number | undefined;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly durationMs: number;
}

export type SessionOutputListener = (
  text: string,
  stream: "stdout" | "stderr",
) => void;

/**
 * Typed event listener for the shared `terminal.*` contract (m3/
 * terminal-stream). M7 sessions emit the SAME event shapes the agent
 * streaming path uses — there is no second protocol. Correlation fields
 * (executionId == session id, taskId, timestamp) are attached by the
 * manager's fan-out, not by the raw session.
 */
export type SessionEventListener = (event: TerminalStreamEvent) => void;

const DEFAULT_SESSION_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

// ============================================================================
// Terminal session
// ============================================================================

export class TerminalSession {
  readonly id: string;
  private readonly options: TerminalSessionOptions;
  private readonly maxOutputBytes: number;
  private child: ChildProcess | null = null;
  private status: TerminalSessionStatus = "starting";
  private exitCode: number | null = null;
  private timedOut = false;
  private cancelled = false;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private readonly startedAt = Date.now();
  private readonly listeners = new Set<SessionOutputListener>();
  private readonly eventListeners = new Set<SessionEventListener>();
  /** Monotonic per-session event sequence (shared terminal.* contract). */
  private readonly seq = new TerminalSequence();
  /** UTF-8-safe incremental decoders — one per stream. */
  private readonly decoders = {
    stdout: new Utf8StreamDecoder(),
    stderr: new Utf8StreamDecoder(),
  };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private waiters: Array<() => void> = [];
  private errorMessage: string | null = null;
  private disposed = false;
  private abortHandler: (() => void) | null = null;

  constructor(options: TerminalSessionOptions) {
    this.options = options;
    this.id = `ts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    // Pre-spawn subscription: the very first event is observable.
    if (options.onEvent) this.eventListeners.add(options.onEvent);
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  /** Spawn the session process. Throws when spawn fails. */
  start(): TerminalSession {
    const { command, args = [], cwd, env, timeoutMs, signal, stdin } = this.options;
    if (typeof command !== "string" || command.trim().length === 0) {
      throw new Error("TerminalSession.start: command is required");
    }

    const child = spawn(command, args, {
      cwd: cwd ?? process.cwd(),
      env: this.buildEnv(env),
      shell: process.platform === "win32" && /\\.(cmd|bat)$/i.test(command),
      windowsHide: true,
      // Shell mode keeps a stdin pipe open so the shell reads the script
      // from stdin (PowerShell source travels there — never the command line).
      ...(stdin !== undefined ? { stdio: ["pipe", "pipe", "pipe"] as const } : {}),
    });
    this.child = child;
    this.status = "running";

    // Shell contract: write the raw command to stdin, then end the pipe so
    // the child can never block waiting for input. EPIPE (early exit) is
    // swallowed — the close handler still reports the real outcome.
    if (stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {
        // Early exit — ignored; close carries the real status.
      });
      child.stdin.end(stdin, "utf8");
    }

    const wire = (
      stream: NodeJS.ReadableStream | null,
      which: "stdout" | "stderr",
    ): void => {
      stream?.on("data", (chunk: Buffer | string) => {
        // UTF-8-safe incremental decoding: a multi-byte character split
        // across chunks is buffered, not corrupted into U+FFFD (same as M3).
        const text = this.decoders[which].decode(chunk);
        if (text.length === 0) return;
        const buffer =
          which === "stdout" ? this.stdoutBuffer : this.stderrBuffer;
        if (buffer.length < this.maxOutputBytes) {
          const room = this.maxOutputBytes - buffer.length;
          const slice = text.slice(0, room);
          if (which === "stdout") this.stdoutBuffer += slice;
          else this.stderrBuffer += slice;
        }
        for (const listener of this.listeners) listener(text, which);
        // Typed fan-out on the shared terminal.* contract (live, unredacted —
        // redaction happens in snapshots/audit; the raw stream is session-scoped).
        this.emitEvent({
          type: which === "stdout" ? "terminal.stdout" : "terminal.stderr",
          seq: this.seq.next(),
          data: text,
          byteCount: Buffer.byteLength(text, "utf8"),
        });
      });
      stream?.on("error", (err: Error) => {
        this.emitEvent({
          type: "terminal.error",
          seq: this.seq.next(),
          message: `stream read error (${which}): ${err.message}`,
          phase: "stream",
        });
      });
    };
    wire(child.stdout, "stdout");
    wire(child.stderr, "stderr");

    // terminal.started is the first event (seq 1) — matches M3 semantics.
    this.emitEvent({
      type: "terminal.started",
      seq: this.seq.next(),
      command,
      pid: child.pid,
    });

    child.once("error", (err) => {
      this.status = "error";
      this.errorMessage = err.message;
      this.emitEvent({
        type: "terminal.error",
        seq: this.seq.next(),
        message: err.message,
        phase: "spawn",
      });
      this.finish();
    });
    child.once("close", (code, signal) => {
      this.exitCode = code;
      if (this.timedOut) this.status = "timedOut";
      else if (this.cancelled) this.status = "killed";
      else this.status = "exited";
      // Flush held-back partial multi-byte sequences at end-of-stream.
      for (const which of ["stdout", "stderr"] as const) {
        const tail = this.decoders[which].end();
        if (tail.length > 0) {
          const buffer =
            which === "stdout" ? this.stdoutBuffer : this.stderrBuffer;
          if (buffer.length < this.maxOutputBytes) {
            if (which === "stdout") this.stdoutBuffer += tail;
            else this.stderrBuffer += tail;
          }
        }
      }
      // Exactly one terminal-status event per session (same semantics as M3:
      // real exit code preserved for normal completion, cancellation/timeout
      // never recast as infrastructure errors).
      const durationMs = Date.now() - this.startedAt;
      if (this.timedOut) {
        this.emitEvent({
          type: "terminal.timeout",
          seq: this.seq.next(),
          timeoutMs: this.options.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
          durationMs,
        });
      } else if (this.cancelled) {
        this.emitEvent({
          type: "terminal.cancelled",
          seq: this.seq.next(),
          durationMs,
        });
      } else {
        this.emitEvent({
          type: "terminal.exit",
          seq: this.seq.next(),
          exitCode: code,
          signal,
          durationMs,
        });
      }
      this.finish();
    });

    const timeout = timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    if (timeout > 0) {
      this.timer = setTimeout(() => {
        this.timedOut = true;
        this.terminate("SIGTERM");
      }, timeout);
    }

    if (signal) {
      if (signal.aborted) {
        this.cancel();
      } else {
        this.abortHandler = () => this.cancel();
        signal.addEventListener("abort", this.abortHandler, { once: true });
      }
    }
    return this;
  }

  /**
   * Dispose the session: terminate the process, clear the timeout, release
   * the abort-signal listener, drop output listeners and resolve waiters.
   * Idempotent — safe to call multiple times and after cancel/kill/finish.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const sig = this.options.signal;
    if (sig && this.abortHandler) {
      try {
        sig.removeEventListener("abort", this.abortHandler);
      } catch {
        // best effort
      }
      this.abortHandler = null;
    }
    this.listeners.clear();
    this.eventListeners.clear();
    try {
      this.terminate("SIGKILL");
    } catch {
      // best effort
    }
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Number of active output listeners (lifecycle introspection for tests). */
  listenerCount(): number {
    return this.listeners.size;
  }

  /** True after dispose() (lifecycle introspection for tests). */
  isDisposed(): boolean {
    return this.disposed;
  }

  /** Wait until the session exits, is killed, or times out. */
  async wait(): Promise<TerminalSessionSnapshot> {
    if (this.status !== "running" && this.status !== "starting") {
      return this.snapshot();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return this.snapshot();
  }

  /** Graceful termination (SIGTERM / tree kill on Windows). */
  cancel(): void {
    this.cancelled = true;
    this.terminate("SIGTERM");
  }

  /** Forced termination (SIGKILL / tree kill on Windows). */
  kill(): void {
    this.cancelled = true;
    this.terminate("SIGKILL");
  }

  // ---------------------------------------------------------------------
  // Observation
  // ---------------------------------------------------------------------

  snapshot(): TerminalSessionSnapshot {
    return {
      id: this.id,
      status: this.status,
      pid: this.child?.pid,
      exitCode: this.exitCode,
      stdout: redact(this.stdoutBuffer),
      stderr: redact(this.stderrBuffer),
      timedOut: this.timedOut,
      cancelled: this.cancelled,
      durationMs: Date.now() - this.startedAt,
    };
  }

  onOutput(listener: SessionOutputListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Subscribe to the shared typed `terminal.*` events. Returns an
   * unsubscribe function. Listeners added AFTER start() receive only new
   * events (no replay) — callers wanting the retained history use snapshot().
   */
  onEvent(listener: SessionEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /** Emit one typed event to all subscribers. A failing listener never breaks the session. */
  private emitEvent(event: TerminalStreamEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // A failing sink must never break the execution pipeline.
      }
    }
  }

  get error(): string | null {
    return this.errorMessage;
  }

  // ---------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------

  private terminate(signal: "SIGTERM" | "SIGKILL"): void {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    if (process.platform === "win32") {
      // taskkill /T kills the whole process tree on Windows.
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      });
    } else {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  }

  private finish(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const sig = this.options.signal;
    if (sig && this.abortHandler) {
      try {
        sig.removeEventListener("abort", this.abortHandler);
      } catch {
        // best effort
      }
      this.abortHandler = null;
    }
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * Safe environment for child processes: a minimal base plus caller-supplied
   * additions. Secrets and unrelated host configuration do not propagate.
   */
  private buildEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
    const base: Record<string, string> = {};
    const passthrough = [
      "PATH",
      "PATHEXT",
      "HOME",
      "USERPROFILE",
      "TEMP",
      "TMP",
      "LANG",
      "SYSTEMROOT",
      "COMSPEC",
      "APPDATA",
      "LOCALAPPDATA",
    ];
    for (const key of passthrough) {
      const value = process.env[key];
      if (value !== undefined) base[key] = value;
    }
    return { ...base, ...extra };
  }
}

// ============================================================================
// Output redaction (kept local to avoid a dependency on the M3 audit logger)
// ============================================================================

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

function redact(content: string): string {
  let out = content;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}
