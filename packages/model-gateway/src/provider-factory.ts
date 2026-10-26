/**
 * @codepilot/model-gateway — provider factory
 *
 * Single place where built-in provider instances are constructed from
 * configuration. Keeps the registry free of provider-specific imports and
 * makes adding a new provider a one-line change here.
 *
 * Secrets flow: callers may pass apiKeys per provider id (resolved from
 * SecretStorage / env upstream). This module never reads process.env
 * directly for keys — see resolveProviderConfig/apiKeyFromEnv in config.ts.
 */

import type { ProviderConfig, ModelProvider } from "./provider.js";
import { BUILTIN_PROVIDER_DEFAULTS, resolveProviderConfig } from "./config.js";
import { OllamaProvider } from "./providers/ollama.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import { GoogleGeminiProvider } from "./providers/google-gemini.js";

/** Result of building one provider: instance plus the id it was built for. */
export interface BuiltProvider {
  id: string;
  instance: ModelProvider;
}

/**
 * Build the correct provider instance for a config.
 * Supports only ollama, gemini, and openai-native.
 */
export function createProviderFromConfig(
  config: ProviderConfig,
): BuiltProvider["instance"] {
  switch (config.type) {
    case "ollama":
      return new OllamaProvider(resolveProviderConfig(config));
    case "gemini":
      return new GoogleGeminiProvider(resolveProviderConfig(config));
    case "openai-native":
    case "openai":
      return new OpenAICompatibleProvider(resolveProviderConfig(config));
    default:
      throw new Error(
        `Unsupported provider type "${config.type}". CodePilot supports only OpenAI, Gemini, and Ollama.`,
      );
  }
}

/**
 * Build every built-in provider from BUILTIN_PROVIDER_DEFAULTS.
 *
 * @param opts.apiKeys  Optional map of provider id → API key, resolved by the
 *                      caller (SecretStorage or environment). Never logged.
 * @param opts.overrides Optional per-id config overrides (baseUrl etc.).
 */
export function createBuiltinProviders(opts?: {
  apiKeys?: Record<string, string | undefined>;
  overrides?: Record<string, Partial<ProviderConfig>>;
}): BuiltProvider[] {
  const built: BuiltProvider[] = [];

  for (const id of Object.keys(BUILTIN_PROVIDER_DEFAULTS) as Array<
    keyof typeof BUILTIN_PROVIDER_DEFAULTS
  >) {
    const defaults = BUILTIN_PROVIDER_DEFAULTS[id]!;
    const override = opts?.overrides?.[id];
    const base: ProviderConfig = {
      ...defaults,
      ...override,
      apiKey: opts?.apiKeys?.[id] ?? override?.apiKey,
      enabled: override?.enabled ?? defaults.enabled,
    } as ProviderConfig;

    if (id === "ollama") {
      built.push({ id, instance: new OllamaProvider(base) });
      continue;
    }
    if (id === "gemini") {
      built.push({ id, instance: new GoogleGeminiProvider(base) });
      continue;
    }
    if (id === "openai-native") {
      built.push({ id, instance: new OpenAICompatibleProvider(base) });
      continue;
    }
    built.push({ id, instance: createProviderFromConfig(base) });
  }

  return built;
}
