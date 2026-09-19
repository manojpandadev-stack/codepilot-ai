/**
 * CodePilotRuntime — the production agent runtime.
 *
 * NATIVE ENGINE: this class now drives the CodePilot-owned agent loop
 * (native/engine) and the CodePilot-owned LLM layer (native/llm). There is no
 * Cline runtime in this path: sessions, iteration, tool dispatch, streaming,
 * cancellation and metrics are all implemented in @codepilot/agent-runtime.
 *
 * PRESERVED CONTRACT (backward compatible):
 *   - Public API: initialize/startSession/sendMessage/abort/stopSession/
 *     listSessions/updateConfig/getState/getAgentState/subscribe/dispose/
 *     getPolicyEngine/getCommandValidator/listenerCount.
 *   - The AgentEvent union — every member and field, unchanged.
 *   - M4 authority: every tool call passes options.requestApproval (the
 *     host's RiskEngine → PermissionPolicyEngine → ApprovalManager →
 *     SecurityValidator pipeline) BEFORE tool execution, deny-closed.
 *   - Privacy guard, concurrent-start guard, retry policy, run timeout,
 *     state machine, correlation ids, run metrics.
 *   - Streaming terminal: the `bash` executor still routes through the
 *     CommandExecutionService and emits terminal_output events live.
 *   - ChangeSet staging: editor/apply_patch executors stage proposals via
 *     options.onWriteProposal (no file writes from the agent).
 */

import { existsSync, readFileSync } from "node:fs";
import type {
  CodePilotAgentConfig,
  CodePilotRuntimeOptions,
  AgentEvent,
  AgentEventListener,
  AgentRuntimeState,
  RuntimeError,
  RunMetrics,
} from "./types.js";
import { PolicyEngine, CommandValidator } from "@codepilot/policy-engine";
import {
  CommandExecutionService,
  createStreamingShellExecutor,
} from "@codepilot/tool-engine";
import type { TerminalStreamEventWithCorrelation } from "@codepilot/tool-engine";
import type { ToolPermissionPolicy } from "@codepilot/shared";
import { OLLAMA_DEFAULT_BASE_URL } from "@codepilot/shared";
import {
  OllamaProvider,
  ProviderRegistry,
  getCatalogProvider,
  type DiscoveredModel,
} from "@codepilot/model-gateway";
import {
  stateMachineStateToRuntimeStatus,
  AgentStateMachine,
} from "./state-machine.js";
import type { AgentState } from "./state-machine.js";
import {
  CancellationSource,
  TimeoutManager,
  withRetry,
  isTransientError,
  CancellationError,
} from "./cancellation.js";
import { MAX_PROPOSED_FILE_BYTES } from "./write-tools.js";
import { createCodePilotBuiltinTools } from "./builtin-tools.js";
import {
  parseEditorInput,
  parseApplyPatchInput,
  formatStagedResult,
} from "./write-tools.js";
// Native engine + LLM (CodePilot-owned replacements for the Cline runtime)
import { NativeSessionManager } from "./native/engine/session.js";
import type { LlmProviderConfig } from "./native/llm/registry.js";
import type { AgentTool, AgentUsage, AgentMessage } from "./native/types.js";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Map a UI agent mode onto the PolicyEngine's mode union ("plan" | "act" | "review").
 */
function toPolicyEngineMode(
  mode: CodePilotAgentConfig["agentMode"],
): "plan" | "act" | "review" {
  switch (mode) {
    case "ask":
    case "plan":
    case "review":
      return "plan";
    case "auto":
    case "act":
    default:
      return "act";
  }
}

/** Minimal usage shape matching both our type and the provider streams */
interface RuntimeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost?: number;
}

/**
 * Model capability metadata for routing and UI display.
 */
export interface ModelCapability {
  model: string;
  provider: string;
  toolCalling: boolean;
  streaming: boolean;
  reasoning: boolean;
  vision: boolean;
  contextWindow: number;
  recommendedFor: string[];
  estimatedMemoryMB?: number;
  codingCapability: "excellent" | "good" | "fair" | "poor";
}

/**
 * Legacy alias kept for API compatibility: maps CodePilot provider ids onto
 * the canonical native provider families. Previously the Cline SDK required
 * its own ids (`openai-native`, `gemini`); the native LLM registry accepts
 * the CodePilot ids directly, so this is now the identity map for ids the
 * registry knows — remote families keep their historical aliases.
 */
export function toNativeProviderId(providerId: string): string {
  switch (providerId) {
    case "google":
      return "gemini";
    default:
      return providerId;
  }
}

/**
 * TRUE when the provider routes model requests to a remote (non-local)
 * endpoint. Local runtimes (Ollama, LM Studio) and providers whose requests
 * never leave the machine return false; everything else is treated as remote.
 * Used by the privacy guard — fail-closed: unknown providers count as remote.
 */
export function isRemoteProvider(providerId: string): boolean {
  if (providerId === "ollama" || providerId === "lmstudio") return false;
  const cat = getCatalogProvider(providerId);
  if (!cat) return true; // unknown provider → assume remote (deny-closed)
  return cat.category !== "local";
}

/**
 * Map a model-gateway DiscoveredModel onto the runtime's ModelCapability shape.
 */
function discoveredToModelCapability(model: DiscoveredModel): ModelCapability {
  const coding =
    model.capabilities.codingCapability === "unknown"
      ? "fair"
      : model.capabilities.codingCapability;
  return {
    model: model.id,
    provider: model.providerId,
    toolCalling: model.capabilities.tools,
    streaming: model.capabilities.streaming,
    reasoning: model.capabilities.reasoning,
    vision: model.capabilities.vision,
    contextWindow: model.capabilities.contextWindow,
    recommendedFor: model.capabilities.recommendedFor,
    estimatedMemoryMB: model.capabilities.estimatedMemoryMB ?? undefined,
    codingCapability: coding,
  };
}

/**
 * Discover Ollama models and their capabilities through the M2 provider
 * system (@codepilot/model-gateway). Never throws — returns [] (a
 * provider-unavailable state) when Ollama is not reachable.
 */
