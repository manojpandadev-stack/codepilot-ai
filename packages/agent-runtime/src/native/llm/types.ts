/**
 * CodePilot LLM — provider-neutral contracts.
 *
 * Independently authored streaming contracts for the native runtime. The
 * engine consumes exactly these events; each provider adapter translates its
 * vendor protocol into them.
 */

import type {
  AgentMessage,
  AgentTool,
  AgentUsage,
} from "../types.js";

/** One streaming request to a provider. */
export interface LlmRequest {
  providerId: string;
  modelId: string;
  systemPrompt?: string;
  messages: AgentMessage[];
  tools?: AgentTool[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** Tool call assembled from a completed streaming tool_call delta. */
export interface LlmToolCall {
  toolCallId: string;
  toolName: string;
  /** Raw JSON text of the arguments (parsed lazily by the engine). */
  argumentsText: string;
}

export type LlmStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; call: LlmToolCall }
  | { type: "usage"; usage: AgentUsage }
  | { type: "finish"; reason: "complete" | "aborted" | "error"; error?: string };

export interface LlmProvider {
  readonly id: string;
  /** Stream one completion. The final yielded event is always `finish`. */
  stream(request: LlmRequest): AsyncIterable<LlmStreamEvent>;
}

export class LlmError extends Error {
  readonly status?: number;
  readonly providerId: string;
  readonly transient: boolean;
  constructor(providerId: string, message: string, opts?: { status?: number; transient?: boolean }) {
    super(`[${providerId}] ${message}`);
    this.name = "LlmError";
    this.providerId = providerId;
    this.status = opts?.status;
    this.transient =
      opts?.transient ??
      (opts?.status === 429 ||
        (opts?.status !== undefined && opts.status >= 500 && opts.status < 600) ||
        opts?.status === undefined);
  }
}
