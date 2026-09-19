/**
 * @codepilot/model-gateway — Provider Configuration
 *
 * Typed configuration with defaults, validation, and environment-variable
 * support. Secrets are never serialized to plain text; callers inject apiKey
 * at runtime (e.g. from VS Code SecretStorage).
 */

import type { ProviderConfig, ProviderType } from "./provider.js";

// ============================================================================
// Defaults
// ============================================================================

/** Never hard-code the Ollama URL in scattered code — import this constant. */
export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";

/** Safe default request timeout for provider calls. */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;

/** Timeout used specifically for health-check probes. */
export const HEALTH_CHECK_TIMEOUT_MS = 5_000;

/** TTL for cached model discovery results. */
export const MODEL_DISCOVERY_CACHE_TTL_MS = 60_000;

/** TTL for cached health-check results. */
export const HEALTH_CACHE_TTL_MS = 15_000;

// ============================================================================
// Built-in provider descriptors
// ============================================================================

/** All known built-in provider IDs. */
export const BUILTIN_PROVIDER_IDS = [
  "ollama",
  "openai",
  "openai-compatible",
  "anthropic",
  "google",
  "openrouter",
  "lmstudio",
  "deepseek",
  "mistral",
  "xai",
  "bedrock",
] as const;

export type BuiltinProviderId = (typeof BUILTIN_PROVIDER_IDS)[number];

/**
 * Factory defaults for each built-in provider.
 * apiKey is intentionally absent — inject at runtime.
 */
export const BUILTIN_PROVIDER_DEFAULTS: Record<
  BuiltinProviderId,
  Omit<ProviderConfig, "apiKey">
> = {
  ollama: {
    id: "ollama",
    name: "Ollama (Local)",
    type: "ollama" as ProviderType,
    baseUrl: OLLAMA_DEFAULT_BASE_URL,
    defaultModelId: "", // dynamically discovered
    timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
    enabled: true,
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    type: "openai-compatible" as ProviderType,
    baseUrl: "https://api.openai.com/v1",
    defaultModelId: "gpt-4o-mini",
    timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
    enabled: false,
  },
  "openai-compatible": {
    id: "openai-compatible",
    name: "OpenAI-Compatible",
    type: "openai-compatible" as ProviderType,
    baseUrl: "", // must be set by user
    defaultModelId: "",
    timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
    enabled: false,
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    type: "anthropic" as ProviderType,
    baseUrl: "https://api.anthropic.com",
    defaultModelId: "claude-sonnet-4-20250514",
    timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
    enabled: false,
  },
  google: {
    id: "google",
    name: "Google Gemini",
    type: "gemini" as ProviderType,
    baseUrl: "https://generativelanguage.googleapis.com",
    defaultModelId: "gemini-2.5-flash",
    timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
    enabled: false,
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    type: "openai-compatible" as ProviderType,
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModelId: "",
    timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
    enabled: false,
  },
  lmstudio: {
    id: "lmstudio",
    name: "LM Studio (Local)",
    type: "openai-compatible" as ProviderType,
    baseUrl: "http://localhost:1234/v1",
    defaultModelId: "", // dynamically discovered
    timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
    enabled: false,
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    type: "openai-compatible" as ProviderType,
    baseUrl: "https://api.deepseek.com/v1",
    defaultModelId: "deepseek-chat",
    timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
    enabled: false,
  },
  mistral: {
    id: "mistral",
    name: "Mistral",
    type: "openai-compatible" as ProviderType,
    baseUrl: "https://api.mistral.ai/v1",
    defaultModelId: "mistral-large-latest",
    timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
    enabled: false,
  },
  xai: {
    id: "xai",
    name: "xAI (Grok)",
    type: "openai-compatible" as ProviderType,
    baseUrl: "https://api.x.ai/v1",
    defaultModelId: "grok-3",
    timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
    enabled: false,
  },
  bedrock: {
    id: "bedrock",
    name: "AWS Bedrock",
    type: "bedrock" as ProviderType,
    defaultModelId: "",
    timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
    enabled: false,
  },
};

// ============================================================================
// Per-model static capability overrides
// ============================================================================

/**
 * Static known-good capability data for popular Ollama models.
 * Used as a fallback when the provider does not expose model details.
 * This object is NOT a runtime model registry — it merely fills capability
 * gaps for well-known models.
 */
export const KNOWN_OLLAMA_MODEL_CAPABILITIES: Record<
  string,
  {
    tools: boolean;
    reasoning: boolean;
    vision: boolean;
    contextWindow: number;
    codingCapability: "excellent" | "good" | "fair" | "poor";
    estimatedMemoryMB: number;
    parameterSize: string;
    recommendedFor: string[];
  }
