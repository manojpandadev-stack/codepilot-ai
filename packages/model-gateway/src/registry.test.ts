/**
 * Tests for ProviderRegistry: registration, duplicate rejection, resolution,
 * caching, health checks, fallback chains, observability and disposal.
 * No network access.
 */
import { describe, expect, it } from "vitest";
import type {
  DiscoveredModel,
  ModelProvider,
  ProviderConfig,
  ProviderHealthStatus,
  ProviderType,
} from "./provider.js";
import { defaultCapabilitySet } from "./provider.js";
import { ProviderRegistry } from "./registry.js";

// ============================================================================
// Test double: a minimal ModelProvider with observable call counts
// ============================================================================

class FakeProvider implements ModelProvider {
  readonly id: string;
  readonly name: string;
  readonly type: ProviderType;
  enabled: boolean;
  models: DiscoveredModel[];
  healthStatus: ProviderHealthStatus;
  listError: Error | null = null;
  healthError: Error | null = null;
  listCalls = 0;
  healthCalls = 0;

  constructor(options: {
    id: string;
    type?: ProviderType;
    enabled?: boolean;
    modelIds?: string[];
    healthStatus?: ProviderHealthStatus;
  }) {
    this.id = options.id;
    this.name = `Provider ${options.id}`;
    this.type = options.type ?? "custom";
    this.enabled = options.enabled ?? true;
    this.models = (options.modelIds ?? []).map((mid) => ({
      id: mid,
      displayName: mid,
      providerId: this.id,
      capabilities: defaultCapabilitySet({ streaming: true, tools: true }),
      locallyAvailable: true,
      sizeBytes: null,
      lastModified: null,
    }));
    this.healthStatus = options.healthStatus ?? "HEALTHY";
  }

  async listModels(): Promise<DiscoveredModel[]> {
    this.listCalls += 1;
    if (this.listError) throw this.listError;
    return this.models;
  }
  async getModel(modelId: string): Promise<DiscoveredModel | null> {
    return this.models.find((m) => m.id === modelId) ?? null;
  }
  async healthCheck() {
    this.healthCalls += 1;
    if (this.healthError) throw this.healthError;
    return {
      providerId: this.id,
      status: this.healthStatus,
      latencyMs: 1,
      error: null,
      checkedAt: Date.now(),
    };
  }
  supportsStreaming() {
    return true;
  }
  supportsTools() {
    return true;
  }
  supportsVision() {
    return false;
  }
  supportsStructuredOutput() {
    return false;
  }
  supportsEmbeddings() {
    return true;
  }
  getCapabilities() {
    return defaultCapabilitySet();
  }
  getConfig() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      enabled: this.enabled,
    };
  }
  updateConfig(patch: Partial<ProviderConfig>): void {
    if (patch.enabled !== undefined) this.enabled = patch.enabled;
  }
}

// ============================================================================
// Registration
// ============================================================================

describe("ProviderRegistry — registration", () => {
  it("registers and retrieves providers", () => {
    const registry = new ProviderRegistry();
    const a = new FakeProvider({ id: "a", modelIds: ["m1"] });
    registry.register(a);
    expect(registry.get("a")).toBe(a);
    expect(registry.list().map((p) => p.id)).toEqual(["a"]);
  });

  it("rejects duplicate registration", () => {
    const registry = new ProviderRegistry();
    registry.register(new FakeProvider({ id: "a" }));
    expect(() => registry.register(new FakeProvider({ id: "a" }))).toThrow(
      /already registered/,
    );
  });

  it("unregisters a provider and clears its caches", async () => {
    const registry = new ProviderRegistry();
    const a = new FakeProvider({ id: "a", modelIds: ["m1"] });
    registry.register(a);
    await registry.listModels("a");
    expect(a.listCalls).toBe(1);
    registry.unregister("a");
    expect(registry.get("a")).toBeUndefined();
    expect(await registry.listModels("a")).toEqual([]);
    // unregistering an unknown provider is a no-op
    registry.unregister("a");
  });

  it("registers or replaces an existing provider", () => {
    const registry = new ProviderRegistry();
    const a1 = new FakeProvider({ id: "a" });
    const a2 = new FakeProvider({ id: "a" });
    registry.register(a1);
    registry.registerOrReplace(a2);
    expect(registry.get("a")).toBe(a2);
    expect(registry.list().length).toBe(1);
  });

  it("listEnabled only returns enabled providers", () => {
    const registry = new ProviderRegistry();
    registry.register(new FakeProvider({ id: "on", enabled: true }));
    registry.register(new FakeProvider({ id: "off", enabled: false }));
    expect(registry.listEnabled().map((p) => p.id)).toEqual(["on"]);
  });
});

