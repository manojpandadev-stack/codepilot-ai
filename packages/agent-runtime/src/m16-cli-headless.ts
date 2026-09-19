/**
 * M16 — CLI / Headless Mode.
 *
 * A headless runner over the SAME CodePilotRuntime used by the VS Code
 * extension (no second agent implementation). Responsibilities:
 *
 * - `run`: execute a single prompt to completion (streaming or buffered)
 * - `task`: create a persisted task via the M12 TaskStore, run it, and
 *   record the result — enabling resume after interruption
 * - `resume`: continue an interrupted/persisted task
 * - `models` / `providers`: list discovered providers and models via the
 *   M2 ProviderRegistry
 * - `sessions`: list prior sessions
 * - `version`: print versions
 *
 * Exit codes (CI-friendly):
 *   0 success · 1 agent/task failure · 2 usage error
 *   3 timeout · 4 cancelled · 5 approval denied / blocked
 *
 * All permissions still flow through M4: in non-interactive mode the runner
 * never auto-approves beyond the runtime's configured policy.
 */

import type { CodePilotRuntime } from "./runtime.js";
import type { AgentEvent } from "./types.js";
import { TaskStore, type PersistedTask } from "./m12-task-store.js";
import {
  buildInitialMessages,
  classifyResumeFidelity,
  type ResumeWireMessage,
} from "./resume.js";
import { CompactionEngine } from "./compaction-engine.js";

// ============================================================================
// Types
// ============================================================================

export type CliExitCode =
  | 0 // success
  | 1 // failure
  | 2 // usage error
  | 3 // timeout
  | 4 // cancelled
  | 5; // approval denied

export interface CliRunResult {
  exitCode: CliExitCode;
  /** Final assistant text (best-effort). */
  output: string;
  sessionId?: string;
  taskId?: string;
  durationMs: number;
  error?: string;
  /** Events recorded when `collectEvents` was set. */
  events?: Array<{ type: string; timestampMs: number }>;
}

export interface CliRunnerOptions {
  /** Timeout for the whole run. 0 = no timeout. Default 0. */
  timeoutMs?: number;
  /** Output mode: `json` prints one JSON result; `stream` also emits events to the sink. */
  output?: "json" | "stream";
  /** Stream sink for `stream` mode. Default: process.stdout-style logger. */
  onStreamEvent?: (event: { type: string; message?: string }) => void;
  /** Persist the task via TaskStore and support resume. */
  store?: TaskStore;
  /**
   * M12 v2 — verbatim resume: seed a restored conversation into the run
   * (native initialMessages wire shape). Used by `resume` for tasks with
   * a faithful v2 conversation record.
   */
  initialMessages?: ResumeWireMessage[];
  /** Non-interactive mode never waits for approvals beyond policy. Default true for CI. */
  collectEvents?: boolean;
}

export const CLI_VERSION = "0.1.0";

// ============================================================================
// Helpers
// ============================================================================

function extractAssistantText(event: AgentEvent): string | null {
  // Best-effort: different event shapes carry assistant text differently.
  const record = event as unknown as Record<string, unknown>;
  if (typeof record.message === "string" && record.type === "status") {
    return record.message;
  }
  const payload = record.payload as Record<string, unknown> | undefined;
  if (payload && typeof payload.text === "string") {
    return payload.text;
  }
  if (typeof record.text === "string") return record.text;
  return null;
}

// ============================================================================
// CliRunner
// ============================================================================

export class CliRunner {
  constructor(private readonly runtime: CodePilotRuntime) {}

