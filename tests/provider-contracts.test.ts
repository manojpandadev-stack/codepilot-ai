/**
 * Provider system tests — webview message normalizers + URL validation.
 *
 * URL validation tests exercise the REAL `validateProviderBaseUrl` from
 * apps/vscode-extension/src/provider-service.ts. The `vscode` module is
 * aliased to a stub in vitest.config.ts, so the actual production validator
 * (shape rules + M13 navigation policy + local-provider allowance) runs
 * directly in these tests.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeCatalogProviders,
  normalizeProviderStatuses,
  normalizeProviderList,
  type CatalogProviderLite,
} from "../apps/webview/src/lib/messages.js";
import { validateProviderBaseUrl } from "../apps/vscode-extension/src/provider-service";

// ============================================================================
// Catalogue normalizers
// ============================================================================

const SAMPLE_PROVIDER: CatalogProviderLite = {
  id: "openai-native",
  displayName: "OpenAI",
  description: "GPT models",
  category: "cloud",
  status: "SUPPORTED",
  protocol: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  supportsCustomBaseUrl: true,
  requiresApiKey: true,
  supportsLocal: false,
  supportsModelDiscovery: false,
  supportsToolCalling: true,
  supportsVision: true,
  supportsReasoning: true,
  fields: [
    {
      path: "apiKey",
      label: "API Key",
      type: "password",
      required: true,
    },
  ],
  models: [
    {
      id: "gpt-5.6",
      name: "GPT-5.6",
      contextWindow: 1050000,
      reasoning: true,
      vision: true,
      tools: true,
      inputPerMtok: 5,
      outputPerMtok: 30,
    },
  ],
  defaultModelId: "gpt-5.4",
  usage: { kind: "local-tracking" },
};

describe("normalizeCatalogProviders", () => {
  it("accepts a bare array", () => {
    const out = normalizeCatalogProviders([SAMPLE_PROVIDER]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("openai-native");
  });

  it("accepts a { providers } wrapper", () => {
    const out = normalizeCatalogProviders({ providers: [SAMPLE_PROVIDER] });
    expect(out).toHaveLength(1);
  });

  it("drops malformed entries (no id, no fields array)", () => {
    const out = normalizeCatalogProviders([
      SAMPLE_PROVIDER,
      { displayName: "no id" },
      null,
      "string",
      { id: "x", displayName: "x", fields: "not-array", models: [] },
    ]);
    expect(out).toHaveLength(1);
  });

  it("returns empty for garbage payloads (never throws)", () => {
    expect(normalizeCatalogProviders(undefined)).toEqual([]);
    expect(normalizeCatalogProviders(null)).toEqual([]);
    expect(normalizeCatalogProviders(42)).toEqual([]);
    expect(normalizeCatalogProviders({})).toEqual([]);
  });
});

describe("normalizeProviderStatuses", () => {
  it("accepts single object, array, and wrapper shapes", () => {
    const s = { providerId: "ollama", credentialConfigured: false };
    expect(normalizeProviderStatuses(s)).toHaveLength(1);
    expect(normalizeProviderStatuses([s])).toHaveLength(1);
    expect(normalizeProviderStatuses({ statuses: [s] })).toHaveLength(1);
    expect(normalizeProviderStatuses({ status: s })[0]!.providerId).toBe(
      "ollama",
    );
  });

  it("filters entries without providerId", () => {
    expect(normalizeProviderStatuses([{ nope: 1 }, null, 3])).toEqual([]);
  });
});

describe("normalizeProviderList (legacy contract unchanged)", () => {
  it("still works", () => {
    expect(
      normalizeProviderList([
        { id: "ollama", name: "Ollama", connected: true },
      ]),
    ).toHaveLength(1);
  });
});

// ============================================================================
// URL policy boundary used by provider base-URL validation
// ============================================================================

describe("provider base-URL validation (real validator)", () => {
  it("blocks private/metadata/loopback URLs for cloud providers", () => {
    for (const url of [
      "http://169.254.169.254/latest", // cloud metadata
      "http://127.0.0.1:8080/v1", // loopback
      "http://10.0.0.5/v1", // private range
      "http://[::1]:9222/v1", // IPv6 loopback
    ]) {
      const v = validateProviderBaseUrl(url, "openai-native");
      expect(v.ok, url).toBe(false);
    }
  });

  it("rejects embedded credentials, non-HTTP schemes and malformed URLs", () => {
    expect(
      validateProviderBaseUrl(
        "https://user:secret@example.com/v1",
        "openai-native",
      ).ok,
    ).toBe(false);
    expect(
      validateProviderBaseUrl("ftp://example.com", "openai-native").ok,
    ).toBe(false);
    expect(validateProviderBaseUrl("not a url", "openai-native").ok).toBe(
      false,
    );
    expect(validateProviderBaseUrl("", "openai-native").ok).toBe(false);
  });

  it("allows loopback for LOCAL providers (the entire point of a local runtime)", () => {
    const v = validateProviderBaseUrl("http://localhost:11434", "ollama");
    expect(v.ok).toBe(true);
  });

  it("allows legitimate HTTPS cloud endpoints", () => {
    const v = validateProviderBaseUrl(
      "https://api.openai.com/v1",
      "openai-native",
    );
    expect(v.ok).toBe(true);
  });
});
