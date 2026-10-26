/**
 * OpenRouter model catalogue helpers (pure logic, no React).
 *
 * This module owns every decision the OpenRouter picker makes: normalizing
 * host payloads, curating the small Recommended set from *provider metadata
 * only*, searching/filtering the full catalog, formatting model facts, and
 * persisting favorites/recents/catalog-cache in web storage.
 *
 * Honesty rules enforced here (and covered by tests):
 * - Tool support is claimed ONLY from provider metadata (`toolsKnown`).
 * - Unknown/missing metadata renders as "Unknown" or is omitted — never
 *   guessed, never popularity-ranked.
 * - Selection is never automatic: helpers return "" (show "Select a model")
 *   instead of inventing a default, and never substitute another model.
 */

export interface OpenRouterModel {
  id: string;
  name: string;
  /** Vendor prefix from the id ("openai" for "openai/gpt-4o"), else "OpenRouter". */
  vendor: string;
  description?: string;
  contextWindow?: number;
  /** Whether the model supports tool/function calling (metadata or heuristic). */
  tools: boolean;
  /** True ONLY when `tools` came from the provider's supported_parameters. */
  toolsKnown: boolean;
  vision: boolean;
  reasoning: boolean;
  /** USD per million tokens, when the provider published pricing. */
  inputPerMtok?: number;
  outputPerMtok?: number;
  /** Free tier: zero pricing on both sides, or the ":free" id convention. */
  free: boolean;
}

/**
 * Host `provider/models` entry shape (superset of the old `{id, name?}`
 * rows; every rich field optional so other providers keep working).
 */
export interface OpenRouterHostModel {
  id: string;
  name?: string;
  description?: string;
  contextWindow?: number;
  tools?: boolean;
  toolsProvenance?: "metadata" | "heuristic";
  vision?: boolean;
  reasoning?: boolean;
  inputPerMtok?: number;
  outputPerMtok?: number;
}

interface HostModelEntry {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  contextWindow?: unknown;
  tools?: unknown;
  toolsProvenance?: unknown;
  vision?: unknown;
  reasoning?: unknown;
  inputPerMtok?: unknown;
  outputPerMtok?: unknown;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function asFiniteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Normalize one host catalogue entry. Entries without a usable id are
 * dropped (returned undefined) — an unidentifiable row can never be
 * selected, so it must never be displayed.
 */
export function normalizeOpenRouterModel(
  entry: unknown,
): OpenRouterModel | undefined {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }
  const e = entry as HostModelEntry;
  const id = asNonEmptyString(e.id)?.trim();
  if (!id) return undefined;
  const name = asNonEmptyString(e.name)?.trim() ?? id;
  const slash = id.indexOf("/");
  const vendor = slash > 0 ? id.slice(0, slash) : "OpenRouter";
  const tools = e.tools === true;
  const toolsKnown = e.toolsProvenance === "metadata";
  const contextWindow =
    typeof e.contextWindow === "number" &&
    Number.isFinite(e.contextWindow) &&
    e.contextWindow > 0
      ? Math.floor(e.contextWindow)
      : undefined;
  const inputPerMtok = asFiniteNonNegative(e.inputPerMtok);
  const outputPerMtok = asFiniteNonNegative(e.outputPerMtok);
  const pricedFree = inputPerMtok === 0 && outputPerMtok === 0;
  return {
    id,
    name,
    vendor,
    description: asNonEmptyString(e.description)?.trim().slice(0, 500),
    contextWindow,
    tools,
    toolsKnown,
    vision: e.vision === true,
    reasoning: e.reasoning === true,
    ...(inputPerMtok !== undefined ? { inputPerMtok } : {}),
    ...(outputPerMtok !== undefined ? { outputPerMtok } : {}),
    free: pricedFree || id.endsWith(":free"),
  };
}

/** Normalize a host payload (bare array or `{ models }` wrapper). */
export function normalizeOpenRouterCatalog(input: unknown): OpenRouterModel[] {
  const raw = Array.isArray(input)
    ? input
    : (input as { models?: unknown } | null)?.models;
  if (!Array.isArray(raw)) return [];
  const out: OpenRouterModel[] = [];
  for (const entry of raw) {
    const model = normalizeOpenRouterModel(entry);
    if (model) out.push(model);
  }
  return out;
}

// ============================================================================
// Recommended set (capability-gated, never popularity-ranked)
// ============================================================================

/** Minimum context window for the Recommended set (documented judgment). */
export const MIN_RECOMMENDED_CONTEXT = 32_000;

/** Maximum Recommended rows rendered before "View all". */
export const MAX_RECOMMENDED = 8;

