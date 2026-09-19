/**
 * Integration tests for the M2 provider system: registry + Ollama + OpenAI-
 * compatible providers wired together with discovery, health, fallback,
 * error normalization and secret safety. All HTTP is mocked — no live network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaProvider } from "./providers/ollama.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import { ProviderRegistry } from "./registry.js";
import { resolveProviderConfig } from "./config.js";

const OLLAMA_URL = "http://localhost:11434";
const GATEWAY_URL = "https://gateway.example.com/v1";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function discoverModelsProvider(): Promise<{ models: unknown[] }> {
  return Promise.resolve({
    models: [
      { name: "qwen3:8b", model: "qwen3:8b", size: 5_200_000_000 },
      { name: "llama3.2:3b", model: "llama3.2:3b", size: 2_000_000_000 },
    ],
  });
}

function discoverModelsOpenAI(): Promise<{ data: unknown[] }> {
  return Promise.resolve({
    data: [
      { id: "gpt-4o", object: "model", created: 1700000000 },
      { id: "gpt-4o-mini", object: "model", created: 1700000001 },
    ],
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("M2 provider system — end-to-end integration", () => {
  function buildRegistry() {
    const registry = new ProviderRegistry();
    registry.register(
      new OllamaProvider(
        resolveProviderConfig({
          id: "ollama",
          type: "ollama",
          baseUrl: OLLAMA_URL,
          enabled: true,
        }),
      ),
    );
    registry.register(
      new OpenAICompatibleProvider(
        resolveProviderConfig({
          id: "openai",
          type: "openai-compatible",
          baseUrl: GATEWAY_URL,
          apiKey: "sk-integration-secret",
          enabled: true,
        }),
      ),
    );
    return registry;
  }

  it("discovers and health-checks all enabled providers", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/api/tags")) {
        return new Response(JSON.stringify(await discoverModelsProvider()), {
          status: 200,
        });
      }
      return new Response(JSON.stringify(await discoverModelsOpenAI()), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const registry = buildRegistry();
    const all = await registry.listAllModels();
    expect(all.map((m) => m.id).sort()).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
      "llama3.2:3b",
      "qwen3:8b",
    ]);

    const health = await registry.healthCheckAll();
    expect(health.get("ollama")?.status).toBe("HEALTHY");
    expect(health.get("openai")?.status).toBe("HEALTHY");
  });

  it("resolves a discovered model to its provider", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input.includes("/api/tags")) {
          return new Response(JSON.stringify(await discoverModelsProvider()), {
            status: 200,
          });
        }
        return new Response(JSON.stringify(await discoverModelsOpenAI()), {
          status: 200,
        });
      }) as unknown as typeof fetch,
    );

    const registry = buildRegistry();
    const resolved = await registry.resolve("ollama", "qwen3:8b");
    expect(resolved?.provider.id).toBe("ollama");
    expect(resolved?.model.capabilities.tools).toBe(true);
    expect(resolved?.model.capabilities.streaming).toBe(true);
    expect(resolved?.model.locallyAvailable).toBe(true);
  });

  it("falls back between providers on failure", async () => {
    let openaiRequests = 0;
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/api/tags")) {
        return new Response(JSON.stringify(await discoverModelsProvider()), {
          status: 200,
        });
      }
      throw new Error("connect ECONNREFUSED");
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const registry = buildRegistry();
    const events: string[] = [];
    registry.subscribe((e) => events.push(e.type));

    // Simulate a hard generation-style failure on the primary while the
    // Ollama fallback provider remains healthy.
    const result = await registry.withFallback(
      "openai",
      ["ollama"],
      async (p) => {
        if (p.id === "openai") {
          openaiRequests += 1;
          throw new Error("connect ECONNREFUSED");
        }
        return p.listModels(signal());
      },
    );

    expect(openaiRequests).toBeGreaterThan(0);
    expect(result.fell_back).toBe(true);
    expect(result.usedProviderId).toBe("ollama");
    expect(result.value.some((m) => m.id === "qwen3:8b")).toBe(true);
    expect(events).toContain("PROVIDER_FALLBACK");
  });

  it("returns a provider-unavailable state instead of crashing when Ollama is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
      }) as unknown as typeof fetch,
    );

    const registry = new ProviderRegistry();
    registry.register(
      new OllamaProvider(
        resolveProviderConfig({
          id: "ollama",
          type: "ollama",
          baseUrl: OLLAMA_URL,
          enabled: true,
        }),
      ),
    );
    let failedDetail = "";
    registry.subscribe((e) => {
      if (e.type === "MODEL_DISCOVERY_FAILED") failedDetail = e.detail ?? "";
    });

    // Discovery resolves to [] — the runtime never crashes.
    const models = await registry.listModels("ollama");
    expect(models).toEqual([]);
    expect(failedDetail).toContain("ECONNREFUSED");

    // Health check also degrades gracefully.
    const health = await registry.healthCheck("ollama");
    expect(health.status).toBe("UNAVAILABLE");
  });

  it("never leaks API keys through errors or registry events", async () => {
    const key = "sk-integration-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        throw new Error(`Unauthorized: ${headers.get("authorization") ?? ""}`);
      }) as unknown as typeof fetch,
    );

    const registry = buildRegistry();
    const eventDetails: string[] = [];
    registry.subscribe((e) => {
      if (e.detail) eventDetails.push(e.detail);
    });
    await registry.listAllModels();
    expect(eventDetails.join(" ")).not.toContain(key);
    expect(JSON.stringify(eventDetails)).not.toContain("Bearer " + key);
  });

  it("cleanup: dispose() releases registry resources without errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ models: [] }), { status: 200 }),
      ) as unknown as typeof fetch,
    );
    const registry = buildRegistry();
    await registry.listAllModels();
    await registry.healthCheckAll();
    expect(() => registry.dispose()).not.toThrow();
  });
});

describe("M2 provider system — registry wiring", () => {
  it("resolves an Ollama model through a registry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              models: [{ name: "qwen3:8b", model: "qwen3:8b" }],
            }),
            { status: 200 },
          ),
      ) as unknown as typeof fetch,
    );
    const registry = new ProviderRegistry();
    registry.register(
      new OllamaProvider(
        resolveProviderConfig({ id: "ollama", type: "ollama", enabled: true }),
      ),
    );
    const models = await registry.listModels("ollama");
    expect(models.map((m) => m.id)).toEqual(["qwen3:8b"]);
    const resolved = await registry.resolve("ollama", "qwen3:8b");
    expect(resolved?.model.capabilities.streaming).toBe(true);
    expect(resolved?.model.capabilities.reasoning).toBe(true);
    registry.dispose();
  });
});
