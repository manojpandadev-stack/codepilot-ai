/**
 * @codepilot/model-gateway
 *
 * Provider abstraction layer for CodePilot AI.
 * Wraps the Cline LLMs gateway and adds CodePilot-specific provider
 * management, model discovery, and configuration.
 */

import { createGateway, DefaultGateway } from "@cline/llms";
import type { GatewayModelDefinition } from "@cline/shared";
import {
  OLLAMA_DEFAULT_BASE_URL,
  type ModelInfo,
} from "@codepilot/shared";

// ============================================================================
// Provider Registry
// ============================================================================

export interface ProviderRegistration {
  id: string;
  name: string;
  type: "local" | "cloud";
  baseUrl?: string;
  apiKeyRequired: boolean;
  defaultModel?: string;
  connected: boolean;
  models: ModelInfo[];
}

/**
 * Manages available providers and their configurations.
 */
export class ProviderRegistry {
  private providers = new Map<string, ProviderRegistration>();
  private gateway: DefaultGateway;

  constructor() {
    this.gateway = createGateway();
    this.registerDefaults();
  }

  /**
   * Register built-in providers.
   */
  private registerDefaults(): void {
    this.register({
      id: "ollama",
      name: "Ollama (Local)",
      type: "local",
      baseUrl: OLLAMA_DEFAULT_BASE_URL,
      apiKeyRequired: false,
      connected: false,
      models: [],
    });

    this.register({
      id: "openai",
      name: "OpenAI",
      type: "cloud",
      apiKeyRequired: true,
      connected: false,
      models: [
        { id: "gpt-4o", name: "GPT-4o", provider: "openai", contextWindow: 128_000, capabilities: ["coding", "reasoning", "tool_use"] },
        { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai", contextWindow: 128_000, capabilities: ["coding", "tool_use"] },
        { id: "o3", name: "o3", provider: "openai", contextWindow: 200_000, capabilities: ["coding", "reasoning", "tool_use"] },
      ],
    });

    this.register({
      id: "anthropic",
      name: "Anthropic",
      type: "cloud",
      apiKeyRequired: true,
      connected: false,
      models: [
        { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic", contextWindow: 200_000, capabilities: ["coding", "reasoning", "tool_use", "long_context"] },
        { id: "claude-opus-4-1", name: "Claude Opus 4", provider: "anthropic", contextWindow: 200_000, capabilities: ["coding", "reasoning", "tool_use", "long_context"] },
      ],
    });

    this.register({
      id: "google",
      name: "Google Gemini",
      type: "cloud",
      apiKeyRequired: true,
      connected: false,
      models: [
        { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google", contextWindow: 1_000_000, capabilities: ["coding", "reasoning", "tool_use", "long_context", "vision"] },
        { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "google", contextWindow: 1_000_000, capabilities: ["coding", "tool_use", "speed"] },
      ],
    });

    this.register({
      id: "bedrock",
      name: "AWS Bedrock",
      type: "cloud",
      apiKeyRequired: true,
      connected: false,
      models: [],
    });

    this.register({
      id: "mistral",
      name: "Mistral",
      type: "cloud",
      apiKeyRequired: true,
      connected: false,
      models: [
        { id: "codestral-latest", name: "Codestral", provider: "mistral", contextWindow: 32_000, capabilities: ["coding", "tool_use"] },
      ],
    });
  }

  /**
   * Register a new provider.
   */
  register(provider: ProviderRegistration): void {
    this.providers.set(provider.id, provider);

    // Register with Cline gateway (cast to bypass SDK type resolution issues)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.gateway.registerProvider({
      id: provider.id,
      name: provider.name,
      defaultModelId: provider.defaultModel ?? "",
      models: provider.models.map((m) => ({
        id: m.id,
        name: m.name,
        providerId: provider.id,
        contextWindow: m.contextWindow,
        capabilities: m.capabilities as unknown as GatewayModelDefinition["capabilities"],
      })),
    } as any);
  }

  /**
   * Get a provider by ID.
   */
  get(id: string): ProviderRegistration | undefined {
    return this.providers.get(id);
  }

  /**
   * List all registered providers.
   */
  list(): ProviderRegistration[] {
    return Array.from(this.providers.values());
  }

  /**
   * Get all models for a provider.
   */
  getModels(providerId: string): ModelInfo[] {
    return this.providers.get(providerId)?.models ?? [];
  }

  /**
   * Get all available models across all providers.
   */
  getAllModels(): ModelInfo[] {
    const models: ModelInfo[] = [];
    for (const provider of this.providers.values()) {
      models.push(...provider.models);
    }
    return models;
  }

  /**
   * Configure a provider.
   */
  configure(providerId: string, config: Partial<ProviderRegistration>): void {
    const existing = this.providers.get(providerId);
    if (existing) {
      this.providers.set(providerId, { ...existing, ...config });
    }
  }

  /**
   * Get the underlying Cline gateway.
   */
  getGateway(): DefaultGateway {
    return this.gateway;
  }
}

// ============================================================================
// Ollama Client
// ============================================================================

export interface OllamaModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  details: {
    parent_model: string;
    format: string;
    family: string;
    families: string[];
    parameter_size: string;
    quantization_level: string;
    context_length: number;
    embedding_length: number;
  };
  capabilities: string[];
}

