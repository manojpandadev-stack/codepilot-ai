/**
 * Native engine — tool dispatch through the M4 permission boundary.
 *
 * EVERY tool call the model makes passes `gate` (the host's M4 pipeline:
 * RiskEngine → PermissionPolicyEngine → ApprovalManager → SecurityValidator)
 * BEFORE `tool.execute` is invoked. Deny-closed: a gate that throws, or is
 * not configured, blocks execution. This is the single authoritative
 * permission boundary of the native engine — there is no auto-approve path.
 */

import type { AgentTool } from "../types.js";
import { NATIVE_AGENT_ID } from "../types.js";
import type { LlmToolCall } from "../llm/types.js";

/** The host-side M4 gate. Same contract as CodePilotRuntime.requestApproval. */
export type ToolGate = (request: {
  toolCallId: string;
  toolName: string;
  input: unknown;
}) => Promise<{ approved: boolean; reason?: string }>;

export interface DispatchOutcome {
  /** Wire-shaped tool_result content (string, bounded by the caller). */
  content: string;
  isError: boolean;
  durationMs: number;
  /** True when the gate denied the call (distinct from tool failure). */
  denied: boolean;
  denialReason?: string;
}

export interface DispatchContext {
  sessionId: string;
  iteration: number;
  signal?: AbortSignal;
}

/**
 * Hard execution deadline elapsed before the tool settled. Raised by the
 * dispatch timer even when the tool ignores its AbortSignal and never
 * resolves, so a non-cooperative tool becomes a structured tool failure
 * instead of a hung dispatch. Surfaced through the normal failure path as
 * `Tool '<name>' failed: timed out after …`.
 */
export class ToolTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `timed out after ${timeoutMs}ms — the tool never settled (hard execution deadline)`,
    );
    this.name = "ToolTimeoutError";
  }
}

/** Parse model tool-call arguments; non-JSON input becomes an error result. */
export function parseToolArguments(
  call: LlmToolCall,
): Record<string, unknown> | { parseError: string } {
  const text = call.argumentsText.trim();
  if (text.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { parseError: "tool arguments must be a JSON object" };
  } catch (err) {
    return {
      parseError: `invalid JSON tool arguments: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Dispatch one tool call: gate → execute → bounded result.
 * Never throws — every failure becomes a structured tool_result the model
 * can react to.
 */
export async function dispatchToolCall(
  tool: AgentTool | undefined,
  call: LlmToolCall,
  gate: ToolGate,
  context: DispatchContext,
  options?: { maxResultChars?: number },
): Promise<DispatchOutcome> {
  const started = Date.now();
  const maxResultChars = options?.maxResultChars ?? 24_000;

  const deny = (reason: string): DispatchOutcome => ({
    content: reason,
    isError: true,
    durationMs: Date.now() - started,
    denied: true,
    denialReason: reason,
  });

  // Resolve cancellation promptly even when an approval UI or executor does
  // not settle its promise after receiving AbortSignal. Promise.race keeps a
  // rejection handler attached to the underlying operation; its eventual
  // result is ignored after cancellation wins.
  const raceWithCancellation = <T>(
    operation: Promise<T>,
  ): Promise<{ cancelled: true } | { cancelled: false; value: T }> => {
    if (!context.signal)
      return operation.then((value) => ({ cancelled: false as const, value }));
    if (context.signal.aborted) return Promise.resolve({ cancelled: true });
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        context.signal?.removeEventListener("abort", onAbort);
        resolve({ cancelled: true });
      };
      context.signal!.addEventListener("abort", onAbort, { once: true });
      operation.then(
        (value) => {
          context.signal?.removeEventListener("abort", onAbort);
          resolve({ cancelled: false, value });
        },
        (err) => {
          context.signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  };
  if (context.signal?.aborted) {
    return deny(
      `Tool '${call.toolName}' was cancelled before approval; execution blocked.`,
    );
  }
  if (!tool) {
    return deny(
      `Unknown tool '${call.toolName}'. Use one of the provided tools.`,
    );
  }
  const args = parseToolArguments(call);
  if ("parseError" in args) {
    return deny(`${call.toolName}: ${args.parseError}`);
  }

  // ---- M4 gate (deny-closed) ----
  if (!gate) {
    return deny(
      "Permission pipeline unavailable — tool execution blocked for safety.",
    );
  }
  let decision: { approved: boolean; reason?: string };
  try {
    const gateResult = await raceWithCancellation(
      Promise.resolve(
        gate({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: args,
        }),
      ),
    );
    if (gateResult.cancelled || context.signal?.aborted) {
      return deny(
        `Tool '${call.toolName}' approval was cancelled; execution blocked.`,
      );
    }
    decision = gateResult.value;
  } catch (err) {
    return deny(
      `Permission evaluation failed (deny-closed): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!decision.approved) {
    return deny(decision.reason ?? `Tool '${call.toolName}' was not approved.`);
  }

  // ---- Cancellation after approval settles, before execute starts ----
  // The gate is asynchronous (it may await user approval). If the run is
  // cancelled while the gate is in flight, the gate's eventual resolver must
  // not be allowed to start a mutation. Re-check the signal here and return
  // a denial so the loop sees an aborted-ish turn and tool.execute is never
  // reached.
  if (context.signal?.aborted) {
    return deny(
      `Tool '${call.toolName}' was approved after the run was cancelled; execution blocked.`,
    );
  }
  // ---- Execute with timeout + abort ----
  const timeoutMs = tool.timeoutMs ?? 120_000;
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  context.signal?.addEventListener("abort", onOuterAbort, { once: true });
  if (context.signal?.aborted) controller.abort();
  // HARD DEADLINE: abort the tool's signal AND settle the dispatch, even
  // when the tool ignores its signal and never resolves. Promise.race
  // attaches handlers to both the tool promise and the deadline, so a late
  // rejection from the losing side can never become an unhandled rejection.
  let rejectDeadline!: (err: Error) => void;
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    controller.abort();
    rejectDeadline(new ToolTimeoutError(timeoutMs));
  }, timeoutMs);
  try {
    const executionResult = await raceWithCancellation(
      Promise.race([
        Promise.resolve(
          tool.execute(args, {
            agentId: NATIVE_AGENT_ID,
            sessionId: context.sessionId,
            iteration: context.iteration,
            toolCallId: call.toolCallId,
            signal: controller.signal,
          }),
        ),
        deadline,
      ]),
    );
    if (context.signal?.aborted || executionResult.cancelled) {
      throw new DOMException("Tool execution cancelled", "AbortError");
    }
    const output = executionResult.value;
    let content: string;
    if (typeof output === "string") content = output;
    else {
      try {
        content = JSON.stringify(output);
      } catch {
        content = String(output);
      }
    }
    if (content.length > maxResultChars) {
      const head = Math.floor(maxResultChars * 0.7);
      const tail = maxResultChars - head - 40;
      content = `${content.slice(0, head)}\n…[output truncated, ${content.length - maxResultChars} chars elided]…\n${tail > 0 ? content.slice(-tail) : ""}`;
    }
    return {
      content,
      isError: false,
      durationMs: Date.now() - started,
      denied: false,
    };
  } catch (err) {
    if (context.signal?.aborted) throw err; // abort must propagate to the loop
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `Tool '${call.toolName}' failed: ${message}`,
      isError: true,
      durationMs: Date.now() - started,
      denied: false,
    };
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener("abort", onOuterAbort);
  }
}