/**
 * Curated Recommended set for coding agents, derived SOLELY from provider
 * metadata: verified tool support + a reasonable context window. Because
 * `toolsKnown` is true only for live OpenRouter discovery entries, this
 * also implies current catalogue availability — static/unknown entries are
 * never recommended. Sorted by context descending, then id. Capped.
 */
export function curateRecommended(
  models: OpenRouterModel[],
): OpenRouterModel[] {
  return models
    .filter(
      (m) =>
        m.toolsKnown &&
        m.tools &&
        (m.contextWindow ?? 0) >= MIN_RECOMMENDED_CONTEXT,
    )
    .sort(
      (a, b) =>
        (b.contextWindow ?? 0) - (a.contextWindow ?? 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .slice(0, MAX_RECOMMENDED);
}

// ============================================================================
// Search + filters (client-side over the loaded catalog)
// ============================================================================

export type ModelFilter =
  | "all"
  | "coding"
  | "tools"
  | "reasoning"
  | "vision"
  | "free"
  | "favorites"
  | "recent";

/** Maximum search rows rendered (the catalog itself is never fully rendered). */
export const MAX_SEARCH_RESULTS = 50;

/**
 * Search the loaded catalog. Every whitespace-separated term must match
 * (AND). Terms match id, name, vendor, or description substrings; the
 * capability terms "tool"/"tools"/"function" match metadata-verified tool
 * support only, "vision"/"reasoning"/"free" match their flags, and
 * "code"/"coding"/"coder" match text (ids, names, descriptions) honestly —
 * never an invented capability. Ranked: exact id, id prefix, then catalog
 * order. Capped at MAX_SEARCH_RESULTS.
 */
export function searchModels(
  models: OpenRouterModel[],
  query: string,
  recommendedIds?: ReadonlySet<string>,
): OpenRouterModel[] {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return [];
  const hits: Array<{ model: OpenRouterModel; rank: number }> = [];
  for (const model of models) {
    const id = model.id.toLowerCase();
    const name = model.name.toLowerCase();
    const vendor = model.vendor.toLowerCase();
    const description = (model.description ?? "").toLowerCase();
    let ok = true;
    let rank = 3;
    for (const term of terms) {
      const textHit =
        id.includes(term) ||
        name.includes(term) ||
        vendor.includes(term) ||
        (description.length > 0 && description.includes(term));
      const capabilityHit =
        ((term === "tool" || term === "tools" || term === "function") &&
          model.toolsKnown &&
          model.tools) ||
        (term === "vision" && model.vision) ||
        (term === "reasoning" && model.reasoning) ||
        (term === "free" && model.free) ||
        ((term === "coding" || term === "code" || term === "coder") &&
          (recommendedIds?.has(model.id) ?? false));
      if (!textHit && !capabilityHit) {
        ok = false;
        break;
      }
      if (id === term) rank = Math.min(rank, 0);
      else if (id.startsWith(term)) rank = Math.min(rank, 1);
      else if (name.startsWith(term)) rank = Math.min(rank, 2);
    }
    if (ok) hits.push({ model, rank });
  }
  hits.sort((a, b) => a.rank - b.rank);
  return hits.slice(0, MAX_SEARCH_RESULTS).map((h) => h.model);
}

export interface ModelFilterOption {
  id: ModelFilter;
  label: string;
  count: number;
}

/**
 * Filter options with live counts. Capability filters (coding/tools/
 * reasoning/vision/free) appear ONLY when at least one catalog entry
 * matches — filters are never offered for unavailable capabilities.
 * All/Favorites/Recent are always present (they describe selection state,
 * not provider metadata).
 */
export function availableFilters(
  models: OpenRouterModel[],
  favorites: readonly string[],
  recent: readonly string[],
): ModelFilterOption[] {
  const ids = new Set(models.map((m) => m.id));
  const recommended = new Set(curateRecommended(models).map((m) => m.id));
  const count = (pred: (m: OpenRouterModel) => boolean): number =>
    models.filter(pred).length;
  const options: ModelFilterOption[] = [
    { id: "all", label: "All", count: models.length },
  ];
  const coding = count((m) => recommended.has(m.id));
  if (coding > 0)
    options.push({ id: "coding", label: "Coding", count: coding });
  const tools = count((m) => m.toolsKnown && m.tools);
  if (tools > 0) options.push({ id: "tools", label: "Tools", count: tools });
  const reasoning = count((m) => m.reasoning);
  if (reasoning > 0) {
    options.push({ id: "reasoning", label: "Reasoning", count: reasoning });
  }
  const vision = count((m) => m.vision);
  if (vision > 0)
    options.push({ id: "vision", label: "Vision", count: vision });
  const free = count((m) => m.free);
  if (free > 0) options.push({ id: "free", label: "Free", count: free });
  options.push({
    id: "favorites",
    label: "Favorites",
    count: favorites.filter((id) => ids.has(id)).length,
  });
  options.push({
    id: "recent",
    label: "Recent",
    count: recent.filter((id) => ids.has(id)).length,
  });
  return options;
}

export interface FilterContext {
  favorites: readonly string[];
  recent: readonly string[];
  recommendedIds: ReadonlySet<string>;
}

/** Apply one filter. Unknown ids fall back to the full list (never empty). */
export function filterModels(
  models: OpenRouterModel[],
  filter: ModelFilter,
  ctx: FilterContext,
): OpenRouterModel[] {
  switch (filter) {
    case "coding":
      return models.filter((m) => ctx.recommendedIds.has(m.id));
    case "tools":
      return models.filter((m) => m.toolsKnown && m.tools);
    case "reasoning":
      return models.filter((m) => m.reasoning);
    case "vision":
      return models.filter((m) => m.vision);
    case "free":
      return models.filter((m) => m.free);
    case "favorites": {
      const order = new Map(ctx.favorites.map((id, i) => [id, i] as const));
      return models
        .filter((m) => order.has(m.id))
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    }
    case "recent": {
      const order = new Map(ctx.recent.map((id, i) => [id, i] as const));
      return models
        .filter((m) => order.has(m.id))
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    }
    case "all":
    default:
      return [...models];
  }
}

// ============================================================================
// Model facts display (unknowns stay unknown)
// ============================================================================

/** "128k" / "1.5M" / raw count; "Unknown" when unavailable. */
export function formatContext(contextWindow?: number): string {
  if (
    typeof contextWindow !== "number" ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    return "Unknown";
  }
  if (contextWindow >= 1_000_000) {
    const v = contextWindow / 1_000_000;
    return `${Number.isInteger(v) ? v : v.toFixed(1)}M`;
  }
  if (contextWindow >= 1000) {
    return `${Math.round(contextWindow / 1000)}k`;
  }
  return String(Math.floor(contextWindow));
}

function formatUsd(value: number): string {
  if (value === 0) return "0";
  if (value >= 100) return String(Math.round(value));
  if (value >= 1) return String(Number(value.toFixed(2)));
  return String(Number(value.toFixed(4)));
}

/** Pricing line, "Free", or "Unknown" — never guessed. */
export function formatPricing(model: OpenRouterModel): string {
  if (model.free) return "Free";
  if (model.inputPerMtok !== undefined || model.outputPerMtok !== undefined) {
    const input =
      model.inputPerMtok !== undefined
        ? `$${formatUsd(model.inputPerMtok)}/Mtok in`
        : "in ?";
    const output =
      model.outputPerMtok !== undefined
        ? `$${formatUsd(model.outputPerMtok)}/Mtok out`
        : "out ?";
    return `${input} · ${output}`;
  }
  return "Unknown";
}

/** Compact info-panel rows; unknown fields are omitted (never invented). */
export function modelInfoLines(model: OpenRouterModel): Array<{
  label: string;
  value: string;
}> {
  const rows = [
    { label: "Model", value: model.name },
    { label: "Model ID", value: model.id },
    { label: "Provider", value: model.vendor },
    { label: "Context", value: formatContext(model.contextWindow) },
  ];
  const capabilities: string[] = [];
  if (model.toolsKnown && model.tools) capabilities.push("Tool calling");
  if (model.vision) capabilities.push("Vision");
  if (model.reasoning) capabilities.push("Reasoning");
  rows.push({
    label: "Capabilities",
    value: capabilities.length > 0 ? capabilities.join(" · ") : "Unknown",
  });
  rows.push({ label: "Pricing", value: formatPricing(model) });
  rows.push({
    label: "Free",
    value: model.free
      ? "Yes"
      : model.inputPerMtok !== undefined || model.outputPerMtok !== undefined
        ? "No"
        : "Unknown",
  });
  if (model.description) {
    rows.push({ label: "About", value: model.description });
  }
  return rows;
}

/** Exact warning copy required when tool support is not metadata-verified. */
export const TOOL_CALLING_WARNING =
  "This model may not support the structured tool calling required by CodePilot's agent mode.";

/** Follow-up shown under a verified "Tool calling supported" badge. */
export const TOOL_SUPPORT_DISCLAIMER =
  "Runtime compatibility still depends on the provider/model response format.";

/** Tool-compatibility verdict for the selected model. */
export function toolSupportVerdict(model: OpenRouterModel): {
  supported: boolean;
  heading: string;
  body?: string;
} {
  if (model.toolsKnown && model.tools) {
    return {
      supported: true,
      heading: "Tool calling supported",
      body: TOOL_SUPPORT_DISCLAIMER,
    };
  }
  return { supported: false, heading: TOOL_CALLING_WARNING };
}

// ============================================================================
// Selection resolution (never automatic, never cross-provider)
// ============================================================================

export interface UserModelSelection {
  providerId: string;
  modelId: string;
}

/**
 * Resolve which model id the picker should display/use after a catalogue
 * refresh. Returns "" when nothing valid applies (the UI shows
 * "Select a model"). NEVER returns the first catalogue entry, NEVER another
 * provider's id, and NEVER Ollama:
 * - offered (in this provider's list, incl. a manually entered id the user
 *   set for this provider) → keep exactly;
 * - else the catalogue default, but ONLY if offered;
 * - else "" (explicit unselected state).
 */
export function resolveSelectedModel(
  current: string,
  offeredIds: ReadonlySet<string>,
  userSet: UserModelSelection | null,
  currentProviderId: string,
  catalogDefaultId?: string | undefined,
): string {
  if (current && offeredIds.has(current)) return current;
  if (
    userSet &&
    userSet.providerId === currentProviderId &&
    userSet.modelId === current &&
    current.length > 0
  ) {
    return current;
  }
  if (
    catalogDefaultId &&
    catalogDefaultId.length > 0 &&
    offeredIds.has(catalogDefaultId)
  ) {
    return catalogDefaultId;
  }
  return "";
}

// ============================================================================
// Favorites / recents (model ids only — never credentials)
// ============================================================================

const FAVORITES_KEY = "codepilot.openrouter.favorites.v1";
const RECENT_KEY = "codepilot.openrouter.recent.v1";

/** Maximum recent models remembered. */
export const RECENT_MAX = 10;

export interface StringListStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function safeStorage(
  storage?: StringListStorage,
): StringListStorage | undefined {
  if (storage) return storage;
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    return undefined;
  }
  return undefined;
}

function readStringList(
  storage: StringListStorage | undefined,
  key: string,
): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
  } catch {
    return [];
  }
}

