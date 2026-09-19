/**
 * Provider catalogue tests — validate the CodePilot-owned curated registry
 * and the CodePilot overlay invariants.
 */
import { describe, expect, it } from "vitest";
import {
  getCatalogProvider,
  getProviderCatalog,
  searchCatalog,
  sortCatalog,
} from "../src/provider-catalog.js";
import {
  estimateCost,
  UsageLedger,
  MAX_USAGE_RECORDS,
  type UsageRecord,
  type UsageStore,
} from "../src/usage-ledger.js";

// ============================================================================
// Catalogue integrity (owned curated dataset)
// ============================================================================

describe("provider catalogue", () => {
  const catalog = getProviderCatalog();

  it("covers every provider id CodePilot can route or configure", () => {
    // Curated set: adapters exist for each (or the generic compatible path
    // with an explicit base URL). Anything missing here is a routing gap.
    for (const id of [
      "ollama",
      "lmstudio",
      "openai-native",
      "openai",
      "openai-compatible",
      "custom",
      "anthropic",
      "gemini",
      "google",
      "openrouter",
      "zai",
      "zhipuai",
    ]) {
      expect(getCatalogProvider(id), id).toBeDefined();
    }
  });

  it("contains no duplicate ids", () => {
    const ids = new Set(catalog.map((p) => p.id));
    expect(ids.size).toBe(catalog.length);
  });

  it("every entry has required fields and a valid status", () => {
    const validStatuses = new Set([
      "SUPPORTED",
      "CONFIGURABLE",
      "GATEWAY",
      "LOCAL",
      "SUBSCRIPTION",
      "PLANNED",
    ]);
    for (const p of catalog) {
      expect(p.id.length, p.id).toBeGreaterThan(0);
      expect(p.displayName.length, p.id).toBeGreaterThan(0);
      expect(validStatuses.has(p.status), `status of ${p.id}`).toBe(true);
      expect(
        ["cloud", "local", "gateway", "custom"].includes(p.category),
        `category of ${p.id}`,
      ).toBe(true);
      expect(Array.isArray(p.models), `models of ${p.id}`).toBe(true);
      expect(Array.isArray(p.fields), `fields of ${p.id}`).toBe(true);
      expect(typeof p.defaultModelId, `defaultModelId of ${p.id}`).toBe(
        "string",
      );
    }
  });

  it("existing working providers are preserved first-class", () => {
    for (const id of [
      "ollama",
      "openai-native",
      "anthropic",
      "gemini",
      "openai-compatible",
      "openrouter",
      "lmstudio",
      "zai",
    ]) {
      expect(getCatalogProvider(id), id).toBeDefined();
    }
  });

  it("marks local runtimes LOCAL and local-category", () => {
    for (const id of ["ollama", "lmstudio"]) {
      const p = getCatalogProvider(id)!;
      expect(p.status).toBe("LOCAL");
      expect(p.category).toBe("local");
      expect(p.requiresApiKey).toBe(false);
    }
  });

  it("pins per-provider health probe paths (Ollama uses /api/tags — never / or /models)", () => {
    // The 404 regression: Ollama's native API serves discovery at /api/tags;
    // probing /models (or /) there fails even though the server is healthy.
    const ollama = getCatalogProvider("ollama")!;
    expect(ollama.health.supportsTestConnection).toBe(true);
    expect(ollama.health.probePath).toBe("/api/tags");
    // LM Studio keeps the OpenAI-compatible /models listing.
    const lmstudio = getCatalogProvider("lmstudio")!;
    expect(lmstudio.health.supportsTestConnection).toBe(true);
    expect(lmstudio.health.probePath).toBe("/models");
    // Invariant for every testable provider: an absolute path, never "/".
    for (const p of catalog) {
      if (!p.health.supportsTestConnection) continue;
      const path = p.health.probePath ?? "/models";
      expect(path.startsWith("/"), `probePath of ${p.id}`).toBe(true);
      expect(path.length, `probePath of ${p.id}`).toBeGreaterThan(1);
    }
  });

  it("never claims a local provider needs a key and vice versa for cloud", () => {
    const ollama = getCatalogProvider("ollama")!;
    expect(ollama.usage.kind).toBe("none"); // no provider billing for local
    const openai = getCatalogProvider("openai-native")!;
    expect(openai.requiresApiKey).toBe(true);
    expect(openai.usage.kind).toBe("local-tracking");
  });

  it("carries curated model pricing from the owned dataset", () => {
    const openai = getCatalogProvider("openai-native")!;
    // Curated snapshot: gpt-4o is $2.50 in / $10 out per Mtok.
    const gpt = openai.models.find((m) => m.id === "gpt-4o");
    expect(gpt).toBeDefined();
    expect(gpt!.inputPerMtok).toBe(2.5);
    expect(gpt!.outputPerMtok).toBe(10);
    expect(gpt!.contextWindow).toBeGreaterThan(0);
    const anthropic = getCatalogProvider("anthropic")!;
    const sonnet = anthropic.models.find(
      (m) => m.id === "claude-sonnet-4-20250514",
    );
    expect(sonnet!.inputPerMtok).toBe(3);
    expect(sonnet!.outputPerMtok).toBe(15);
  });

  it("openrouter is flagged as having a real usage API", () => {
    const or = getCatalogProvider("openrouter")!;
    expect(or.usage.kind).toBe("provider-api");
  });

  it("lists no unroutable placeholder providers", () => {
    // Curated set invariant: every entry is routable today (an owned
    // adapter or the generic compatible path) — nothing PLANNED.
    for (const p of catalog) {
      expect(p.status, p.id).not.toBe("PLANNED");
    }
  });

  it("looks up providers by id only", () => {
    expect(getCatalogProvider("definitely-not-a-provider")).toBeUndefined();
  });
});

