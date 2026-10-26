// ============================================================================
// Gemini Simplified Setup Tests
//
// Verifies:
// 1. Gemini configuration requires only API key (no Base URL, no technical fields).
// 2. Gemini does not require Base URL from the user (derived internally).
// 3. Valid key validation succeeds (probe returns Gemini Connected).
// 4. Invalid key validation fails with clear message (not silently saved).
// 5. Empty key is rejected before running unauthenticated probe.
// 6. Network failure returns clear error without crash.
// 7. Quota/rate limit returns clear quota message.
// 8. Successful connection updates connection state.
// 9. Connection indicator displays correctly.
// 10. Gemini chat inference works (GoogleLlmProvider stream).
// 11. API key is never exposed in errors, URLs in error messages, or logs.
// 12. Existing providers (Ollama, OpenAI-native) continue working.
// 13. Existing Gemini model catalogue entries are preserved.
// ============================================================================

import React from "../apps/webview/node_modules/react";
import { renderToString } from "../apps/webview/node_modules/react-dom/server";
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderService } from "../apps/vscode-extension/src/provider-service";
import { inMemorySecrets, inMemoryState, context } from "./vscode-stub";
import { getCatalogProvider } from "../packages/model-gateway/src/provider-catalog";
import {
  GoogleLlmProvider,
  toGeminiSchema,
  toGeminiFunctionDeclarationSchema,
  toGeminiContents,
} from "../packages/agent-runtime/src/native/llm/google";
import { OpenAiCompatibleLlmProvider } from "../packages/agent-runtime/src/native/llm/openai-compatible";
import { LlmError } from "../packages/agent-runtime/src/native/llm/types";
import { classifyError } from "../packages/agent-runtime/src/self-healing";
import { describeErrorCard } from "../apps/webview/src/lib/outcomes";
import { dispatchToolCall, type ToolGate } from "../packages/agent-runtime/src/native/engine/tool-dispatch";
import type { AgentTool } from "../packages/agent-runtime/src/native/types";
import { connectionSummary, type CatalogProviderLite } from "../apps/webview/src/lib/messages";
import { ProviderSelector } from "../apps/webview/src/ProviderSelector";

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

describe("1 & 2. Gemini Configuration Surface", () => {
  it("Gemini requires only API key in metadata and does not expose Base URL", () => {
    const provider = getCatalogProvider("gemini");
    expect(provider).toBeDefined();
    expect(provider!.requiresApiKey).toBe(true);
    expect(provider!.supportsCustomBaseUrl).toBe(false);

    // Metadata config fields must NOT contain a baseUrl field
    const fieldPaths = provider!.fields.map((f) => f.path);
    expect(fieldPaths).not.toContain("baseUrl");

    // Plain non-secret fields should be empty (no technical endpoints or URLs)
    const plainFields = provider!.fields.filter((f) => f.type !== "password");
    expect(plainFields).toHaveLength(0);

    // Only password/apiKey field is present
    const secretFields = provider!.fields.filter((f) => f.type === "password");
    expect(secretFields).toHaveLength(1);
    expect(secretFields[0]!.path).toBe("apiKey");
  });

  it("Gemini uses default Google base URL internally without user input", () => {
    const svc = makeService();
    const effectiveBase = svc.effectiveBaseUrl("gemini");
    expect(effectiveBase).toBe("https://generativelanguage.googleapis.com");
  });
});

describe("3, 4, 5, 6, 7. Gemini Key Validation & Probing", () => {
  it("valid key validation succeeds with x-goog-api-key header on /v1beta/models", async () => {
    const svc = makeService();
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        models: [
          { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash" },
          { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await svc.testConnection("gemini", undefined, "AIzaSyTestValidKey");
    expect(result.state).toBe("connected");
    expect(result.message).toBe("Gemini Connected");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]!;
    const url = String(call[0]);
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models");

    const headers = call[1]?.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("AIzaSyTestValidKey");
    expect(headers.Authorization).toBeUndefined(); // Google uses x-goog-api-key, not Bearer
  });

  it("invalid key (HTTP 400 / 401 / 403) validation fails with clear error", async () => {
    const svc = makeService();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: 400,
              message: "API key not valid. Please pass a valid API key.",
              status: "INVALID_ARGUMENT",
            },
          },
          400,
        ),
      ),
    );

    const result = await svc.testConnection("gemini", undefined, "invalid-key-xyz");
    expect(result.state).toBe("auth-invalid");
    expect(result.message).toBe("Gemini API key is invalid or could not be verified.");
  });

  it("empty key is rejected without making any network request", async () => {
    const svc = makeService();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await svc.testConnection("gemini");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.state).toBe("auth-required");
    expect(result.message).toBe("Gemini API key is required.");
  });

  it("network failure returns clear network error without crash", async () => {
    const svc = makeService();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Failed to fetch / network unreachable");
      }),
    );

    const result = await svc.testConnection("gemini", undefined, "some-key");
    expect(result.state).toBe("unavailable");
    expect(result.message).toBe("Could not reach Gemini. Check your network connection.");
  });

  it("quota/rate limit (HTTP 429) returns clear rate-limit message", async () => {
    const svc = makeService();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: 429,
              message: "Resource has been exhausted (check quota).",
              status: "RESOURCE_EXHAUSTED",
            },
          },
          429,
        ),
      ),
    );

    const result = await svc.testConnection("gemini", undefined, "some-key");
    expect(result.state).toBe("rate-limited");
    expect(result.message).toBe("Gemini API quota/rate limit reached.");
  });
});

