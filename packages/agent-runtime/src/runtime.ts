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
import {
  CommandRepairLoop,
  runTerminalToolRepair,
  classifyCommandFailure,
  type CommandRepairOutcome,
} from "./m13-command-repair.js";

/** Extract the single command text from a terminal tool call's raw args. */
function extractCommandText(argsText: unknown): string | null {
  // The loop event carries the raw arguments JSON text (LlmToolCall).
  if (typeof argsText !== "string" || argsText.length === 0) return null;
  try {
    const parsed = JSON.parse(argsText) as { command?: unknown };
    if (typeof parsed.command === "string" && parsed.command.length > 0) {
      return parsed.command;
    }
  } catch {
    return null;
  }
  // Multi-command batches ({ commands: [...] }) are NOT repaired — the
  // repair loop is defined for a single command text.
  return null;
}
import type { PrivacyMode, ToolPermissionPolicy } from "@codepilot/shared";
import { OLLAMA_DEFAULT_BASE_URL, scrubSecretsText } from "@codepilot/shared";
import {
  modelSupportsVision,
  isSupportedProviderId,
  CODEPILOT_PROVIDER_CATALOG,
} from "@codepilot/llm";
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
import { createCodePilotBuiltinTools } from "./builtin-tools.js";
import { parseModelPlanText, type TaskPlan } from "./task-plan.js";
import {
  MUTATING_TOOL_NAMES,
  STAGED_WRITE_TOOL_NAMES,
  createStagedWriteTools,
} from "./staged-write-tools.js";
// Native engine + LLM (CodePilot-owned replacements for the Cline runtime)
import { NativeSessionManager } from "./native/engine/session.js";
import type { LlmProviderConfig } from "./native/llm/registry.js";
import type { AgentTool, AgentUsage, AgentMessage } from "./native/types.js";
import { NATIVE_AGENT_ID } from "./native/types.js";

// ============================================================================
// Helpers
// ============================================================================

/** Re-exported so hosts and tests share one agent identity constant. */
export { NATIVE_AGENT_ID };

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
 * Host names that always mean "this machine" (RFC 6761 reserves `.localhost`).
 * Compared case-insensitively after stripping a trailing dot.
 */
const LOCAL_ONLY_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);

/** IPv4 literals inside 127.0.0.0/8 (loopback). */
function isLoopbackIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const octets = m.slice(1, 5).map((n) => Number(n));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return false;
  return octets[0] === 127;
}

/**
 * TRUE only when the URL provably points at THIS machine.
 *
 * Deliberately conservative and synchronous — it never performs DNS, so it
 * cannot itself leak a hostname or be fooled by a rebinding answer:
 *   - literal loopback IPv4 (127.0.0.0/8) and IPv6 (::1) → local
 *   - reserved `localhost` names (RFC 6761, incl. `*.localhost`) → local
 *   - anything else — public host, LAN/private IP, unparsable URL,
 *     relative/odd scheme, or an unparseable host → REMOTE (fail-closed)
 *
 * Because DNS is never consulted, a public name that happens to resolve to
 * 127.0.0.1 is still classified remote and therefore blocked in Local Only.
 */
export function isLoopbackEndpoint(
  baseUrl: string | undefined | null,
): boolean {
  if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false; // unparsable destination is ambiguous → fail-closed
  }
  // Only http/https carry model traffic; anything else (file:, ws:, …) is not
  // a local model endpoint we can vouch for.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  // Credentials in a Local Only URL are never legitimate; treat as ambiguous.
  if (parsed.username.length > 0 || parsed.password.length > 0) return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host.length === 0) return false;
  if (host === "[::1]" || host === "::1") return true;
  if (LOCAL_ONLY_HOSTNAMES.has(host)) return true;
  if (host.endsWith(".localhost")) return true;
  return isLoopbackIPv4(host);
}

/**
 * TRUE when the provider routes model requests to a remote (non-local)
 * endpoint.
 *
 * Locality is decided by the EFFECTIVE DESTINATION, not the provider ID: a
 * local provider id pointed at a remote `baseUrl` (e.g. an Ollama-compatible
 * host on the internet) still leaves the machine and is therefore remote.
 * `baseUrl` is optional for call sites that genuinely have no override — in
 * that case the provider id decides, as before.
 *
 * Used by the privacy guard — fail-closed: unknown providers and unknown
 * endpoints count as remote.
 */
export function isRemoteProvider(
  providerId: string,
  baseUrl?: string | undefined | null,
): boolean {
  if (baseUrl !== undefined && baseUrl !== null && baseUrl !== "") {
    return !isLoopbackEndpoint(baseUrl);
  }
  if (providerId === "ollama") return false;
  const cat = getCatalogProvider(providerId);
  if (!cat) return true; // unknown provider → assume remote (deny-closed)
  return cat.category !== "local";
}

