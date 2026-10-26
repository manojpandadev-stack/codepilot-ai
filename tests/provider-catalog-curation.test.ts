// ============================================================================
// Provider catalog curation — cloud-first curated list, legacy preservation,
// SecretStorage hygiene, embedding/chat separation, connection-test states.
//
// Deterministic: every external call is mocked. No real provider API is
// contacted and no real API key is used anywhere in this file.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODEPILOT_PROVIDER_CATALOG,
  CURATED_PROVIDER_IDS,
  CURATED_PROVIDER_LIMIT,
  isLegacyProviderId,
} from "../packages/llm/src/catalogue";
import {
  getProviderCatalog,
  getCuratedProviderCatalog,
  getCatalogProvider,
} from "../packages/model-gateway/src/provider-catalog";
import { isEmbeddingModelId } from "../packages/shared/src/index";
import {
  connectionTestView,
  normalizeCatalogProviders,
  type CatalogProviderLite,
} from "../apps/webview/src/lib/messages";
import {
  ProviderService,
  validateProviderBaseUrl,
} from "../apps/vscode-extension/src/provider-service";
import { inMemorySecrets, inMemoryState, context } from "./vscode-stub";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(): ProviderService {
  return new ProviderService(
    context as unknown as ConstructorParameters<typeof ProviderService>[0],
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
  });
}

/** Minimal CatalogProviderLite factory for normalizer tests. */
function liteProvider(
  overrides: Partial<CatalogProviderLite> & { id: string },
): CatalogProviderLite {
  return {
    displayName: overrides.id,
    category: "cloud",
    status: "SUPPORTED",
    protocol: "openai-chat",
    supportsCustomBaseUrl: false,
    requiresApiKey: true,
    supportsLocal: false,
    supportsModelDiscovery: false,
    supportsToolCalling: true,
    supportsVision: false,
    supportsReasoning: false,
    fields: [],
    models: [],
    defaultModelId: "",
    usage: { kind: "none" },
    ...overrides,
  };
}