describe("8 & 9. Connection State & Indicator", () => {
  it("successful connection displays connected summary", () => {
    const provider = getCatalogProvider("gemini");
    const summary = connectionSummary({
      selectedProviderId: "gemini",
      catalog: provider as unknown as Parameters<typeof connectionSummary>[0]["catalog"],
      health: {
        providerId: "gemini",
        state: "connected",
        message: "Gemini Connected",
        latencyMs: 120,
      },
      credentialConfigured: true,
      modelCount: 3,
    });

    expect(summary.connected).toBe(true);
    expect(summary.label).toContain("Connected");
  });

  it("rejected credential displays rejected summary", () => {
    const provider = getCatalogProvider("gemini");
    const summary = connectionSummary({
      selectedProviderId: "gemini",
      catalog: provider as unknown as Parameters<typeof connectionSummary>[0]["catalog"],
      selectedState: {
        id: "gemini",
        name: "Google Gemini",
        state: "auth-invalid",
        connected: false,
      },
      credentialConfigured: true,
      modelCount: 3,
    });

    expect(summary.connected).toBe(false);
    expect(summary.label).toMatch(/API key rejected/i);
  });
});

describe("10 & 11. Gemini Chat Inference & Security", () => {
  it("GoogleLlmProvider streams chat responses from SSE wire format", async () => {
    const ssePayload = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hello from "}],"role":"model"}}]}',
      "",
      'data: {"candidates":[{"content":{"parts":[{"text":"Gemini!"}],"role":"model"}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":4}}',
      "",
      "",
    ].join("\n");

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(ssePayload));
        controller.close();
      },
    });

    const mockFetch = vi.fn(async () => new Response(stream, { status: 200 }));

    const llm = new GoogleLlmProvider({
      apiKey: "SECRET_KEY_12345",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const chunks: string[] = [];
    for await (const event of llm.stream({
      messages: [{ role: "user", content: "Hi" }],
      modelId: "gemini-2.5-flash",
    })) {
      if (event.type === "text-delta" && event.text) {
        chunks.push(event.text);
      }
    }

    expect(chunks.join("")).toBe("Hello from Gemini!");

    // Verify endpoint called
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = String(mockFetch.mock.calls[0]![0]);
    expect(calledUrl).toContain("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent");
  });

  it("API key is never included in error messages when request fails", async () => {
    const secretKey = "SECRET_GEMINI_KEY_XYZ_999";
    const mockFetch = vi.fn(async () =>
      new Response("Bad Request: INVALID_ARGUMENT", { status: 400 }),
    );

    const llm = new GoogleLlmProvider({
      apiKey: secretKey,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    let caughtError: Error | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of llm.stream({
        messages: [{ role: "user", content: "Hi" }],
        modelId: "gemini-2.5-flash",
      })) {
        // no-op
      }
    } catch (e) {
      caughtError = e as Error;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).not.toContain(secretKey);
  });
});

describe("12 & 13. Existing Providers & Supported Models Preserved", () => {
  it("Ollama and OpenAI-native continue functioning normally", async () => {
    const svc = makeService();

    // Ollama probe works
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ models: [{ name: "qwen2.5-coder:3b" }] })),
    );
    svc.setConfig("ollama", { baseUrl: "http://127.0.0.1:11434" });
    const ollamaResult = await svc.testConnection("ollama");
    expect(ollamaResult.state).toBe("connected");

    // OpenAI probe works
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [{ id: "gpt-4o" }] })),
    );
    await svc.setCredential("openai-native", "sk-openai-key");
    const openaiResult = await svc.testConnection("openai-native");
    expect(openaiResult.state).toBe("connected");
  });

  it("Gemini catalogue preserves all supported models (2.5-flash, 2.5-pro, 2.0-flash)", () => {
    const provider = getCatalogProvider("gemini");
    expect(provider).toBeDefined();

    const modelIds = provider!.models.map((m) => m.id);
    expect(modelIds).toContain("gemini-2.5-flash");
    expect(modelIds).toContain("gemini-2.5-pro");
    expect(modelIds).toContain("gemini-2.0-flash");
    expect(provider!.defaultModelId).toBe("gemini-2.5-flash");
  });
});