  /** `codepilot run <prompt>` — one-shot headless execution. */
  async run(prompt: string, options?: CliRunnerOptions): Promise<CliRunResult> {
    if (!prompt || !prompt.trim()) {
      return {
        exitCode: 2,
        output: "",
        durationMs: 0,
        error: "empty prompt (usage: codepilot run <prompt>)",
      };
    }

    const startedAt = Date.now();
    const events: Array<{ type: string; timestampMs: number }> = [];
    let output = "";
    let settled = false;
    let exitCode: CliExitCode = 0;
    let errorMessage: string | undefined;

    const unsubscribe = this.runtime.subscribe((event: AgentEvent) => {
      const record = event as unknown as Record<string, unknown>;
      if (options?.collectEvents) {
        events.push({ type: String(record.type), timestampMs: Date.now() });
      }
      if (options?.output === "stream") {
        options.onStreamEvent?.({
          type: String(record.type),
          message:
            typeof record.message === "string" ? record.message : undefined,
        });
      }
      const text = extractAssistantText(event);
      if (text && text.length > output.length) output = text;

      // Event-driven exit codes never override an earlier terminal code
      // (e.g. a timeout already recorded as 3 stays 3).
      if (record.type === "error" && exitCode === 0) {
        const err = record.error as
          { category?: string; message?: string } | undefined;
        errorMessage = err?.message ?? String(record.message ?? "agent error");
        exitCode = 1;
      }
      if (record.type === "cancelled" && exitCode === 0) {
        exitCode = 4;
      }
    });

    // Timeout guard.
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    if (options?.timeoutMs && options.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (!settled) {
          exitCode = 3;
          errorMessage = `run timed out after ${options.timeoutMs}ms`;
          this.runtime.abort().catch(() => undefined);
        }
      }, options.timeoutMs);
    }

    try {
      const sessionId = await this.runtime.startSession(prompt, {
        ...(options?.initialMessages
          ? { initialMessages: options.initialMessages }
          : {}),
      });
      // startSession resolves when the run settles (success or failure).
      const state = this.runtime.getState();
      if (exitCode === 0 && state.lastRunMetrics?.failed) {
        exitCode = 1;
        errorMessage = errorMessage ?? "run failed";
      }
      return {
        exitCode,
        output,
        sessionId: sessionId || state.sessionId || undefined,
        durationMs: Date.now() - startedAt,
        error: errorMessage,
        events: options?.collectEvents ? events : undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        exitCode: exitCode === 0 ? 1 : exitCode,
        output,
        durationMs: Date.now() - startedAt,
        error: errorMessage ?? message,
        events: options?.collectEvents ? events : undefined,
      };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      unsubscribe();
    }
  }

  /** `codepilot task <prompt>` — persisted, resumable task execution. */
  async task(
    prompt: string,
    options?: CliRunnerOptions,
  ): Promise<CliRunResult> {
    const store = options?.store;
    if (!store) {
      // Without a store, task == run.
      return this.run(prompt, options);
    }
    const persisted = await store.create(prompt);
    const result = await this.run(prompt, options);
    if (result.exitCode === 0) {
      await store.update(persisted.id, { status: "completed" });
      await store.appendMessage(
        persisted.id,
        "assistant",
        result.output || "(no output)",
      );
    } else if (result.exitCode === 4) {
      await store.update(persisted.id, { status: "cancelled" });
    } else {
      await store.update(persisted.id, { status: "failed" });
      await store.appendMessage(
        persisted.id,
        "system",
        result.error ?? "run failed",
      );
    }
    return { ...result, taskId: persisted.id };
  }

  /** `codepilot resume <taskId>` — record resume intent; execution continues via runtime. */
  async resume(
    taskId: string,
    options?: CliRunnerOptions,
  ): Promise<CliRunResult> {
    const store = options?.store;
    if (!store) {
      return {
        exitCode: 2,
        output: "",
        durationMs: 0,
        error: "resume requires a task store",
      };
    }
    const persisted: PersistedTask | null = await store.get(taskId);
    if (!persisted) {
      return {
        exitCode: 2,
        output: "",
        durationMs: 0,
        error: `unknown task: ${taskId}`,
      };
    }
    if (persisted.status === "completed") {
      return {
        exitCode: 0,
        output: "task already completed",
        taskId,
        durationMs: 0,
      };
    }
    // M12 v2 — same contract as the extension: verbatim conversation seeding
    // when the v2 conversation exists, honest fidelity reporting, and the
    // atomic resume guard (completed/archived rejected above; generation
    // bumped below so two concurrent resumes cannot both own the task).
    const fidelity = classifyResumeFidelity(persisted);
    // Compacted resume: reuse the latest persisted compaction artifact when
    // present (summary + recent tail, protocol-validated). The CLI has no
    // live summarizer config, so resume consumes artifacts only — it never
    // triggers a fresh summarization call.
    const compacted = new CompactionEngine({
      store,
      resolveSummarizerConfig: async () => null,
    }).composeFromTask(persisted);
    const initialMessages =
      compacted && compacted.length > 0
        ? compacted
        : buildInitialMessages(persisted);
    const resumed = await store.beginResume(taskId);
    if (!resumed) {
      return {
        exitCode: 2,
        output: "",
        durationMs: 0,
        error: "task can no longer be resumed",
      };
    }
    // E2E evidence: open-ended "continue" framing makes small local models
    // parrot a trailing ack instead of doing new work. Ask for the next
    // concrete step explicitly.
    const prompt =
      initialMessages.length > 0
        ? `The conversation above is the real prior history of the task "${persisted.title.slice(0, 200)}". Continue working on the original request: do not repeat completed work, do not acknowledge — produce the next concrete step toward the goal.`
        : `Resume task: ${persisted.title}`;
    const result = await this.run(prompt, {
      ...options,
      ...(initialMessages.length > 0
        ? ({ initialMessages } as Partial<CliRunnerOptions>)
        : {}),
    });
    if (result.exitCode === 0) {
      await store.update(taskId, { status: "completed" });
      await store.appendMessage(
        taskId,
        "assistant",
        result.output || "(no output)",
      );
    } else if (result.exitCode !== 4) {
      await store.update(taskId, { status: "failed" });
    }
    return {
      ...result,
      taskId,
      ...(fidelity.fidelity !== "FULL"
        ? { error: result.error ?? `resume fidelity: ${fidelity.fidelity}` }
        : {}),
    };
  }
}

