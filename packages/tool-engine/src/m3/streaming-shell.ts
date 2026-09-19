/**
 * @codepilot/tool-engine — streaming shell executor for agent terminal tools
 *
 * Host-side `bash` executor shaped as `(command, cwd, context) =>
 * Promise<string>` so the runtime can wrap it into the native `bash`
 * AgentTool. Execution itself runs through
 * the canonical `CommandExecutionService` (structured spawn — NOT a second
 * execution system): stdout/stderr chunks flow out live through the typed
 * `terminal.*` event sink while the returned promise still resolves to the
 * final combined output string the SDK contract requires.
 *
 * Security model (read carefully):
 * - This executor NEVER gates, approves, or validates. The M4 pipeline
 *   (dispatcher gate → RiskEngine → PolicyEngine → ApprovalManager →
 *   SecurityValidator) runs BEFORE the native dispatcher reaches this executor,
 *   exactly as for every other live tool. An unapproved call never arrives.
 * - Shell selection for string commands mirrors the platform defaults
 *   (powershell on Windows, bash on POSIX) so model-facing behavior —
 *   including the run_commands tool description — does not drift.
 * - The child environment is the inherited process environment (as in any
 *   developer terminal and as a plain shell executor provides), NOT the sanitized
 *   M3 base env: agent commands routinely depend on PATH additions,
 *   VIRTUAL_ENV, JAVA_HOME and friends. Secrets still never reach disk or
 *   audit because persistence and audit only ever see bounded, redacted
 *   summaries (see the redaction tests).
 *
 * Output contract (mirrors the plain-executor observable behavior):
 * - success (exit 0) → combined `stdout[\n[stderr]\nstderr]` string,
 *   middle-truncated past the char cap with the identical marker;
 * - non-zero exit → throws `Error("[Command exited with code N]\n…")`
 *   (surfaces as tool_failed, exactly like the SDK's CommandExitError);
 * - cancellation → throws `Error("Command cancelled")`;
 * - timeout → throws `Error("Command timed out after Nms")`;
 * - spawn failure → the service rejection propagates unchanged.
 */

import {
  CommandExecutionService,
  type CommandOutput,
} from "./command-execution.js";
import type {
  TerminalStreamEventWithCorrelation,
  TerminalStreamSink,
} from "./terminal-stream.js";
import { getDefaultShell, getShellInvocation } from "./shell-platform.js";

/** Combined-output cap in chars (matches the SDK executor default). */
export const STREAMING_SHELL_MAX_OUTPUT_CHARS = 48_000;

/**
 * Middle-truncation marker. Byte-identical in shape to the SDK executor's
 * marker so downstream snapshots/tests see no drift.
 */
export function truncateStreamingOutput(
  text: string,
  maxChars: number = STREAMING_SHELL_MAX_OUTPUT_CHARS,
): string {
  const total = text.length;
  if (total <= maxChars) return text;
  const head = Math.ceil(maxChars / 2);
  const tail = Math.max(1, maxChars - head);
  return (
    `${text.slice(0, head)}\n[... output truncated: ${total} chars total. ` +
    `Refine the command (grep, head, tail) to view the elided middle ...]\n` +
    text.slice(-tail)
  );
}

/** Minimal agent-tool context surface this executor actually reads. */
export interface StreamingShellContext {
  toolCallId?: string;
  sessionId?: string;
  signal?: AbortSignal;
}

/** Structured argv form (mirrors the SDK's StructuredCommandInput). */
export interface StreamingShellArgv {
  command: string;
  args?: string[];
}

export interface StreamingShellHooks {
  /**
   * Receives every typed `terminal.*` event while the process runs
   * (started → stdout/stderr chunks → exit/cancelled/timeout/error).
   * Never invoked after the returned promise settles.
   */
  onTerminalEvent?: TerminalStreamSink;
  /** Execution timeout in ms (default 30s — matches the SDK executor). */
  timeoutMs?: number;
  /** Combined-output char cap (default 48k — matches the SDK executor). */
  maxOutputChars?: number;
}

const DEFAULT_SHELL_TIMEOUT_MS = 30_000;

/**
 * Shell argv for a raw command string, using the SDK's own shell resolution
 * (`getDefaultShell`) and invocation builder (`getShellInvocation`) so the
 * syntax the model is told to use always matches what actually executes.
 * PowerShell source travels through Unicode-safe stdin (never the command
 * line), which also makes nested invocations (`powershell … "…"` authored
 * by the model) work verbatim instead of hanging on quote mangling.
 */