describe("ProviderRegistry — model discovery", () => {
  it("returns [] for an unknown provider id", async () => {
    const registry = new ProviderRegistry();
    expect(await registry.listModels("nope")).toEqual([]);
  });

  it("caches discovery results within the TTL", async () => {
    const registry = new ProviderRegistry();
    const a = new FakeProvider({ id: "a", modelIds: ["m1", "m2"] });
    registry.register(a);
    expect(await registry.listModels("a")).toHaveLength(2);
    expect(await registry.listModels("a")).toHaveLength(2);
    expect(a.listCalls).toBe(1);
  });

  it("bypasses the cache with forceRefresh", async () => {
    const registry = new ProviderRegistry();
    const a = new FakeProvider({ id: "a", modelIds: ["m1"] });
    registry.register(a);
    await registry.listModels("a");
    await registry.listModels("a", { forceRefresh: true });
    expect(a.listCalls).toBe(2);
  });

  it("expires cached entries after the TTL", async () => {
    const registry = new ProviderRegistry({ discoveryTtlMs: 5 });
    const a = new FakeProvider({ id: "a", modelIds: ["m1"] });
    registry.register(a);
    await registry.listModels("a");
    await new Promise((r) => setTimeout(r, 25));
    await registry.listModels("a");
    expect(a.listCalls).toBe(2);
  });

  it("returns [] and emits failure when the provider throws", async () => {
    const registry = new ProviderRegistry();
    const a = new FakeProvider({ id: "a", modelIds: ["m1"] });
    const events: string[] = [];
    registry.subscribe((e) => events.push(e.type));
    a.listError = new Error("connect ECONNREFUSED");
    registry.register(a);
    expect(await registry.listModels("a")).toEqual([]);
    expect(events).toContain("MODEL_DISCOVERY_FAILED");
  });

  it("lists models across all enabled providers", async () => {
    const registry = new ProviderRegistry();
    registry.register(new FakeProvider({ id: "a", modelIds: ["a1"] }));
    registry.register(new FakeProvider({ id: "b", modelIds: ["b1", "b2"] }));
    registry.register(
      new FakeProvider({ id: "off", enabled: false, modelIds: ["x"] }),
    );
    const all = await registry.listAllModels();
    expect(all.map((m) => m.id).sort()).toEqual(["a1", "b1", "b2"]);
  });

  it("resolves a provider/model pair", async () => {
    const registry = new ProviderRegistry();
    const a = new FakeProvider({ id: "a", modelIds: ["m1"] });
    registry.register(a);
    const resolved = await registry.resolve("a", "m1");
    expect(resolved?.provider).toBe(a);
    expect(resolved?.model.id).toBe("m1");
  });

  it("returns null when the model is unknown or provider missing", async () => {
    const registry = new ProviderRegistry();
    registry.register(new FakeProvider({ id: "a", modelIds: ["m1"] }));
    expect(await registry.resolve("a", "missing")).toBeNull();
    expect(await registry.resolve("missing", "m1")).toBeNull();
  });
});

describe("ProviderRegistry — health checks", () => {
  it("returns UNKNOWN for an unregistered provider without throwing", async () => {
    const registry = new ProviderRegistry();
    const health = await registry.healthCheck("ghost");
    expect(health.status).toBe("UNKNOWN");
    expect(health.error).toContain("ghost");
  });

  it("caches health results within the TTL", async () => {
    const registry = new ProviderRegistry();
    const a = new FakeProvider({ id: "a" });
    registry.register(a);
    await registry.healthCheck("a");
    await registry.healthCheck("a");
    expect(a.healthCalls).toBe(1);
  });

  it("refreshes health with forceRefresh", async () => {
    const registry = new ProviderRegistry();
    const a = new FakeProvider({ id: "a" });
    registry.register(a);
    await registry.healthCheck("a");
    await registry.healthCheck("a", { forceRefresh: true });
    expect(a.healthCalls).toBe(2);
  });

  it("healthCheckAll reports every enabled provider", async () => {
    const registry = new ProviderRegistry();
    registry.register(new FakeProvider({ id: "a" }));
    registry.register(new FakeProvider({ id: "b", enabled: false }));
    const map = await registry.healthCheckAll();
    expect(Array.from(map.keys())).toEqual(["a"]);
    expect(map.get("a")?.status).toBe("HEALTHY");
  });
});

