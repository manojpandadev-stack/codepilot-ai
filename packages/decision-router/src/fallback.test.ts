import { describe, expect, it } from "vitest";
import { FallbackIntentRouter } from "./fallback.js";

describe("FallbackIntentRouter", () => {
  const router = new FallbackIntentRouter();

  it.each([
    ["Create a new React component for the login form", "generate_new_code"],
    ["Implement a retry helper with exponential backoff", "generate_new_code"],
    ["Fix the TypeError when clicking submit", "debug_error"],
    ["Why is this test failing with an exception?", "debug_error"],
    ["Add unit tests for the auth module", "write_tests"],
    ["Write a test for the login flow", "write_tests"],
    ["Explain how authentication works in this file", "explain_code"],
    ["What does this regex do?", "explain_code"],
    ["Refactor the login handler to reduce duplication", "refactor"],
    ["Hi, what can you do?", "general_chat"],
  ])("classifies %j as %s", async (text, intent) => {
    const d = await router.classify({ text });
    expect(d.intent).toBe(intent);
    expect(d.source).toBe("fallback");
    expect(d.confidence).toBeGreaterThan(0);
  });

  it("flags multi-file migrations as complex", async () => {
    const d = await router.classify({
      text: "Migrate the entire codebase to ESM across all packages",
    });
    expect(d.intent).toBe("refactor");
    expect(d.complexity).toBe(2);
  });

  it("returns uncertain for empty input", async () => {
    const d = await router.classify({ text: "   " });
    expect(d.intent).toBe("uncertain");
    expect(d.reason).toBe("empty-input");
  });

  it("returns uncertain when no intent signal is present", async () => {
    const d = await router.classify({ text: "asdf qwer zxcv blorp" });
    expect(d.intent).toBe("uncertain");
    expect(d.reason).toBe("low-confidence");
  });

  it("is deterministic", async () => {
    const text = "Explain why this test fails intermittently on CI";
    const a = await router.classify({ text });
    const b = await router.classify({ text });
    expect({ ...a, latencyMs: 0 }).toEqual({ ...b, latencyMs: 0 });
    expect(a.latencyMs).toBeGreaterThanOrEqual(0);
    expect(b.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
