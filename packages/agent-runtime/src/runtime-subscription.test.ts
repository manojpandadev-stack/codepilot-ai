/**
 * Regression tests for duplicated assistant streaming text.
 *
 * Root cause: CodePilotRuntime.startSession() called cline.subscribe() on every
 * run. ClineCore's subscribe REGISTERS an additional listener each call
 * (additive semantics) — so after N messages every streamed delta was handled N
 * times, duplicating assistant text ("File File File…").
 *
 * Contract under test:
 *   - exactly ONE core listener exists regardless of how many sessions run;
 *   - every delta is delivered exactly once per run;
 *   - dispose() removes the core listener.
 */
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  /** Faithful mimic of ClineCore's additive subscribe + run lifecycle. */
  class FakeClineCore {
    readonly listeners: Array<(event: Record<string, unknown>) => void> = [];
    started = 0;

    subscribe(listener: (event: Record<string, unknown>) => void): () => void {
      this.listeners.push(listener);
      const index = this.listeners.indexOf(listener);
      return () => {
        if (this.listeners.indexOf(listener) >= 0) {
          this.listeners.splice(
            index >= 0 ? this.listeners.indexOf(listener) : index,
            1,
          );
        }
      };
    }

    /** One run = two unique text deltas + done, fanned out to ALL listeners. */
    async start(): Promise<{
      sessionId: string;
      result: {
        outputText: string;
        usage: { inputTokens: number; outputTokens: number };
      };
    }> {
      this.started += 1;
      const sessionId = `session-${this.started}`;
      const deltas = ["Hello", " world!"];
      let accumulated = "";
      for (const listener of [...this.listeners]) {
        for (const text of deltas) {
          accumulated += text;
          listener({
            type: "agent_event",
            payload: {
              sessionId,
              event: {
                type: "content_start",
                contentType: "text",
                text,
                accumulated,
              },
            },
          });
        }
        listener({
          type: "agent_event",
          payload: {
            sessionId,
            event: { type: "done", reason: "completed", text: accumulated },
          },
        });
      }
      return {
        sessionId,
        result: {
          outputText: accumulated,
          usage: { inputTokens: 3, outputTokens: 5 },
        },
      };
    }

    async send(): Promise<void> {}
    async abort(): Promise<void> {}
    async stop(): Promise<void> {}
    async dispose(): Promise<void> {}
  }
  return {
    FakeClineCore,
    instances: [] as InstanceType<typeof FakeClineCore>[],
  };
});

vi.mock("@cline/core", () => ({
  ClineCore: {
    create: async () => {
      const instance = new h.FakeClineCore();
      h.instances.push(instance);
      return instance;
    },
  },
}));

import { CodePilotRuntime } from "./runtime.js";

function makeRuntime(): CodePilotRuntime {
  return new CodePilotRuntime({
    workspaceRoot: process.cwd(),
    providerId: "ollama",
    modelId: "qwen3:8b",
  });
}

describe("CodePilotRuntime — single-subscription streaming contract", () => {
  it("registers exactly ONE ClineCore listener no matter how many sessions run", async () => {
    const runtime = makeRuntime();
    try {
      await runtime.initialize();
      await runtime.startSession("first message");
      await runtime.startSession("second message");
      await runtime.startSession("third message");
      expect(h.instances[0]?.listeners.length).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("delivers each streamed delta exactly once across consecutive sessions", async () => {
    const runtime = makeRuntime();
    const deltas: string[] = [];
    runtime.subscribe((event) => {
      if (event.type === "text_delta") deltas.push(event.text);
    });
    try {
      await runtime.initialize();
      await runtime.startSession("one");
      await runtime.startSession("two");
      // Two runs × two unique deltas — duplicated listener would yield 8 entries.
      expect(deltas).toEqual(["Hello", " world!", "Hello", " world!"]);
    } finally {
      await runtime.dispose();
    }
  });

  it("emits exactly one completed event per run", async () => {
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

  it("dispose removes the core listener", async () => {
    const runtime = makeRuntime();
    await runtime.initialize();
    const core = h.instances[h.instances.length - 1];
    expect(core?.listeners.length).toBe(1);
    await runtime.dispose();
    expect(core?.listeners.length).toBe(0);
  });
});
