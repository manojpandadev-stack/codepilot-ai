/**
 * Tests for provider configuration helpers: validation, resolution and
 * environment-based API key handling. No network access.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILTIN_PROVIDER_DEFAULTS,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  OLLAMA_DEFAULT_BASE_URL,
  apiKeyFromEnv,
  resolveProviderConfig,
  validateProviderConfig,
} from "./config.js";

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (originalEnv[key] === undefined) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe("validateProviderConfig", () => {
  it("accepts a valid Ollama config", () => {
    const result = validateProviderConfig({
      id: "ollama",
      name: "Ollama (Local)",
      type: "ollama",
      baseUrl: OLLAMA_DEFAULT_BASE_URL,
      enabled: true,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts a valid openai-compatible config", () => {
    const result = validateProviderConfig({
      id: "openai-compatible",
      name: "My Gateway",
      type: "openai-compatible",
      baseUrl: "https://llm.example.com/v1",
      enabled: true,
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("rejects an openai-compatible config without a baseUrl", () => {
    const result = validateProviderConfig({
      id: "openai-compatible",
      name: "Broken",
      type: "openai-compatible",
      enabled: true,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("baseUrl");
  });

  it("rejects a baseUrl that is not http(s)", () => {
    const result = validateProviderConfig({
      id: "openai-compatible",
      name: "Broken",
      type: "openai-compatible",
      baseUrl: "ftp://llm.example.com/v1",
      enabled: true,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("http:// or https://");
  });

  it("warns about unencrypted http:// for non-localhost endpoints", () => {
    const result = validateProviderConfig({
      id: "openai-compatible",
      name: "Insecure",
      type: "openai-compatible",
      baseUrl: "http://192.168.1.50:8000/v1",
      enabled: true,
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.join(" ")).toContain("unencrypted http://");
  });

  it("does not warn about http:// on localhost", () => {
    const result = validateProviderConfig({
      id: "ollama",
      name: "Ollama (Local)",
      type: "openai-compatible",
      baseUrl: "http://localhost:11434",
      enabled: true,
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("rejects a non-positive timeoutMs", () => {
    const result = validateProviderConfig({
      id: "ollama",
      name: "Ollama (Local)",
      type: "ollama",
      timeoutMs: 0,
      enabled: true,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("timeoutMs");
  });

  it("rejects an empty provider id and name", () => {
    const result = validateProviderConfig({
      id: "  ",
      name: "",
      type: "ollama",
      enabled: true,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("id");
    expect(result.errors.join(" ")).toContain("name");
  });
});

describe("resolveProviderConfig", () => {
  it("merges Ollama partial config with built-in defaults", () => {
    const config = resolveProviderConfig({
      id: "ollama",
      type: "ollama",
    });
    expect(config.baseUrl).toBe(OLLAMA_DEFAULT_BASE_URL);
    expect(config.name).toBe("Ollama (Local)");
    expect(config.enabled).toBe(true);
    expect(config.timeoutMs).toBe(DEFAULT_PROVIDER_TIMEOUT_MS);
    expect(config.apiKey).toBeUndefined();
  });

  it("merges OpenAI partial config with cloud defaults", () => {
    const config = resolveProviderConfig({
      id: "openai",
      type: "openai",
    });
    expect(config.baseUrl).toBe("https://api.openai.com/v1");
    expect(config.defaultModelId).toBe("gpt-4o-mini");
    expect(config.enabled).toBe(false);
  });

  it("falls back to sensible defaults for custom providers", () => {
    const config = resolveProviderConfig({
      id: "my-custom",
      type: "custom",
    });
    expect(config.name).toBe("my-custom");
    expect(config.enabled).toBe(true);
    expect(config.timeoutMs).toBe(DEFAULT_PROVIDER_TIMEOUT_MS);
  });

  it("preserves explicitly-provided fields", () => {
    const config = resolveProviderConfig({
      id: "ollama",
      type: "ollama",
      baseUrl: "http://localhost:11435",
      timeoutMs: 30_000,
      apiKey: "a-secret",
    });
    expect(config.baseUrl).toBe("http://localhost:11435");
    expect(config.timeoutMs).toBe(30_000);
    expect(config.apiKey).toBe("a-secret");
  });

  it("does not clobber defaults with undefined overrides", () => {
    const config = resolveProviderConfig({
      id: "ollama",
      type: "ollama",
      name: undefined,
      enabled: undefined,
      timeoutMs: undefined,
    });
    expect(config.name).toBe(BUILTIN_PROVIDER_DEFAULTS.ollama.name);
    expect(config.enabled).toBe(true);
    expect(config.timeoutMs).toBe(DEFAULT_PROVIDER_TIMEOUT_MS);
  });
});

describe("apiKeyFromEnv", () => {
  it("returns the trimmed value of a well-known env var", () => {
    process.env.OPENAI_API_KEY = "  sk-env-secret-1 ";
    expect(apiKeyFromEnv("openai")).toBe("sk-env-secret-1");
  });

  it("returns undefined when the env var is unset", () => {
    delete process.env.OPENAI_API_KEY;
    expect(apiKeyFromEnv("openai")).toBeUndefined();
  });

  it("returns undefined for providers without an env var mapping", () => {
    expect(apiKeyFromEnv("ollama")).toBeUndefined();
    expect(apiKeyFromEnv("openai-compatible")).toBeUndefined();
  });

  it("never throws", () => {
    process.env.OPENAI_API_KEY = "  ";
    expect(apiKeyFromEnv("openai")).toBeUndefined();
  });
});
