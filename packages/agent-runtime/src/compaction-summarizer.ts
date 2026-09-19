/**
 * M12 — LLM conversation summarizer.
 *
 * Produces a REAL model-generated structured summary of the older
 * conversation segment. This is a separate one-shot completion — it never
 * runs inside the agent turn. Uses the SAME @codepilot/llm provider factory
 * the live runtime routes through, so provider/credential handling is
 * identical to live execution (keys are supplied by the host at call time
 * and are never logged or persisted).
 *
 * Failure contract: any failure (timeout, provider error, malformed output)
 * resolves to null — the caller falls back to bounded truncation and the
 * canonical history is never destroyed.
 */

import { createLlmProvider } from "./native/llm/registry.js";
import type { LlmProvider } from "./native/llm/types.js";
import { isRemoteProvider, toNativeProviderId } from "./runtime.js";
import type { CompactionSummary } from "./compaction-types.js";
import type { ResumeWireMessage } from "./resume.js";

// ============================================================================
// Privacy
// ============================================================================

export class PrivacyViolationError extends Error {
  constructor(providerId: string) {
    super(
      `Privacy violation blocked: summarization provider "${providerId}" is remote but privacy mode is "local". Conversation history was NOT sent anywhere.`,
    );
    this.name = "PrivacyViolationError";
  }
}

/**
 * Deny-closed: a summarization request to a remote provider is blocked while
 * privacy mode is "local" — mirroring the runtime's session guard. Local
 * providers (or explicit cloud permission) proceed.
 */
export function assertSummarizerPrivacyAllowed(
  providerId: string,
  privacyMode: "local" | "cloud",
): void {
  if (privacyMode === "local" && isRemoteProvider(providerId)) {
    throw new PrivacyViolationError(toNativeProviderId(providerId));
  }
}

// ============================================================================
// Structured summary validation
// ============================================================================

const SUMMARY_STRING_KEYS = [
  "objective",
] as const;

const SUMMARY_LIST_KEYS = [
  "constraints",
  "completedWork",
  "filesChanged",
  "decisions",
  "importantFindings",
  "errors",
  "tests",
  "pendingWork",
  "toolState",
  "checkpoints",
  "resumeInstructions",
] as const;

/**
 * Validate model output against the summary schema. Missing keys, wrong
 * types, or non-array lists make the summary REJECTED — callers fall back to
 * truncation rather than persisting a degraded summary.
 */
export function validateSummaryOutput(raw: unknown):
  | { ok: true; summary: CompactionSummary }
  | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "summary is not an object" };
  }
  const rec = raw as Record<string, unknown>;
  for (const key of SUMMARY_STRING_KEYS) {
    const v = rec[key];
    if (typeof v !== "string" || v.trim().length === 0) {
      return { ok: false, reason: `missing or empty string field "${key}"` };
    }
  }
  const out: Record<string, unknown> = {
    objective: (rec["objective"] as string).slice(0, 2_000),
  };
  for (const key of SUMMARY_LIST_KEYS) {
    const v = rec[key];
    if (!Array.isArray(v)) {
      return { ok: false, reason: `field "${key}" is not an array` };
    }
    const items = v
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((x) => x.slice(0, 500));
    out[key] = items;
  }
  return { ok: true, summary: out as unknown as CompactionSummary };
}

// ============================================================================
// Prompt construction
// ============================================================================

/** Flatten wire messages to a bounded transcript for the summarizer prompt. */
function renderTranscript(messages: ResumeWireMessage[], maxChars: number): string {
  const parts: string[] = [];
  let chars = 0;
  for (const m of messages) {
    let text: string;
    if (typeof m.content === "string") {
      text = `[${m.role}] ${m.content}`;
    } else {
      const lines: string[] = [];
      for (const b of m.content) {
        if (b.type === "text") lines.push(`[${m.role}] ${(b as { text: string }).text}`);
        else if (b.type === "tool_use")
          lines.push(
            `[${m.role} tool_use ${(b as { name: string }).name}] ${JSON.stringify((b as { input: unknown }).input ?? {}).slice(0, 400)}`,
          );
        else if (b.type === "tool_result")
          lines.push(
            `[tool_result ${(b as { name: string }).name}${(b as { is_error?: boolean }).is_error ? " ERROR" : ""}] ${String((b as { content: string }).content).slice(0, 600)}`,
          );
      }
      text = lines.join("\n");
    }
    if (chars + text.length > maxChars) break;
    parts.push(text);
    chars += text.length;
  }
  return parts.join("\n");
}

