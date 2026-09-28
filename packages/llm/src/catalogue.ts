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

/**
 * Tri-state native tool-calling support for a model.
 *
 * POLICY (binding for the runtime and every adapter):
 * - "true"     → authoritative evidence the model emits structured tool
 *                calls natively (Ollama /api/chat `tool_calls`). The pipeline
 *                behaves exactly as it does today.
 * - "false"    → authoritative evidence the model CANNOT emit structured
 *                tool calls natively. The runtime may omit the tools array
 *                for this model (they cannot be dispatched anyway); it must
 *                do so honestly (a diagnostic line), never silently.
 * - "unknown"  → no reliable evidence either way. The native tool pipeline
 *                MUST stay enabled: tools are still advertised and streamed
 *                tool_calls are still accepted. Unknown NEVER silently
 *                disables the tool pipeline — the model either uses the
 *                advertised tools or answers in prose, and the Act-mode
 *                no-tool-call diagnostic records which happened.
 *
 * This field is deliberately separate from the legacy `capabilities` string
 * array (consumed by model-gateway's capability mapping); it exists so a
 * claim can carry its own evidence class. A model whose support cannot be
 * established from authoritative metadata is "unknown" — never guessed.
 */
export type LlmToolCallingSupport = "true" | "false" | "unknown";

export interface LlmCatalogModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  capabilities?: string[];
  pricing?: { input?: number; output?: number };
  /**
   * Tri-state native tool-calling support (see the type's policy block).
   * Absent on models with no curated evidence → treated as "unknown".
   */
  toolCallingSupport?: LlmToolCallingSupport;
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
  description:
    "API key issued by the provider. Stored in OS secret storage only.",
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
      configFields: [baseUrlField("http://localhost:11434")],
    },
    models: {
      "qwen3:8b": {
        id: "qwen3:8b",
        name: "Qwen 3 8B",
        contextWindow: 32768,
        capabilities: ["tools", "streaming", "reasoning"],
        // Verified live on this machine (qwen3:8b, Ollama /api/chat): the
        // model emits structured `message.tool_calls` entries with parsed
        // JSON arguments — same protocol class the catalogue already credits
        // (Ollama tool calling, Qwen3 family). Recorded 2026-09.
        toolCallingSupport: "true",
      },
      "qwen2.5-coder:3b": {
        id: "qwen2.5-coder:3b",
        name: "Qwen 2.5 Coder 3B",
        contextWindow: 32768,
        capabilities: ["tools", "streaming"],
        // Deliberately "unknown", NOT "true": the Ollama model page
        // advertises tool templates for this tag, but the only live
        // observation available (2026-09, CPU, full 17-tool schema) is that
        // the model SOMETIMES answers an explicit terminal request in prose
        // instead of emitting a structured tool call. That is not enough
        // evidence for "true", and nothing authoritative supports "false".
        // Per policy, "unknown" keeps the native tool pipeline fully enabled
        // — the Act-mode no-tool-call diagnostic records actual behavior.
        toolCallingSupport: "unknown",
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

/** Capability keys that mean "this model accepts image input". */
const VISION_CAPABILITY_KEYS: readonly string[] = ["images", "vision"];

function capabilitiesIncludeVision(
  capabilities: readonly string[] | undefined,
): boolean {
  if (!capabilities) return false;
  return capabilities.some((c) => VISION_CAPABILITY_KEYS.includes(c));
}

/**
 * Whether a provider/model pair is known to accept image input, per the
 * curated catalogue.
 *
 * - A model explicitly listed in the catalogue decides by its own
 *   capabilities (vision keys: "images" or "vision").
 * - Local runtimes (Ollama, LM Studio) serve whatever the user installed:
 *   unlisted models are unknowable statically → `undefined` (live discovery
 *   and the server own the truth).
 * - Generic bring-your-own endpoints (`openai-compatible`, `custom`,
 *   legacy `openai`) accept any model by construction → `undefined`.
 * - Any other catalogued provider falls back to its provider-level
 *   capabilities (`false` when vision is absent).
 * - Unknown provider ids → `undefined`.
 *
 * Callers treat `false` as fail-closed (clear capability error) and
 * `undefined` as unknowable (allowed; server errors surface naturally).
 */
export function modelSupportsVision(
  providerId: string,
  modelId: string,
): boolean | undefined {
  const provider = CODEPILOT_PROVIDER_CATALOG.find((p) => p.id === providerId);
  if (!provider) return undefined;
  const model = provider.models?.[modelId];
  if (model?.capabilities !== undefined) {
    return capabilitiesIncludeVision(model.capabilities);
  }
  if (providerId === "ollama" || providerId === "lmstudio") return undefined;
  if (
    providerId === "openai-compatible" ||
    providerId === "custom" ||
    providerId === "openai"
  ) {
    return undefined;
  }
  if (provider.capabilities !== undefined) {
    return capabilitiesIncludeVision(provider.capabilities);
  }
  return undefined;
}

/**
 * Tri-state native tool-calling support for a provider/model pair.
 *
 * - A model explicitly listed in the catalogue decides by its own
 *   `toolCallingSupport` (absent field → "unknown": absence of curated
 *   evidence is never a denial).
 * - Models on local runtimes (Ollama, LM Studio) not explicitly listed are
 *   unknowable statically → "unknown" (the user installed whatever they
 *   installed; live behavior is the only truth).
 * - Generic bring-your-own endpoints (`openai-compatible`, `custom`,
 *   legacy `openai`) accept any model by construction → "unknown".
 * - Any other catalogued provider falls back to its provider-level
 *   `capabilities` array ONLY as a "true" signal when it names "tools"
 *   (provider-level metadata is a protocol claim, weaker than per-model
 *   evidence — it can never produce "false").
 * - Unknown provider ids → "unknown".
 *
 * See the `LlmToolCallingSupport` policy block: "unknown" keeps the native
 * tool pipeline fully enabled; only authoritative "false" may omit tools,
 * and even then honestly (a diagnostic), never silently.
 */
export function modelToolCallingSupport(
  providerId: string,
  modelId: string,
): LlmToolCallingSupport {
  const provider = CODEPILOT_PROVIDER_CATALOG.find((p) => p.id === providerId);
  if (!provider) return "unknown";
  const model = provider.models?.[modelId];
  if (model !== undefined) {
    return model.toolCallingSupport ?? "unknown";
  }
  if (providerId === "ollama" || providerId === "lmstudio") return "unknown";
  if (
    providerId === "openai-compatible" ||
    providerId === "custom" ||
    providerId === "openai"
  ) {
    return "unknown";
  }
  if (provider.capabilities?.includes("tools")) return "true";
  return "unknown";
}
