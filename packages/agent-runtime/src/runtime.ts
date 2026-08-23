import { ClineCore } from "@cline/core";
import type { ToolApprovalRequest, ToolApprovalResult, RuntimeCapabilities } from "@cline/core";
import { existsSync, readFileSync } from "node:fs";
import type { CodePilotAgentConfig, CodePilotRuntimeOptions, AgentEvent, AgentEventListener, AgentRuntimeState } from "./types.js";
import { PolicyEngine, CommandValidator } from "@codepilot/policy-engine";
import type { ToolPermissionPolicy } from "@codepilot/shared";
import { OLLAMA_DEFAULT_BASE_URL } from "@codepilot/shared";
import { mapCoreEvent } from "./core-event-mapper.js";
import {
  parseEditorInput,
  parseApplyPatchInput,
  formatStagedResult,
  MAX_PROPOSED_FILE_BYTES,
} from "./write-tools.js";

/** Write tools whose execution is staged as a ChangeSet instead of writing. */
const STAGED_WRITE_TOOLS = new Set([
  "editor",
  "apply_patch",
  "create_file",
  "write_file",
  "delete_file",
  "rename_file",
  "move_file",
]);


function mapMode(mode: string): "act" | "plan" | "yolo" | "zen" {
  const map: Record<string, "act" | "plan" | "yolo" | "zen"> = {
    ask: "zen", plan: "plan", act: "act", review: "plan", auto: "yolo",
  };
  return map[mode] ?? "act";
}

/**
 * Map a UI agent mode onto the PolicyEngine's mode union ("plan" | "act" | "review").
 * Read-only UI modes (ask/plan/review) map to "plan"; write-capable modes
 * (act/auto) map to "act". Security boundaries are unaffected — PolicyEngine
 * still enforces workspace/command rules in every mode.
 */
function toPolicyEngineMode(mode: CodePilotAgentConfig["agentMode"]): "plan" | "act" | "review" {
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

/** Minimal usage shape matching both our type and Cline's */
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

/** Known model capabilities for popular coding models */
const KNOWN_MODEL_CAPABILITIES: Record<string, Partial<ModelCapability>> = {
  "qwen3:8b": {
    toolCalling: true, streaming: true, reasoning: true, vision: false,
    contextWindow: 32768, codingCapability: "good",
    recommendedFor: ["coding", "tool_use", "reasoning"],
    estimatedMemoryMB: 5200,
  },
  "qwen3:14b": {
    toolCalling: true, streaming: true, reasoning: true, vision: false,
    contextWindow: 32768, codingCapability: "excellent",
    recommendedFor: ["coding", "tool_use", "reasoning", "complex_tasks"],
    estimatedMemoryMB: 9800,
  },
  "qwen2.5-coder:7b": {
    toolCalling: false, streaming: true, reasoning: false, vision: false,
    contextWindow: 32768, codingCapability: "good",
    recommendedFor: ["coding", "chat"],
    estimatedMemoryMB: 4800,
  },
  "qwen2.5-coder:3b": {
    toolCalling: false, streaming: true, reasoning: false, vision: false,
    contextWindow: 32768, codingCapability: "fair",
    recommendedFor: ["chat", "simple_coding"],
    estimatedMemoryMB: 2400,
  },
  "llama3.2": {
    toolCalling: false, streaming: true, reasoning: false, vision: false,
    contextWindow: 131072, codingCapability: "fair",
    recommendedFor: ["chat"],
    estimatedMemoryMB: 2000,
  },
  "codellama:13b": {
    toolCalling: false, streaming: true, reasoning: false, vision: false,
    contextWindow: 16384, codingCapability: "good",
    recommendedFor: ["coding"],
    estimatedMemoryMB: 8000,
  },
};

/**
 * Discover Ollama models and their capabilities.
 */
export async function discoverOllamaModels(
  baseUrl: string = OLLAMA_DEFAULT_BASE_URL
): Promise<ModelCapability[]> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return [];

    const data = await response.json() as {
      models: Array<{
        name: string;
        details?: {
          context_length?: number;
          parameter_size?: string;
          quantization_level?: string;
        };
        size?: number;
      }>;
    };

    return data.models.map((model) => {
      const known = KNOWN_MODEL_CAPABILITIES[model.name] ?? {};
      const isQwen3 = model.name.startsWith("qwen3");
      const isCoder = model.name.includes("coder");
      const sizeGB = model.size ? model.size / (1024 * 1024 * 1024) : 0;

      return {
        model: model.name,
        provider: "ollama",
        toolCalling: known.toolCalling ?? isQwen3,
        streaming: known.streaming ?? true,
        reasoning: known.reasoning ?? isQwen3,
        vision: known.vision ?? false,
        contextWindow: known.contextWindow ?? model.details?.context_length ?? 8192,
        recommendedFor: known.recommendedFor ?? (isCoder ? ["coding"] : ["chat"]),
        estimatedMemoryMB: known.estimatedMemoryMB ?? Math.round(sizeGB * 1024),
        codingCapability: known.codingCapability
          ?? (isCoder ? "good" : "fair") as "excellent" | "good" | "fair" | "poor",
      };
    });
  } catch {
    return [];
  }
}

