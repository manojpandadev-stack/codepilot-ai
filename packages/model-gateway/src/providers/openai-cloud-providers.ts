/**
 * @codepilot/model-gateway — OpenAI-compatible cloud providers
 *
 * OpenRouter, LM Studio, DeepSeek, Mistral and xAI all speak the OpenAI
 * Chat Completions protocol. Their model catalogues are discovered through
 * the standard `GET {baseUrl}/models` endpoint, so they share a single
 * descriptor factory built on RestCatalogProvider.
 *
 * Generation is routed through the runtime's @codepilot/llm adapters with
 * the matching providerId ("openrouter", "lmstudio", "deepseek", "mistral",
 * "xai").
 *
 * Secrets: API keys only ever appear in Authorization headers at call time
 * and are stripped from getConfig().
 */

import type { ProviderConfig } from "../provider.js";
import { RestCatalogProvider } from "./rest-catalog-provider.js";
import type {
  RestCatalogDescriptor,
  CatalogModelDescriptor,
} from "./rest-catalog-provider.js";
import type { ModelCapabilitySet } from "../provider.js";

// ============================================================================
// Shared OpenAI-style catalog parsing
// ============================================================================

function parseBareArray(arr: unknown[]): CatalogModelDescriptor[] {
  return arr
    .filter(
      (m): m is { id: string; created?: number } =>
        typeof m === "object" &&
        m !== null &&
        typeof (m as { id?: unknown }).id === "string",
    )
    .map((m) => ({ id: m.id, createdAt: m.created ?? null }));
}

/** Parse the standard OpenAI `{ object: "list", data: [{ id, created }] }`. */
function parseOpenAIList(body: unknown): CatalogModelDescriptor[] {
  const data = (body as { data?: unknown })?.data;
  if (Array.isArray(data)) return parseBareArray(data);
  // Some gateways return a bare array.
  if (Array.isArray(body)) return parseBareArray(body);
  return [];
}

// ============================================================================
// Per-provider capability data
// ============================================================================

const DEEPSEEK_KNOWN: Record<string, Partial<ModelCapabilitySet>> = {
  "deepseek-chat": {
    tools: true,
    vision: false,
    structuredOutput: true,
    contextWindow: 65_536,
  },
  "deepseek-reasoner": {
    tools: false,
    vision: false,
    structuredOutput: true,
    contextWindow: 65_536,
    reasoning: true,
  },
};

const MISTRAL_KNOWN: Record<string, Partial<ModelCapabilitySet>> = {
  "mistral-large-latest": {
    tools: true,
    vision: false,
    structuredOutput: true,
    contextWindow: 131_072,
  },
  "codestral-latest": {
    tools: true,
    vision: false,
    structuredOutput: true,
    contextWindow: 262_144,
  },
  "pixtral-large-latest": {
    tools: true,
    vision: true,
    structuredOutput: true,
    contextWindow: 131_072,
  },
};

const XAI_KNOWN: Record<string, Partial<ModelCapabilitySet>> = {
  "grok-3": {
    tools: true,
    vision: false,
    structuredOutput: true,
    contextWindow: 131_072,
  },
  "grok-3-mini": {
    tools: true,
    vision: false,
    structuredOutput: true,
    contextWindow: 131_072,
    reasoning: true,
  },
  "grok-2-vision-1212": {
    tools: true,
    vision: true,
    structuredOutput: true,
    contextWindow: 32_768,
  },
};

function openAIHeuristics(): (modelId: string) => Partial<ModelCapabilitySet> {
  return (modelId: string) => ({
    tools: true,
    vision: /vision|multimodal|image|pixtral|vl/i.test(modelId),
    structuredOutput: true,
    reasoning: /reasoner|thinking|r1/i.test(modelId),
  });
}

// ============================================================================
// Descriptor factory
// ============================================================================