> = {
  "qwen3:8b": {
    tools: true,
    reasoning: true,
    vision: false,
    contextWindow: 32768,
    codingCapability: "good",
    estimatedMemoryMB: 5200,
    parameterSize: "8B",
    recommendedFor: ["coding", "tool_use", "reasoning"],
  },
  "qwen3:14b": {
    tools: true,
    reasoning: true,
    vision: false,
    contextWindow: 32768,
    codingCapability: "excellent",
    estimatedMemoryMB: 9800,
    parameterSize: "14B",
    recommendedFor: ["coding", "tool_use", "reasoning", "complex_tasks"],
  },
  "qwen3:30b-a3b": {
    tools: true,
    reasoning: true,
    vision: false,
    contextWindow: 32768,
    codingCapability: "excellent",
    estimatedMemoryMB: 18000,
    parameterSize: "30B",
    recommendedFor: ["coding", "tool_use", "reasoning", "complex_tasks"],
  },
  "qwen2.5-coder:7b": {
    tools: false,
    reasoning: false,
    vision: false,
    contextWindow: 32768,
    codingCapability: "good",
    estimatedMemoryMB: 4800,
    parameterSize: "7B",
    recommendedFor: ["coding", "chat"],
  },
  "qwen2.5-coder:3b": {
    tools: false,
    reasoning: false,
    vision: false,
    contextWindow: 32768,
    codingCapability: "fair",
    estimatedMemoryMB: 2400,
    parameterSize: "3B",
    recommendedFor: ["chat", "simple_coding"],
  },
  "qwen2.5-coder:14b": {
    tools: false,
    reasoning: false,
    vision: false,
    contextWindow: 32768,
    codingCapability: "excellent",
    estimatedMemoryMB: 9800,
    parameterSize: "14B",
    recommendedFor: ["coding"],
  },
  "llama3.2:3b": {
    tools: false,
    reasoning: false,
    vision: false,
    contextWindow: 131072,
    codingCapability: "fair",
    estimatedMemoryMB: 2000,
    parameterSize: "3B",
    recommendedFor: ["chat"],
  },
  "llama3.2:1b": {
    tools: false,
    reasoning: false,
    vision: false,
    contextWindow: 131072,
    codingCapability: "poor",
    estimatedMemoryMB: 1000,
    parameterSize: "1B",
    recommendedFor: ["chat"],
  },
  "codellama:13b": {
    tools: false,
    reasoning: false,
    vision: false,
    contextWindow: 16384,
    codingCapability: "good",
    estimatedMemoryMB: 8000,
    parameterSize: "13B",
    recommendedFor: ["coding"],
  },
  "deepseek-coder-v2:16b": {
    tools: false,
    reasoning: false,
    vision: false,
    contextWindow: 163840,
    codingCapability: "excellent",
    estimatedMemoryMB: 10000,
    parameterSize: "16B",
    recommendedFor: ["coding"],
  },
  "mistral:7b": {
    tools: true,
    reasoning: false,
    vision: false,
    contextWindow: 32768,
    codingCapability: "good",
    estimatedMemoryMB: 4500,
    parameterSize: "7B",
    recommendedFor: ["coding", "chat", "tool_use"],
  },
};

// ============================================================================
// Validation
// ============================================================================

export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a ProviderConfig for internal consistency.
 * Does NOT check network reachability — use healthCheck() for that.
 */
export function validateProviderConfig(
  config: ProviderConfig,
): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config.id || config.id.trim().length === 0) {
    errors.push("Provider id must not be empty");
  }
  if (!config.name || config.name.trim().length === 0) {
    errors.push("Provider name must not be empty");
  }
  if (config.type === "openai-compatible" || config.type === "openai") {
    if (!config.baseUrl || config.baseUrl.trim().length === 0) {
      errors.push(
        `Provider "${config.id}" (${config.type}) requires a baseUrl`,
      );
    } else {
      const normalized = config.baseUrl.trim().toLowerCase();
      if (
        !normalized.startsWith("http://") &&
        !normalized.startsWith("https://")
      ) {
        errors.push(
          `Provider "${config.id}" baseUrl must start with http:// or https://`,
        );
      }
      if (
        normalized.startsWith("http://") &&
        !normalized.startsWith("http://localhost") &&
        !normalized.startsWith("http://127.") &&
        !normalized.startsWith("http://0.0.0.0")
      ) {
        warnings.push(
          `Provider "${config.id}" is using an unencrypted http:// URL for a non-localhost address — consider https://`,
        );
      }
    }
  }
  if (config.timeoutMs !== undefined && config.timeoutMs <= 0) {
    errors.push("timeoutMs must be a positive integer");
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Build a fully-resolved ProviderConfig by merging a partial config with
 * the built-in defaults for a given provider type.
 * The returned config will always have all required fields populated.
 */
export function resolveProviderConfig(
  partial: Partial<ProviderConfig> & { id: string; type: ProviderType },
): ProviderConfig {
  const builtinId = partial.id as BuiltinProviderId;
  const defaults =
    BUILTIN_PROVIDER_DEFAULTS[builtinId] ??
    ({
      id: partial.id,
      name: partial.id,
      type: partial.type,
      enabled: true,
      timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
    } satisfies Omit<ProviderConfig, "apiKey">);

  return {
    ...defaults,
    ...partial,
    // Never override with undefined
    name: partial.name ?? defaults.name,
    enabled: partial.enabled ?? defaults.enabled ?? true,
    timeoutMs:
      partial.timeoutMs ?? defaults.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
  };
}

// ============================================================================
// Environment helpers
// ============================================================================

/**
 * Attempt to read an API key from a well-known environment variable.
 * Returns undefined (not null) so callers can use ?? safely.
 * Never throws.
 */
export function apiKeyFromEnv(providerId: string): string | undefined {
  try {
    const envMap: Record<string, string> = {
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      google: "GEMINI_API_KEY",
      mistral: "MISTRAL_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      deepseek: "DEEPSEEK_API_KEY",
      xai: "XAI_API_KEY",
    };
    const envVar = envMap[providerId];
    if (!envVar) return undefined;
    // Some providers have well-known alternate variable names — try them too.
    const alternates: Record<string, string[]> = {
      google: ["GOOGLE_API_KEY"],
    };
    for (const key of [envVar, ...(alternates[providerId] ?? [])]) {
      const val = process.env[key];
      if (val && val.trim().length > 0) return val.trim();
    }
    return undefined;
  } catch {
    return undefined;
  }
}
