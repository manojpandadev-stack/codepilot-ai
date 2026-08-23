import { describe, expect, it } from "vitest";
import { mapCoreEvent } from "./core-event-mapper.js";

/**
 * Payloads below are REAL events captured from @cline/core@0.0.75 running
 * against local Ollama (qwen3:8b) — see scripts/probe-cline-ollama.ts and
 * scripts/probe-cline-tools.ts.
 */

describe("mapCoreEvent — real ClineCore contract", () => {
  it("maps a text content_start into a text_delta with accumulated text", () => {
    const mapped = mapCoreEvent({
      type: "agent_event",
      payload: {
        sessionId: "s1",
        event: {
          type: "content_start",
          contentType: "text",
          text: "Hello, I",
          accumulated: "Hello, I",
        },
      },
    });
    expect(mapped.events).toEqual([
      { type: "text_delta", text: "Hello, I", accumulated: "Hello, I" },
    ]);
  });

  it("maps sequential deltas so ONE assistant message accumulates", () => {
    const deltas = ["Hello", "Hello, I", "Hello, I can", "Hello, I can help."];
    const accumulated: string[] = [];
    for (const text of deltas) {
      const mapped = mapCoreEvent({
        type: "agent_event",
        payload: {
          sessionId: "s1",
          event: {
            type: "content_start",
            contentType: "text",
            text,
            accumulated: text,
          },
        },
      });
      const delta = mapped.events[0];
      expect(delta?.type).toBe("text_delta");
      if (delta?.type === "text_delta") accumulated.push(delta.text);
    }
    // Deltas build on each other — the UI must replace, not append blindly.
    expect(accumulated).toEqual(deltas);
    expect(accumulated[3]).toBe("Hello, I can help.");
  });

  it("maps reasoning content_start into reasoning_delta (qwen3 thinking)", () => {
    const mapped = mapCoreEvent({
      type: "agent_event",
      payload: {
        sessionId: "s1",
        event: {
          type: "content_start",
          contentType: "reasoning",
          text: "Let me think",
          accumulated: "Let me think",
        },
      },
    });
    expect(mapped.events).toEqual([
      {
        type: "reasoning_delta",
        text: "Let me think",
        accumulated: "Let me think",
      },
    ]);
  });

  it("maps a real tool content_start into tool_started", () => {
    const mapped = mapCoreEvent({
      type: "agent_event",
      payload: {
        sessionId: "s1",
        event: {
          type: "content_start",
          contentType: "tool",
          toolName: "read_files",
          toolCallId: "call_7w9j4o0x",
          input: { files: [{ path: "/workspace/package.json" }] },
        },
      },
    });
    expect(mapped.events).toEqual([
      {
        type: "tool_started",
        toolCallId: "call_7w9j4o0x",
        toolName: "read_files",
      },
    ]);
  });
});

