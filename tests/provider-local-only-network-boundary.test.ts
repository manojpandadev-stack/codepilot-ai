/**
 * Local Only — the provider-service NETWORK BOUNDARY.
 *
 * "Local Only" promises that no request leaves the machine. This suite proves
 * that promise for EVERY outbound provider-service path, using an injected
 * fetch seam so nothing is really sent:
 *
 *   - connection / health probe          → testConnection
 *   - usage + billing / credit check     → getUsage
 *   - inference test                     → testInference
 *   - model discovery                    → covered by provider-discovery-local-only
 *
 * Every blocked case asserts ZERO fetch calls, because "blocked" that still
 * touches the network is not blocked.
 *
 * The subtle one is REDIRECTS. The privacy gate validates the CONFIGURED
 * endpoint, but a loopback endpoint may answer `302 Location: https://…` and a
 * default fetch follows it — so a Local Only run would leave the machine via a
 * URL the policy never inspected. The fake fetch below models real fetch
 * semantics (follow unless `redirect: "manual"`) and records every hop, so a
 * regression to redirect-following is caught, not mocked away.
 *
 * No credentials are printed: assertions inspect presence/shape only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderService } from "../apps/vscode-extension/src/provider-service";
import { inMemorySecrets, inMemoryState, context } from "./vscode-stub";

const REMOTE = "https://remote.example.com";
const FAKE_KEY = "sk-local-only-boundary-not-real";

/** Every URL the fetch seam was asked for, in order. */
let hops: string[] = [];

/**
 * A fetch seam with faithful redirect semantics.
 *
 * `redirect: "manual"` → returns the 3xx untouched (what the policy requires).
 * anything else       → follows the Location the way a real fetch does, so a
 *                      regression that drops the option really does escape.
 */
function fakeFetch(bodyFor: (url: string) => Response) {
  const impl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    hops.push(url);
    if (url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1")) {
      if (url.includes("/redirect")) {
        const manual = init?.redirect === "manual";
        const res = new Response(null, {
          status: 302,
          headers: { Location: `${REMOTE}/credits-escaped` },
        });
        if (manual) return res;
        return impl(`${REMOTE}/credits-escaped`, init);
      }
      return bodyFor(url);
    }
    return bodyFor(url);
  };
  vi.stubGlobal("fetch", impl as unknown as typeof fetch);
  return impl as unknown as typeof fetch;
}

function tagsResponse(): Response {
  return new Response(JSON.stringify({ models: [{ name: "qwen3:8b" }] }), {
    status: 200,
  });
}

function creditsResponse(): Response {
  return new Response(JSON.stringify({ data: { total_credits: 10, total_usage: 2 } }), {
    status: 200,
  });
}

function bodyFor(url: string): Response {
  if (url.includes("/credits")) return creditsResponse();
  if (url.includes("/chat/completions")) {
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "pong" } }] }),
      { status: 200 },
    );
  }
  return tagsResponse();
}

/** ProviderService wired to an EXPLICIT, mutable privacy mode. */
function makeService(getMode: () => "local" | "hybrid" | "cloud"): ProviderService {
  return new ProviderService(
    context as unknown as ConstructorParameters<typeof ProviderService>[0],
    getMode,
  );
}

function localService(): ProviderService {
  return makeService(() => "local");
}

beforeEach(() => {
  hops = [];
  inMemoryState.clear();
  inMemorySecrets.clear();
  vi.unstubAllGlobals();
});