export function shellArgvForCommand(command: string): {
  command: string;
  args: string[];
  stdin?: string;
} {
  const shell = getDefaultShell(process.platform);
  const invocation = getShellInvocation(shell, command);
  return {
    command: invocation.command,
    args: invocation.args,
    ...(invocation.input !== undefined ? { stdin: invocation.input } : {}),
  };
}

/**
 * Combine retained stdout/stderr exactly like the SDK executor:
 * stdout first, stderr appended under an `[stderr]` banner when present.
 */
export function combineShellOutput(stdout: string, stderr: string): string {
  return stdout + (stderr.length > 0 ? `\n[stderr]\n${stderr}` : "");
}

/** Full host environment minus undefined values (SDK parity, see above). */
function inheritedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Create the streaming `bash` executor. Structurally a plain
 * `(command, cwd, context) => Promise<string>` function (keeps tool-engine
 * free of the runtime dependency): the runtime wraps it as the native
 * `bash` AgentTool.
 */
export function createStreamingShellExecutor(
  service: CommandExecutionService,
  hooks: StreamingShellHooks = {},
): (
  command: string | StreamingShellArgv,
  cwd: string,
  context: StreamingShellContext,
) => Promise<string> {
  const timeoutMs =
    typeof hooks.timeoutMs === "number" && hooks.timeoutMs > 0
      ? hooks.timeoutMs
      : DEFAULT_SHELL_TIMEOUT_MS;
  const maxChars =
    typeof hooks.maxOutputChars === "number" && hooks.maxOutputChars > 0
      ? hooks.maxOutputChars
      : STREAMING_SHELL_MAX_OUTPUT_CHARS;

  return async (
    command: string | StreamingShellArgv,
    cwd: string,
    context: StreamingShellContext,
  ): Promise<string> => {
    const toolCallId =
      typeof context?.toolCallId === "string" && context.toolCallId.length > 0
        ? context.toolCallId
        : `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Structured argv spawns directly (no shell); raw strings go through
    // the SDK shell invocation (stdin for PowerShell, -c for bash).
    const requested =
      typeof command === "string"
        ? shellArgvForCommand(command)
        : {
            command: command.command,
            args: Array.isArray(command.args) ? command.args : [],
          };
    const argv = {
      command: requested.command,
      args: requested.args,
      ...(requested.stdin !== undefined ? { stdin: requested.stdin } : {}),
    };
    let output: CommandOutput;
    try {
      output = await service.run(
        {
          command: argv.command,
          args: argv.args,
          cwd,
          timeoutMs,
          // Stdin payload (SDK shell contract): the shell reads the script
          // from stdin, so it must be fed AND ended here — otherwise the
          // child blocks in ReadToEnd forever.
          ...(argv.stdin !== undefined ? { stdin: argv.stdin } : {}),
          // Inherit the host environment wholesale (SDK parity — agent
          // commands depend on PATH additions, VIRTUAL_ENV, JAVA_HOME…).
          // service.run layers this over its sanitized base, so the result
          // is the full process environment, exactly like a developer
          // terminal and like the SDK executor this replaces.
          env: inheritedEnv(),
        },
        {
          signal: context?.signal,
          executionId: toolCallId,
          onEvent: (event: TerminalStreamEventWithCorrelation) => {
            try {
              hooks.onTerminalEvent?.(event);
            } catch {
              // A failing forwarder must never break execution.
            }
          },
        },
      );
    } catch (err) {
      // Spawn failure (ENOENT, EACCES, …): infrastructure error, propagates
      // unchanged so the caller maps it to tool_failed, as before.
      throw err instanceof Error ? err : new Error(String(err));
    }
    const combined = truncateStreamingOutput(
      combineShellOutput(output.stdout, output.stderr),
      maxChars,
    );
    if (output.cancelled) {
      throw new Error("Command cancelled");
    }
    if (output.timedOut) {
      throw new Error(`Command timed out after ${timeoutMs}ms`);
    }
    if (output.exitCode !== 0 && output.exitCode !== null) {
      throw new Error(
        combined.length > 0
          ? `[Command exited with code ${output.exitCode}]\n${combined}`
          : `[Command exited with code ${output.exitCode}]`,
      );
    }
    return combined;
  };
}
