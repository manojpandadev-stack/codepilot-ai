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

import { CODEPILOT_PROVIDER_CATALOG } from "@codepilot/llm";
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
const USAGE_PROVIDER_API: ReadonlySet<string> = new Set([
  // OpenRouter documents GET /api/v1/credits (auth: Bearer key).
  "openrouter",
]);

const BILLING_PORTALS: Readonly<Record<string, string>> = {
  openai: "https://platform.openai.com/usage",
  anthropic: "https://console.anthropic.com/settings/billing",
  "openai-native": "https://platform.openai.com/usage",
  gemini: "https://console.cloud.google.com/billing",
  together: "https://api.together.xyz/settings/billing",
  fireworks: "https://fireworks.ai/account/billing",
  groq: "https://console.groq.com/settings/billing",
  deepseek: "https://platform.deepseek.com/usage",
  moonshot: "https://platform.moonshot.ai/console",
  minimax: "https://platform.minimax.io",
  zhipuai: "https://open.bigmodel.cn",
  zai: "https://z.ai",
  "302ai": "https://api.302.ai",
  openrouter: "https://openrouter.ai/credits",
  cerebras: "https://cloud.cerebras.ai",
  huggingface: "https://huggingface.co/settings/billing",
};

/** Providers that primarily authenticate via a subscription/OAuth flow. */
const SUBSCRIPTION_IDS: ReadonlySet<string> = new Set([
  "openai-codex", // ChatGPT subscription
  "openai-codex-cli",
  "claude-code",
  "cline", // Cline account
  "cline-pass",
  "github-copilot",
  "qwen-code",
  "opencode",
]);

/** Local runtimes. */
const LOCAL_IDS: ReadonlySet<string> = new Set(["ollama", "lmstudio"]);

/**
 * Per-provider Test Connection probe paths (appended to the provider's base
 * URL). Vendors genuinely differ — this is authoritative data, not a guess:
 *   - Ollama: native API. Model listing/health is `GET /api/tags`.
 *     `GET /models` and `GET /` both return 404 there.
 *   - LM Studio & everything else that supports a probe: OpenAI-compatible
 *     `GET {base}/models` (the SDK baseUrl already carries the `/v1` prefix).
 */
const HEALTH_PROBE_PATHS: Readonly<Record<string, string>> = {
  ollama: OLLAMA_API_TAGS, // "/api/tags"
  lmstudio: "/models",
};

/** Default probe path for providers without a vendor-specific one. */
const DEFAULT_HEALTH_PROBE_PATH = "/models";

/** Multi-provider gateways/routers. */
const GATEWAY_IDS: ReadonlySet<string> = new Set([
  "openrouter",
  "requesty",
  "litellm",
  "vercel-ai-gateway",
  "unorouter",
  "orcarouter",
  "fastrouter",
  "trustedrouter",
  "llmgateway",
  "kilo",
  "aihubmix",
  "zenmux",
  "anyapi",
  "helicone",
  "wandb",
]);

const DESCRIPTION_OVERRIDES: Readonly<Record<string, string>> = {
  "openai-native": "GPT models via the official OpenAI API.",
  "openai-codex": "OpenAI models through a ChatGPT subscription.",
  anthropic: "Claude models via the official Anthropic API.",
  gemini: "Google Gemini models via the Gemini API.",
  vertex: "Google Gemini models via Vertex AI (GCP project billing).",
  bedrock: "Claude and other models via AWS Bedrock (IAM credentials).",
  ollama: "Run open models locally — nothing leaves your machine.",
  lmstudio: "Local models served by LM Studio on this machine.",
  openai: "OpenAI-Compatible endpoints (custom base URL + model).",
  "openai-compatible":
    "Any OpenAI-compatible API — bring your own base URL, key and model.",
  openrouter:
    "One API for 280+ models from many providers, with a live credits API.",
  deepseek: "DeepSeek chat and reasoner models.",
  together: "Open-weight models hosted by Together AI.",
  zai: "Z.AI GLM models (Zhipu international).",
  zhipuai: "Zhipu GLM models (China platform).",
  moonshot: "Moonshot Kimi models.",
  minimax: "MiniMax M-series models (Anthropic-compatible endpoint).",
  groq: "Ultra-fast inference for open models on LPU hardware.",
  cerebras: "Wafer-scale fast inference for open models.",
  fireworks: "Fireworks AI hosted open models.",
  requesty: "Multi-provider router with per-request routing controls.",
  litellm: "Self-hosted LiteLLM proxy (OpenAI-compatible).",
  huggingface: "Hugging Face Inference Providers router.",
  "github-copilot": "GitHub Copilot models via GitHub authentication.",
  "claude-code": "Claude models via a Claude subscription login.",
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
  if (SUBSCRIPTION_IDS.has(id)) return "SUBSCRIPTION";
  if (GATEWAY_IDS.has(id)) return "GATEWAY";
  // Known cloud providers with first-class native providers. Note: only ids
  // present in CODEPILOT_PROVIDER_CATALOG ever reach this mapping; the
  // remaining entries are dormant until a matching catalogue entry exists.
  const firstClass = new Set([
    "openai-native",
    "anthropic",
    "gemini",
    "vertex",
    "bedrock",
    "deepseek",
    "mistral",
    "xai",
    "together",
    "fireworks",
    "groq",
    "cerebras",
    "sambanova",
    "nebius",
    "baseten",
    "requesty",
    "huggingface",
    "302ai",
    "alibaba",
    "minimax",
    "moonshot",
    "zhipuai",
    "zai",
    "stepfun",
    "stepfun-ai",
    "upstage",
    "xiaomi",
    "doubao",
    "modelscope",
    "novita-ai",
    "nvidia",
    "vultr",
    "scaleway",
    "ovhcloud",
    "digitalocean",
    "neon",
    "crusoe",
    "modal",
    "gmicloud",
    "hyper",
    "tinfoil",
    "privatemode-ai",
    "sapaicore",
    "databricks",
    "snowflake-cortex",
    "clarifai",
    "vercel-ai-gateway",
    "v0",
    "vercel-ai-gateway",
  ]);
  if (firstClass.has(id)) return "SUPPORTED";
  // Any other catalogue id without a dedicated native provider speaks
  // OpenAI-compatible via an explicit base URL.
  return "CONFIGURABLE";
}

function categoryFor(id: string, status: ProviderStatus): ProviderCategory {
  if (status === "LOCAL") return "local";
  if (status === "GATEWAY" || status === "SUBSCRIPTION") return "gateway";
  if (id === "openai" || id === "openai-compatible" || id === "custom") {
    return "custom";
  }
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

function fieldsFor(sdk: SdkProviderInfo, id: string): CatalogField[] {
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
      required:
        type === "password" && (id !== "openrouter" || f.path === "apiKey"),
      placeholder: f.placeholder,
      description: f.description,
    });
  }
  return out;
}

function modelFor(sdkModel: SdkModelInfo): CatalogModel {
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
    const models = Object.values(p.models ?? {}).map(modelFor);
    return {
      id,
      displayName: p.name,
      description: DESCRIPTION_OVERRIDES[id] ?? p.description,
      category: categoryFor(id, status),
      status,
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
        supportsTestConnection: supportsDiscovery || LOCAL_IDS.has(id),
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
  if (id === "openrouter") return false; // lists models without a key
  return (p.env?.length ?? 0) > 0;
}

/** Lookup one provider by id. */
export function getCatalogProvider(id: string): CatalogProvider | undefined {
  return getProviderCatalog().find((p) => p.id === id);
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
