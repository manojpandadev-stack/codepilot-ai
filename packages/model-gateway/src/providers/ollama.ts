/**
 * @codepilot/model-gateway — OllamaProvider
 *
 * Implements ModelProvider for the Ollama local inference server.
 *
 * Responsibility split:
 *   - Generation: routed through the CodePilot runtime's @codepilot/llm
 *     provider adapters (this class is discovery/health/capability only).
 *   - Discovery (/api/tags): this class, with typed model metadata.
 *   - Health check: this class, using a simple /api/tags probe.
 *   - Capability metadata: this class, using KNOWN_OLLAMA_MODEL_CAPABILITIES
 *     as a lookup with per-model fallback heuristics.
 */

import type {
  ModelProvider,
  DiscoveredModel,
  ProviderHealth,
} from "../provider.js";
import {
  normalizeProviderError,
  defaultCapabilitySet,
  redactSecrets,
} from "../provider.js";
import type { ProviderConfig, ModelCapabilitySet } from "../provider.js";
import {
  OLLAMA_DEFAULT_BASE_URL,
  KNOWN_OLLAMA_MODEL_CAPABILITIES,
  HEALTH_CHECK_TIMEOUT_MS,
} from "../config.js";

// ============================================================================
// Ollama REST API response shapes (private — used only for parsing)
// ============================================================================

interface OllamaTagsResponse {
  models: OllamaModelEntry[];
}

interface OllamaModelEntry {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  details?: {
    parent_model?: string;
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
    context_length?: number;
  };
  capabilities?: string[];
}

// ============================================================================
// OllamaProvider
// ============================================================================

export class OllamaProvider implements ModelProvider {
  readonly id: string;
  readonly name: string;
  readonly type = "ollama" as const;

  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.name = config.name;
    this.config = {
      ...config,
      baseUrl: config.baseUrl ?? OLLAMA_DEFAULT_BASE_URL,
    };
  }

  // ---- Discovery ----

  async listModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
    const baseUrl = this.baseUrl();
    const effectiveSignal =
      signal ?? AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS * 3);

    let data: OllamaTagsResponse;
    try {
      const response = await fetch(`${baseUrl}/api/tags`, {
        signal: effectiveSignal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      data = (await response.json()) as OllamaTagsResponse;
    } catch (err) {
      const normalized = normalizeProviderError(err, this.id);
      throw Object.assign(new Error(normalized.message), {
        code: normalized.code,
        retryable: normalized.retryable,
        cause: normalized.cause,
      });
    }

    if (!Array.isArray(data.models)) return [];

    return data.models.map((m) => this.toDiscoveredModel(m));
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
    const baseUrl = this.baseUrl();
    const effectiveSignal =
      signal ?? AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS);
    const start = Date.now();

    try {
      const response = await fetch(`${baseUrl}/api/tags`, {
        signal: effectiveSignal,
        headers: { Accept: "application/json" },
      });
      const latencyMs = Date.now() - start;

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

      const data = (await response.json()) as OllamaTagsResponse;
      const modelCount = Array.isArray(data.models) ? data.models.length : 0;

      return {
        providerId: this.id,
        status: "HEALTHY",
        latencyMs,
        error: modelCount === 0 ? "No models installed" : null,
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
    return true; // depends on model; conservatively true
  }
  supportsVision(): boolean {
    return false; // per-model; false at provider level
  }
  supportsStructuredOutput(): boolean {
    return false;
  }
  supportsEmbeddings(): boolean {
    return true; // Ollama supports /api/embeddings
  }

  getCapabilities(modelId: string): ModelCapabilitySet {
    const known = KNOWN_OLLAMA_MODEL_CAPABILITIES[modelId];
    if (known) {
      return {
        streaming: true,
        tools: known.tools,
        vision: known.vision,
        structuredOutput: false,
        embeddings: true,
        reasoning: known.reasoning,
        functionCalling: known.tools,
        contextWindow: known.contextWindow,
        maxOutputTokens: null,
        estimatedMemoryMB: known.estimatedMemoryMB,
        codingCapability: known.codingCapability,
        recommendedFor: known.recommendedFor,
        parameterSize: known.parameterSize,
      };
    }

    // Heuristic fallback for unknown models
    const lower = modelId.toLowerCase();
    const isQwen3 = lower.startsWith("qwen3");
    const isCoder =
      lower.includes("coder") ||
      lower.includes("code") ||
      lower.includes("deepseek");
    const isMistral = lower.startsWith("mistral");

    return defaultCapabilitySet({
      streaming: true,
      tools: isQwen3 || isMistral,
      reasoning: isQwen3,
      functionCalling: isQwen3 || isMistral,
      codingCapability: isCoder ? "good" : isQwen3 ? "good" : "fair",
      recommendedFor: isCoder ? ["coding"] : ["chat"],
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
    return (this.config.baseUrl ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  private toDiscoveredModel(m: OllamaModelEntry): DiscoveredModel {
    const caps = this.getCapabilities(m.name);
    const paramSize = m.details?.parameter_size ?? caps.parameterSize ?? null;
    const contextWindow = m.details?.context_length ?? caps.contextWindow;

    const isQwen3 = m.name.toLowerCase().startsWith("qwen3");
    const isMistral = m.name.toLowerCase().startsWith("mistral");

    return {
      id: m.name,
      displayName: m.name,
      providerId: this.id,
      capabilities: {
        ...caps,
        tools: caps.tools || isQwen3 || isMistral,
        reasoning: caps.reasoning || isQwen3,
        contextWindow,
        parameterSize: paramSize,
        estimatedMemoryMB:
          caps.estimatedMemoryMB ??
          (m.size ? Math.round(m.size / (1024 * 1024)) : null),
      },
      locallyAvailable: true,
      sizeBytes: m.size ?? null,
      lastModified: m.modified_at ?? null,
    };
  }
}
