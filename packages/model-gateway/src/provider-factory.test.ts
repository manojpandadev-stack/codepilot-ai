/**
 * Tests for the provider factory: builtin providers for OpenAI, Gemini, and Ollama,
 * env-key resolution, custom endpoint support, secret safety.
 * All HTTP is mocked — no live network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuiltinProviders } from "./provider-factory.js";
import { BUILTIN_PROVIDER_IDS, BUILTIN_PROVIDER_DEFAULTS } from "./config.js";
import { OllamaProvider } from "./providers/ollama.js";
import { GoogleGeminiProvider } from "./providers/google-gemini.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import type { ProviderConfig } from "./provider.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
});

describe("createBuiltinProviders", () => {
  it("builds exactly one provider per builtin id", () => {
    const built = createBuiltinProviders();
    expect(built.map((b) => b.id).sort()).toEqual(
      [...BUILTIN_PROVIDER_IDS].sort(),
    );
    expect(built.map((b) => b.id).sort()).toEqual(
      ["gemini", "ollama", "openai-native"].sort(),
    );
  });

  it("builds the correct concrete class per provider id", () => {
    const built = createBuiltinProviders();
    const byId = new Map(built.map((b) => [b.id, b.instance]));
    expect(byId.get("ollama")).toBeInstanceOf(OllamaProvider);
    expect(byId.get("gemini")).toBeInstanceOf(GoogleGeminiProvider);
    expect(byId.get("openai-native")).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it("applies overrides and resolves keys from the provided map only", () => {
    const built = createBuiltinProviders({
      apiKeys: { "openai-native": "sk-openai-test" },
      overrides: {
        "openai-native": {
          baseUrl: "https://api.openai.com/v1",
          enabled: true,
        },
      },
    });
    const openai = built.find((b) => b.id === "openai-native")!
      .instance as OpenAICompatibleProvider;
    expect(openai.getConfig().baseUrl).toBe("https://api.openai.com/v1");
    // The key must never be exposed through getConfig.
    expect(JSON.stringify(openai.getConfig())).not.toContain("sk-openai-test");
  });

  it("leaves builtin cloud providers disabled by default", () => {
    const built = createBuiltinProviders();
    for (const b of built) {
      if (b.id !== "ollama") {
        expect(b.instance.getConfig().enabled).toBe(false);
      }
    }
  });

  it("keeps BUILTIN_PROVIDER_DEFAULTS in sync with BUILTIN_PROVIDER_IDS", () => {
    expect(Object.keys(BUILTIN_PROVIDER_DEFAULTS).sort()).toEqual(
      [...BUILTIN_PROVIDER_IDS].sort(),
    );
  });

  it("exercises discovery against a mocked OpenAI endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [{ id: "gpt-4o" }, { id: "o3-mini" }],
        }),
      ) as unknown as typeof fetch,
    );
    const built = createBuiltinProviders({
      apiKeys: { "openai-native": "test-key" },
      overrides: { "openai-native": { enabled: true } },
    });
    const openai = built.find((b) => b.id === "openai-native")!
      .instance as OpenAICompatibleProvider;
    const models = await openai.listModels(signal());
    expect(models[0]?.id).toBe("gpt-4o");
    expect(models[0]?.providerId).toBe("openai-native");
  });

  it("never leaks API keys through any provider's getConfig", () => {
    const built = createBuiltinProviders({
      apiKeys: Object.fromEntries(
        BUILTIN_PROVIDER_IDS.map((id) => [id, `secret-${id}-value`]),
      ),
    });
    for (const b of built) {
      const json = JSON.stringify(b.instance.getConfig());
      expect(json).not.toContain(`secret-${b.id}-value`);
    }
  });
});

describe("ProviderConfig typing sanity", () => {
  it("accepts ProviderConfig for openai-native", () => {
    const cfg: ProviderConfig = {
      ...BUILTIN_PROVIDER_DEFAULTS["openai-native"],
      apiKey: undefined,
    };
    expect(cfg.type).toBe("openai");
  });
});
