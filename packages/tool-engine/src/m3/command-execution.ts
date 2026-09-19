/**
 * @codepilot/tool-engine — M3 controlled command execution
 *
 * Structured process spawning (command + args array — never an untrusted
 * shell string), stdout/stderr streaming, cancellation, timeout, exit codes
 * and PID tracking. A CommandExecutionPolicy decides allowed/denied/
 * requires_approval before anything is spawned.
 *
 * Platform notes:
 *   - Windows: .cmd/.bat files require the shell; we spawn via cmd.exe with
 *     /d /s /c and the args array intact (no user string concatenation).
 *   - POSIX: direct exec of the binary; shell scripts need an explicit
 *     interpreter, which keeps injection out of scope by construction.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  TerminalSequence,
  TerminalRetentionBuffer,
  Utf8StreamDecoder,
} from "./terminal-stream.js";
import type {
  TerminalStreamEvent,
  TerminalStreamSink,
  TerminalTruncation,
} from "./terminal-stream.js";

// ============================================================================
// Policy
// ============================================================================

export type CommandPolicyDecision = "allowed" | "denied" | "requires_approval";

export interface CommandExecutionPolicyConfig {
  /** Commands that are always allowed without approval. */
  allowedPrefixes?: string[];
  /** Commands that are always denied (hard block). */
  deniedCommands?: string[];
  /** When true, everything not explicitly allowed requires approval. */
  requireApprovalByDefault?: boolean;
}

export const DANGEROUS_COMMANDS = [
  "rm -rf /",
  "rm -rf ~",
  "del /f /s /q c:\\",
  "rd /s /q c:\\",
  "format c:",
  "mkfs",
  "dd if=/dev/zero",
  ":(){ :|:& };:",
  "shutdown",
  "reboot",
  "sudo rm",
] as const;

export class CommandExecutionPolicy {
  private readonly allowedPrefixes: string[];
  private readonly deniedCommands: string[];
  private readonly requireApprovalByDefault: boolean;

  constructor(config: CommandExecutionPolicyConfig = {}) {
    this.allowedPrefixes = (
      config.allowedPrefixes ?? [
        "ls",
        "dir",
        "cat",
        "head",
        "tail",
        "wc",
        "find",
        "grep",
        "rg",
        "git status",
        "git diff",
        "git log",
        "git show",
        "git branch",
        "node --version",
        "npm --version",
        "pnpm --version",
        "python --version",
        "echo",
        "pwd",
        "whoami",
        "which",
        "where",
      ]
    ).map((c) => c.toLowerCase());
    this.deniedCommands = (
      config.deniedCommands ?? [...DANGEROUS_COMMANDS]
    ).map((c) => c.toLowerCase());
    this.requireApprovalByDefault = config.requireApprovalByDefault ?? true;
  }

  /** Decide for a command line (command + args joined for matching only). */
  decide(command: string, args: string[]): CommandPolicyDecision {
    const full = `${command} ${args.join(" ")}`.trim().toLowerCase();
    for (const denied of this.deniedCommands) {
      if (full === denied || full.startsWith(denied)) return "denied";
    }
    for (const allowed of this.allowedPrefixes) {
      if (full.startsWith(allowed)) return "allowed";
    }
    return this.requireApprovalByDefault ? "requires_approval" : "allowed";
  }
}

// ============================================================================
// Execution service
// ============================================================================

export interface CommandRequest {
  /** Executable to run (no shell operators). */
  command: string;
  /** Structured argument array — never concatenated into a shell string. */
  args?: string[];
  /** Working directory; defaults to the caller-provided workspace root. */
  cwd?: string;
  /** Additional environment variables layered over a sanitized base env. */
  env?: Record<string, string>;
  /** Kill the process after this long (default 120s). */
  timeoutMs?: number;
  /**
   * Text written to the child stdin (then stdin is ended). Used by the
   * SDK-compatible shell invocation: PowerShell source travels through
   * Unicode-safe stdin instead of the command line, so quoting can never
   * mangle it and non-interactive commands cannot hang waiting for input.
   */
  stdin?: string;
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  pid: number | undefined;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  /** Phase 3 — present only when a stream exceeded the retention cap. */
  truncation?: CommandOutputTruncation;
  /** Phase 3 — present only when a stdout/stderr read failed mid-stream. */
  streamError?: string;
}

export type CommandStreamListener = (
  chunk: string,
  stream: "stdout" | "stderr",
) => void;

/**
 * Phase 3 — truncation metadata attached to a command result when either
 * stream exceeded the retention cap. Absent when nothing was dropped, so
 * existing consumers see an identical shape.
 */
