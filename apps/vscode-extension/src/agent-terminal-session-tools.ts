/**
 * Agent-initiated tracked terminal sessions — AgentTool wrappers for the
 * native runtime extraTools surface (same pattern as MCP/browser tools).
 *
 * Execution path (identical security semantics to every other live tool):
 *
 *   native dispatcher gate (toolCallId-scoped)
 *     → requestApprovalViaM4 → LiveToolPermissionBridge.evaluateLiveTool
 *     → RiskEngine → PolicyEngine → ApprovalManager → SecurityValidator
 *     → (approved) stageDecisionToken → tool.execute()
 *     → TerminalSessionManager.startAgentSession / execInSession / …
 *     → TerminalSession (REAL process, REAL streaming on terminal.*)
 *     → bounded result to the model
 *
 * There is NO second execution engine: every command runs as its own
 * TerminalSession inside the manager. There is NO session-level permission:
 * M4 runs in the dispatcher gate for EVERY tool call, and exec consumes a single-use
 * decision token bound to the exact command text (fresh deny-closed bridge
 * evaluation when no token was staged). Session ownership (taskId =
 * conversationId) is enforced host-side in the manager — another task's
 * session is indistinguishable from a nonexistent one.
 *
 * Shell state: each command is an independent process. cwd/env are session
 * constants, NOT inherited from previous commands — `cd` does not persist.
 * This is documented, deliberate behavior (no fake persistence).
 *
 * Errors are RETURNED as structured `{ ok:false, error, code }` values —
 * never thrown past the wrapper — so a denied/failed command can never
 * crash the extension host and the model always receives a deterministic,
 * bounded result.
 */

import type { AgentTool } from "@codepilot/agent-runtime";
import type { LiveToolPermissionBridge } from "@codepilot/tool-engine";
import type {
  AgentSessionCommandResult,
  TerminalSessionManager,
} from "./terminal-session-manager";

/** Maximum chars of command text accepted. */
const MAX_COMMAND_LEN = 4096;
/** Maximum chars of stdout/stderr returned to the model per command. */
const MAX_RESULT_STREAM_CHARS = 8_000;
/** Tool timeout handed to the native dispatcher (per call; exec commands may stream long). */
const TOOL_TIMEOUT_MS = 15 * 60_000;

/** Structured failure codes surfaced to the model. */
type FailureCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "M4_DENIED"
  | "CLOSED"
  | "INVALID"
  | "LIMIT"
  | "INTERNAL";

type Failure = { ok: false; error: string; code: FailureCode };

function fail(error: string, code: FailureCode): Failure {
  return { ok: false, error, code };
}

/** Bound a result stream for the model context (tails, explicit truncation). */
function boundForModel(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_RESULT_STREAM_CHARS) {
    return { text, truncated: false };
  }
  return { text: text.slice(-MAX_RESULT_STREAM_CHARS), truncated: true };
}

/** Shape a command result for the model. Bounded by construction. */
function toModelResult(r: AgentSessionCommandResult) {
  const out = boundForModel(r.stdout ?? "");
  const errOut = boundForModel(r.stderr ?? "");
  return {
    ok: true as const,
    sessionId: r.sessionId,
    commandId: r.commandId,
    index: r.index,
    status: r.status,
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    cancelled: r.cancelled,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    durationMs: r.durationMs,
    stdout: out.text,
    stderr: errOut.text,
    truncated: r.truncated || out.truncated || errOut.truncated,
    ...(r.error ? { error: r.error } : {}),
  };
}

export interface AgentTerminalSessionToolConfig {
  manager: TerminalSessionManager;
}

/**
 * Build the agent-facing tracked terminal session tools.
 *
 * Ownership context: AgentToolContext carries `conversationId` (stable per
 * agent session) — that is the owning taskId enforced by the manager. A
 * missing identity fails closed.
 */
