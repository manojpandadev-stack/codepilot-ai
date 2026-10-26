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
import { OpenAIProvider, OPENAI_DEFAULT_BASE_URL } from "./providers/openai.js";
import { GoogleProvider, GOOGLE_DEFAULT_BASE_URL } from "./providers/google.js";

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
    case "openai-native":
      return OPENAI_DEFAULT_BASE_URL;
    case "gemini":
      return GOOGLE_DEFAULT_BASE_URL;
    default:
      return undefined;
  }
}

export function createLlmProvider(options: LlmProviderOptions): LlmProvider {
  const canonical = normalizeProviderId(options.providerId);
  if (!options.modelId) {
    throw new Error(`provider "${canonical}" requires modelId`);
  }
  const baseUrl = options.baseUrl?.trim() || defaultBaseUrlFor(canonical) || "";
  const resolved: LlmProviderOptions = { ...options, baseUrl };
  switch (canonical) {
    case "ollama":
      return new OllamaProvider(resolved);
    case "openai-native":
      return new OpenAIProvider(resolved);
    case "gemini":
      return new GoogleProvider(resolved);
    default:
      throw new Error(
        `Unsupported provider "${options.providerId}". CodePilot supports only OpenAI, Gemini, and Ollama.`,
      );
  }
}
