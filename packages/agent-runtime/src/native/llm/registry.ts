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
  /**
   * Effective privacy mode of the current run.
   *
   * Local Only must never follow an HTTP redirect: the privacy gate can only
   * validate the CONFIGURED endpoint, so a permitted loopback server answering
   * `302 Location: https://…` would otherwise send the prompt (and the stored
   * credential) to a destination the policy never inspected. Omitted → the
   * provider default ("follow").
   */
  privacyMode?: "local" | "hybrid" | "cloud";
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
  "openai-native": "https://api.openai.com/v1",
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com",
  google: "https://generativelanguage.googleapis.com",
};

/**
 * Create a native LLM provider for the given provider id.
 * Throws LlmError when the provider cannot be constructed (missing key for a
 * remote provider, or unsupported provider id) — the engine treats that as a permanent run failure.
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
  // Local Only must never follow a redirect off the machine (see
  // LlmProviderConfig.privacyMode). Omitted for every other mode so cloud
  // providers keep their existing follow behaviour.
  const localOnlyRedirect: "follow" | "manual" | undefined =
    config?.privacyMode === "local" ? "manual" : undefined;
  const openAiOptions = (
    extra?: Partial<OpenAiCompatibleOptions>,
  ): OpenAiCompatibleOptions => ({
    baseUrl: baseUrl ?? DEFAULT_ENDPOINTS[request.providerId] ?? "",
    apiKey,
    fetchImpl,
    ...(localOnlyRedirect !== undefined ? { redirect: localOnlyRedirect } : {}),
    ...(extra ?? {}),
  });

  switch (request.providerId) {
    case "ollama": {
      return new OllamaLlmProvider({
        baseUrl: baseUrl ?? OLLAMA_DEFAULT_HOST,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(localOnlyRedirect !== undefined
          ? { redirect: localOnlyRedirect }
          : {}),
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
    case "openai-native":
    case "openai": {
      if (!apiKey) {
        throw new LlmError(
          request.providerId,
          "API key is required for OpenAI",
        );
      }
      return new OpenAiCompatibleLlmProvider(
        request.providerId,
        openAiOptions(),
      );
    }
    case "gemini":
    case "google": {
      if (!apiKey) {
        throw new LlmError(
          request.providerId,
          "API key is required for Gemini",
        );
      }
      if (!request.modelId) {
        throw new LlmError(
          request.providerId,
          "Model ID is required for Gemini",
        );
      }
      return new GoogleLlmProvider({ apiKey, baseUrl, fetchImpl });
    }
    default: {
      throw new LlmError(
        request.providerId,
        `Unsupported provider "${request.providerId}". CodePilot supports only OpenAI, Gemini, and Ollama.`,
        { transient: false },
      );
    }
  }
}