export interface OllamaTagsResponse {
  models: OllamaModel[];
}

/**
 * Client for the Ollama local inference server.
 */
export class OllamaClient {
  private baseUrl: string;
  private abortController: AbortController | null = null;

  constructor(baseUrl: string = OLLAMA_DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /**
   * Check if Ollama is available.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * List all available models.
   */
  async listModels(): Promise<OllamaModel[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const data = (await response.json()) as OllamaTagsResponse;
    return data.models;
  }

  /**
   * Convert Ollama models to CodePilot ModelInfo.
   */
  async getModelInfos(): Promise<ModelInfo[]> {
    const models = await this.listModels();
    return models
      .filter((m) => m.capabilities.includes("completion"))
      .map((m) => ({
        id: m.name,
        name: m.name,
        provider: "ollama",
        contextWindow: m.details.context_length,
        capabilities: m.capabilities,
      }));
  }

  /**
   * Generate a chat completion (streaming).
   */
  async *chat(
    model: string,
    messages: Array<{ role: string; content: string }>,
    options?: {
      temperature?: number;
      numPredict?: number;
      keepAlive?: string;
      stream?: boolean;
    }
  ): AsyncGenerator<{ role: string; content: string; done: boolean }> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: options?.stream !== false,
        options: {
          temperature: options?.temperature,
          num_predict: options?.numPredict,
        },
        keep_alive: options?.keepAlive,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama chat error: ${response.status}`);
    }

    if (!response.body) {
      throw new Error("No response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as {
              message?: { role: string; content: string };
              done: boolean;
            };
            if (parsed.message) {
              yield {
                role: parsed.message.role,
                content: parsed.message.content,
                done: parsed.done,
              };
            }
          } catch {
            // skip malformed lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Cancel any in-flight request.
   */
  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  /**
   * Update the base URL.
   */
  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, "");
  }
}

// ============================================================================
// Model Capability Router
// ============================================================================

export type TaskComplexity = "simple" | "moderate" | "complex";

/**
 * Routes tasks to appropriate models based on capability requirements.
 */
export class ModelCapabilityRouter {
  constructor(private registry: ProviderRegistry) {}

  /**
   * Select the best model for a given task.
   */
  selectModel(options: {
    taskType: "coding" | "reasoning" | "review" | "planning";
    complexity: TaskComplexity;
    privacyMode: "local" | "hybrid" | "cloud";
    preferredProvider?: string;
    preferredModel?: string;
  }): { providerId: string; modelId: string } | null {
    const { taskType, complexity, privacyMode, preferredProvider, preferredModel } = options;

    // If a specific model is preferred, use it
    if (preferredProvider && preferredModel) {
      const provider = this.registry.get(preferredProvider);
      if (provider?.models.some((m) => m.id === preferredModel)) {
        return { providerId: preferredProvider, modelId: preferredModel };
      }
    }

    // Local-only mode: only use Ollama
    if (privacyMode === "local") {
      const ollama = this.registry.get("ollama");
      if (ollama?.connected && ollama.models.length > 0) {
        // Prefer coding models for coding tasks
        const codingModel = ollama.models.find(
          (m) => m.id.includes("coder") || m.id.includes("code")
        );
        const selected = codingModel ?? ollama.models[0]!;
        return { providerId: "ollama", modelId: selected.id };
      }
      return null;
    }

    // Cloud/hybrid: route based on task requirements
    if (complexity === "complex" || taskType === "reasoning") {
      // Use the most capable model
      const anthropic = this.registry.get("anthropic");
      if (anthropic?.connected && anthropic.models.length > 0) {
        return { providerId: "anthropic", modelId: anthropic.models[0]!.id };
      }
      const openai = this.registry.get("openai");
      if (openai?.connected && openai.models.length > 0) {
        return { providerId: "openai", modelId: openai.models[0]!.id };
      }
    }

    // Simple tasks: use fast model
    const ollama = this.registry.get("ollama");
    if (ollama?.connected && ollama.models.length > 0) {
      return { providerId: "ollama", modelId: ollama.models[0]!.id };
    }

    return null;
  }
}
