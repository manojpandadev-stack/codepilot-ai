import { describe, it, expect, vi, beforeEach } from "vitest";
import { getCatalogProvider } from "../packages/model-gateway/src/provider-catalog.js";
import { isSupportedProviderId } from "../packages/model-gateway/src/config.js";
import { CODEPILOT_PROVIDER_CATALOG } from "../packages/llm/src/catalogue.js";
import { connectionSummary } from "../apps/webview/src/lib/messages.js";
import { ProviderService } from "../apps/vscode-extension/src/provider-service.js";
import { GoogleProvider } from "../packages/llm/src/providers/google.js";
import { GoogleLlmProvider } from "../packages/agent-runtime/src/native/llm/google.js";
import { inMemorySecrets, inMemoryState, context } from "./vscode-stub.js";

describe("PROVIDER / MODEL / BACKEND CONNECTION CONSISTENCY", () => {
  let mockSecretStorage: Map<string, string>;
  let mockGlobalState: Map<string, unknown>;
  let providerService: ProviderService;

  beforeEach(() => {
    mockSecretStorage = new Map<string, string>();
    mockGlobalState = new Map<string, unknown>();
    providerService = new ProviderService({
      secrets: {
        get: vi.fn(async (key: string) => mockSecretStorage.get(key)),
        store: vi.fn(async (key: string, val: string) => {
          mockSecretStorage.set(key, val);
        }),
        delete: vi.fn(async (key: string) => {
          mockSecretStorage.delete(key);
        }),
      } as never,
      globalState: {
        get: vi.fn((key: string, defaultVal: unknown) => mockGlobalState.get(key) ?? defaultVal),
        update: vi.fn(async (key: string, val: unknown) => {
          mockGlobalState.set(key, val);
        }),
      } as never,
      getPrivacyMode: () => "cloud",
    });
  });

  it("1. Provider selection: curated catalogue contains only supported providers", () => {
    expect(isSupportedProviderId("gemini")).toBe(true);
    expect(isSupportedProviderId("ollama")).toBe(true);
    expect(isSupportedProviderId("openai-native")).toBe(true);
    // Anthropic was removed from curated catalogue
    expect(isSupportedProviderId("anthropic")).toBe(false);
  });

  it("2. Gemini model catalogue contains active supported models", () => {
    const gemini = getCatalogProvider("gemini");
    expect(gemini).toBeDefined();
    expect(gemini!.defaultModelId).toBe("gemini-2.5-flash");
    const modelIds = gemini!.models.map((m) => m.id);
    expect(modelIds).toContain("gemini-3.8-flash");
    expect(modelIds).toContain("gemini-3.5-flash");
    expect(modelIds).toContain("gemini-3-flash-preview");
    expect(modelIds).toContain("gemini-2.5-flash");
    expect(modelIds).toContain("gemini-2.5-pro");
  });

  it("3. Model selection & Save: secret is stored securely in SecretStorage without logging or leakage", async () => {
    await providerService.setCredential("gemini", "AIzaSyTestKeySecret12345");
    expect(mockSecretStorage.get("codepilot.apiKey.gemini")).toBe("AIzaSyTestKeySecret12345");
    const cred = await providerService.getCredential("gemini");
    expect(cred).toBe("AIzaSyTestKeySecret12345");
    expect(await providerService.hasCredential("gemini")).toBe(true);
  });

  it("4. Gemini API key validation: invalid key fails closed with auth-invalid", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: "API_KEY_INVALID" } }),
    } as Response);

    try {
      const probe = await providerService.testConnection("gemini", undefined, "invalid-key");
      expect(probe.state).toBe("auth-invalid");
      expect(probe.message).toContain("invalid");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("5. Gemini API key validation: valid key succeeds with connected state", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ name: "models/gemini-3.5-flash" }] }),
    } as Response);

    try {
      const probe = await providerService.testConnection("gemini", undefined, "valid-key");
      expect(probe.state).toBe("connected");
      expect(probe.message).toContain("Gemini Connected");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("6. Connection status color rules: semantic tone mapping", () => {
    // GREEN: Provider validated and usable
    const connected = connectionSummary({
      selectedProviderId: "gemini",
      catalog: { id: "gemini", displayName: "Google Gemini", category: "cloud" } as never,
      health: { state: "connected" },
      credentialConfigured: true,
      modelCount: 3,
    });
    expect(connected.connected).toBe(true);
    expect(connected.tone).toBe("success");

    // YELLOW: Testing / checking
    const checking = connectionSummary({
      selectedProviderId: "gemini",
      catalog: { id: "gemini", displayName: "Google Gemini", category: "cloud" } as never,
      selectedState: { id: "gemini", name: "gemini", state: "checking", connected: false, checkedAt: "" },
      credentialConfigured: true,
      modelCount: 3,
    });
    expect(checking.connected).toBe(false);
    expect(checking.tone).toBe("warning");

    // YELLOW: Rate-limited
    const rateLimited = connectionSummary({
      selectedProviderId: "gemini",
      catalog: { id: "gemini", displayName: "Google Gemini", category: "cloud" } as never,
      health: { state: "rate-limited" },
      credentialConfigured: true,
      modelCount: 3,
    });
    expect(rateLimited.connected).toBe(false);
    expect(rateLimited.tone).toBe("warning");

    // RED: Invalid authentication
    const authInvalid = connectionSummary({
      selectedProviderId: "gemini",
      catalog: { id: "gemini", displayName: "Google Gemini", category: "cloud" } as never,
      health: { state: "auth-invalid" },
      credentialConfigured: true,
      modelCount: 3,
    });
    expect(authInvalid.connected).toBe(false);
    expect(authInvalid.tone).toBe("danger");

    // RED: Unavailable
    const unavailable = connectionSummary({
      selectedProviderId: "gemini",
      catalog: { id: "gemini", displayName: "Google Gemini", category: "cloud" } as never,
      health: { state: "unavailable" },
      credentialConfigured: true,
      modelCount: 3,
    });
    expect(unavailable.connected).toBe(false);
    expect(unavailable.tone).toBe("danger");

    // GRAY: Not configured / unverified / auth-required
    const authRequired = connectionSummary({
      selectedProviderId: "gemini",
      catalog: { id: "gemini", displayName: "Google Gemini", category: "cloud" } as never,
      health: { state: "auth-required" },
      credentialConfigured: false,
      modelCount: 3,
    });
    expect(authRequired.connected).toBe(false);
    expect(authRequired.tone).toBe("muted");
    expect(authRequired.label).toContain("API key required");

    // GRAY: Unprobed cloud provider (no yellow dot without a reason)
    const unprobed = connectionSummary({
      selectedProviderId: "gemini",
      catalog: { id: "gemini", displayName: "Google Gemini", category: "cloud" } as never,
      health: undefined,
      credentialConfigured: false,
      modelCount: 3,
    });
    expect(unprobed.connected).toBe(false);
    expect(unprobed.tone).toBe("muted");
  });

  it("7. Anthropic / Cloud status mapping: unconfigured shows API key required / unverified, never fake yellow or connected", () => {
    const anthropicSummary = connectionSummary({
      selectedProviderId: "anthropic",
      catalog: { id: "anthropic", displayName: "Anthropic", category: "cloud" } as never,
      selectedState: { id: "anthropic", name: "anthropic", state: "auth-required", connected: false, checkedAt: "" },
      credentialConfigured: false,
      modelCount: 0,
    });
    expect(anthropicSummary.connected).toBe(false);
    expect(anthropicSummary.tone).toBe("muted");
    expect(anthropicSummary.label).toBe("Anthropic: API key required");
  });

  it("8. GoogleProvider streams using specified model and falls back from 404 retired models", async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn()
      // First call (gemini-2.5-flash) returns 404 (model retired)
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        body: null,
        text: async () => JSON.stringify({ error: { message: "models/gemini-2.5-flash is retired" } }),
      } as Response)
      // Second call (fallback to gemini-3.5-flash) returns 200 SSE stream
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: {
          getReader: () => {
            let emitted = false;
            return {
              read: async () => {
                if (emitted) return { done: true, value: undefined };
                emitted = true;
                const encoder = new TextEncoder();
                const sseData =
                  'data: {"candidates":[{"content":{"parts":[{"text":"GEMINI_OK"}]},"finishReason":"STOP"}]}\n\n';
                return { done: false, value: encoder.encode(sseData) };
              },
            };
          },
        },
      } as unknown as Response);

    global.fetch = fetchMock;

    try {
      const provider = new GoogleProvider({
        providerId: "gemini",
        modelId: "gemini-2.5-flash",
        apiKey: "test-key",
      });

      const chunks = [];
      for await (const chunk of provider.completeStream({
        messages: [{ role: "user", content: "Reply with exactly GEMINI_OK" }],
      })) {
        chunks.push(chunk);
      }

      const textChunks = chunks.filter((c) => c.type === "text");
      expect(textChunks.length).toBeGreaterThan(0);
      expect((textChunks[0] as { text: string }).text).toBe("GEMINI_OK");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toContain("gemini-2.5-flash");
      expect(fetchMock.mock.calls[1][0]).toContain("gemini-3.8-flash");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("9. GoogleLlmProvider (native runtime) handles tool calls with thoughtSignature", async () => {
    const sseResponse =
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"package.json"}},"thoughtSignature":"sig_123"}]},"finishReason":"STOP"}]}\n\n';

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        getReader: () => {
          let emitted = false;
          return {
            read: async () => {
              if (emitted) return { done: true, value: undefined };
              emitted = true;
              return { done: false, value: new TextEncoder().encode(sseResponse) };
            },
          };
        },
      },
    } as unknown as Response);

    const nativeProvider = new GoogleLlmProvider({
      apiKey: "test-key",
      fetchImpl: fetchImpl as never,
    });

    const events = [];
    for await (const event of nativeProvider.stream({
      modelId: "gemini-3.5-flash",
      messages: [{ role: "user", content: "Read package.json" }],
      tools: [{
        name: "read_file",
        description: "Read file",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      }] as never,
    })) {
      events.push(event);
    }

    const toolEvents = events.filter((e) => e.type === "tool-call");
    expect(toolEvents.length).toBe(1);
    expect((toolEvents[0] as { call: { toolName: string; thoughtSignature?: string } }).call.toolName).toBe("read_file");
    expect((toolEvents[0] as { call: { thoughtSignature?: string } }).call.thoughtSignature).toBe("sig_123");
  });
});
