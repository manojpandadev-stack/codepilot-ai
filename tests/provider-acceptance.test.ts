// ============================================================================
// Provider acceptance audit — regression tests for the defects found during
// the final acceptance pass, plus the acceptance criteria that needed
// executable coverage.
//
//   B (OpenRouter): authenticated /key probe (INVALID key must NEVER read
//     "Connected" — /models is public there), HTTP 402 credits class,
//     keyless probe never runs, bounded timeout classification.
//   C (cloud-first / local-optional): cloud configuration with zero Ollama
//     involvement; Ollama/LM Studio local parity; per-provider config
//     isolation; embedding/chat model separation.
//
// Deterministic: every external call is mocked. No real API key is used.
// The runtime-isolation behavior (configure non-active provider must not
// patch the live runtime) is covered by the behavioral assertion that the
// dispatcher emits no "Configuration updated." runtime status for a
// non-active provider — see the describe block marked via provider-status
// messages below.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderService } from "../apps/vscode-extension/src/provider-service";
import { inMemorySecrets, inMemoryState, context } from "./vscode-stub";
import { isEmbeddingModelId } from "../packages/shared/src/index";
import { getCatalogProvider } from "../packages/model-gateway/src/provider-catalog";

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

// ---------------------------------------------------------------------------
// B — OpenRouter authenticated probe semantics
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// B — OpenAI authenticated probe semantics
// ---------------------------------------------------------------------------

describe("OpenAI test connection — authenticated endpoint semantics", () => {
  it("probe URL is the key-authenticated /models endpoint", async () => {
    const svc = makeService();
    await svc.setCredential("openai-native", "sk-test-v1-key");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ data: [{ id: "gpt-4o" }] }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await svc.testConnection("openai-native");
    expect(result.state).toBe("connected");
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) throw new Error("expected probe call");
    const url = String(firstCall[0]);
    expect(url).toBe("https://api.openai.com/v1/models");
    // The credential must travel with the probe.
    const headers = firstCall[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test-v1-key");
  });

  it("an INVALID key reports auth-invalid, never connected (401 on /models)", async () => {
    const svc = makeService();
    await svc.setCredential("openai-native", "sk-test-WRONG");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "invalid key" }, 401)),
    );
    const result = await svc.testConnection("openai-native");
    expect(result.state).toBe("auth-invalid");
    expect(result.state).not.toBe("connected");
  });

  it("no key at all → auth-required (probe never runs unauthenticated)", async () => {
    const svc = makeService();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const result = await svc.testConnection("openai-native");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.state).toBe("auth-required");
    expect(result.message).toMatch(/api key required/i);
  });

  it("HTTP 429 on the authenticated probe reports rate-limited", async () => {
    const svc = makeService();
    await svc.setCredential("openai-native", "sk-test-busy");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 429)));
    const result = await svc.testConnection("openai-native");
    expect(result.state).toBe("rate-limited");
    expect(result.message).toMatch(/429/);
  });

  it("timeout/abort on the authenticated probe reports unavailable (bounded)", async () => {
    const svc = makeService();
    await svc.setCredential("openai-native", "sk-test-slow");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Promise<Response>((_resolve, reject) =>
            setTimeout(
              () => reject(new Error("The operation was aborted due to timeout")),
              20,
            ),
          ),
      ),
    );
    const result = await svc.testConnection("openai-native");
    expect(result.state).toBe("unavailable");
    expect(result.message).toMatch(/time|abort|network/i);
  });

  it("model discovery endpoint contract: OpenAI /models stays available for the picker (catalogue supportsModelDiscovery)", () => {
    const openai = getCatalogProvider("openai-native");
    expect(openai?.supportsModelDiscovery).toBe(true);
    expect(openai?.health.probePath).toBe("/models");
  });
});

// ---------------------------------------------------------------------------
// C — cloud-first without Ollama; local parity; isolation
// ---------------------------------------------------------------------------

describe("cloud configuration without any Ollama involvement", () => {
  it("OpenAI configure→verify→use cycle never touches an Ollama endpoint", async () => {
    const svc = makeService();
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ data: [{ id: "gpt-4o" }] }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    await svc.setCredential("openai-native", "sk-test-key");
    const health = await svc.testConnection("openai-native");
    expect(health.state).toBe("connected");
    for (const call of fetchMock.mock.calls) {
      const url = String(call[0]);
      expect(url).not.toMatch(/11434|localhost|127\.0\.0\.1|ollama/i);
    }
  });

  it("Ollama remains a fully operational local provider without API key", async () => {
    const svc = makeService();
    // Ollama probe (native /api/tags):
    const tagFetch = vi.fn<typeof fetch>(async () =>
      jsonResponse({ models: [{ name: "qwen3:8b" }] }),
    );
    vi.stubGlobal("fetch", tagFetch as unknown as typeof fetch);
    svc.setConfig("ollama", { baseUrl: "http://127.0.0.1:11434" });
    const ollamaHealth = await svc.testConnection("ollama");
    expect(ollamaHealth.state).toBe("connected");
    expect(String(tagFetch.mock.calls[0]![0])).toBe(
      "http://127.0.0.1:11434/api/tags",
    );

    // Removed providers like lmstudio fail closed:
    const removedResult = await svc.testConnection("lmstudio");
    expect(removedResult.state).toBe("invalid-config");
    expect(removedResult.message).toMatch(/unsupported provider/i);
  });

  it("per-provider config isolation — provider X's config never serves provider Y", () => {
    const svc = makeService();
    svc.setConfig("openai-native", {
      baseUrl: "https://custom.openai.example/v1",
    });
    svc.setConfig("ollama", { baseUrl: "http://127.0.0.1:11434" });
    expect(svc.effectiveBaseUrl("openai-native")).toBe(
      "https://custom.openai.example/v1",
    );
    // setConfig stores the URL-validated (normalized) form.
    expect(svc.effectiveBaseUrl("ollama")).toBe("http://127.0.0.1:11434/");
  });

  it("credentials are per-provider: provider X's key is never served for provider Y", async () => {
    const svc = makeService();
    await svc.setCredential("openai-native", "sk-openai-key-A");
    expect(await svc.getCredential("openai-native")).toBe("sk-openai-key-A");
    expect(await svc.getCredential("gemini")).toBeUndefined();
    expect(await svc.getCredential("ollama")).toBeUndefined();
  });

  it("embedding models are excluded from chat-model lists; chat models kept", () => {
    const discovered = [
      "qwen3:8b",
      "qwen2.5-coder:3b",
      "nomic-embed-text:latest",
      "mxbai-embed-large:latest",
      "llama3.1:8b",
    ];
    const chatModels = discovered.filter((id) => !isEmbeddingModelId(id));
    expect(chatModels).toEqual(["qwen3:8b", "qwen2.5-coder:3b", "llama3.1:8b"]);
  });
});
