/**
 * Native engine — the CodePilot agent loop.
 *
 * PRODUCTION PATH: `runAgentLoop` is the SINGLE iteration engine — used by
 * NativeSessionManager (session.ts) for every runtime turn (and by agent.ts).
 * There is no alternate loop; do not add a second execution path.
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

import type {
  AgentMessage,
  AgentTool,
  AgentUsage,
  ToolUseBlock,
} from "../types.js";
import type { LlmStreamEvent, LlmToolCall } from "../llm/types.js";
import type { LlmProvider } from "../llm/types.js";
import { scrubSecretsText } from "@codepilot/shared";
import {
  estimateRequestTokens,
  resolveOutputBudget,
} from "../../token-budget.js";
import {
  dispatchToolCall,
  parseToolArguments,
  type ToolGate,
} from "./tool-dispatch.js";
import { containsUnverifiedExecutionClaim } from "../../review-intelligence.js";

export type AgentLoopEvent =
  | { type: "iteration_start"; iteration: number }
  | { type: "text_delta"; text: string; accumulated: string }
  | { type: "reasoning_delta"; text: string; accumulated: string }
  | { type: "tool_started"; call: LlmToolCall; toolName: string }
  | {
      type: "tool_completed";
      call: LlmToolCall;
      toolName: string;
      output: string;
      isError: boolean;
      durationMs: number;
    }
  | { type: "tool_denied"; call: LlmToolCall; toolName: string; reason: string }
  | { type: "usage"; usage: AgentUsage }
  | {
      type: "finish";
      reason:
        "complete" | "aborted" | "error" | "max_iterations" | "incomplete";
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
  /**
   * Known model context window (tokens) used to bound per-request output.
   * When omitted the loop falls back to the configured/default output cap —
   * the context window is NEVER used as the output budget (Phase 7: an
   * unbounded `max_tokens` lets credit-checked providers impute the full
   * window and reject with HTTP 402).
   */
  modelContextWindow?: number;
  /**
   * Explicit per-request output cap. Invalid values fall back to the
   * default. Always clamped to remaining context when the window is known.
   */
  maxOutputTokens?: number;
  /**
   * H2 credential boundary: when true, tool_result content persisted into
   * messages (the next provider request) is scrubbed through the canonical
   * secret scrubber. Defaults to false — local runs pass output through
   * verbatim. Remote callers must pass true so secret-shaped spans (a
   * workspace .env, API keys, passwords) never reach the provider.
   */
  redactToolResults?: boolean;
  /**
   * F-02/F-03 terminal-outcome propagation: the mode callers pass for
   * diagnostics only. Never authorizes anything — ToolGate/M4 stay
   * authoritative. (H6 verification lives outside this round.)
   */
  agentMode?: string;
  /** Called for every event, synchronously, in order. */
  onEvent: (event: AgentLoopEvent) => void;
}

export interface AgentLoopResult {
  text: string;
  usage: AgentUsage;
  iterations: number;
  reason: "complete" | "aborted" | "error" | "max_iterations" | "incomplete";
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
  let executedToolsCount = 0;

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
    // Phase 7: resolve a bounded output budget BEFORE touching the provider.
    // The budget is min(configured cap, remaining context) — never the
    // context window. Exhausted context fails closed without a request.
    const estimatedInput = estimateRequestTokens(
      messages,
      options.systemPrompt,
      options.tools,
    );
    const budget = resolveOutputBudget({
      contextWindowTokens: options.modelContextWindow,
      estimatedInputTokens: estimatedInput,
      configuredMaxOutputTokens: options.maxOutputTokens,
    });
    if (!budget.ok) {
      options.onEvent({
        type: "finish",
        reason: "error",
        error: budget.message,
        text: accumulatedText,
        usage: { ...usage },
        iterations,
      });
      return finish("error", budget.message);
    }
    const toolCalls: Array<LlmToolCall & { args: Record<string, unknown> }> =
      [];
    let turnError: string | undefined;
    let aborted = false;
    // F-03: only an explicit finish(complete) is terminal completion evidence.
    let turnFinishedCleanly = false;
    let turnIncomplete = false;

