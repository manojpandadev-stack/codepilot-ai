/**
 * Tests for OllamaProvider: dynamic model discovery, health checks,
 * capability detection and secret-safe configuration. Uses mocked fetch —
 * no live Ollama required.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OLLAMA_DEFAULT_BASE_URL, resolveProviderConfig } from "../config.js";
import { OllamaProvider } from "./ollama.js";
import type { DiscoveredModel } from "../provider.js";

function makeProvider(
  baseUrl: string = OLLAMA_DEFAULT_BASE_URL,
  apiKey?: string,
): OllamaProvider {
  return new OllamaProvider(
    resolveProviderConfig({
      id: "ollama",
      type: "ollama",
      baseUrl,
      apiKey,
      enabled: true,
    }),
  );
}

/** Explicit signal so tests never depend on AbortSignal.timeout timers. */
function signal(): AbortSignal {
  return new AbortController().signal;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
  });
}

function tagsPayload(entries: Array<Record<string, unknown>>): Response {
  return jsonResponse({ models: entries });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OllamaProvider — model discovery", () => {
  it("discovers installed models dynamically (never hard-coded)", async () => {
    const fetchMock = vi.fn(async () =>
      tagsPayload([
        {
          name: "qwen3:8b",
          model: "qwen3:8b",
          modified_at: "2025-05-01T00:00:00Z",
          size: 5_200_000_000,
          details: { parameter_size: "8B", context_length: 32768 },
        },
        {
          name: "llama3.2:3b",
          model: "llama3.2:3b",
          modified_at: "2025-04-01T00:00:00Z",
          size: 2_000_000_000,
          details: { parameter_size: "3B", context_length: 131072 },
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const provider = makeProvider();
    const models = await provider.listModels(signal());

    expect(models.map((m) => m.id).sort()).toEqual(["llama3.2:3b", "qwen3:8b"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/api/tags",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("tags discovered models with provider id and local availability", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        tagsPayload([
          {
            name: "qwen3:8b",
            model: "qwen3:8b",
            modified_at: "2025-05-01T00:00:00Z",
            size: 5_200_000_000,
          },
        ]),
      ) as unknown as typeof fetch,
    );
    const models = await makeProvider().listModels(signal());
    const qwen: DiscoveredModel | undefined = models[0];
    expect(qwen?.providerId).toBe("ollama");
    expect(qwen?.locallyAvailable).toBe(true);
    expect(qwen?.sizeBytes).toBe(5_200_000_000);
    expect(qwen?.lastModified).toBe("2025-05-01T00:00:00Z");
    // qwen3:8b is a known model → static capability metadata is applied
    expect(qwen?.capabilities.tools).toBe(true);
    expect(qwen?.capabilities.reasoning).toBe(true);
    expect(qwen?.capabilities.contextWindow).toBe(32768);
    expect(qwen?.capabilities.parameterSize).toBe("8B");
  });

  it("normalizes a 404 model-not-found response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: "boom" }, 404),
      ) as unknown as typeof fetch,
    );
    await expect(makeProvider().listModels(signal())).rejects.toMatchObject({
      code: "MODEL_NOT_FOUND",
    });
  });

  it("normalizes transient network failures as retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
      }) as unknown as typeof fetch,
    );
    await expect(makeProvider().listModels(signal())).rejects.toMatchObject({
      code: "NETWORK",
      retryable: true,
    });
  });

  it("returns an empty list when the payload is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ unexpected: true }),
      ) as unknown as typeof fetch,
    );
    expect(await makeProvider().listModels(signal())).toEqual([]);
  });

  it("returns [] when no models are installed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tagsPayload([])) as unknown as typeof fetch,
    );
    expect(await makeProvider().listModels(signal())).toEqual([]);
  });

  it("normalizes the base URL (trailing slashes removed)", async () => {
    const fetchMock = vi.fn(async () => tagsPayload([]));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    await makeProvider("http://localhost:11434//").listModels(signal());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/api/tags",
      expect.anything(),
    );
  });
});

describe("OllamaProvider — getModel", () => {
  it("returns the discovered model by id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        tagsPayload([{ name: "qwen3:8b", model: "qwen3:8b" }]),
      ) as unknown as typeof fetch,
    );
    const model = await makeProvider().getModel("qwen3:8b");
    expect(model?.id).toBe("qwen3:8b");
  });

  it("returns null when the model is not installed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        tagsPayload([{ name: "qwen3:8b", model: "qwen3:8b" }]),
      ) as unknown as typeof fetch,
    );
    expect(await makeProvider().getModel("mistral:7b")).toBeNull();
  });
});

