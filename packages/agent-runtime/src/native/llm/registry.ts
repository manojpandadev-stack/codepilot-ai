/**
 * CodePilot LLM — provider registry + factory.
 *
 * Maps CodePilot provider ids to native adapters. Provider configuration
 * (base URLs, keys) is supplied by the host at construction time — keys are
 * never logged or persisted by this layer.
 *
 * Provider id families (mirrors runtime.toProviderId):
 *   ollama       → OllamaLlmProvider (local)
 *   openai       → Chat Completions (api.openai.com/v1)
 *   openrouter   → Chat Completions (openrouter.ai/api/v1, attribution headers)
 *   anthropic    → AnthropicLlmProvider (native Messages API)
 *   google       → Gemini generateContent adapter
 *   *            → OpenAI-compatible base URL when configured, else error.
 */

import { OllamaLlmProvider, OLLAMA_DEFAULT_HOST } from "./ollama.js";
import {
  OpenAiCompatibleLlmProvider,
  type OpenAiCompatibleOptions,
} from "./openai-compatible.js";
import { AnthropicLlmProvider } from "./anthropic.js";
import { GoogleLlmProvider } from "./google.js";
import { LlmError, type LlmProvider, type LlmRequest } from "./types.js";

export type {
  LlmProvider,
  LlmRequest,
  LlmStreamEvent,
  LlmToolCall,
} from "./types.js";
export { LlmError } from "./types.js";
export { OllamaLlmProvider, OLLAMA_DEFAULT_HOST } from "./ollama.js";
export {
  OpenAiCompatibleLlmProvider,
  toOpenAiMessages,
} from "./openai-compatible.js";
export { AnthropicLlmProvider } from "./anthropic.js";
export { GoogleLlmProvider } from "./google.js";

export interface LlmProviderConfig {
  /** Stable provider id (e.g. "ollama", "openai", "openrouter"). */
  providerId: string;
  /** API key (host-resolved from SecretStorage — never logged). */
  apiKey?: string;
  /** Base URL override (required for unknown providers). */
  baseUrl?: string;
}

export interface CreateLlmProviderOptions {
  configs?: LlmProviderConfig[];
  fetchImpl?: typeof fetch;
}

const DEFAULT_ENDPOINTS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  deepseek: "https://api.deepseek.com/v1",
  mistral: "https://api.mistral.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  together: "https://api.together.xyz/v1",
  xai: "https://api.x.ai/v1",
};

/**
 * Create a native LLM provider for the given provider id.
 * Throws LlmError when the provider cannot be constructed (missing key for a
 * remote provider) — the engine treats that as a permanent run failure.
 */
export function createLlmProvider(
  request: Pick<LlmRequest, "providerId" | "modelId">,
  options: CreateLlmProviderOptions = {},
): LlmProvider {
  const configs = options.configs ?? [];
  const config = configs.find((c) => c.providerId === request.providerId);
  const apiKey = config?.apiKey;
  const baseUrl = config?.baseUrl;

  const fetchImpl = options.fetchImpl ?? fetch;
  const openAiOptions = (
    extra?: Partial<OpenAiCompatibleOptions>,
  ): OpenAiCompatibleOptions => ({
    baseUrl: baseUrl ?? DEFAULT_ENDPOINTS[request.providerId] ?? "",
    apiKey,
    fetchImpl,
    ...(extra ?? {}),
  });

  switch (request.providerId) {
    case "ollama":
    case "lmstudio": {
      // LM Studio also exposes Ollama-style local endpoints only via its own
      // OpenAI-compatible server — treat any baseUrl-bearing local id as
      // Ollama when it points at the Ollama port, else OpenAI-compatible.
      if (request.providerId === "ollama") {
        return new OllamaLlmProvider({
          baseUrl: baseUrl ?? OLLAMA_DEFAULT_HOST,
          fetchImpl,
        });
      }
      if (!baseUrl) {
        throw new LlmError(
          request.providerId,
          "baseUrl is required for lmstudio",
        );
      }
      return new OpenAiCompatibleLlmProvider(
        request.providerId,
        openAiOptions(),
      );
    }
    case "openai":
    case "openai-native":
      if (!apiKey)
        throw new LlmError(
          request.providerId,
          "API key is required for OpenAI",
        );
      return new OpenAiCompatibleLlmProvider(
        request.providerId,
        openAiOptions(),
      );
    case "openrouter":
      if (!apiKey)
        throw new LlmError(
          request.providerId,
          "API key is required for OpenRouter",
        );
      return new OpenAiCompatibleLlmProvider(
        request.providerId,
        openAiOptions({
          headers: {
            "HTTP-Referer": "https://github.com/codepilot-ai",
            "X-Title": "CodePilot AI",
          },
        }),
      );
    case "deepseek":
    case "mistral":
    case "groq":
    case "together":
    case "xai":
      if (!apiKey)
        throw new LlmError(
          request.providerId,
          `API key is required for ${request.providerId}`,
        );
      return new OpenAiCompatibleLlmProvider(
        request.providerId,
        openAiOptions(),
      );
    case "anthropic":
      if (!apiKey)
        throw new LlmError(
          request.providerId,
          "API key is required for Anthropic",
        );
      return new AnthropicLlmProvider({ apiKey, baseUrl, fetchImpl });
    case "google":
    case "gemini":
      if (!apiKey)
        throw new LlmError(
          request.providerId,
          "API key is required for Google",
        );
      return new GoogleLlmProvider({ apiKey, baseUrl, fetchImpl });
    default: {
      // Unknown provider id: require an explicit base URL and speak
      // OpenAI-compatible (the de-facto interchange protocol).
      if (!baseUrl) {
        throw new LlmError(
          request.providerId,
          `Unknown provider "${request.providerId}" and no baseUrl configured`,
          { transient: false },
        );
      }
      return new OpenAiCompatibleLlmProvider(
        request.providerId,
        openAiOptions(),
      );
    }
  }
}