export class CodePilotRuntime {
  private cline: ClineCore | null = null;
  private listeners = new Set<AgentEventListener>();
  private policyEngine: PolicyEngine;
  private commandValidator: CommandValidator;
  private options: CodePilotRuntimeOptions;
  private state: AgentRuntimeState = {
    status: "idle", sessionId: null, currentIteration: 0, messages: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    filesChanged: [], toolCallHistory: [], lastError: null,
  };
  private defaultConfig: CodePilotAgentConfig;
  /** sessionId captured from the first core event — available even while start() is still awaiting. */
  private activeSessionId: string | null = null;
  /** Guards against duplicate completed/cancelled/error emissions within a single run. */
  private runSettled = false;
  /**
   * Unsubscribe for the SINGLE ClineCore listener. ClineCore.subscribe is
   * additive — it must be called once per core instance, never per run, or
   * every streamed delta is delivered N times (duplicated assistant text).
   */
  private coreUnsubscribe: (() => void) | null = null;


  constructor(options: CodePilotRuntimeOptions) {
    this.options = options;
    this.defaultConfig = {
      providerId: options.providerId, modelId: options.modelId,
      apiKey: options.apiKey, baseUrl: options.baseUrl,
      workspaceRoot: options.workspaceRoot, privacyMode: options.privacyMode ?? "local",
      agentMode: options.agentMode ?? "act", maxIterations: options.maxIterations ?? 50,
      temperature: options.temperature, systemPrompt: options.systemPrompt,
      toolPolicies: options.toolPolicies, extraTools: options.extraTools,
    };

    // Initialize policy engine with custom policies if provided
    const customPolicies: ToolPermissionPolicy[] | undefined = options.toolPolicies
      ? Object.entries(options.toolPolicies).map(([toolName, policy]) => ({
          toolName,
          category: "system" as const,
          permission: policy.autoApprove ? "auto" as const
            : policy.enabled === false ? "blocked" as const
            : "approval" as const,
        }))
      : undefined;

    this.policyEngine = new PolicyEngine({ customPolicies });
    this.commandValidator = new CommandValidator();
  }

  /**
   * Build the RuntimeCapabilities handed to ClineCore for a session:
   *  - `requestToolApproval` gates every non-auto-approved tool through the
   *    PolicyEngine (blocked in Plan mode, auto-approved by policy, otherwise
   *    decided by the host or the ChangeSet staging model).
   *  - `toolExecutors` overrides `editor`/`apply_patch` with staging executors
   *    that compute the proposed content in memory and register a pending
   *    ChangeSet — the file is written ONLY after user approval.
   */
  private buildCapabilities(config: CodePilotAgentConfig): RuntimeCapabilities {
    const capabilities: RuntimeCapabilities = {
      requestToolApproval: (request: ToolApprovalRequest) => this.resolveToolApproval(request),
    };

    // Only stage write tools when the host registered an onWriteProposal bridge.
    if (this.options.onWriteProposal) {
      const cwd = config.workspaceRoot;
      capabilities.toolExecutors = {
        editor: async (input: unknown) => this.stageInput("editor", input as Record<string, unknown>, cwd),
        applyPatch: async (input: unknown) => this.stageInput("apply_patch", input as Record<string, unknown>, cwd),
      };
    }

    return capabilities;
  }

