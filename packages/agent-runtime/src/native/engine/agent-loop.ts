/**
 * Native engine — the CodePilot agent loop.
 *
 * Independently authored iteration engine:
 *
 *   user message
 *     → [LLM stream → text/reasoning/tool-call events]
 *     → execute approved tools (M4 gate per call)
 *     → append tool results as the next user message
 *     → repeat until the model answers with no tool calls
 *     → finish(complete | error | aborted | max-iterations)
 *
 * Protocol invariants:
 *   - Every assistant tool_use block is paired with exactly one tool_result
 *     block in the FOLLOWING user message (the wire protocol the providers
 *     require and TaskStore persists).
 *   - Events are emitted synchronously in execution order; text deltas carry
 *     the accumulated text so UIs can render progressively.
 *   - Abort (AbortSignal) unwinds the current LLM stream or tool execution
 *     and resolves with finish(aborted). No zombie promises.
 *   - maxIterations bounds the loop; exceeding it finishes with an explicit
 *     error the caller can surface.
 */

import type { AgentMessage, AgentTool, AgentUsage, ToolUseBlock } from "../types.js";
import type { LlmStreamEvent, LlmToolCall } from "../llm/types.js";
import type { LlmProvider } from "../llm/types.js";
import { dispatchToolCall, parseToolArguments, type ToolGate } from "./tool-dispatch.js";

export type AgentLoopEvent =
  | { type: "iteration_start"; iteration: number }
  | { type: "text_delta"; text: string; accumulated: string }
  | { type: "reasoning_delta"; text: string; accumulated: string }
  | { type: "tool_started"; call: LlmToolCall; toolName: string }
  | { type: "tool_completed"; call: LlmToolCall; toolName: string; output: string; isError: boolean; durationMs: number }
  | { type: "tool_denied"; call: LlmToolCall; toolName: string; reason: string }
  | { type: "usage"; usage: AgentUsage }
  | {
      type: "finish";
      reason: "complete" | "aborted" | "error" | "max_iterations";
      error?: string;
      text: string;
      usage: AgentUsage;
      iterations: number;
    };

export interface AgentLoopOptions {
  provider: LlmProvider;
  modelId: string;
  sessionId: string;
  systemPrompt?: string;
  tools: AgentTool[];
  gate: ToolGate;
  maxIterations: number;
  temperature?: number;
  maxResultChars?: number;
  /** Called for every event, synchronously, in order. */
  onEvent: (event: AgentLoopEvent) => void;
}

export interface AgentLoopResult {
  text: string;
  usage: AgentUsage;
  iterations: number;
  reason: "complete" | "aborted" | "error" | "max_iterations";
  error?: string;
}

const emptyUsage = (): AgentUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/**
 * Run the agent loop until completion. `messages` is mutated in place —
 * callers pass their session message array and read the final transcript
 * from it (including every tool_use/tool_result exchange).
 */
