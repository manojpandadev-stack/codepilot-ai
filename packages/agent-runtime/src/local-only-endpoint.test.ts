/**
 * Phase 1 — Local Only must be decided by the EFFECTIVE DESTINATION.
 *
 * Invariant: in privacy mode "local", no model request, health probe, model
 * discovery, or web tool may reach anything other than this machine. A local
 * provider ID pointed at a remote endpoint is still remote, and an unknown or
 * unparsable endpoint fails closed.
 *
 * All tests are hermetic: a global fetch trap proves zero outbound requests.
 * No network, no model, no real credentials.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodePilotAgent } from "./agent.js";
import { createCodePilotBuiltinTools } from "./builtin-tools.js";
import { buildChildAgentConfig } from "./orchestrator.js";
import { isLoopbackEndpoint, isRemoteProvider } from "./runtime.js";
import { assertSummarizerPrivacyAllowed } from "./compaction-summarizer.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Fails loudly if ANY request is attempted — proves "zero outbound calls". */
function trapFetch(): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (async (input: unknown) => {
    calls.push(
      String(typeof input === "string" ? input : (input as Request).url),
    );
    throw new Error(
      "network trap tripped — Local Only made an outbound request",
    );
  }) as unknown as typeof fetch);
  return { calls };
}

/** A local Ollama-shaped loopback response (for "allowed" paths). */
function localOllamaFetch(calls: string[]): void {
  vi.stubGlobal("fetch", (async (input: unknown) => {
    calls.push(
      String(typeof input === "string" ? input : (input as Request).url),
    );
    return new Response(
      `${JSON.stringify({ message: { role: "assistant", content: "local ok" }, done: true })}\n`,
      { status: 200 },
    );
  }) as unknown as typeof fetch);
}

function agentConfig(
  providerId: string,
  privacyMode: "local" | "cloud",
  baseUrl?: string,
): ConstructorParameters<typeof CodePilotAgent>[0] {
  return {
    providerId,
    modelId: "test-model",
    apiKey: "test-key-not-real",
    workspaceRoot: process.cwd(),
    privacyMode,
    agentMode: "act",
    maxIterations: 2,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };
}

describe("Phase 1 · isLoopbackEndpoint classifies the effective destination", () => {
  it("accepts loopback IPv4, IPv6, localhost, and reserved *.localhost", () => {
    for (const url of [
      "http://localhost:11434",
      "http://127.0.0.1:11434",
      "https://127.0.0.1:443/v1",
      "http://127.5.6.7:8080",
      "http://[::1]:1234",
      "http://LOCALHOST:11434",
      "http://localhost.:11434",
      "http://foo.localhost:11434",
      "http://localhost.localdomain:1234",
    ]) {
      expect(isLoopbackEndpoint(url), url).toBe(true);
    }
  });

  it("rejects remote, LAN, ambiguous, and unparsable destinations (fail-closed)", () => {
    for (const url of [
      "http://ollama.example.com:11434",
      "https://api.openai.com/v1",
      "http://192.168.1.50:11434",
      "http://10.0.0.5:11434",
      "http://172.16.0.1:11434",
      "http://169.254.169.254/latest/meta-data/",
      "http://[2001:db8::1]:11434",
      "http://user:pass@localhost:11434",
      "file:///etc/passwd",
      "ws://localhost:11434",
      "not-a-url",
      "",
      undefined,
      null,
    ]) {
      expect(
        isLoopbackEndpoint(url as string | undefined | null),
        String(url),
      ).toBe(false);
    }
  });

  it("a public name resolving to loopback is still remote (no DNS trust)", () => {
    // "localhost.attacker.example" is NOT localhost even if a resolver answers
    // 127.0.0.1 — the guard never performs DNS, so it cannot be rebound.
    expect(isLoopbackEndpoint("http://localhost.attacker.example:11434")).toBe(
      false,
    );
  });
});

describe("Phase 1 · isRemoteProvider judges by destination, not by provider ID", () => {
  it("local provider id + loopback baseUrl ⇒ local", () => {
    expect(isRemoteProvider("ollama", "http://localhost:11434")).toBe(false);
    expect(isRemoteProvider("lmstudio", "http://127.0.0.1:1234/v1")).toBe(
      false,
    );
  });

  it("local provider id + remote baseUrl ⇒ REMOTE (the bypass)", () => {
    expect(isRemoteProvider("ollama", "http://ollama.example.com:11434")).toBe(
      true,
    );
    expect(
      isRemoteProvider("lmstudio", "https://lmstudio.example.com/v1"),
    ).toBe(true);
    expect(isRemoteProvider("ollama", "http://192.168.1.50:11434")).toBe(true);
  });

  it("remote provider id stays remote when there is no baseUrl", () => {
    expect(isRemoteProvider("openrouter")).toBe(true);
    expect(isRemoteProvider("some-unknown-provider")).toBe(true);
  });

  it("a loopback baseUrl is local even for a cloud id (local proxy keeps data local)", () => {
    // Locality is a property of the DESTINATION: a gateway/proxy running on
    // this machine never sends the payload off-box, so Local Only permits it.
    // The same id with its default cloud endpoint stays blocked.
    expect(isRemoteProvider("openrouter", "http://localhost:4000")).toBe(false);
    expect(isRemoteProvider("openrouter", "https://openrouter.ai/api/v1")).toBe(
      true,
    );
  });

  it("local provider id with no baseUrl keeps the id-based default", () => {
    expect(isRemoteProvider("ollama")).toBe(false);
    // Removed providers without an explicit loopback baseUrl are remote by default
    expect(isRemoteProvider("lmstudio")).toBe(true);
  });
});

