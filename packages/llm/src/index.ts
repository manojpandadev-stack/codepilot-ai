/**
 * @codepilot/llm — CodePilot-owned LLM layer.
 *
 * Provider adapters, agent/tool contracts, one-shot completion, and the
 * curated provider catalogue. No third-party agent framework involved.
 */

export type {
  LlmRole,
  LlmTextBlock,
  LlmToolUseBlock,
  LlmToolResultBlock,
  LlmImageBlock,
  LlmContentBlock,
  LlmMessage,
  LlmToolDefinition,
  LlmToolCall,
  LlmChunk,
  LlmUsage,
  LlmRequest,
  LlmListedModel,
  LlmProvider,
  LlmProviderOptions,
  AgentToolContext,
  AgentTool,
  AgentToolConfig,
  ToolExecutorFn,
  AgentUsage,
  AgentMessage,
} from "./types.js";
export { createTool } from "./types.js";
export type {
  LlmCatalogModel,
  LlmCatalogField,
  LlmCatalogProvider,
  LlmToolCallingSupport,
  CuratedProviderId,
} from "./catalogue.js";
export {
  CODEPILOT_PROVIDER_CATALOG,
  CURATED_PROVIDER_IDS,
  CURATED_PROVIDER_LIMIT,
  SUPPORTED_PROVIDER_IDS,
  isSupportedProviderId,
  isLegacyProviderId,
  modelSupportsVision,
  modelToolCallingSupport,
} from "./catalogue.js";
export type { SupportedProviderId } from "./catalogue.js";
export { OllamaProvider, OLLAMA_DEFAULT_BASE_URL } from "./providers/ollama.js";
export { splitThinking } from "./providers/ollama.js";
export { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
export type { OpenAICompatibleOptions } from "./providers/openai-compatible.js";
export { OpenAIProvider, OPENAI_DEFAULT_BASE_URL } from "./providers/openai.js";
export {
  OpenRouterProvider,
  OPENROUTER_DEFAULT_BASE_URL,
} from "./providers/openrouter.js";
export {
  AnthropicProvider,
  ANTHROPIC_DEFAULT_BASE_URL,
} from "./providers/anthropic.js";
export {
  GoogleProvider,
  GOOGLE_DEFAULT_BASE_URL,
  toGeminiSchema,
  toGeminiFunctionDeclarationSchema,
} from "./providers/google.js";
export {
  createLlmProvider,
  normalizeProviderId,
  defaultBaseUrlFor,
} from "./factory.js";
export { completeText } from "./complete.js";
export type { CompleteTextOptions } from "./complete.js";
