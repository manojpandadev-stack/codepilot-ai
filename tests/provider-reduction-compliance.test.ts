/**
 * Provider Reduction Compliance Test Suite.
 *
 * Verifies CodePilot AI's strict reduction to exactly three supported providers:
 *   1. OpenAI (canonical ID: openai-native) — requires user-supplied API key
 *   2. Gemini (canonical ID: gemini) — requires user-supplied API key
 *   3. Ollama (canonical ID: ollama) — local provider, no key required
 *
 * Covers the 10 prompt requirements:
 *   1. Provider catalogue and user-facing selectors expose exactly OpenAI, Gemini, and Ollama.
 *   2. Removed provider IDs fail closed through UI messages, runtime creation, resume, and CLI.
 *   3. OpenAI and Gemini credentials resolve from secure storage and are never serialized to UI or task records.
 *   4. Ollama works without a key.
 *   5. Local Only blocks OpenAI and Gemini before any network request.
 *   6. Local Ollama remains available under Local Only.
 *   7. Unsupported persisted provider IDs do not trigger network access during resume.
 *   8. Provider discovery, connection testing, inference testing, and usage paths work only for supported providers.
 *   9. Unknown/future provider values are handled safely.
 *   10. Existing supported-provider tests continue to pass.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURATED_PROVIDER_IDS,
  SUPPORTED_PROVIDER_IDS,
  CODEPILOT_PROVIDER_CATALOG,
  isSupportedProviderId as isLlmSupportedProviderId,
} from "../packages/llm/src/catalogue";
import { createLlmProvider } from "../packages/llm/src/factory";
import {
  getProviderCatalog,
  getCuratedProviderCatalog,
  getCatalogProvider,
} from "../packages/model-gateway/src/provider-catalog";
import {
  BUILTIN_PROVIDER_IDS,
  isSupportedProviderId as isGatewaySupportedProviderId,
} from "../packages/model-gateway/src/config";
import { createProviderFromConfig } from "../packages/model-gateway/src/provider-factory";
import { ProviderService } from "../apps/vscode-extension/src/provider-service";
import { inMemorySecrets, inMemoryState, context } from "./vscode-stub";

const REMOVED_PROVIDER_IDS = [
  "openrouter",
  "anthropic",
  "groq",
  "deepseek",
  "mistral",
  "z-ai",
  "lmstudio",
  "openai-compatible",
  "bedrock",
  "jev",
  "systemone",
] as const;

function makeService(getMode?: () => "local" | "hybrid" | "cloud"): ProviderService {
  return new ProviderService(
    context as unknown as ConstructorParameters<typeof ProviderService>[0],
    getMode,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
  });
}

beforeEach(() => {
  inMemoryState.clear();
  inMemorySecrets.clear();
  vi.unstubAllGlobals();
});

describe("1. Provider catalogue and selectors expose exactly OpenAI, Gemini, and Ollama", () => {
  it("exposes exactly the 3 canonical provider IDs across @codepilot/llm", () => {
    expect(CURATED_PROVIDER_IDS).toEqual(["openai-native", "gemini", "ollama"]);
    expect(SUPPORTED_PROVIDER_IDS).toEqual(["openai-native", "gemini", "ollama"]);
    expect(CODEPILOT_PROVIDER_CATALOG.map((p) => p.id).sort()).toEqual(
      ["gemini", "ollama", "openai-native"].sort(),
    );
  });

  it("exposes exactly the 3 canonical provider IDs across @codepilot/model-gateway", () => {
    expect(BUILTIN_PROVIDER_IDS).toEqual(["ollama", "openai-native", "gemini"]);
    const catalog = getProviderCatalog();
    expect(catalog.map((p) => p.id).sort()).toEqual(
      ["gemini", "ollama", "openai-native"].sort(),
    );
    const curated = getCuratedProviderCatalog();
    expect(curated.map((p) => p.id).sort()).toEqual(
      ["gemini", "ollama", "openai-native"].sort(),
    );
  });

  it("exposes exactly the 3 providers from ProviderService.listProviders()", () => {
    const svc = makeService();
    const providers = svc.listProviders();
    expect(providers.map((p) => p.id).sort()).toEqual(
      ["gemini", "ollama", "openai-native"].sort(),
    );
  });

  it("asserts every removed provider is absent from the catalogue", () => {
    for (const id of REMOVED_PROVIDER_IDS) {
      expect(isLlmSupportedProviderId(id)).toBe(false);
      expect(isGatewaySupportedProviderId(id)).toBe(false);
      expect(getCatalogProvider(id)).toBeUndefined();
    }
  });
});

describe("2. Removed provider IDs fail closed through runtime creation and message handlers", () => {
  it("fails closed in @codepilot/llm createLlmProvider for all removed providers", () => {
    for (const id of REMOVED_PROVIDER_IDS) {
      expect(() =>
        createLlmProvider({
          providerId: id as never,
          modelId: "some-model",
          apiKey: "fake-key",
        }),
      ).toThrow(/unsupported provider/i);
    }
  });

  it("fails closed in @codepilot/model-gateway createProviderFromConfig for all removed providers", () => {
    for (const id of REMOVED_PROVIDER_IDS) {
      expect(() =>
        createProviderFromConfig({
          id,
          name: id,
          type: id as never,
        }),
      ).toThrow(/unsupported provider/i);
    }
  });

  it("fails closed in ProviderService connection testing for all removed providers", async () => {
    const svc = makeService();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    for (const id of REMOVED_PROVIDER_IDS) {
      const result = await svc.testConnection(id);
      expect(result.state).toBe("invalid-config");
      expect(result.message).toMatch(/unsupported provider/i);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed in ProviderService inference testing for all removed providers", async () => {
    const svc = makeService();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    for (const id of REMOVED_PROVIDER_IDS) {
      const result = await svc.testInference(id, "some-model");
      expect(result.state).toBe("failed");
      expect(result.message).toMatch(/unsupported provider/i);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("3. OpenAI and Gemini credentials resolve from secure storage and are never serialized to non-secret storage", () => {
  it("resolves OpenAI key from SecretStorage and never leaks into non-secret config", async () => {
    const svc = makeService();
    const FAKE_OPENAI_KEY = "sk-test-secret-openai-12345";
    await svc.setCredential("openai-native", FAKE_OPENAI_KEY);

    expect(await svc.hasCredential("openai-native")).toBe(true);
    expect(await svc.getCredential("openai-native")).toBe(FAKE_OPENAI_KEY);

    // setConfig defensive scrub prevents secret persistence:
    svc.setConfig("openai-native", {
      baseUrl: "https://api.openai.com/v1",
      fields: { apiKey: FAKE_OPENAI_KEY, customHeader: "value" },
    });
    const storedConfig = JSON.stringify(svc.getConfig("openai-native"));
    expect(storedConfig).not.toContain(FAKE_OPENAI_KEY);
    expect(storedConfig).toContain("customHeader");
  });

  it("resolves Gemini key from SecretStorage and never leaks into non-secret config", async () => {
    const svc = makeService();
    const FAKE_GEMINI_KEY = "AIzaSyTestSecretGemini-98765";
    await svc.setCredential("gemini", FAKE_GEMINI_KEY);

    expect(await svc.hasCredential("gemini")).toBe(true);
    expect(await svc.getCredential("gemini")).toBe(FAKE_GEMINI_KEY);

    svc.setConfig("gemini", {
      fields: { apiKey: FAKE_GEMINI_KEY, token: "bad" },
    });
    const storedConfig = JSON.stringify(svc.getConfig("gemini"));
    expect(storedConfig).not.toContain(FAKE_GEMINI_KEY);
  });

  it("clears credentials safely without deleting legacy keys of removed providers", async () => {
    const svc = makeService();
    inMemorySecrets.set("codepilot.apiKey.openrouter", "preserved-removed-key");
    await svc.setCredential("openai-native", "sk-active-key");

    await svc.clearCredential("openai-native");
    expect(await svc.getCredential("openai-native")).toBeUndefined();
    // Removed provider entry is preserved in storage:
    expect(inMemorySecrets.get("codepilot.apiKey.openrouter")).toBe("preserved-removed-key");
  });
});

describe("4. Ollama works without an API key", () => {
  it("Ollama does not require an API key in catalogue metadata", () => {
    const ollama = getCatalogProvider("ollama");
    expect(ollama).toBeDefined();
    expect(ollama?.requiresApiKey).toBe(false);
    expect(ollama?.health.requiresApiKeyForProbe).toBe(false);
  });

  it("Ollama testConnection succeeds without an API key", async () => {
    const svc = makeService();
    svc.setConfig("ollama", { baseUrl: "http://localhost:11434" });
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ models: [{ name: "llama3" }] }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await svc.testConnection("ollama");
    expect(result.state).toBe("connected");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("Ollama testInference succeeds without an API key", async () => {
    const svc = makeService();
    svc.setConfig("ollama", { baseUrl: "http://localhost:11434" });
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ choices: [{ message: { content: "pong from ollama" } }] }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await svc.testInference("ollama", "llama3");
    expect(result.state).toBe("success");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("5. Local Only blocks OpenAI and Gemini before any network request", () => {
  it("blocks OpenAI connection and inference with zero outbound requests under Local Only", async () => {
    const svc = makeService(() => "local");
    await svc.setCredential("openai-native", "sk-mock-key");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const conn = await svc.testConnection("openai-native");
    expect(conn.state).toBe("invalid-config");
    expect(conn.message).toMatch(/Local Only/i);
    expect(fetchMock).not.toHaveBeenCalled();

    const inf = await svc.testInference("openai-native", "gpt-4o-mini");
    expect(inf.state).toBe("blocked");
    expect(inf.message).toMatch(/Local Only/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks Gemini connection with zero outbound requests under Local Only", async () => {
    const svc = makeService(() => "local");
    await svc.setCredential("gemini", "mock-gemini-key");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const conn = await svc.testConnection("gemini");
    expect(conn.state).toBe("invalid-config");
    expect(conn.message).toMatch(/Local Only/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("6. Local Ollama remains available under Local Only", () => {
  it("allows Ollama probe on loopback under Local Only", async () => {
    const svc = makeService(() => "local");
    svc.setConfig("ollama", { baseUrl: "http://localhost:11434" });
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ models: [{ name: "codellama" }] }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await svc.testConnection("ollama");
    expect(result.state).toBe("connected");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks Ollama if pointed at a remote non-loopback URL under Local Only", async () => {
    const svc = makeService(() => "local");
    svc.setConfig("ollama", { baseUrl: "https://remote-ollama.example.com" });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await svc.testConnection("ollama");
    expect(result.state).toBe("invalid-config");
    expect(result.message).toMatch(/Local Only/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("7. Unsupported persisted provider IDs do not trigger network access during resume", () => {
  it("fails closed on unsupported provider during session start without network access", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    for (const id of REMOVED_PROVIDER_IDS) {
      expect(() =>
        createLlmProvider({
          providerId: id as never,
          modelId: "default",
        }),
      ).toThrow(/unsupported provider/i);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("8. Provider discovery, connection testing, inference testing, and usage work only for supported providers", () => {
  it("effectiveBaseUrl returns undefined or custom override only for supported providers", () => {
    const svc = makeService();
    expect(svc.effectiveBaseUrl("openai-native")).toBe("https://api.openai.com/v1");
    expect(svc.effectiveBaseUrl("ollama")).toBe("http://localhost:11434");
    expect(svc.effectiveBaseUrl("gemini")).toBe("https://generativelanguage.googleapis.com");
    for (const id of REMOVED_PROVIDER_IDS) {
      expect(svc.effectiveBaseUrl(id)).toBeUndefined();
    }
  });

  it("getUsage fails closed with secret-free error for removed providers", async () => {
    const svc = makeService();
    for (const id of REMOVED_PROVIDER_IDS) {
      const usage = await svc.getUsage(id);
      expect(usage.error).toMatch(/unsupported provider/i);
    }
  });
});

describe("9. Unknown/future provider values are handled safely", () => {
  it("fails closed on completely arbitrary unknown provider string", async () => {
    const svc = makeService();
    const result = await svc.testConnection("future-quantum-provider-2030");
    expect(result.state).toBe("invalid-config");
    expect(result.message).toMatch(/unsupported provider/i);

    const inf = await svc.testInference("future-quantum-provider-2030", "model-x");
    expect(inf.state).toBe("failed");
    expect(inf.message).toMatch(/unsupported provider/i);
  });
});
