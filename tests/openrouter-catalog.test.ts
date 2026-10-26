/**
 * OpenRouter model catalogue regression tests (redesign acceptance).
 *
 * All pure logic (no DOM, no network): normalize, curate, search, filters,
 * info display, selection resolution, favorites/recents, cache. Each numbered
 * item maps to the redesign objective's test list.
 */
import { describe, expect, it } from "vitest";
import {
  availableFilters,
  curateRecommended,
  filterModels,
  formatContext,
  formatPricing,
  isCatalogFresh,
  loadFavorites,
  loadRecent,
  MAX_RECOMMENDED,
  MAX_SEARCH_RESULTS,
  MIN_RECOMMENDED_CONTEXT,
  modelInfoLines,
  normalizeOpenRouterCatalog,
  OR_CATALOG_CACHE_TTL_MS,
  pushRecent,
  readCatalogCache,
  RECENT_MAX,
  resolveSelectedModel,
  searchModels,
  toggleFavorite,
  TOOL_CALLING_WARNING,
  toolSupportVerdict,
  writeCatalogCache,
  type OpenRouterHostModel,
  type StringListStorage,
} from "../apps/webview/src/lib/openrouter-catalog.js";

/** In-memory web-storage stand-in (no browser needed). */
function memStorage(initial: Record<string, string> = {}): StringListStorage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

function hostModel(
  partial: Partial<OpenRouterHostModel> & { id: string },
): OpenRouterHostModel {
  return { ...partial };
}

const TOOL_MODEL = hostModel({
  id: "acme/coder-1",
  name: "Acme Coder",
  description: "A coding model with tool support.",
  contextWindow: 128000,
  tools: true,
  toolsProvenance: "metadata",
  vision: false,
  reasoning: false,
  inputPerMtok: 0.5,
  outputPerMtok: 1.5,
});

const NO_TOOL_MODEL = hostModel({
  id: "acme/chat-1",
  name: "Acme Chat",
  contextWindow: 64000,
  tools: false,
  toolsProvenance: "metadata",
});

const HEURISTIC_MODEL = hostModel({
  id: "acme/mystery-1",
  contextWindow: 200000,
  tools: true,
});

const SMALL_TOOL_MODEL = hostModel({
  id: "acme/tiny-coder",
  contextWindow: 8000,
  tools: true,
  toolsProvenance: "metadata",
});

const FREE_MODEL = hostModel({
  id: "acme/free-1:free",
  contextWindow: 32000,
  tools: true,
  toolsProvenance: "metadata",
  inputPerMtok: 0,
  outputPerMtok: 0,
});

const VISION_MODEL = hostModel({
  id: "acme/looker",
  contextWindow: 128000,
  tools: true,
  toolsProvenance: "metadata",
  vision: true,
});

const REASON_MODEL = hostModel({
  id: "acme/thinker",
  contextWindow: 128000,
  tools: true,
  toolsProvenance: "metadata",
  reasoning: true,
});

const ALL = [
  TOOL_MODEL,
  NO_TOOL_MODEL,
  HEURISTIC_MODEL,
  SMALL_TOOL_MODEL,
  FREE_MODEL,
  VISION_MODEL,
  REASON_MODEL,
];

function normalized(): ReturnType<typeof normalizeOpenRouterCatalog> {
  return normalizeOpenRouterCatalog(ALL);
}

describe("1. curated model list", () => {
  it("recommends only metadata-verified tool models with reasonable context", () => {
    const rec = curateRecommended(normalized());
    const ids = rec.map((m) => m.id);
    expect(ids).toContain("acme/coder-1");
    // Heuristic-only tools flag is NOT enough (never presented as verified).
    expect(ids).not.toContain("acme/mystery-1");
    // Metadata-verified LACK of tools excludes.
    expect(ids).not.toContain("acme/chat-1");
    // Below the documented context threshold.
    expect(ids).not.toContain("acme/tiny-coder");
  });

  it("is sorted by context descending and capped", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      hostModel({
        id: `acme/coder-${i}`,
        contextWindow: 200000 - i * 1000,
        tools: true,
        toolsProvenance: "metadata",
      }),
    );
    const rec = curateRecommended(normalizeOpenRouterCatalog(many));
    expect(rec.length).toBeLessThanOrEqual(MAX_RECOMMENDED);
    expect(rec.length).toBe(MAX_RECOMMENDED);
    for (let i = 1; i < rec.length; i++) {
      expect(rec[i - 1]!.contextWindow ?? 0).toBeGreaterThanOrEqual(
        rec[i]!.contextWindow ?? 0,
      );
    }
  });

  it("is empty when nothing is verifiable (never popularity-ranked)", () => {
    expect(
      curateRecommended(normalizeOpenRouterCatalog([HEURISTIC_MODEL])),
    ).toEqual([]);
  });
});

