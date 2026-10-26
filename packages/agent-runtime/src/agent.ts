import type {
  CodePilotAgentConfig,
  AgentEvent,
  AgentEventListener,
} from "./types.js";
import type { AgentTool, AgentUsage } from "./native/types.js";
import { runAgentLoop } from "./native/engine/agent-loop.js";
import type { AgentLoopEvent } from "./native/engine/agent-loop.js";
import type { ToolGate } from "./native/engine/tool-dispatch.js";
import type { LlmProvider } from "./native/llm/types.js";
import { createLlmProvider } from "./native/llm/registry.js";
import { isRemoteProvider, resolveModelLimits } from "./runtime.js";

/**
 * Terminal outcome of a CodePilotAgent run. `complete` is the ONLY successful
 * outcome — cancellation (`aborted`), a truncated provider turn
 * (`incomplete`), transport failure (`error`) and iteration exhaustion
 * (`max_iterations`) never surface as completion.
 */
export type AgentRunReason =
  "complete" | "aborted" | "error" | "max_iterations" | "incomplete";

export interface AgentRunResult {
  text: string;
  usage: AgentUsage;
  /** Terminal loop outcome — callers must not treat non-complete as success. */
  reason: AgentRunReason;
  error?: string;
}

/**
 * CodePilotAgent — the lightweight agent facade over the native engine.
 *
 * Independently implemented on the CodePilot-owned agent loop and LLM layer.
 * Preserved surface: initialize/run/continue/abort/subscribe/dispose/
 * listenerCount/getUsage, with the same event mapping the orchestrator and
 * CLI-headless consumers rely on.
 */
export class CodePilotAgent {
  private messages: import("./native/types.js").AgentMessage[] = [];
  private listeners = new Set<AgentEventListener>();
  private usage: AgentUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  private provider: LlmProvider | null = null;
  private controller: AbortController | null = null;
  private running = false;
  /** Set when initialize() fails (notably privacy rejection): run() must fail closed. */
  private initFailed: Error | null = null;

  constructor(private readonly config: CodePilotAgentConfig) {}

  async initialize(): Promise<void> {
    // F-01 FAIL-CLOSED: authorize privacy BEFORE constructing/storing any
    // provider. The canonical policy is isRemoteProvider() (runtime.ts):
    // Local Only + remote provider must never become usable.
    if (
      this.config.privacyMode === "local" &&
      isRemoteProvider(this.config.providerId, this.config.baseUrl)
    ) {
      const err = new Error(
        `Privacy violation blocked: provider "${this.config.providerId}" is remote but privacy mode is "local".`,
      );
      this.provider = null;
      this.initFailed = err;
      throw err;
    }
    // Resolve the native provider for this session config. The registry
    // throws for remote providers without credentials — a permanent,
    // user-actionable failure.
    try {
      this.provider = createLlmProvider(
        { providerId: this.config.providerId, modelId: this.config.modelId },
        {
          configs: [
            {
              providerId: this.config.providerId,
              ...(this.config.apiKey ? { apiKey: this.config.apiKey } : {}),
              ...(this.config.baseUrl ? { baseUrl: this.config.baseUrl } : {}),
            },
          ],
        },
      );
    } catch (err) {
      this.provider = null;
      this.initFailed = err instanceof Error ? err : new Error(String(err));
      throw err;
    }
    this.initFailed = null;
  }

  async run(message: string): Promise<AgentRunResult> {
    return this.execute(message);
  }

  async continue(message?: string): Promise<AgentRunResult> {
    return this.execute(message ?? "Continue.");
  }