export async function discoverOllamaModels(
  baseUrl: string = OLLAMA_DEFAULT_BASE_URL,
): Promise<ModelCapability[]> {
  try {
    const registry = new ProviderRegistry();
    registry.register(
      new OllamaProvider({
        id: "ollama",
        name: "Ollama (Local)",
        type: "ollama",
        baseUrl,
        enabled: true,
      }),
    );
    const models = await registry.listModels("ollama", {
      forceRefresh: true,
      signal: AbortSignal.timeout(5000),
    });
    return models.map(discoveredToModelCapability);
  } catch {
    return [];
  }
}

/**
 * Probe Ollama availability through the M2 provider system
 * (@codepilot/model-gateway registry health check). Never throws.
 */
export async function checkOllamaHealth(
  baseUrl: string = OLLAMA_DEFAULT_BASE_URL,
): Promise<{ available: boolean; error?: string; latencyMs?: number }> {
  try {
    const registry = new ProviderRegistry();
    registry.register(
      new OllamaProvider({
        id: "ollama",
        name: "Ollama (Local)",
        type: "ollama",
        baseUrl,
        enabled: true,
      }),
    );
    const health = await registry.healthCheck("ollama", {
      signal: AbortSignal.timeout(5000),
    });
    if (health.status === "HEALTHY") {
      return { available: true, latencyMs: health.latencyMs ?? undefined };
    }
    return {
      available: false,
      error: health.error ?? "Ollama is unavailable.",
    };
  } catch (error) {
    return {
      available: false,
      error:
        error instanceof Error
          ? `Ollama is unavailable: ${error.message}`
          : "Ollama is unavailable.",
    };
  }
}

// ============================================================================
// CodePilotRuntime
// ============================================================================

export class CodePilotRuntime {
  private sessions: NativeSessionManager;
  private listeners = new Set<AgentEventListener>();
  private policyEngine: PolicyEngine;
  private commandValidator: CommandValidator;
  private options: CodePilotRuntimeOptions;
  private state: AgentRuntimeState = {
    status: "idle",
    sessionId: null,
    currentIteration: 0,
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    filesChanged: [],
    toolCallHistory: [],
    lastError: null,
  };

  private defaultConfig: CodePilotAgentConfig;

  private activeSessionId: string | null = null;

  /** Set once the current run has produced a terminal event (completed/cancelled/error). */
  private runSettled = false;

  /** Abort controller for the in-flight run (native engine unwinds on abort). */
  private runController: AbortController | null = null;

  private stateMachine: AgentStateMachine = new AgentStateMachine("CREATED");

  private runCancellationSource: CancellationSource | null = null;

  private runTimeoutManager: TimeoutManager | null = null;

  private eventCounter = 0;

  private currentTaskId: string | null = null;

  private runStartedAt = 0;

  /** Last per-run usage snapshot from the loop (normalized). */
  private lastRunUsage: RuntimeUsage | undefined;

  /**
   * Live tool names for terminal_output correlation: toolCallId → name.
   * Pruned on every terminal tool event and cleared per run — bounded by construction.
   */
  private terminalToolNames = new Map<string, string>();

  /**
   * Highest terminal_output seq emitted per toolCallId this run. When one
   * tool call streams SEVERAL commands (run_commands batch), each underlying
   * execution restarts its seq at 1 — resequencing here keeps the WebView
   * contract (appendTerminalOutput drops seq ≤ lastSeq) monotonically
   * ordered under a single toolCallId. Cleared per run; bounded by live tools.
   */
  private terminalSeqByToolCall = new Map<string, number>();

  /**
   * Shared command execution service for the streaming `bash` executor.
   * One instance serves all runs (it is designed for concurrent executions).
   */
  private terminalService: CommandExecutionService | null = null;

  /**
   * Lazily-built single streaming shell executor shared by bash AND
   * run_commands (see terminalStreamingRunner). Built once per runtime.
   */
  private terminalStreamingFactory:
    | ((input: {
        command: string;
        signal?: AbortSignal;
        toolCallId?: string;
      }) => Promise<string>)
    | null = null;

  constructor(options: CodePilotRuntimeOptions) {
    this.options = options;
    this.defaultConfig = {
      providerId: options.providerId,
      modelId: options.modelId,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      workspaceRoot: options.workspaceRoot,
      privacyMode: options.privacyMode ?? "local",
      agentMode: options.agentMode ?? "act",
      maxIterations: options.maxIterations ?? 50,
      temperature: options.temperature,
      systemPrompt: options.systemPrompt,
      toolPolicies: options.toolPolicies,
      extraTools: options.extraTools,
    };

    // Initialize policy engine with custom policies if provided
    const customPolicies: ToolPermissionPolicy[] | undefined =
      options.toolPolicies
        ? Object.entries(options.toolPolicies).map(([toolName, policy]) => ({
            toolName,
            category: "system" as const,
            permission: policy.autoApprove
              ? ("auto" as const)
              : policy.enabled === false
                ? ("blocked" as const)
                : ("approval" as const),
          }))
        : undefined;

    this.policyEngine = new PolicyEngine({ customPolicies });
    this.commandValidator = new CommandValidator();
    this.sessions = new NativeSessionManager([]);
  }

  // ============================================================================
  // Tool executors + staging (preserved behavior, native dispatch)
  // ============================================================================

  private async stageInput(
    toolName: "editor" | "apply_patch",
    input: Record<string, unknown>,
    cwd: string,
  ): Promise<string> {
    if (!this.options.onWriteProposal) {
      throw new Error("ChangeSet staging is not configured for this session");
    }
    const result =
      toolName === "editor"
        ? parseEditorInput(input, cwd, (abs) => this.readOriginalSafe(abs))
        : await parseApplyPatchInput(input, cwd);
    if (!result.ok) {
      throw new Error(`${toolName} staging failed: ${result.error}`);
    }
    const { changeSetId } = await this.options.onWriteProposal(
      toolName,
      result.proposals,
    );
    this.state.filesChanged.push(
      ...result.proposals.map((p) => p.relativePath),
    );
    return formatStagedResult(toolName, changeSetId, result.proposals);
  }

