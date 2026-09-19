/**
 * @codepilot/llm — CodePilot-owned provider catalogue data.
 *
 * Curated facts (ids, endpoints, models, capabilities) for the providers
 * CodePilot routes through its own adapters. This replaces the SDK-derived
 * dataset with a small, auditable, version-controlled snapshot:
 * - Only providers with a CodePilot-owned adapter or explicit generic
 *   support are listed. Unknown ids resolve through the generic
 *   OpenAI-compatible path only with an explicit user base URL.
 * - Model facts are conservative (well-established context windows and
 *   capabilities). Pricing is included only where long-published; it feeds
 *   cost *estimates* in the usage ledger, never billing.
 * - Snapshot date: 2026-09. Refresh deliberately (P2), never silently.
 *
 * Field shapes mirror what `model-gateway`'s mapping layer consumes so the
 * mapping code (status/category/protocol/fields/models) is untouched.
 */

export interface LlmCatalogModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  capabilities?: string[];
  pricing?: { input?: number; output?: number };
}

export interface LlmCatalogField {
  path: string;
  label?: string;
  type?: string;
  placeholder?: string;
  description?: string;
}

export interface LlmCatalogProvider {
  id: string;
  name: string;
  description?: string;
  protocol?:
    | "openai-responses"
    | "anthropic"
    | "gemini"
    | "openai-chat"
    | "openai-r1"
    | "ai-sdk";
  baseUrl?: string;
  defaultModelId: string;
  capabilities?: string[];
  env?: string[];
  client: string;
  metadata?: { configFields?: LlmCatalogField[] } | null;
  models?: Record<string, LlmCatalogModel>;
}

const apiKeyField = (label: string): LlmCatalogField => ({
  path: "apiKey",
  label,
  type: "password",
  placeholder: "Enter API key...",
  description: "API key issued by the provider. Stored in OS secret storage only.",
});

const baseUrlField = (placeholder: string): LlmCatalogField => ({
  path: "baseUrl",
  label: "Base URL",
  type: "url",
  placeholder,
  description: "Base endpoint used for provider requests.",
});

/**
 * The curated provider set. Every id referenced by CodePilot configuration,
 * switching, privacy classification, or catalogue UI is present:
 * ollama, lmstudio, openai-native, openai (legacy id), openai-compatible,
 * custom, anthropic, gemini (+ legacy alias google), openrouter, zai,
 * zhipuai.
 */
