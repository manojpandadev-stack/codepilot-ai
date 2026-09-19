/**
 * @codepilot/model-gateway — ProviderRegistry
 *
 * Central registry for all configured providers. Responsibilities:
 *   - Register / unregister providers
 *   - Prevent duplicate registration
 *   - Resolve provider/model pairs
 *   - Cache model discovery results (TTL-based)
 *   - Cache health check results (TTL-based)
 *   - Provider fallback chains
 *   - Structured observability logging (no secrets)
 */

import type {
  ModelProvider,
  DiscoveredModel,
  ProviderHealth,
  ProviderConfig,
} from "./provider.js";
import { MODEL_DISCOVERY_CACHE_TTL_MS, HEALTH_CACHE_TTL_MS } from "./config.js";
import { createBuiltinProviders } from "./provider-factory.js";

// ============================================================================
// Types
// ============================================================================

export interface ModelResolution {
  provider: ModelProvider;
  model: DiscoveredModel;
}

export interface FallbackResult<T> {
  value: T;
  usedProviderId: string;
  /** True when a fallback provider was used instead of the primary. */
  fell_back: boolean;
}

export interface ProviderRegistryEvent {
  type:
    | "PROVIDER_REGISTERED"
    | "PROVIDER_UNREGISTERED"
    | "PROVIDER_ENABLED"
    | "PROVIDER_DISABLED"
    | "MODEL_DISCOVERY_STARTED"
    | "MODEL_DISCOVERY_COMPLETED"
    | "MODEL_DISCOVERY_FAILED"
    | "HEALTH_CHECK_STARTED"
    | "HEALTH_CHECK_COMPLETED"
    | "PROVIDER_FALLBACK";
  providerId: string;
  timestamp: number;
  detail?: string;
}

export type RegistryEventListener = (event: ProviderRegistryEvent) => void;

// ============================================================================
// Cache entries
// ============================================================================

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

// ============================================================================
// ProviderRegistry
// ============================================================================

/**
 * Central registry for ModelProvider instances.
 *
 * Thread-safety note: JavaScript is single-threaded so Map mutations are
 * safe. Async discovery/health calls may race; cache stamps prevent stale
 * data from replacing fresher results.
 */
export class ProviderRegistry {
  private providers = new Map<string, ModelProvider>();
  private discoveryCache = new Map<string, CacheEntry<DiscoveredModel[]>>();
  private healthCache = new Map<string, CacheEntry<ProviderHealth>>();
  private listeners = new Set<RegistryEventListener>();
  private discoveryTtlMs: number;
  private healthTtlMs: number;

  constructor(options?: { discoveryTtlMs?: number; healthTtlMs?: number }) {
    this.discoveryTtlMs =
      options?.discoveryTtlMs ?? MODEL_DISCOVERY_CACHE_TTL_MS;
    this.healthTtlMs = options?.healthTtlMs ?? HEALTH_CACHE_TTL_MS;
  }

  // ---- Registration ----

