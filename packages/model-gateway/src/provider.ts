/**
 * @codepilot/model-gateway — Core Provider Types
 *
 * Defines the CodePilot-specific provider abstraction layer. Every provider
 * must implement ModelProvider. The model-gateway never performs HTTP calls
 * directly for generation — the runtime's @codepilot/llm adapters own that;
 * the gateway does own model discovery and health-check HTTP calls since
 * those are CodePilot-specific concerns.
 */

// ============================================================================
// Model capability set
// ============================================================================

/**
 * Fine-grained capability flags for a model.
 * Providers must report these honestly — never claim a capability the model
 * does not actually support.
 */
export interface ModelCapabilitySet {
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  structuredOutput: boolean;
  embeddings: boolean;
  reasoning: boolean;
  /** Function/tool calling via the model's native API. */
  functionCalling: boolean;
  /** Maximum context window in tokens. */
  contextWindow: number;
  /** Maximum output tokens. */
  maxOutputTokens: number | null;
  /** Estimated VRAM / RAM requirement (local models only). */
  estimatedMemoryMB: number | null;
  /** Subjective coding capability for display purposes. */
  codingCapability: "excellent" | "good" | "fair" | "poor" | "unknown";
  /** Suggested use-cases (display only). */
  recommendedFor: string[];
  /** Parameter size string as reported by the provider (e.g. "8B", "14B"). */
  parameterSize: string | null;
}

// ============================================================================
// Discovered model metadata
// ============================================================================

/**
 * A model discovered from a running provider.
 * All optional fields may be absent if the provider does not expose them.
 */
export interface DiscoveredModel {
  /** Provider-qualified model identifier (e.g. "qwen3:8b"). */
  id: string;
  /** Human-readable display name. */
  displayName: string;
  /** ID of the provider that owns this model. */
  providerId: string;
  /** Full capability set. */
  capabilities: ModelCapabilitySet;
  /** True when the model is locally installed (Ollama etc.). */
  locallyAvailable: boolean;
  /** Approximate disk/VRAM size in bytes (local only). */
  sizeBytes: number | null;
  /** ISO timestamp or epoch ms from the provider's model metadata. */
  lastModified: string | null;
}

// ============================================================================
// Provider health
// ============================================================================

export type ProviderHealthStatus =
  "HEALTHY" | "DEGRADED" | "UNAVAILABLE" | "UNKNOWN";

export interface ProviderHealth {
  providerId: string;
  status: ProviderHealthStatus;
  /** Round-trip latency in ms for the health probe request. */
  latencyMs: number | null;
  /** Human-readable error when status !== HEALTHY. */
  error: string | null;
  /** Unix timestamp (ms) when the check was performed. */
  checkedAt: number;
}

// ============================================================================
// Normalized provider error
// ============================================================================

export type ProviderErrorCode =
  | "AUTHENTICATION"
  | "AUTHORIZATION"
  | "NETWORK"
  | "TIMEOUT"
  | "RATE_LIMIT"
  | "MODEL_NOT_FOUND"
  | "PROVIDER_UNAVAILABLE"
  | "INVALID_REQUEST"
  | "UNSUPPORTED_CAPABILITY"
  | "STREAM_INTERRUPTED"
  | "CANCELLED"
  | "UNKNOWN";

export interface NormalizedProviderError {
  code: ProviderErrorCode;
  /** Short human-readable message safe for UI display. Never includes secrets. */
  message: string;
  /** Full technical detail for logs only — never shown raw to users. */
  technicalDetail?: string;
  retryable: boolean;
  cause?: unknown;
}

// ============================================================================
// Provider configuration
// ============================================================================

export type ProviderType =
  | "ollama"
  | "openai-compatible"
  | "openai"
  | "anthropic"
  | "gemini"
  | "bedrock"
  | "custom";

/**
 * Everything needed to configure and use a provider.
 * Secrets (apiKey) must be handled by the caller — they are never
 * logged or serialized by this package.
 */
export interface ProviderConfig {
  /** Unique identifier (e.g. "ollama", "openai", "my-local-llm"). */
  id: string;
  /** Display name shown in the UI. */
  name: string;
  type: ProviderType;
  /** Base URL override (required for local providers, optional for cloud). */
  baseUrl?: string;
  /** API key (optional; never stored in source code or logs). */
  apiKey?: string;
  /** Model to use when none is specified explicitly. */
  defaultModelId?: string;
  /** Request timeout in milliseconds. Default: 120 000. */
  timeoutMs?: number;
  /** Whether this provider is enabled in the registry. */
  enabled: boolean;
  /**
   * Provider-specific non-secret settings (e.g. region for Bedrock,
   * project for Vertex). Values must never contain credentials.
   */
  metadata?: Record<string, string>;
}

// ============================================================================
// Provider interface
// ============================================================================

/**
 * Core CodePilot provider interface.
 *
 * Implementations expose discovery, health-check, and capability-query
 * capabilities around generation, which is routed through the runtime's
 * @codepilot/llm provider adapters.
 */
export interface ModelProvider {
  /** Matches ProviderConfig.id. */
  readonly id: string;
  readonly name: string;
  readonly type: ProviderType;

