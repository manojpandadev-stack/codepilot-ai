import { Agent, createBuiltinTools } from "@cline/core";
import type {
  AgentRuntimeConfig,
  AgentRuntimeEvent,
  AgentTool,
  AgentUsage,
} from "@cline/agents";
import type {
  CodePilotAgentConfig,
  AgentEvent,
  AgentEventListener,
} from "./types.js";

/**
 * CodePilotAgent wraps the Cline AgentRuntime (Agent) class directly.
 */
export class CodePilotAgent {
  private agent: Agent | null = null;
  private listeners = new Set<AgentEventListener>();
  private usage: AgentUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  constructor(private readonly config: CodePilotAgentConfig) {}

  async initialize(): Promise<void> {
    const tools: AgentTool[] = [];
    if (this.config.enableTools !== false) {
      tools.push(
        ...createBuiltinTools({
          cwd: this.config.workspaceRoot,
          enableBash: true,
          enableWebFetch: this.config.privacyMode !== "local",
        }),
      );
    }
    if (this.config.extraTools) tools.push(...this.config.extraTools);

    this.agent = new Agent({
      providerId: this.config.providerId,
      modelId: this.config.modelId,
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
      systemPrompt: this.buildSystemPrompt(),
      tools,
      maxIterations: this.config.maxIterations ?? 50,
      hooks: {
        onEvent: (event: AgentRuntimeEvent) => this.handleAgentEvent(event),
      },
    } as AgentRuntimeConfig);
  }

  async run(message: string): Promise<{ text: string; usage: AgentUsage }> {
    if (!this.agent) throw new Error("Agent not initialized.");
    const result = await this.agent.run(message);
    this.usage = result.usage;
    return { text: result.outputText, usage: result.usage };
  }

  async continue(
    message?: string,
  ): Promise<{ text: string; usage: AgentUsage }> {
    if (!this.agent) throw new Error("Agent not initialized.");
    const result = await this.agent.continue(message);
    this.usage = result.usage;
    return { text: result.outputText, usage: result.usage };
  }

  abort(): void {
    this.agent?.abort();
    this.emit({ type: "cancelled" });
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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

  private handleAgentEvent(event: AgentRuntimeEvent): void {
    switch (event.type) {
      case "assistant-text-delta":
        this.emit({
          type: "text_delta",
          text: event.text,
          accumulated: event.accumulatedText,
        });
        break;
      case "assistant-reasoning-delta":
        this.emit({
          type: "reasoning_delta",
          text: event.text,
          accumulated: event.accumulatedText,
        });
        break;
      case "tool-started":
        this.emit({
          type: "tool_started",
          toolCallId: event.toolCall.toolCallId,
          toolName: event.toolCall.toolName,
        });
        break;
      case "tool-finished":
        this.emit({
          type: "tool_completed",
          toolCallId: event.toolCall.toolCallId,
          toolName: event.toolCall.toolName,
          output: null,
          durationMs: 0,
        });
        break;
      case "usage-updated":
        this.usage = event.usage;
        break;
      case "run-finished":
        this.emit({
          type: "completed",
          result: event.result.outputText,
          usage: event.result.usage,
        });
        break;
      case "run-failed":
        this.emit({
          type: "error",
          error: event.error.message,
          recoverable: false,
        });
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