describe("14. Simplified Provider Settings UI Render & Behavior", () => {
  const sampleProviders: CatalogProviderLite[] = [
    {
      id: "gemini",
      displayName: "Google Gemini",
      category: "cloud",
      status: "SUPPORTED",
      curated: true,
      requiresApiKey: true,
      supportsCustomBaseUrl: false,
      fields: [{ path: "apiKey", label: "Gemini API key", type: "password", required: true }],
      models: [
        { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", reasoning: true, vision: true, tools: true, streaming: true, toolCalling: "true" },
        { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", reasoning: true, vision: true, tools: true, streaming: true, toolCalling: "true" },
      ],
    },
    {
      id: "ollama",
      displayName: "Ollama",
      category: "local",
      status: "SUPPORTED",
      curated: true,
      requiresApiKey: false,
      supportsCustomBaseUrl: true,
      baseUrl: "http://localhost:11434",
      fields: [{ path: "baseUrl", label: "Base URL", type: "url", required: false }],
      models: [
        { id: "qwen3:8b", name: "Qwen 3 8B", reasoning: true, vision: false, tools: true, streaming: true, toolCalling: "true" },
      ],
    },
    {
      id: "openai-native",
      displayName: "OpenAI",
      category: "cloud",
      status: "SUPPORTED",
      curated: true,
      requiresApiKey: true,
      supportsCustomBaseUrl: true,
      baseUrl: "https://api.openai.com/v1",
      fields: [
        { path: "apiKey", label: "OpenAI API key", type: "password", required: true },
        { path: "baseUrl", label: "Base URL", type: "url", required: false },
      ],
      models: [
        { id: "gpt-4o", name: "GPT-4o", reasoning: false, vision: true, tools: true, streaming: true, toolCalling: "true" },
      ],
    },
  ];

  it("1. Gemini settings renders API key field", () => {
    const html = renderToString(
      React.createElement(ProviderSelector, {
        providers: sampleProviders,
        statuses: { gemini: { credentialConfigured: false } },
        activeProviderId: "gemini",
        onSave: () => {},
        onTest: () => {},
        onUseProvider: () => {},
      }),
    );
    expect(html).toContain('id="gemini-api-key"');
    expect(html).toContain("Gemini API Key");
  });

  it("2 & 3. Gemini settings does NOT render Base URL or generic URL inputs", () => {
    const html = renderToString(
      React.createElement(ProviderSelector, {
        providers: sampleProviders,
        statuses: { gemini: { credentialConfigured: false } },
        activeProviderId: "gemini",
        onSave: () => {},
        onTest: () => {},
        onUseProvider: () => {},
      }),
    );
    expect(html).not.toContain("Base URL");
    expect(html).not.toContain("prov-baseurl");
    expect(html).not.toContain("set-baseurl");
    expect(html).not.toContain("https://generativelanguage.googleapis.com");
    expect(html).not.toContain("Advanced Settings");
  });

  it("4. Gemini Connect button is rendered", () => {
    const html = renderToString(
      React.createElement(ProviderSelector, {
        providers: sampleProviders,
        statuses: { gemini: { credentialConfigured: false } },
        activeProviderId: "gemini",
        onSave: () => {},
        onTest: () => {},
        onUseProvider: () => {},
      }),
    );
    expect(html).toContain("Connect");
    expect(html).toContain('data-testid="gemini-connect-btn"');
  });

  it("5. Valid Gemini key displays Connected status", () => {
    const html = renderToString(
      React.createElement(ProviderSelector, {
        providers: sampleProviders,
        statuses: { gemini: { credentialConfigured: true } },
        activeProviderId: "gemini",
        health: {
          providerId: "gemini",
          state: "connected",
          message: "Gemini Connected",
        },
        onSave: () => {},
        onTest: () => {},
        onUseProvider: () => {},
      }),
    );
    expect(html).toContain("✓ Gemini Connected");
  });

  it("6. Invalid Gemini key displays error", () => {
    const html = renderToString(
      React.createElement(ProviderSelector, {
        providers: sampleProviders,
        statuses: { gemini: { credentialConfigured: false } },
        activeProviderId: "gemini",
        health: {
          providerId: "gemini",
          state: "error",
          message: "Invalid Gemini API key",
        },
        onSave: () => {},
        onTest: () => {},
        onUseProvider: () => {},
      }),
    );
    expect(html).toContain("Invalid Gemini API key");
  });

  it("7. Invalid Gemini key is not saved into SecretStorage", async () => {
    const svc = makeService();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: 400,
              message: "API key not valid",
              status: "INVALID_ARGUMENT",
            },
          },
          400,
        ),
      ),
    );

    const testRes = await svc.testConnection("gemini", undefined, "bad-key");
    expect(testRes.state).toBe("auth-invalid");
    // Secret storage must not have this bad key
    expect(inMemorySecrets.get("codepilot.provider.gemini.apiKey")).toBeUndefined();
  });

  it("8. Ollama normal settings does NOT render Base URL in normal view", () => {
    const html = renderToString(
      React.createElement(ProviderSelector, {
        providers: sampleProviders,
        statuses: { ollama: { credentialConfigured: false } },
        activeProviderId: "ollama",
        onSave: () => {},
        onTest: () => {},
        onUseProvider: () => {},
      }),
    );
    // Base URL input is hidden by default under Advanced Settings
    expect(html).not.toContain('id="prov-baseurl"');
    expect(html).toContain("Advanced Settings");
    expect(html).toContain("Ollama Connected");
  });

  it("9. Ollama uses localhost:11434 internally by default", () => {
    const svc = makeService();
    const effectiveBase = svc.effectiveBaseUrl("ollama");
    expect(effectiveBase).toBe("http://localhost:11434");
  });

  it("10. Custom-provider Base URL functionality remains available under Advanced", () => {
    const customProviders: CatalogProviderLite[] = [
      {
        id: "custom",
        displayName: "Custom Provider",
        category: "custom",
        status: "CONFIGURABLE",
        curated: false,
        requiresApiKey: true,
        supportsCustomBaseUrl: true,
        baseUrl: "https://api.custom.ai/v1",
        fields: [{ path: "apiKey", label: "API key", type: "password", required: true }],
        models: [{ id: "custom-model", name: "Custom Model", reasoning: false, vision: false, tools: true, streaming: true, toolCalling: "true" }],
      },
    ];

    const html = renderToString(
      React.createElement(ProviderSelector, {
        providers: customProviders,
        statuses: { custom: { credentialConfigured: false } },
        activeProviderId: "custom",
        onSave: () => {},
        onTest: () => {},
        onUseProvider: () => {},
      }),
    );
    // Has advanced settings toggle to configure Base URL
    expect(html).toContain("Advanced Settings");
    expect(html).toContain("Custom Provider API Key");
  });

  it("11. Provider switching separates Gemini and Ollama fields without stale leakage", () => {
    const geminiHtml = renderToString(
      React.createElement(ProviderSelector, {
        providers: sampleProviders,
        statuses: { gemini: { credentialConfigured: false }, ollama: { credentialConfigured: false } },
        activeProviderId: "gemini",
        onSave: () => {},
        onTest: () => {},
        onUseProvider: () => {},
      }),
    );
    expect(geminiHtml).toContain("Gemini API Key");
    expect(geminiHtml).not.toContain("Ollama Connected");
    expect(geminiHtml).not.toContain("Test connection");

    const ollamaHtml = renderToString(
      React.createElement(ProviderSelector, {
        providers: sampleProviders,
        statuses: { gemini: { credentialConfigured: false }, ollama: { credentialConfigured: false } },
        activeProviderId: "ollama",
        onSave: () => {},
        onTest: () => {},
        onUseProvider: () => {},
      }),
    );
    expect(ollamaHtml).toContain("Ollama Connected");
    expect(ollamaHtml).not.toContain("Gemini API Key");
    expect(ollamaHtml).not.toContain('data-testid="gemini-connect-btn"');
    expect(ollamaHtml).not.toContain('id="gemini-api-key"');
  });

  it("12. No duplicate or rogue Base URL form is rendered in App.tsx Settings", () => {
    const appTsxPath = path.resolve(__dirname, "../apps/webview/src/App.tsx");
    const appTsxContent = fs.readFileSync(appTsxPath, "utf-8");

    // Must NOT contain the old hardcoded Base URL (Ollama) field
    expect(appTsxContent).not.toContain('label="Base URL (Ollama)"');
    expect(appTsxContent).not.toContain('id="set-baseurl"');
  });
});