describe("2-4. full catalog search", () => {
  it("finds qwen models by name fragment", () => {
    const models = normalizeOpenRouterCatalog([
      { id: "qwen/qwen3-coder", name: "Qwen Coder" },
      { id: "openai/gpt-4o-mini" },
    ]);
    expect(searchModels(models, "qwen").map((m) => m.id)).toEqual([
      "qwen/qwen3-coder",
    ]);
  });

  it("finds gpt models by id fragment", () => {
    const models = normalizeOpenRouterCatalog([
      { id: "qwen/qwen3-coder" },
      { id: "openai/gpt-4o-mini" },
      { id: "openai/gpt-4o" },
    ]);
    const ids = searchModels(models, "gpt").map((m) => m.id);
    expect(ids).toContain("openai/gpt-4o-mini");
    expect(ids).toContain("openai/gpt-4o");
    expect(ids).not.toContain("qwen/qwen3-coder");
  });

  it("matches every term (AND), including vendor + capability", () => {
    const models = normalized();
    const ids = searchModels(models, "acme tool").map((m) => m.id);
    expect(ids).toContain("acme/coder-1");
    // "tool" matches only metadata-verified support, not heuristic flags.
    expect(ids).not.toContain("acme/mystery-1");
    expect(ids).not.toContain("acme/chat-1");
  });

  it("searches by exact model ID first", () => {
    const models = normalizeOpenRouterCatalog([
      { id: "openai/gpt-4o-mini" },
      { id: "openai/gpt-4o" },
    ]);
    expect(searchModels(models, "openai/gpt-4o-mini")[0]?.id).toBe(
      "openai/gpt-4o-mini",
    );
  });

  it("searches by provider vendor prefix", () => {
    const models = normalizeOpenRouterCatalog([
      { id: "anthropic/claude-sonnet" },
      { id: "openai/gpt-4o-mini" },
    ]);
    expect(searchModels(models, "anthropic").map((m) => m.id)).toEqual([
      "anthropic/claude-sonnet",
    ]);
  });

  it("caps result lists instead of rendering everything", () => {
    const many = Array.from({ length: MAX_SEARCH_RESULTS + 40 }, (_, i) =>
      hostModel({ id: `acme/model-${i}` }),
    );
    expect(searchModels(normalizeOpenRouterCatalog(many), "acme").length).toBe(
      MAX_SEARCH_RESULTS,
    );
  });
});

describe("5. capability filtering", () => {
  const favs: string[] = [];
  const recents: string[] = [];
  const rec = () => new Set(curateRecommended(normalized()).map((m) => m.id));

  it("filters tools by verified metadata only", () => {
    const out = filterModels(normalized(), "tools", {
      favorites: favs,
      recent: recents,
      recommendedIds: rec(),
    }).map((m) => m.id);
    expect(out).toContain("acme/coder-1");
    expect(out).not.toContain("acme/mystery-1");
    expect(out).not.toContain("acme/chat-1");
  });

  it("filters reasoning, vision, and free", () => {
    const models = normalized();
    const ctx = { favorites: favs, recent: recents, recommendedIds: rec() };
    expect(filterModels(models, "reasoning", ctx).map((m) => m.id)).toEqual([
      "acme/thinker",
    ]);
    expect(filterModels(models, "vision", ctx).map((m) => m.id)).toEqual([
      "acme/looker",
    ]);
    expect(filterModels(models, "free", ctx).map((m) => m.id)).toEqual([
      "acme/free-1:free",
    ]);
  });

  it("hides capability filters with zero matches", () => {
    const models = normalizeOpenRouterCatalog([NO_TOOL_MODEL]);
    const opts = availableFilters(models, [], []);
    const ids = opts.map((o) => o.id);
    expect(ids).toContain("all");
    expect(ids).toContain("favorites");
    expect(ids).toContain("recent");
    expect(ids).not.toContain("tools");
    expect(ids).not.toContain("coding");
    expect(ids).not.toContain("reasoning");
    expect(ids).not.toContain("vision");
    expect(ids).not.toContain("free");
  });

  it("reports counts for offered filters", () => {
    const opts = availableFilters(normalized(), [], []);
    const byId = new Map(opts.map((o) => [o.id, o.count]));
    expect(byId.get("all")).toBe(7);
    expect(byId.get("tools")).toBe(5);
  });
});