export function buildSummaryPrompt(transcript: string, priorSummary?: string): string {
  const prior = priorSummary
    ? `A previous summary of even older history follows. Fold it in: keep every still-relevant point, then update it with the newer transcript.\n<previous_summary>\n${priorSummary}\n</previous_summary>\n\n`
    : "";
  return `You are summarizing a coding-agent conversation so work can continue in a fresh context.

${prior}TRANSCRIPT (oldest first):
<transcript>
${transcript}
</transcript>

Produce a JSON object with EXACTLY these keys (no markdown, no commentary):
{
  "objective": string,                // the user's original goal, restated
  "constraints": string[],            // explicit constraints that must be respected
  "completedWork": string[],          // what has actually been done
  "filesChanged": string[],           // file paths created/modified/deleted
  "decisions": string[],              // important decisions + brief rationale
  "importantFindings": string[],      // facts later work depends on (api shapes, line numbers, config)
  "errors": string[],                 // errors encountered + resolution status
  "tests": string[],                  // test/verification results
  "pendingWork": string[],            // remaining work
  "toolState": string[],              // relevant tool/process/MCP state
  "checkpoints": string[],            // checkpoint ids mentioned, if any
  "resumeInstructions": string[]      // concrete next steps for the new context
}
Rules: never include API keys, tokens, or credentials. Be specific and factual — no filler.`;
}

// ============================================================================
// One-shot completion over the @codepilot/llm provider registry
// ============================================================================

export interface SummarizerConfig {
  providerId: string;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  privacyMode: "local" | "cloud";
  timeoutMs?: number;
  maxTranscriptChars?: number;
}

export interface SummarizeResult {
  summary: CompactionSummary;
  /** Raw text/output token estimates of the summarization call itself. */
  promptTokensEstimate: number;
  outputTokensEstimate: number;
  latencyMs: number;
  providerId: string;
  modelId: string;
}

/** Aggregate a provider stream into a string (extracts text chunks only). */
async function completeText(
  provider: LlmProvider,
  modelId: string,
  system: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const messages = [{ role: "user" as const, content: prompt }];
  let out = "";
  for await (const chunk of provider.stream({
    providerId: provider.id,
    modelId,
    systemPrompt: system,
    messages,
    signal,
  })) {
    if (chunk.type === "text-delta") out += chunk.text;
    if (chunk.type === "finish" && chunk.reason === "error") {
      throw new Error(chunk.error ?? "summarizer stream failed");
    }
    if (chunk.type === "finish" && chunk.reason === "aborted") {
      throw new Error("summarizer aborted");
    }
  }
  return out;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Summarize a conversation segment with a real model call. Throws
 * PrivacyViolationError when privacy forbids the provider; resolves null
 * on any other failure (caller falls back to truncation).
 */
export async function summarizeConversation(
  segment: ResumeWireMessage[],
  config: SummarizerConfig,
  options?: { priorSummary?: string; signal?: AbortSignal },
): Promise<SummarizeResult | null> {
  assertSummarizerPrivacyAllowed(config.providerId, config.privacyMode);

  const maxChars = config.maxTranscriptChars ?? 48_000;
  const transcript = renderTranscript(segment, maxChars);
  if (transcript.trim().length === 0) return null;

  const prompt = buildSummaryPrompt(transcript, options?.priorSummary);
  const promptTokensEstimate = Math.ceil(prompt.length / 4);
  const started = Date.now();

  const provider = createLlmProvider(
    { providerId: toNativeProviderId(config.providerId), modelId: config.modelId },
    {
      configs: [
        {
          providerId: toNativeProviderId(config.providerId),
          ...(config.apiKey ? { apiKey: config.apiKey } : {}),
          ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        },
      ],
    },
  );

  const timeoutMs = config.timeoutMs ?? 120_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  options?.signal?.addEventListener("abort", onOuterAbort, { once: true });
  if (options?.signal?.aborted) controller.abort();
  let text: string;
  try {
    text = await completeText(
      provider,
      config.modelId,
      SUMMARY_SYSTEM_PROMPT,
      prompt,
      controller.signal,
    );
  } catch {
    return null; // provider/timeout failure — caller falls back to truncation
  } finally {
    clearTimeout(timeout);
    options?.signal?.removeEventListener("abort", onOuterAbort);
  }

  const parsed = validateSummaryOutput(extractJson(text));
  if (!parsed.ok) return null;

  return {
    summary: parsed.summary,
    promptTokensEstimate,
    outputTokensEstimate: Math.ceil(text.length / 4),
    latencyMs: Date.now() - started,
    providerId: config.providerId,
    modelId: config.modelId,
  };
}

const SUMMARY_SYSTEM_PROMPT =
  "You are a precise engineering summarizer. Output only valid JSON matching the requested schema. Never invent facts not present in the transcript. Never include secrets.";