export interface CommandOutputTruncation {
  stdout?: TerminalTruncation;
  stderr?: TerminalTruncation;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
/** Max buffered output per stream (1 MB) — protects memory on chatty builds. */
const MAX_BUFFER_BYTES = 1_000_000;

/**
 * Controlled command execution. Commands run via structured spawn with an
 * args array; on Windows shell-requiring extensions (.cmd/.bat) spawn through
 * the shell with `args` passed intact. Environment is filtered to a safe base
 * set (PATH, HOME/USERPROFILE, TEMP, TMP, LANG, plus explicit caller
 * additions) so secrets and unrelated machine configuration never leak into
 * child processes.
 */
export class CommandExecutionService {
  private readonly running = new Map<
    number,
    { process: ChildProcess; cancel: () => void }
  >();
  private seq = 0;

  async run(
    request: CommandRequest,
    opts: {
      signal?: AbortSignal;
      policy?: CommandExecutionPolicy;
      /** Legacy per-chunk listener — kept for backward compatibility. */
      onStream?: CommandStreamListener;
      /**
       * Phase 3 — typed terminal stream sink. Receives `terminal.*` events
       * with monotonic per-execution sequence numbers while the process is
       * still running. Never invoked after the single terminal-status event.
       */
      onEvent?: TerminalStreamSink;
      /** Correlation for typed events. */
      taskId?: string;
      /** Execution correlation (defaults to a generated id). */
      executionId?: string;
      /** Retention cap per stream in bytes (default 1 MB). */
      maxOutputBytes?: number;
    } = {},
  ): Promise<CommandOutput> {
    const { command, args = [], env, timeoutMs } = request;
    if (typeof command !== "string" || command.trim().length === 0) {
      throw new Error("CommandExecutionService.run: command is required");
    }

    // Cancellation before process start: nothing spawned, nothing to clean up.
    if (opts.signal?.aborted) {
      return {
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        pid: undefined,
        timedOut: false,
        cancelled: true,
        durationMs: 0,
      };
    }

    const startedAt = Date.now();
    const cwd = request.cwd ?? process.cwd();
    const timeout =
      typeof timeoutMs === "number" && timeoutMs > 0
        ? timeoutMs
        : DEFAULT_COMMAND_TIMEOUT_MS;

    const execId = ++this.seq;
    const executionId = opts.executionId ?? `cmd-${execId}-${startedAt}`;
    const taskId = opts.taskId;

    // Per-execution streaming state: monotonic seq, UTF-8-safe decoders and
    // bounded head+tail retention (memory never grows past maxOutputBytes).
    const seq = new TerminalSequence();
    const maxBytes = opts.maxOutputBytes ?? MAX_BUFFER_BYTES;
    const retention = {
      stdout: new TerminalRetentionBuffer(maxBytes),
      stderr: new TerminalRetentionBuffer(maxBytes),
    };
    const decoders = {
      stdout: new Utf8StreamDecoder(),
      stderr: new Utf8StreamDecoder(),
    };

    const emit = (event: TerminalStreamEvent): void => {
      try {
        opts.onEvent?.({
          ...event,
          ...(taskId !== undefined ? { taskId } : {}),
          executionId,
          timestamp: Date.now(),
        });
      } catch {
        // A failing sink must never break the execution pipeline.
      }
    };

    let timedOut = false;
    let externallyCancelled = false;
    let spawnFailed = false;
    let streamError: string | undefined;

    const child = spawn(command, args, {
      cwd,
      env: this.buildEnv(env),
      // Windows: required for .cmd/.bat shims (npm/pnpm/etc.).
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
      windowsHide: true,
    });

    // terminal.started is the first event (seq 1) for every execution.
    emit({
      type: "terminal.started",
      seq: seq.next(),
      command,
      pid: child.pid,
    });

    const killProcess = (): void => {
      if (child.pid === undefined || child.exitCode !== null) return;
      if (process.platform === "win32") {
        // taskkill /T kills the whole child tree on Windows.
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
        });
      } else {
        child.kill("SIGTERM");
      }
    };

    this.running.set(execId, {
      process: child,
      // Idempotent: repeated cancellation never re-kills an already-dead
      // process and never produces duplicate cancellation effects.
      cancel: () => {
        if (externallyCancelled) return;
        externallyCancelled = true;
        killProcess();
      },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcess();
    }, timeout);

    const cleanup = (): void => {
      clearTimeout(timer);
      this.running.delete(execId);
    };