describe("Gemini Tool Schema Compatibility & Function Declarations", () => {
  // 1. Gemini tool schema with additionalProperties:false -> request contains no additionalProperties
  it("1. Gemini tool schema with additionalProperties:false -> contains no additionalProperties", async () => {
    const rawSchema = {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    };
    const converted = toGeminiFunctionDeclarationSchema(rawSchema);
    expect(converted).not.toHaveProperty("additionalProperties");
    expect(converted).toEqual({
      type: "OBJECT",
      properties: {
        path: { type: "STRING" },
      },
      required: ["path"],
    });

    // Check request payload sent by GoogleLlmProvider.stream
    let sentBody: any;
    const mockFetch = vi.fn(async (_url, opts) => {
      sentBody = JSON.parse(opts.body);
      return new Response("data: [DONE]\n\n", { status: 200 });
    });
    const llm = new GoogleLlmProvider({ apiKey: "test-key", fetchImpl: mockFetch as any });
    const dummyTool: AgentTool = {
      name: "read_file",
      description: "Read file",
      inputSchema: rawSchema,
      execute: async () => "",
    };
    for await (const _ of llm.stream({
      modelId: "gemini-2.5-flash",
      messages: [{ role: "user", content: "hi" }],
      tools: [dummyTool],
    })) {}

    const decl = sentBody.tools[0].functionDeclarations[0];
    expect(decl.parameters).not.toHaveProperty("additionalProperties");
    expect(decl.parameters.type).toBe("OBJECT");
    expect(decl.parameters.properties.path.type).toBe("STRING");
  });

  // 2. Nested object with additionalProperties:false -> nested schema also contains no additionalProperties
  it("2. Nested object with additionalProperties:false -> nested schema also contains no additionalProperties", () => {
    const nestedSchema = {
      type: "object",
      properties: {
        options: {
          type: "object",
          properties: {
            recursive: {
              type: "boolean",
            },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    };
    const converted = toGeminiFunctionDeclarationSchema(nestedSchema);
    expect(converted).not.toHaveProperty("additionalProperties");
    const optionsProp = (converted.properties as any).options;
    expect(optionsProp).not.toHaveProperty("additionalProperties");
    expect(optionsProp.type).toBe("OBJECT");
    expect(optionsProp.properties.recursive.type).toBe("BOOLEAN");
  });

  // 3. MCP tool JSON schema -> Gemini-compatible schema generated
  it("3. MCP tool JSON schema -> Gemini-compatible schema generated", () => {
    const mcpSchema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        uri: {
          type: "string",
          description: "URI to fetch",
        },
        timeout: {
          type: "integer",
          minimum: 1,
        },
      },
      required: ["uri"],
      additionalProperties: false,
    };
    const converted = toGeminiFunctionDeclarationSchema(mcpSchema);
    expect(converted).not.toHaveProperty("$schema");
    expect(converted).not.toHaveProperty("additionalProperties");
    expect(converted.type).toBe("OBJECT");
    expect((converted.properties as any).uri).toEqual({
      type: "STRING",
      description: "URI to fetch",
    });
    expect((converted.properties as any).timeout).toEqual({
      type: "INTEGER",
      minimum: 1,
    });
    expect(converted.required).toEqual(["uri"]);
  });

  // 4. string property preserved
  it("4. string property preserved with description, format, pattern, minLength, maxLength", () => {
    const schema = {
      type: "object",
      properties: {
        email: {
          type: "string",
          description: "User email",
          format: "email",
          pattern: "^.+@.+$",
          minLength: 5,
          maxLength: 100,
        },
      },
    };
    const converted = toGeminiFunctionDeclarationSchema(schema);
    const emailProp = (converted.properties as any).email;
    expect(emailProp).toEqual({
      type: "STRING",
      description: "User email",
      format: "email",
      pattern: "^.+@.+$",
      minLength: 5,
      maxLength: 100,
    });
  });

  // 5. number property preserved
  it("5. number property preserved with minimum, maximum", () => {
    const schema = {
      type: "object",
      properties: {
        score: {
          type: "number",
          minimum: 0.0,
          maximum: 100.0,
          description: "Accuracy score",
        },
      },
    };
    const converted = toGeminiFunctionDeclarationSchema(schema);
    const scoreProp = (converted.properties as any).score;
    expect(scoreProp).toEqual({
      type: "NUMBER",
      minimum: 0.0,
      maximum: 100.0,
      description: "Accuracy score",
    });
  });

  // 6. integer property preserved
  it("6. integer property preserved with minimum, maximum", () => {
    const schema = {
      type: "object",
      properties: {
        count: {
          type: "integer",
          minimum: 1,
          maximum: 50,
        },
      },
    };
    const converted = toGeminiFunctionDeclarationSchema(schema);
    const countProp = (converted.properties as any).count;
    expect(countProp).toEqual({
      type: "INTEGER",
      minimum: 1,
      maximum: 50,
    });
  });

  // 7. boolean property preserved
  it("7. boolean property preserved", () => {
    const schema = {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          description: "Flag to enable feature",
        },
      },
    };
    const converted = toGeminiFunctionDeclarationSchema(schema);
    const enabledProp = (converted.properties as any).enabled;
    expect(enabledProp).toEqual({
      type: "BOOLEAN",
      description: "Flag to enable feature",
    });
  });

  // 8. array/items preserved
  it("8. array/items preserved with items schema, minItems, maxItems", () => {
    const schema = {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: {
            type: "string",
          },
          minItems: 1,
          maxItems: 5,
        },
      },
    };
    const converted = toGeminiFunctionDeclarationSchema(schema);
    const tagsProp = (converted.properties as any).tags;
    expect(tagsProp).toEqual({
      type: "ARRAY",
      items: {
        type: "STRING",
      },
      minItems: 1,
      maxItems: 5,
    });
  });

  // 9. object/properties preserved
  it("9. object/properties preserved recursively", () => {
    const schema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            name: { type: "string" },
            age: { type: "integer" },
          },
          required: ["name"],
        },
      },
    };
    const converted = toGeminiFunctionDeclarationSchema(schema);
    expect(converted.type).toBe("OBJECT");
    const userProp = (converted.properties as any).user;
    expect(userProp.type).toBe("OBJECT");
    expect(userProp.properties.name.type).toBe("STRING");
    expect(userProp.properties.age.type).toBe("INTEGER");
    expect(userProp.required).toEqual(["name"]);
  });

  // 10. required fields preserved
  it("10. required fields preserved as valid string array", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "number" },
      },
      required: ["a", "b"],
    };
    const converted = toGeminiFunctionDeclarationSchema(schema);
    expect(converted.required).toEqual(["a", "b"]);
  });

  // 11. Unsupported JSON Schema keywords are safely normalized
  it("11. Unsupported JSON Schema keywords ($defs, patternProperties, const, oneOf, allOf) are normalized", () => {
    const unsupportedSchema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      $defs: { custom: { type: "string" } },
      definitions: { old: { type: "string" } },
      patternProperties: { "^s_": { type: "string" } },
      unevaluatedProperties: false,
      readOnly: true,
      writeOnly: false,
      type: "object",
      properties: {
        action: {
          const: "restart",
        },
        payload: {
          oneOf: [
            { type: "string" },
            { type: "number" },
          ],
        },
      },
      allOf: [
        {
          properties: { extra: { type: "boolean" } },
          required: ["extra"],
        },
      ],
    };
    const converted = toGeminiFunctionDeclarationSchema(unsupportedSchema);
    expect(converted).not.toHaveProperty("$schema");
    expect(converted).not.toHaveProperty("$defs");
    expect(converted).not.toHaveProperty("definitions");
    expect(converted).not.toHaveProperty("patternProperties");
    expect(converted).not.toHaveProperty("unevaluatedProperties");
    expect(converted).not.toHaveProperty("readOnly");
    expect(converted).not.toHaveProperty("writeOnly");
    expect(converted).not.toHaveProperty("allOf");

    // const -> enum
    const actionProp = (converted.properties as any).action;
    expect(actionProp.type).toBe("STRING");
    expect(actionProp.enum).toEqual(["restart"]);

    // oneOf -> anyOf
    const payloadProp = (converted.properties as any).payload;
    expect(payloadProp.anyOf).toEqual([
      { type: "STRING" },
      { type: "NUMBER" },
    ]);

    // allOf merged into properties and required
    expect((converted.properties as any).extra).toEqual({ type: "BOOLEAN" });
    expect(converted.required).toContain("extra");
  });

  // 12. OpenAI canonical schema remains unchanged
  it("12. OpenAI canonical schema remains unchanged (additionalProperties preserved)", async () => {
    const canonicalSchema = {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    };
    const tool: AgentTool = {
      name: "read_file",
      description: "Read a file",
      inputSchema: canonicalSchema,
      execute: async () => "",
    };

    let capturedBody: any;
    const mockFetch = vi.fn(async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return new Response("data: [DONE]\n\n", { status: 200 });
    });

    const openai = new OpenAiCompatibleLlmProvider("openai", {
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      fetchImpl: mockFetch as any,
    });

    for await (const _ of openai.stream({
      providerId: "openai",
      modelId: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      tools: [tool],
    })) {}

    // Verify canonical inputSchema was NOT mutated
    expect(canonicalSchema.additionalProperties).toBe(false);

    // Verify OpenAI provider sends canonical schema
    const openaiTools = capturedBody.tools;
    expect(openaiTools[0].function.parameters.additionalProperties).toBe(false);
  });

  // 13. Gemini function declaration request passes schema validation
  it("13. Gemini function declaration request passes schema validation (no additionalProperties in entire wire body)", async () => {
    let capturedBody: any;
    const mockFetch = vi.fn(async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return new Response("data: [DONE]\n\n", { status: 200 });
    });

    const llm = new GoogleLlmProvider({
      apiKey: "test-gemini-key",
      fetchImpl: mockFetch as any,
    });

    const complexTool: AgentTool = {
      name: "execute_complex",
      description: "Complex tool with nested properties",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to execute" },
          mode: {
            type: "string",
            enum: ["fast", "precise"],
            description: "Execution mode",
          },
          options: {
            type: "object",
            description: "Execution options",
            properties: {
              timeout: { type: "integer", description: "Timeout in ms" },
              verbose: { type: "boolean", description: "Verbose logging" },
            },
            additionalProperties: false,
          },
          items: {
            type: "array",
            description: "List of target items",
            items: {
              type: "object",
              properties: { id: { type: "string", description: "Item identifier" } },
              additionalProperties: false,
            },
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
      execute: async () => "",
    };

    for await (const _ of llm.stream({
      modelId: "gemini-2.5-flash",
      messages: [{ role: "user", content: "run" }],
      tools: [complexTool],
    })) {}

    const bodyStr = JSON.stringify(capturedBody);
    // Assert that the serialized Gemini request contains no unsupported additionalProperties fields at any depth
    expect(bodyStr).not.toContain('"additionalProperties"');

    // Assert preserved supported fields: type, properties, required, description, items, enum
    const decl = capturedBody.tools[0].functionDeclarations[0];
    expect(decl.name).toBe("execute_complex");
    expect(decl.description).toBe("Complex tool with nested properties");

    // Top-level parameters
    expect(decl.parameters.type).toBe("OBJECT");
    expect(decl.parameters.required).toEqual(["command"]);
    expect(decl.parameters.properties).toBeDefined();

    // Preserved fields on command
    expect(decl.parameters.properties.command.type).toBe("STRING");
    expect(decl.parameters.properties.command.description).toBe("Command to execute");

    // Preserved enum
    expect(decl.parameters.properties.mode.type).toBe("STRING");
    expect(decl.parameters.properties.mode.enum).toEqual(["fast", "precise"]);
    expect(decl.parameters.properties.mode.description).toBe("Execution mode");

    // Preserved nested object properties
    expect(decl.parameters.properties.options.type).toBe("OBJECT");
    expect(decl.parameters.properties.options.description).toBe("Execution options");
    expect(decl.parameters.properties.options.properties.timeout.type).toBe("INTEGER");
    expect(decl.parameters.properties.options.properties.timeout.description).toBe("Timeout in ms");
    expect(decl.parameters.properties.options.properties.verbose.type).toBe("BOOLEAN");

    // Preserved array and items
    expect(decl.parameters.properties.items.type).toBe("ARRAY");
    expect(decl.parameters.properties.items.description).toBe("List of target items");
    expect(decl.parameters.properties.items.items.type).toBe("OBJECT");
    expect(decl.parameters.properties.items.items.properties.id.type).toBe("STRING");
    expect(decl.parameters.properties.items.items.properties.id.description).toBe("Item identifier");
  });

  // 14. Gemini tool call response is parsed correctly
  it("14. Gemini tool call response (functionCall) is parsed correctly into tool-call stream events", async () => {
    const ssePayload = [
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"src/index.ts"}}}],"role":"model"}}]}',
      "",
      'data: {"candidates":[{"content":{"parts":[],"role":"model"}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5}}',
      "",
      "",
    ].join("\n");

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(ssePayload));
        controller.close();
      },
    });

    const mockFetch = vi.fn(async () => new Response(stream, { status: 200 }));
    const llm = new GoogleLlmProvider({
      apiKey: "test-gemini-key",
      fetchImpl: mockFetch as any,
    });

    const events: any[] = [];
    for await (const evt of llm.stream({
      modelId: "gemini-2.5-flash",
      messages: [{ role: "user", content: "read file" }],
    })) {
      events.push(evt);
    }

    const toolCallEvt = events.find((e) => e.type === "tool-call");
    expect(toolCallEvt).toBeDefined();
    expect(toolCallEvt.call.toolName).toBe("read_file");
    expect(toolCallEvt.call.argumentsText).toBe(JSON.stringify({ path: "src/index.ts" }));
  });

  // 15. Existing ToolGate approval still works
  it("15. Existing ToolGate approval still works (allows when approved, blocks when denied)", async () => {
    const executedTools: string[] = [];
    const testTool: AgentTool = {
      name: "write_file",
      description: "Write file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        additionalProperties: false,
      },
      execute: async (args: any) => {
        executedTools.push(args.path);
        return "written";
      },
    };

    const approvedGate: ToolGate = async () => ({ approved: true });
    const deniedGate: ToolGate = async () => ({ approved: false, reason: "Security violation" });

    // Test approved path
    const outcomeApproved = await dispatchToolCall(
      testTool,
      {
        toolCallId: "call_1",
        toolName: "write_file",
        argumentsText: JSON.stringify({ path: "allowed.txt", content: "data" }),
      },
      approvedGate,
      { taskId: "task_1" },
    );
    expect(outcomeApproved.denied).toBe(false);
    expect(outcomeApproved.content).toBe("written");
    expect(executedTools).toContain("allowed.txt");

    // Test denied path
    const outcomeDenied = await dispatchToolCall(
      testTool,
      {
        toolCallId: "call_2",
        toolName: "write_file",
        argumentsText: JSON.stringify({ path: "forbidden.txt", content: "data" }),
      },
      deniedGate,
      { taskId: "task_2" },
    );
    expect(outcomeDenied.denied).toBe(true);
    expect(outcomeDenied.denialReason).toBe("Security violation");
    expect(executedTools).not.toContain("forbidden.txt");
  });

  // 16. Existing file/terminal/browser tools continue working
  it("16. Existing file/terminal/browser tools continue working with schema conversion", () => {
    const fileToolSchema = {
      type: "object",
      properties: {
        path: { type: "string", description: "Target file path" },
        encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8" },
      },
      required: ["path"],
      additionalProperties: false,
    };
    const terminalToolSchema = {
      type: "object",
      properties: {
        command: { type: "string", description: "Command line to run" },
        timeoutMs: { type: "integer", minimum: 1000 },
      },
      required: ["command"],
      additionalProperties: false,
    };
    const browserToolSchema = {
      type: "object",
      properties: {
        action: { type: "string", enum: ["navigate", "click", "screenshot"] },
        url: { type: "string" },
        selector: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    };

    const normFile = toGeminiFunctionDeclarationSchema(fileToolSchema);
    const normTerminal = toGeminiFunctionDeclarationSchema(terminalToolSchema);
    const normBrowser = toGeminiFunctionDeclarationSchema(browserToolSchema);

    expect(normFile.type).toBe("OBJECT");
    expect(normFile).not.toHaveProperty("additionalProperties");
    expect((normFile.properties as any).path.type).toBe("STRING");
    expect((normFile.properties as any).encoding.enum).toEqual(["utf8", "base64"]);

    expect(normTerminal.type).toBe("OBJECT");
    expect(normTerminal).not.toHaveProperty("additionalProperties");
    expect((normTerminal.properties as any).command.type).toBe("STRING");
    expect((normTerminal.properties as any).timeoutMs.type).toBe("INTEGER");

    expect(normBrowser.type).toBe("OBJECT");
    expect(normBrowser).not.toHaveProperty("additionalProperties");
    expect((normBrowser.properties as any).action.enum).toEqual(["navigate", "click", "screenshot"]);
  });

  // 17. Verify complete requests (Requirement 4): simple text-gen & agent request with tools on Google endpoint
  it("17. Verify complete requests: text-generation without tools & agent request with tools on Google endpoint", async () => {
    let capturedUrl = "";
    let capturedBody: any = null;

    const mockFetch = vi.fn(async (url: string, opts?: any) => {
      capturedUrl = String(url);
      capturedBody = opts?.body ? JSON.parse(opts.body) : null;
      return new Response("data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Verified response\"}],\"role\":\"model\"}}]}\n\n", {
        status: 200,
      });
    });

    const googleLlm = new GoogleLlmProvider({
      apiKey: "AIzaSyTestGeminiKey",
      fetchImpl: mockFetch as any,
    });

    // 1. Simple text generation request without tools
    const textGenChunks: string[] = [];
    for await (const evt of googleLlm.stream({
      modelId: "gemini-2.5-flash",
      messages: [{ role: "user", content: "Explain this repository" }],
    })) {
      if (evt.type === "text-delta" && evt.text) textGenChunks.push(evt.text);
    }

    // Verify Google endpoint is called, not Ollama or another provider
    expect(capturedUrl).toContain("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent");
    expect(capturedUrl).not.toContain("localhost:11434");
    expect(capturedUrl).not.toContain("127.0.0.1:11434");
    expect(capturedBody).toBeDefined();
    expect(capturedBody.tools).toBeUndefined(); // no tools sent for simple text generation
    expect(textGenChunks.join("")).toBe("Verified response");

    // 2. Agent request with tools enabled
    const agentTool: AgentTool = {
      name: "search_repository",
      description: "Search files in repository",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query string" },
          limit: { type: "integer", description: "Maximum results" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async () => "result",
    };

    capturedUrl = "";
    capturedBody = null;

    for await (const _ of googleLlm.stream({
      modelId: "gemini-2.5-flash",
      messages: [{ role: "user", content: "Explain this repository" }],
      tools: [agentTool],
    })) {}

    // Verify Google endpoint is called for agent request
    expect(capturedUrl).toContain("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent");
    expect(capturedUrl).not.toContain("localhost:11434");
    expect(capturedBody).toBeDefined();
    expect(capturedBody.tools).toBeDefined();
    expect(capturedBody.tools[0].functionDeclarations).toHaveLength(1);
    expect(capturedBody.tools[0].functionDeclarations[0].name).toBe("search_repository");
    expect(capturedBody.tools[0].functionDeclarations[0].parameters.type).toBe("OBJECT");
    expect(capturedBody.tools[0].functionDeclarations[0].parameters.required).toEqual(["query"]);

    // Verify wire payload contains NO additionalProperties
    expect(JSON.stringify(capturedBody)).not.toContain('"additionalProperties"');
  });
});

