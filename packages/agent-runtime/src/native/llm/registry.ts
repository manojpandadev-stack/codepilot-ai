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
  /**
   * Ollama-only: inactivity window (ms) allowed before the first stream
   * chunk. A local CPU prefill is legitimately silent for minutes before
   * generation starts; the steady-stream inactivity window must not apply
   * to that phase. Undefined → provider default (15m).
   */
  ollamaFirstTokenTimeoutMs?: number;
  /**
   * Ollama-only: model residency after a completed request (Go duration
   * string, e.g. "10m"). Keeps the model warm across turns; "0" restores
   * the server-default unload behavior. Undefined → "10m".
   */
  ollamaKeepAlive?: string;
  /**
   * Ollama-only: `num_ctx` context-window size (VS Code setting
   * `codepilot.localAI.ollama.contextLength`). Undefined → omit from the
   * request (server/model default).
   */
  ollamaContextLength?: number;
  /**
   * Ollama-only: `num_predict` max tokens (VS Code setting
   * `codepilot.localAI.ollama.numPredict`). Undefined → omit from the
   * request (server/model default).
   */
  ollamaNumPredict?: number;
  /**
   * Ollama-only: explicit `think` control for reasoning models. Three-state
   * (undefined = server default, never a blind disable). The user is always
   * shown real reasoning spans via agent/status "Thinking…".
   */
  ollamaThink?: boolean;
}

export interface CreateLlmProviderOptions {
  configs?: LlmProviderConfig[];
  fetchImpl?: typeof fetch;
  /**
   * BUG 5 — transport for the local Ollama provider. Default "fetch" keeps
   * global fetch (undici) — the documented test/embedding seam. "node-http"
   * swaps in the zero-transport-timeout adapter so undici's 300s HEADERS
   * timeout cannot kill a slow local CPU prefill (measured, live qwen3:8b).
   * An explicit fetchImpl wins over this option. Only the ollama branch
   * honors it; cloud providers always use fetch.
   */
  transport?: "fetch" | "node-http";
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
        // TRANSPORT SELECTION (BUG 5): default stays global fetch — the
        // documented test/embedding seam (vi.stubGlobal("fetch")). An
        // explicit fetchImpl always wins. `transport: "node-http"` (only
        // honored without a fetchImpl) selects the zero-transport-timeout
        // adapter, bypassing undici's 300s HEADERS timeout so a slow CPU
        // prefill is governed ONLY by the provider's first-token inactivity
        // window (measured, live qwen3:8b; see node-http-fetch.ts).
        return new OllamaLlmProvider({
          baseUrl: baseUrl ?? OLLAMA_DEFAULT_HOST,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          ...(options.transport && !options.fetchImpl
            ? { transport: options.transport }
            : {}),
          ...(config?.ollamaFirstTokenTimeoutMs !== undefined
            ? { firstTokenTimeoutMs: config.ollamaFirstTokenTimeoutMs }
            : {}),
          ...(config?.ollamaKeepAlive !== undefined
            ? { keepAlive: config.ollamaKeepAlive }
            : {}),
          ...(config?.ollamaContextLength !== undefined
            ? { numCtx: config.ollamaContextLength }
            : {}),
          ...(config?.ollamaNumPredict !== undefined
            ? { numPredict: config.ollamaNumPredict }
            : {}),
          ...(config?.ollamaThink !== undefined
            ? { think: config.ollamaThink }
            : {}),
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