  private readOriginalSafe(absolutePath: string): string | undefined {
    try {
      if (!existsSync(absolutePath)) return undefined;
      const buffer = readFileSync(absolutePath);
      if (buffer.length > MAX_PROPOSED_FILE_BYTES) return undefined;
      if (buffer.includes(0)) return undefined;
      return buffer.toString("utf8");
    } catch {
      return undefined;
    }
  }

  /** Build the native toolset for a merged config. */
  private buildNativeTools(config: CodePilotAgentConfig): AgentTool[] {
    const tools: AgentTool[] = [];
    if (config.extraTools) tools.push(...(config.extraTools as AgentTool[]));
    // Streaming terminal executor (M7): live stdout/stderr events while the
    // process runs. M4 still gates every call BEFORE dispatch reaches this
    // tool — execution here implies approval.
    tools.push(this.buildTerminalStreamingTool());
    // ChangeSet-staged write tools: no file write happens here — proposals
    // go to the host's ChangeSetManager (pending until user approval).
    if (this.options.onWriteProposal) {
      tools.push(this.buildStagingTool("editor"));
      tools.push(this.buildStagingTool("apply_patch"));
    }
    // CodePilot-owned model-facing builtins (read_files, search_codebase,
    // skills, ask_question, run_commands, plus fetch_web_content/web_search
    // outside local privacy mode). Tool lookup is first-wins, so the native
    // streaming `bash` executor and the staged editor/apply_patch above keep
    // precedence and these fill only names the native set does not already
    // provide. The no-staging (headless/legacy) path gets the direct-write
    // editor/apply_patch from the owned set, matching the legacy contract.
    // Every call still passes the M4 gate BEFORE dispatch reaches execute.
    const registeredNames = new Set(tools.map((t) => t.name));
    const streamingRunner = this.terminalStreamingRunner();
    for (const owned of createCodePilotBuiltinTools({
      cwd: config.workspaceRoot,
      // The native streaming bash executor above IS the bash tool here.
      enableBash: false,
      enableWebFetch: config.privacyMode !== "local",
      commandService: this.terminalService ?? undefined,
      // run_commands shares the ONE streaming executor (same live events,
      // same engine) instead of falling back to completion-only collection.
      ...(streamingRunner ? { streamingCommandRunner: streamingRunner } : {}),
    })) {
      if (registeredNames.has(owned.name)) continue;
      registeredNames.add(owned.name);
      tools.push({
        name: owned.name,
        description: owned.description ?? owned.name,
        inputSchema: owned.inputSchema ?? { type: "object" },
        ...(owned.timeoutMs !== undefined ? { timeoutMs: owned.timeoutMs } : {}),
        execute: async (input, context) => {
          // Adapt the owned tool shape (all-optional context) to the native
          // dispatcher contract (required agentId, abort signal).
          return await owned.execute(input, {
            sessionId: context.sessionId,
            agentId: context.agentId,
            toolCallId: context.toolCallId,
            signal: context.signal,
          });
        },
      });
    }
    return tools;
  }

  /** Native wrapper for the ChangeSet-staged write tools. */
  private buildStagingTool(toolName: "editor" | "apply_patch"): AgentTool {
    const description =
      toolName === "editor"
        ? "Edit file ranges in the workspace. The edit is staged as a pending ChangeSet for user approval — no file is modified until approved."
        : "Apply a Codex-style patch (*** Begin Patch format) to workspace files. Changes are staged as a pending ChangeSet for user approval — no file is modified until approved.";
    const schema: Record<string, unknown> =
      toolName === "editor"
        ? {
            type: "object",
            properties: {
              file_path: { type: "string", description: "Workspace-relative file path" },
              operation: {
                type: "string",
                enum: ["replace", "insert", "append"],
                description: "replace: swap old_string→new_string; insert: insert after line; append: add to end",
              },
              old_string: { type: "string", description: "Text to replace (replace operation)" },
              new_string: { type: "string", description: "Replacement text" },
              line: { type: "number", description: "1-based line number (insert operation)" },
              content: { type: "string", description: "Text to insert/append" },
            },
            required: ["file_path", "operation"],
          }
        : {
            type: "object",
            properties: {
              patch: { type: "string", description: "Patch beginning with '*** Begin Patch'" },
            },
            required: ["patch"],
          };
    return {
      name: toolName,
      description,
      inputSchema: schema,
      timeoutMs: 30_000,
      execute: async (input) => {
        const resultText = await this.stageInput(
          toolName,
          input as Record<string, unknown>,
          this.defaultConfig.workspaceRoot,
        );
        return resultText;
      },
    };
  }

