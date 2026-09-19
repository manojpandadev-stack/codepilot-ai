/**
 * Tests for OpenAICompatibleProvider: configurable base URL / API key / model,
 * dynamic discovery, static fallback, health checks, normalized errors and
 * secret-safe handling. Uses mocked fetch — no live service.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "../provider.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
  });
}

function modelsPayload(ids: string[]): Response {
  return jsonResponse({
    object: "list",
    data: ids.map((id, i) => ({
      id,
      object: "model",
      created: 1700000000 + i,
    })),
  });
}

function makeProvider(
  overrides: Partial<ProviderConfig> = {},
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: overrides.id ?? "openai-compatible",
    name: overrides.id === "openai" ? "OpenAI" : "OpenAI-Compatible",
    type: "openai-compatible",
    baseUrl: overrides.baseUrl ?? "https://api.example.com/v1",
    apiKey: overrides.apiKey,
    timeoutMs: overrides.timeoutMs ?? 10_000,
    enabled: overrides.enabled ?? true,
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAICompatibleProvider — dynamic discovery", () => {
  it("discovers models from a configurable base URL", async () => {
    const fetchMock = vi.fn(async () =>
      modelsPayload(["gpt-4o-mini", "gpt-4o"]),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const provider = makeProvider({ baseUrl: "https://my-gateway.example/v1" });
    const models = await provider.listModels(signal());

    expect(models.map((m) => m.id).sort()).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://my-gateway.example/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
  });

  it("sends the configured API key as a Bearer token", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        modelsPayload(["gpt-4o-mini"]),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const provider = makeProvider({ apiKey: "sk-test-123" });
    await provider.listModels(signal());

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-test-123");
  });

  it("applies known capability metadata to discovered models", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => modelsPayload(["gpt-4o"])) as unknown as typeof fetch,
    );
    const models = await makeProvider({ id: "openai" }).listModels(signal());
    expect(models[0]?.capabilities.vision).toBe(true);
    expect(models[0]?.capabilities.tools).toBe(true);
    expect(models[0]?.capabilities.contextWindow).toBe(128_000);
    expect(models[0]?.locallyAvailable).toBe(false);
  });

  it("falls back to the static model list for known cloud providers on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: "unauthorized" }, 401),
      ) as unknown as typeof fetch,
    );
    const models = await makeProvider({ id: "openai" }).listModels(signal());
    const ids = models.map((m) => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).toContain("gpt-4o-mini");
  });

  it("returns [] on failure for providers without a static catalogue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof fetch,
    );
    const models = await makeProvider().listModels(signal());
    expect(models).toEqual([]);
  });

  it("returns the static list when no base URL is configured", async () => {
    const openai = makeProvider({ id: "openai", baseUrl: "" });
    expect((await openai.listModels(signal())).length).toBeGreaterThan(0);

    const custom = makeProvider({ baseUrl: "" });
    expect(await custom.listModels(signal())).toEqual([]);
  });
});

describe("OpenAICompatibleProvider — getModel", () => {
  it("returns the discovered model by id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => modelsPayload(["gpt-4o"])) as unknown as typeof fetch,
    );
    const model = await makeProvider({ id: "openai" }).getModel("gpt-4o");
    expect(model?.id).toBe("gpt-4o");
  });

  it("returns null for an unknown model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => modelsPayload(["gpt-4o"])) as unknown as typeof fetch,
    );
    expect(await makeProvider({ id: "openai" }).getModel("nope")).toBeNull();
  });
});

describe("OpenAICompatibleProvider — health checks", () => {
  it("reports HEALTHY when reachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        modelsPayload(["gpt-4o-mini"]),
      ) as unknown as typeof fetch,
    );
    const health = await makeProvider().healthCheck(signal());
    expect(health.status).toBe("HEALTHY");
    expect(health.error).toBeNull();
  });

  it("detects authentication failure (401)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: "nope" }, 401),
      ) as unknown as typeof fetch,
    );
    const health = await makeProvider().healthCheck(signal());
    expect(health.status).toBe("DEGRADED");
    expect(health.error).toContain("API key");
  });

  it("detects authentication failure (403)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: "forbidden" }, 403),
      ) as unknown as typeof fetch,
    );
    const health = await makeProvider().healthCheck(signal());
    expect(health.status).toBe("DEGRADED");
    expect(health.error).toContain("API key");
  });

  it("reports DEGRADED on other HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: "boom" }, 500),
      ) as unknown as typeof fetch,
    );
    const health = await makeProvider().healthCheck(signal());
    expect(health.status).toBe("DEGRADED");
    expect(health.error).toContain("HTTP 500");
  });

  it("reports UNAVAILABLE on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed: network error");
      }) as unknown as typeof fetch,
    );
    const health = await makeProvider().healthCheck(signal());
    expect(health.status).toBe("UNAVAILABLE");
  });

  it("reports UNAVAILABLE when no base URL is configured", () => {
    const provider = makeProvider({ baseUrl: "" });
    return expect(provider.healthCheck(signal())).resolves.toMatchObject({
      status: "UNAVAILABLE",
      error: "No baseUrl configured",
    });
  });
});

describe("OpenAICompatibleProvider — capabilities, normalization, security", () => {
  it("reports provider-level capability flags", () => {
    const provider = makeProvider();
    expect(provider.supportsStreaming()).toBe(true);
    expect(provider.supportsTools()).toBe(true);
    expect(provider.supportsEmbeddings()).toBe(true);
    expect(provider.supportsVision()).toBe(false);
    expect(provider.supportsStructuredOutput()).toBe(false);
  });

  it("returns known capability metadata for OpenAI models", () => {
    const caps = makeProvider({ id: "openai" }).getCapabilities("gpt-4o");
    expect(caps.tools).toBe(true);
    expect(caps.vision).toBe(true);
    expect(caps.structuredOutput).toBe(true);
    expect(caps.contextWindow).toBe(128_000);
  });

  it("uses heuristics for unknown OpenAI-family models", () => {
    const caps = makeProvider().getCapabilities("gpt-4.custom-internal");
    expect(caps.tools).toBe(true);
    expect(caps.structuredOutput).toBe(true);
  });

  it("buildError normalizes and prefix the provider id", () => {
    const provider = makeProvider();
    const err = provider.buildError(new Error("connect ECONNREFUSED"));
    expect(err.code).toBe("NETWORK");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain(`${provider.id}`);
  });

  it("getConfig never exposes the apiKey", () => {
    const provider = makeProvider({ apiKey: "sk-super-secret-99" });
    expect("apiKey" in provider.getConfig()).toBe(false);
    expect(JSON.stringify(provider.getConfig())).not.toContain("secret");
  });

  it("normalizes auth errors from an OpenAI-compatible endpoint without leaking the key", () => {
    const provider = makeProvider({ apiKey: "sk-topsecret-123" });
    const err = provider.buildError(
      "Invalid API key: Authorization: Bearer sk-topsecret-123",
    );
    expect(err.code).toBe("AUTHENTICATION");
    expect(err.message).not.toContain("sk-topsecret-123");
    expect(err.technicalDetail).not.toContain("sk-topsecret-123");
  });

  it("updateConfig applies base URL and apiKey changes but is never exposed", async () => {
    const fetchMock = vi.fn(async () => modelsPayload(["gpt-4o"]));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const provider = makeProvider({ baseUrl: "https://a.example/v1" });
    provider.updateConfig({
      baseUrl: "https://b.example/v2",
      apiKey: "new-key",
    });
    await provider.listModels(signal());
    expect(fetchMock).toHaveBeenCalledWith(
      "https://b.example/v2/models",
      expect.anything(),
    );
    expect("apiKey" in provider.getConfig()).toBe(false);
  });
});