interface OpenAICompatibleCloudOptions {
  defaultBaseUrl: string;
  requiresApiKey: boolean;
  knownCapabilities?: Record<string, Partial<ModelCapabilitySet>>;
  heuristics?: (modelId: string) => Partial<ModelCapabilitySet>;
  providerSupports?: Partial<RestCatalogDescriptor["providerSupports"]>;
  /** Extra static headers, e.g. OpenRouter attribution headers. */
  extraHeaders?: Record<string, string>;
  /** Static model ids returned when discovery is unavailable. */
  fallbackModels?: string[];
}

function openAICompatibleCloudDescriptor(
  options: OpenAICompatibleCloudOptions,
): RestCatalogDescriptor {
  return {
    defaultBaseUrl: options.defaultBaseUrl,
    listPath: "/models",
    requiresApiKey: options.requiresApiKey,
    authScheme: "Authorization: Bearer",
    buildHeaders: (config) => ({
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      ...options.extraHeaders,
    }),
    parseModels: (body) => parseOpenAIList(body),
    fallbackModels: options.fallbackModels ?? [],
    knownCapabilities: options.knownCapabilities ?? {},
    heuristicCapabilities: options.heuristics ?? openAIHeuristics(),
    providerSupports: {
      streaming: true,
      tools: true,
      vision: true,
      structuredOutput: true,
      embeddings: false,
      ...options.providerSupports,
    },
  };
}

// ============================================================================
// Concrete providers
// ============================================================================

abstract class OpenAICompatibleCloudProvider extends RestCatalogProvider {}

/** OpenRouter — multi-provider gateway (free models need no key to list). */
export class OpenRouterProvider extends OpenAICompatibleCloudProvider {
  readonly type = "openai-compatible" as const;
  constructor(config: ProviderConfig) {
    super(
      config,
      openAICompatibleCloudDescriptor({
        defaultBaseUrl: "https://openrouter.ai/api/v1",
        requiresApiKey: false,
        extraHeaders: {
          "HTTP-Referer": "https://github.com/codepilot-ai",
          "X-Title": "CodePilot AI",
        },
      }),
    );
  }
}

/** LM Studio — local OpenAI-compatible server (no key required). */
export class LMStudioProvider extends OpenAICompatibleCloudProvider {
  readonly type = "openai-compatible" as const;
  constructor(config: ProviderConfig) {
    super(
      config,
      openAICompatibleCloudDescriptor({
        defaultBaseUrl: "http://localhost:1234/v1",
        requiresApiKey: false,
        providerSupports: { vision: false, embeddings: true },
      }),
    );
  }
}

/** DeepSeek — API with chat + reasoner models. */
export class DeepSeekProvider extends OpenAICompatibleCloudProvider {
  readonly type = "openai-compatible" as const;
  constructor(config: ProviderConfig) {
    super(
      config,
      openAICompatibleCloudDescriptor({
        defaultBaseUrl: "https://api.deepseek.com/v1",
        requiresApiKey: true,
        knownCapabilities: DEEPSEEK_KNOWN,
        fallbackModels: ["deepseek-chat", "deepseek-reasoner"],
        providerSupports: { vision: false },
      }),
    );
  }
}

/** Mistral — La Plateforme API. */
export class MistralProvider extends OpenAICompatibleCloudProvider {
  readonly type = "openai-compatible" as const;
  constructor(config: ProviderConfig) {
    super(
      config,
      openAICompatibleCloudDescriptor({
        defaultBaseUrl: "https://api.mistral.ai/v1",
        requiresApiKey: true,
        knownCapabilities: MISTRAL_KNOWN,
        fallbackModels: ["mistral-large-latest", "mistral-small-latest"],
      }),
    );
  }
}

/** xAI — Grok models. */
export class XAIProvider extends OpenAICompatibleCloudProvider {
  readonly type = "openai-compatible" as const;
  constructor(config: ProviderConfig) {
    super(
      config,
      openAICompatibleCloudDescriptor({
        defaultBaseUrl: "https://api.x.ai/v1",
        requiresApiKey: true,
        knownCapabilities: XAI_KNOWN,
        fallbackModels: ["grok-3", "grok-3-mini"],
      }),
    );
  }
}
