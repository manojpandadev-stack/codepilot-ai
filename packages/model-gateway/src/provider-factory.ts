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
import { AnthropicProvider } from "./providers/anthropic.js";
import { GoogleGeminiProvider } from "./providers/google-gemini.js";
import { BedrockProvider } from "./providers/bedrock.js";
import {
  OpenRouterProvider,
  LMStudioProvider,
  DeepSeekProvider,
  MistralProvider,
  XAIProvider,
} from "./providers/openai-cloud-providers.js";

/** Result of building one provider: instance plus the id it was built for. */
export interface BuiltProvider {
  id: string;
  instance: ModelProvider;
}

/**
 * Build the correct provider instance for a config.
 * Falls back to OpenAICompatibleProvider for custom/openai-compatible types.
 */
export function createProviderFromConfig(
  config: ProviderConfig,
): BuiltProvider["instance"] {
  switch (config.type) {
    case "ollama":
      return new OllamaProvider(resolveProviderConfig(config));
    case "anthropic":
      return new AnthropicProvider(resolveProviderConfig(config));
    case "gemini":
      return new GoogleGeminiProvider(resolveProviderConfig(config));
    case "bedrock":
      return new BedrockProvider(resolveProviderConfig(config));
    case "openai":
    case "openai-compatible":
    case "custom":
    default:
      return new OpenAICompatibleProvider(resolveProviderConfig(config));
  }
}

/** Provider ids built from the openai-compatible descriptor factory. */
const OPENAI_COMPATIBLE_BUILTINS = [
  "openrouter",
  "lmstudio",
  "deepseek",
  "mistral",
  "xai",
] as const;

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

    // Custom providers (user-defined openai-compatible endpoints) are
    // created explicitly by callers, not from the builtin defaults.
    if (id === "openai") {
      built.push({ id, instance: new OpenAICompatibleProvider(base) });
      continue;
    }
    if (id === "anthropic") {
      built.push({ id, instance: new AnthropicProvider(base) });
      continue;
    }
    if (id === "google") {
      built.push({ id, instance: new GoogleGeminiProvider(base) });
      continue;
    }
    if (id === "bedrock") {
      built.push({ id, instance: new BedrockProvider(base) });
      continue;
    }
    if (id === "openrouter") {
      built.push({ id, instance: new OpenRouterProvider(base) });
      continue;
    }
    if (id === "lmstudio") {
      built.push({ id, instance: new LMStudioProvider(base) });
      continue;
    }
    if ((OPENAI_COMPATIBLE_BUILTINS as readonly string[]).includes(id)) {
      if (id === "deepseek") {
        built.push({ id, instance: new DeepSeekProvider(base) });
      } else if (id === "mistral") {
        built.push({ id, instance: new MistralProvider(base) });
      } else if (id === "xai") {
        built.push({ id, instance: new XAIProvider(base) });
      } else {
        built.push({ id, instance: new OpenAICompatibleProvider(base) });
      }
      continue;
    }
    if (id === "ollama") {
      built.push({ id, instance: new OllamaProvider(base) });
      continue;
    }
    built.push({ id, instance: new OpenAICompatibleProvider(base) });
  }

  return built;
}