describe("Phase 1 · single agent rejects remote endpoints in Local Only (0 requests)", () => {
  const remoteEndpoints = [
    "http://ollama.example.com:11434",
    "https://lmstudio.example.com/v1",
    "http://192.168.1.50:11434",
    "not-a-url",
  ];

  for (const baseUrl of remoteEndpoints) {
    it(`initialize() rejects ollama @ ${baseUrl}`, async () => {
      const trap = trapFetch();
      const agent = new CodePilotAgent(agentConfig("ollama", "local", baseUrl));
      await expect(agent.initialize()).rejects.toThrow(/privacy/i);
      expect(trap.calls).toHaveLength(0);
      await agent.dispose?.();
    });

    it(`run() still rejects after a CAUGHT initialize error @ ${baseUrl}`, async () => {
      const trap = trapFetch();
      const agent = new CodePilotAgent(agentConfig("ollama", "local", baseUrl));
      await agent.initialize().catch(() => undefined);
      await expect(agent.run("hi")).rejects.toThrow(/privacy/i);
      expect(trap.calls).toHaveLength(0);
      await agent.dispose?.();
    });
  }

  it("loopback ollama is allowed and does reach the endpoint", async () => {
    const calls: string[] = [];
    localOllamaFetch(calls);
    const agent = new CodePilotAgent(
      agentConfig("ollama", "local", "http://localhost:11434"),
    );
    await agent.initialize();
    await expect(agent.run("hi")).resolves.toMatchObject({
      reason: "complete",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("localhost:11434");
    await agent.dispose?.();
  });

  it("cloud mode + remote endpoint is still allowed (privacy is the user's call)", async () => {
    const trap = trapFetch();
    const agent = new CodePilotAgent(
      agentConfig("ollama", "cloud", "http://ollama.example.com:11434"),
    );
    await agent.initialize();
    await agent.dispose?.();
    // Only proves initialization is not blocked by the privacy guard.
    expect(trap.calls).toHaveLength(0);
  });
});

describe("Phase 1 · child agents and summarizer inherit the endpoint policy", () => {
  it("multi-agent orchestrator rejects a remote endpoint in Local Only (0 requests)", async () => {
    const trap = trapFetch();
    // Child agents inherit provider + baseUrl + privacy from the base config,
    // so the child's own initialize() must refuse before any request.
    const child = buildChildAgentConfig(
      {
        providerId: "ollama",
        modelId: "test-model",
        apiKey: "test-key-not-real",
        baseUrl: "http://ollama.example.com:11434",
        workspaceRoot: process.cwd(),
        privacyMode: "local",
        maxIterations: 2,
      },
      "coder",
      "act",
    );
    expect(child.baseUrl).toBe("http://ollama.example.com:11434");
    const agent = new CodePilotAgent(child);
    await expect(agent.initialize()).rejects.toThrow(/privacy/i);
    await expect(agent.run("fix the login test")).rejects.toThrow(/privacy/i);
    expect(trap.calls).toHaveLength(0);
    await agent.dispose?.();
  });

  it("multi-agent orchestrator child allows a loopback endpoint in Local Only", async () => {
    const calls: string[] = [];
    localOllamaFetch(calls);
    const child = buildChildAgentConfig(
      {
        providerId: "ollama",
        modelId: "test-model",
        workspaceRoot: process.cwd(),
        privacyMode: "local",
        baseUrl: "http://localhost:11434",
        maxIterations: 2,
      },
      "coder",
      "act",
    );
    const agent = new CodePilotAgent(child);
    await agent.initialize();
    await expect(agent.run("hi")).resolves.toMatchObject({
      reason: "complete",
    });
    expect(calls.some((u) => u.includes("localhost:11434"))).toBe(true);
    await agent.dispose?.();
  });

  it("summarizer rejects a local provider id pointed at a remote endpoint", () => {
    expect(() =>
      assertSummarizerPrivacyAllowed(
        "ollama",
        "local",
        "http://ollama.example.com:11434",
      ),
    ).toThrow();
    expect(() =>
      assertSummarizerPrivacyAllowed(
        "ollama",
        "local",
        "http://localhost:11434",
      ),
    ).not.toThrow();
  });
});

describe("Phase 1 · web tools remain suppressed in Local Only", () => {
  it("no network tool is exposed for a local provider id, even with web enabled", () => {
    const tools = createCodePilotBuiltinTools({
      cwd: process.cwd(),
      enableWebFetch: true,
      privacyMode: "local",
      baseUrl: undefined,
    } as Parameters<typeof createCodePilotBuiltinTools>[0]);
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("fetch_web_content");
    expect(names).not.toContain("web_search");
  });
});
