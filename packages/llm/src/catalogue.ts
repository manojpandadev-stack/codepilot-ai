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

export const CURATED_PROVIDER_LIMIT = 12;

export const SUPPORTED_PROVIDER_IDS = [
  "openai-native",
  "gemini",
  "ollama",
] as const;

export type SupportedProviderId = (typeof SUPPORTED_PROVIDER_IDS)[number];

export function isSupportedProviderId(id: string): id is SupportedProviderId {
  const norm = id?.trim().toLowerCase();
  return norm === "openai-native" || norm === "gemini" || norm === "ollama";
}

export const CURATED_PROVIDER_IDS = [
  "openai-native",
  "gemini",
  "ollama",
] as const;

export type CuratedProviderId = (typeof CURATED_PROVIDER_IDS)[number];

const LEGACY_PROVIDER_IDS = new Set(["openai", "google", "custom", "zhipuai"]);

export function isLegacyProviderId(id: string): boolean {
  return LEGACY_PROVIDER_IDS.has(id);
}

/**
 * The curated provider set. Strictly reduced to supported providers:
 * ollama, openai-native, gemini.
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
        toolCallingSupport: "true",
      },
      "qwen2.5-coder:3b": {
        id: "qwen2.5-coder:3b",
        name: "Qwen 2.5 Coder 3B",
        contextWindow: 32768,
        capabilities: ["tools", "streaming"],
        toolCallingSupport: "unknown",
      },
    },
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
      configFields: [apiKeyField("Gemini API key")],
    },
    models: {
      "gemini-3.8-flash": {
        id: "gemini-3.8-flash",
        name: "Gemini 3.8 Flash",
        contextWindow: 1048576,
        capabilities: ["tools", "streaming", "reasoning", "images"],
        toolCallingSupport: "true",
      },
      "gemini-3.5-flash": {
        id: "gemini-3.5-flash",
        name: "Gemini 3.5 Flash",
        contextWindow: 1048576,
        capabilities: ["tools", "streaming", "reasoning", "images"],
        toolCallingSupport: "true",
      },
      "gemini-3-flash-preview": {
        id: "gemini-3-flash-preview",
        name: "Gemini 3 Flash Preview",
        contextWindow: 1048576,
        capabilities: ["tools", "streaming", "reasoning", "images"],
        toolCallingSupport: "true",
      },
      "gemini-2.5-flash": {
        id: "gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        contextWindow: 1048576,
        capabilities: ["tools", "streaming", "reasoning", "images"],
        toolCallingSupport: "true",
      },
      "gemini-2.5-pro": {
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        contextWindow: 1048576,
        capabilities: ["tools", "streaming", "reasoning", "images"],
        toolCallingSupport: "true",
      },
      "gemini-2.0-flash": {
        id: "gemini-2.0-flash",
        name: "Gemini 2.0 Flash",
        contextWindow: 1048576,
        capabilities: ["tools", "streaming", "reasoning", "images"],
        toolCallingSupport: "true",
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
 */
export function modelSupportsVision(
  providerId: string,
  modelId: string,
): boolean | undefined {
  const canonicalId = providerId === "google" ? "gemini" : providerId;
  const provider = CODEPILOT_PROVIDER_CATALOG.find((p) => p.id === canonicalId);
  if (!provider) return undefined;
  const model = provider.models?.[modelId];
  if (model?.capabilities !== undefined) {
    return capabilitiesIncludeVision(model.capabilities);
  }
  if (providerId === "ollama") return undefined;
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
  const canonicalId = providerId === "google" ? "gemini" : providerId;
  const provider = CODEPILOT_PROVIDER_CATALOG.find((p) => p.id === canonicalId);
  if (!provider) return "unknown";
  const model = provider.models?.[modelId];
  if (model !== undefined) {
    return model.toolCallingSupport ?? "unknown";
  }
  if (providerId === "ollama") return "unknown";
  if (provider.capabilities?.includes("tools")) return "true";
  return "unknown";
}