describe("14. Gemini HTTP 503 Handling & Credential Preservation", () => {
  it("treats HTTP 503 as temporary provider availability error in ProviderService (not invalid key)", async () => {
    const svc = makeService();
    await svc.setCredential("gemini", "AIzaSySavedKeyFor503Test");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 503,
            message: "The model is overloaded. Please try again later.",
            status: "UNAVAILABLE",
          },
        }),
        {
          status: 503,
          statusText: "Service Unavailable",
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await svc.testConnection("gemini", undefined, "AIzaSySavedKeyFor503Test");

    // Requirement 1: Treat HTTP 503 as temporary availability error, not auth-invalid
    expect(result.state).toBe("unavailable");
    expect(result.state).not.toBe("auth-invalid");

    // Requirement 2: Concise message
    expect(result.message).toBe("Gemini is temporarily busy. Try again shortly or select another available model.");

    // Requirement 3: Does not clear or overwrite saved API key
    const savedKey = await svc.getCredential("gemini");
    expect(savedKey).toBe("AIzaSySavedKeyFor503Test");
  });

  it("testInference handles HTTP 503 with concise message and preserves API key", async () => {
    const svc = makeService();
    await svc.setCredential("gemini", "AIzaSySavedKeyForInferenceTest");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 503,
            message: "model experiencing high demand",
            status: "UNAVAILABLE",
          },
        }),
        {
          status: 503,
          statusText: "Service Unavailable",
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await svc.testInference("gemini", "gemini-2.5-flash");

    expect(result.state).toBe("failed");
    expect(result.message).toBe("Gemini is temporarily busy. Try again shortly or select another available model.");

    // API key preserved
    const savedKey = await svc.getCredential("gemini");
    expect(savedKey).toBe("AIzaSySavedKeyForInferenceTest");
  });

  it("GoogleLlmProvider stream surfaces HTTP 503 with concise message and status 503 without fallback", async () => {
    let callCount = 0;
    const fetchMock = vi.fn<typeof fetch>(async (info) => {
      callCount++;
      const url = String(info);
      expect(url).toContain("generativelanguage.googleapis.com");
      expect(url).not.toContain("localhost:11434");
      return new Response("Service Unavailable: model experiencing high demand", {
        status: 503,
        statusText: "Service Unavailable",
      });
    });

    const googleLlm = new GoogleLlmProvider({
      apiKey: "AIzaSyTestSecretKey503",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    let thrownError: unknown;
    try {
      for await (const _ of googleLlm.stream({
        modelId: "gemini-2.5-flash",
        messages: [{ role: "user", content: "Hello" }],
      })) {}
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError).toBeInstanceOf(LlmError);
    const llmErr = thrownError as LlmError;
    // Requirement 1 & 2: Concise message
    expect(llmErr.message).toContain("Gemini is temporarily busy. Try again shortly or select another available model.");
    // Requirement 7: Preserves original HTTP status
    expect(llmErr.status).toBe(503);
    // Requirement 7: Redacts credentials from error message
    expect(llmErr.message).not.toContain("AIzaSyTestSecretKey503");
    // Requirement 4: No silent fallback - called exactly 1 time
    expect(callCount).toBe(1);
  });

  it("GoogleLlmProvider stream handles mid-stream SSE 503 UNAVAILABLE event", async () => {
    const sseBody = [
      `data: {"error":{"code":503,"message":"The model is overloaded. Please try again later.","status":"UNAVAILABLE"}}\n\n`,
    ].join("");

    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const googleLlm = new GoogleLlmProvider({
      apiKey: "AIzaSyTestSecretKeyMidStream",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const events: Array<{ type: string; reason?: string; error?: string }> = [];
    for await (const evt of googleLlm.stream({
      modelId: "gemini-2.5-flash",
      messages: [{ role: "user", content: "Hello" }],
    })) {
      events.push(evt as { type: string; reason?: string; error?: string });
    }

    const finishEvt = events.find((e) => e.type === "finish");
    expect(finishEvt).toBeDefined();
    expect(finishEvt?.reason).toBe("error");
    expect(finishEvt?.error).toContain("Gemini is temporarily busy. Try again shortly or select another available model.");
    expect(finishEvt?.error).not.toContain("AIzaSyTestSecretKeyMidStream");
  });

  it("GoogleLlmProvider stream does NOT relabel a context-limit 400 as 'temporarily busy' when the token count embeds 503", async () => {
    // Regression (root cause of unreliable long prompts): a long prompt that
    // exceeds the context window arrives mid-stream with code 400 /
    // INVALID_ARGUMENT. The real Gemini message embeds a token count
    // ("1503503") that CONTAINS the substring "503", so the previous free-text
    // /503|unavailable|high demand/i matcher relabeled this genuine
    // context-limit failure as the non-recoverable "temporarily busy" card,
    // hiding the real per-request cause. It must surface the real error instead.
    const sseBody = [
      `data: {"error":{"code":400,"status":"INVALID_ARGUMENT","message":"The input token count (1503503) exceeds the maximum number of tokens allowed (1048576)."}}\n\n`,
    ].join("");

    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const googleLlm = new GoogleLlmProvider({
      apiKey: "AIzaSyTestSecretKeyContextLimit",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const events: Array<{ type: string; reason?: string; error?: string }> = [];
    for await (const evt of googleLlm.stream({
      modelId: "gemini-2.5-flash",
      messages: [{ role: "user", content: "x".repeat(32) }],
    })) {
      events.push(evt as { type: string; reason?: string; error?: string });
    }

    const finishEvt = events.find((e) => e.type === "finish");
    expect(finishEvt).toBeDefined();
    expect(finishEvt?.reason).toBe("error");
    // The real, actionable diagnostic is preserved...
    expect(finishEvt?.error).toContain("exceeds the maximum number of tokens allowed");
    // ...and it is NOT masked as the transient busy message.
    expect(finishEvt?.error).not.toContain("temporarily busy");
    // Credentials never leak into the surfaced error.
    expect(finishEvt?.error).not.toContain("AIzaSyTestSecretKeyContextLimit");
  });

  it("GoogleLlmProvider stream still relabels a genuine structured 503 UNAVAILABLE as 'temporarily busy'", async () => {
    // Guard: the fix must not regress real availability errors. A structured
    // status UNAVAILABLE (no numeric code) is still genuine unavailability and
    // must continue to map to the concise busy message.
    const sseBody = [
      `data: {"error":{"status":"UNAVAILABLE","message":"The model is overloaded. Please try again later."}}\n\n`,
    ].join("");

    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const googleLlm = new GoogleLlmProvider({
      apiKey: "AIzaSyTestSecretKeyGenuine503",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const events: Array<{ type: string; reason?: string; error?: string }> = [];
    for await (const evt of googleLlm.stream({
      modelId: "gemini-2.5-flash",
      messages: [{ role: "user", content: "Hello" }],
    })) {
      events.push(evt as { type: string; reason?: string; error?: string });
    }

    const finishEvt = events.find((e) => e.type === "finish");
    expect(finishEvt?.reason).toBe("error");
    expect(finishEvt?.error).toContain(
      "Gemini is temporarily busy. Try again shortly or select another available model.",
    );
  });

  it("self-healing classifies Gemini busy as NON_RECOVERABLE (no automatic retry by default)", () => {
    const res = classifyError("Gemini is temporarily busy. Try again shortly or select another available model.");
    expect(res.category).toBe("NON_RECOVERABLE");
    expect(res.recoverable).toBe(false);
  });

  it("allows user to select another supported Gemini model such as gemini-2.5-pro after 503", async () => {
    let capturedUrl = "";
    const fetchMock = vi.fn<typeof fetch>(async (info) => {
      capturedUrl = String(info);
      if (capturedUrl.includes("gemini-2.5-flash")) {
        return new Response("Service Unavailable", { status: 503, statusText: "Service Unavailable" });
      }
      return new Response(
        `data: {"candidates":[{"content":{"parts":[{"text":"Response from gemini-2.5-pro"}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5}}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    });

    const googleLlm = new GoogleLlmProvider({
      apiKey: "AIzaSyTestKeyProSwitch",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    // 1. Initial attempt on gemini-2.5-flash fails with 503
    await expect(async () => {
      for await (const _ of googleLlm.stream({
        modelId: "gemini-2.5-flash",
        messages: [{ role: "user", content: "Query" }],
      })) {}
    }).rejects.toThrow("Gemini is temporarily busy. Try again shortly or select another available model.");

    // 2. User selects gemini-2.5-pro and manually retries -> succeeds
    const chunks: string[] = [];
    for await (const evt of googleLlm.stream({
      modelId: "gemini-2.5-pro",
      messages: [{ role: "user", content: "Query" }],
    })) {
      if (evt.type === "text-delta" && evt.text) chunks.push(evt.text);
    }

    expect(capturedUrl).toContain("gemini-2.5-pro");
    expect(capturedUrl).not.toContain("localhost:11434");
    expect(chunks.join("")).toBe("Response from gemini-2.5-pro");
  });

  it("webview describeErrorCard maps Gemini busy to concise network card", () => {
    const card = describeErrorCard({
      message: "Gemini is temporarily busy. Try again shortly or select another available model.",
      providerId: "gemini",
    });
    expect(card.title).toBe("Gemini is temporarily busy. Try again shortly or select another available model.");
    expect(card.kind).toBe("network");
    expect(card.kind).not.toBe("auth");
    expect(card.privacyBlocked).toBe(false);
  });
});



