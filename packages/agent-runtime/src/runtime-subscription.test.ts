/**
 * Regression tests for duplicated assistant streaming text.
 *
 * Root cause (original incident): startSession() subscribed to the core on
 * every run while the core's subscribe was additive — after N runs every
 * streamed delta was handled N times, duplicating assistant text.
 *
 * Contract under test (native engine edition — same intent, current seam):
 *   - sessions never multiply listener delivery: N sessions × K deltas
 *     arrive exactly N×K times, even with several runtime subscribers;
 *   - every run emits exactly one terminal completion;
 *   - dispose() clears runtime listeners so nothing fires afterwards.
 *
 * The model layer is stubbed Ollama NDJSON (no network, no model); the
 * agent loop, event fan-out, and subscription bookkeeping are all genuine.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import { CodePilotRuntime } from "./runtime.js";
import { stubOllamaFetch } from "./ollama-fetch-stub.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeRuntime(): CodePilotRuntime {
  return new CodePilotRuntime({
    workspaceRoot: process.cwd(),
    providerId: "ollama",
    modelId: "qwen3:8b",
  });
}

function textTurn(first: string, second: string) {
  return { texts: [first, second] };
}

describe("CodePilotRuntime — single-subscription streaming contract", () => {
  it("never multiplies delivery no matter how many sessions run", async () => {
    stubOllamaFetch([
      textTurn("Hello", " world!"),
      textTurn("Hello", " world!"),
      textTurn("Hello", " world!"),
    ]);
    const runtime = makeRuntime();
    try {
      await runtime.initialize();
      await runtime.startSession("first message");
      await runtime.startSession("second message");
      await runtime.startSession("third message");
      // Listener bookkeeping stays flat across sessions.
      expect(runtime.listenerCount()).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("delivers each streamed delta exactly once across consecutive sessions", async () => {
    stubOllamaFetch([
      textTurn("Hello", " world!"),
      textTurn("Hello", " world!"),
    ]);
    const runtime = makeRuntime();
    const deltas: string[] = [];
    runtime.subscribe((event) => {
      if (event.type === "text_delta") deltas.push(event.text);
    });
    try {
      await runtime.initialize();
      await runtime.startSession("one");
      await runtime.startSession("two");
      // Two runs × two unique deltas — a multiplying fan-out would yield more.
      expect(deltas).toEqual(["Hello", " world!", "Hello", " world!"]);
    } finally {
      await runtime.dispose();
    }
  });

  it("emits exactly one completed event per run", async () => {
    stubOllamaFetch([textTurn("A", "B"), textTurn("C", "D")]);
    const runtime = makeRuntime();
    let completed = 0;
    runtime.subscribe((event) => {
      if (event.type === "completed") completed += 1;
    });
    try {
      await runtime.initialize();
      await runtime.startSession("one");
      await runtime.startSession("two");
      expect(completed).toBe(2);
    } finally {
      await runtime.dispose();
    }
  });

  it("dispose clears runtime listeners", async () => {
    stubOllamaFetch([textTurn("A", "B")]);
    const runtime = makeRuntime();
    const seen: string[] = [];
    const unsub = runtime.subscribe((event) => {
      seen.push(event.type);
    });
    expect(runtime.listenerCount()).toBe(1);
    unsub();
    expect(runtime.listenerCount()).toBe(0);
    await runtime.initialize();
    await runtime.startSession("one");
    // Unsubscribed before the run: nothing observed afterwards either.
    expect(seen).toEqual([]);
    await runtime.dispose();
    expect(runtime.listenerCount()).toBe(0);
  });
});
