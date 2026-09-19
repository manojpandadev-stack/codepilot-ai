/**
 * @codepilot/tool-engine — M3 built-in command tools
 *
 * execute_command · terminal_output · kill_process
 *
 * execute_command uses the controlled CommandExecutionService (structured
 * spawn, no shell string concatenation). A CommandExecutionPolicy hard-blocks
 * dangerous commands; anything not explicitly allowed requires approval, which
 * is surfaced through the host approval channel on top of the tool-level
 * permission gate. Command args are ALWAYS passed as an argv array, never
 * interpolated into a shell line.
 */

import type { ToolContext, ToolDefinition } from "../types.js";
import { toolError, isAbortLike } from "../types.js";
import type { WorkspaceBoundary } from "../workspace-boundary.js";
import type {
  CommandExecutionService,
  CommandExecutionPolicy,
} from "../command-execution.js";
import { redactSecrets } from "../audit-logger.js";

export const DEFAULT_COMMAND_TIMEOUT_MS = 300_000; // 5 min
export const MAX_COMMAND_TIMEOUT_MS = 10 * 60_000;
export const MAX_ARGS_PER_COMMAND = 64;
export const MAX_COMMAND_LEN = 2_048;
export const COMMAND_OUTPUT_CAP = 65_536; // per-stream cap stored for the agent

// ============================================================================
// Terminal store (bounded, secret-redacted)
// ============================================================================

export interface TerminalRecord {
  executionId: string;
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  cancelled: boolean;
  timedOut: boolean;
  durationMs: number;
  at: number;
}

export class TerminalStore {
  private readonly records: TerminalRecord[] = [];
  constructor(private readonly limit: number = 100) {}

  push(record: TerminalRecord): void {
    this.records.push(sanitizeRecord(record));
    if (this.records.length > this.limit) {
      this.records.splice(0, this.records.length - this.limit);
    }
  }

  recent(count = 20): TerminalRecord[] {
    return this.records.slice(-count);
  }

  forExecution(executionId: string): TerminalRecord | null {
    return this.records.find((r) => r.executionId === executionId) ?? null;
  }

  clear(): void {
    this.records.length = 0;
  }

  size(): number {
    return this.records.length;
  }
}

function sanitizeRecord(record: TerminalRecord): TerminalRecord {
  return {
    ...record,
    command: redactSecrets(record.command),
    args: record.args.map((a) => redactSecrets(a)),
    stdout: redactSecrets(record.stdout.slice(0, COMMAND_OUTPUT_CAP)),
    stderr: redactSecrets(record.stderr.slice(0, COMMAND_OUTPUT_CAP)),
  };
}

function checkAborted(ctx: ToolContext): void {
  if (ctx.signal.aborted) {
    throw toolError("CANCELLED", "Cancelled", ctx.executionId, {
      recoverable: false,
    });
  }
}

function displayCommand(command: string, args: string[]): string {
  return redactSecrets([command, ...args].join(" "));
}

// ============================================================================
// execute_command
// ============================================================================

