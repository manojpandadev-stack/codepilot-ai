/**
 * H5: provider cache identity regression tests.
 *
 * Cached provider instances must be bound to the exact credential in use:
 * rotating or revoking a key yields a different cache identity, so a stale
 * entry can never serve a new key. The identity is a truncated SHA-256 hex
 * digest — non-reversible, so raw key material never appears in cache keys,
 * logs, or errors.
 */
import { describe, expect, it } from "vitest";
import { providerCacheIdentity } from "./session.js";

describe("providerCacheIdentity", () => {
  it("is stable for identical inputs", () => {
    expect(
      providerCacheIdentity(
        "openrouter",
        "https://openrouter.ai/api/v1",
        "sk-a",
      ),
    ).toBe(
      providerCacheIdentity(
        "openrouter",
        "https://openrouter.ai/api/v1",
        "sk-a",
      ),
    );
  });

  it("changes when the credential rotates", () => {
    const before = providerCacheIdentity(
      "openrouter",
      "https://openrouter.ai/api/v1",
      "sk-old-key",
    );
    const after = providerCacheIdentity(
      "openrouter",
      "https://openrouter.ai/api/v1",
      "sk-new-key",
    );
    expect(after).not.toBe(before);
  });

  it("distinguishes absent credentials from present ones", () => {
    expect(
      providerCacheIdentity(
        "openrouter",
        "https://openrouter.ai/api/v1",
        undefined,
      ),
    ).not.toBe(
      providerCacheIdentity(
        "openrouter",
        "https://openrouter.ai/api/v1",
        "sk-a",
      ),
    );
  });

  it("participates provider id and base URL", () => {
    const base = providerCacheIdentity(
      "openrouter",
      "https://x.example",
      "sk-a",
    );
    expect(
      providerCacheIdentity("other", "https://x.example", "sk-a"),
    ).not.toBe(base);
    expect(
      providerCacheIdentity("openrouter", "https://y.example", "sk-a"),
    ).not.toBe(base);
  });

  it("never contains raw key material", () => {
    const secret = "sk-super-secret-value-abcdef123456";
    const identity = providerCacheIdentity(
      "openrouter",
      "https://x.example",
      secret,
    );
    expect(identity).not.toContain(secret);
    expect(identity).not.toContain("super-secret");
    // Still namespaced by provider for debuggability.
    expect(identity.startsWith("openrouter|")).toBe(true);
  });
});
