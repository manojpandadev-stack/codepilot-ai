/**
 * Token-budget regression tests (output-token safety).
 *
 * Root cause under test: agent turns used to send OpenAI-compatible chat
 * requests with NO max_tokens bound. Credit-checked providers then impute
 * the model's full context window as output (131072 for qwen3.6-35b-a3b)
 * and reject with HTTP 402 even for tiny prompts. These tests pin the fix:
 * every request carries an explicit bounded max_tokens derived from
 * min(configured cap, remaining context) — never the context window.
 *
 * Pure math plus loop-level request capture. No network, no model.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  TOKEN_BUDGET_SAFETY_MARGIN_TOKENS,
  estimateAgentMessageTokens,
  estimateRequestTokens,
  formatBillingFailureMessage,
  isBillingFailure,
  parseAffordableTokens,
  resolveOutputBudget,
} from "./token-budget.js";
import { runAgentLoop } from "./native/engine/agent-loop.js";
import type {
  LlmProvider,
  LlmRequest,
  LlmStreamEvent,
} from "./native/llm/types.js";
import type { AgentTool } from "./native/types.js";

const done: LlmStreamEvent = { type: "finish", reason: "complete" };

function capturingProvider(
  turns: LlmStreamEvent[][],
  seen: LlmRequest[],
): LlmProvider {
  let index = 0;
  return {
    id: "cap",
    async *stream(request: LlmRequest) {
      seen.push(request);
      yield* turns[index++] ?? [];
    },
  };
}

function loopOpts(provider: LlmProvider, extra: Record<string, unknown> = {}) {
  return {
    provider,
    modelId: "qwen/qwen3.6-35b-a3b",
    sessionId: "budget-test",
    tools: [],
    gate: async () => ({ approved: true }),
    maxIterations: 2,
    onEvent: () => {},
    ...extra,
  };
}

describe("resolveOutputBudget — the 131072 failure", () => {
  it("never emits the context window as the output budget", () => {
    const budget = resolveOutputBudget({
      contextWindowTokens: 131072,
      estimatedInputTokens: 512,
    });
    expect(budget.ok).toBe(true);
    if (!budget.ok) throw new Error("expected ok");
    expect(budget.maxTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(budget.maxTokens).not.toBe(131072);
    expect(budget.maxTokens).toBeLessThanOrEqual(8192);
  });

  it("respects an explicit configured cap", () => {
    const budget = resolveOutputBudget({
      contextWindowTokens: 131072,
      estimatedInputTokens: 512,
      configuredMaxOutputTokens: 4096,
    });
    expect(budget.ok).toBe(true);
    if (!budget.ok) throw new Error("expected ok");
    expect(budget.maxTokens).toBe(4096);
  });

  it("falls back to the default on invalid configured values", () => {
    for (const bad of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      const budget = resolveOutputBudget({
        contextWindowTokens: 131072,
        estimatedInputTokens: 100,
        configuredMaxOutputTokens: bad,
      });
      expect(budget.ok).toBe(true);
      if (budget.ok) expect(budget.maxTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    }
  });

  it("clamps to remaining context on a small window", () => {
    const budget = resolveOutputBudget({
      contextWindowTokens: 8192,
      estimatedInputTokens: 1000,
    });
    expect(budget.ok).toBe(true);
    if (!budget.ok) throw new Error("expected ok");
    expect(budget.maxTokens).toBe(
      8192 - 1000 - TOKEN_BUDGET_SAFETY_MARGIN_TOKENS,
    );
    expect(budget.boundByContext).toBe(true);
  });

  it("uses the cap on a large window", () => {
    const budget = resolveOutputBudget({
      contextWindowTokens: 200000,
      estimatedInputTokens: 5000,
    });
    expect(budget.ok).toBe(true);
    if (!budget.ok) throw new Error("expected ok");
    expect(budget.maxTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(budget.boundByContext).toBe(false);
  });

  it("clamps near-limit requests to what remains", () => {
    const budget = resolveOutputBudget({
      contextWindowTokens: 10000,
      estimatedInputTokens: 1000,
    });
    expect(budget.ok).toBe(true);
    if (!budget.ok) throw new Error("expected ok");
    expect(budget.maxTokens).toBe(
      10000 - 1000 - TOKEN_BUDGET_SAFETY_MARGIN_TOKENS,
    );
  });

  it("refuses exhausted context with an actionable error (never sends)", () => {
    const drained = resolveOutputBudget({
      contextWindowTokens: 10000,
      estimatedInputTokens: 9500,
    });
    expect(drained.ok).toBe(false);
    if (drained.ok) throw new Error("expected error");
    expect(drained.reason).toBe("context-exhausted");
    expect(drained.message).toMatch(/9,500|9500/);
    expect(drained.message).toMatch(/[Cc]ompact|shorten/);

    const exact = resolveOutputBudget({
      contextWindowTokens: 2048,
      estimatedInputTokens: 1024,
      safetyMarginTokens: 1024,
    });
    expect(exact.ok).toBe(false);
  });

  it("bounds requests when window metadata is missing", () => {
    for (const window of [undefined, 0, -5, Number.NaN]) {
      const budget = resolveOutputBudget({
        contextWindowTokens: window,
        estimatedInputTokens: 300,
      });
      expect(budget.ok).toBe(true);
      if (budget.ok) expect(budget.maxTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    }
  });

  it("honors a custom safety margin", () => {
    const budget = resolveOutputBudget({
      contextWindowTokens: 10000,
      estimatedInputTokens: 1000,
      safetyMarginTokens: 0,
    });
    expect(budget.ok).toBe(true);
    if (budget.ok) expect(budget.maxTokens).toBe(8192);
  });
});

describe("request token estimation", () => {
  it("estimates plain text at chars/4", () => {
    expect(
      estimateAgentMessageTokens({ role: "user", content: "abcdefgh" }),
    ).toBe(2);
    expect(estimateAgentMessageTokens({ role: "user", content: "" })).toBe(0);
  });

  it("counts blocks, tool payloads, and images without reading semantics", () => {
    const tokens = estimateAgentMessageTokens({
      role: "assistant",
      content: [
        { type: "text", text: "abcd" },
        {
          type: "tool_use",
          id: "1",
          name: "read_files",
          input: { path: "a.ts" },
        },
        {
          type: "tool_result",
          tool_use_id: "1",
          name: "read_files",
          content: "efgh",
        },
        { type: "image", mime: "image/png", dataBase64: "aGVsbG8=" },
      ],
    });
    expect(tokens).toBeGreaterThan(2);
    expect(Number.isInteger(tokens)).toBe(true);
  });

  it("includes system prompt and serialized tool definitions", () => {
    const tools = [
      {
        name: "read_files",
        description: "read a file",
        inputSchema: { type: "object" },
        execute: async () => "ok",
      },
    ] as AgentTool[];
    const withTools = estimateRequestTokens(
      [{ role: "user", content: "hi" }],
      "system prompt here",
      tools,
    );
    const bare = estimateRequestTokens([{ role: "user", content: "hi" }]);
    expect(withTools).toBeGreaterThan(bare);
  });
});

describe("agent loop carries a bounded maxTokens", () => {
  const textTurn: LlmStreamEvent[][] = [
    [{ type: "text-delta", text: "ok" }, done],
  ];

  it("sends the default bound with model/provider/temperature/tools intact", async () => {
    const seen: LlmRequest[] = [];
    const tools = [
      {
        name: "read_files",
        description: "r",
        inputSchema: { type: "object", properties: {} },
        execute: async () => "ok",
      },
    ] as AgentTool[];
    const result = await runAgentLoop(
      [],
      "hi",
      loopOpts(capturingProvider(textTurn, seen), {
        tools,
        temperature: 0.3,
        modelContextWindow: 131072,
      }),
    );
    expect(result.reason).toBe("complete");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.maxTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(seen[0]?.maxTokens).not.toBe(131072);
    expect(seen[0]?.modelId).toBe("qwen/qwen3.6-35b-a3b");
    expect(seen[0]?.providerId).toBe("cap");
    expect(seen[0]?.temperature).toBe(0.3);
    expect(seen[0]?.tools).toEqual(tools);
  });

  it("never emits 131072 for the exact live failure shape", async () => {
    const seen: LlmRequest[] = [];
    await runAgentLoop(
      [],
      "Fix calc.js",
      loopOpts(capturingProvider(textTurn, seen), {
        modelContextWindow: 131072,
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.maxTokens).toBeLessThanOrEqual(8192);
  });

  it("honors a configured cap through the loop", async () => {
    const seen: LlmRequest[] = [];
    await runAgentLoop(
      [],
      "hi",
      loopOpts(capturingProvider(textTurn, seen), {
        maxOutputTokens: 2048,
        modelContextWindow: 131072,
      }),
    );
    expect(seen[0]?.maxTokens).toBe(2048);
  });

  it("fails closed without calling the provider when context is exhausted", async () => {
    const seen: LlmRequest[] = [];
    const huge = "x".repeat(200 * 1024);
    const result = await runAgentLoop(
      [],
      huge,
      loopOpts(capturingProvider(textTurn, seen), {
        modelContextWindow: 8192,
      }),
    );
    expect(result.reason).toBe("error");
    expect(result.error).toMatch(/Context limit reached/);
    expect(seen).toHaveLength(0);
  });
});

describe("billing failure classification", () => {
  it("recognizes 402-class failures and never retries them", async () => {
    const billing = [
      new Error(
        '[openrouter] chat failed 402: {"error":{"message":"insufficient credits"}}',
      ),
      new Error("HTTP 402 Payment Required"),
      new Error("insufficient credit balance"),
      "available credit could only afford 11247 tokens",
      new Error("request exceeds billing credit quota"),
    ];
    for (const err of billing) {
      expect(isBillingFailure(err)).toBe(true);
    }
  });

  it("does not misclassify auth/rate-limit/timeout/plain errors as billing", () => {
    expect(isBillingFailure(new Error("401 Unauthorized"))).toBe(false);
    expect(isBillingFailure(new Error("429 Too Many Requests"))).toBe(false);
    expect(isBillingFailure(new Error("timed out after 30000ms"))).toBe(false);
    expect(isBillingFailure(new Error("something unexpected"))).toBe(false);
    expect(isBillingFailure(null)).toBe(false);
  });

  it("parses the affordable-token figure when reported", () => {
    expect(
      parseAffordableTokens("available credit could only afford 11247 tokens"),
    ).toBe(11247);
    expect(
      parseAffordableTokens(
        "could only afford 1,234,567 tokens for this request",
      ),
    ).toBe(1234567);
    expect(parseAffordableTokens("HTTP 402 Payment Required")).toBeUndefined();
  });

  it("formats the exact actionable message without secrets", () => {
    const message = formatBillingFailureMessage({
      providerLabel: "OpenRouter",
      affordableTokens: 11247,
    });
    expect(message).toContain("OpenRouter rejected this request");
    expect(message).toContain("exceeds the available credits");
    expect(message).toContain("11,247");
    expect(message).toContain("sufficient credits");
    expect(message).not.toContain("sk-");
    const bare = formatBillingFailureMessage({});
    expect(bare).toContain("The provider rejected this request");
  });
});
