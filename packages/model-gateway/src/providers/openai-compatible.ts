/**
 * @codepilot/model-gateway — OpenAICompatibleProvider
 *
 * A provider for any OpenAI-compatible REST API endpoint.
 *
 * This includes:
 *   - OpenAI itself (api.openai.com/v1)
 *   - Local OpenAI-compatible servers (LM Studio, llama.cpp, vLLM, etc.)
 *   - Enterprise AI gateways that speak the OpenAI Chat Completions protocol
 *
 * Generation is routed through the runtime's @codepilot/llm adapters, which
 * handle the full OpenAI streaming protocol. This package adds:
 *   - Static model catalogue (for known providers like OpenAI)
 *   - Dynamic model discovery via GET /v1/models
 *   - Health check via GET /v1/models (fast, no generation)
 *   - Capability metadata per model
 */

import type {
  ModelProvider,
  DiscoveredModel,
  ProviderHealth,
  ProviderConfig,
  ModelCapabilitySet,
} from "../provider.js";
import {
  normalizeProviderError,
  defaultCapabilitySet,
  redactSecrets,
} from "../provider.js";
import { HEALTH_CHECK_TIMEOUT_MS } from "../config.js";

// ============================================================================
// OpenAI /v1/models API response shapes (private)
// ============================================================================

interface OpenAIModelListResponse {
  object: string;
  data: OpenAIModelObject[];
}

interface OpenAIModelObject {
  id: string;
  object: string;
  created?: number;
  owned_by?: string;
}

// ============================================================================
// Static known model capabilities for popular OpenAI-compatible models
// ============================================================================

const KNOWN_OPENAI_MODEL_CAPABILITIES: Record<
  string,
  Partial<ModelCapabilitySet>
> = {
  "gpt-4o": {
    tools: true,
    vision: true,
    structuredOutput: true,
    reasoning: false,
    functionCalling: true,
    contextWindow: 128_000,
    codingCapability: "excellent",
    recommendedFor: ["coding", "reasoning", "tool_use", "vision"],
    parameterSize: null,
  },
  "gpt-4o-mini": {
    tools: true,
    vision: true,
    structuredOutput: true,
    reasoning: false,
    functionCalling: true,
    contextWindow: 128_000,
    codingCapability: "good",
    recommendedFor: ["coding", "tool_use", "fast"],
    parameterSize: null,
  },
  o3: {
    tools: true,
    vision: false,
    structuredOutput: true,
    reasoning: true,
    functionCalling: true,
    contextWindow: 200_000,
    codingCapability: "excellent",
    recommendedFor: ["coding", "reasoning", "complex_tasks"],
    parameterSize: null,
  },
  "o4-mini": {
    tools: true,
    vision: false,
    structuredOutput: true,
    reasoning: true,
    functionCalling: true,
    contextWindow: 200_000,
    codingCapability: "excellent",
    recommendedFor: ["coding", "reasoning", "fast"],
    parameterSize: null,
  },
};