// ============================================================================
// Search / sort (pure UI helpers)
// ============================================================================

describe("catalog search and sort", () => {
  const catalog = getProviderCatalog();

  it("search matches id, name, and description", () => {
    const byId = searchCatalog(catalog, "openrouter");
    expect(byId.map((p) => p.id)).toContain("openrouter");
    const byName = searchCatalog(catalog, "Anthropic");
    expect(byName.map((p) => p.id)).toContain("anthropic");
    const byDesc = searchCatalog(catalog, "locally");
    expect(byDesc.map((p) => p.id)).toContain("ollama");
  });

  it("search is case-insensitive and trims", () => {
    expect(searchCatalog(catalog, "  ANTHROPIC  ").length).toBeGreaterThan(0);
  });

  it("category filter is exact", () => {
    const locals = searchCatalog(catalog, "", "local");
    expect(locals.length).toBeGreaterThan(0);
    expect(locals.every((p) => p.category === "local")).toBe(true);
  });

  it("sort puts favorites first and is stable otherwise", () => {
    const sorted = sortCatalog(catalog, ["zai"], ["openrouter"]);
    expect(sorted[0]!.id).toBe("zai");
    const idx = (id: string) => sorted.findIndex((p) => p.id === id);
    expect(idx("openrouter")).toBeLessThan(idx("anthropic"));
    // no favorites/recent: alphabetical within status class
    const plain = sortCatalog(catalog);
    const supported = plain.filter((p) => p.status === "SUPPORTED");
    const names = supported.map((p) => p.displayName);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });
});

// ============================================================================
// Usage ledger
// ============================================================================

function memStore(): { store: UsageStore; writes: UsageRecord[][] } {
  const writes: UsageRecord[][] = [];
  let data: UsageRecord[] = [];
  return {
    writes,
    store: {
      read: () => data,
      write: (r) => {
        data = r;
        writes.push(r);
      },
    },
  };
}

describe("usage ledger", () => {
  it("records usage and estimates cost from catalogue pricing", () => {
    const { store } = memStore();
    const ledger = new UsageLedger(store);
    const rec = ledger.record({
      providerId: "openai-native",
      modelId: "gpt-4o",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      taskId: "task-1",
    });
    // Curated catalogue pricing for gpt-4o: input 2.5, output 10 per Mtok.
    expect(rec.estimatedCostUsd).toBeCloseTo(12.5, 1);
    const s = ledger.summary();
    expect(s.totalRequests).toBe(1);
    expect(s.totalInputTokens).toBe(1_000_000);
    expect(s.totalEstimatedCostUsd).toBeCloseTo(12.5, 1);
    expect(s.pricingCoverage).toBe("full");
    expect(s.byProvider[0]!.providerId).toBe("openai-native");
  });

  it("handles unknown pricing honestly (no fabricated numbers)", () => {
    const ledger = new UsageLedger();
    const rec = ledger.record({
      providerId: "openai-native",
      modelId: "mystery-model-9000",
      inputTokens: 100,
      outputTokens: 200,
    });
    expect(rec.estimatedCostUsd).toBeUndefined();
    expect(ledger.summary().pricingCoverage).toBe("none");
  });

  it("local providers report no billing data", () => {
    const ledger = new UsageLedger();
    ledger.record({
      providerId: "ollama",
      modelId: "qwen3:8b",
      inputTokens: 500,
      outputTokens: 300,
    });
    const recs = ledger.recent(1);
    expect(recs[0]!.estimatedCostUsd).toBeUndefined();
  });

  it("returns undefined for router models with no curated pricing", () => {
    // OpenRouter proxies arbitrary vendor/model ids; without a curated
    // entry there is no number to use — undefined, never fabricated.
    const cost = estimateCost(
      "openrouter",
      "anthropic/claude-sonnet-5",
      1_000_000,
      0,
    );
    expect(cost).toBeUndefined();
  });

  it("is bounded at the cap and keeps newest records", () => {
    const ledger = new UsageLedger(undefined, 10);
    for (let i = 0; i < 25; i++) {
      ledger.record({
        providerId: "openai-native",
        modelId: "gpt-4o",
        inputTokens: i,
        outputTokens: i,
      });
    }
    expect(ledger.summary().totalRequests).toBe(10);
    const recs = ledger.recent(10);
    expect(recs[0]!.inputTokens).toBe(24); // newest first
  });

  it("persists through the store adapter and clears on demand", () => {
    const { store, writes } = memStore();
    const ledger = new UsageLedger(store);
    ledger.record({
      providerId: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      inputTokens: 10,
      outputTokens: 20,
    });
    expect(writes.length).toBe(1);
    // Reload from the same store: state survives restart.
    const reloaded = new UsageLedger(store);
    expect(reloaded.summary().totalRequests).toBe(1);
    ledger.clear();
    expect(ledger.summary().totalRequests).toBe(0);
    expect(new UsageLedger(store).summary().totalRequests).toBe(0);
  });

  it("survives a broken store without throwing", () => {
    const ledger = new UsageLedger({
      read: () => {
        throw new Error("corrupt");
      },
      write: () => {
        throw new Error("disk full");
      },
    });
    expect(() =>
      ledger.record({
        providerId: "openai-native",
        modelId: "gpt-4o",
        inputTokens: 1,
        outputTokens: 1,
      }),
    ).not.toThrow();
  });

  it("cap constant is sane", () => {
    expect(MAX_USAGE_RECORDS).toBeGreaterThanOrEqual(100);
  });
});
