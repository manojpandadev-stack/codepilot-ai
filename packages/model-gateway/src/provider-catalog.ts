/**
 * @codepilot/model-gateway — authoritative provider catalogue
 *
 * SINGLE SOURCE OF TRUTH for every provider CodePilot AI can show in the UI.
 *
 * The catalogue is DERIVED from CodePilot's owned provider dataset
 * (`@codepilot/llm` catalogue — the same adapters the CodePilot runtime
 * uses to resolve live model handlers), so every entry reflects a protocol
 * the runtime can genuinely route: names, base URLs, protocols, auth
 * fields, models, context windows and per-Mtok pricing all come from
 * curated CodePilot data. CodePilot-specific facts (status, category,
 * usage-API availability) are layered on top as a small static overlay.
 *
 * UI components MUST derive their lists from this module — never maintain
 * separate hard-coded provider lists in React.
 */

import {
  CODEPILOT_PROVIDER_CATALOG,
  CURATED_PROVIDER_IDS,
  modelToolCallingSupport,
  type LlmToolCallingSupport,
} from "@codepilot/llm";
import { OLLAMA_API_TAGS } from "@codepilot/shared";

// ============================================================================
// Types
// ============================================================================

/**
 * Provider status. Be conservative: a provider is SUPPORTED only when
 * CodePilot can configure it AND route a real model request through the
 * production runtime (the native LLM registry resolves a provider for its id).
 */
export type ProviderStatus =
  | "SUPPORTED" // native/gateway provider resolvable by the CodePilot LLM registry today
  | "CONFIGURABLE" // works via OpenAI-compatible protocol (custom base URL)
  | "GATEWAY" // accessed through a supported router/gateway
  | "LOCAL" // local model runtime (Ollama, LM Studio)
  | "SUBSCRIPTION" // requires provider subscription/OAuth login
  | "PLANNED"; // shown for completeness, NOT usable today

export type ProviderCategory = "cloud" | "local" | "gateway" | "custom";

/** What a health/test connection call can honestly report for a provider. */
export interface CatalogHealthCapability {
  /** A models/ or similar endpoint can be probed without side effects. */
  supportsTestConnection: boolean;
  /** Whether the probe requires an API key to return a meaningful result. */
  requiresApiKeyForProbe: boolean;
  /**
   * HTTP path appended to the provider's base URL for the no-side-effect
   * Test Connection probe. Per-provider because vendors differ: Ollama
   * serves discovery under `/api/tags` (probing `/models` or `/` there
   * returns 404), OpenAI-compatible endpoints list models under `/models`.
   * Callers MUST fall back to "/models" when absent.
   */
  probePath?: string;
}

/** What usage/billing data is actually available for a provider. */
export interface CatalogUsageCapability {
  kind:
    | "provider-api" // a real provider endpoint exposes usage/billing
    | "local-tracking" // CodePilot's own token/cost accounting only
    | "none"; // no billing data available
  /** Provider console/billing URL, when one is publicly documented. */
  billingPortalUrl?: string;
}

/** A single model in the catalogue (from the SDK's models.dev dataset). */
export interface CatalogModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning: boolean;
  vision: boolean;
  tools: boolean;
  streaming: boolean;
  /**
   * Tool-calling support tri-state (CodePilot catalogue truth):
   * "true" = verified structured tool calling; "unknown" = unverified
   * (NOT supported, NOT unsupported — must never render as supported);
   * "false" = the adapter cannot carry tool calls. Boolean `tools` above is
   * the provider-level capability and stays for compatibility.
   */
  toolCalling: LlmToolCallingSupport;
  /** USD per million input tokens, when published. */
  inputPerMtok?: number;
  /** USD per million output tokens, when published. */
  outputPerMtok?: number;
}

/** A credential/config field the provider needs (from SDK configFields). */
export interface CatalogField {
  path: string;
  label: string;
  type: "password" | "text" | "url" | "boolean" | "select";
  required: boolean;
  placeholder?: string;
  description?: string;
}