  // ---- Discovery ----

  /**
   * Return models currently available from this provider.
   * For local providers (Ollama) this calls the provider's list endpoint.
   * For cloud providers this returns the statically known model catalogue.
   *
   * @param signal  AbortSignal to cancel the discovery request.
   */
  listModels(signal?: AbortSignal): Promise<DiscoveredModel[]>;

  /**
   * Return metadata for a single model by id.
   * Returns null when the model is not found.
   */
  getModel(
    modelId: string,
    signal?: AbortSignal,
  ): Promise<DiscoveredModel | null>;

  // ---- Health ----

  /**
   * Probe the provider to determine if it is reachable and responsive.
   * Must never throw — error information is returned in ProviderHealth.
   *
   * @param signal  AbortSignal to cancel the probe.
   */
  healthCheck(signal?: AbortSignal): Promise<ProviderHealth>;

  // ---- Capability queries ----

  supportsStreaming(): boolean;
  supportsTools(): boolean;
  supportsVision(): boolean;
  supportsStructuredOutput(): boolean;
  supportsEmbeddings(): boolean;

  /**
   * Return the inferred capability set for a given model.
   * The provider should use discovery data when available; otherwise fall back
   * to statically-known metadata.
   */
  getCapabilities(modelId: string): ModelCapabilitySet;

  // ---- Configuration ----

  /**
   * Return the current configuration (without secrets).
   */
  getConfig(): Omit<ProviderConfig, "apiKey">;

  /**
   * Apply a partial configuration update.
   * apiKey changes must be accepted but never logged.
   */
  updateConfig(patch: Partial<ProviderConfig>): void;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a default ModelCapabilitySet for an unknown model.
 */
export function defaultCapabilitySet(
  overrides?: Partial<ModelCapabilitySet>,
): ModelCapabilitySet {
  return {
    streaming: true,
    tools: false,
    vision: false,
    structuredOutput: false,
    embeddings: false,
    reasoning: false,
    functionCalling: false,
    contextWindow: 4096,
    maxOutputTokens: null,
    estimatedMemoryMB: null,
    codingCapability: "unknown",
    recommendedFor: [],
    parameterSize: null,
    ...overrides,
  };
}

/**
 * Build a NormalizedProviderError from an unknown thrown value.
 * Never includes the API key or other secrets.
 */
export function normalizeProviderError(
  error: unknown,
  providerId: string,
): NormalizedProviderError {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unknown error";

  const lower = raw.toLowerCase();

  let code: ProviderErrorCode = "UNKNOWN";
  let retryable = false;

  if (
    lower.includes("unauthorized") ||
    lower.includes("401") ||
    lower.includes("invalid api key") ||
    lower.includes("authentication failed")
  ) {
    code = "AUTHENTICATION";
  } else if (lower.includes("403") || lower.includes("forbidden")) {
    code = "AUTHORIZATION";
  } else if (
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests")
  ) {
    code = "RATE_LIMIT";
  } else if (
    lower.includes("invalid request") ||
    lower.includes("bad request") ||
    lower.includes("invalid_request") ||
    lower.includes("invalid input") ||
    lower.includes("400")
  ) {
    code = "INVALID_REQUEST";
  } else if (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("etimedout")
  ) {
    code = "TIMEOUT";
    retryable = true;
  } else if (
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("socket hang up") ||
    lower.includes("500") ||
    lower.includes("503") ||
    lower.includes("502") ||
    lower.includes("504") ||
    lower.includes("service unavailable") ||
    lower.includes("network")
  ) {
    code = "NETWORK";
    retryable = true;
  } else if (
    lower.includes("model not found") ||
    lower.includes("model_not_found") ||
    lower.includes("no such model") ||
    lower.includes("404")
  ) {
    code = "MODEL_NOT_FOUND";
  } else if (lower.includes("cancelled") || lower.includes("aborted")) {
    code = "CANCELLED";
  } else if (
    lower.includes("unsupported") ||
    lower.includes("not supported") ||
    lower.includes("does not support") ||
    lower.includes("doesn't support")
  ) {
    code = "UNSUPPORTED_CAPABILITY";
  } else if (
    lower.includes("provider unavailable") ||
    lower.includes("provider not available") ||
    lower.includes("no providers available")
  ) {
    code = "PROVIDER_UNAVAILABLE";
    retryable = true;
  } else if (lower.includes("stream")) {
    code = "STREAM_INTERRUPTED";
    retryable = true;
  }

  // Redact secrets from the message before surfacing
  const safeMessage = redactSecrets(raw.slice(0, 300));

  return {
    code,
    message: `[${providerId}] ${safeMessage}`,
    technicalDetail: redactSecrets(raw),
    retryable,
    cause: error,
  };
}

/** Remove common secret patterns from a string before logging or display. */
export function redactSecrets(text: string): string {
  return text
    .replace(
      /(api[_-]?key|apikey|authorization|bearer|token|secret|password)[=:\s]+\S+/gi,
      "$1=<redacted>",
    )
    .replace(/sk-[A-Za-z0-9]+/g, "sk-<redacted>")
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>");
}