function writeStringList(
  storage: StringListStorage | undefined,
  key: string,
  ids: string[],
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(ids));
    return true;
  } catch {
    return false;
  }
}

export function loadFavorites(storage?: StringListStorage): string[] {
  return readStringList(safeStorage(storage), FAVORITES_KEY);
}

export function toggleFavorite(
  storage: StringListStorage | undefined,
  id: string,
): string[] {
  const current = loadFavorites(storage);
  const next = current.includes(id)
    ? current.filter((v) => v !== id)
    : [...current, id].slice(0, 50);
  writeStringList(safeStorage(storage), FAVORITES_KEY, next);
  return next;
}

export function loadRecent(storage?: StringListStorage): string[] {
  return readStringList(safeStorage(storage), RECENT_KEY).slice(0, RECENT_MAX);
}

export function pushRecent(
  storage: StringListStorage | undefined,
  id: string,
): string[] {
  if (!id) return loadRecent(storage);
  const next = [id, ...loadRecent(storage).filter((v) => v !== id)].slice(
    0,
    RECENT_MAX,
  );
  writeStringList(safeStorage(storage), RECENT_KEY, next);
  return next;
}

// ============================================================================
// Catalogue cache (bounded, provider-scoped, quota-safe)
// ============================================================================

/** How long a cached OpenRouter catalogue is trusted (documented choice). */
export const OR_CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const CACHE_KEY = "codepilot.openrouter.catalog.v1";