/** One full catalogue entry — everything the UI and host need. */
export interface CatalogProvider {
  /** Canonical provider id (the id the native LLM registry routes through). */
  id: string;
  displayName: string;
  description?: string;
  category: ProviderCategory;
  status: ProviderStatus;
  /** Whether this provider is part of the curated (primary) list. */
  curated: boolean;
  /** Wire protocol the SDK handler speaks. */
  protocol:
    | "openai-chat"
    | "openai-responses"
    | "anthropic"
    | "gemini"
    | "bedrock"
    | "vertex"
    | "ai-sdk"
    | "fetch";
  /** SDK client kind that backs the handler (informational). */
  sdkClient: string;
  /** Default base URL for the API, when defined. */
  baseUrl?: string;
  /** Whether the provider can accept a user-supplied base URL override. */
  supportsCustomBaseUrl: boolean;
  requiresApiKey: boolean;
  supportsOAuth: boolean;
  supportsLocal: boolean;
  supportsModelDiscovery: boolean;
  supportsStreaming: boolean;
  supportsToolCalling: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  /** Typical context window of the provider's flagship models. */
  contextWindow?: number;
  /** Well-known env var names (from the SDK catalogue). */
  envVars: string[];
  /** Credential/config fields the UI should render. */
  fields: CatalogField[];
  models: CatalogModel[];
  /** Default model id, from SDK data. */
  defaultModelId: string;
  health: CatalogHealthCapability;
  usage: CatalogUsageCapability;
}

// ============================================================================
// CodePilot overlay — facts the SDK does not express
// ============================================================================

/**
 * Usage-API providers: only where a documented, key-authenticated endpoint
 * returns account-level usage/credit information. Everything else reports
 * "local tracking" or "unavailable" — never fabricated numbers.
 */
const USAGE_PROVIDER_API: ReadonlySet<string> = new Set([]);

const BILLING_PORTALS: Readonly<Record<string, string>> = {
  "openai-native": "https://platform.openai.com/usage",
  gemini: "https://console.cloud.google.com/billing",
};

/** Local runtimes. */
const LOCAL_IDS: ReadonlySet<string> = new Set(["ollama"]);

/**
 * Per-provider Test Connection probe paths (appended to the provider's base URL).
 */
const HEALTH_PROBE_PATHS: Readonly<Record<string, string>> = {
  ollama: OLLAMA_API_TAGS, // "/api/tags"
  "openai-native": "/models",
  gemini: "/v1beta/models",
};

/** Default probe path for providers without a vendor-specific one. */
const DEFAULT_HEALTH_PROBE_PATH = "/models";

const DESCRIPTION_OVERRIDES: Readonly<Record<string, string>> = {
  "openai-native": "GPT models via the official OpenAI API.",
  gemini: "Google Gemini models via the Gemini API.",
  ollama: "Run open models locally — nothing leaves your machine.",
} as const;

// ============================================================================
// SDK type shims (kept structural to avoid coupling to internal SDK types)
// ============================================================================

interface SdkModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  capabilities?: string[];
  /** CodePilot-owned tri-state from the LLM catalogue (absent = resolve). */
  toolCallingSupport?: LlmToolCallingSupport;
  pricing?: { input?: number; output?: number };
}

interface SdkConfigField {
  path: string;
  label?: string;
  type?: string;
  placeholder?: string;
  description?: string;
}

interface SdkProviderInfo {
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
  metadata?: { configFields?: SdkConfigField[] } | null;
  models?: Record<string, SdkModelInfo>;
}

/**
 * Load the CodePilot-owned provider catalogue.
 *
 * CODEPILOT_PROVIDER_CATALOG is CodePilot's curated registry of every
 * provider its own adapters can route (the same data the CodePilot runtime
 * resolves live model handlers from), each entry carrying the provider
 * descriptor and its model catalogue.
 */