/**
 * Effective per-request output-budget limits for the selected model.
 *
 * Precedence: explicit host config (modelContextWindow / maxOutputTokens) →
 * curated LLM catalogue entry → absent. Absent means UNKNOWN: the agent loop
 * then falls back to its documented default output cap (never the context
 * window), so missing or invalid metadata can never inflate a request beyond
 * what the model actually supports. Values must be positive integers —
 * anything else is treated as absent (limits are never invented).
 */
export function resolveModelLimits(
  providerId: string,
  modelId: string,
  explicit?: { modelContextWindow?: number; maxOutputTokens?: number },
): { contextWindow?: number; maxOutputTokens?: number } {
  const positiveInt = (value: unknown): number | undefined =>
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= Number.MAX_SAFE_INTEGER
      ? value
      : undefined;
  const explicitWindow = positiveInt(explicit?.modelContextWindow);
  const explicitMax = positiveInt(explicit?.maxOutputTokens);

  const canonicalId = providerId === "google" ? "gemini" : providerId;
  const provider = CODEPILOT_PROVIDER_CATALOG.find((p) => p.id === canonicalId);
  const model = provider?.models?.[modelId];

  const contextWindow = explicitWindow ?? positiveInt(model?.contextWindow);
  const maxOutputTokens = explicitMax ?? positiveInt(model?.maxTokens);
  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  };
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
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
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

  /** First model output (text or reasoning delta) of the current run. */
  private firstTokenAt: number | null = null;

  /** Tool calls that failed this run (executor error or gate denial). */
  private toolFailureCount = 0;

  /** Names of the tools exposed to the model for the CURRENT run (Phase 1
   *  tool-automation diagnostics — authoritative post-filter list). */
  private lastRunToolNames: string[] = [];

  /** Structured tool calls the model emitted this run (Phase 2 no-tool-call
   *  diagnostic �?" distinguishes "model chose prose" from "runtime lost the
   *  call"). Counted at tool_started, i.e. post-parse, pre-approval. */
  private lastRunToolCallCount = 0;

  /**
   * Structured task plan for the ACTIVE task. Written by the `plan` builtin
   * (or the PLAN-mode text fallback) and re-hydrated by the host on resume;
   * every change is emitted as agent.plan_created/plan_updated so the host
   * persists it and the WebView renders live progress. Holds plan METADATA
   * only (objective/steps/status) �?" never file or command content.
   */
  private currentTaskPlan: TaskPlan | null = null;

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
  /** Bounded command-failure repair loop (Phase 12, row 14). */
  private commandRepairLoop: CommandRepairLoop | null = null;

  constructor(options: CodePilotRuntimeOptions) {
    this.options = options;
    // SECURITY: gate mode-boundary state starts from the CONFIGURED mode so
    // the gate is safe even before the first startSession assigns it.
    this.activeRunAgentMode = options.agentMode ?? "act";
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
      ...(options.redactToolResults !== undefined
        ? { redactToolResults: options.redactToolResults }
        : {}),
      ...(options.modelContextWindow !== undefined
        ? { modelContextWindow: options.modelContextWindow }
        : {}),
      ...(options.maxOutputTokens !== undefined
        ? { maxOutputTokens: options.maxOutputTokens }
        : {}),
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
  // Tool executors + staging (shared ChangeSet boundary — staged-write-tools)
  // ============================================================================

  /**
   * Tools that can never execute in a given agent mode (Phase 1 — Act-mode
   * truth). The tool-calling ASK/PLAN contract is read-only Q&A: mutating
   * tools (writes, shell, staged edits) are NOT advertised to the model at
   * all, so a mis-modeled turn cannot even attempt a mutation the policy
   * would deny anyway. Read-only tools (read_files, search_codebase,
   * ask_question, skills, web) stay available because ASK legitimately reads
   * the workspace to answer. This is a model-contract filter ONLY — the M4
   * gate still evaluates every call in every mode; nothing here bypasses or
   * weakens approval.
   */
  private static readonly MODE_FILTERED_TOOLS: ReadonlySet<string> =
    MUTATING_TOOL_NAMES;

  /** Build the native toolset for a merged config. */
  private buildNativeTools(config: CodePilotAgentConfig): AgentTool[] {
    const tools: AgentTool[] = [];
    if (config.extraTools) tools.push(...(config.extraTools as AgentTool[]));
    // Streaming terminal executor (M7): live stdout/stderr events while the
    // process runs. M4 still gates every call BEFORE dispatch reaches this
    // tool — execution here implies approval.
    tools.push(this.buildTerminalStreamingTool());
    // ChangeSet-staged write tools (SAME shared boundary child agents use):
    // no file write happens here — proposals go to the host's
    // ChangeSetManager (pending until user approval). Without a host bridge
    // the list is empty, so no write tool is advertised at all (fail closed).
    tools.push(
      ...createStagedWriteTools({
        workspaceRoot: config.workspaceRoot,
        ...(this.options.onWriteProposal
          ? { onWriteProposal: this.options.onWriteProposal }
          : {}),
        onStaged: (paths) => this.state.filesChanged.push(...paths),
      }),
    );
    // CodePilot-owned model-facing builtins (read_files, search_codebase,
    // skills, ask_question, run_commands, plus fetch_web_content/web_search
    // outside local privacy mode). Tool lookup is first-wins, so the native
    // streaming `bash` executor and the staged editor/apply_patch above keep
    // precedence and these fill only names the native set does not already
    // provide. The owned set NEVER contributes a write tool here: the
    // staging tools above are the only editor/apply_patch/delete_file.
    // Every call still passes the M4 gate BEFORE dispatch reaches execute.
    const registeredNames = new Set(tools.map((t) => t.name));
    // Names owned exclusively by the staging boundary. Without a host bridge
    // no staging tool was registered above, so the owned factory must NOT
    // supply a direct-write editor/apply_patch/delete_file as a substitute —
    // a missing ChangeSet bridge means no write tools at all (fail closed).
    for (const reserved of STAGED_WRITE_TOOL_NAMES) {
      registeredNames.add(reserved);
    }
    const streamingRunner = this.terminalStreamingRunner();
    for (const owned of createCodePilotBuiltinTools({
      cwd: config.workspaceRoot,
      // The native streaming bash executor above IS the bash tool here.
      enableBash: false,
      enableWebFetch: config.privacyMode !== "local",
      // F-01: forward the effective privacy mode so the factory — not just
      // enableWebFetch — owns the Local Only web-tool decision.
      privacyMode: config.privacyMode,
      commandService: this.terminalService ?? undefined,
      // run_commands shares the ONE streaming executor (same live events,
      // same engine) instead of falling back to completion-only collection.
      ...(streamingRunner ? { streamingCommandRunner: streamingRunner } : {}),
      // Structured plan seam: plan tool changes flow through runtime state
      // and emit agent.plan_created/plan_updated (host persists the plan on
      // the task and fans it out to the WebView).
      planBridge: {
        getPlan: () => this.currentTaskPlan,
        onChange: (plan, kind) => this.applyTaskPlanChange(plan, kind),
      },
    })) {
      if (registeredNames.has(owned.name)) continue;
      registeredNames.add(owned.name);
      tools.push({
        name: owned.name,
        description: owned.description ?? owned.name,
        inputSchema: owned.inputSchema ?? { type: "object" },
        ...(owned.timeoutMs !== undefined
          ? { timeoutMs: owned.timeoutMs }
          : {}),
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
    // Phase 1 — mode/tool-contract truth: in ASK/PLAN the model is told to
    // answer without mutating, so mutating tools are not advertised at all
    // (they could not pass policy; advertising them invites doomed calls).
    // ACT/AUTO/REVIEW keep the full set. M4 still gates every call in every
    // mode — this filter changes what the MODEL sees, never authorization.
    if (config.agentMode === "ask" || config.agentMode === "plan") {
      const filtered = tools.filter(
        (t) => !CodePilotRuntime.MODE_FILTERED_TOOLS.has(t.name),
      );
      const dropped = tools.length - filtered.length;
      if (dropped > 0) {
        this.emit({
          type: "status",
          message: `AGENT_TOOLS_FILTERED mode=${config.agentMode} advertised=${filtered.length} withheld=${dropped} (mutating tools unavailable in ${config.agentMode} mode)`,
          ...this.buildCorrelation(),
        });
      }
      return filtered;
    }
    return tools;
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
          timeoutMs: {
            type: "number",
            description: "Optional timeout in milliseconds",
          },
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
       * Only roles user/assistant with text/tool_use/tool_result/image
       * blocks. Never contains secrets. Image blocks carry validated,
       * metadata-stripped bytes (`dataBase64`); `fileRef`-only blocks are
       * rejected by the provider layer — the host must resolve them first.
       */
      initialMessages?: Array<{
        role: "user" | "assistant";
        content:
          | string
          | Array<
              | { type: "text"; text: string }
              | {
                  type: "tool_use";
                  id: string;
                  name: string;
                  input: Record<string, unknown>;
                }
              | {
                  type: "tool_result";
                  tool_use_id: string;
                  name: string;
                  content: string;
                  is_error?: boolean;
                }
              | {
                  type: "image";
                  mime: string;
                  dataBase64?: string;
                  fileRef?: string;
                  name?: string;
                  sizeBytes?: number;
                }
            >;
        ts?: number;
      }>;
    },
  ): Promise<string> {
    const merged = { ...this.defaultConfig, ...config };
    // Phase 7 (wiring): effective output-budget limits for the selected
    // model — explicit host config wins, then the curated catalogue; absent
    // metadata leaves the loop's documented default cap in place.
    const modelLimits = resolveModelLimits(
      merged.providerId || "ollama",
      merged.modelId || "",
      merged,
    );

    // Phase 12 (row 14): bounded command-failure repair. Created once per
    // runtime from the effective config; history persists when configured.
    if (this.commandRepairLoop === null) {
      this.commandRepairLoop = new CommandRepairLoop({
        ...(merged.commandRepairPersistPath !== undefined
          ? { persistPath: merged.commandRepairPersistPath }
          : {}),
      });
    }

    // ---- Provider support guard (fail-closed) ----
    const requestedPid = merged.providerId || "ollama";
    const normalizedPid = toNativeProviderId(requestedPid);
    if (!isSupportedProviderId(normalizedPid)) {
      const message = `Unsupported provider "${requestedPid}". CodePilot supports only OpenAI, Gemini, and Ollama.`;
      this.emit({
        type: "error",
        error: message,
        recoverable: false,
        code: "provider-unsupported",
        providerId: requestedPid,
        ...this.buildCorrelation(),
      });
      throw new Error(message);
    }

    // ---- Privacy guard (fail-closed) ----
    // A provider whose requests leave the machine must NEVER run while the
    // user selected "local" privacy mode: that mode promises "no data leaves
    // this machine". Blocking is safer than silently switching modes — the
    // host surfaces the error and the user makes an explicit choice.
    if (
      merged.privacyMode === "local" &&
      isRemoteProvider(merged.providerId || "ollama", merged.baseUrl)
    ) {
      const pid = toNativeProviderId(merged.providerId || "ollama");
      this.emit({
        type: "error",
        error:
          `Privacy mode is "local" but provider "${pid}" sends requests to a remote endpoint. ` +
          `No request was made. Switch to a local provider (e.g. Ollama) or change privacy mode in Settings.`,
        recoverable: false,
        // Structured cause: the host renders this as an actionable privacy card
        // (and never as a generic provider failure, and never a duplicate).
        code: "privacy-blocked",
        providerId: merged.providerId || "ollama",
        ...this.buildCorrelation(),
      });
      throw new Error(
        `Privacy violation blocked: provider "${pid}" is remote but privacy mode is "local".`,
      );
    }

    // ---- Vision capability guard (fail-closed) ----
    // Image content must never be sent to a model known to be text-only
    // (it would be silently ignored or error opaquely server-side). Unknown
    // endpoints (local servers with unlisted models, BYO URLs) are allowed:
    // their capabilities cannot be established statically.
    if (
      (merged.initialMessages ?? []).some(
        (m) =>
          Array.isArray(m.content) && m.content.some((b) => b.type === "image"),
      )
    ) {
      const vision = modelSupportsVision(
        merged.providerId || "ollama",
        merged.modelId || "",
      );
      if (vision === false) {
        const message =
          `Model "${merged.modelId || "(default)"}" via provider "${merged.providerId || "ollama"}" ` +
          `does not support image input. No request was made. Switch to a vision-capable model.`;
        this.emit({
          type: "error",
          error: message,
          recoverable: false,
          ...this.buildCorrelation(),
        });
        throw new Error(message);
      }
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
    this.firstTokenAt = null;
    this.toolFailureCount = 0;
    this.eventCounter = 0;
    this.runStartedAt = Date.now();
    this.terminalToolNames.clear();
    this.terminalSeqByToolCall.clear();
    this.lastRunToolCallCount = 0;

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

    // SECURITY: record the ACTIVE run's mode BEFORE any tool can dispatch —
    // the gate enforces the ask/plan execution boundary from this value.
    this.activeRunAgentMode = merged.agentMode;

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
    // Phase 1 — authoritative per-run tool truth for diagnostics: the
    // post-filter list the model is actually offered, not the UI's button.
    this.lastRunToolNames = tools.map((t) => t.name);
    // Tool-automation truth line: mode/provider/model/toolCount as resolved
    // by the RUNTIME (not the webview button). Names stay available via
    // getLastRunToolSummary(); the message itself carries no secrets.
    this.emit({
      type: "status",
      message: `AGENT_REQUEST mode=${merged.agentMode} provider=${merged.providerId || "ollama"} model=${merged.modelId} tools=${tools.length}`,
      ...this.buildCorrelation(),
    });
    const providerConfig: LlmProviderConfig = {
      providerId: merged.providerId || "ollama",
      ...(merged.apiKey ? { apiKey: merged.apiKey } : {}),
      ...(merged.baseUrl ? { baseUrl: merged.baseUrl } : {}),
      // Local Only propagates into the LLM transport so it never follows an
      // HTTP redirect off the machine (see LlmProviderConfig.privacyMode).
      ...(merged.privacyMode ? { privacyMode: merged.privacyMode } : {}),
      ...(this.options.ollamaFirstTokenTimeoutMs !== undefined
        ? { ollamaFirstTokenTimeoutMs: this.options.ollamaFirstTokenTimeoutMs }
        : {}),
      ...(this.options.ollamaKeepAlive !== undefined
        ? { ollamaKeepAlive: this.options.ollamaKeepAlive }
        : {}),
      ...(this.options.ollamaContextLength !== undefined
        ? { ollamaContextLength: this.options.ollamaContextLength }
        : {}),
      ...(this.options.ollamaNumPredict !== undefined
        ? { ollamaNumPredict: this.options.ollamaNumPredict }
        : {}),
      ...(this.options.ollamaThink !== undefined
        ? { ollamaThink: this.options.ollamaThink }
        : {}),
    };
    this.sessions = new NativeSessionManager(
      [providerConfig],
      undefined,
      400,
      // BUG 5 — production opt-in: local Ollama chat uses the node:http
      // transport (no undici 300s HEADERS cap) so a slow CPU prefill is
      // governed solely by the provider's first-token inactivity window.
      this.options.ollamaUseNodeHttpTransport === true &&
        (merged.providerId || "ollama") === "ollama"
        ? "node-http"
        : "fetch",
    );
    this.sessions.create(sessionId, {
      providerId: merged.providerId || "ollama",
      modelId: merged.modelId || "",
      ...(merged.apiKey ? { apiKey: merged.apiKey } : {}),
      ...(merged.baseUrl ? { baseUrl: merged.baseUrl } : {}),
      systemPrompt:
        merged.systemPrompt ?? this.buildDefaultSystemPrompt(merged),
      tools,
      gate: this.buildGate(),
      maxIterations: merged.maxIterations ?? 50,
      ...(merged.temperature !== undefined
        ? { temperature: merged.temperature }
        : {}),
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
            systemPrompt:
              merged.systemPrompt ?? this.buildDefaultSystemPrompt(merged),
            tools,
            gate: this.buildGate(),
            maxIterations: merged.maxIterations ?? 50,
            ...(merged.temperature !== undefined
              ? { temperature: merged.temperature }
              : {}),
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
              systemPrompt:
                merged.systemPrompt ?? this.buildDefaultSystemPrompt(merged),
              tools,
              gate: this.buildGate(),
              maxIterations: merged.maxIterations ?? 50,
              ...(merged.temperature !== undefined
                ? { temperature: merged.temperature }
                : {}),
              // H2: remote providers never receive unredacted tool output —
              // canonical classification; explicit host override wins.
              redactToolResults:
                merged.redactToolResults ??
                isRemoteProvider(merged.providerId || "ollama", merged.baseUrl),
              // Phase 7: model limits → output budget (absent = loop default).
              ...(modelLimits.contextWindow !== undefined
                ? { modelContextWindow: modelLimits.contextWindow }
                : {}),
              ...(modelLimits.maxOutputTokens !== undefined
                ? { maxOutputTokens: modelLimits.maxOutputTokens }
                : {}),
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
          // F-02/F-03: only "complete" may settle as COMPLETED. Cancellation
          // is terminal (CancellationError → CANCELLED path, never retried);
          // truncated turns and iteration exhaustion are failures, never
          // silent completions.
          if (result.reason === "aborted") {
            throw new CancellationError("Agent run cancelled");
          }
          if (result.reason === "error") {
            throw new Error(result.error ?? "provider stream failed");
          }
          if (
            result.reason === "incomplete" ||
            result.reason === "max_iterations"
          ) {
            throw new Error(
              result.error ?? `Agent run ended: ${result.reason}`,
            );
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

        // Phase 2 — Act-mode no-tool-call diagnostic. A completed Act turn
        // with ZERO structured tool calls is LEGITIMATE (the model may
        // genuinely not need a tool); this is diagnostic truth, never an
        // error and never a retry. It distinguishes "model chose prose" from
        // "runtime failed to receive/parse a tool call" — if tools were
        // advertised (count > 0) but none were called, the request path is
        // suspect; if tools were filtered (ASK/PLAN) this line is absent by
        // design. No prompt text, no secrets.
        if (
          (merged.agentMode === "act" || merged.agentMode === "auto") &&
          this.lastRunToolCallCount === 0 &&
          this.lastRunToolNames.length > 0
        ) {
          this.emit({
            type: "status",
            message: `AGENT_COMPLETED_WITHOUT_TOOL_CALL mode=${merged.agentMode} provider=${merged.providerId || "ollama"} model=${merged.modelId} toolCount=${this.lastRunToolNames.length} classification=model_answered_without_tool_call`,
            ...this.buildCorrelation(),
          });
        }

        // Phase 2 — structured plan fallback. In PLAN mode, when the model
        // answered with plan-shaped prose instead of calling the `plan`
        // tool, materialize a real TaskPlan from it (fenced JSON block or an
        // ordered list). parseModelPlanText is deliberately conservative —
        // it returns null rather than guessing, and a structured plan from
        // an actual `plan` tool call is never overwritten here.
        if (merged.agentMode === "plan" && !this.currentTaskPlan) {
          const parsed = parseModelPlanText(result.text, Date.now());
          if (parsed) {
            this.applyTaskPlanChange(parsed, "created");
          }
        }

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
          ...(metrics.timeToFirstTokenMs !== undefined
            ? { timeToFirstTokenMs: metrics.timeToFirstTokenMs }
            : {}),
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
      this.state.lastError = scrubSecretsText(`${message}${stack}`);

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

        console.error(
          "[agent-runtime] AGENT_ERROR:",
          scrubSecretsText(message),
        );
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

  /** SECURITY: agent mode of the ACTIVE run — read by the tool gate to
   *  enforce the ask/plan execution boundary even for unadvertised tools. */
  private activeRunAgentMode: CodePilotAgentConfig["agentMode"] = "act";

  /** The M4 gate handed to the native dispatcher — deny-closed. */
  private buildGate() {
    return async (request: {
      toolCallId: string;
      toolName: string;
      input: unknown;
    }): Promise<{ approved: boolean; reason?: string }> => {
      // SECURITY BOUNDARY (mode): mutating/execution tools are rejected at
      // the gate in ask/plan mode — INDEPENDENT of tool advertisement. Even
      // a tool the model was never told about is refused here if the model
      // emits it anyway (no advertisement-only "protection").
      const activeMode = this.activeRunAgentMode;
      if (
        (activeMode === "ask" || activeMode === "plan") &&
        CodePilotRuntime.MODE_FILTERED_TOOLS.has(request.toolName)
      ) {
        return {
          approved: false,
          reason: `Tool '${request.toolName}' is unavailable in ${activeMode} mode (execution boundary)`,
        };
      }
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

  /**
   * Emit the canonical tool_failed event for an executor failure (vs gate
   * denial, which arrives as tool_denied). UI cards, history, and healing
   * see the failure — matching the long-standing tool_failed contract.
   */
  private emitToolFailure(loop: {
    call: { toolCallId: string };
    toolName: string;
    output: unknown;
  }): void {
    this.toolFailureCount += 1;
    this.emit({
      type: "tool_failed",
      toolCallId: loop.call.toolCallId,
      toolName: loop.toolName,
      error: String(loop.output ?? "tool failed").slice(0, 4000),
      ...this.buildCorrelation(),
    });
  }

  /**
   * Phase 12 (row 14): attempt bounded repair for a failed terminal tool
   * call. Returns the repair outcome, or null when the failure is not
   * repairable (non-terminal tool, unknown command, no loop/factory).
   *
   * M4 on each rerun: identical command text stays covered by the original
   * approval; TRANSFORMED text is re-evaluated through the deny-closed gate
   * before it executes.
   */
  private async tryRepairTerminalToolFailure(loop: {
    call: { toolCallId: string; argumentsText: string };
    toolName: string;
    output: unknown;
    durationMs: number;
  }): Promise<CommandRepairOutcome | null> {
    if (this.commandRepairLoop === null) return null;
    if (loop.toolName !== "bash" && loop.toolName !== "run_commands") {
      return null;
    }
    const command = extractCommandText(loop.call.argumentsText);
    if (command === null) return null;
    if (this.terminalStreamingFactory === null) return null;
    const factory = this.terminalStreamingFactory;
    this.emit({
      type: "status",
      message: `Repairing ${loop.toolName} failure (bounded attempts)…`,
      ...this.buildCorrelation(),
    });
    const decision = await runTerminalToolRepair(
      {
        loop: this.commandRepairLoop,
        isTerminalTool: (name) => name === "bash" || name === "run_commands",
        extractCommand: (input) => extractCommandText(input),
        executeRepair: async (cmd) => {
          const original = extractCommandText(loop.call.argumentsText);
          if (cmd !== original) {
            const gate = this.buildGate();
            const verdict = await gate({
              toolCallId: loop.call.toolCallId,
              toolName: loop.toolName,
              input: { command: cmd },
            });
            if (!verdict.approved) {
              throw new Error(
                `repair command denied by M4: ${verdict.reason ?? "approval required"}`,
              );
            }
          }
          return factory({
            command: cmd,
            toolCallId: loop.call.toolCallId,
          });
        },
      },
      {
        toolCallId: loop.call.toolCallId,
        toolName: loop.toolName,
        input: loop.call.argumentsText,
        output: String(loop.output ?? "tool failed").slice(0, 4000),
      },
    );
    if (decision.action !== "repair") return null;
    return decision.outcome;
  }

  /** Map native loop/session events onto the preserved AgentEvent union. */
  private handleLoopEvent(
    sessionId: string,
    event:
      | { type: "status"; sessionId: string; status: string; reason?: string }
      | {
          type: "loop";
          loop: import("./native/engine/agent-loop.js").AgentLoopEvent;
          sessionId: string;
        },
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
        if (this.firstTokenAt === null) {
          this.firstTokenAt = Date.now();
        }
        this.emit({
          type: "text_delta",
          text: loop.text,
          accumulated: loop.accumulated,
          ...this.buildCorrelation(),
        });
        break;
      case "reasoning_delta":
        this.state.status = "running";
        if (this.firstTokenAt === null) {
          this.firstTokenAt = Date.now();
        }
        this.emit({
          type: "reasoning_delta",
          text: loop.text,
          accumulated: loop.accumulated,
          ...this.buildCorrelation(),
        });
        break;
      case "tool_started":
        this.recordToolStart(loop.toolName);
        this.lastRunToolCallCount += 1;
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
          // Phase 12 (row 14): bounded command-failure repair for terminal
          // tools. Only recoverable failure classes enter the loop — the
          // emission is deferred until the outcome is known (each transformed
          // rerun re-gates through M4; ambiguous transient failures are never
          // replayed and surface as outcome-unknown). Non-recoverable
          // failures emit tool_failed synchronously via the normal path.
          const failureText = String(loop.output ?? "tool failed").slice(
            0,
            4000,
          );
          const { classification } = classifyCommandFailure(failureText);
          if (classification !== "non_recoverable") {
            void this.tryRepairTerminalToolFailure(loop).then((repair) => {
              if (repair !== null && repair.status === "recovered") {
                if (this.stateMachine.canTransitionTo("EXECUTING")) {
                  this.doTransition("EXECUTING", `Tool done: ${loop.toolName}`);
                }
                this.emit({
                  type: "tool_completed",
                  toolCallId: loop.call.toolCallId,
                  toolName: loop.toolName,
                  output: repair.output ?? "",
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
                return;
              }
              if (repair?.status === "outcome_unknown") {
                this.toolFailureCount += 1;
                this.emit({
                  type: "tool_failed",
                  toolCallId: loop.call.toolCallId,
                  toolName: loop.toolName,
                  error:
                    "Command outcome is unknown: it may have partially or fully executed before the timeout or network failure. Inspect the workspace before retrying.",
                  ...this.buildCorrelation(),
                });
              } else {
                this.emitToolFailure(loop);
              }
            });
            break;
          }
          this.emitToolFailure(loop);
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
        this.toolFailureCount += 1;
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
          ...(loop.usage.totalCost !== undefined
            ? { totalCost: loop.usage.totalCost }
            : {}),
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
      ...(options?.mode
        ? { agentMode: options.mode as CodePilotAgentConfig["agentMode"] }
        : {}),
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
    // The abort path bypasses startSession's catch (which would write
    // metrics): record the cancelled run here so lastRunMetrics is
    // meaningful on every settlement path.
    this.state.lastRunMetrics = this.buildRunMetrics(false, true);
  }

  async stopSession(): Promise<void> {
    this.runController?.abort();
    if (!this.runSettled) {
      this.runSettled = true;
      this.stateMachine.cancel("Session stopped");
      this.state.status = "idle";
      // A stopped run still produced partial telemetry — record it so
      // lastRunMetrics is meaningful on every settlement path.
      this.state.lastRunMetrics = this.buildRunMetrics(false, true);
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
      /** Ollama-only live settings (BUG 4): reach the next /api/chat body. */
      ollamaContextLength?: number;
      ollamaNumPredict?: number;
      ollamaKeepAlive?: string;
      /** Explicit thinking control (three-state; undefined = server default). */
      ollamaThink?: boolean;
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
    // Ollama-only live settings (BUG 4): stored on the runtime so the next
    // startSession builds its LlmProviderConfig with the current values.
    if (patch.ollamaContextLength !== undefined)
      this.options.ollamaContextLength = patch.ollamaContextLength;
    if (patch.ollamaNumPredict !== undefined)
      this.options.ollamaNumPredict = patch.ollamaNumPredict;
    if (patch.ollamaKeepAlive !== undefined)
      this.options.ollamaKeepAlive = patch.ollamaKeepAlive;
    if (patch.ollamaThink !== undefined)
      this.options.ollamaThink = patch.ollamaThink;
    if (patch.maxIterations !== undefined)
      this.defaultConfig.maxIterations = patch.maxIterations;
    if (patch.privacyMode !== undefined)
      this.defaultConfig.privacyMode = patch.privacyMode;
    if (patch.agentMode !== undefined) {
      this.defaultConfig.agentMode = patch.agentMode;
      this.policyEngine.setAgentMode(toPolicyEngineMode(patch.agentMode));
      // SECURITY: keep the gate's mode boundary in sync with config changes.
      if (!this.state.sessionId) this.activeRunAgentMode = patch.agentMode;
    }
    if (patch.systemPrompt !== undefined)
      this.defaultConfig.systemPrompt = patch.systemPrompt;
    // H2 / Phase 7: honor these fields when set through updateConfig too —
    // silently dropping a host's redaction/limit patch would be worse than
    // rejecting it (a remote provider would fall back to classification and
    // a limit override would appear to apply while never reaching the wire).
    if (patch.redactToolResults !== undefined)
      this.defaultConfig.redactToolResults = patch.redactToolResults;
    if (patch.modelContextWindow !== undefined)
      this.defaultConfig.modelContextWindow = patch.modelContextWindow;
    if (patch.maxOutputTokens !== undefined)
      this.defaultConfig.maxOutputTokens = patch.maxOutputTokens;
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
   * Read-only view of the runtime's authoritative routing/privacy settings
   * (providerId, modelId, baseUrl, privacyMode — never the apiKey). The host
   * uses this to detect configuration changed OUTSIDE the runtime (e.g.
   * ProviderService writes, or the user flipping privacy mode via
   * settings/set / privacy/confirm while the runtime was already live) and to
   * re-apply it via updateConfig before the next run. apiKey is deliberately
   * omitted: the host re-resolves credentials from SecretStorage, never from
   * the runtime. privacyMode is included because the privacy gate reads the
   * LIVE runtime value on every request — a host-only setting write would
   * otherwise leave a stale mode in force until the next runtime creation.
   */
  getProviderSettings(): {
    providerId: string;
    modelId: string;
    baseUrl?: string;
    privacyMode: PrivacyMode;
  } {
    return {
      providerId: this.defaultConfig.providerId,
      modelId: this.defaultConfig.modelId,
      ...(this.defaultConfig.baseUrl !== undefined
        ? { baseUrl: this.defaultConfig.baseUrl }
        : {}),
      privacyMode: this.defaultConfig.privacyMode ?? "local",
    };
  }

  /**
   * Phase 1 tool-automation truth: the tool names exposed to the model for
   * the most recent (or current) run — the post-filter authoritative list
   * the request contract (LlmRequest.tools) is built from. Never contains
   * schemas or inputs; safe for logs and diagnostics.
   */
  getLastRunToolSummary(): { count: number; names: string[] } {
    return {
      count: this.lastRunToolNames.length,
      names: [...this.lastRunToolNames],
    };
  }

  /**
   * Structured task plan — host seam. The host hydrates this from the
   * persisted task on resume (so a resumed task continues ITS plan, never a
   * blank one) and clears it when the active task changes.
   */
  getTaskPlan(): TaskPlan | null {
    return this.currentTaskPlan;
  }

  setTaskPlan(plan: TaskPlan | null): void {
    this.currentTaskPlan = plan;
  }

  /** Apply a `plan` tool change: hold state + emit the typed plan event. */
  private applyTaskPlanChange(
    plan: TaskPlan,
    kind: "created" | "updated",
  ): void {
    this.currentTaskPlan = plan;
    if (kind === "created") {
      this.emit({
        type: "agent.plan_created",
        plan: plan.objective,
        stepsCount: plan.steps.length,
        taskPlan: plan,
        ...this.buildCorrelation(),
      });
    } else {
      this.emit({
        type: "agent.plan_updated",
        taskPlan: plan,
        ...this.buildCorrelation(),
      });
    }
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
        "You are in PLAN mode. Analyze the codebase and create an implementation plan. Do NOT modify any files. Describe what changes would be needed, which files to modify, and the implementation steps. " +
          "FIRST call the `plan` tool with action=create to record the plan as structured steps (objective, ordered steps with affected files and validation); " +
          "then summarize the same plan for the user. If the `plan` tool is unavailable, present the plan as an ordered numbered list.",
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

    if (
      config.enableTools !== false &&
      config.extraTools &&
      config.extraTools.length > 0
    ) {
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
    runId: string | undefined;
    agentId: string;
    timestamp: number;
    agentState: AgentState;
  } {
    return {
      eventId: `evt-${++this.eventCounter}`,
      sessionId: this.activeSessionId ?? undefined,
      taskId: this.currentTaskId ?? undefined,
      runId: this.currentTaskId ?? undefined,
      agentId: NATIVE_AGENT_ID,
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
    const raw = error instanceof Error ? error.message : String(error);
    // Scrub before classification AND storage: error text travels into
    // events, the webview, and persistence — secret-shaped fragments must
    // never ride along. Classification runs on the scrubbed text.
    const message = scrubSecretsText(raw);
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
    const merged = this.defaultConfig;
    return {
      taskId: this.currentTaskId ?? "",
      sessionId: this.activeSessionId,
      runId: this.currentTaskId ?? undefined,
      agentId: NATIVE_AGENT_ID,
      providerId: merged.providerId || "ollama",
      modelId: merged.modelId || "",
      agentMode: merged.agentMode || "act",
      startedAt: this.runStartedAt,
      completedAt: now,
      durationMs: now - this.runStartedAt,
      ...(this.firstTokenAt !== null
        ? {
            firstTokenAt: this.firstTokenAt,
            timeToFirstTokenMs: this.firstTokenAt - this.runStartedAt,
          }
        : {}),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      ...(usage.totalCost !== undefined ? { totalCost: usage.totalCost } : {}),
      toolCallCount: this.state.toolCallHistory.reduce(
        (sum, t) => sum + t.count,
        0,
      ),
      toolFailures: this.toolFailureCount,
      iterations: this.state.currentIteration,
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