  private buildTerminalStreamingTool(): AgentTool {
    const streamingRunner = this.terminalStreamingRunner();
    // Wrap the streaming shell executor into a native AgentTool so the
    // M4-gated dispatcher calls it identically.
    return {
      name: "bash",
      description:
        "Run a shell command in the workspace. Streams stdout/stderr live; returns combined bounded output and the exit code.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to run" },
          timeoutMs: { type: "number", description: "Optional timeout in milliseconds" },
        },
        required: ["command"],
      },
      timeoutMs: 300_000,
      execute: async (input, context) => {
        const rec = input as Record<string, unknown>;
        const command = typeof rec.command === "string" ? rec.command : "";
        if (command.length === 0) {
          return { error: "bash input missing command" };
        }
        // The streaming executor resolves to the combined output string
        // (and throws `[Command exited with code N]` on failure) — map it
        // to the structured result the model expects. Live chunks already
        // reached the UI through the onTerminalEvent side channel above.
        const output = await streamingRunner({
          command,
          ...(context.signal ? { signal: context.signal } : {}),
          ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
        });
        return { output, exitCode: 0, success: true };
      },
    };
  }

  /**
   * The ONE streaming shell executor for agent terminal tools (bash and
   * run_commands). Lazily builds it with the terminal_output forwarder that
   * fans live stdout/stderr chunks into the runtime event stream; callers
   * pass toolCallId/signal per invocation. There is deliberately no second
   * terminal engine — both tools stream through this single instance.
   */
  private terminalStreamingRunner(): (input: {
    command: string;
    signal?: AbortSignal;
    toolCallId?: string;
  }) => Promise<string> {
    if (!this.terminalService) {
      this.terminalService = new CommandExecutionService();
    }
    if (!this.terminalStreamingFactory) {
      const streamingShell = createStreamingShellExecutor(
        this.terminalService,
        {
          onTerminalEvent: (event: TerminalStreamEventWithCorrelation) => {
            if (
              event.type !== "terminal.stdout" &&
              event.type !== "terminal.stderr"
            ) {
              return;
            }
            const toolCallId = event.executionId;
            const toolName =
              this.terminalToolNames.get(toolCallId) ?? "terminal";
            // Resequence per tool call: a multi-command batch restarts each
            // execution's seq at 1, but the WebView sink orders by seq under
            // one toolCallId — emit monotonically increasing values instead.
            const outSeq =
              (this.terminalSeqByToolCall.get(toolCallId) ?? 0) + 1;
            this.terminalSeqByToolCall.set(toolCallId, outSeq);
            this.emit({
              type: "terminal_output",
              toolCallId,
              toolName,
              stream: event.type === "terminal.stdout" ? "stdout" : "stderr",
              data: event.data,
              seq: outSeq,
              executionId: event.executionId,
              ...this.buildCorrelation(),
            });
          },
        },
      );
      this.terminalStreamingFactory = (input) =>
        streamingShell(input.command, this.defaultConfig.workspaceRoot, {
          ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
    }
    return this.terminalStreamingFactory;
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async initialize(): Promise<void> {
    this.emit({
      type: "status",
      message: "Initializing CodePilot runtime...",
      ...this.buildCorrelation(),
    });
    // The native engine has no external bootstrap — initialization is local
    // and synchronous-safe. Kept async for API compatibility.
    this.emit({
      type: "status",
      message: "Runtime initialized.",
      ...this.buildCorrelation(),
    });
  }

  // ============================================================================
  // startSession
  // ============================================================================

  async startSession(
    prompt: string,
    config?: Partial<CodePilotAgentConfig> & {
      /**
       * Verbatim resume: prior conversation seeded into the session
       * (ResumeWireMessage shape — the native engine's native wire format).
       * Only roles user/assistant with text/tool_use/tool_result blocks.
       * Never contains secrets.
       */
      initialMessages?: Array<{
        role: "user" | "assistant";
        content:
          | string
          | Array<
              | { type: "text"; text: string }
              | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
              | {
                  type: "tool_result";
                  tool_use_id: string;
                  name: string;
                  content: string;
                  is_error?: boolean;
                }
            >;
        ts?: number;
      }>;
    },
  ): Promise<string> {
    const merged = { ...this.defaultConfig, ...config };

    // ---- Privacy guard (fail-closed) ----
    // A provider whose requests leave the machine must NEVER run while the
    // user selected "local" privacy mode: that mode promises "no data leaves
    // this machine". Blocking is safer than silently switching modes — the
    // host surfaces the error and the user makes an explicit choice.
    if (
      merged.privacyMode === "local" &&
      isRemoteProvider(merged.providerId || "ollama")
    ) {
      const pid = toNativeProviderId(merged.providerId || "ollama");
      this.emit({
        type: "error",
        error:
          `Privacy mode is "local" but provider "${pid}" sends requests to a remote endpoint. ` +
          `No request was made. Switch to a local provider (e.g. Ollama) or change privacy mode in Settings.`,
        recoverable: false,
        ...this.buildCorrelation(),
      });
      throw new Error(
        `Privacy violation blocked: provider "${pid}" is remote but privacy mode is "local".`,
      );
    }

    // ---- Concurrent-start guard ----
    if (this.state.status === "running" && !this.runSettled) {
      throw new Error(
        "A task is already running in this runtime. Stop it or wait for completion before starting another.",
      );
    }

    // ---- Reset per-run state ----
    this.runSettled = false;
    this.lastRunUsage = undefined;
    this.eventCounter = 0;
    this.runStartedAt = Date.now();
    this.terminalToolNames.clear();
    this.terminalSeqByToolCall.clear();

    // Assign a stable task ID for this run (preserved across retries)
    this.currentTaskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.state.taskId = this.currentTaskId;
    this.state.retriesConsumed = 0;

    // Reset state machine (may be in terminal state from a previous run)
    if (this.stateMachine.isTerminal) {
      this.stateMachine.reset();
    }

    // Set up per-run cancellation source
    this.runCancellationSource?.dispose();
    this.runCancellationSource = new CancellationSource();

    // Set up optional run timeout
    this.runTimeoutManager?.dispose();
    const runTimeoutMs = this.options.runTimeoutMs ?? 0;
    if (runTimeoutMs > 0) {
      this.runTimeoutManager = new TimeoutManager(
        this.runCancellationSource,
        runTimeoutMs,
        `Run timed out after ${runTimeoutMs}ms`,
      );
    }

    // Abort plumbing: cancellation source (timeout/abort()) → native engine
    this.runController = new AbortController();
    this.runCancellationSource.token.onCancelled((reason) => {
      if (!this.runSettled && this.runController) {
        this.runController.abort();
        void this.settleCancelled(reason);
      }
    });

    // Transition: CREATED → INITIALIZING
    this.doTransition("INITIALIZING", "Session starting");

    this.emit({
      type: "status",
      message: `Starting ${merged.agentMode} session...`,
      ...this.buildCorrelation(),
    });

    // Validate shell commands in the prompt
    const commandMatch = prompt.match(/```bash\n([\s\S]*?)```/);
    if (commandMatch) {
      const validation = this.commandValidator.validate(
        commandMatch[1]!.trim(),
      );
      if (!validation.allowed) {
        this.emit({
          type: "error",
          error: `Command blocked: ${validation.reason}`,
          recoverable: true,
          ...this.buildCorrelation(),
        });
      }
    }

    // INITIALIZING → PLANNING
    this.doTransition("PLANNING", "Building session config");

    // Stable session id for this run.
    const sessionId = `cp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.activeSessionId = sessionId;
    this.state.sessionId = sessionId;

    this.emit({
      type: "status",
      message: `AGENT_STARTED provider=${merged.providerId} model=${merged.modelId} baseUrl=${merged.baseUrl ?? "(default)"} mode=${merged.agentMode}`,
      ...this.buildCorrelation(),
    });

    // Emit M1.2 structured event
    this.emit({
      type: "agent.started",
      agentMode: merged.agentMode,
      providerId: merged.providerId,
      modelId: merged.modelId,
      ...this.buildCorrelation(),
    });

    // PLANNING → EXECUTING
    this.doTransition("EXECUTING", "Starting native agent loop");

    this.state.status = "running";

    const tools = this.buildNativeTools(merged);
    const providerConfig: LlmProviderConfig = {
      providerId: merged.providerId || "ollama",
      ...(merged.apiKey ? { apiKey: merged.apiKey } : {}),
      ...(merged.baseUrl ? { baseUrl: merged.baseUrl } : {}),
    };
    this.sessions = new NativeSessionManager([providerConfig]);
    this.sessions.create(sessionId, {
      providerId: merged.providerId || "ollama",
      modelId: merged.modelId || "",
      ...(merged.apiKey ? { apiKey: merged.apiKey } : {}),
      ...(merged.baseUrl ? { baseUrl: merged.baseUrl } : {}),
      systemPrompt: merged.systemPrompt ?? this.buildDefaultSystemPrompt(merged),
      tools,
      gate: this.buildGate(),
      maxIterations: merged.maxIterations ?? 50,
      ...(merged.temperature !== undefined ? { temperature: merged.temperature } : {}),
      ...(merged.initialMessages && merged.initialMessages.length > 0
        ? { initialMessages: merged.initialMessages as AgentMessage[] }
        : {}),
    });

    const maxRetries = this.options.maxRetries ?? 2;

    try {
      const result = await withRetry(
        async () => {
          // Fresh transcript per retry attempt (the loop mutates in place).
          this.sessions.create(sessionId, {
            providerId: merged.providerId || "ollama",
            modelId: merged.modelId || "",
            ...(merged.apiKey ? { apiKey: merged.apiKey } : {}),
            ...(merged.baseUrl ? { baseUrl: merged.baseUrl } : {}),
            systemPrompt: merged.systemPrompt ?? this.buildDefaultSystemPrompt(merged),
            tools,
            gate: this.buildGate(),
            maxIterations: merged.maxIterations ?? 50,
            ...(merged.temperature !== undefined ? { temperature: merged.temperature } : {}),
            ...(merged.initialMessages && merged.initialMessages.length > 0
              ? { initialMessages: merged.initialMessages as AgentMessage[] }
              : {}),
          });
          const result = await this.sessions.run(
            sessionId,
            {
              providerId: merged.providerId || "ollama",
              modelId: merged.modelId || "",
              ...(merged.apiKey ? { apiKey: merged.apiKey } : {}),
              ...(merged.baseUrl ? { baseUrl: merged.baseUrl } : {}),
              systemPrompt: merged.systemPrompt ?? this.buildDefaultSystemPrompt(merged),
              tools,
              gate: this.buildGate(),
              maxIterations: merged.maxIterations ?? 50,
              ...(merged.temperature !== undefined ? { temperature: merged.temperature } : {}),
              ...(merged.initialMessages && merged.initialMessages.length > 0
                ? { initialMessages: merged.initialMessages as AgentMessage[] }
                : {}),
            },
            prompt,
            (event) => this.handleLoopEvent(sessionId, event),
            this.runController?.signal,
          );
          // Loop errors are returned as results, not thrown — surface them
          // here so withRetry can retry transient failures (timeouts,
          // connection resets) and genuine failures settle as FAILED via
          // the catch path below (never as a fake "completed").
          if (result.reason === "error") {
            throw new Error(result.error ?? "provider stream failed");
          }
          return result;
        },
        {
          maxRetries,
          initialDelayMs: 500,
          maxDelayMs: 8_000,
          isRetryable: (err) => isTransientError(err),
        },
        this.runCancellationSource.token,
        (attempt) => {
          this.state.retriesConsumed = attempt.attempt;
          this.emit({
            type: "agent.retry",
            attempt: attempt.attempt,
            maxAttempts: attempt.maxRetries,
            reason:
              attempt.error instanceof Error
                ? attempt.error.message
                : String(attempt.error),
            delayMs: attempt.delayMs,
            ...this.buildCorrelation(),
          });
          this.emit({
            type: "status",
            message: `Retrying (attempt ${attempt.attempt}/${attempt.maxRetries}, delay ${attempt.delayMs}ms)…`,
            ...this.buildCorrelation(),
          });
        },
      );

      if (!this.runSettled) {
        this.runSettled = true;
        this.doTransition("COMPLETED", "Run finished");
        this.state.status = "idle";

        const usage = this.lastRunUsage ?? {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
        this.state.usage = usage;
        const metrics = this.buildRunMetrics(false, false);
        this.state.lastRunMetrics = metrics;

        this.emit({
          type: "completed",
          result: result.text,
          usage,
          ...this.buildCorrelation(),
        });
        this.emit({
          type: "agent.completed",
          result: result.text,
          usage,
          durationMs: metrics.durationMs,
          ...this.buildCorrelation(),
        });
      }
      return this.state.sessionId ?? "";
    } catch (error) {
      if (this.runSettled) {
        // Already settled (e.g. cancellation was signalled and settled via the loop)
        return this.state.sessionId ?? "";
      }
      this.runSettled = true;
      const isCancelled = error instanceof CancellationError;
      const message = error instanceof Error ? error.message : String(error);
      const stack =
        error instanceof Error && error.stack ? `\n${error.stack}` : "";
      this.state.lastError = `${message}${stack}`;

      if (isCancelled) {
        this.doTransition("CANCELLED", message);
        this.state.status = "idle";
        this.emit({
          type: "cancelled",
          ...this.buildCorrelation(),
        });
        this.emit({
          type: "agent.cancelled",
          reason: message,
          ...this.buildCorrelation(),
        });
      } else {
        this.doTransition("FAILED", message);
        this.state.status = "failed";
        const runtimeErr = this.normalizeError(error);
        this.state.lastRuntimeError = runtimeErr;

        console.error("[agent-runtime] AGENT_ERROR:", message);
        this.emit({
          type: "error",
          error: `Agent runtime failed: ${message}`,
          recoverable: false,
          ...this.buildCorrelation(),
        });
        this.emit({
          type: "agent.failed",
          error: runtimeErr,
          ...this.buildCorrelation(),
        });
      }

      this.state.lastRunMetrics = this.buildRunMetrics(
        !isCancelled,
        isCancelled,
      );
      throw error;
    } finally {
      this.runTimeoutManager?.dispose();
      this.runTimeoutManager = null;
      this.runController = null;
    }
  }

  /** The M4 gate handed to the native dispatcher — deny-closed. */
  private buildGate() {
    return async (request: {
      toolCallId: string;
      toolName: string;
      input: unknown;
    }): Promise<{ approved: boolean; reason?: string }> => {
      if (!this.options.requestApproval) {
        // Fail-closed: no permission pipeline configured.
        return {
          approved: false,
          reason:
            "Permission pipeline unavailable — tool execution blocked for safety",
        };
      }
      const policy = this.policyEngine.checkPermission(
        request.toolName,
        request.input,
      );
      if (!policy.enabled) {
        this.emit({
          type: "status",
          message: `Tool '${request.toolName}' blocked by policy.`,
          ...this.buildCorrelation(),
        });
        return {
          approved: false,
          reason: `Tool '${request.toolName}' is blocked by policy (mode: ${this.policyEngine.getAgentMode()})`,
        };
      }
      // Surface the approval card (M1.2) while the M4 decision is pending.
      this.emit({
        type: "agent.approval_required",
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        input: request.input,
        riskLevel: "medium",
        ...this.buildCorrelation(),
      });
      const decision = await this.options.requestApproval(request);
      if (!decision.approved) {
        return { approved: false, reason: decision.reason };
      }
      return { approved: true };
    };
  }

  /** Map native loop/session events onto the preserved AgentEvent union. */
  private handleLoopEvent(
    sessionId: string,
    event:
      | { type: "status"; sessionId: string; status: string; reason?: string }
      | { type: "loop"; loop: import("./native/engine/agent-loop.js").AgentLoopEvent; sessionId: string },
  ): void {
    if (event.type === "status") {
      return;
    }
    const loop = event.loop;
    switch (loop.type) {
      case "iteration_start":
        this.state.currentIteration = loop.iteration;
        this.emit({
          type: "thinking",
          iteration: loop.iteration,
          ...this.buildCorrelation(),
        });
        this.emit({
          type: "agent.thinking",
          iteration: loop.iteration,
          ...this.buildCorrelation(),
        });
        break;
      case "text_delta":
        this.state.status = "running";
        this.emit({
          type: "text_delta",
          text: loop.text,
          accumulated: loop.accumulated,
          ...this.buildCorrelation(),
        });
        break;
      case "reasoning_delta":
        this.state.status = "running";
        this.emit({
          type: "reasoning_delta",
          text: loop.text,
          accumulated: loop.accumulated,
          ...this.buildCorrelation(),
        });
        break;
      case "tool_started":
        this.recordToolStart(loop.toolName);
        this.terminalToolNames.set(loop.call.toolCallId, loop.toolName);
        if (this.stateMachine.canTransitionTo("RUNNING_TOOL")) {
          this.doTransition("RUNNING_TOOL", `Tool: ${loop.toolName}`);
        }
        this.emit({
          type: "tool_started",
          toolCallId: loop.call.toolCallId,
          toolName: loop.toolName,
          ...this.buildCorrelation(),
        });
        this.emit({
          type: "agent.tool_started",
          toolCallId: loop.call.toolCallId,
          toolName: loop.toolName,
          ...this.buildCorrelation(),
        });
        break;
      case "tool_completed":
        this.terminalToolNames.delete(loop.call.toolCallId);
        if (this.stateMachine.canTransitionTo("EXECUTING")) {
          this.doTransition("EXECUTING", `Tool done: ${loop.toolName}`);
        }
        {
          const record = this.state.toolCallHistory.find(
            (t) => t.name === loop.toolName,
          );
          if (record) record.totalDurationMs += loop.durationMs;
        }
        if (loop.isError) {
          // Executor failure (vs gate denial, which arrives as tool_denied):
          // surface as tool_failed so UI cards, history, and healing see a
          // failure — matching the long-standing tool_failed contract for
          // failed executions. The error detail rides in `error`.
          this.emit({
            type: "tool_failed",
            toolCallId: loop.call.toolCallId,
            toolName: loop.toolName,
            error: String(loop.output ?? "tool failed").slice(0, 4000),
            ...this.buildCorrelation(),
          });
          break;
        }
        this.emit({
          type: "tool_completed",
          toolCallId: loop.call.toolCallId,
          toolName: loop.toolName,
          output: loop.output,
          durationMs: loop.durationMs,
          ...this.buildCorrelation(),
        });
        this.emit({
          type: "agent.tool_completed",
          toolCallId: loop.call.toolCallId,
          toolName: loop.toolName,
          durationMs: loop.durationMs,
          ...this.buildCorrelation(),
        });
        break;
      case "tool_denied":
        this.terminalToolNames.delete(loop.call.toolCallId);
        this.emit({
          type: "tool_failed",
          toolCallId: loop.call.toolCallId,
          toolName: loop.toolName,
          error: loop.reason,
          ...this.buildCorrelation(),
        });
        break;
      case "usage":
        this.lastRunUsage = {
          inputTokens: loop.usage.inputTokens,
          outputTokens: loop.usage.outputTokens,
          cacheReadTokens: loop.usage.cacheReadTokens,
          cacheWriteTokens: loop.usage.cacheWriteTokens,
          ...(loop.usage.totalCost !== undefined ? { totalCost: loop.usage.totalCost } : {}),
        };
        break;
      case "finish":
        // The run-level settlement happens in startSession based on the loop
        // RESULT (complete/error/max_iterations/aborted) — nothing to emit here.
        break;
      default:
        break;
    }
    void sessionId;
  }

  // ============================================================================
  // sendMessage / Abort / Stop / Sessions
  // ============================================================================

  async sendMessage(
    prompt: string,
    options?: { mode?: string },
  ): Promise<void> {
    if (!this.state.sessionId) throw new Error("No active session.");
    // The native engine runs one prompt per session; sending a follow-up
    // message re-enters startSession with the existing transcript seeded.
    // Preserved method for API compatibility with hosts that call it.
    const merged = this.defaultConfig;
    await this.startSession(prompt, {
      agentMode: merged.agentMode,
      ...(options?.mode ? { agentMode: options.mode as CodePilotAgentConfig["agentMode"] } : {}),
    });
  }

  async abort(): Promise<void> {
    // Cancel the run-level cancellation source first — the listener aborts
    // the native engine and settles the run as cancelled.
    if (this.runCancellationSource && !this.runCancellationSource.isCancelled) {
      this.runCancellationSource.cancel("Aborted by user");
      return;
    }
    await this.doAbort("Aborted by user");
  }

  private async doAbort(reason: string): Promise<void> {
    this.runController?.abort();
    await this.settleCancelled(reason);
  }

  /** Settle the in-flight run as cancelled (idempotent). */
  private async settleCancelled(reason: string): Promise<void> {
    if (this.runSettled) return;
    this.runSettled = true;
    this.stateMachine.cancel(reason);
    this.state.status = "idle";
    this.emit({
      type: "cancelled",
      ...this.buildCorrelation(),
    });
    this.emit({
      type: "agent.cancelled",
      reason,
      ...this.buildCorrelation(),
    });
  }

  async stopSession(): Promise<void> {
    this.runController?.abort();
    if (!this.runSettled) {
      this.runSettled = true;
      this.stateMachine.cancel("Session stopped");
      this.state.status = "idle";
    }
    if (this.state.sessionId) {
      this.sessions.stop(this.state.sessionId);
    }
    this.state.sessionId = null;
    this.activeSessionId = null;
    this.emit({
      type: "cancelled",
      ...this.buildCorrelation(),
    });
  }

  async listSessions(
    limit = 20,
  ): Promise<Array<{ id: string; title?: string; updatedAt?: number }>> {
    return this.sessions.list(limit).map((s) => ({
      id: s.sessionId,
      updatedAt: s.updatedAt,
    }));
  }

  // ============================================================================
  // Config / accessors
  // ============================================================================

  getPolicyEngine(): PolicyEngine {
    return this.policyEngine;
  }

  updateConfig(
    patch: Omit<Partial<CodePilotAgentConfig>, "apiKey" | "baseUrl"> & {
      /** null explicitly CLEARS the stored key (provider switch). */
      apiKey?: string | null;
      /** null explicitly CLEARS the stored base URL (provider switch). */
      baseUrl?: string | null;
    },
  ): void {
    // NOTE: provider/model/baseUrl/apiKey must move ATOMICALLY when the user
    // switches providers. `null` (in addition to undefined) explicitly CLEARS
    // a field so a stale credential/baseUrl from provider A can never be
    // reused against provider B (e.g. Ollama's loopback baseUrl hitting
    // OpenRouter). Callers switching providers should pass all four fields.
    if (patch.modelId !== undefined) this.defaultConfig.modelId = patch.modelId;
    if (patch.providerId !== undefined)
      this.defaultConfig.providerId = patch.providerId;
    if (patch.baseUrl !== undefined || patch.baseUrl === null)
      this.defaultConfig.baseUrl = patch.baseUrl ?? undefined;
    if (patch.apiKey !== undefined || patch.apiKey === null)
      this.defaultConfig.apiKey = patch.apiKey ?? undefined;
    if (patch.temperature !== undefined)
      this.defaultConfig.temperature = patch.temperature;
    if (patch.maxIterations !== undefined)
      this.defaultConfig.maxIterations = patch.maxIterations;
    if (patch.privacyMode !== undefined)
      this.defaultConfig.privacyMode = patch.privacyMode;
    if (patch.agentMode !== undefined) {
      this.defaultConfig.agentMode = patch.agentMode;
      this.policyEngine.setAgentMode(toPolicyEngineMode(patch.agentMode));
    }
    if (patch.systemPrompt !== undefined)
      this.defaultConfig.systemPrompt = patch.systemPrompt;
    this.emit({
      type: "status",
      message: "Configuration updated.",
      ...this.buildCorrelation(),
    });
  }

  getCommandValidator(): CommandValidator {
    return this.commandValidator;
  }

  /**
   * Read-only view of the provider-scoped runtime settings (providerId,
   * modelId, baseUrl — never the apiKey). The host uses this to detect
   * provider configuration changed OUTSIDE the runtime (e.g. ProviderService
   * writes while the runtime was already live) and re-apply it via
   * updateConfig before the next run. apiKey is deliberately omitted: the
   * host re-resolves credentials from SecretStorage, never from the runtime.
   */
  getProviderSettings(): {
    providerId: string;
    modelId: string;
    baseUrl?: string;
  } {
    return {
      providerId: this.defaultConfig.providerId,
      modelId: this.defaultConfig.modelId,
      ...(this.defaultConfig.baseUrl !== undefined
        ? { baseUrl: this.defaultConfig.baseUrl }
        : {}),
    };
  }

  getState(): Readonly<AgentRuntimeState> {
    return {
      ...this.state,
      agentState: this.stateMachine.state,
      status: stateMachineStateToRuntimeStatus(this.stateMachine.state),
    };
  }

  /** Returns the current fine-grained agent state from the state machine. */
  getAgentState(): AgentState {
    return this.stateMachine.state;
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Number of active listeners (lifecycle introspection for tests). */
  listenerCount(): number {
    return this.listeners.size;
  }

  private disposed = false;

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Cancel any in-flight run
    if (this.runCancellationSource && !this.runCancellationSource.isCancelled) {
      this.runCancellationSource.cancel("Runtime disposed");
    }
    this.runTimeoutManager?.dispose();
    this.runTimeoutManager = null;
    this.runController?.abort();
    this.sessions.dispose();
    this.listeners.clear();
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private buildDefaultSystemPrompt(config: CodePilotAgentConfig): string {
    const parts = [
      "You are CodePilot AI, an expert software engineering assistant.",
      `Working directory: ${config.workspaceRoot}`,
      `Privacy mode: ${config.privacyMode}`,
    ];

    if (config.privacyMode === "local") {
      parts.push(
        "IMPORTANT: LOCAL-ONLY mode. No source code leaves the machine. Never suggest sending code to external services.",
      );
    }

    if (config.agentMode === "plan") {
      parts.push(
        "You are in PLAN mode. Analyze the codebase and create an implementation plan. Do NOT modify any files. Describe what changes would be needed, which files to modify, and the implementation steps.",
      );
    } else if (config.agentMode === "review") {
      parts.push(
        "You are in REVIEW mode. Review the codebase for bugs, security issues, performance problems, and code quality. Provide structured findings with severity levels (CRITICAL, HIGH, MEDIUM, LOW, INFO).",
      );
    } else if (config.agentMode === "ask") {
      parts.push(
        "You are in ASK mode. Answer questions about the codebase. Do not modify any files.",
      );
    }

    if (config.enableTools !== false && config.extraTools && config.extraTools.length > 0) {
      const toolLines = config.extraTools
        .map((t) => `- ${t.name}: ${t.description}`)
        .join("\n");
      parts.push(
        "Available tools (call one at a time; wait for its result before continuing):\n" +
          toolLines,
      );
    }

    return parts.join("\n");
  }

  private recordToolStart(toolName: string): void {
    const record = this.state.toolCallHistory.find((t) => t.name === toolName);
    if (record) record.count += 1;
    else
      this.state.toolCallHistory.push({
        name: toolName,
        count: 1,
        totalDurationMs: 0,
      });
  }

  /**
   * Build EventCorrelation metadata from current runtime state.
   * All fields are safe to include in any event.
   */
  private buildCorrelation(): {
    eventId: string;
    sessionId: string | undefined;
    taskId: string | undefined;
    timestamp: number;
    agentState: AgentState;
  } {
    return {
      eventId: `evt-${++this.eventCounter}`,
      sessionId: this.activeSessionId ?? undefined,
      taskId: this.currentTaskId ?? undefined,
      timestamp: Date.now(),
      agentState: this.stateMachine.state,
    };
  }

  /**
   * Safely attempt a state machine transition.
   * Logs and swallows InvalidStateTransitionError so one bad event never
   * crashes the runtime — the old coarse `status` field remains source of truth
   * as a fallback.
   */
  private doTransition(to: AgentState, reason?: string): void {
    try {
      if (
        !this.stateMachine.isTerminal &&
        this.stateMachine.canTransitionTo(to)
      ) {
        const event = this.stateMachine.transition(to, reason);
        // Emit M1.2 state-change event
        this.emit({
          type: "agent.state_changed",
          from: event.from,
          to: event.to,
          reason: event.reason,
          ...this.buildCorrelation(),
        });
      }
    } catch (err) {
      // Non-fatal: log but do not crash the pipeline
      console.warn(
        `[agent-runtime] state transition ${this.stateMachine.state} → ${to} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** Build a RuntimeError from an unknown thrown value. */
  private normalizeError(error: unknown): RuntimeError {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();

    let code: RuntimeError["code"] = "UNKNOWN";
    let category: RuntimeError["category"] = "permanent";
    let retryable = false;

    if (isTransientError(error)) {
      code =
        lower.includes("timeout") || lower.includes("timed out")
          ? "NETWORK_TIMEOUT"
          : "PROVIDER_UNAVAILABLE";
      category = "transient";
      retryable = true;
    } else if (
      lower.includes("workspace") ||
      lower.includes("path traversal") ||
      lower.includes("escape")
    ) {
      code = "WORKSPACE_VIOLATION";
      category = "security";
    } else if (
      lower.includes("permission") ||
      lower.includes("access denied")
    ) {
      code = "PERMISSION_DENIED";
    } else if (lower.includes("approval")) {
      code = "APPROVAL_DENIED";
      category = "user_action_required";
    } else if (
      lower.includes("context") ||
      lower.includes("too long") ||
      lower.includes("token")
    ) {
      code = "CONTEXT_OVERFLOW";
    } else if (lower.includes("max iter")) {
      code = "MAX_ITERATIONS";
    } else if (lower.includes("timeout") || lower.includes("timed out")) {
      code = "RUN_TIMEOUT";
      category = "transient";
      retryable = true;
    }

    return {
      code,
      category,
      message: message.slice(0, 400),
      technicalDetail: message,
      recoverable: retryable || category === "transient",
      retryable,
      cancelled: false,
      timedOut: code === "NETWORK_TIMEOUT" || code === "RUN_TIMEOUT",
      cause: error,
      correlation: {
        sessionId: this.activeSessionId ?? undefined,
        taskId: this.currentTaskId ?? undefined,
        timestamp: Date.now(),
        agentState: this.stateMachine.state,
      },
    };
  }

  private buildRunMetrics(failed: boolean, cancelled: boolean): RunMetrics {
    const now = Date.now();
    const usage = this.lastRunUsage ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    return {
      taskId: this.currentTaskId ?? "",
      sessionId: this.activeSessionId,
      startedAt: this.runStartedAt,
      completedAt: now,
      durationMs: now - this.runStartedAt,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      toolCallCount: this.state.toolCallHistory.reduce(
        (sum, t) => sum + t.count,
        0,
      ),
      filesChanged: this.state.filesChanged.length,
      retriesConsumed: this.state.retriesConsumed ?? 0,
      cancelled,
      failed,
    };
  }

  /**
   * Emit an event to all listeners.
   */
  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (listenerError) {
        console.error("[agent-runtime] listener error:", listenerError);
      }
    }
  }
}

// Re-export staged-write helpers for compatibility with prior imports.
export { AgentUsage };