describe("6-7. tool display and unknown metadata", () => {
  it("shows Supported only for verified tool calling", () => {
    const [m] = normalizeOpenRouterCatalog([TOOL_MODEL]);
    expect(toolSupportVerdict(m!).supported).toBe(true);
    expect(toolSupportVerdict(m!).heading).toBe("Tool calling supported");
  });

  it("never presents heuristic or missing support as compatible", () => {
    for (const raw of [HEURISTIC_MODEL, NO_TOOL_MODEL, { id: "x/y" }]) {
      const [m] = normalizeOpenRouterCatalog([raw]);
      const verdict = toolSupportVerdict(m!);
      expect(verdict.supported).toBe(false);
      expect(verdict.heading).toBe(TOOL_CALLING_WARNING);
    }
  });

  it("renders Unknown for missing facts and omits nothing invented", () => {
    const [m] = normalizeOpenRouterCatalog([{ id: "x/y" }]);
    const rows = new Map(modelInfoLines(m!).map((r) => [r.label, r.value]));
    expect(rows.get("Model ID")).toBe("x/y");
    expect(rows.get("Provider")).toBe("x");
    expect(rows.get("Context")).toBe("Unknown");
    expect(rows.get("Capabilities")).toBe("Unknown");
    expect(rows.get("Pricing")).toBe("Unknown");
    expect(rows.get("Free")).toBe("Unknown");
    expect(rows.has("About")).toBe(false);
  });

  it("formats real facts when present", () => {
    const [m] = normalizeOpenRouterCatalog([TOOL_MODEL]);
    const rows = new Map(modelInfoLines(m!).map((r) => [r.label, r.value]));
    expect(rows.get("Model")).toBe("Acme Coder");
    expect(rows.get("Context")).toBe("128k");
    expect(rows.get("Capabilities")).toContain("Tool calling");
    expect(rows.get("Pricing")).toContain("/Mtok");
    expect(rows.get("Free")).toBe("No");
    expect(rows.get("About")).toContain("coding model");
  });

  it("formats context windows and pricing", () => {
    expect(formatContext(128000)).toBe("128k");
    expect(formatContext(1500000)).toBe("1.5M");
    expect(formatContext(undefined)).toBe("Unknown");
    expect(formatPricing(normalized()[0]!)).toContain("/Mtok");
    const [free] = normalizeOpenRouterCatalog([FREE_MODEL]);
    expect(formatPricing(free!)).toBe("Free");
  });

  it("drops unidentifiable entries", () => {
    expect(normalizeOpenRouterCatalog([{}, { id: "" }, null, 42]).length).toBe(
      0,
    );
  });
});

describe("8 + 11 + 16. selection resolution (never automatic)", () => {
  const offered = new Set(["acme/coder-1", "acme/chat-1"]);

  it("preserves the offered current model exactly", () => {
    expect(
      resolveSelectedModel("acme/coder-1", offered, null, "openrouter"),
    ).toBe("acme/coder-1");
  });

  it("preserves a manually entered id across refreshes", () => {
    expect(
      resolveSelectedModel(
        "acme/custom:free",
        offered,
        { providerId: "openrouter", modelId: "acme/custom:free" },
        "openrouter",
      ),
    ).toBe("acme/custom:free");
  });

  it("ignores user-set ids from other providers (separation)", () => {
    expect(
      resolveSelectedModel(
        "qwen3:8b",
        offered,
        { providerId: "ollama", modelId: "qwen3:8b" },
        "openrouter",
      ),
    ).toBe("");
  });

  it("uses the catalogue default only when offered", () => {
    expect(
      resolveSelectedModel(
        "stale-id",
        offered,
        null,
        "openrouter",
        "acme/chat-1",
      ),
    ).toBe("acme/chat-1");
    expect(
      resolveSelectedModel("stale-id", offered, null, "openrouter", "other/x"),
    ).toBe("");
  });

  it("never returns the first catalogue entry or another provider", () => {
    expect(resolveSelectedModel("stale-id", offered, null, "openrouter")).toBe(
      "",
    );
    expect(resolveSelectedModel("", offered, null, "openrouter")).toBe("");
  });
});