// ============================================================================
// Command parsing (pure — testable without a runtime)
// ============================================================================

export interface ParsedCliCommand {
  command:
    | "run"
    | "task"
    | "resume"
    | "models"
    | "providers"
    | "sessions"
    | "version"
    | "help"
    | "config"
    // Help/version aliases — normalized to help/version by consumers.
    | "--help"
    | "-h"
    | "--version"
    | "-v";
  args: string[];
  flags: Record<string, string | boolean>;
  exitCode: CliExitCode | null; // null = proceed; number = immediate exit
  errorMessage?: string;
}

const KNOWN_COMMANDS = new Set([
  "run",
  "task",
  "resume",
  "models",
  "providers",
  "sessions",
  "version",
  "help",
  "config",
  // Help aliases — standard CLI conventions.
  "--help",
  "-h",
  "--version",
  "-v",
]);

export function parseCliCommand(argv: readonly string[]): ParsedCliCommand {
  const args = [...argv];
  const first = args.shift() ?? "help";
  if (!KNOWN_COMMANDS.has(first)) {
    return {
      command: "help",
      args: [],
      flags: {},
      exitCode: 2,
      errorMessage: `unknown command: ${first}`,
    };
  }
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  if ((first === "run" || first === "task") && positional.length === 0) {
    return {
      command: first,
      args: positional,
      flags,
      exitCode: 2,
      errorMessage: `${first} requires a prompt argument`,
    };
  }
  if (first === "resume" && positional.length === 0) {
    return {
      command: "resume",
      args: positional,
      flags,
      exitCode: 2,
      errorMessage: "resume requires a task id",
    };
  }
  return {
    command: first as ParsedCliCommand["command"],
    args: positional,
    flags,
    exitCode: null,
  };
}

/** Human-readable help text. */
export function cliHelpText(): string {
  return [
    "codepilot — CodePilot AI headless CLI",
    "",
    "Usage:",
    "  codepilot run <prompt>       Run one task to completion",
    "  codepilot task <prompt>      Run with durable persistence (resumable)",
    "  codepilot resume <taskId>    Resume a persisted task",
    "  codepilot models             List discovered models",
    "  codepilot providers          List providers",
    "  codepilot sessions           List recent sessions",
    "  codepilot config             Show current configuration",
    "  codepilot version            Print version",
    "",
    "Flags:",
    "  --json                       JSON output (CI mode)",
    "  --timeout <ms>               Kill the run after <ms>",
    "  --stream                     Stream events as they arrive",
  ].join("\n");
}
