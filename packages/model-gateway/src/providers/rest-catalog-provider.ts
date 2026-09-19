/**
 * @codepilot/model-gateway — RestCatalogProvider
 *
 * Abstract base class for providers whose model catalogue is available over a
 * simple REST endpoint. It implements the full ModelProvider contract for
 * discovery (listModels/getModel), health checks, capability metadata and
 * configuration management, so concrete cloud providers only need to supply:
 *
 *   - how to build the list URL and headers
 *   - how to parse the response body into model descriptors
 *   - a static fallback catalogue used when discovery is unavailable
 *   - capability metadata / heuristics per model id
 *
 * Generation is NEVER implemented here — the agent runtime routes it
 * through its @codepilot/llm adapters, exactly as for Ollama and
 * OpenAI-compatible providers.
 */

import type {
  ModelProvider,
  DiscoveredModel,
  ProviderHealth,
  ProviderConfig,
  ModelCapabilitySet,
  ProviderType,
} from "../provider.js";
import {
  normalizeProviderError,
  defaultCapabilitySet,
  redactSecrets,
} from "../provider.js";
import { HEALTH_CHECK_TIMEOUT_MS } from "../config.js";

// ============================================================================
// Descriptor
// ============================================================================

/** A parsed model descriptor returned by a concrete provider's parser. */
export interface CatalogModelDescriptor {
  id: string;
  displayName?: string;
  /** Unix seconds (OpenAI-style) or ISO string — normalized by the base. */
  createdAt?: number | string | null;
  contextWindow?: number | null;
}

/**
 * Everything a concrete REST-catalog provider must describe.
 * No secrets ever appear here — headers are built from config at call time.
 */
export interface RestCatalogDescriptor {
  /** Default base URL when the config does not override it. */
  defaultBaseUrl: string;
  /** Path appended to the base URL for model discovery (e.g. "/v1/models"). */
  listPath: string;
  /** Whether discovery requires an API key to succeed. */
  requiresApiKey: boolean;
  /** Human-readable auth scheme name used in error messages (never values). */
  authScheme: string;
  /** Build request headers from config. Must never log header values. */
  buildHeaders(config: ProviderConfig): Record<string, string>;
  /** Parse a discovery response body into model descriptors. */
  parseModels(body: unknown, config: ProviderConfig): CatalogModelDescriptor[];
  /** Statically-known model ids used when discovery fails (may be empty). */
  fallbackModels: string[];
  /** Known capability overrides per model id. */
  knownCapabilities: Record<string, Partial<ModelCapabilitySet>>;
  /** Heuristic capabilities for unknown model ids (optional). */
  heuristicCapabilities?(modelId: string): Partial<ModelCapabilitySet>;
  /** Provider-level capability flags. */
  providerSupports: {
    streaming: boolean;
    tools: boolean;
    vision: boolean;
    structuredOutput: boolean;
    embeddings: boolean;
  };
}

// ============================================================================
// RestCatalogProvider
// ============================================================================

export abstract class RestCatalogProvider implements ModelProvider {
  readonly id: string;
  readonly name: string;
  abstract readonly type: ProviderType;

  protected config: ProviderConfig;
  private readonly descriptor: RestCatalogDescriptor;

  constructor(config: ProviderConfig, descriptor: RestCatalogDescriptor) {
    this.id = config.id;
    this.name = config.name;
    this.config = {
      ...config,
      baseUrl: config.baseUrl || descriptor.defaultBaseUrl,
    };
    this.descriptor = descriptor;
  }

  // ---- Discovery ----

  async listModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
    const base = this.baseUrl();
    if (!base) return this.staticModels();

    const effectiveSignal =
      signal ?? AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS * 3);

    let body: unknown;
    try {
      const response = await fetch(`${base}${this.descriptor.listPath}`, {
        signal: effectiveSignal,
        headers: {
          Accept: "application/json",
          ...this.descriptor.buildHeaders(this.config),
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      body = await response.json();
    } catch (err) {
      if (signal?.aborted) {
        const normalized = normalizeProviderError(err, this.id);
        throw Object.assign(new Error(normalized.message), {
          code: normalized.code,
          retryable: normalized.retryable,
          cause: normalized.cause,
        });
      }
      // Discovery is best-effort: fall back to the static catalogue rather
      // than failing the whole model listing (matches the OpenAI-compatible
      // provider behavior for known cloud providers).
      return this.staticModels();
    }

    if (this.descriptor.requiresApiKey && !this.config.apiKey) {
      // Some endpoints return unauthenticated results; never show a catalogue
      // that generation cannot actually use.
      return this.staticModels();
    }

    const parsed = this.descriptor.parseModels(body, this.config);
    return parsed
      .filter((m) => m.id && typeof m.id === "string")
      .map((m) => this.toDiscoveredModel(m));
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

    const start = Date.now();
    const effectiveSignal =
      signal ?? AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS);
    try {
      const response = await fetch(`${base}${this.descriptor.listPath}`, {
        signal: effectiveSignal,
        headers: {
          Accept: "application/json",
          ...this.descriptor.buildHeaders(this.config),
        },
      });
      const latencyMs = Date.now() - start;
      if (response.status === 401 || response.status === 403) {
        return {
          providerId: this.id,
          status: "UNAVAILABLE",
          latencyMs,
          error: redactSecrets(
            `Authentication failed (HTTP ${response.status}) — check the API key`,
          ),
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
    return this.descriptor.providerSupports.streaming;
  }
  supportsTools(): boolean {
    return this.descriptor.providerSupports.tools;
  }
  supportsVision(): boolean {
    return this.descriptor.providerSupports.vision;
  }
  supportsStructuredOutput(): boolean {
    return this.descriptor.providerSupports.structuredOutput;
  }
  supportsEmbeddings(): boolean {
    return this.descriptor.providerSupports.embeddings;
  }

  getCapabilities(modelId: string): ModelCapabilitySet {
    const known = this.descriptor.knownCapabilities[modelId];
    const base: Partial<ModelCapabilitySet> =
      known ?? this.descriptor.heuristicCapabilities?.(modelId) ?? {};
    return defaultCapabilitySet({
      streaming: this.descriptor.providerSupports.streaming,
      ...base,
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

  // ---- Protected helpers for subclasses ----

  protected baseUrl(): string {
    return (this.config.baseUrl ?? "").replace(/\/+$/, "");
  }

  protected toDiscoveredModel(m: CatalogModelDescriptor): DiscoveredModel {
    return {
      id: m.id,
      displayName: m.displayName ?? m.id,
      providerId: this.id,
      capabilities: this.getCapabilities(m.id),
      locallyAvailable: false,
      sizeBytes: null,
      lastModified:
        typeof m.createdAt === "number"
          ? new Date(m.createdAt * 1000).toISOString()
          : (m.createdAt ?? null),
    };
  }

  /** Static catalogue entries for when discovery is unavailable. */
  protected staticModels(): DiscoveredModel[] {
    return this.descriptor.fallbackModels.map((id) => ({
      id,
      displayName: id,
      providerId: this.id,
      capabilities: this.getCapabilities(id),
      locallyAvailable: false,
      sizeBytes: null,
      lastModified: null,
    }));
  }

  /** Normalized error builder shared by all REST-catalog providers. */
  protected buildError(err: unknown) {
    return normalizeProviderError(err, this.id);
  }
}
