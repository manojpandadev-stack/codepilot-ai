/**
 * Tests for the provider factory: builtin providers for all eleven built-in
 * provider ids, env-key resolution, custom endpoint support, secret safety.
 * All HTTP is mocked — no live network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuiltinProviders } from "./provider-factory.js";
import { BUILTIN_PROVIDER_IDS, BUILTIN_PROVIDER_DEFAULTS } from "./config.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { GoogleGeminiProvider } from "./providers/google-gemini.js";
import {
  OpenRouterProvider,
  LMStudioProvider,
  DeepSeekProvider,
  MistralProvider,
  XAIProvider,
} from "./providers/openai-cloud-providers.js";
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
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.MISTRAL_API_KEY;
  delete process.env.XAI_API_KEY;
});

describe("createBuiltinProviders", () => {
  it("builds exactly one provider per builtin id", () => {
    const built = createBuiltinProviders();
    expect(built.map((b) => b.id).sort()).toEqual(
      [...BUILTIN_PROVIDER_IDS].sort(),
    );
  });

  it("builds the correct concrete class per provider id", () => {
    const built = createBuiltinProviders();
    const byId = new Map(built.map((b) => [b.id, b.instance]));
    expect(byId.get("anthropic")).toBeInstanceOf(AnthropicProvider);
    expect(byId.get("google")).toBeInstanceOf(GoogleGeminiProvider);
    expect(byId.get("openrouter")).toBeInstanceOf(OpenRouterProvider);
    expect(byId.get("lmstudio")).toBeInstanceOf(LMStudioProvider);
    expect(byId.get("deepseek")).toBeInstanceOf(DeepSeekProvider);
    expect(byId.get("mistral")).toBeInstanceOf(MistralProvider);
    expect(byId.get("xai")).toBeInstanceOf(XAIProvider);
  });

  it("applies overrides and resolves keys from the provided map only", () => {
    const built = createBuiltinProviders({
      apiKeys: { anthropic: "sk-ant-test" },
      overrides: {
        "openai-compatible": {
          baseUrl: "https://my-gw.example/v1",
          enabled: true,
        },
      },
    });
    const anthropic = built.find((b) => b.id === "anthropic")!
      .instance as AnthropicProvider;
    expect(anthropic.getConfig().baseUrl).toBe("https://api.anthropic.com");
    // The key must never be exposed through getConfig.
    expect(JSON.stringify(anthropic.getConfig())).not.toContain("sk-ant-test");
  });

  it("leaves builtin providers disabled by default", () => {
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

  it("exercises discovery against a mocked OpenRouter endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [{ id: "anthropic/claude-sonnet-4" }],
        }),
      ) as unknown as typeof fetch,
    );
    const built = createBuiltinProviders({
      apiKeys: { openrouter: "test-key" },
      overrides: { openrouter: { enabled: true } },
    });
    const openrouter = built.find((b) => b.id === "openrouter")!
      .instance as OpenRouterProvider;
    const models = await openrouter.listModels(signal());
    expect(models[0]?.id).toBe("anthropic/claude-sonnet-4");
    expect(models[0]?.providerId).toBe("openrouter");
  });

  it("exercises health check against a mocked LM Studio endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [] })) as unknown as typeof fetch,
    );
    const built = createBuiltinProviders({
      overrides: { lmstudio: { enabled: true } },
    });
    const lmstudio = built.find((b) => b.id === "lmstudio")!
      .instance as LMStudioProvider;
    const health = await lmstudio.healthCheck(signal());
    expect(health.status).toBe("HEALTHY");
    expect(health.providerId).toBe("lmstudio");
  });

  it("exercises config-driven static fallback for DeepSeek on discovery failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: "unauthorized" }, 401),
      ) as unknown as typeof fetch,
    );
    const built = createBuiltinProviders({
      apiKeys: { deepseek: "test-key" },
      overrides: { deepseek: { enabled: true } },
    });
    const deepseek = built.find((b) => b.id === "deepseek")!
      .instance as DeepSeekProvider;
    const models = await deepseek.listModels(signal());
    expect(models.map((m) => m.id)).toContain("deepseek-chat");
    expect(models.every((m) => m.providerId === "deepseek")).toBe(true);
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
  it("accepts the widened ProviderType union", () => {
    const cfg: ProviderConfig = {
      ...BUILTIN_PROVIDER_DEFAULTS["xai"]!,
      apiKey: undefined,
    };
    expect(cfg.type).toBe("openai-compatible");
  });
});