describe("OllamaProvider — health checks", () => {
  it("reports HEALTHY with model count", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        tagsPayload([{ name: "qwen3:8b", model: "qwen3:8b" }]),
      ) as unknown as typeof fetch,
    );
    const health = await makeProvider().healthCheck(signal());
    expect(health.status).toBe("HEALTHY");
    expect(health.error).toBeNull();
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports HEALTHY with a warning when no models are installed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tagsPayload([])) as unknown as typeof fetch,
    );
    const health = await makeProvider().healthCheck(signal());
    expect(health.status).toBe("HEALTHY");
    expect(health.error).toContain("No models installed");
  });

  it("reports DEGRADED on HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: "nope" }, 500),
      ) as unknown as typeof fetch,
    );
    const health = await makeProvider().healthCheck(signal());
    expect(health.status).toBe("DEGRADED");
    expect(health.error).toContain("HTTP 500");
  });

  it("reports UNAVAILABLE on connection failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof fetch,
    );
    const health = await makeProvider().healthCheck(signal());
    expect(health.status).toBe("UNAVAILABLE");
  });

  it("reports UNAVAILABLE with a timeout message on aborts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("The operation was aborted");
      }) as unknown as typeof fetch,
    );
    const health = await makeProvider().healthCheck(signal());
    expect(health.status).toBe("UNAVAILABLE");
    expect(health.error).toContain("timed out");
  });

  it("never throws — errors are returned as health state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }) as unknown as typeof fetch,
    );
    await expect(makeProvider().healthCheck(signal())).resolves.toMatchObject({
      status: "UNAVAILABLE",
    });
  });
});

describe("OllamaProvider — endpoint correctness (404 regression)", () => {
  it("health check probes GET /api/tags — never / and never /models", async () => {
    const fetchMock = vi.fn(async (_url: string) => tagsPayload([]));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const health = await makeProvider().healthCheck(signal());
    expect(health.status).toBe("HEALTHY");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://localhost:11434/api/tags",
    );
  });

  it("normalizes trailing-slash base URLs before appending the probe path", async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      tagsPayload([
        {
          name: "qwen3:8b",
          model: "qwen3:8b",
          modified_at: "2025-05-01T00:00:00Z",
          size: 5_200_000_000,
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    // The exact shape users paste into the settings UI.
    const provider = makeProvider("http://localhost:11434/");
    const models = await provider.listModels(signal());
    const health = await provider.healthCheck(signal());
    expect(models.map((m) => m.id)).toEqual(["qwen3:8b"]);
    expect(health.status).toBe("HEALTHY");
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe("http://localhost:11434/api/tags");
    }
  });

  it("classifies HTTP 404 from the tags endpoint as DEGRADED (not connected)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: "not found" }, 404),
      ) as unknown as typeof fetch,
    );
    const health = await makeProvider().healthCheck(signal());
    expect(health.status).toBe("DEGRADED");
    expect(health.error).toContain("HTTP 404");
  });

  it("treats a malformed (non-JSON) tags payload as a provider error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>gateway error</html>", {
            status: 200,
            statusText: "OK",
          }),
      ) as unknown as typeof fetch,
    );
    await expect(makeProvider().listModels(signal())).rejects.toThrow();
    const health = await makeProvider().healthCheck(signal());
    expect(health.status).toBe("UNAVAILABLE");
  });

  it("propagates cancellation: an aborted discovery rejects with a normalized error", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) => {
            if (init?.signal?.aborted) {
              reject(new Error("This operation was aborted"));
              return;
            }
            init?.signal?.addEventListener("abort", () => {
              reject(new Error("This operation was aborted"));
            });
          }),
      ) as unknown as typeof fetch,
    );
    await expect(makeProvider().listModels(controller.signal)).rejects.toThrow(
      /abort/i,
    );
  });
});

describe("OllamaProvider — capabilities and config", () => {
  it("reports provider-level capability flags", () => {
    const provider = makeProvider();
    expect(provider.supportsStreaming()).toBe(true);
    expect(provider.supportsTools()).toBe(true);
    expect(provider.supportsEmbeddings()).toBe(true);
    expect(provider.supportsVision()).toBe(false);
    expect(provider.supportsStructuredOutput()).toBe(false);
  });

  it("returns known capability metadata for well-known models", () => {
    const caps = makeProvider().getCapabilities("qwen3:8b");
    expect(caps.tools).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.contextWindow).toBe(32768);
    expect(caps.codingCapability).toBe("good");
    expect(caps.parameterSize).toBe("8B");
  });

  it("uses heuristics for unknown qwen3 models", () => {
    const caps = makeProvider().getCapabilities("qwen3:32b");
    expect(caps.tools).toBe(true);
    expect(caps.reasoning).toBe(true);
  });

  it("is conservative for unknown non-coding models", () => {
    const caps = makeProvider().getCapabilities("some-random-model");
    expect(caps.tools).toBe(false);
    expect(caps.reasoning).toBe(false);
  });

  it("getConfig never exposes the apiKey", () => {
    const provider = makeProvider(OLLAMA_DEFAULT_BASE_URL, "sk-super-secret");
    expect("apiKey" in provider.getConfig()).toBe(false);
    expect(JSON.stringify(provider.getConfig())).not.toContain("secret");
  });

  it("updateConfig applies base URL changes", async () => {
    const fetchMock = vi.fn(async () => tagsPayload([]));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const provider = makeProvider("http://localhost:11434");
    await provider.listModels(signal());
    provider.updateConfig({ baseUrl: "http://10.0.0.9:11434" });
    await provider.listModels(signal());
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://10.0.0.9:11434/api/tags",
      expect.anything(),
    );
  });
});
