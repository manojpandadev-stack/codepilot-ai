/**
 * H2: credential boundary on tool output entering model history.
 *
 * A tool returning secret-shaped text (e.g. a workspace .env) must have
 * those spans redacted before the tool_result reaches the NEXT provider
 * request when redaction is enabled (remote providers). With the flag off
 * (local runs), output passes through verbatim — existing behavior.
 *
 * Synthetic markers only (sk-fake-…, hunter2-fake-…) — never real secrets.
 */
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "./agent-loop.js";
import type { LlmProvider, LlmStreamEvent, LlmRequest } from "../llm/types.js";
import type { AgentTool } from "../types.js";

const done: LlmStreamEvent = { type: "finish", reason: "complete" };

const SECRET_OUTPUT =
  "db_url=postgres://bob@db.internal:5432/app\n" +
  "db password = hunter2-fake-pw\n" +
  "api_key = sk-fake-secret-12345678\nuser=bob";

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

function readerTool(): AgentTool {
  return {
    name: "reader",
    description: "",
    inputSchema: {},
    execute: async () => SECRET_OUTPUT,
  } as AgentTool;
}

function readCall(id: string): LlmStreamEvent {
  return {
    type: "tool-call",
    call: { toolCallId: id, toolName: "reader", argumentsText: "{}" },
  };
}

function baseOpts(provider: LlmProvider, extra: Record<string, unknown> = {}) {
  return {
    provider,
    modelId: "test",
    sessionId: "s",
    tools: [readerTool()],
    gate: async () => ({ approved: true }),
    maxIterations: 4,
    onEvent: () => {},
    ...extra,
  };
}

function secondRequestText(seen: LlmRequest[]): string {
  expect(seen.length).toBeGreaterThanOrEqual(2);
  return JSON.stringify(seen[1]);
}

describe("tool-output credential boundary (H2)", () => {
  it("redacts secret spans before the next request when enabled", async () => {
    const seen: LlmRequest[] = [];
    const result = await runAgentLoop(
      [],
      "read the config",
      baseOpts(
        capturingProvider(
          [
            [readCall("1"), done],
            [{ type: "text-delta", text: "ok" }, done],
          ],
          seen,
        ),
        { redactToolResults: true },
      ),
    );
    expect(result.reason).toBe("complete");
    const wire = secondRequestText(seen);
    expect(wire).toContain("[REDACTED]");
    expect(wire).not.toContain("sk-fake-secret-12345678");
    expect(wire).not.toContain("hunter2-fake-pw");
    // Non-secret context survives span-preserving redaction.
    expect(wire).toContain("user=bob");
  });

  it("passes output through verbatim when disabled (local behavior preserved)", async () => {
    const seen: LlmRequest[] = [];
    const result = await runAgentLoop(
      [],
      "read the config",
      baseOpts(
        capturingProvider(
          [
            [readCall("1"), done],
            [{ type: "text-delta", text: "ok" }, done],
          ],
          seen,
        ),
      ),
    );
    expect(result.reason).toBe("complete");
    const wire = secondRequestText(seen);
    expect(wire).toContain("sk-fake-secret-12345678");
  });
});