    try {
      for await (const evt of iterateUntilAborted(
        options.provider.stream({
          providerId: options.provider.id,
          modelId: options.modelId,
          systemPrompt: options.systemPrompt,
          messages: [...messages],
          tools: options.tools,
          temperature: options.temperature,
          maxTokens: budget.maxTokens,
          signal,
        }),
        signal,
      )) {
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
              usage.totalCost =
                (usage.totalCost ?? 0) + streamEvt.usage.totalCost;
            }
            options.onEvent({ type: "usage", usage: { ...usage } });
            break;
          case "finish":
            if (streamEvt.reason === "aborted") aborted = true;
            if (streamEvt.reason === "error")
              turnError = streamEvt.error ?? "provider stream failed";
            if (streamEvt.reason === "complete") turnFinishedCleanly = true;
            if (streamEvt.reason === "incomplete") turnIncomplete = true;
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

    // The provider is not authoritative about caller cancellation. Some
    // providers/fakes may ignore AbortSignal and still yield finish(complete)
    // after the user has stopped the run. Cancellation wins at this boundary
    // before any tool call can be dispatched or completion can be reported.
    if (signal?.aborted) {
      options.onEvent({
        type: "finish",
        reason: "aborted",
        text: accumulatedText,
        usage: { ...usage },
        iterations,
      });
      return finish("aborted");
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

    // F-03: no valid terminal completion evidence → NOT COMPLETE. EOF
    // without finish(complete), or an explicit finish(incomplete), means the
    // provider turn was truncated — never claim successful completion.
    if (!turnFinishedCleanly || turnIncomplete) {
      const incompleteError =
        "provider stream ended without valid terminal completion evidence";
      options.onEvent({
        type: "finish",
        reason: "incomplete",
        error: incompleteError,
        text: accumulatedText,
        usage: { ...usage },
        iterations,
      });
      return finish("incomplete", incompleteError);
    }

    // ---- No tool calls → the model's answer completes the run ----
    if (toolCalls.length === 0) {
      const isActOrAuto =
        options.agentMode === "act" || options.agentMode === "auto";
      if (
        isActOrAuto &&
        executedToolsCount === 0 &&
        containsUnverifiedExecutionClaim(accumulatedText)
      ) {
        const unverifiedError =
          "Unverified completion claim: model claimed completion without executing any tools";
        options.onEvent({
          type: "finish",
          reason: "error",
          error: unverifiedError,
          text: accumulatedText,
          usage: { ...usage },
          iterations,
        });
        return finish("error", unverifiedError);
      }

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
      ...(call.thoughtSignature
        ? { thoughtSignature: call.thoughtSignature }
        : {}),
    }));
    messages.push({ role: "assistant", content: toolUseBlocks });

    const resultBlocks = [];
    for (const call of toolCalls) {
      const tool = options.tools.find((t) => t.name === call.toolName);
      options.onEvent({ type: "tool_started", call, toolName: call.toolName });
      let outcome: Awaited<ReturnType<typeof dispatchToolCall>>;
      try {
        outcome = await dispatchToolCall(
          tool,
          call,
          options.gate,
          { sessionId: options.sessionId, iteration: iterations, signal },
          { maxResultChars: options.maxResultChars },
        );
      } catch (err) {
        // F-02: abort during tool execution unwinds here (dispatch rethrows
        // when the signal is aborted). Cancellation is terminal — never
        // continue the turn, recover, retry, or return COMPLETE.
        if (signal?.aborted) {
          options.onEvent({ ...finish("aborted"), type: "finish" });
          return finish("aborted");
        }
        throw err;
      }
      // F-02: cancellation that lands while awaiting approval (or during
      // dispatch) must win even when the gate later resolves approved and
      // dispatch reports a denial. Late denials after abort are CANCELLED,
      // never completion evidence; no further tool may execute.
      if (signal?.aborted) {
        options.onEvent({ ...finish("aborted"), type: "finish" });
        return finish("aborted");
      }
      if (outcome.denied) {
        options.onEvent({
          type: "tool_denied",
          call,
          toolName: call.toolName,
          reason: outcome.denialReason ?? "denied",
        });
      } else {
        executedToolsCount += 1;
        options.onEvent({
          type: "tool_completed",
          call,
          toolName: call.toolName,
          output: outcome.content,
          isError: outcome.isError,
          durationMs: outcome.durationMs,
        });
      }
      // H2: scrub secret spans before the tool_result reaches persisted
      // history (the next provider request body). UI/event output above
      // stays verbatim — only the wire content is bounded.
      const persistedContent = options.redactToolResults
        ? scrubSecretsText(outcome.content)
        : outcome.content;
      resultBlocks.push({
        type: "tool_result" as const,
        tool_use_id: call.toolCallId,
        name: call.toolName,
        content: persistedContent,
        ...(outcome.isError || outcome.denied ? { is_error: true } : {}),
      });
      // F-02: check cancellation between tool calls so a queued
      // state-changing call never starts after abort.
      if (signal?.aborted) {
        options.onEvent({ ...finish("aborted"), type: "finish" });
        return finish("aborted");
      }
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

/**
 * Consume provider output without relying on the provider honoring the
 * AbortSignal. A stalled `next()` must not keep a cancelled run alive; any
 * late provider result is observed only to prevent an unhandled rejection
 * and is never yielded to the agent loop.
 */
async function* iterateUntilAborted<T>(
  source: AsyncIterable<T>,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let resolveAbort!: () => void;
  const abortPromise = signal
    ? new Promise<void>((resolve) => {
        resolveAbort = resolve;
      })
    : undefined;
  const onAbort = (): void => resolveAbort();
  if (signal) {
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) resolveAbort();
  }

  try {
    while (!signal?.aborted) {
      const next = Promise.resolve()
        .then(() => iterator.next())
        .then(
          (value) => ({ kind: "next" as const, value }),
          (error: unknown) => ({ kind: "error" as const, error }),
        );
      const result = abortPromise
        ? await Promise.race([
            next,
            abortPromise.then(() => ({ kind: "aborted" as const })),
          ])
        : await next;
      if (result.kind === "aborted" || signal?.aborted) return;
      if (result.kind === "error") throw result.error;
      if (result.value.done) return;
      yield result.value.value;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) {
      try {
        const closing = iterator.return?.();
        if (closing) void Promise.resolve(closing).catch(() => undefined);
      } catch {
        // A stalled provider's cleanup must never delay cancellation.
      }
    }
  }
}
