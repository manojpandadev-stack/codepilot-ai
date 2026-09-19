/**
 * Test Connection regression — the Ollama 404 bug.
 *
 * The VS Code host's ProviderService.testConnection() used to probe
 * `GET {base}/models` for EVERY provider. Ollama's native API has no
 * /models route (model discovery/health is GET /api/tags), so the UI
 * reported "Provider responded HTTP 404." even though Ollama was healthy.
 *
 * These tests run the REAL ProviderService (via the `vscode` module stub)
 * with mocked global fetch — no live Ollama required.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderService } from "../apps/vscode-extension/src/provider-service";
import { inMemorySecrets, inMemoryState, context } from "./vscode-stub";

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

beforeEach(() => {
  inMemoryState.clear();
  inMemorySecrets.clear();
  vi.unstubAllGlobals();
});

describe("ProviderService.testConnection — Ollama endpoint correctness", () => {
  it("probes GET {base}/api/tags and reports connected", async () => {
    const svc = makeService();
    svc.setConfig("ollama", { baseUrl: "http://localhost:11434" });
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        models: [
          { name: "qwen3:8b", model: "qwen3:8b", size: 5_200_000_000 },
          { name: "qwen2.5-coder:3b", model: "qwen2.5-coder:3b" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await svc.testConnection("ollama");

    expect(result.state).toBe("connected");
    expect(result.message).toBe("Connected.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) throw new Error("expected Ollama probe to have been called");
    const [url] = firstCall;
    expect(url).toBe("http://localhost:11434/api/tags");
  });

  it("NEVER probes the root endpoint (/) for Ollama", async () => {
    const svc = makeService();
    svc.setConfig("ollama", { baseUrl: "http://localhost:11434/" });
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ models: [] }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await svc.testConnection("ollama");

    expect(result.state).toBe("connected");
    for (const call of fetchMock.mock.calls) {
      const requested = String(call[0]);
      expect(requested).not.toBe("http://localhost:11434/");
      expect(requested).not.toBe("http://localhost:11434");
      expect(requested).toBe("http://localhost:11434/api/tags");
    }
  });

  it("NEVER probes /models for Ollama (the 404 regression)", async () => {
    const svc = makeService();
    svc.setConfig("ollama", { baseUrl: "http://localhost:11434/" });
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        models: [{ name: "qwen3:8b", model: "qwen3:8b" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await svc.testConnection("ollama");

    expect(result.state).toBe("connected");
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain("/models");
    }
  });

  it("normalizes trailing slashes exactly as configured in the settings UI", async () => {
    const svc = makeService();
    svc.setConfig("ollama", { baseUrl: "http://localhost:11434/" });
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ models: [] }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await svc.testConnection("ollama");

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://localhost:11434/api/tags",
    );
  });

  it("still classifies an honest HTTP 404 from Ollama as unavailable", async () => {
    const svc = makeService();
    svc.setConfig("ollama", { baseUrl: "http://localhost:11434" });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => jsonResponse({ error: "not found" }, 404),
      ) as unknown as typeof fetch,
    );

    const result = await svc.testConnection("ollama");

    expect(result.state).toBe("unavailable");
    expect(result.message).toBe("Provider responded HTTP 404.");
  });

  it("reports a network error when Ollama is unreachable (ECONNREFUSED)", async () => {
    const svc = makeService();
    svc.setConfig("ollama", { baseUrl: "http://localhost:11434" });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
      }) as unknown as typeof fetch,
    );

    const result = await svc.testConnection("ollama");

    expect(result.state).toBe("unavailable");
    expect(result.message).toContain("Network error");
  });

  it("reports a timeout when the probe is aborted", async () => {
    const svc = makeService();
    svc.setConfig("ollama", { baseUrl: "http://localhost:11434" });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new Error("This operation was aborted");
      }) as unknown as typeof fetch,
    );

    const result = await svc.testConnection("ollama");

    expect(result.state).toBe("unavailable");
    expect(result.message).toBe("Provider did not respond in time.");
  });

  it("rejects a reachable endpoint that does not return a model list", async () => {
    const svc = makeService();
    svc.setConfig("ollama", { baseUrl: "http://localhost:11434" });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>not json</html>", {
            status: 200,
            statusText: "OK",
          }),
      ) as unknown as typeof fetch,
    );

    const result = await svc.testConnection("ollama");

    expect(result.state).toBe("unavailable");
    expect(result.message).toContain("did not return a model list");
  });

  it("requires no API key for the local Ollama probe", async () => {
    const svc = makeService();
    svc.setConfig("ollama", { baseUrl: "http://localhost:11434" });
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ models: [] }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await svc.testConnection("ollama");

    expect(result.state).toBe("connected");
    const init = fetchMock.mock.calls[0]?.[1];
    // No Authorization header may be sent to the local Ollama probe.
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
  });
});

describe("ProviderService.testConnection — provider switching", () => {
  it("switching to an OpenAI-compatible provider probes {base}/models (unchanged)", async () => {
    const svc = makeService();
    // openai-compatible is a BYO provider: the curated catalogue carries NO
    // default base URL (baseUrl: undefined), and the M13 SSRF policy blocks
    // loopback base URLs for its non-local category — so configure an
    // explicit remote endpoint, as the user must.
    svc.setConfig("openai-compatible", {
      baseUrl: "https://api.example.com/v1",
    });
    const svcBase = svc.effectiveBaseUrl("openai-compatible");
    expect(svcBase).toBe("https://api.example.com/v1");
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    inMemorySecrets.set("codepilot.apiKey.openai-compatible", "test-key");
    const result = await svc.testConnection("openai-compatible");

    expect(result.state).toBe("connected");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${svcBase!.replace(/\/+$/, "")}/models`,
    );
  });

  it("switching to the local LM Studio provider still probes loopback /models", async () => {
    const svc = makeService();
    svc.setConfig("lmstudio", { baseUrl: "http://localhost:1234/v1" });
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await svc.testConnection("lmstudio");

    expect(result.state).toBe("connected");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://localhost:1234/v1/models",
    );
  });

  it("switching back to Ollama after another provider probes /api/tags again", async () => {
    const svc = makeService();
    svc.setConfig("lmstudio", { baseUrl: "http://localhost:1234/v1" });
    const fetchMock = vi.fn<typeof fetch>(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/models")) return jsonResponse({ data: [] });
      if (url.endsWith("/api/tags")) {
        return jsonResponse({ models: [{ name: "qwen3:8b" }] });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(
      svc.testConnection("lmstudio"),
    ).resolves.toMatchObject({ state: "connected" });
    await expect(svc.testConnection("ollama")).resolves.toMatchObject({
      state: "connected",
    });
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.endsWith("/api/tags"))).toHaveLength(1);
  });

  it("returns invalid-config for an unknown provider id", async () => {
    const svc = makeService();
    const result = await svc.testConnection("definitely-not-a-provider");
    expect(result.state).toBe("invalid-config");
  });
});
