/**
 * Token-budget math for agent requests (pure functions, no I/O).
 *
 * Root-cause context: CodePilot used to send OpenAI-compatible chat
 * requests with NO max_tokens bound. OpenRouter's credit pre-check then
 * assumes the worst case — up to the model's full context window
 * (e.g. 131072 output tokens for a 131k-context model) — and returns
 * HTTP 402 when the account cannot cover it, even for tiny prompts.
 * A model's context window is NOT its output budget; this module keeps
 * the two strictly separate:
 *
 *   availableContext = modelContextWindow - estimatedInputTokens - safetyMargin
 *   requestedOutput  = min(configuredOutputLimit, availableContext)
 *
 * Token estimation uses the documented chars/4 approximation (same constant
 * as the M6 budgeter and M12 compaction math). Image blocks reuse the shared
 * estimateImageTokens helper, exactly like compaction does.
 *
 * Also hosted here: provider billing-failure classification (HTTP 402 class)
 * so the no-retry rule and the user-facing message live next to the budget
 * that prevents the failure. Nothing here logs, prints, or persists keys.
 */

import { estimateImageTokens } from "@codepilot/shared";
import type { AgentMessage, AgentTool } from "./native/types.js";

/** Documented chars-per-token approximation (M6 budgeter / M12 compaction). */
export const CHARS_PER_TOKEN = 4;

/**
 * Default per-request output budget. Matches the Anthropic adapter default
 * (8192) — large enough for agentic tool loops, small enough that a
 * credit pre-check prices the actual request instead of a full context
 * window. Configurable per runtime; never derived from the context window.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/**
 * Headroom subtracted from the context window for framing the provider adds
 * around our counted payload (roles, separators, usage variance).
 */
export const TOKEN_BUDGET_SAFETY_MARGIN_TOKENS = 1024;

