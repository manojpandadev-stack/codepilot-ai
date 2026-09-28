/**
 * BUG 1 — Provider connection truth regression tests.
 *
 * Root cause: ProviderService.listConnectionStates() treated
 * "cloud provider + API key present" as connected=true. An unreachable
 * endpoint, a rejected key (401) or a rate limit all displayed "Connected".
 *
 * Contract under test ("API key exists" ≠ "provider connected"):
 *   - only a positive host-side probe produces state "connected"
 *   - credential presence alone maps to "configured" (cloud list) — the
 *     live verdict for the SELECTED provider comes from connectionState(),
 *     which ALWAYS probes
 *   - a stale verdict from one provider can never leak into another
 *
 * Uses the REAL ProviderService (vscode stub) with mocked global fetch —
 * no network access in tests, no fabricated states.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProviderService,
  type ConnectionStateEntry,
} from "../apps/vscode-extension/src/provider-service";
import { inMemorySecrets, inMemoryState, context } from "./vscode-stub";
import {
  connectionSummary,
  normalizeProviderList,
} from "../apps/webview/src/lib/messages.js";

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

describe("CONNECTION — cloud configured ≠ connected (BUG 1 root cause)", () => {
  it("1. valid cloud endpoint + valid key → connectionState() reports connected", async () => {
    const svc = makeService();
    svc.setConfig("openai-compatible", {
      baseUrl: "https://api.example.com/v1",
    });
    inMemorySecrets.set("codepilot.apiKey.openai-compatible", "good-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [{ id: "gpt" }] })) as unknown as typeof fetch,
    );
    const entry = await svc.connectionState("openai-compatible");
    expect(entry.state).toBe("connected");
    expect(entry.connected).toBe(true);
  });

  it("2. invalid API key → auth-invalid (never connected)", async () => {
    const svc = makeService();
    svc.setConfig("openai-compatible", {
      baseUrl: "https://api.example.com/v1",
    });
    inMemorySecrets.set("codepilot.apiKey.openai-compatible", "bad-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "invalid" }, 401)) as unknown as typeof fetch,
    );
    const entry = await svc.connectionState("openai-compatible");
    expect(entry.state).toBe("auth-invalid");
    expect(entry.connected).toBe(false);
  });

  it("3. unreachable endpoint → unavailable (never connected)", async () => {
    const svc = makeService();
    svc.setConfig("openai-compatible", {
      baseUrl: "https://api.example.com/v1",
    });
    inMemorySecrets.set("codepilot.apiKey.openai-compatible", "any-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    );
    const entry = await svc.connectionState("openai-compatible");
    expect(entry.state).toBe("unavailable");
    expect(entry.connected).toBe(false);
  });

  it("4. valid credential, no successful probe → configured/unverified (never connected)", async () => {
    const svc = makeService();
    inMemorySecrets.set("codepilot.apiKey.openrouter", "present-but-unprobed");
    // List path: static, no network.
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const states = await svc.listConnectionStates();
    const openrouter = states.find((s) => s.id === "openrouter");
    expect(openrouter?.state).toBe("configured");
    expect(openrouter?.connected).toBe(false);
    // No CLOUD endpoint was probed on the list path (local probes allowed).
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => !u.includes("localhost"))).toEqual([]);

    // Selected-provider path: probe runs, endpoint down → still not connected.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    );
    const probed = await svc.connectionState("openrouter");
    expect(probed.connected).toBe(false);
    expect(["configured", "unavailable", "unverified"]).toContain(probed.state);
  });

  it("5. local Ollama down → unavailable; 6. up → connected", async () => {
    const svc = makeService();
    svc.setConfig("ollama", { baseUrl: "http://localhost:11434" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("connect ECONNREFUSED 127.0.0.1:11434");
      }) as unknown as typeof fetch,
    );
    const down = await svc.connectionState("ollama");
    expect(down.state).toBe("unavailable");
    expect(down.connected).toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ models: [{ name: "qwen3:8b" }] }),
      ) as unknown as typeof fetch,
    );
    const up = await svc.connectionState("ollama");
    expect(up.state).toBe("connected");
    expect(up.connected).toBe(true);
  });
});

describe("CONNECTION — selection isolation and staleness (BUG 1)", () => {
  it("7+8. provider switch isolation: each provider's verdict is its own; selected state is fresh-probed", async () => {
    const svc = makeService();
    svc.setConfig("ollama", { baseUrl: "http://localhost:11434" });
    svc.setConfig("lmstudio", { baseUrl: "http://localhost:1234/v1" });
    // Ollama up, LM Studio down: verdicts must never cross, regardless of
    // which provider is "selected" (the service takes no selection input).
    const fetchMock = vi.fn<typeof fetch>(
      async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/api/tags")) {
          return jsonResponse({ models: [{ name: "qwen3:8b" }] });
        }
        throw new TypeError("connect ECONNREFUSED 127.0.0.1:1234");
      },
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const states = await svc.listConnectionStates();
    const byId = new Map(states.map((s) => [s.id, s]));
    expect(byId.get("ollama")?.state).toBe("connected");
    expect(byId.get("lmstudio")?.state).toBe("unavailable");

    // The selected-provider verdict is derived ONLY from that provider's own
    // probe — never borrowed from another entry.
    const lmSelected = await svc.connectionState("lmstudio");
    expect(lmSelected.id).toBe("lmstudio");
    expect(lmSelected.state).toBe("unavailable");
  });

  it("9. stale health never leaks: header derivation prefers the fresh selected verdict and maps typed states honestly", () => {
    // The header consumes provider/list entries via connectionSummary.
    // Typed state "connected" → Connected; anything else must never render
    // as connected.
    const fresh: ConnectionStateEntry = {
      id: "ollama",
      name: "Ollama",
      state: "connected",
      connected: true,
    };
    const staleDown = normalizeProviderList([
      { id: "ollama", name: "Ollama", state: "unavailable" as const },
    ]);
    expect(staleDown[0]?.connected).toBe(false);

    const summary = connectionSummary({
      selectedProviderId: "ollama",
      catalog: { id: "ollama", displayName: "Ollama", category: "local" } as never,
      modelCount: 2,
      liveConnections: staleDown,
      // Fresh verdict wins over any stale entry:
      selectedState: { ...fresh },
    });
    expect(summary.connected).toBe(true);
    expect(summary.label).toMatch(/Connected/);

    // Without a fresh verdict, the typed unavailable state must show down
    // even if an OLD entry claimed connected=true (legacy shape).
    const legacyStale = connectionSummary({
      selectedProviderId: "ollama",
      catalog: { id: "ollama", displayName: "Ollama", category: "local" } as never,
      modelCount: 2,
      liveConnections: [{ id: "ollama", name: "Ollama", connected: true }],
      selectedState: { id: "ollama", name: "Ollama", state: "unavailable", connected: false },
    });
    expect(legacyStale.connected).toBe(false);
  });

  it("10+11. provider stops after connected → unavailable; restarts → connected after a fresh probe", async () => {
    const svc = makeService();
    svc.setConfig("ollama", { baseUrl: "http://localhost:11434" });
    let up = true;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      if (!up) throw new TypeError("connect ECONNREFUSED 127.0.0.1:11434");
      return jsonResponse({ models: [{ name: "qwen3:8b" }] });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    // Connected while up…
    const first = await svc.connectionState("ollama");
    expect(first.state).toBe("connected");

    // …STOPPED (no reload, no reconfigure): the next probe reports down.
    up = false;
    const stopped = await svc.connectionState("ollama");
    expect(stopped.state).toBe("unavailable");
    expect(stopped.connected).toBe(false);

    // …RESTARTED: the next probe reports connected again (fresh truth, not a
    // cached verdict).
    up = true;
    const restarted = await svc.connectionState("ollama");
    expect(restarted.state).toBe("connected");
    expect(restarted.connected).toBe(true);
    // Each verdict came from its own real probe (no caching in the service).
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe("CONNECTION — rate-limited and error-shape honesty", () => {
  it("rate-limited probe (429) → rate-limited state, never connected", async () => {
    const svc = makeService();
    svc.setConfig("openai-compatible", {
      baseUrl: "https://api.example.com/v1",
    });
    inMemorySecrets.set("codepilot.apiKey.openai-compatible", "key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "slow down" }, 429)) as unknown as typeof fetch,
    );
    const entry = await svc.connectionState("openai-compatible");
    expect(entry.state).toBe("rate-limited");
    expect(entry.connected).toBe(false);
  });
});
