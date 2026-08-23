import { describe, it, expect } from "vitest";
import { ContextEngine, estimateTokens, estimateObjectTokens } from "./index.js";

describe("estimateTokens", () => {
  it("estimates tokens for simple text", () => {
    // ~4 chars per token
    expect(estimateTokens("hello")).toBe(2); // 5 chars / 4 = 1.25, ceil = 2
    expect(estimateTokens("abcd")).toBe(1); // exactly 4 chars
    expect(estimateTokens("")).toBe(0);
  });

  it("scales linearly with text length", () => {
    const short = estimateTokens("test");
    const long = estimateTokens("test".repeat(10));
    expect(long).toBe(short * 10);
  });
});

describe("estimateObjectTokens", () => {
  it("estimates tokens for a JSON-serializable object", () => {
    const tokens = estimateObjectTokens({ key: "value" });
    expect(tokens).toBeGreaterThan(0);
  });

  it("larger objects produce more tokens", () => {
    const small = estimateObjectTokens({ a: 1 });
    const large = estimateObjectTokens({ a: "x".repeat(1000) });
    expect(large).toBeGreaterThan(small);
  });
});

describe("ContextEngine", () => {
  it("creates with default options", () => {
    const engine = new ContextEngine();
    const stats = engine.getStats();
    expect(stats.maxTokens).toBe(128_000);
    expect(stats.reservedTokens).toBe(32_000); // 25% of 128K
    expect(stats.availableTokens).toBe(96_000);
  });

  it("creates with custom options", () => {
    const engine = new ContextEngine({ maxTokens: 32_000, responseReserveFraction: 0.5 });
    const stats = engine.getStats();
    expect(stats.maxTokens).toBe(32_000);
    expect(stats.reservedTokens).toBe(16_000);
    expect(stats.availableTokens).toBe(16_000);
  });

  it("buildContext selects high-priority items first", () => {
    const engine = new ContextEngine({ maxTokens: 1000 });
    const items = [
      { source: "repository_structure" as const, content: "low priority", priority: 1, estimatedTokens: 100 },
      { source: "user_request" as const, content: "high priority", priority: 10, estimatedTokens: 100 },
      { source: "current_file" as const, content: "medium priority", priority: 5, estimatedTokens: 100 },
    ];

    const result = engine.buildContext(items);
    expect(result.context.length).toBe(3);
    expect(result.context[0]!.source).toBe("user_request");
    expect(result.context[1]!.source).toBe("current_file");
    expect(result.context[2]!.source).toBe("repository_structure");
  });

  it("buildContext drops items below min priority", () => {
    const engine = new ContextEngine({ maxTokens: 1000, minPriority: 5 });
    const items = [
      { source: "user_request" as const, content: "keep", priority: 10, estimatedTokens: 100 },
      { source: "memory" as const, content: "drop", priority: 2, estimatedTokens: 100 },
    ];

    const result = engine.buildContext(items);
    expect(result.context.length).toBe(1);
    expect(result.context[0]!.content).toBe("keep");
  });

  it("buildContext respects budget limits", () => {
    const engine = new ContextEngine({ maxTokens: 500, responseReserveFraction: 0.25 });
    // Budget = 500 - 125 = 375 tokens
    const items = [
      { source: "user_request" as const, content: "a", priority: 10, estimatedTokens: 200 },
      { source: "current_file" as const, content: "b", priority: 9, estimatedTokens: 200 },
    ];

    const result = engine.buildContext(items);
    expect(result.totalTokens).toBeLessThanOrEqual(375);
    expect(result.budgetRemaining).toBeGreaterThanOrEqual(0);
  });

  it("buildContext deduplicates items with same content prefix", () => {
    const engine = new ContextEngine({ maxTokens: 10_000 });
    const items = [
      { source: "user_request" as const, content: "same content here for testing dedup".repeat(10), priority: 10, estimatedTokens: 100 },
      { source: "current_file" as const, content: "same content here for testing dedup".repeat(10), priority: 9, estimatedTokens: 100 },
      { source: "memory" as const, content: "different content", priority: 8, estimatedTokens: 100 },
    ];

    const result = engine.buildContext(items);
    // The first two have same prefix → deduplicated
    expect(result.context.length).toBe(2);
  });

  it("compress truncates low-priority items first", () => {
    const engine = new ContextEngine();
    const items = [
      { source: "user_request" as const, content: "x".repeat(4000), priority: 10, estimatedTokens: 1000 },
      { source: "memory" as const, content: "y".repeat(4000), priority: 1, estimatedTokens: 1000 },
    ];

    const compressed = engine.compress(items, 1000);
    const totalTokens = compressed.reduce((sum, item) => sum + item.estimatedTokens, 0);
    expect(totalTokens).toBeLessThanOrEqual(1200); // some slack for truncation overhead
  });

  it("wouldOverflow detects when context exceeds budget", () => {
    const engine = new ContextEngine({ maxTokens: 1000, responseReserveFraction: 0.25 });
    // reservedTokens = floor(1000 * 0.25) = 250
    expect(engine.wouldOverflow(800)).toBe(true);   // 800 + 250 = 1050 > 1000 → overflow
    expect(engine.wouldOverflow(700)).toBe(false);   // 700 + 250 = 950  < 1000 → ok
    expect(engine.wouldOverflow(500)).toBe(false);   // 500 + 250 = 750  < 1000 → ok
  });

  it("estimateMessageTokens sums up message tokens", () => {
    const engine = new ContextEngine();
    const tokens = engine.estimateMessageTokens([
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ]);
    expect(tokens).toBeGreaterThan(0);
  });
});
