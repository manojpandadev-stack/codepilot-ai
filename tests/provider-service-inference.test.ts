/**
 * Inference-probe response-shape regression tests (Problem B).
 *
 * testInference() must never treat a bare HTTP 2xx as successful
 * inference. These tests drive the REAL ProviderService (via the `vscode`
 * module stub) with a mocked global fetch — no network, no real key.
 *
 * Covered: valid completion, malformed bodies, provider error envelopes
 * delivered with HTTP 200, reasoning-only responses, empty content,
 * non-JSON bodies, auth rejection without retries, and the exact probe
 * request shape (model, bounded max_tokens, ping prompt, non-streaming).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderService } from "../apps/vscode-extension/src/provider-service";
import { inMemorySecrets, inMemoryState, context } from "./vscode-stub";

const FAKE_KEY = "sk-openai-test-key-not-real";

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

async function withKey(svc: ProviderService): Promise<void> {
  await svc.setCredential("openai-native", FAKE_KEY);
}

beforeEach(() => {
  inMemoryState.clear();
  inMemorySecrets.clear();
  vi.unstubAllGlobals();
});

describe("testInference response-shape validation", () => {
  it("reports success for a valid chat completion", async () => {
    const svc = makeService();
    await withKey(svc);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          choices: [{ message: { role: "assistant", content: "pong" } }],
        }),
      ) as unknown as typeof fetch,
    );
    const result = await svc.testInference("openai-native", "gpt-4o-mini");
    expect(result.state).toBe("success");
    expect(result.modelId).toBe("gpt-4o-mini");
    expect(result.message).toContain("Model response received");
  });

  it("sends a bounded non-streaming probe (model, max_tokens, ping)", async () => {
    const svc = makeService();
    await withKey(svc);
    const fetchMock = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "pong" } }] }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    await svc.testInference("openai-native", "gpt-4o-mini");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    expect(String(url)).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    // Presence only — the credential value is never inspected or printed.
    expect(headers["Authorization"] !== undefined).toBe(true);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body["model"]).toBe("gpt-4o-mini");
    expect(body["messages"]).toEqual([{ role: "user", content: "ping" }]);
    expect(typeof body["max_tokens"]).toBe("number");
    expect((body["max_tokens"] as number) <= 64).toBe(true);
    expect("stream" in body).toBe(false);
  });

  it("surfaces a provider error envelope delivered with HTTP 200", async () => {
    const svc = makeService();
    await withKey(svc);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: { message: "No endpoints found", code: 404 } }),
      ) as unknown as typeof fetch,
    );
    const result = await svc.testInference("openai-native", "some/model");
    expect(result.state).toBe("failed");
    expect(result.message).toContain("Provider error:");
    expect(result.message).toContain("No endpoints found");
    // Success is never reported for an error envelope.
    expect(result.state).not.toBe("success");
  });

  it("rejects a 200 body with no completion choices", async () => {
    const svc = makeService();
    await withKey(svc);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ id: "x", object: "chat.completion" })),
    );
    const result = await svc.testInference("openai-native", "some/model");
    expect(result.state).toBe("failed");
    expect(result.message).toContain("no completion choices");
  });

  it("rejects an empty choices array", async () => {
    const svc = makeService();
    await withKey(svc);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ choices: [] })),
    );
    const result = await svc.testInference("openai-native", "some/model");
    expect(result.state).toBe("failed");
  });

  it("rejects a reasoning-only response without message content", async () => {
    const svc = makeService();
    await withKey(svc);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          choices: [
            { message: { role: "assistant", reasoning_content: "let me think" } },
          ],
        }),
      ) as unknown as typeof fetch,
    );
    const result = await svc.testInference("openai-native", "some/model");
    expect(result.state).toBe("failed");
    expect(result.message).toContain("reasoning");
  });

  it("rejects empty content instead of claiming success", async () => {
    const svc = makeService();
    await withKey(svc);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ choices: [{ message: { content: "   " } }] }),
      ) as unknown as typeof fetch,
    );
    const result = await svc.testInference("openai-native", "some/model");
    expect(result.state).toBe("failed");
    expect(result.message).toContain("empty content");
  });

  it("rejects a non-JSON 200 body distinctly", async () => {
    const svc = makeService();
    await withKey(svc);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("<html>ok</html>", { status: 200 }),
      ) as unknown as typeof fetch,
    );
    const result = await svc.testInference("openai-native", "some/model");
    expect(result.state).toBe("failed");
    expect(result.message).toContain("non-JSON");
  });

  it("reports auth failure from HTTP 401 with a single attempt (no retries)", async () => {
    const svc = makeService();
    await withKey(svc);
    const fetchMock = vi.fn(async () => jsonResponse({ error: "bad key" }, 401));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const result = await svc.testInference("openai-native", "some/model");
    expect(result.state).toBe("auth-failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts the legacy content-array shape with real text", async () => {
    const svc = makeService();
    await withKey(svc);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ content: [{ text: "pong" }] })),
    );
    const result = await svc.testInference("openai-native", "some/model");
    expect(result.state).toBe("success");
  });

  it("aborts promptly on cancellation without retries", async () => {
    const svc = makeService();
    await withKey(svc);
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      await new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
      throw new Error("unreachable");
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const controller = new AbortController();
    const pending = svc.testInference("openai-native", "some/model", {
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    controller.abort();
    const result = await pending;
    expect(result.state).toBe("failed");
    expect(result.message).toMatch(/cancel/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("times out a hanging endpoint within the probe budget", async () => {
    const svc = makeService();
    await withKey(svc);
    // Like a real transport, the stub rejects when the probe signal aborts.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_, reject) => {
            if (init?.signal?.aborted) {
              reject(new DOMException("The operation was aborted.", "AbortError"));
              return;
            }
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted.", "TimeoutError")),
            );
          }),
      ) as unknown as typeof fetch,
    );
    const result = await svc.testInference("openai-native", "some/model", {
      timeoutMs: 30,
    });
    expect(result.state).toBe("failed");
    expect(result.message).toMatch(/time|cancel/i);
  });

  it("requires a stored credential before probing cloud providers", async () => {
    const svc = makeService();
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [] }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const result = await svc.testInference("openai-native", "some/model");
    expect(result.state).toBe("auth-failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows Ollama inference without an API key", async () => {
    const svc = makeService();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "pong from ollama" } }] }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const result = await svc.testInference("ollama", "llama3");
    expect(result.state).toBe("success");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects removed provider IDs with secret-safe failure and zero network", async () => {
    const svc = makeService();
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [] }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const result = await svc.testInference("openrouter", "anthropic/claude-3-opus");
    expect(result.state).toBe("failed");
    expect(result.message).toMatch(/unsupported provider/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
