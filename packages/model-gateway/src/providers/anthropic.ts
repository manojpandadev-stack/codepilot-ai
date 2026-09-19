/**
 * @codepilot/model-gateway — AnthropicProvider
 *
 * Anthropic API provider (claude.ai / api.anthropic.com). Discovery uses the
 * public `/v1/models` endpoint; generation is routed through the runtime's
 * @codepilot/llm adapters (providerId: "anthropic").
 *
 * Secrets: the API key is only ever placed in request headers at call time
 * and is stripped from getConfig().
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

/** Statically-known Anthropic models used when discovery is unavailable. */
const ANTHROPIC_FALLBACK_MODELS = [
  "claude-sonnet-4-20250514",
  "claude-opus-4-20250514",
  "claude-3-7-sonnet-20250219",
  "claude-3-5-haiku-20241022",
] as const;

/** Known capability metadata for well-known Anthropic models. */
const ANTHROPIC_KNOWN_CAPABILITIES: Record<
  string,
  Partial<ModelCapabilitySet>
> = {
  "claude-opus-4-20250514": {
    tools: true,
    vision: true,
    structuredOutput: true,
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    reasoning: true,
  },
  "claude-sonnet-4-20250514": {
    tools: true,
    vision: true,
    structuredOutput: true,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    reasoning: true,
  },
  "claude-3-7-sonnet-20250219": {
    tools: true,
    vision: true,
    structuredOutput: true,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    reasoning: true,
  },
  "claude-3-5-haiku-20241022": {
    tools: true,
    vision: true,
    structuredOutput: true,
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
  },
};

/** Heuristics for unknown/new Anthropic model ids. */
function anthropicHeuristics(modelId: string): Partial<ModelCapabilitySet> {
  const lower = modelId.toLowerCase();
  const isOpus = lower.includes("opus");
  return {
    tools: true,
    vision: true, // all current Claude models are multimodal
    structuredOutput: true,
    contextWindow: 200_000,
    maxOutputTokens: isOpus ? 32_000 : 64_000,
    reasoning: isOpus || lower.includes("sonnet"),
  };
}

// ============================================================================
// Descriptor
// ============================================================================

const ANTHROPIC_DESCRIPTOR: RestCatalogDescriptor = {
  defaultBaseUrl: "https://api.anthropic.com",
  listPath: "/v1/models",
  requiresApiKey: true,
  authScheme: "x-api-key",
  buildHeaders: (config) => ({
    "x-api-key": config.apiKey ?? "",
    "anthropic-version": "2023-06-01",
  }),
  parseModels: (body): CatalogModelDescriptor[] => {
    const data = (body as { data?: unknown })?.data;
    if (!Array.isArray(data)) return [];
    return data
      .filter(
        (m): m is { id: string; display_name?: string; created_at?: string } =>
          typeof m === "object" &&
          m !== null &&
          typeof (m as { id?: unknown }).id === "string",
      )
      .map((m) => ({
        id: m.id,
        displayName: m.display_name,
        createdAt: m.created_at ?? null,
      }));
  },
  fallbackModels: [...ANTHROPIC_FALLBACK_MODELS],
  knownCapabilities: ANTHROPIC_KNOWN_CAPABILITIES,
  heuristicCapabilities: anthropicHeuristics,
  providerSupports: {
    streaming: true,
    tools: true,
    vision: true,
    structuredOutput: true,
    embeddings: false,
  },
};

// ============================================================================
// Provider
// ============================================================================

export class AnthropicProvider extends RestCatalogProvider {
  readonly type = "anthropic" as const;

  constructor(config: ProviderConfig) {
    super(config, ANTHROPIC_DESCRIPTOR);
  }
}