export function createAgentTerminalSessionTools(
  config: AgentTerminalSessionToolConfig,
): AgentTool[] {
  const { manager } = config;

  const callerTaskId = (ctx: {
    conversationId?: string;
    agentId?: string;
    sessionId?: string;
  }): string | null => {
    const id = ctx.conversationId ?? ctx.agentId ?? ctx.sessionId;
    return typeof id === "string" && id.length > 0 ? id : null;
  };

  // ---- terminal_session_start ------------------------------------------------

  const sessionStart: AgentTool = {
    name: "terminal_session_start",
    description:
      "Create a tracked terminal session for running MULTIPLE commands " +
      "with live streaming output. Returns a sessionId. No process starts " +
      "and nothing is approved yet — each command is permission-checked " +
      "when executed. Working directory is fixed at creation (defaults to " +
      "the workspace).",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description:
            "Optional working directory for all commands in this session " +
            "(relative to the workspace).",
        },
      },
      additionalProperties: false,
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    execute: async (input, ctx) => {
      const taskId = callerTaskId(ctx);
      if (!taskId) {
        return fail(
          "No task identity available — session cannot be created",
          "FORBIDDEN",
        );
      }
      const cwdRaw =
        input && typeof (input as Record<string, unknown>).cwd === "string"
          ? ((input as Record<string, unknown>).cwd as string).trim()
          : undefined;
      const created = manager.startAgentSession({
        taskId,
        ...(cwdRaw ? { cwd: cwdRaw } : {}),
      });
      if (!created.ok) {
        return fail(created.error, "LIMIT");
      }
      return {
        ok: true as const,
        sessionId: created.sessionId,
        taskId: created.taskId,
        createdAt: created.createdAt,
        note: "Use terminal_session_exec with this sessionId to run commands.",
      };
    },
  };

  // ---- terminal_session_exec ---------------------------------------------

  const sessionExec: AgentTool = {
    name: "terminal_session_exec",
    description:
      "Execute ONE command inside a tracked terminal session created by " +
      "terminal_session_start. Output streams live to the terminal UI " +
      "while the command runs. Returns the final bounded result (status, " +
      "exit code, stdout/stderr tails). Each command is independently " +
      "permission-checked — approval of a previous command does NOT carry " +
      "over. Commands run sequentially per session; each is a fresh " +
      "process, so `cd`/exports do not persist between commands.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Session id from terminal_session_start.",
        },
        command: {
          type: "string",
          description: "The command to run (shell string). Max 4096 chars.",
        },
        timeoutMs: {
          type: "number",
          description:
            "Optional per-command timeout in ms (default 10 min, capped at 60 min).",
        },
      },
      required: ["sessionId", "command"],
      additionalProperties: false,
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    execute: async (input, ctx) => {
      const taskId = callerTaskId(ctx);
      if (!taskId) {
        return fail(
          "No task identity available — command cannot run",
          "FORBIDDEN",
        );
      }
      const rec = (input ?? {}) as Record<string, unknown>;
      const sessionId = rec.sessionId;
      if (
        typeof sessionId !== "string" ||
        sessionId.length === 0 ||
        sessionId.length > 256
      ) {
        return fail("sessionId is required (string, max 256 chars)", "INVALID");
      }
      const command = rec.command;
      if (typeof command !== "string" || command.trim().length === 0) {
        return fail("command is required", "INVALID");
      }
      if (command.length > MAX_COMMAND_LEN) {
        return fail(`command exceeds ${MAX_COMMAND_LEN} characters`, "INVALID");
      }
      const timeoutMs =
        typeof rec.timeoutMs === "number" &&
        Number.isFinite(rec.timeoutMs) &&
        rec.timeoutMs > 0
          ? rec.timeoutMs
          : undefined;
      try {
        const exec = await manager.execInSession(
          { sessionId, taskId, command, timeoutMs, signal: ctx.signal },
          // Fallback bridge evaluation — used only when beforeTool did not
          // stage a decision token for this exact command. Deny-closed.
          getFallbackBridge(),
        );
        if (!exec.ok) {
          const code: FailureCode =
            exec.code === "M4_DENIED"
              ? "M4_DENIED"
              : exec.code === "NOT_FOUND"
                ? "NOT_FOUND"
                : exec.code === "FORBIDDEN"
                  ? "FORBIDDEN"
                  : exec.code === "CLOSED"
                    ? "CLOSED"
                    : exec.code === "LIMIT" || exec.code === "BUSY"
                      ? "LIMIT"
                      : "INVALID";
          return fail(exec.error, code);
        }
        return toModelResult(exec.result);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e), "INTERNAL");
      }
    },
  };

  // ---- terminal_session_status -------------------------------------------

  const sessionStatus: AgentTool = {
    name: "terminal_session_status",
    description:
      "Query the state of a tracked terminal session you own: whether it " +
      "is open, which command is running, and a bounded history of " +
      "completed commands (status, exit code, duration).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Session id from terminal_session_start.",
        },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    execute: async (input, ctx) => {
      const taskId = callerTaskId(ctx);
      if (!taskId) {
        return fail("No task identity available", "FORBIDDEN");
      }
      const rec = (input ?? {}) as Record<string, unknown>;
      const sessionId = rec.sessionId;
      if (
        typeof sessionId !== "string" ||
        sessionId.length === 0 ||
        sessionId.length > 256
      ) {
        return fail("sessionId is required", "INVALID");
      }
      const view = manager.agentSessionStatus(sessionId, taskId);
      if (!view) {
        return fail("unknown session (or not owned by this task)", "NOT_FOUND");
      }
      return { ok: true as const, ...view };
    },
  };

  // ---- terminal_session_stop ---------------------------------------------

  const sessionStop: AgentTool = {
    name: "terminal_session_stop",
    description:
      "Gracefully stop the currently running command in a tracked " +
      "terminal session you own. The session stays open — you can run " +
      "another command afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Session id from terminal_session_start.",
        },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    execute: async (input, ctx) => {
      const taskId = callerTaskId(ctx);
      if (!taskId) {
        return fail("No task identity available", "FORBIDDEN");
      }
      const rec = (input ?? {}) as Record<string, unknown>;
      const sessionId = rec.sessionId;
      if (
        typeof sessionId !== "string" ||
        sessionId.length === 0 ||
        sessionId.length > 256
      ) {
        return fail("sessionId is required", "INVALID");
      }
      const stopped = manager.stopAgentSessionCommand(sessionId, taskId);
      if (!stopped) {
        return fail(
          "unknown session, not owned by this task, or no command running",
          "NOT_FOUND",
        );
      }
      return { ok: true as const, sessionId, stopped: true };
    },
  };

  // ---- terminal_session_close --------------------------------------------

  const sessionClose: AgentTool = {
    name: "terminal_session_close",
    description:
      "Close a tracked terminal session you own. Any running command is " +
      "stopped; no further commands can execute in this session. Use this " +
      "when you are done with the session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Session id from terminal_session_start.",
        },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    execute: async (input, ctx) => {
      const taskId = callerTaskId(ctx);
      if (!taskId) {
        return fail("No task identity available", "FORBIDDEN");
      }
      const rec = (input ?? {}) as Record<string, unknown>;
      const sessionId = rec.sessionId;
      if (
        typeof sessionId !== "string" ||
        sessionId.length === 0 ||
        sessionId.length > 256
      ) {
        return fail("sessionId is required", "INVALID");
      }
      const closed = manager.closeAgentSession(sessionId, taskId);
      if (!closed) {
        return fail("unknown session or not owned by this task", "NOT_FOUND");
      }
      return { ok: true as const, sessionId, closed: true };
    },
  };

  return [sessionStart, sessionExec, sessionStatus, sessionStop, sessionClose];
}

/**
 * Fallback bridge resolution for exec when no beforeTool decision token was
 * staged (e.g. direct tool execution outside the agent loop). The extension
 * wires the real bridge at activation; with no provider the exec tool
 * refuses to run (deny-closed).
 */
let fallbackBridgeProvider: (() => LiveToolPermissionBridge) | null = null;

export function setAgentSessionFallbackBridge(
  provider: () => LiveToolPermissionBridge,
): void {
  fallbackBridgeProvider = provider;
}

function getFallbackBridge(): LiveToolPermissionBridge {
  if (!fallbackBridgeProvider) {
    throw new Error("Permission pipeline unavailable — command cannot run");
  }
  return fallbackBridgeProvider();
}