    opts.signal?.addEventListener(
      "abort",
      () => {
        if (externallyCancelled) return;
        externallyCancelled = true;
        killProcess();
      },
      { once: true },
    );

    // Stream wiring: UTF-8-safe incremental decode, bounded retention and a
    // typed event per chunk. Output events fire while the process runs —
    // nothing waits for completion.
    const wire = (
      stream: NodeJS.ReadableStream | null,
      which: "stdout" | "stderr",
    ): void => {
      stream?.on("data", (chunk: Buffer | string) => {
        // Multi-byte characters split across chunks are buffered by the
        // stream decoder instead of being corrupted per chunk.
        const text = decoders[which].decode(chunk);
        retention[which].append(chunk);
        opts.onStream?.(text, which);
        emit({
          type: which === "stdout" ? "terminal.stdout" : "terminal.stderr",
          seq: seq.next(),
          data: text,
          byteCount:
            typeof chunk === "string"
              ? Buffer.byteLength(chunk, "utf8")
              : chunk.length,
        });
      });
      stream?.on("error", (err: Error) => {
        streamError = `${which}: ${err.message}`;
        emit({
          type: "terminal.error",
          seq: seq.next(),
          message: `stream read error (${which}): ${err.message}`,
          phase: "stream",
        });
      });
    };
    wire(child.stdout, "stdout");
    wire(child.stderr, "stderr");

    // Stdin payload (SDK shell-invocation contract): written verbatim, then
    // stdin is ended so the child can never block waiting for input. Errors
    // (early exit → EPIPE) are swallowed — process exit still resolves below.
    if (request.stdin !== undefined && child.stdin) {
      try {
        child.stdin.on("error", () => {
          // Child exited before reading: exit/close handlers own the outcome.
        });
        child.stdin.write(request.stdin);
        child.stdin.end();
      } catch {
        // Best effort; exit/close handlers own the outcome.
      }
    }

    return new Promise<CommandOutput>((resolve, reject) => {
      child.once("error", (err) => {
        cleanup();
        if (!spawnFailed) {
          spawnFailed = true;
          // Spawn failure (ENOENT, EACCES, ...) is infrastructure — never a
          // non-zero exit code.
          emit({
            type: "terminal.error",
            seq: seq.next(),
            message: err.message,
            phase: "spawn",
          });
        }
        reject(err);
      });
      child.once("close", (code, signal) => {
        cleanup();
        // Flush any held-back partial multi-byte sequence at end-of-stream.
        for (const which of ["stdout", "stderr"] as const) {
          const tail = decoders[which].end();
          if (tail.length > 0) {
            retention[which].append(tail);
            opts.onStream?.(tail, which);
            emit({
              type: which === "stdout" ? "terminal.stdout" : "terminal.stderr",
              seq: seq.next(),
              data: tail,
              byteCount: Buffer.byteLength(tail, "utf8"),
            });
          }
        }
        const durationMs = Date.now() - startedAt;
        // Exactly one terminal-status event per execution; the real exit code
        // is preserved for normal completion (never recast as an error).
        if (externallyCancelled) {
          emit({ type: "terminal.cancelled", seq: seq.next(), durationMs });
        } else if (timedOut) {
          emit({
            type: "terminal.timeout",
            seq: seq.next(),
            timeoutMs: timeout,
            durationMs,
          });
        } else {
          emit({
            type: "terminal.exit",
            seq: seq.next(),
            exitCode: code,
            signal,
            durationMs,
          });
        }
        const out = retention.stdout.snapshot();
        const errOut = retention.stderr.snapshot();
        const truncation: CommandOutputTruncation | undefined =
          out.truncation || errOut.truncation
            ? {
                ...(out.truncation ? { stdout: out.truncation } : {}),
                ...(errOut.truncation ? { stderr: errOut.truncation } : {}),
              }
            : undefined;
        resolve({
          stdout: out.text,
          stderr: errOut.text,
          exitCode: code,
          signal,
          pid: child.pid,
          timedOut,
          cancelled: externallyCancelled,
          durationMs,
          ...(truncation ? { truncation } : {}),
          ...(streamError ? { streamError } : {}),
        });
      });
    });
  }

  /** Best-effort kill of a running execution by its sequence id. */
  cancel(execId: number): boolean {
    const entry = this.running.get(execId);
    if (!entry) return false;
    entry.cancel();
    return true;
  }

  /** All currently running executions' PIDs. */
  runningPids(): number[] {
    return [...this.running.values()]
      .map((r) => r.process.pid)
      .filter((pid): pid is number => pid !== undefined);
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
