/**
 * @codepilot/llm — OpenRouter provider (OpenAI-compatible + referral headers).
 */

import type { LlmProviderOptions } from "../types.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export class OpenRouterProvider extends OpenAICompatibleProvider {
  constructor(options: LlmProviderOptions) {
    super({
      ...options,
      baseUrl: options.baseUrl?.trim() || OPENROUTER_DEFAULT_BASE_URL,
      extraHeaders: {
        "HTTP-Referer": "https://codepilot.ai",
        "X-Title": "CodePilot AI",
        ...options.headers,
      },
    });
  }
}