export interface ExecuteCommandInput {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export function createExecuteCommandTool(
  boundary: WorkspaceBoundary,
  service: CommandExecutionService,
  policy: CommandExecutionPolicy,
  store: TerminalStore,
): ToolDefinition<ExecuteCommandInput, unknown> {
  return {
    id: "execute_command",
    name: "Execute Command",
    description:
      "Run a shell command in the workspace via a structured argv. The policy blocks destructive commands; other commands require approval.",
    category: "command",
    version: "1.0.0",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Executable to run (e.g. npm, node, git)",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Arguments passed verbatim (never shell-interpolated)",
        },
        cwd: {
          type: "string",
          description: "Working directory (default workspace root)",
        },
        timeoutMs: {
          type: "number",
          description: "Timeout in ms (default 300000, max 600000)",
        },
        env: {
          type: "object",
          description: "Additional environment variables",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        exitCode: { type: "number" },
        stdout: { type: "string" },
        stderr: { type: "string" },
        durationMs: { type: "number" },
        pid: { type: "number" },
      },
      required: ["command", "exitCode", "stdout", "stderr", "durationMs"],
    },
    capabilities: ["cancellable", "streaming"],
    permission: {
      level: "execute",
      requiresApproval: true,
      rationale: "Execute a shell command in the workspace",
    },
    idempotent: false,
    async execute(input, ctx): Promise<unknown> {
      checkAborted(ctx);
      const command = input.command;
      if (typeof command !== "string" || command.trim().length === 0) {
        throw toolError(
          "VALIDATION",
          "command must be a non-empty string",
          ctx.executionId,
          {
            recoverable: false,
          },
        );
      }
      if (command.length > MAX_COMMAND_LEN) {
        throw toolError(
          "VALIDATION",
          `command exceeds ${MAX_COMMAND_LEN} characters`,
          ctx.executionId,
          { recoverable: false },
        );
      }
      const args = Array.isArray(input.args)
        ? input.args.filter((a): a is string => typeof a === "string")
        : [];
      if (args.length > MAX_ARGS_PER_COMMAND) {
        throw toolError(
          "VALIDATION",
          `args exceeds ${MAX_ARGS_PER_COMMAND} entries`,
          ctx.executionId,
          { recoverable: false },
        );
      }

      // Working directory must stay inside the workspace boundary.
      let cwd = boundary.root;
      if (input.cwd !== undefined) {
        if (typeof input.cwd !== "string" || input.cwd.trim().length === 0) {
          throw toolError(
            "VALIDATION",
            "cwd must be a non-empty string",
            ctx.executionId,
            {
              recoverable: false,
            },
          );
        }
        const res = boundary.resolve(input.cwd, ctx.executionId, true);
        if (!res.ok) throw res.error;
        cwd = res.absolutePath;
      }

      // Command-level policy: hard-block dangerous commands; require explicit
      // approval for anything not on the allow list (in addition to the
      // tool-level permission gate the executor already applied).
      const decision = policy.decide(command, args);
      if (decision === "denied") {
        throw toolError(
          "PERMISSION_DENIED",
          `Command is blocked by policy: ${redactSecrets(command)}`,
          ctx.executionId,
          { recoverable: false },
        );
      }
      if (decision === "requires_approval") {
        if (!ctx.requestApproval) {
          throw toolError(
            "UNSUPPORTED",
            "Command requires approval but no approval channel is available",
            ctx.executionId,
            { recoverable: false },
          );
        }
        const approval = await ctx.requestApproval({
          toolId: "execute_command",
          executionId: ctx.executionId,
          summary: `Approve command: ${displayCommand(command, args)}`,
        });
        if (ctx.signal.aborted) {
          throw toolError(
            "CANCELLED",
            "Cancelled while awaiting command approval",
            ctx.executionId,
            { recoverable: false },
          );
        }
        if (!approval.approved) {
          throw toolError(
            "PERMISSION_DENIED",
            `Command denied by user: ${displayCommand(command, args)}`,
            ctx.executionId,
            { recoverable: false },
          );
        }
      }

      const timeoutMs =
        typeof input.timeoutMs === "number" && input.timeoutMs > 0
          ? Math.min(input.timeoutMs, MAX_COMMAND_TIMEOUT_MS)
          : DEFAULT_COMMAND_TIMEOUT_MS;

      const startedAt = Date.now();
      const output = await service.run(
        { command, args, cwd, env: input.env, timeoutMs },
        {
          signal: ctx.signal,
          onStream: (text) => {
            const trimmed = text.trimEnd();
            if (trimmed.length > 0)
              ctx.progress({ message: trimmed.slice(-200) });
          },
        },
      );
      const durationMs = Date.now() - startedAt;

      store.push({
        executionId: ctx.executionId,
        command,
        args,
        exitCode: output.exitCode,
        stdout: output.stdout,
        stderr: output.stderr,
        cancelled: output.cancelled,
        timedOut: output.timedOut,
        durationMs,
        at: Date.now(),
      });

      ctx.progress({
        message: `Command finished (exit ${output.exitCode ?? "?"}) in ${durationMs}ms`,
      });
      if (output.cancelled) {
        throw toolError("CANCELLED", "Command cancelled", ctx.executionId, {
          recoverable: false,
        });
      }
      if (output.timedOut) {
        throw toolError(
          "TIMEOUT",
          `Command timed out after ${timeoutMs}ms: ${displayCommand(command, args)}`,
          ctx.executionId,
          { retryable: true },
        );
      }
      if (output.exitCode !== 0) {
        throw toolError(
          "COMMAND_FAILED",
          `Command exited ${output.exitCode}: ${displayCommand(command, args)} — ${redactSecrets(
            (output.stderr || output.stdout).slice(0, 1000),
          ).trim()}`,
          ctx.executionId,
          { recoverable: true, cause: output },
        );
      }
      return {
        command: redactSecrets(command),
        args: args.map((a) => redactSecrets(a)),
        exitCode: output.exitCode,
        stdout: output.stdout.slice(0, COMMAND_OUTPUT_CAP),
        stderr: output.stderr.slice(0, COMMAND_OUTPUT_CAP),
        durationMs,
        pid: output.pid,
      };
    },
  };
}

// ============================================================================
// terminal_output
// ============================================================================