export async function runAgentLoop(
  messages: AgentMessage[],
  prompt: string,
  options: AgentLoopOptions,
  signal?: AbortSignal,
): Promise<AgentLoopResult> {
  const usage = emptyUsage();
  let accumulatedText = "";
  let accumulatedReasoning = "";
  let iterations = 0;

  messages.push({ role: "user", content: prompt });

  const finish = (
    reason: AgentLoopResult["reason"],
    error?: string,
  ): AgentLoopResult => ({
    text: accumulatedText,
    usage,
    iterations,
    reason,
    ...(error !== undefined ? { error } : {}),
  });

  if (signal?.aborted) return finish("aborted");

  while (iterations < options.maxIterations) {
    iterations += 1;
    options.onEvent({ type: "iteration_start", iteration: iterations });

    // ---- One model turn ----
    const toolCalls: Array<LlmToolCall & { args: Record<string, unknown> }> = [];
    let turnError: string | undefined;
    let aborted = false;

    try {
      for await (const evt of options.provider.stream({
        providerId: options.provider.id,
        modelId: options.modelId,
        systemPrompt: options.systemPrompt,
        messages: [...messages],
        tools: options.tools,
        temperature: options.temperature,
        signal,
      })) {
        const streamEvt = evt as LlmStreamEvent;
        switch (streamEvt.type) {
          case "text-delta":
            accumulatedText += streamEvt.text;
            options.onEvent({
              type: "text_delta",
              text: streamEvt.text,
              accumulated: accumulatedText,
            });
            break;
          case "reasoning-delta":
            accumulatedReasoning += streamEvt.text;
            options.onEvent({
              type: "reasoning_delta",
              text: streamEvt.text,
              accumulated: accumulatedReasoning,
            });
            break;
          case "tool-call": {
            const parsed = parseToolArguments(streamEvt.call);
            const args = "parseError" in parsed ? {} : parsed;
            toolCalls.push({ ...streamEvt.call, args });
            break;
          }
          case "usage":
            usage.inputTokens += streamEvt.usage.inputTokens;
            usage.outputTokens += streamEvt.usage.outputTokens;
            usage.cacheReadTokens += streamEvt.usage.cacheReadTokens;
            usage.cacheWriteTokens += streamEvt.usage.cacheWriteTokens;
            if (streamEvt.usage.totalCost !== undefined) {
              usage.totalCost = (usage.totalCost ?? 0) + streamEvt.usage.totalCost;
            }
            options.onEvent({ type: "usage", usage: { ...usage } });
            break;
          case "finish":
            if (streamEvt.reason === "aborted") aborted = true;
            if (streamEvt.reason === "error") turnError = streamEvt.error ?? "provider stream failed";
            break;
        }
        if (aborted) break;
      }
    } catch (err) {
      if (signal?.aborted) {
        options.onEvent({ ...finish("aborted"), type: "finish" });
        return finish("aborted");
      }
      const message = err instanceof Error ? err.message : String(err);
      options.onEvent({
        type: "finish",
        reason: "error",
        error: message,
        text: accumulatedText,
        usage: { ...usage },
        iterations,
      });
      return finish("error", message);
    }

    if (aborted) {
      options.onEvent({
        type: "finish",
        reason: "aborted",
        text: accumulatedText,
        usage: { ...usage },
        iterations,
      });
      return finish("aborted");
    }
    if (turnError !== undefined) {
      options.onEvent({
        type: "finish",
        reason: "error",
        error: turnError,
        text: accumulatedText,
        usage: { ...usage },
        iterations,
      });
      return finish("error", turnError);
    }

    // ---- No tool calls → the model's answer completes the run ----
    if (toolCalls.length === 0) {
      const result = finish("complete");
      options.onEvent({
        type: "finish",
        reason: "complete",
        text: accumulatedText,
        usage: { ...usage },
        iterations,
      });
      return result;
    }

    // ---- Record assistant tool_use + execute through M4 ----
    const toolUseBlocks: ToolUseBlock[] = toolCalls.map((call) => ({
      type: "tool_use",
      id: call.toolCallId,
      name: call.toolName,
      input: call.args,
    }));
    messages.push({ role: "assistant", content: toolUseBlocks });

    const resultBlocks = [];
    for (const call of toolCalls) {
      const tool = options.tools.find((t) => t.name === call.toolName);
      options.onEvent({ type: "tool_started", call, toolName: call.toolName });
      const outcome = await dispatchToolCall(
        tool,
        call,
        options.gate,
        { sessionId: options.sessionId, iteration: iterations, signal },
        { maxResultChars: options.maxResultChars },
      );
      if (outcome.denied) {
        options.onEvent({ type: "tool_denied", call, toolName: call.toolName, reason: outcome.denialReason ?? "denied" });
      } else {
        options.onEvent({
          type: "tool_completed",
          call,
          toolName: call.toolName,
          output: outcome.content,
          isError: outcome.isError,
          durationMs: outcome.durationMs,
        });
      }
      resultBlocks.push({
        type: "tool_result" as const,
        tool_use_id: call.toolCallId,
        name: call.toolName,
        content: outcome.content,
        ...(outcome.isError || outcome.denied ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: resultBlocks });
  }

  // Loop guard: the model kept calling tools without ever finishing.
  const message = `Agent exceeded the maximum of ${options.maxIterations} iterations.`;
  options.onEvent({
    type: "finish",
    reason: "max_iterations",
    error: message,
    text: accumulatedText,
    usage: { ...usage },
    iterations,
  });
  return finish("max_iterations", message);
}