// ===========================================================================
// 1. Valid LOCAL endpoints stay usable under Local Only.
// ===========================================================================
describe("Local Only keeps valid loopback providers usable", () => {
  it("probes a local Ollama endpoint (one loopback request, no block)", async () => {
    const svc = localService();
    svc.setConfig("ollama", { baseUrl: "http://localhost:11434" });
    fakeFetch(bodyFor);

    const result = await svc.testConnection("ollama");

    expect(result.state).toBe("connected");
    expect(hops).toEqual(["http://localhost:11434/api/tags"]);
  });

  it("probes a local Ollama IPv4 loopback endpoint without blocking", async () => {
    const svc = localService();
    svc.setConfig("ollama", { baseUrl: "http://127.0.0.1:11434" });
    fakeFetch(bodyFor);

    const result = await svc.testConnection("ollama");

    expect(result.state).toBe("connected");
    expect(hops.every((u) => u.startsWith("http://127.0.0.1:11434"))).toBe(true);
    expect(hops.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 2. REMOTE endpoints must be blocked with ZERO outbound requests —
//    including a LOCAL provider id pointed at a remote base URL.
// ===========================================================================
describe("Local Only blocks remote destinations with zero network", () => {
  it("blocks a remote Ollama-compatible endpoint (local id, remote URL)", async () => {
    const svc = localService();
    svc.setConfig("ollama", { baseUrl: REMOTE });
    fakeFetch(bodyFor);

    const result = await svc.testConnection("ollama");

    expect(hops).toEqual([]);
    expect(result.message).toMatch(/Local Only|no request was made/i);
  });

  it("blocks a remote cloud provider connection test (openai-native)", async () => {
    const svc = localService();
    await svc.setCredential("openai-native", FAKE_KEY);
    fakeFetch(bodyFor);

    const result = await svc.testConnection("openai-native");

    expect(hops).toEqual([]);
    // The POLICY must be the reported reason — not a misleading
    // "configure a base URL" that would still be blocked afterwards.
    expect(result.message).toMatch(/Local Only|no request was made/i);
  });

  it("blocks a remote cloud provider connection test (gemini)", async () => {
    const svc = localService();
    await svc.setCredential("gemini", FAKE_KEY);
    fakeFetch(bodyFor);

    const result = await svc.testConnection("gemini");

    expect(hops).toEqual([]);
    expect(result.message).toMatch(/Local Only|no request was made/i);
  });

  it("fails closed on removed providers with zero network requests", async () => {
    const svc = localService();
    fakeFetch(bodyFor);

    const removedIds = ["openrouter", "anthropic", "lmstudio", "groq", "deepseek"];
    for (const id of removedIds) {
      const result = await svc.testConnection(id);
      expect(hops).toEqual([]);
      expect(result.state).toBe("invalid-config");
      expect(result.message).toMatch(/unsupported provider/i);
    }
  });

  it("blocks a remote usage check for supported cloud provider", async () => {
    const svc = localService();
    await svc.setCredential("openai-native", FAKE_KEY);
    fakeFetch(bodyFor);

    const usage = await svc.getUsage("openai-native");

    expect(hops).toEqual([]);
    expect(usage.error ?? "").toMatch(/Local Only|no request was made/i);
    expect(usage.usage).toBeUndefined();
  });

  it("blocks a remote inference test for supported cloud provider", async () => {
    const svc = localService();
    await svc.setCredential("openai-native", FAKE_KEY);
    fakeFetch(bodyFor);

    const result = await svc.testInference("openai-native", "gpt-4o-mini");

    expect(hops).toEqual([]);
    expect(result.state).toBe("blocked");
    expect(result.message).toMatch(/Local Only|no request was made/i);
  });

  it("treats an unknown provider id with a custom base URL as unsupported and fails closed", async () => {
    const svc = localService();
    fakeFetch(bodyFor);

    const result = await svc.testConnection("totally-unknown-provider");

    expect(hops).toEqual([]);
    expect(["invalid-config", "no-endpoint"]).toContain(result.state);
  });
});

// ===========================================================================
// 3. REDIRECTS must not smuggle a request off the machine.
// ===========================================================================
describe("Local Only does not follow an off-box redirect", () => {
  it("never follows a loopback 302 to a remote host (connection test)", async () => {
    const svc = localService();
    svc.setConfig("ollama", { baseUrl: "http://localhost:11434" });
    fakeFetch(bodyFor);
    // Force the probe to hit a path that answers with a redirect.
    vi.spyOn(svc, "effectiveBaseUrl").mockReturnValue(
      "http://localhost:11434/redirect",
    );

    const result = await svc.testConnection("ollama");

    expect(hops.every((u) => u.startsWith("http://localhost"))).toBe(true);
    expect(hops).not.toContain(`${REMOTE}/api/tags`);
    expect(result.state).not.toBe("connected");
  });
});

// ===========================================================================
// 4. The gate reads the CURRENT mode on an already-created service.
// ===========================================================================
describe("privacy mode changes apply to a live provider service", () => {
  it("blocks while local, and performs the request immediately after opting in", async () => {
    let mode: "local" | "hybrid" | "cloud" = "local";
    const svc = makeService(() => mode);
    await svc.setCredential("openai-native", FAKE_KEY);
    fakeFetch(bodyFor);

    const blocked = await svc.testConnection("openai-native");
    expect(blocked.message).toMatch(/Local Only|no request was made/i);
    expect(hops).toEqual([]);

    // Same instance, no reconstruction.
    mode = "cloud";
    const allowed = await svc.testConnection("openai-native");
    expect(allowed.state).toBe("connected");
    expect(hops.length).toBe(1);
    expect(hops[0]).toMatch(/^https:\/\/api\.openai\.com/);
  });
});

// ===========================================================================
// 5. Distinct, honest outcomes — and no secret ever leaks.
// ===========================================================================
describe("blocked and unauthenticated are different outcomes", () => {
  it("reports a missing key as auth-required, not as a privacy block", async () => {
    // A provider whose probe genuinely needs a credential. Gate OFF, so the
    // honest verdict is the missing key — a different outcome with different
    // user guidance, and still zero network.
    const svc = makeService(() => "cloud");
    fakeFetch(bodyFor);

    const result = await svc.testConnection("openai-native");

    expect(hops).toEqual([]);
    expect(result.state).toBe("auth-required");
    expect(result.message).not.toMatch(/Local Only/i);
  });

  it("reports a privacy block for the same call under Local Only", async () => {
    const svc = localService();
    fakeFetch(bodyFor);

    const result = await svc.testConnection("openai-native");

    expect(hops).toEqual([]);
    expect(result.message).toMatch(/Local Only|no request was made/i);
    expect(result.state).not.toBe("auth-required");
  });

  it("keeps the credential out of every blocked result", async () => {
    const svc = localService();
    await svc.setCredential("openai-native", FAKE_KEY);
    fakeFetch(bodyFor);

    const results = [
      await svc.testConnection("openai-native"),
      await svc.testInference("openai-native", "gpt-4o-mini"),
      await svc.getUsage("openai-native"),
    ];
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain(FAKE_KEY);
    expect(serialized).not.toMatch(/Bearer /i);
  });

  it("does not persist the credential into non-secret config", async () => {
    const svc = localService();
    await svc.setCredential("openai-native", FAKE_KEY);
    svc.setConfig("openai-native", {
      baseUrl: REMOTE,
      fields: { apiKey: FAKE_KEY, region: "eu" },
    });

    const stored = JSON.stringify(svc.getConfig("openai-native"));
    expect(stored).not.toContain(FAKE_KEY);
    expect(stored).toContain("eu");
  });
});