export const CODEPILOT_PROVIDER_CATALOG: LlmCatalogProvider[] = [
  {
    id: "ollama",
    name: "Ollama",
    description: "Run open models locally — nothing leaves your machine.",
    baseUrl: "http://localhost:11434",
    defaultModelId: "qwen3:8b",
    capabilities: ["tools", "streaming", "reasoning"],
    env: [],
    client: "ollama",
    metadata: {
      configFields: [
        baseUrlField("http://localhost:11434"),
      ],
    },
    models: {
      "qwen3:8b": {
        id: "qwen3:8b",
        name: "Qwen 3 8B",
        contextWindow: 32768,
        capabilities: ["tools", "streaming", "reasoning"],
      },
      "qwen2.5-coder:3b": {
        id: "qwen2.5-coder:3b",
        name: "Qwen 2.5 Coder 3B",
        contextWindow: 32768,
        capabilities: ["tools", "streaming"],
      },
    },
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    description: "Local models served by LM Studio on this machine.",
    baseUrl: "http://localhost:1234/v1",
    defaultModelId: "",
    capabilities: ["tools", "streaming"],
    env: [],
    client: "openai-compatible",
    metadata: {
      configFields: [baseUrlField("http://localhost:1234/v1")],
    },
    models: {},
  },
  {
    id: "openai-native",
    name: "OpenAI",
    description: "GPT models via the official OpenAI API.",
    protocol: "openai-chat",
    baseUrl: "https://api.openai.com/v1",
    defaultModelId: "gpt-4o",
    capabilities: ["tools", "streaming"],
    env: ["OPENAI_API_KEY"],
    client: "openai",
    metadata: {
      configFields: [
        apiKeyField("OpenAI API key"),
        baseUrlField("https://api.openai.com/v1"),
      ],
    },
    models: {
      "gpt-4o": {
        id: "gpt-4o",
        name: "GPT-4o",
        contextWindow: 128000,
        maxTokens: 16384,
        capabilities: ["tools", "streaming", "images"],
        pricing: { input: 2.5, output: 10 },
      },
      "gpt-4o-mini": {
        id: "gpt-4o-mini",
        name: "GPT-4o mini",
        contextWindow: 128000,
        maxTokens: 16384,
        capabilities: ["tools", "streaming", "images"],
        pricing: { input: 0.15, output: 0.6 },
      },
    },
  },
  {
    id: "openai",
    name: "OpenAI-Compatible",
    description: "OpenAI-Compatible endpoints (custom base URL + model).",
    baseUrl: undefined,
    defaultModelId: "gpt-4o",
    capabilities: ["tools", "streaming"],
    env: [],
    client: "openai-compatible",
    metadata: {
      configFields: [
        apiKeyField("API key"),
        baseUrlField("https://your-endpoint/v1"),
      ],
    },
    models: {},
  },
  {
    id: "openai-compatible",
    name: "OpenAI-Compatible (custom)",
    description:
      "Any OpenAI-compatible API — bring your own base URL, key and model.",
    baseUrl: undefined,
    defaultModelId: "gpt-4o",
    capabilities: ["tools", "streaming"],
    env: [],
    client: "openai-compatible",
    metadata: {
      configFields: [
        apiKeyField("API key"),
        baseUrlField("https://your-endpoint/v1"),
      ],
    },
    models: {},
  },
  {
    id: "custom",
    name: "Custom endpoint",
    description: "User-configured OpenAI-compatible endpoint.",
    baseUrl: undefined,
    defaultModelId: "",
    capabilities: ["tools", "streaming"],
    env: [],
    client: "openai-compatible",
    metadata: {
      configFields: [
        apiKeyField("API key"),
        baseUrlField("https://your-endpoint/v1"),
      ],
    },
    models: {},
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude models via the official Anthropic API.",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    defaultModelId: "claude-sonnet-4-20250514",
    capabilities: ["tools", "streaming", "reasoning"],
    env: ["ANTHROPIC_API_KEY"],
    client: "anthropic",
    metadata: {
      configFields: [
        apiKeyField("Anthropic API key"),
        baseUrlField("https://api.anthropic.com"),
      ],
    },
    models: {
      "claude-sonnet-4-20250514": {
        id: "claude-sonnet-4-20250514",
        name: "Claude Sonnet 4",
        contextWindow: 200000,
        maxTokens: 64000,
        capabilities: ["tools", "streaming", "reasoning", "images"],
        pricing: { input: 3, output: 15 },
      },
      "claude-opus-4-20250514": {
        id: "claude-opus-4-20250514",
        name: "Claude Opus 4",
        contextWindow: 200000,
        maxTokens: 32000,
        capabilities: ["tools", "streaming", "reasoning", "images"],
        pricing: { input: 15, output: 75 },
      },
      "claude-3-7-sonnet-20250219": {
        id: "claude-3-7-sonnet-20250219",
        name: "Claude Sonnet 3.7",
        contextWindow: 200000,
        maxTokens: 64000,
        capabilities: ["tools", "streaming", "reasoning", "images"],
        pricing: { input: 3, output: 15 },
      },
      "claude-3-5-haiku-20241022": {
        id: "claude-3-5-haiku-20241022",
        name: "Claude Haiku 3.5",
        contextWindow: 200000,
        maxTokens: 8192,
        capabilities: ["tools", "streaming", "images"],
        pricing: { input: 0.8, output: 4 },
      },
    },
  },
  {
    id: "gemini",
    name: "Google Gemini",
    description: "Google Gemini models via the Gemini API.",
    protocol: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    defaultModelId: "gemini-2.5-flash",
    capabilities: ["tools", "streaming", "reasoning"],
    env: ["GEMINI_API_KEY"],
    client: "gemini",
    metadata: {
      configFields: [
        apiKeyField("Gemini API key"),
        baseUrlField("https://generativelanguage.googleapis.com"),
      ],
    },
    models: {
      "gemini-2.5-flash": {
        id: "gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        contextWindow: 1048576,
        capabilities: ["tools", "streaming", "reasoning", "images"],
      },
      "gemini-2.5-pro": {
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        contextWindow: 1048576,
        capabilities: ["tools", "streaming", "reasoning", "images"],
      },
    },
  },
  {
    id: "google",
    name: "Google Gemini",
    description: "Google Gemini models via the Gemini API (legacy alias).",
    protocol: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    defaultModelId: "gemini-2.5-flash",
    capabilities: ["tools", "streaming", "reasoning"],
    env: ["GEMINI_API_KEY"],
    client: "gemini",
    metadata: {
      configFields: [
        apiKeyField("Gemini API key"),
        baseUrlField("https://generativelanguage.googleapis.com"),
      ],
    },
    models: {
      "gemini-2.5-flash": {
        id: "gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        contextWindow: 1048576,
        capabilities: ["tools", "streaming", "reasoning", "images"],
      },
      "gemini-2.5-pro": {
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        contextWindow: 1048576,
        capabilities: ["tools", "streaming", "reasoning", "images"],
      },
    },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description:
      "One API for many models from many providers, with a live credits API.",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModelId: "",
    capabilities: ["tools", "streaming", "reasoning"],
    env: ["OPENROUTER_API_KEY"],
    client: "openai-compatible",
    metadata: {
      configFields: [
        apiKeyField("OpenRouter API key"),
        baseUrlField("https://openrouter.ai/api/v1"),
      ],
    },
    models: {},
  },
  {
    id: "zai",
    name: "Z.AI",
    description: "Z.AI GLM models (Zhipu international).",
    baseUrl: "https://api.z.ai/api/paas/v4",
    defaultModelId: "glm-4-flash",
    capabilities: ["tools", "streaming", "reasoning"],
    env: ["ZHIPU_API_KEY"],
    client: "openai-compatible",
    metadata: {
      configFields: [
        apiKeyField("Z.AI API key"),
        baseUrlField("https://api.z.ai/api/paas/v4"),
      ],
    },
    models: {
      "glm-4-flash": {
        id: "glm-4-flash",
        name: "GLM-4-Flash",
        contextWindow: 128000,
        capabilities: ["tools", "streaming"],
      },
      "glm-4.6": {
        id: "glm-4.6",
        name: "GLM-4.6",
        capabilities: ["tools", "streaming", "reasoning"],
      },
    },
  },
  {
    id: "zhipuai",
    name: "Zhipu AI",
    description: "Zhipu GLM models (China platform).",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModelId: "glm-4-flash",
    capabilities: ["tools", "streaming", "reasoning"],
    env: ["ZHIPU_API_KEY"],
    client: "openai-compatible",
    metadata: {
      configFields: [
        apiKeyField("Zhipu API key"),
        baseUrlField("https://open.bigmodel.cn/api/paas/v4"),
      ],
    },
    models: {
      "glm-4-flash": {
        id: "glm-4-flash",
        name: "GLM-4-Flash",
        contextWindow: 128000,
        capabilities: ["tools", "streaming"],
      },
    },
  },
];
