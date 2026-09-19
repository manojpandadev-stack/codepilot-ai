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

  constructor(private readonly config: CodePilotAgentConfig) {}

  async initialize(): Promise<void> {
    // Resolve the native provider for this session's config. The registry
    // throws for remote providers without credentials — a permanent,
    // user-actionable failure.
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
  }

  async run(message: string): Promise<{ text: string; usage: AgentUsage }> {
    return this.execute(message);
  }

  async continue(
    message?: string,
  ): Promise<{ text: string; usage: AgentUsage }> {
    return this.execute(message ?? "Continue.");
  }

  private async execute(
    message: string,
  ): Promise<{ text: string; usage: AgentUsage }> {
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
      return { text: result.text, usage: result.usage };
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