  /**
   * Register a provider.
   * @throws if a provider with the same id is already registered.
   */
  register(provider: ModelProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(
        `Provider "${provider.id}" is already registered. Unregister it first.`,
      );
    }
    this.providers.set(provider.id, provider);
    this.emit({
      type: "PROVIDER_REGISTERED",
      providerId: provider.id,
      timestamp: Date.now(),
      detail: `type=${provider.type}`,
    });
  }

  /**
   * Unregister a provider and clear its caches.
   * No-op if the provider is not registered.
   */
  unregister(providerId: string): void {
    if (!this.providers.has(providerId)) return;
    this.providers.delete(providerId);
    this.discoveryCache.delete(providerId);
    this.healthCache.delete(providerId);
    this.emit({
      type: "PROVIDER_UNREGISTERED",
      providerId,
      timestamp: Date.now(),
    });
  }

  /**
   * Re-register a provider, replacing any existing entry.
   */
  registerOrReplace(provider: ModelProvider): void {
    if (this.providers.has(provider.id)) {
      this.unregister(provider.id);
    }
    this.register(provider);
  }

  // ---- Lookup ----

  /**
   * Get a registered provider by id. Returns undefined if not found.
   */
  get(providerId: string): ModelProvider | undefined {
    return this.providers.get(providerId);
  }

  /**
   * List all registered providers.
   */
  list(): ModelProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * List all enabled providers (i.e. those whose config.enabled === true).
   */
  listEnabled(): ModelProvider[] {
    return this.list().filter((p) => p.getConfig().enabled);
  }

  // ---- Model discovery ----

  /**
   * List models for a provider, using the TTL-based cache.
   * Cache is bypassed when `forceRefresh` is true.
   */
  async listModels(
    providerId: string,
    options?: { forceRefresh?: boolean; signal?: AbortSignal },
  ): Promise<DiscoveredModel[]> {
    const provider = this.providers.get(providerId);
    if (!provider) return [];

    const cached = this.discoveryCache.get(providerId);
    if (!options?.forceRefresh && cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    this.emit({
      type: "MODEL_DISCOVERY_STARTED",
      providerId,
      timestamp: Date.now(),
    });

    try {
      const models = await provider.listModels(options?.signal);
      this.discoveryCache.set(providerId, {
        value: models,
        expiresAt: Date.now() + this.discoveryTtlMs,
      });
      this.emit({
        type: "MODEL_DISCOVERY_COMPLETED",
        providerId,
        timestamp: Date.now(),
        detail: `discovered ${models.length} models`,
      });
      return models;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit({
        type: "MODEL_DISCOVERY_FAILED",
        providerId,
        timestamp: Date.now(),
        detail: msg.slice(0, 200),
      });
      return [];
    }
  }

  /**
   * List all models across all enabled providers.
   */
  async listAllModels(options?: {
    forceRefresh?: boolean;
    signal?: AbortSignal;
  }): Promise<DiscoveredModel[]> {
    const results = await Promise.all(
      this.listEnabled().map((p) =>
        this.listModels(p.id, options).catch(() => [] as DiscoveredModel[]),
      ),
    );
    return results.flat();
  }

  /**
   * Resolve a specific model by provider + model id.
   * Returns null when provider is not registered or model is not found.
   */
  async resolve(
    providerId: string,
    modelId: string,
    options?: { forceRefresh?: boolean; signal?: AbortSignal },
  ): Promise<ModelResolution | null> {
    const provider = this.providers.get(providerId);
    if (!provider) return null;

    const models = await this.listModels(providerId, options);
    const model = models.find((m) => m.id === modelId);
    if (!model) return null;

    return { provider, model };
  }

  // ---- Health ----

  /**
   * Run a health check for a provider, using the TTL-based cache.
   * Never throws — always returns a ProviderHealth result.
   */
  async healthCheck(
    providerId: string,
    options?: { forceRefresh?: boolean; signal?: AbortSignal },
  ): Promise<ProviderHealth> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      return {
        providerId,
        status: "UNKNOWN",
        latencyMs: null,
        error: `Provider "${providerId}" is not registered`,
        checkedAt: Date.now(),
      };
    }

    const cached = this.healthCache.get(providerId);
    if (!options?.forceRefresh && cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    this.emit({
      type: "HEALTH_CHECK_STARTED",
      providerId,
      timestamp: Date.now(),
    });

    const health = await provider.healthCheck(options?.signal);
    this.healthCache.set(providerId, {
      value: health,
      expiresAt: Date.now() + this.healthTtlMs,
    });
    this.emit({
      type: "HEALTH_CHECK_COMPLETED",
      providerId,
      timestamp: Date.now(),
      detail: `status=${health.status} latency=${health.latencyMs ?? "n/a"}ms`,
    });
    return health;
  }

  /**
   * Run health checks for all enabled providers in parallel.
   */
  async healthCheckAll(options?: {
    forceRefresh?: boolean;
    signal?: AbortSignal;
  }): Promise<Map<string, ProviderHealth>> {
    const results = await Promise.all(
      this.listEnabled().map(async (p) => {
        const health = await this.healthCheck(p.id, options);
        return [p.id, health] as const;
      }),
    );
    return new Map(results);
  }

  // ---- Fallback ----

  /**
   * Try the primary provider; fall back through the fallback chain on failure.
   * Emits PROVIDER_FALLBACK when switching to a fallback.
   *
   * @param primaryId      Primary provider id.
   * @param fallbackIds    Ordered list of fallback provider ids.
   * @param operation      Async function that takes a ModelProvider and returns T.
   */
  async withFallback<T>(
    primaryId: string,
    fallbackIds: string[],
    operation: (provider: ModelProvider) => Promise<T>,
  ): Promise<FallbackResult<T>> {
    const chain = [primaryId, ...fallbackIds];

    for (let i = 0; i < chain.length; i++) {
      const id = chain[i]!;
      const provider = this.providers.get(id);
      if (!provider) continue;

      try {
        const value = await operation(provider);
        if (i > 0) {
          this.emit({
            type: "PROVIDER_FALLBACK",
            providerId: id,
            timestamp: Date.now(),
            detail: `fell back from ${chain[i - 1]} to ${id}`,
          });
        }
        return { value, usedProviderId: id, fell_back: i > 0 };
      } catch (err) {
        // Last in chain — propagate
        if (i === chain.length - 1) throw err;
        // Otherwise try next fallback
        const msg = err instanceof Error ? err.message : String(err);
        this.emit({
          type: "PROVIDER_FALLBACK",
          providerId: id,
          timestamp: Date.now(),
          detail: `error on ${id}: ${msg.slice(0, 100)} — trying next`,
        });
      }
    }

    throw new Error("All providers in fallback chain failed");
  }

  // ---- Config updates ----

  /**
   * Apply a partial configuration patch to a registered provider.
   * Propagates the update to the provider via updateConfig().
   */
  updateProviderConfig(
    providerId: string,
    patch: Partial<ProviderConfig>,
  ): void {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Provider "${providerId}" is not registered`);
    }
    provider.updateConfig(patch);
    // Invalidate caches since config change may affect results
    this.discoveryCache.delete(providerId);
    this.healthCache.delete(providerId);
  }

  // ---- Cache management ----

  /** Invalidate all caches for a provider. */
  invalidateCache(providerId: string): void {
    this.discoveryCache.delete(providerId);
    this.healthCache.delete(providerId);
  }

  /** Invalidate all caches. */
  invalidateAllCaches(): void {
    this.discoveryCache.clear();
    this.healthCache.clear();
  }

  // ---- Observability ----

  subscribe(listener: RegistryEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: ProviderRegistryEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* listeners must not crash the registry */
      }
    }
  }

  // ---- Cleanup ----

  dispose(): void {
    this.discoveryCache.clear();
    this.healthCache.clear();
    this.listeners.clear();
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a ProviderRegistry pre-loaded with Ollama and OpenAI-compatible
 * providers. Both are disabled by default — callers must enable and configure
 * them at startup.
 *
 * @param options.includeBuiltins  Also register every built-in provider
 *   (Anthropic, Google Gemini, OpenRouter, LM Studio, DeepSeek, Mistral,
 *   xAI, Bedrock) from BUILTIN_PROVIDER_DEFAULTS. They are disabled by
 *   default; callers enable them via updateConfig/enableProvider.
 * @param options.apiKeys  Optional provider id → API key map used when
 *   includeBuiltins is true. Never logged.
 */
export function createDefaultRegistry(options?: {
  discoveryTtlMs?: number;
  healthTtlMs?: number;
  includeBuiltins?: boolean;
  apiKeys?: Record<string, string | undefined>;
}): ProviderRegistry {
  const registry = new ProviderRegistry(options);
  if (options?.includeBuiltins) {
    for (const { instance } of createBuiltinProviders({
      apiKeys: options.apiKeys,
    })) {
      registry.register(instance);
    }
  }
  return registry;
}
