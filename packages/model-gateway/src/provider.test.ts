/**
 * Tests for provider core types: default capability sets, error normalization
 * and secret redaction. No network access.
 */
import { describe, expect, it } from "vitest";
import {
  defaultCapabilitySet,
  normalizeProviderError,
  redactSecrets,
} from "./provider.js";
import type { ProviderErrorCode } from "./provider.js";

describe("defaultCapabilitySet", () => {
  it("returns conservative defaults for an unknown model", () => {
    const caps = defaultCapabilitySet();
    expect(caps.streaming).toBe(true);
    expect(caps.tools).toBe(false);
    expect(caps.vision).toBe(false);
    expect(caps.structuredOutput).toBe(false);
    expect(caps.embeddings).toBe(false);
    expect(caps.reasoning).toBe(false);
    expect(caps.functionCalling).toBe(false);
    expect(caps.contextWindow).toBe(4096);
    expect(caps.maxOutputTokens).toBeNull();
    expect(caps.estimatedMemoryMB).toBeNull();
    expect(caps.codingCapability).toBe("unknown");
    expect(caps.recommendedFor).toEqual([]);
    expect(caps.parameterSize).toBeNull();
  });

  it("merges overrides over the defaults", () => {
    const caps = defaultCapabilitySet({ tools: true, contextWindow: 32768 });
    expect(caps.tools).toBe(true);
    expect(caps.contextWindow).toBe(32768);
    // untouched fields keep conservative defaults
    expect(caps.vision).toBe(false);
    expect(caps.embeddings).toBe(false);
  });
});

describe("normalizeProviderError", () => {
  const cases: Array<[string, ProviderErrorCode, boolean]> = [
    // authentication
    ["Unauthorized: invalid api key", "AUTHENTICATION", false],
    ["HTTP 401 Unauthorized", "AUTHENTICATION", false],
    ["Authentication failed for provider", "AUTHENTICATION", false],
    // authorization
    ["HTTP 403 Forbidden", "AUTHORIZATION", false],
    ["forbidden: access denied", "AUTHORIZATION", false],
    // rate limit
    ["HTTP 429 rate limit exceeded", "RATE_LIMIT", false],
    ["Too many requests, slow down", "RATE_LIMIT", false],
    // invalid request
    ["HTTP 400 invalid request", "INVALID_REQUEST", false],
    ["invalid_request_error: bad schema", "INVALID_REQUEST", false],
    ["Bad Request", "INVALID_REQUEST", false],
    // timeout
    ["request timed out after 10000ms", "TIMEOUT", true],
    ["connect ETIMEDOUT", "TIMEOUT", true],
    // network / transient
    ["connect ECONNREFUSED 127.0.0.1:11434", "NETWORK", true],
    ["socket hang up", "NETWORK", true],
    ["HTTP 503 service unavailable", "NETWORK", true],
    ["HTTP 502 bad gateway", "NETWORK", true],
    ["fetch failed: network error", "NETWORK", true],
    // model not found
    ["model not found: qwen3:8b", "MODEL_NOT_FOUND", false],
    ["HTTP 404 Not Found", "MODEL_NOT_FOUND", false],
    ["no such model llama3:70b", "MODEL_NOT_FOUND", false],
    // cancellation
    ["The operation was cancelled", "CANCELLED", false],
    ["Request aborted", "CANCELLED", false],
    // unsupported capability
    ["model does not support vision input", "UNSUPPORTED_CAPABILITY", false],
    ["unsupported parameter 'temperature'", "UNSUPPORTED_CAPABILITY", false],
    // provider unavailable
    ["provider unavailable: ollama not running", "PROVIDER_UNAVAILABLE", true],
    ["No providers available for routing", "PROVIDER_UNAVAILABLE", true],
    // stream interrupted
    ["stream interrupted mid-response", "STREAM_INTERRUPTED", true],
  ];

  it.each(cases)(
    "maps %j to %s (retryable=%s)",
    (message, expectedCode, expectedRetryable) => {
      const err = new Error(message);
      const normalized = normalizeProviderError(err, "test-provider");
      expect(normalized.code).toBe(expectedCode);
      expect(normalized.retryable).toBe(expectedRetryable);
      expect(normalized.message).toContain("[test-provider]");
    },
  );

  it("handles non-Error thrown values", () => {
    const normalized = normalizeProviderError("boom", "ollama");
    expect(normalized.code).toBe("UNKNOWN");
    expect(normalized.retryable).toBe(false);
  });

  it("attaches the original cause", () => {
    const cause = new Error("original");
    const normalized = normalizeProviderError(cause, "ollama");
    expect(normalized.cause).toBe(cause);
  });

  it("never includes secrets in the surfaced message", () => {
    const msg =
      "Invalid API key: apiKey=sk-super-secret-123 with token 'secret-token'";
    const normalized = normalizeProviderError(msg, "openai");
    expect(normalized.message).not.toContain("sk-super-secret");
    expect(normalized.message).not.toContain("secret-token");
    expect(normalized.technicalDetail).not.toContain("sk-super-secret");
  });
});

describe("redactSecrets", () => {
  it("redacts inline apiKey= values", () => {
    const redacted = redactSecrets("apiKey=sk-abc123");
    expect(redacted).not.toContain("sk-abc123");
    expect(redacted.toLowerCase()).toContain("<redacted>");
  });

  it("redacts Authorization / Bearer tokens", () => {
    const redacted = redactSecrets("Authorization: Bearer sk-proj-abcdef");
    expect(redacted).not.toContain("sk-proj-abcdef");
    expect(redacted.toLowerCase()).toContain("<redacted>");
  });

  it("redacts bare sk- keys", () => {
    const redacted = redactSecrets("key: sk-live-999999");
    expect(redacted).not.toContain("sk-live-999999");
  });

  it("returns the input unchanged when nothing sensitive is present", () => {
    expect(redactSecrets("all good here")).toBe("all good here");
  });
});
