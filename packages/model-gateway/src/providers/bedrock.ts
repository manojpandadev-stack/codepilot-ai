/**
 * @codepilot/model-gateway — BedrockProvider
 *
 * AWS Bedrock provider. STATUS: PARTIAL by design — Bedrock's model
 * discovery APIs (ListFoundationModels / ListInferenceProfiles) require
 * SigV4-signed AWS SDK calls, which we intentionally do not add as a
 * dependency here. Model generation is fully supported through the runtime's
 * @codepilot/llm adapters (providerId: "bedrock"), so users configure models
 * explicitly.
 *
 * Security: no AWS credentials are ever handled by this class — signing and
 * credential resolution happen inside the provider adapter/AWS SDK at
 * generation time. getConfig() never contains credentials.
 */

import type {
  ProviderConfig,
  DiscoveredModel,
  ModelCapabilitySet,
} from "../provider.js";
import { defaultCapabilitySet } from "../provider.js";

// ============================================================================
// Static catalogue
// ============================================================================

/** Widely-available Bedrock foundation models (Anthropic on AWS). */
const BEDROCK_FALLBACK_MODELS = [
  "anthropic.claude-sonnet-4-20250514-v1:0",
  "anthropic.claude-3-7-sonnet-20250219-v1:0",
  "anthropic.claude-3-5-sonnet-20241022-v2:0",
  "anthropic.claude-3-5-haiku-20241022-v1:0",
  "amazon.nova-pro-v1:0",
  "amazon.nova-lite-v1:0",
] as const;

const BEDROCK_KNOWN_CAPABILITIES: Record<
  string,
  Partial<ModelCapabilitySet>
> = {
  "anthropic.claude-sonnet-4-20250514-v1:0": {
    tools: true,
    vision: true,
    structuredOutput: true,
    contextWindow: 200_000,
    reasoning: true,
  },
  "anthropic.claude-3-7-sonnet-20250219-v1:0": {
    tools: true,
    vision: true,
    structuredOutput: true,
    contextWindow: 200_000,
    reasoning: true,
  },
  "anthropic.claude-3-5-sonnet-20241022-v2:0": {
    tools: true,
    vision: true,
    structuredOutput: true,
    contextWindow: 200_000,
  },
  "anthropic.claude-3-5-haiku-20241022-v1:0": {
    tools: true,
    vision: true,
    structuredOutput: true,
    contextWindow: 200_000,
  },
  "amazon.nova-pro-v1:0": {
    tools: true,
    vision: true,
    structuredOutput: true,
    contextWindow: 300_000,
  },
  "amazon.nova-lite-v1:0": {
    tools: true,
    vision: true,
    structuredOutput: true,
    contextWindow: 300_000,
  },
};

function bedrockHeuristics(modelId: string): Partial<ModelCapabilitySet> {
  const lower = modelId.toLowerCase();
  return {
    tools: true,
    vision: !lower.includes("haiku"),
    structuredOutput: true,
    contextWindow: 200_000,
    reasoning: lower.includes("sonnet") || lower.includes("nova-pro"),
  };
}

// ============================================================================
// Provider
// ============================================================================

export class BedrockProvider {
  readonly id: string;
  readonly name: string;
  readonly type = "bedrock" as const;

  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.name = config.name;
    this.config = config;
  }

  /**
   * Bedrock model discovery requires SigV4-signed SDK calls. We return the
   * static catalogue and clearly mark models as not locally verified.
   */
  async listModels(_signal?: AbortSignal): Promise<DiscoveredModel[]> {
    return BEDROCK_FALLBACK_MODELS.map((id) => ({
      id,
      displayName: id,
      providerId: this.id,
      capabilities: defaultCapabilitySet({
        streaming: true,
        ...BEDROCK_KNOWN_CAPABILITIES[id],
        ...(!BEDROCK_KNOWN_CAPABILITIES[id] ? bedrockHeuristics(id) : {}),
      }),
      locallyAvailable: false,
      sizeBytes: null,
      lastModified: null,
    }));
  }

  async getModel(
    modelId: string,
    signal?: AbortSignal,
  ): Promise<DiscoveredModel | null> {
    const models = await this.listModels(signal);
    return models.find((m) => m.id === modelId) ?? null;
  }

  /**
   * Health check is delegated to generation-time credential/endpoint checks
   * in the provider adapter. We report HEALTHY when a region is configured,
   * since we cannot cheaply probe Bedrock without an AWS SDK dependency.
   */
  async healthCheck(_signal?: AbortSignal) {
    const region = this.config.metadata?.["region"];
    return {
      providerId: this.id,
      status: region ? ("HEALTHY" as const) : ("DEGRADED" as const),
      latencyMs: null,
      error: region
        ? null
        : "No AWS region configured (set codepilot.providers.bedrock.region)",
      checkedAt: Date.now(),
    };
  }

  supportsStreaming(): boolean {
    return true;
  }
  supportsTools(): boolean {
    return true;
  }
  supportsVision(): boolean {
    return true;
  }
  supportsStructuredOutput(): boolean {
    return true;
  }
  supportsEmbeddings(): boolean {
    return false;
  }

  getCapabilities(modelId: string): ModelCapabilitySet {
    return defaultCapabilitySet({
      streaming: true,
      ...BEDROCK_KNOWN_CAPABILITIES[modelId],
      ...(!BEDROCK_KNOWN_CAPABILITIES[modelId]
        ? bedrockHeuristics(modelId)
        : {}),
    });
  }

  getConfig(): Omit<ProviderConfig, "apiKey"> {
    const { apiKey: _apiKey, ...safe } = this.config;
    return safe;
  }

  updateConfig(patch: Partial<ProviderConfig>): void {
    this.config = { ...this.config, ...patch };
  }
}