/** Estimate input tokens for one agent message (text + blocks). */
export function estimateAgentMessageTokens(message: AgentMessage): number {
  if (typeof message.content === "string") {
    return Math.ceil(message.content.length / CHARS_PER_TOKEN);
  }
  let chars = 0;
  let imageTokens = 0;
  for (const block of message.content) {
    if (block.type === "text") {
      chars += block.text.length;
    } else if (block.type === "tool_use") {
      chars += block.name.length + JSON.stringify(block.input).length;
    } else if (block.type === "tool_result") {
      chars += block.name.length + block.content.length;
    } else if (block.type === "image") {
      if (block.dataBase64) {
        imageTokens += estimateImageTokens(
          Math.floor((block.dataBase64.length * 3) / 4),
        );
      } else {
        // Same convention as M12 compaction: unsized images use the
        // helper's zero-size estimate rather than an invented number.
        imageTokens += estimateImageTokens(block.sizeBytes ?? 0);
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + imageTokens;
}

/**
 * Estimate input tokens for a full request: system prompt + message history
 * + serialized tool definitions. Counts only — never inspects semantics.
 */
export function estimateRequestTokens(
  messages: AgentMessage[],
  systemPrompt?: string,
  tools?: AgentTool[],
): number {
  let total = 0;
  if (systemPrompt) total += Math.ceil(systemPrompt.length / CHARS_PER_TOKEN);
  for (const message of messages) total += estimateAgentMessageTokens(message);
  if (tools && tools.length > 0) {
    for (const tool of tools) {
      const schema = JSON.stringify({
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.inputSchema ?? {},
      });
      total += Math.ceil(schema.length / CHARS_PER_TOKEN);
    }
  }
  return total;
}

export interface OutputBudgetInput {
  /** Model context window in tokens. Undefined/unknown ⇒ bounded default. */
  contextWindowTokens?: number;
  /** Estimated input tokens for the request about to be sent. */
  estimatedInputTokens: number;
  /** Configured per-request output cap. Invalid values fall back to default. */
  configuredMaxOutputTokens?: number;
  /** Safety headroom. Defaults to TOKEN_BUDGET_SAFETY_MARGIN_TOKENS. */
  safetyMarginTokens?: number;
}

export type OutputBudget =
  | {
      ok: true;
      /** The max_tokens value the request MUST carry (always bounded). */
      maxTokens: number;
      /** The effective configured cap (explicit or default). */
      configuredLimit: number;
      /** Context remaining after input + margin, when the window is known. */
      remainingContextTokens?: number;
      /** True when the window (not the cap) is the binding constraint. */
      boundByContext: boolean;
    }
  | {
      ok: false;
      reason: "context-exhausted";
      /** Actionable, secret-free message safe for error cards. */
      message: string;
      estimatedInputTokens: number;
      contextWindowTokens: number;
    };

function validPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Resolve the output budget for one request. NEVER returns the context
 * window as the output budget and NEVER returns unbounded: unknown windows
 * fall back to the configured/default cap, and an exhausted window is an
 * explicit error (the caller must surface it, not send a doomed request).
 */
export function resolveOutputBudget(input: OutputBudgetInput): OutputBudget {
  const limit =
    validPositiveInt(input.configuredMaxOutputTokens) ??
    DEFAULT_MAX_OUTPUT_TOKENS;
  const estimated = validPositiveInt(input.estimatedInputTokens) ?? 0;
  const margin =
    input.safetyMarginTokens === undefined
      ? TOKEN_BUDGET_SAFETY_MARGIN_TOKENS
      : Math.max(0, Math.floor(input.safetyMarginTokens));
  const window = validPositiveInt(input.contextWindowTokens);
  if (window === undefined) {
    return {
      ok: true,
      maxTokens: limit,
      configuredLimit: limit,
      boundByContext: false,
    };
  }
  const available = window - estimated - margin;
  if (available <= 0) {
    return {
      ok: false,
      reason: "context-exhausted",
      message:
        `Context limit reached: ~${estimated.toLocaleString("en-US")} estimated input tokens ` +
        `fill the ${window.toLocaleString("en-US")}-token window (margin ${margin.toLocaleString("en-US")}). ` +
        `Compact the conversation or shorten the request instead of sending a request the provider must reject.`,
      estimatedInputTokens: estimated,
      contextWindowTokens: window,
    };
  }
  const maxTokens = Math.max(1, Math.min(limit, available));
  return {
    ok: true,
    maxTokens,
    configuredLimit: limit,
    remainingContextTokens: available,
    boundByContext: maxTokens < limit,
  };
}

// ============================================================================
// Provider billing failures (HTTP 402 class)
// ============================================================================

/**
 * True when an error looks like a provider billing/credit rejection:
 * HTTP 402, payment-required, insufficient-credit, or an "affordable
 * budget" notice (OpenRouter reports e.g. "could only afford 11247
 * tokens"). Billing failures must NEVER be retried automatically — a retry
 * cannot create credits — and must never trigger a provider/model switch.
 */
export function isBillingFailure(error: unknown): boolean {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return (
    /\b402\b/.test(text) ||
    /payment required/i.test(text) ||
    /insufficient credit/i.test(text) ||
    /exceeds.*credit|credit.*exceed/i.test(text) ||
    /billing/i.test(text) ||
    /could only afford/i.test(text)
  );
}

/**
 * Extract an affordable-token figure from provider error text such as
 * "available credit could only afford 11247 tokens". Undefined when absent.
 */
export function parseAffordableTokens(text: string): number | undefined {
  const match = /afford[^\d]*([\d,]+)\s*tokens/i.exec(text);
  if (!match?.[1]) return undefined;
  const value = Number.parseInt(match[1].replace(/,/g, ""), 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Actionable, secret-free user message for a billing failure. States the
 * cause, the remedy, and the reported affordable budget when present.
 * Never claims the model is broken; never suggests switching providers.
 */
export function formatBillingFailureMessage(input: {
  providerLabel?: string;
  affordableTokens?: number;
}): string {
  const who = input.providerLabel?.trim() || "The provider";
  const base =
    `${who} rejected this request because the requested token budget ` +
    `exceeds the available credits.`;
  const afford =
    input.affordableTokens !== undefined
      ? ` The response reports an affordable budget of ~${input.affordableTokens.toLocaleString("en-US")} tokens.`
      : "";
  return (
    base +
    afford +
    ` Reduce the request/context or use a model/account with sufficient credits.`
  );
}