function loadSdkProviderInfo(): SdkProviderInfo[] {
  return CODEPILOT_PROVIDER_CATALOG.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    defaultModelId: p.defaultModelId,
    capabilities: p.capabilities ? [...p.capabilities] : undefined,
    env: p.env ? [...p.env] : undefined,
    client: p.client,
    metadata: p.metadata
      ? {
          configFields: p.metadata.configFields?.map((f) => ({ ...f })),
        }
      : null,
    models: Object.fromEntries(
      Object.entries(p.models ?? {}).map(([id, m]) => [id, { ...m }]),
    ),
  }));
}

// ============================================================================
// Mapping
// ============================================================================

function mapStatus(id: string): ProviderStatus {
  if (LOCAL_IDS.has(id)) return "LOCAL";
  if (id === "openai-native" || id === "gemini") return "SUPPORTED";
  return "CONFIGURABLE";
}

function categoryFor(_id: string, status: ProviderStatus): ProviderCategory {
  if (status === "LOCAL") return "local";
  return "cloud";
}

function protocolFor(sdk: SdkProviderInfo): CatalogProvider["protocol"] {
  switch (sdk.protocol) {
    case "openai-responses":
      return "openai-responses";
    case "anthropic":
      return "anthropic";
    case "gemini":
      return "gemini";
    case "ai-sdk":
      return "ai-sdk";
    case "openai-chat":
    case "openai-r1":
    default:
      return "openai-chat";
  }
}

function fieldsFor(sdk: SdkProviderInfo, _id: string): CatalogField[] {
  const out: CatalogField[] = [];
  const raw = sdk.metadata?.configFields ?? [];
  for (const f of raw) {
    const type = ((): CatalogField["type"] => {
      switch (f.type) {
        case "password":
        case "text":
        case "url":
        case "boolean":
        case "select":
          return f.type;
        default:
          return "text";
      }
    })();
    out.push({
      path: f.path,
      label: f.label ?? f.path,
      type,
      required: type === "password",
      placeholder: f.placeholder,
      description: f.description,
    });
  }
  return out;
}

function modelFor(sdkModel: SdkModelInfo, providerId: string): CatalogModel {
  const caps = sdkModel.capabilities ?? [];
  return {
    id: sdkModel.id,
    name: sdkModel.name,
    contextWindow: sdkModel.contextWindow,
    maxOutputTokens: sdkModel.maxTokens,
    reasoning: caps.includes("reasoning"),
    vision: caps.includes("images") || caps.includes("video"),
    tools: caps.includes("tools"),
    streaming: caps.includes("streaming") || caps.includes("tools"),
    // Tri-state truth: the model entry's explicit value wins; otherwise the
    // catalogue resolver decides (BYO/unlisted → "unknown", never "true").
    toolCalling:
      sdkModel.toolCallingSupport ??
      modelToolCallingSupport(providerId, sdkModel.id),
    inputPerMtok: sdkModel.pricing?.input,
    outputPerMtok: sdkModel.pricing?.output,
  };
}

let catalogCache: CatalogProvider[] | null = null;