describe("mapCoreEvent — tool completion, usage, lifecycle", () => {
  it("maps a real successful tool content_end into tool_completed with durationMs", () => {
    const mapped = mapCoreEvent({
      type: "agent_event",
      payload: {
        sessionId: "s1",
        event: {
          type: "content_end",
          contentType: "tool",
          toolName: "read_files",
          toolCallId: "call_7w9j4o0x",
          output: [
            { query: "/workspace/package.json", result: "{}", success: true },
          ],
          durationMs: 2,
        },
      },
    });
    expect(mapped.events).toEqual([
      {
        type: "tool_completed",
        toolCallId: "call_7w9j4o0x",
        toolName: "read_files",
        output: [
          { query: "/workspace/package.json", result: "{}", success: true },
        ],
        durationMs: 2,
      },
    ]);
  });

  it("maps a real failed tool content_end (ENOENT) into tool_failed with the real error", () => {
    const mapped = mapCoreEvent({
      type: "agent_event",
      payload: {
        sessionId: "s1",
        event: {
          type: "content_end",
          contentType: "tool",
          toolName: "read_files",
          toolCallId: "call_7w9j4o0x",
          output: [
            {
              query: "/workspace/package.json",
              result: "",
              error:
                "Error reading file: ENOENT: no such file or directory, stat 'C:\\workspace\\package.json'",
              success: false,
            },
          ],
          durationMs: 2,
        },
      },
    });
    expect(mapped.events).toHaveLength(1);
    expect(mapped.events[0]?.type).toBe("tool_failed");
    if (mapped.events[0]?.type === "tool_failed") {
      expect(mapped.events[0].error).toContain("ENOENT");
    }

    describe("mapCoreEvent — usage and lifecycle", () => {
      it("captures real usage payloads", () => {
        const mapped = mapCoreEvent({
          type: "agent_event",
          payload: {
            sessionId: "s1",
            event: {
              type: "usage",
              inputTokens: 1770,
              outputTokens: 27,
              totalInputTokens: 1770,
              totalOutputTokens: 27,
              totalCost: 0,
            },
          },
        });
        expect(mapped.usage).toMatchObject({
          inputTokens: 1770,
          outputTokens: 27,
        });
        expect(mapped.events).toHaveLength(0);
      });

      it("maps the real done(completed) event into completed with final text and usage, ended=true", () => {
        const mapped = mapCoreEvent({
          type: "agent_event",
          payload: {
            sessionId: "1787419130084_5mkpz",
            event: {
              type: "done",
              reason: "completed",
              text: "CodePilot AI is working.",
              iterations: 1,
              usage: { inputTokens: 3617, outputTokens: 57, totalCost: 0 },
            },
          },
        });
        expect(mapped.ended).toBe(true);
        expect(mapped.usage).toMatchObject({
          inputTokens: 3617,
          outputTokens: 57,
        });
        expect(mapped.events).toEqual([
          {
            type: "completed",
            result: "CodePilot AI is working.",
            usage: { inputTokens: 3617, outputTokens: 57, totalCost: 0 },
          },
        ]);
      });

      it("maps done(aborted) into cancelled so Stop settles the UI", () => {
        const mapped = mapCoreEvent({
          type: "agent_event",
          payload: {
            sessionId: "s1",
            event: { type: "done", reason: "aborted" },
          },
        });
        expect(mapped.ended).toBe(true);
        expect(mapped.events).toEqual([{ type: "cancelled" }]);
      });

      it("maps top-level status running / completed / idle", () => {
        const running = mapCoreEvent({
          type: "status",
          payload: { sessionId: "s1", status: "running" },
        });
        expect(running.events[0]?.type).toBe("status");
        expect(running.events[0]).toMatchObject({ message: "Agent running…" });
        const done = mapCoreEvent({
          type: "status",
          payload: { sessionId: "s1", status: "completed" },
        });
        expect(done.ended).toBe(true);
        expect(
          mapCoreEvent({
            type: "status",
            payload: { sessionId: "s1", status: "idle" },
          }).events[0]?.type,
        ).toBe("status");
      });

      it("marks ended on top-level ended events and extracts sessionId", () => {
        const mapped = mapCoreEvent({
          type: "ended",
          payload: { sessionId: "sess-42", reason: "disposed" },
        });
        expect(mapped.ended).toBe(true);
        expect(mapped.sessionId).toBe("sess-42");
      });

      it("ignores chunk echoes without throwing; iteration_start maps to thinking", () => {
        expect(
          mapCoreEvent({
            type: "chunk",
            payload: { stream: "lead", chunk: {} },
          }).events,
        ).toHaveLength(0);
        expect(
          mapCoreEvent({
            type: "agent_event",
            payload: {
              sessionId: "s1",
              event: { type: "iteration_start", iteration: 1 },
            },
          }).events.map((e) => e.type),
        ).toEqual(["thinking"]);
        expect(
          mapCoreEvent({
            type: "agent_event",
            payload: {
              sessionId: "s1",
              event: {
                type: "iteration_end",
                iteration: 1,
                hadToolCalls: true,
                toolCallCount: 1,
              },
            },
          }).events,
        ).toHaveLength(0);
      });

      it("never throws on malformed payloads", () => {
        expect(() => mapCoreEvent(null)).not.toThrow();
        expect(() => mapCoreEvent(undefined)).not.toThrow();
        expect(() => mapCoreEvent(42)).not.toThrow();
        expect(() =>
          mapCoreEvent({ type: "agent_event", payload: { event: "garbage" } }),
        ).not.toThrow();
        expect(mapCoreEvent(null).events).toHaveLength(0);
      });
    });
  });
});