describe("ProviderRegistry — fallback", () => {
  it("uses the primary when it succeeds", async () => {
    const registry = new ProviderRegistry();
    const a = new FakeProvider({ id: "a", modelIds: ["m1"] });
    registry.register(a);
    const result = await registry.withFallback("a", ["b"], (p) =>
      p.listModels(),
    );
    expect(result.fell_back).toBe(false);
    expect(result.usedProviderId).toBe("a");
    expect(result.value.map((m) => m.id)).toEqual(["m1"]);
  });

  it("falls back to the next provider when the primary fails", async () => {
    const registry = new ProviderRegistry();
    const a = new FakeProvider({ id: "a", modelIds: ["m1"] });
    const b = new FakeProvider({ id: "b", modelIds: ["m2"] });
    const events: string[] = [];
    registry.subscribe((e) => events.push(e.type));
    a.listError = new Error("connect ECONNREFUSED");
    registry.register(a);
    registry.register(b);
    const result = await registry.withFallback("a", ["b"], (p) =>
      p.listModels(),
    );
    expect(result.fell_back).toBe(true);
    expect(result.usedProviderId).toBe("b");
    expect(result.value.map((m) => m.id)).toEqual(["m2"]);
    expect(events).toContain("PROVIDER_FALLBACK");
  });

  it("skips unknown providers in the chain", async () => {
    const registry = new ProviderRegistry();
    const a = new FakeProvider({ id: "a", modelIds: ["m1"] });
    registry.register(a);
    const result = await registry.withFallback("ghost", ["a"], (p) =>
      p.listModels(),
    );
    expect(result.usedProviderId).toBe("a");
    expect(result.fell_back).toBe(true);
  });

  it("throws when every provider in the chain fails", async () => {
    const registry = new ProviderRegistry();
    const a = new FakeProvider({ id: "a", modelIds: ["m1"] });
    a.listError = new Error("connect ECONNREFUSED");
    registry.register(a);
    await expect(
      registry.withFallback("a", [], (p) => p.listModels()),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("ProviderRegistry — observability, config and disposal", () => {
  it("emits PROVIDER_REGISTERED and unsubscribes cleanly", () => {
    const registry = new ProviderRegistry();
    const events: string[] = [];
    const unsubscribe = registry.subscribe((e) => events.push(e.type));
    registry.register(new FakeProvider({ id: "a" }));
    expect(events).toEqual(["PROVIDER_REGISTERED"]);
    unsubscribe();
    registry.register(new FakeProvider({ id: "b" }));
    expect(events).toEqual(["PROVIDER_REGISTERED"]);
  });

  it("updateProviderConfig invalidates discovery cache", async () => {
    const registry = new ProviderRegistry();
    const a = new FakeProvider({ id: "a", modelIds: ["m1"] });
    registry.register(a);
    await registry.listModels("a");
    registry.updateProviderConfig("a", { enabled: false });
    await registry.listModels("a");
    expect(a.listCalls).toBe(2);
  });

  it("updateProviderConfig rejects unknown providers", () => {
    const registry = new ProviderRegistry();
    expect(() => registry.updateProviderConfig("ghost", {})).toThrow(
      /not registered/,
    );
  });

  it("invalidates caches on demand", async () => {
    const registry = new ProviderRegistry();
    const a = new FakeProvider({ id: "a", modelIds: ["m1"] });
    registry.register(a);
    await registry.listModels("a");
    await registry.healthCheck("a");
    registry.invalidateCache("a");
    await registry.listModels("a");
    await registry.healthCheck("a");
    expect(a.listCalls).toBe(2);
    expect(a.healthCalls).toBe(2);
  });

  it("dispose clears caches and listeners", async () => {
    const registry = new ProviderRegistry();
    const a = new FakeProvider({ id: "a", modelIds: ["m1"] });
    registry.register(a);
    const events: string[] = [];
    registry.subscribe((e) => events.push(e.type));
    await registry.listModels("a");
    expect(a.listCalls).toBe(1);
    expect(events.length).toBeGreaterThan(0); // listener receives events
    registry.dispose();
    const observedBeforeDispose = events.length;
    await registry.listModels("a");
    expect(a.listCalls).toBe(2); // cache was cleared, so re-fetched
    expect(events.length).toBe(observedBeforeDispose); // listeners were cleared
  });

  it("listeners cannot crash the registry", async () => {
    const registry = new ProviderRegistry();
    registry.subscribe(() => {
      throw new Error("listener bug");
    });
    const a = new FakeProvider({ id: "a", modelIds: ["m1"] });
    expect(() => registry.register(a)).not.toThrow();
    const result = await registry.withFallback("a", [], (p) => p.listModels());
    expect(result.value).toHaveLength(1);
  });
});