/** Build the full catalogue from the SDK registry. Cached after first call. */
export function getProviderCatalog(): CatalogProvider[] {
  if (catalogCache) return catalogCache;
  const sdk = loadSdkProviderInfo();
  catalogCache = sdk.map((p) => {
    const id = p.id;
    const status = mapStatus(id);
    const caps = p.capabilities ?? [];
    // Model discovery: only OpenAI-compatible-style /models endpoints
    // (client openai-compatible / openai). Native clients have their own
    // catalogue data; local runtimes discover at runtime.
    const supportsDiscovery =
      p.client === "openai-compatible" || p.client === "openai";
    const models = Object.values(p.models ?? {}).map((m) => modelFor(m, id));
    return {
      id,
      displayName: p.name,
      description: DESCRIPTION_OVERRIDES[id] ?? p.description,
      category: categoryFor(id, status),
      status,
      curated: (CURATED_PROVIDER_IDS as readonly string[]).includes(id),
      protocol: protocolFor(p),
      sdkClient: p.client,
      baseUrl: p.baseUrl,
      supportsCustomBaseUrl: supportsDiscovery || LOCAL_IDS.has(id),
      requiresApiKey:
        (p.env?.length ?? 0) > 0 &&
        !LOCAL_IDS.has(id) &&
        p.client !== "vertex" &&
        p.client !== "bedrock",
      supportsOAuth: caps.includes("oauth"),
      supportsLocal: LOCAL_IDS.has(id),
      supportsModelDiscovery: supportsDiscovery,
      supportsStreaming: true,
      supportsToolCalling:
        caps.includes("tools") || p.client === "openai-compatible",
      supportsVision: caps.includes("vision"),
      supportsReasoning: caps.includes("reasoning"),
      contextWindow: models[0]?.contextWindow,
      envVars: p.env ?? [],
      fields: fieldsFor(p, id),
      models,
      defaultModelId: p.defaultModelId,
      health: {
        supportsTestConnection:
          supportsDiscovery || LOCAL_IDS.has(id) || id === "gemini",
        requiresApiKeyForProbe: requiresKeyForProbe(p, id),
        probePath: HEALTH_PROBE_PATHS[id] ?? DEFAULT_HEALTH_PROBE_PATH,
      },
      usage: {
        kind: USAGE_PROVIDER_API.has(id)
          ? "provider-api"
          : LOCAL_IDS.has(id)
            ? "none"
            : "local-tracking",
        billingPortalUrl: BILLING_PORTALS[id],
      },
    } satisfies CatalogProvider;
  });
  return catalogCache;
}

function requiresKeyForProbe(p: SdkProviderInfo, id: string): boolean {
  if (LOCAL_IDS.has(id)) return false;
  return (p.env?.length ?? 0) > 0;
}

/** Get only curated providers (primary <= 12 entries). */
export function getCuratedProviderCatalog(): CatalogProvider[] {
  return getProviderCatalog().filter((p) => p.curated);
}

/** Lookup one provider by id (supports canonical IDs and backward-compatible aliases). */
export function getCatalogProvider(id: string): CatalogProvider | undefined {
  const canonicalId =
    id === "openai" ? "openai-native" : id === "google" ? "gemini" : id;
  return getProviderCatalog().find((p) => p.id === canonicalId);
}

/** Deterministic sort: popular/local first, then alphabetical. */
export function sortCatalog(
  list: CatalogProvider[],
  favorites: readonly string[] = [],
  recent: readonly string[] = [],
): CatalogProvider[] {
  const favRank = new Map(favorites.map((id, i) => [id, i]));
  const recRank = new Map(recent.map((id, i) => [id, i]));
  const statusRank: Record<ProviderStatus, number> = {
    LOCAL: 0,
    SUPPORTED: 1,
    GATEWAY: 2,
    SUBSCRIPTION: 3,
    CONFIGURABLE: 4,
    PLANNED: 5,
  };
  return [...list].sort((a, b) => {
    const fa = favRank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const fb = favRank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (fa !== fb) return fa - fb;
    const ra = recRank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const rb = recRank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    const sa = statusRank[a.status];
    const sb = statusRank[b.status];
    if (sa !== sb) return sa - sb;
    return a.displayName.localeCompare(b.displayName);
  });
}

/** Search/filter a catalogue by text and category. Pure function. */
export function searchCatalog(
  list: CatalogProvider[],
  query: string,
  category?: ProviderCategory,
): CatalogProvider[] {
  const q = query.trim().toLowerCase();
  return list.filter((p) => {
    if (category && p.category !== category) return false;
    if (!q) return true;
    return (
      p.id.toLowerCase().includes(q) ||
      p.displayName.toLowerCase().includes(q) ||
      (p.description?.toLowerCase().includes(q) ?? false)
    );
  });
}