export interface CachedCatalog {
  savedAt: number;
  models: OpenRouterModel[];
}

/** Read a shape-validated cache entry, or null (missing/stale/invalid). */
export function readCatalogCache(
  storage?: StringListStorage,
): CachedCatalog | null {
  const store = safeStorage(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const entry = parsed as { savedAt?: unknown; models?: unknown };
    if (typeof entry.savedAt !== "number" || !Array.isArray(entry.models)) {
      return null;
    }
    const models = normalizeOpenRouterCatalog(entry.models);
    return { savedAt: entry.savedAt, models };
  } catch {
    return null;
  }
}

/** Persist normalized models; false when storage is unavailable/full. */
export function writeCatalogCache(
  storage: StringListStorage | undefined,
  models: OpenRouterModel[],
  now: number = Date.now(),
): boolean {
  const store = safeStorage(storage);
  if (!store) return false;
  try {
    store.setItem(
      CACHE_KEY,
      JSON.stringify({ savedAt: now, models: models.slice(0, 2000) }),
    );
    return true;
  } catch {
    return false;
  }
}

/** True when a cache timestamp is within the TTL (clock-skew tolerant). */
export function isCatalogFresh(
  savedAt: number,
  now: number = Date.now(),
): boolean {
  if (!Number.isFinite(savedAt) || !Number.isFinite(now)) return false;
  const age = now - savedAt;
  return age >= 0 && age <= OR_CATALOG_CACHE_TTL_MS;
}
