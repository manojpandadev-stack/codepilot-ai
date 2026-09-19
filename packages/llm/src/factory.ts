/**
 * @codepilot/llm — provider factory.
 *
 * Maps CodePilot provider ids onto CodePilot-owned adapters. Unknown ids
 * with an explicit base URL fall back to the generic OpenAI-compatible
 * adapter (mirrors the CONFIGURABLE catalogue semantics); unknown ids
 * WITHOUT a base URL fail closed — the runtime must never guess an
 * endpoint for a provider it does not know.
 */

import type { LlmProvider, LlmProviderOptions } from "./types.js";
import { OllamaProvider, OLLAMA_DEFAULT_BASE_URL } from "./providers/ollama.js";
import {
  OpenAICompatibleProvider,
} from "./providers/openai-compatible.js";
import { OpenAIProvider, OPENAI_DEFAULT_BASE_URL } from "./providers/openai.js";
import {
  OpenRouterProvider,
  OPENROUTER_DEFAULT_BASE_URL,
} from "./providers/openrouter.js";
import {
  AnthropicProvider,
  ANTHROPIC_DEFAULT_BASE_URL,
} from "./providers/anthropic.js";
import { GoogleProvider, GOOGLE_DEFAULT_BASE_URL } from "./providers/google.js";

export const LMSTUDIO_DEFAULT_BASE_URL = "http://localhost:1234/v1";
export const ZAI_DEFAULT_BASE_URL = "https://api.z.ai/api/paas/v4";

/** Normalize legacy/alias CodePilot provider ids to canonical adapter ids. */
export function normalizeProviderId(providerId: string): string {
  switch ((providerId ?? "").trim().toLowerCase()) {
    case "openai":
      return "openai-native";
    case "google":
      return "gemini";
    default:
      return (providerId ?? "").trim();
  }
}

/** Default base URL for a canonical provider id (undefined when none). */
export function defaultBaseUrlFor(canonicalId: string): string | undefined {
  switch (canonicalId) {
    case "ollama":
      return OLLAMA_DEFAULT_BASE_URL;
    case "lmstudio":
      return LMSTUDIO_DEFAULT_BASE_URL;
    case "openai-native":
      return OPENAI_DEFAULT_BASE_URL;
    case "anthropic":
      return ANTHROPIC_DEFAULT_BASE_URL;
    case "gemini":
      return GOOGLE_DEFAULT_BASE_URL;
    case "openrouter":
      return OPENROUTER_DEFAULT_BASE_URL;
    case "zai":
      return ZAI_DEFAULT_BASE_URL;
    default:
      return undefined;
  }
}

export function createLlmProvider(options: LlmProviderOptions): LlmProvider {
  const canonical = normalizeProviderId(options.providerId);
  if (!options.modelId) {
    throw new Error(`provider "${canonical}" requires modelId`);
  }
  const baseUrl =
    options.baseUrl?.trim() || defaultBaseUrlFor(canonical) || "";
  const resolved: LlmProviderOptions = { ...options, baseUrl };
  switch (canonical) {
    case "ollama":
      return new OllamaProvider(resolved);
    case "lmstudio":
      return new OpenAICompatibleProvider(resolved);
    case "openai-native":
      return new OpenAIProvider(resolved);
    case "anthropic":
      return new AnthropicProvider(resolved);
    case "gemini":
      return new GoogleProvider(resolved);
    case "openrouter":
      return new OpenRouterProvider(resolved);
    case "zai":
    case "openai-compatible":
    case "custom":
      if (!resolved.baseUrl) {
        throw new Error(
          `provider "${canonical}" requires an explicit baseUrl`,
        );
      }
      return new OpenAICompatibleProvider(resolved);
    default:
      if (!resolved.baseUrl) {
        throw new Error(
          `unknown provider "${options.providerId}" requires an explicit baseUrl (fail-closed)`,
        );
      }
      return new OpenAICompatibleProvider(resolved);
  }
}
