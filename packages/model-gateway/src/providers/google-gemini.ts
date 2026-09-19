/**
 * @codepilot/model-gateway — GoogleGeminiProvider
 *
 * Google Gemini API provider. Discovery uses the `/v1beta/models` endpoint
 * with the API key as a query parameter (Google's auth scheme); generation
 * is routed through the runtime's @codepilot/llm adapters.
 *
 * Secrets: the API key is only ever placed in the request URL/header at call
 * time and is stripped from getConfig(). It is never logged.
 */

import type { ProviderConfig } from "../provider.js";
import { RestCatalogProvider } from "./rest-catalog-provider.js";
import type {
  RestCatalogDescriptor,
  CatalogModelDescriptor,
} from "./rest-catalog-provider.js";
import type { ModelCapabilitySet } from "../provider.js";

// ============================================================================
// Static catalogues & capability data
// ============================================================================

/** Statically-known Gemini models used when discovery is unavailable. */
const GEMINI_FALLBACK_MODELS = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
] as const;

/** Known capability metadata for well-known Gemini models. */
const GEMINI_KNOWN_CAPABILITIES: Record<string, Partial<ModelCapabilitySet>> = {
  "gemini-2.5-pro": {
    tools: true,
    vision: true,
    structuredOutput: true,
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    reasoning: true,
  },
  "gemini-2.5-flash": {
    tools: true,
    vision: true,
    structuredOutput: true,
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    reasoning: true,
  },
  "gemini-2.0-flash": {
    tools: true,
    vision: true,
    structuredOutput: true,
    contextWindow: 1_048_576,
    maxOutputTokens: 8_192,
  },
};

/** Heuristics for unknown/new Gemini model ids. */
function geminiHeuristics(modelId: string): Partial<ModelCapabilitySet> {
  const lower = modelId.toLowerCase();
  return {
    tools: true,
    vision: true, // all Gemini 2.x models are multimodal
    structuredOutput: true,
    contextWindow: 1_048_576,
    maxOutputTokens: lower.includes("pro") ? 65_536 : 8_192,
    reasoning: lower.includes("thinking") || lower.includes("2.5"),
  };
}

// ============================================================================
// Descriptor
// ============================================================================

const GEMINI_DESCRIPTOR: RestCatalogDescriptor = {
  defaultBaseUrl: "https://generativelanguage.googleapis.com",
  listPath: "/v1beta/models",
  requiresApiKey: true,
  authScheme: "x-goog-api-key header or ?key= query parameter",
  buildHeaders: (config) => ({
    "x-goog-api-key": config.apiKey ?? "",
  }),
  parseModels: (body): CatalogModelDescriptor[] => {
    const models = (body as { models?: unknown })?.models;
    if (!Array.isArray(models)) return [];
    return (
      models
        .filter(
          (m): m is { name: string; displayName?: string } =>
            typeof m === "object" &&
            m !== null &&
            typeof (m as { name?: unknown }).name === "string",
        )
        // Google returns names like "models/gemini-2.5-flash" — strip prefix.
        // Embedding/aqa models are not generation targets — exclude them.
        .filter((m) => !/embed|aqa|vision-duck/i.test(m.name))
        .map((m) => ({
          id: m.name.replace(/^models\//, ""),
          displayName: m.displayName,
        }))
    );
  },
  fallbackModels: [...GEMINI_FALLBACK_MODELS],
  knownCapabilities: GEMINI_KNOWN_CAPABILITIES,
  heuristicCapabilities: geminiHeuristics,
  providerSupports: {
    streaming: true,
    tools: true,
    vision: true,
    structuredOutput: true,
    embeddings: true,
  },
};

// ============================================================================
// Provider
// ============================================================================

export class GoogleGeminiProvider extends RestCatalogProvider {
  readonly type = "gemini" as const;

  constructor(config: ProviderConfig) {
    super(config, GEMINI_DESCRIPTOR);
  }
}