describe("9-10. favorites and recents", () => {
  it("toggles favorites with persistence", () => {
    const store = memStorage();
    expect(loadFavorites(store)).toEqual([]);
    expect(toggleFavorite(store, "a/b")).toEqual(["a/b"]);
    expect(loadFavorites(store)).toEqual(["a/b"]);
    expect(toggleFavorite(store, "a/b")).toEqual([]);
    expect(loadFavorites(store)).toEqual([]);
  });

  it("orders recents most-recent-first, deduped and capped", () => {
    const store = memStorage();
    pushRecent(store, "a/1");
    pushRecent(store, "b/2");
    pushRecent(store, "a/1");
    expect(loadRecent(store)).toEqual(["a/1", "b/2"]);
    for (let i = 0; i < RECENT_MAX + 5; i++) pushRecent(store, `m/${i}`);
    expect(loadRecent(store).length).toBeLessThanOrEqual(RECENT_MAX);
    expect(loadRecent(store)[0]).toBe(`m/${RECENT_MAX + 4}`);
  });

  it("survives corrupt storage without throwing", () => {
    const store = memStorage({
      "codepilot.openrouter.favorites.v1": "not-json{{",
    });
    expect(loadFavorites(store)).toEqual([]);
    expect(loadRecent(undefined)).toEqual([]);
    expect(toggleFavorite(undefined, "a/b")).toEqual(["a/b"]);
  });
});

describe("12. provider separation", () => {
  it("keeps each entry's own vendor id (no cross-provider merge)", () => {
    const models = normalizeOpenRouterCatalog([
      { id: "openai/gpt-4o-mini" },
      { id: "anthropic/claude-x" },
    ]);
    expect(models.map((m) => m.vendor)).toEqual(["openai", "anthropic"]);
  });

  it("ids without a vendor prefix attribute to OpenRouter", () => {
    const [m] = normalizeOpenRouterCatalog([{ id: "lonely-model" }]);
    expect(m!.vendor).toBe("OpenRouter");
  });
});

describe("13-15. empty, unavailable, cached", () => {
  it("empty query and empty catalog yield empty lists", () => {
    const models = normalized();
    expect(searchModels(models, "   ")).toEqual([]);
    expect(searchModels(models, "zzz-no-such-model")).toEqual([]);
    expect(normalizeOpenRouterCatalog([])).toEqual([]);
    expect(normalizeOpenRouterCatalog({ nope: 1 })).toEqual([]);
  });

  it("round-trips the cache and honors TTL", () => {
    const store = memStorage();
    expect(readCatalogCache(store)).toBeNull();
    const models = normalized();
    expect(writeCatalogCache(store, models, 1000)).toBe(true);
    const hit = readCatalogCache(store);
    expect(hit?.models.length).toBe(models.length);
    expect(isCatalogFresh(1000, 1000 + OR_CATALOG_CACHE_TTL_MS)).toBe(true);
    expect(isCatalogFresh(1000, 1000 + OR_CATALOG_CACHE_TTL_MS + 1)).toBe(
      false,
    );
    expect(isCatalogFresh(2000, 1000)).toBe(false);
  });

  it("rejects corrupt caches and survives quota errors", () => {
    const bad = memStorage({
      "codepilot.openrouter.catalog.v1": '{"savedAt":',
    });
    expect(readCatalogCache(bad)).toBeNull();
    expect(readCatalogCache(undefined)).toBeNull();
    const throwing: StringListStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(writeCatalogCache(throwing, normalized())).toBe(false);
  });
});

describe("context threshold constant", () => {
  it("documents the recommended minimum", () => {
    expect(MIN_RECOMMENDED_CONTEXT).toBe(32_000);
    expect(MAX_RECOMMENDED).toBeLessThanOrEqual(10);
  });
});