beforeEach(() => {
  inMemoryState.clear();
  inMemorySecrets.clear();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Phase 2 — curated catalog (≤ 12 primary entries)
// ---------------------------------------------------------------------------

describe("curated provider catalog — exactly 3 supported providers", () => {
  it("curated list has exactly 3 entries", () => {
    expect(CURATED_PROVIDER_IDS.length).toBe(3);
    expect(CURATED_PROVIDER_LIMIT).toBe(12);
  });

  it("curated list matches exactly OpenAI, Gemini, and Ollama", () => {
    expect([...CURATED_PROVIDER_IDS]).toEqual([
      "openai-native",
      "gemini",
      "ollama",
    ]);
  });

  it("every curated id exists in the catalogue and is routable metadata-wise", () => {
    const ids = new Set(CODEPILOT_PROVIDER_CATALOG.map((p) => p.id));
    for (const id of CURATED_PROVIDER_IDS) {
      expect(ids.has(id), `curated id ${id} must exist in the catalogue`).toBe(
        true,
      );
    }
  });

  it("curated catalog has exactly 3 entries", () => {
    const curated = getCuratedProviderCatalog();
    expect(curated.length).toBe(3);
    for (const p of curated) {
      expect(p.curated).toBe(true);
      expect(isLegacyProviderId(p.id)).toBe(false);
    }
  });

  it("removed providers are absent from the catalogue and fail closed", () => {
    for (const removed of [
      "anthropic",
      "openrouter",
      "groq",
      "deepseek",
      "mistral",
      "zai",
      "lmstudio",
      "openai-compatible",
    ]) {
      expect(getCatalogProvider(removed)).toBeUndefined();
    }
  });

  it("catalog flags local providers and cloud providers distinctly", () => {
    const ollama = getCatalogProvider("ollama");
    const openai = getCatalogProvider("openai-native");
    expect(ollama?.category).toBe("local");
    expect(ollama?.requiresApiKey).toBe(false);
    expect(openai?.category).toBe("cloud");
    expect(openai?.requiresApiKey).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cloud configuration works without Ollama installed
// ---------------------------------------------------------------------------

describe("cloud provider configuration without Ollama installed", () => {
  it("stores and reports a credential for a cloud provider with zero local involvement", async () => {
    const svc = makeService();
    expect(await svc.hasCredential("openai-native")).toBe(false);

    await svc.setCredential("openai-native", "sk-test-not-a-real-key");
    expect(await svc.hasCredential("openai-native")).toBe(true);

    // Effective base URL resolves from the catalogue without any Ollama call.
    // (Catalogue default — no trailing slash normalization on pass-through.)
    expect(svc.effectiveBaseUrl("openai-native")).toBe(
      "https://api.openai.com/v1",
    );

    // Connection truth: credential presence is "configured", NEVER connected.
    const states = await svc.listConnectionStates();
    const openai = states.find((s) => s.id === "openai-native");
    expect(openai?.state).toBe("configured");
    expect(openai?.connected).toBe(false);
  });

  it("cloud base URL validation uses the SSRF policy (blocks loopback for cloud)", () => {
    const cloud = validateProviderBaseUrl("http://127.0.0.1:8080", "openai-native");
    expect(cloud.ok).toBe(false);
    const good = validateProviderBaseUrl(
      "https://api.openai.com/v1",
      "openai-native",
    );
    expect(good.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OpenRouter base URL + manual model ids
// ---------------------------------------------------------------------------

describe("OpenAI configuration and base URL handling", () => {
  it("defaults to https://api.openai.com/v1 and allows a validated override", async () => {
    const svc = makeService();
    expect(svc.effectiveBaseUrl("openai-native")).toBe(
      "https://api.openai.com/v1",
    );
    svc.setConfig("openai-native", { baseUrl: "https://openai.example/v1" });
    // .example TLD is policy-allowed (global) — override wins over default.
    expect(svc.effectiveBaseUrl("openai-native")).toBe(
      "https://openai.example/v1",
    );
  });

  it("rejects credential-bearing or non-HTTPS override URLs", () => {
    expect(
      validateProviderBaseUrl("https://user:pass@api.openai.com/v1", "openai-native").ok,
    ).toBe(false);
    expect(validateProviderBaseUrl("ftp://api.openai.com", "openai-native").ok).toBe(
      false,
    );
  });

  it("normalizes catalog payloads keeping the curated flag (webview side)", () => {
    const payload = {
      providers: [
        liteProvider({ id: "openai-native", curated: true }),
        liteProvider({ id: "openai", displayName: "OpenAI (legacy alias)", curated: false }),
        liteProvider({ id: "google", displayName: "Google Gemini (legacy alias)", curated: false }),
      ],
    };
    const all = normalizeCatalogProviders(payload);
    expect(all).toHaveLength(3);
    const primary = normalizeCatalogProviders(payload, { curatedOnly: true });
    expect(primary.map((p) => p.id)).toEqual(["openai-native"]);
  });

  it("treats a pre-flag host payload as all-curated (forward compatibility)", () => {
    const legacyPayload = {
      providers: [liteProvider({ id: "openai-native" })],
    };
    const primary = normalizeCatalogProviders(legacyPayload, {
      curatedOnly: true,
    });
    expect(primary).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// SecretStorage integration and credential redaction
// ---------------------------------------------------------------------------

describe("SecretStorage integration and credential hygiene", () => {
  it("stores keys only in SecretStorage under codepilot.apiKey.<id>", async () => {
    const svc = makeService();
    await svc.setCredential("anthropic", "sk-ant-test-value");
    expect(inMemorySecrets.get("codepilot.apiKey.anthropic")).toBe(
      "sk-ant-test-value",
    );
    expect(inMemoryState.get("codepilot.providerConfig.v1")).toBeUndefined();
  });

  it("clearCredential removes the stored slot (canonical ids have no divergent legacy slot)", async () => {
    const svc = makeService();
    await svc.setCredential("gemini", "new-slot-key");
    expect(inMemorySecrets.get("codepilot.apiKey.gemini")).toBe(
      "new-slot-key",
    );
    await svc.clearCredential("gemini");
    expect(inMemorySecrets.get("codepilot.apiKey.gemini")).toBeUndefined();
  });

  it("never persists secret-shaped values through setConfig fields", () => {
    const svc = makeService();
    svc.setConfig("openai-compatible", {
      fields: { region: "us-east-1", apiKey: "sk-should-not-persist", token: "nope" },
    });
    const stored = inMemoryState.get("codepilot.providerConfig.v1") as {
      "openai-compatible"?: { fields?: Record<string, string> };
    };
    expect(stored["openai-compatible"]?.fields?.region).toBe("us-east-1");
    expect(stored["openai-compatible"]?.fields?.apiKey).toBeUndefined();
    expect(stored["openai-compatible"]?.fields?.token).toBeUndefined();
  });

  it("health results carry no secret material", async () => {
    const svc = makeService();
    await svc.setCredential("openai-native", "sk-very-secret-value");
    svc.setConfig("openai-native", { baseUrl: "https://api.openai.com/v1" });
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ data: [{ id: "gpt-4o" }] }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const result = await svc.testConnection("openai-native");
    expect(result.state).toBe("connected");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sk-very-secret-value");
  });
});

// ---------------------------------------------------------------------------
// Model selection, custom ids, embedding/chat separation
// ---------------------------------------------------------------------------

describe("model selection and invalid chat-model vs embedding-model handling", () => {
  it("classifies embedding model ids (Ollama naming, BGE/E5/GTE families)", () => {
    expect(isEmbeddingModelId("nomic-embed-text:latest")).toBe(true);
    expect(isEmbeddingModelId("mxbai-embed-large")).toBe(true);
    expect(isEmbeddingModelId("bge-m3")).toBe(true);
    expect(isEmbeddingModelId("text-embedding-3-small")).toBe(true);
    expect(isEmbeddingModelId("e5-large-v2")).toBe(true);
    expect(isEmbeddingModelId("gte-large")).toBe(true);
  });

  it("does NOT classify chat models as embedding models", () => {
    expect(isEmbeddingModelId("qwen3:8b")).toBe(false);
    expect(isEmbeddingModelId("qwen2.5-coder:3b")).toBe(false);
    expect(isEmbeddingModelId("gpt-4o")).toBe(false);
    expect(isEmbeddingModelId("claude-sonnet-4-20250514")).toBe(false);
    expect(isEmbeddingModelId("deepseek-chat")).toBe(false);
    expect(isEmbeddingModelId("moonshotai/kimi-k2-instruct")).toBe(false);
    expect(isEmbeddingModelId("llama3.2-vision")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Connection-test states (step ③) — pure UI mapping
// ---------------------------------------------------------------------------

describe("connectionTestView — explicit step-3 states", () => {
  it("maps every host health state honestly", () => {
    expect(
      connectionTestView({
        requiresApiKey: true,
        credentialConfigured: true,
        health: { state: "connected", message: "Connected." },
      }),
    ).toMatchObject({ state: "connected", label: "Connected" });

    expect(
      connectionTestView({
        requiresApiKey: true,
        credentialConfigured: true,
        health: { state: "auth-invalid", message: "HTTP 401/403" },
      }).state,
    ).toBe("auth-failed");

    expect(
      connectionTestView({
        requiresApiKey: true,
        credentialConfigured: true,
        health: { state: "invalid-config", message: "No base URL" },
      }).state,
    ).toBe("invalid-endpoint");

    expect(
      connectionTestView({
        requiresApiKey: true,
        credentialConfigured: true,
        health: { state: "rate-limited", message: "HTTP 429" },
      }).state,
    ).toBe("rate-limited");

    expect(
      connectionTestView({
        requiresApiKey: true,
        credentialConfigured: true,
        health: {
          state: "unavailable",
          message: "Network error: ECONNREFUSED",
        },
      }).state,
    ).toBe("network-error");

    expect(
      connectionTestView({
        requiresApiKey: true,
        credentialConfigured: true,
        health: {
          state: "unavailable",
          message: "Provider responded HTTP 500.",
        },
      }).state,
    ).toBe("invalid-endpoint");

    expect(
      connectionTestView({
        requiresApiKey: true,
        credentialConfigured: false,
        health: { state: "auth-required", message: "API key required" },
      }).state,
    ).toBe("not-configured");
  });

  it("never marks connected from credential presence alone", () => {
    const view = connectionTestView({
      requiresApiKey: true,
      credentialConfigured: true,
    });
    expect(view.state).toBe("not-configured");
    expect(view.label).not.toContain("Connected");
  });

  it("distinguishes the Testing… in-flight state", () => {
    const view = connectionTestView({
      requiresApiKey: true,
      credentialConfigured: true,
      testing: true,
    });
    expect(view.state).toBe("testing");
    expect(view.label).toBe("Testing…");
  });

  it("no-endpoint providers honestly cannot be auto-verified", () => {
    const view = connectionTestView({
      requiresApiKey: true,
      credentialConfigured: true,
      health: {
        state: "no-endpoint",
        message: "No testable HTTP endpoint.",
      },
    });
    expect(view.state).toBe("model-unavailable");
    expect(view.label).toBe("Cannot verify automatically");
  });
});

// ---------------------------------------------------------------------------
// Provider testConnection — mocked HTTP states (no real APIs)
// ---------------------------------------------------------------------------

describe("ProviderService.testConnection — mocked failure/success classes", () => {
  it("reports auth-invalid on HTTP 401 (mocked)", async () => {
    const svc = makeService();
    await svc.setCredential("openai-native", "sk-wrong-key");
    svc.setConfig("openai-native", { baseUrl: "https://api.openai.com/v1" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "bad key" }, 401)),
    );
    const result = await svc.testConnection("openai-native");
    expect(result.state).toBe("auth-invalid");
  });

  it("reports rate-limited on HTTP 429 (mocked)", async () => {
    const svc = makeService();
    await svc.setCredential("openai-native", "sk-test");
    svc.setConfig("openai-native", { baseUrl: "https://api.openai.com/v1" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "quota" }, 429)),
    );
    const result = await svc.testConnection("openai-native");
    expect(result.state).toBe("rate-limited");
  });

  it("reports unavailable for network errors (mocked fetch rejection)", async () => {
    const svc = makeService();
    await svc.setCredential("openai-native", "sk-test");
    svc.setConfig("openai-native", { baseUrl: "https://api.openai.com/v1" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network error: ECONNREFUSED");
      }),
    );
    const result = await svc.testConnection("openai-native");
    expect(result.state).toBe("unavailable");
    expect(result.message).toMatch(/network error/i);
  });

  it("removed provider fails closed with invalid-config and unknown/unsupported provider message", async () => {
    const svc = makeService();
    const result = await svc.testConnection("anthropic");
    expect(result.state).toBe("invalid-config");
    expect(result.message).toMatch(/unknown|unsupported provider/i);
  });

  it("Ollama-style local probe still uses /api/tags (regression guard)", async () => {
    const svc = makeService();
    svc.setConfig("ollama", { baseUrl: "http://localhost:11434" });
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ models: [{ name: "qwen3:8b" }] }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const result = await svc.testConnection("ollama");
    expect(result.state).toBe("connected");
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) throw new Error("expected probe call");
    expect(String(firstCall[0])).toBe("http://localhost:11434/api/tags");
  });

  it("usage for non-OpenRouter providers honestly reports local tracking", async () => {
    const svc = makeService();
    const snap = await svc.getUsage("openai-native");
    expect(snap.kind).toBe("local-tracking");
    expect(snap.usage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Legacy-alias backward compatibility (settings + secrets)
// ---------------------------------------------------------------------------

describe("legacy provider id backward compatibility", () => {
  it("resolves credentials stored under legacy ids (google → legacy slot)", async () => {
    const svc = makeService();
    // A pre-catalogue install stored the key under the google slot.
    inMemorySecrets.set("codepilot.apiKey.google", "old-google-key");
    expect(await svc.getCredential("google")).toBe("old-google-key");
    // And the canonical gemini id can still be configured independently.
    await svc.setCredential("gemini", "new-gemini-key");
    expect(await svc.getCredential("gemini")).toBe("new-gemini-key");
  });

  it("legacy ids remain configurable through the host service", async () => {
    const svc = makeService();
    await svc.setCredential("openai", "sk-legacy-key");
    expect(await svc.hasCredential("openai")).toBe(true);
    svc.setConfig("openai", { baseUrl: "https://api.openai.com/v1" });
    expect(svc.effectiveBaseUrl("openai")).toBe(
      "https://api.openai.com/v1",
    );
  });
});
