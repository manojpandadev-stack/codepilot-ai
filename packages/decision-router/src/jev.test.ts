import { describe, expect, it, vi } from "vitest";
import { INTENT_KINDS } from "./intent.js";
import { JevIntentRouter, type JevSystemOneLike } from "./jev.js";

function probabilitiesFor(
  winner: string,
  winnerProb = 0.7,
): Record<string, number> {
  const rest = (1 - winnerProb) / (INTENT_KINDS.length - 1);
  const out: Record<string, number> = {};
  for (const intent of INTENT_KINDS) {
    out[intent] = intent === winner ? winnerProb : rest;
  }
  return out;
}

function jevSuccessResponse(intent: string, confidence = 0.87, score = 1.2) {
  return {
    model: "jev-1.13.0",
    answers: {
      intent: {
        type: "choice",
        choice: intent,
        confidence,
        probabilities: probabilitiesFor(intent),
      },
      complexity: {
        type: "score",
        score,
        confidence: 0.7,
        legend: { "0": "simple", "1": "moderate", "2": "complex" },
        probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 },
      },
    },
    usage: { input_tokens: 100, output_tokens: 10 },
  };
}

function routerWith(mock: JevSystemOneLike, extra?: { threshold?: number }) {
  return new JevIntentRouter(
    {
      apiKey: "sk-test-not-real",
      ...(extra?.threshold !== undefined
        ? { confidenceThreshold: extra.threshold }
        : {}),
    },
    mock,
  );
}

describe("JevIntentRouter", () => {
  it("requires an API key", () => {
    expect(() => new JevIntentRouter({ apiKey: "" })).toThrow();
    expect(() => new JevIntentRouter({ apiKey: "   " })).toThrow();
  });

  it.each([...INTENT_KINDS])("maps a confident %s answer", async (intent) => {
    const mock = vi.fn(async () => jevSuccessResponse(intent));
    const d = await routerWith(mock).classify({ text: "do the thing" });
    expect(d.intent).toBe(intent);
    expect(d.source).toBe("jev");
    expect(d.confidence).toBe(0.87);
    expect(d.complexity).toBe(1);
    expect(d.modelId).toBe("jev-1.13.0");
    expect(typeof d.latencyMs).toBe("number");
  });

  it("rounds complexity to the nearest level", async () => {
    const mock = vi.fn(async () => jevSuccessResponse("refactor", 0.9, 1.8));
    const d = await routerWith(mock).classify({ text: "refactor x" });
    expect(d.complexity).toBe(2);
  });

  it("sends the request text and mode as state (truncated)", async () => {
    const mock = vi.fn(async () => jevSuccessResponse("general_chat"));
    await routerWith(mock).classify({ text: "hello", mode: "act" });
    expect(mock).toHaveBeenCalledTimes(1);
    const firstCall = mock.mock.calls[0] as
      | [
          { state: unknown; questions: unknown; model?: string },
          { signal?: AbortSignal; timeout?: number },
        ]
      | undefined;
    expect(firstCall).toBeDefined();
    const [request, options] = firstCall as [
      { state: unknown; questions: unknown; model?: string },
      { signal?: AbortSignal; timeout?: number },
    ];
    expect(request.model).toBe("jev-latest");
    expect(request.state).toEqual({ request: "hello", mode: "act" });
    expect(options.timeout).toBe(8000);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const questions = request.questions as Record<string, { type: string }>;
    expect(questions["intent"]?.type).toBe("choice");
    expect(questions["complexity"]?.type).toBe("score");
  });

  it("treats an unknown choice as invalid", async () => {
    const mock = vi.fn(async () =>
      jevSuccessResponse("delete_everything", 0.99),
    );
    const d = await routerWith(mock).classify({ text: "hi" });
    expect(d.intent).toBe("uncertain");
    expect(d.reason).toBe("invalid-response");
  });

  it("treats malformed shapes as invalid", async () => {
    const bad = [
      {},
      { answers: null },
      { answers: { intent: null, complexity: null } },
      {
        answers: {
          intent: { type: "choice", choice: "debug_error" },
          complexity: { type: "score", score: 1, confidence: 0.5 },
        },
      },
      {
        answers: {
          intent: {
            type: "choice",
            choice: "debug_error",
            confidence: "high",
            probabilities: probabilitiesFor("debug_error"),
          },
          complexity: { type: "score", score: 1, confidence: 0.5 },
        },
      },
      {
        answers: {
          intent: {
            type: "choice",
            choice: "debug_error",
            confidence: 0.9,
            probabilities: { debug_error: 1.5, other: 0.5 },
          },
          complexity: { type: "score", score: 1, confidence: 0.5 },
        },
      },
    ];
    for (const response of bad) {
      const mock = vi.fn(async () => response);
      const d = await routerWith(mock).classify({ text: "hi" });
      expect(d.intent).toBe("uncertain");
      expect(d.reason).toBe("invalid-response");
    }
  });

  it("treats low confidence as uncertain", async () => {
    const mock = vi.fn(async () => jevSuccessResponse("debug_error", 0.2));
    const d = await routerWith(mock).classify({ text: "maybe fix this" });
    expect(d.intent).toBe("uncertain");
    expect(d.reason).toBe("low-confidence");
  });

  it("honors a custom confidence threshold", async () => {
    const mock = vi.fn(async () => jevSuccessResponse("debug_error", 0.87));
    const d = await routerWith(mock, { threshold: 0.9 }).classify({
      text: "fix this",
    });
    expect(d.intent).toBe("uncertain");
    expect(d.reason).toBe("low-confidence");
  });

  it("falls back on timeout", async () => {
    const mock = vi.fn(
      async () => new Promise((resolve) => setTimeout(resolve, 5000)),
    );
    const router = new JevIntentRouter(
      { apiKey: "sk-test", timeoutMs: 15 },
      mock,
    );
    const d = await router.classify({ text: "do something slow" });
    expect(d.intent).toBe("uncertain");
    expect(d.reason).toBe("timeout");
    expect(d.latencyMs ?? 0).toBeLessThan(3000);
  });

  it("falls back when the service is unavailable", async () => {
    const mock = vi.fn(async () => {
      throw new Error("boom");
    });
    const d = await routerWith(mock).classify({ text: "hi" });
    expect(d.intent).toBe("uncertain");
    expect(d.reason).toBe("unavailable");
  });

  it("resolves uncertain on abort without calling the service", async () => {
    const mock = vi.fn(async () => jevSuccessResponse("debug_error"));
    const controller = new AbortController();
    controller.abort();
    const d = await routerWith(mock).classify(
      { text: "hi" },
      { signal: controller.signal },
    );
    expect(d.intent).toBe("uncertain");
    expect(d.reason).toBe("aborted");
    expect(mock).not.toHaveBeenCalled();
  });

  it("resolves uncertain for empty input without calling the service", async () => {
    const mock = vi.fn(async () => jevSuccessResponse("debug_error"));
    const d = await routerWith(mock).classify({ text: "  " });
    expect(d.intent).toBe("uncertain");
    expect(d.reason).toBe("empty-input");
    expect(mock).not.toHaveBeenCalled();
  });
});