  private async execute(message: string): Promise<AgentRunResult> {
    // F-01 FAIL-CLOSED: run() must independently reject when effective
    // privacy mode is Local Only with a remote provider, even if the caller
    // caught an initialize() error and calls run() anyway. Do not rely on
    // callers handling initialize() errors.
    if (
      this.config.privacyMode === "local" &&
      isRemoteProvider(this.config.providerId, this.config.baseUrl)
    ) {
      throw new Error(
        `Privacy violation blocked: provider "${this.config.providerId}" is remote but privacy mode is "local".`,
      );
    }
    if (this.initFailed) throw this.initFailed;
    if (!this.provider) throw new Error("Agent not initialized.");
    if (this.running) throw new Error("Agent is already running.");
    this.running = true;
    this.controller = new AbortController();
    const gate: ToolGate = async (request) => {
      if (!this.config.requestApproval) {
        // Fail closed — no permission pipeline configured.
        return {
          approved: false,
          reason:
            "Permission pipeline unavailable — tool execution blocked for safety",
        };
      }
      try {
        return await this.config.requestApproval({
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          input: request.input,
        });
      } catch (err) {
        return {
          approved: false,
          reason: `Permission evaluation failed (deny-closed): ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    };

    // Phase 7 (wiring): effective output-budget limits for the selected
    // model — explicit host config wins, then the curated catalogue.
    const modelLimits = resolveModelLimits(
      this.config.providerId,
      this.config.modelId,
      this.config,
    );
    try {
      const result = await runAgentLoop(
        this.messages,
        message,
        {
          provider: this.provider,
          modelId: this.config.modelId,
          sessionId: "codepilot-agent",
          systemPrompt: this.buildSystemPrompt(),
          tools: (this.config.extraTools ?? []) as AgentTool[],
          gate,
          maxIterations: this.config.maxIterations ?? 50,
          ...(this.config.temperature !== undefined
            ? { temperature: this.config.temperature }
            : {}),
          // H2: remote providers never receive unredacted tool output.
          // Canonical classification (unknown provider → remote → redacted);
          // an explicit host/test override wins.
          redactToolResults:
            this.config.redactToolResults ??
            isRemoteProvider(this.config.providerId, this.config.baseUrl),
          // Phase 7: real model limits bound the output budget — explicit
          // config wins, then the curated catalogue; absent metadata keeps
          // the loop's documented default cap (limits are never invented).
          ...(modelLimits.contextWindow !== undefined
            ? { modelContextWindow: modelLimits.contextWindow }
            : {}),
          ...(modelLimits.maxOutputTokens !== undefined
            ? { maxOutputTokens: modelLimits.maxOutputTokens }
            : {}),
          onEvent: (event: AgentLoopEvent) => this.handleLoopEvent(event),
        },
        this.controller.signal,
      );
      this.usage = result.usage;
      if (result.reason === "error") {
        this.emit({
          type: "error",
          error: result.error ?? "agent run failed",
          recoverable: false,
        });
      }
      if (result.reason === "aborted") {
        this.emit({ type: "cancelled" });
      }
      // F-02/F-03: propagate the terminal outcome verbatim so orchestration
      // can never read a cancelled or truncated run as a completion.
      return {
        text: result.text,
        usage: result.usage,
        reason: result.reason,
        ...(result.error !== undefined ? { error: result.error } : {}),
      };
    } finally {
      this.running = false;
      this.controller = null;
    }
  }

  abort(): void {
    this.controller?.abort();
    this.emit({ type: "cancelled" });
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private disposed = false;

  /**
   * Dispose the agent wrapper: abort in-flight work and drop listeners so
   * completed/cancelled sessions retain nothing. Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.controller?.abort();
    } catch {
      // best effort
    }
    this.listeners.clear();
    this.provider = null;
  }

  /** Number of active listeners (lifecycle introspection for tests). */
  listenerCount(): number {
    return this.listeners.size;
  }

  getUsage(): AgentUsage {
    return { ...this.usage };
  }

  private buildSystemPrompt(): string {
    if (this.config.systemPrompt) {
      return [
        this.config.systemPrompt,
        `\nWorking directory: ${this.config.workspaceRoot}`,
        `Privacy mode: ${this.config.privacyMode}`,
      ].join("\n");
    }
    return [
      "You are CodePilot AI, an expert software engineering assistant.",
      `Working directory: ${this.config.workspaceRoot}`,
      `Privacy mode: ${this.config.privacyMode}`,
      this.config.privacyMode === "local"
        ? "IMPORTANT: LOCAL-ONLY mode. No source code leaves the machine."
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private handleLoopEvent(event: AgentLoopEvent): void {
    switch (event.type) {
      case "text_delta":
        this.emit({
          type: "text_delta",
          text: event.text,
          accumulated: event.accumulated,
        });
        break;
      case "reasoning_delta":
        this.emit({
          type: "reasoning_delta",
          text: event.text,
          accumulated: event.accumulated,
        });
        break;
      case "tool_started":
        this.emit({
          type: "tool_started",
          toolCallId: event.call.toolCallId,
          toolName: event.toolName,
        });
        break;
      case "tool_completed":
        this.emit({
          type: "tool_completed",
          toolCallId: event.call.toolCallId,
          toolName: event.toolName,
          output: event.output,
          durationMs: event.durationMs,
        });
        break;
      case "tool_denied":
        this.emit({
          type: "tool_failed",
          toolCallId: event.call.toolCallId,
          toolName: event.toolName,
          error: event.reason,
        });
        break;
      case "usage":
        this.usage = event.usage;
        break;
      case "finish":
        if (event.reason === "complete") {
          this.emit({
            type: "completed",
            result: event.text,
            usage: event.usage,
          });
        } else if (event.reason === "error") {
          this.emit({
            type: "error",
            error: event.error ?? "agent run failed",
            recoverable: false,
          });
        }
        break;
      default:
        break;
    }
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* don't break */
      }
    }
  }
}