// ============================================================================
// OpenAICompatibleProvider
// ============================================================================

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly name: string;
  readonly type = "openai-compatible" as const;

  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.name = config.name;
    this.config = config;
  }

  // ---- Discovery ----

  async listModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
    const base = this.baseUrl();
    if (!base) return this.staticModels();

    const effectiveSignal =
      signal ?? AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS * 3);

    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
      };
      if (this.config.apiKey) {
        headers["Authorization"] = `Bearer ${this.config.apiKey}`;
      }

      const response = await fetch(`${base}/models`, {
        signal: effectiveSignal,
        headers,
      });

      if (!response.ok) {
        // Fall back to static list if discovery fails
        return this.staticModels();
      }

      const data = (await response.json()) as OpenAIModelListResponse;
      if (!Array.isArray(data.data)) return this.staticModels();

      return data.data.map((m) => this.toDiscoveredModel(m));
    } catch {
      // Discovery is best-effort; fall back to static list
      return this.staticModels();
    }
  }

  async getModel(
    modelId: string,
    signal?: AbortSignal,
  ): Promise<DiscoveredModel | null> {
    const models = await this.listModels(signal);
    return models.find((m) => m.id === modelId) ?? null;
  }

  // ---- Health ----

  async healthCheck(signal?: AbortSignal): Promise<ProviderHealth> {
    const base = this.baseUrl();
    if (!base) {
      return {
        providerId: this.id,
        status: "UNAVAILABLE",
        latencyMs: null,
        error: "No baseUrl configured",
        checkedAt: Date.now(),
      };
    }

    const effectiveSignal =
      signal ?? AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS);
    const start = Date.now();

    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
      };
      if (this.config.apiKey) {
        headers["Authorization"] = `Bearer ${this.config.apiKey}`;
      }

      const response = await fetch(`${base}/models`, {
        signal: effectiveSignal,
        headers,
      });
      const latencyMs = Date.now() - start;

      if (response.status === 401 || response.status === 403) {
        return {
          providerId: this.id,
          status: "DEGRADED",
          latencyMs,
          error: "Authentication failed — check your API key",
          checkedAt: Date.now(),
        };
      }

      if (!response.ok) {
        return {
          providerId: this.id,
          status: "DEGRADED",
          latencyMs,
          error: redactSecrets(
            `HTTP ${response.status} ${response.statusText}`,
          ),
          checkedAt: Date.now(),
        };
      }

      return {
        providerId: this.id,
        status: "HEALTHY",
        latencyMs,
        error: null,
        checkedAt: Date.now(),
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout =
        message.toLowerCase().includes("timeout") ||
        message.toLowerCase().includes("aborted");

      return {
        providerId: this.id,
        status: "UNAVAILABLE",
        latencyMs: isTimeout ? null : latencyMs,
        error: redactSecrets(
          isTimeout
            ? `Health check timed out after ${HEALTH_CHECK_TIMEOUT_MS}ms`
            : message,
        ),
        checkedAt: Date.now(),
      };
    }
  }

  // ---- Capabilities ----

  supportsStreaming(): boolean {
    return true;
  }
  supportsTools(): boolean {
    return true;
  }
  supportsVision(): boolean {
    // Conservatively false; true for specific known models
    return false;
  }
  supportsStructuredOutput(): boolean {
    return false;
  }
  supportsEmbeddings(): boolean {
    return true;
  }

  getCapabilities(modelId: string): ModelCapabilitySet {
    const known = KNOWN_OPENAI_MODEL_CAPABILITIES[modelId];
    if (known) {
      return defaultCapabilitySet({
        streaming: true,
        embeddings: true,
        ...known,
      });
    }

    // Heuristic fallback for unknown models
    const lower = modelId.toLowerCase();
    const isGpt4Family =
      lower.startsWith("gpt-4") ||
      lower.startsWith("o1") ||
      lower.startsWith("o3");
    const isMini = lower.includes("mini");

    return defaultCapabilitySet({
      streaming: true,
      tools: true,
      functionCalling: true,
      structuredOutput: isGpt4Family,
      codingCapability: isGpt4Family && !isMini ? "excellent" : "good",
    });
  }

  // ---- Config ----

  getConfig(): Omit<ProviderConfig, "apiKey"> {
    const { apiKey: _apiKey, ...safe } = this.config;
    return safe;
  }

  updateConfig(patch: Partial<ProviderConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  // ---- Private ----

  private baseUrl(): string {
    return (this.config.baseUrl ?? "").replace(/\/+$/, "");
  }

  private toDiscoveredModel(m: OpenAIModelObject): DiscoveredModel {
    const caps = this.getCapabilities(m.id);
    return {
      id: m.id,
      displayName: m.id,
      providerId: this.id,
      capabilities: caps,
      locallyAvailable: false,
      sizeBytes: null,
      lastModified:
        m.created !== undefined
          ? new Date(m.created * 1000).toISOString()
          : null,
    };
  }

  /** Return statically-known models for this provider (used as fallback). */
  private staticModels(): DiscoveredModel[] {
    // Only return static data for known providers to avoid lying to the user
    if (this.id !== "openai") return [];

    return Object.keys(KNOWN_OPENAI_MODEL_CAPABILITIES).map((id) => ({
      id,
      displayName: id,
      providerId: this.id,
      capabilities: this.getCapabilities(id),
      locallyAvailable: false,
      sizeBytes: null,
      lastModified: null,
    }));
  }

  /**
   * Build a NormalizedProviderError — delegates to the shared utility.
   * Exported for use in tests.
   */
  buildError(err: unknown) {
    return normalizeProviderError(err, this.id);
  }
}
