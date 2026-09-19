/**
 * @codepilot/model-gateway
 *
 * Production-grade provider abstraction layer for CodePilot AI.
 *
 * Architecture:
 *   - ModelProvider interface: provider-independent contracts
 *   - OllamaProvider: Ollama local inference (discovery + health + capabilities)
 *   - OpenAICompatibleProvider: any OpenAI-compatible endpoint
 *   - ProviderRegistry: manages providers, caching, fallback, health checks
 *   - Config helpers: validation, defaults, environment support
 *
 * Generation is routed through the runtime's @codepilot/llm provider
 * adapters — this package handles everything around it (discovery, health,
 * capability metadata, configuration, caching).
 */

// ---- Core types and interface ----
export type {
  ModelProvider,
  ModelCapabilitySet,
  DiscoveredModel,
  ProviderHealth,
  ProviderHealthStatus,
  ProviderConfig,
  ProviderType,
  NormalizedProviderError,
  ProviderErrorCode,
} from "./provider.js";
export {
  defaultCapabilitySet,
  normalizeProviderError,
  redactSecrets,
} from "./provider.js";

// ---- Configuration ----
export {
  OLLAMA_DEFAULT_BASE_URL,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  HEALTH_CHECK_TIMEOUT_MS,
  MODEL_DISCOVERY_CACHE_TTL_MS,
  HEALTH_CACHE_TTL_MS,
  BUILTIN_PROVIDER_IDS,
  BUILTIN_PROVIDER_DEFAULTS,
  KNOWN_OLLAMA_MODEL_CAPABILITIES,
  validateProviderConfig,
  resolveProviderConfig,
  apiKeyFromEnv,
} from "./config.js";
export type { BuiltinProviderId, ConfigValidationResult } from "./config.js";

// ---- Providers ----
export { OllamaProvider } from "./providers/ollama.js";
export { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
export { AnthropicProvider } from "./providers/anthropic.js";
export { GoogleGeminiProvider } from "./providers/google-gemini.js";
export { BedrockProvider } from "./providers/bedrock.js";
export {
  OpenRouterProvider,
  LMStudioProvider,
  DeepSeekProvider,
  MistralProvider,
  XAIProvider,
} from "./providers/openai-cloud-providers.js";
export {
  RestCatalogProvider,
  type RestCatalogDescriptor,
  type CatalogModelDescriptor,
} from "./providers/rest-catalog-provider.js";

// ---- Factory ----
export {
  createProviderFromConfig,
  createBuiltinProviders,
  type BuiltProvider,
} from "./provider-factory.js";

// ---- Registry ----
export { ProviderRegistry, createDefaultRegistry } from "./registry.js";
export type {
  ModelResolution,
  FallbackResult,
  ProviderRegistryEvent,
  RegistryEventListener,
} from "./registry.js";

// ============================================================================
// Convenience factory functions
// ============================================================================

import { OllamaProvider } from "./providers/ollama.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import { ProviderRegistry } from "./registry.js";
import { resolveProviderConfig } from "./config.js";
import type { ProviderConfig } from "./provider.js";

/**
 * Create a ready-to-use ProviderRegistry with Ollama as the default
 * enabled provider. Additional providers can be added via registry.register().
 *
 * @param ollamaBaseUrl  Override Ollama URL (default: http://localhost:11434)
 */
export function createRegistryWithOllama(
  ollamaBaseUrl?: string,
): ProviderRegistry {
  const registry = new ProviderRegistry();
  const ollamaConfig = resolveProviderConfig({
    id: "ollama",
    type: "ollama",
    baseUrl: ollamaBaseUrl,
    enabled: true,
  });
  registry.register(new OllamaProvider(ollamaConfig));
  return registry;
}

/**
 * Create an OllamaProvider from a partial config.
 */
export function createOllamaProvider(
  partial?: Partial<ProviderConfig>,
): OllamaProvider {
  const config = resolveProviderConfig({
    id: "ollama",
    type: "ollama",
    enabled: true,
    ...partial,
  });
  return new OllamaProvider(config);
}

/**
 * Create an OpenAI-compatible provider from a partial config.
 */
export function createOpenAICompatibleProvider(
  partial: Partial<ProviderConfig> & { id: string; baseUrl: string },
): OpenAICompatibleProvider {
  const config = resolveProviderConfig({
    type: "openai-compatible",
    enabled: true,
    ...partial,
  });
  return new OpenAICompatibleProvider(config);
}

// ---- Provider catalogue (single source of truth for the UI) ----
export type {
  CatalogProvider,
  CatalogModel,
  CatalogField,
  CatalogHealthCapability,
  CatalogUsageCapability,
  ProviderCategory,
  ProviderStatus,
} from "./provider-catalog.js";
export {
  getProviderCatalog,
  getCatalogProvider,
  sortCatalog,
  searchCatalog,
} from "./provider-catalog.js";

// ---- Local usage/cost ledger ----
export type { UsageRecord, UsageSummary, UsageStore } from "./usage-ledger.js";
export {
  UsageLedger,
  estimateCost,
  MAX_USAGE_RECORDS,
} from "./usage-ledger.js";