  /**
   * PolicyEngine gate for a tool that is not auto-approved. Staged write tools
   * are always allowed through (their executor never writes — the ChangeSet
   * approval is the real gate); everything else falls back to the host's
   * `requestApproval` callback, then to deny.
   */
  private async resolveToolApproval(request: ToolApprovalRequest): Promise<ToolApprovalResult> {
    const policy = this.policyEngine.checkPermission(request.toolName, request.input);
    if (!policy.enabled) {
      this.emit({ type: "status", message: `Tool '${request.toolName}' blocked by policy.` });
      return { approved: false, reason: `Tool '${request.toolName}' is blocked by policy (mode: ${this.policyEngine.getAgentMode()})` };
    }
    if (policy.autoApprove) {
      return { approved: true, reason: "Auto-approved by policy" };
    }
    if (STAGED_WRITE_TOOLS.has(request.toolName)) {
      // Safe: the staging executor never writes; apply happens via ChangeSet.
      return { approved: true, reason: "Staged as ChangeSet — apply via Changes tab" };
    }
    if (this.options.requestApproval) {
      const decision = await this.options.requestApproval({
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        input: request.input,
      });
      return { approved: decision.approved, reason: decision.reason };
    }
    return { approved: false, reason: `Tool '${request.toolName}' requires user approval` };
  }

  /**
   * Stage a write-tool input into a pending ChangeSet via the host bridge.
   * Never writes to disk. Throws on path-escape, parse errors, or oversized
   * content so the model receives a real, actionable error.
   */
  private async stageInput(
    toolName: "editor" | "apply_patch",
    input: Record<string, unknown>,
    cwd: string
  ): Promise<string> {
    if (!this.options.onWriteProposal) {
      throw new Error("ChangeSet staging is not configured for this session");
    }
    const result = toolName === "editor"
      ? parseEditorInput(input, cwd, (abs) => this.readOriginalSafe(abs))
      : await parseApplyPatchInput(input, cwd);
    if (!result.ok) {
      throw new Error(`${toolName} staging failed: ${result.error}`);
    }
    const { changeSetId } = await this.options.onWriteProposal(toolName, result.proposals);
    this.state.filesChanged.push(...result.proposals.map((p) => p.relativePath));
    return formatStagedResult(toolName, changeSetId, result.proposals);
  }

  /** Read original file content safely: missing, binary, or oversized → undefined. */
  private readOriginalSafe(absolutePath: string): string | undefined {
    try {
      if (!existsSync(absolutePath)) return undefined;
      const buffer = readFileSync(absolutePath);
      if (buffer.length > MAX_PROPOSED_FILE_BYTES) return undefined;
      if (buffer.includes(0)) return undefined; // binary — not text-editable
      return buffer.toString("utf8");
    } catch {
      return undefined;
    }
  }