export function createTerminalOutputTool(
  store: TerminalStore,
): ToolDefinition<{ limit?: number; executionId?: string }, unknown> {
  return {
    id: "terminal_output",
    name: "Terminal Output",
    description:
      "Show the recent output of executed commands (bounded, secret-redacted).",
    category: "command",
    version: "1.0.0",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "How many recent commands to return (default 20)",
        },
        executionId: {
          type: "string",
          description: "Return output for a specific execution id",
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        outputs: { type: "array", items: { type: "object" } },
        count: { type: "number" },
      },
      required: ["outputs", "count"],
    },
    capabilities: ["idempotent"],
    permission: {
      level: "read",
      requiresApproval: false,
      rationale: "Read recent terminal output",
    },
    idempotent: true,
    async execute(input, ctx): Promise<unknown> {
      if (input.executionId !== undefined) {
        if (
          typeof input.executionId !== "string" ||
          input.executionId.trim().length === 0
        ) {
          throw toolError(
            "VALIDATION",
            "executionId must be a non-empty string",
            ctx.executionId,
            {
              recoverable: false,
            },
          );
        }
        const record = store.forExecution(input.executionId);
        if (!record) {
          throw toolError(
            "NOT_FOUND",
            `No terminal output for execution ${input.executionId}`,
            ctx.executionId,
          );
        }
        return { outputs: [record], count: 1 };
      }
      const limit =
        typeof input.limit === "number" && input.limit > 0
          ? Math.min(input.limit, 100)
          : 20;
      const outputs = store.recent(limit);
      return { outputs, count: outputs.length };
    },
  };
}

// ============================================================================
// kill_process
// ============================================================================

export function createKillProcessTool(
  service: CommandExecutionService,
): ToolDefinition<{ pid: number; signal?: "SIGTERM" | "SIGKILL" }, unknown> {
  return {
    id: "kill_process",
    name: "Kill Process",
    description:
      "Terminate a running process by PID (Windows: kills the process tree).",
    category: "command",
    version: "1.0.0",
    inputSchema: {
      type: "object",
      properties: {
        pid: { type: "number", description: "Process id to terminate" },
        signal: {
          type: "string",
          enum: ["SIGTERM", "SIGKILL"],
          description: "Signal on POSIX (default SIGTERM)",
        },
      },
      required: ["pid"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        pid: { type: "number" },
        killed: { type: "boolean" },
      },
      required: ["pid", "killed"],
    },
    capabilities: [],
    permission: {
      level: "execute",
      requiresApproval: true,
      rationale: "Terminate a process by PID",
    },
    idempotent: false,
    async execute(input, ctx): Promise<unknown> {
      checkAborted(ctx);
      const pid = input.pid;
      if (!Number.isInteger(pid) || pid <= 0) {
        throw toolError(
          "VALIDATION",
          "pid must be a positive integer",
          ctx.executionId,
          {
            recoverable: false,
          },
        );
      }
      if (process.platform === "win32") {
        const out = await service.run(
          { command: "taskkill", args: ["/PID", String(pid), "/T", "/F"] },
          { signal: ctx.signal },
        );
        if (out.cancelled) {
          throw toolError(
            "CANCELLED",
            "Cancelled while killing process",
            ctx.executionId,
            {
              recoverable: false,
            },
          );
        }
        if ((out.exitCode ?? 1) !== 0) {
          throw toolError(
            "PROCESS_FAILED",
            `taskkill failed to terminate pid ${pid}: ${redactSecrets(out.stderr.trim()).slice(0, 500)}`,
            ctx.executionId,
          );
        }
        return { pid, killed: true };
      }
      // POSIX — signal via process.kill.
      const signal = input.signal ?? "SIGTERM";
      try {
        process.kill(pid, signal);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (isAbortLike(err)) {
          throw toolError("CANCELLED", "Cancelled", ctx.executionId, {
            recoverable: false,
          });
        }
        if (code === "ESRCH") {
          throw toolError(
            "NOT_FOUND",
            `No process with pid ${pid}`,
            ctx.executionId,
          );
        }
        throw toolError(
          "PROCESS_FAILED",
          `Failed to signal pid ${pid}: ${redactSecrets(String(err))}`,
          ctx.executionId,
        );
      }
      return { pid, killed: true };
    },
  };
}

// ============================================================================
// Factory
// ============================================================================

export function createCommandTools(
  boundary: WorkspaceBoundary,
  service: CommandExecutionService,
  policy: CommandExecutionPolicy,
  store: TerminalStore,
): ToolDefinition[] {
  return [
    createExecuteCommandTool(boundary, service, policy, store),
    createTerminalOutputTool(store),
    createKillProcessTool(service),
  ] as ToolDefinition[];
}
