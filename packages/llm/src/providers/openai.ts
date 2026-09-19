/**
 * @codepilot/llm — OpenAI provider (native API).
 *
 * Uses the chat-completions wire protocol (same shapes as
 * OpenAI-compatible); only the provider id and default endpoint differ.
 */

import type { LlmProviderOptions } from "../types.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(options: LlmProviderOptions) {
    super({
      ...options,
      baseUrl: options.baseUrl?.trim() || OPENAI_DEFAULT_BASE_URL,
    });
  }
}