  async initialize(): Promise<void> {
    this.emit({ type: "status", message: "Initializing CodePilot runtime..." });
    try {
      this.cline = await ClineCore.create({ clientName: "codepilot-ai", backendMode: "local" });
      this.emit({ type: "status", message: "Runtime initialized." });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ type: "error", error: `Init failed: ${message}`, recoverable: false });
      throw error;
    }
    // Subscribe ONCE per ClineCore instance. ClineCore.subscribe REGISTERS an
    // additional listener on every call (additive semantics) — subscribing per
    // startSession() caused every streamed delta to be handled N times after N
    // messages, duplicating assistant text ("File File File…").
    this.attachCoreListeners();
  }

  /**
   * Idempotently attach the single core-event listener for the current
   * ClineCore instance. Safe to call before every run.
   */
  private attachCoreListeners(): void {
    if (!this.cline || this.coreUnsubscribe) return;
    this.coreUnsubscribe = this.cline.subscribe(
      (event: Record<string, unknown>) => this.handleCoreEvent(event)
    );
  }

  async startSession(prompt: string, config?: Partial<CodePilotAgentConfig>): Promise<string> {
    if (!this.cline) throw new Error("Runtime not initialized.");
    const merged = { ...this.defaultConfig, ...config };
    const mode = mapMode(merged.agentMode);
    this.emit({ type: "status", message: `Starting ${merged.agentMode} session...` });

    // Reset per-run state. Subscribing BEFORE start() is critical: the core
    // begins emitting events (status/agent_event) as soon as the run starts,
    // and start()'s returned promise only resolves after the whole run —
    // subscribing after it would miss every streaming event.
    this.runSettled = false;
    this.activeSessionId = null;

    // Validate any shell commands in the prompt through policy engine
    const commandMatch = prompt.match(/```bash\n([\s\S]*?)```/);
    if (commandMatch) {
      const validation = this.commandValidator.validate(commandMatch[1]!.trim());
      if (!validation.allowed) {
        this.emit({ type: "error", error: `Command blocked: ${validation.reason}`, recoverable: true });
      }
    }

    // Merge tool policies from the policy engine
    const enginePolicies = this.policyEngine.toClineToolPolicies();
    const mergedPolicies = { ...enginePolicies, ...merged.toolPolicies };

    const clineConfig = {
      providerId: merged.providerId || "ollama",
      modelId: merged.modelId || "",
      apiKey: merged.apiKey, baseUrl: merged.baseUrl, mode,
      systemPrompt: merged.systemPrompt ?? this.buildDefaultSystemPrompt(merged),
      cwd: merged.workspaceRoot,
      workspaceRoot: merged.workspaceRoot,
      enableTools: merged.enableTools ?? true,
      enableSpawnAgent: false,
      enableAgentTeams: false,
      thinking: false,
      maxIterations: merged.maxIterations, temperature: merged.temperature,
      toolPolicies: mergedPolicies,
    };

    // Structured diagnostics (no secrets): exactly what we hand to ClineCore.
    this.emit({
      type: "status",
      message: `AGENT_STARTED provider=${clineConfig.providerId} model=${clineConfig.modelId} baseUrl=${merged.baseUrl ?? "(default)"} mode=${mode}`,
    });

    this.state.status = "running";
    // Defensive: guarantees exactly ONE core listener even if initialize()
    // was skipped (e.g. runtime constructed then startSession called directly).
    this.attachCoreListeners();

    try {
      const result = await this.cline.start({
        config: clineConfig,
        capabilities: this.buildCapabilities(merged),
        source: "codepilot" as const, prompt, interactive: true,
      } as Parameters<typeof this.cline.start>[0]);

      this.state.sessionId = result.sessionId ?? this.activeSessionId;
      if (result.sessionId) this.activeSessionId = result.sessionId;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = result.result as any;
      const finalText: string | undefined =
        typeof res?.outputText === "string" ? res.outputText
          : typeof res?.text === "string" ? res.text
          : undefined;
      const usage = normalizeUsage(res?.usage);
      if (usage) this.state.usage = usage;

      // The run may already have been settled by a `done`/`ended` event that
      // arrived while start() was awaiting — emit completion only once.
      if (!this.runSettled) {
        this.runSettled = true;
        this.state.status = "idle";
        this.emit({
          type: "completed",
          result: finalText ?? "",
          usage: usage ?? {
            inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
          },
        });
      }
      return this.state.sessionId ?? "";
    } catch (error) {
      // NEVER swallow runtime failures: surface them so the UI can show the
      // real error instead of hanging on "Agent running…".
      this.runSettled = true;
      this.state.status = "idle";
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error && error.stack ? `\n${error.stack}` : "";
      this.state.lastError = `${message}${stack}`;
      console.error("[agent-runtime] AGENT_ERROR:", message);
      this.emit({ type: "error", error: `Agent runtime failed: ${message}`, recoverable: false });
      throw error;
    }
  }


  async sendMessage(prompt: string, options?: { mode?: string }): Promise<void> {
    if (!this.cline || !this.state.sessionId) throw new Error("No active session.");
    const mode = options?.mode ? mapMode(options.mode) : undefined;
    await this.cline.send({ sessionId: this.state.sessionId, prompt, mode });
  }

  async abort(): Promise<void> {
    // state.sessionId is captured from the first core event, so Stop works
    // even while start() is still awaiting the in-flight run.
    const sessionId = this.state.sessionId ?? this.activeSessionId;
    if (this.cline && sessionId) {
      try {
        await this.cline.abort(sessionId);
      } catch (error) {
        console.error("[agent-runtime] abort failed:", error);
      }
    }
    this.runSettled = true;
    this.state.status = "idle";
    this.emit({ type: "cancelled" });
  }

  async stopSession(): Promise<void> {
    const sessionId = this.state.sessionId ?? this.activeSessionId;
    if (this.cline && sessionId) {
      try {
        await this.cline.stop(sessionId);
      } catch (error) {
        console.error("[agent-runtime] stop failed:", error);
      }
    }
    this.runSettled = true;
    this.state.status = "idle"; this.state.sessionId = null; this.activeSessionId = null;
    this.emit({ type: "cancelled" });
  }


  async listSessions(limit = 20): Promise<Array<{ id: string; title?: string; updatedAt?: number }>> {
    if (!this.cline) return [];
    const records = await this.cline.list(limit);
    return records.map((r) => ({
      id: r.sessionId,
      title: r.metadata?.title as string | undefined,
      updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : undefined,
    }));
  }

  /** Get the policy engine for external inspection/modification. */
  getPolicyEngine(): PolicyEngine { return this.policyEngine; }

  /**
   * Apply a live configuration patch (model, base URL, temperature, mode...)
   * without recreating the runtime. Takes effect on the next startSession.
   * Agent-mode changes are also synced to the PolicyEngine so permission
   * enforcement matches the selected UI mode immediately.
   */
  updateConfig(patch: Partial<CodePilotAgentConfig>): void {
    if (patch.modelId !== undefined) this.defaultConfig.modelId = patch.modelId;
    if (patch.providerId !== undefined) this.defaultConfig.providerId = patch.providerId;
    if (patch.baseUrl !== undefined) this.defaultConfig.baseUrl = patch.baseUrl;
    if (patch.apiKey !== undefined) this.defaultConfig.apiKey = patch.apiKey;
    if (patch.temperature !== undefined) this.defaultConfig.temperature = patch.temperature;
    if (patch.maxIterations !== undefined) this.defaultConfig.maxIterations = patch.maxIterations;
    if (patch.privacyMode !== undefined) this.defaultConfig.privacyMode = patch.privacyMode;
    if (patch.agentMode !== undefined) {
      this.defaultConfig.agentMode = patch.agentMode;
      this.policyEngine.setAgentMode(toPolicyEngineMode(patch.agentMode));
    }
    if (patch.systemPrompt !== undefined) this.defaultConfig.systemPrompt = patch.systemPrompt;
    this.emit({ type: "status", message: "Configuration updated." });
  }

  /** Get command validator for external use. */
  getCommandValidator(): CommandValidator { return this.commandValidator; }

  getState(): Readonly<AgentRuntimeState> { return { ...this.state }; }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async dispose(): Promise<void> {
    if (this.state.sessionId && this.cline) {
      try { await this.cline.stop(this.state.sessionId); } catch { /* best effort */ }
    }
    if (this.coreUnsubscribe) {
      try { this.coreUnsubscribe(); } catch { /* best effort */ }
      this.coreUnsubscribe = null;
    }
    if (this.cline) { await this.cline.dispose(); this.cline = null; }
    this.listeners.clear();
  }

  private buildDefaultSystemPrompt(config: CodePilotAgentConfig): string {
    const parts = [
      "You are CodePilot AI, an expert software engineering assistant.",
      `Working directory: ${config.workspaceRoot}`,
      `Privacy mode: ${config.privacyMode}`,
    ];

    if (config.privacyMode === "local") {
      parts.push("IMPORTANT: LOCAL-ONLY mode. No source code leaves the machine. Never suggest sending code to external services.");
    }

    if (config.agentMode === "plan") {
      parts.push("You are in PLAN mode. Analyze the codebase and create an implementation plan. Do NOT modify any files. Describe what changes would be needed, which files to modify, and the implementation steps.");
    } else if (config.agentMode === "review") {
      parts.push("You are in REVIEW mode. Review the codebase for bugs, security issues, performance problems, and code quality. Provide structured findings with severity levels (CRITICAL, HIGH, MEDIUM, LOW, INFO).");
    } else if (config.agentMode === "ask") {
      parts.push("You are in ASK mode. Answer questions about the codebase. Do not modify any files.");
    }

    return parts.join("\n");
  }

  private handleCoreEvent(event: Record<string, unknown>): void {
    // Structured trace of every raw core event (no secrets in payloads).
    try {
      console.log(`[agent-runtime] CORE_EVENT type=${String(event.type)}`);
    } catch { /* logging must never break the pipeline */ }

    let mapped: ReturnType<typeof mapCoreEvent>;
    try {
      mapped = mapCoreEvent(event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[agent-runtime] EVENT_MAP_FAILED: ${message}`);
      return;
    }

    // Track sessionId as early as possible (first event already carries it),
    // so Stop works even while start() is still awaiting.
    if (mapped.sessionId && !this.activeSessionId) {
      this.activeSessionId = mapped.sessionId;
      this.state.sessionId = mapped.sessionId;
    }

    for (const mappedEvent of mapped.events) {
      switch (mappedEvent.type) {
        case "completed":
        case "cancelled":
          if (this.runSettled) continue; // single settlement per run
          this.runSettled = true;
          this.state.status = "idle";
          break;
        case "error":
          if (this.runSettled) continue;
          this.state.status = "failed";
          this.state.lastError = mappedEvent.error;
          break;
        case "text_delta":
        case "reasoning_delta":
          // First assistant output — the run is now visibly streaming.
          this.state.status = "running";
          break;
        case "tool_started":
          this.recordToolStart(mappedEvent.toolName);
          break;
        case "tool_failed":
          this.recordToolStart(mappedEvent.toolName);
          break;
        case "tool_completed": {
          const record = this.state.toolCallHistory.find((t) => t.name === mappedEvent.toolName);
          if (record) record.totalDurationMs += mappedEvent.durationMs;
          break;
        }
        default:
          break;
      }
      this.emit(mappedEvent);
    }

    if (mapped.ended) {
      // Belt-and-braces: a top-level ended/status:completed without a done
      // event still settles the run so the UI never stays "running".
      if (!this.runSettled) {
        this.runSettled = true;
        this.state.status = "idle";
        this.emit({ type: "status", message: "Agent finished." });
      }
    }
  }

  /** Ensure a per-tool aggregate entry exists and count one invocation. */
  private recordToolStart(toolName: string): void {
    const record = this.state.toolCallHistory.find((t) => t.name === toolName);
    if (record) record.count += 1;
    else this.state.toolCallHistory.push({ name: toolName, count: 1, totalDurationMs: 0 });
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) { try { listener(event); } catch (listenerError) { console.error("[agent-runtime] listener error:", listenerError); } }
  }
}


function normalizeUsage(raw: unknown): RuntimeUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  return {
    inputTokens: (u.inputTokens as number) ?? 0,
    outputTokens: (u.outputTokens as number) ?? 0,
    cacheReadTokens: (u.cacheReadTokens as number) ?? 0,
    cacheWriteTokens: (u.cacheWriteTokens as number) ?? 0,
    totalCost: u.totalCost as number | undefined,
  };
}
