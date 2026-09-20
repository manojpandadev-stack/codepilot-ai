/**
 * M12 — Compaction engine.
 *
 * Owns the compaction pipeline:
 *
 *   TaskStore conversation → pressure evaluation → (semantic | fallback)
 *   → CompactionArtifact → compacted `initialMessages` for native resume
 *
 * Invariants:
 * - The canonical TaskStore conversation is NEVER mutated destructively;
 *   artifacts are stored alongside and record the summarized range.
 * - A failed/aborted compaction leaves the task fully resumable.
 * - Protocol validity of summary + tail is checked before use.
 * - Idempotent per (taskId, toTs): concurrent/interrupted compactions of the
 *   same boundary reuse the existing artifact instead of duplicating work.
 */

import { createHash } from "node:crypto";
import { describeImage } from "@codepilot/shared";
import type { TaskStore } from "./m12-task-store.js";
import type {
  PersistedConversationMessage,
  PersistedTask,
} from "./m12-task-store.js";
import {
  evaluateCompactionNeed,
  type ContextPressure,
} from "./compaction-tokens.js";
import {
  safeCompactionBoundary,
  validateConversationProtocol,
} from "./compaction-protocol.js";
import {
  summarizeConversation,
  PrivacyViolationError,
  type SummarizerConfig,
  type SummarizeResult,
} from "./compaction-summarizer.js";
import {
  buildInitialMessages,
  type ResumeWireMessage,
  type WireBlock,
} from "./resume.js";
import type { CompactionArtifact } from "./compaction-types.js";

/** Bounded tool-result renderer (Phase 8 — tool-aware compaction). */
const MAX_TOOL_RESULT_IN_SUMMARY_SOURCE = 1_200;

/**
 * Tool-aware transcript shrinker: oversized tool_result contents are
 * head+tail bounded BEFORE the summarizer sees them, so one giant terminal
 * dump cannot crowd out the actual conversation.
 */
function shrinkSegmentForSummary(
  segment: ResumeWireMessage[],
): ResumeWireMessage[] {
  return segment.map((m) => {
    if (typeof m.content === "string") return m;
    const blocks: WireBlock[] = m.content.map((b): WireBlock => {
      if (b.type !== "tool_result") {
        // Image blocks cannot be summarized as pixels: replace with a
        // textual marker so token accounting stays honest. All other
        // blocks pass through untouched.
        if (b.type === "image") {
          return {
            type: "text",
            text: describeImage(b.mime, b.sizeBytes ?? 0),
          };
        }
        return b;
      }
      if (b.content.length <= MAX_TOOL_RESULT_IN_SUMMARY_SOURCE) return b;
      const head = b.content.slice(0, 700);
      const tail = b.content.slice(-400);
      return {
        ...b,
        content: `${head}\n…[bounded ${b.content.length} chars]…\n${tail}`,
      };
    });
    return {
      role: m.role,
      content: blocks,
      ...(m.ts !== undefined ? { ts: m.ts } : {}),
    };
  });
}

export interface CompactionEngineOptions {
  store: TaskStore;
  /** Resolve the summarizer call config for the ACTIVE provider/model. */
  resolveSummarizerConfig: () => Promise<SummarizerConfig | null>;
  /** Model/provider context-window lookups (host → catalogue/discovery). */
  lookupModelContextWindow?: (
    providerId: string,
    modelId: string,
  ) => number | undefined;
  lookupProviderContextWindow?: (providerId: string) => number | undefined;
  /**
   * TEST HOOK ONLY: overrides the one-shot summarizer call. Production
   * callers never set this — it exists so engine behavior can be verified
   * without a live model endpoint.
   */
  summarizeForTest?: (
    segment: ResumeWireMessage[],
    config: SummarizerConfig,
    options?: { priorSummary?: string; signal?: AbortSignal },
  ) => Promise<SummarizeResult | null>;
}

export interface CompactionOutcome {
  ran: boolean;
  mode?: "semantic" | "truncation-fallback" | "skipped";
  artifact?: CompactionArtifact;
  reason: string;
  pressure?: ContextPressure;
  /** Present when compaction ran: the summary message + tail wire shape. */
  compactedMessages?: ResumeWireMessage[];
  /** Token estimates for cost/observability (semantic mode). */
  summaryCost?: {
    promptTokensEstimate: number;
    outputTokensEstimate: number;
    latencyMs: number;
  };
}

function boundaryHash(taskId: string, toTs: number): string {
  return createHash("sha256")
    .update(`${taskId}:${toTs}`)
    .digest("hex")
    .slice(0, 16);
}

function renderSummaryText(
  s: NonNullable<CompactionArtifact["summary"]>,
): string {
  const lines: string[] = [];
  lines.push(`## Conversation summary (compacted context)`);
  lines.push(`**Objective:** ${s.objective}`);
  const section = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push(`**${title}:**`);
    for (const item of items.slice(0, 12)) lines.push(`- ${item}`);
  };
  section("Constraints", s.constraints);
  section("Completed work", s.completedWork);
  section("Files changed", s.filesChanged);
  section("Decisions", s.decisions);
  section("Key findings", s.importantFindings);
  section("Errors", s.errors);
  section("Tests", s.tests);
  section("Pending work", s.pendingWork);
  section("Tool state", s.toolState);
  section("Checkpoints", s.checkpoints);
  section("Next steps", s.resumeInstructions);
  return lines.join("\n");
}

type SummaryLike = CompactionArtifact["summary"];

function foldSummaries(
  prior: NonNullable<SummaryLike>,
  next: NonNullable<SummaryLike>,
): NonNullable<SummaryLike> {
  const merge = (
    a: string[] | undefined,
    b: string[] | undefined,
    cap: number,
  ): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of [...(b ?? []), ...(a ?? [])]) {
      const key = item.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      if (out.length >= cap) break;
    }
    return out;
  };
  return {
    objective: next.objective || prior.objective || "",
    constraints: merge(prior.constraints, next.constraints, 10),
    completedWork: merge(prior.completedWork, next.completedWork, 14),
    filesChanged: merge(prior.filesChanged, next.filesChanged, 20),
    decisions: merge(prior.decisions, next.decisions, 10),
    importantFindings: merge(
      prior.importantFindings,
      next.importantFindings,
      14,
    ),
    errors: merge(prior.errors, next.errors, 8),
    tests: merge(prior.tests, next.tests, 8),
    pendingWork: next.pendingWork?.length
      ? next.pendingWork
      : (prior.pendingWork ?? []),
    toolState: merge(prior.toolState, next.toolState, 8),
    checkpoints: merge(prior.checkpoints, next.checkpoints, 10),
    resumeInstructions: next.resumeInstructions?.length
      ? next.resumeInstructions
      : (prior.resumeInstructions ?? []),
  };
}

// Fold-in is applied on the NEXT semantic compaction after a prior one —
// kept for Phase 7 incremental use (see compactIfNeeded's priorSummary).
void foldSummaries;

export class CompactionEngine {
  constructor(private readonly options: CompactionEngineOptions) {}

  /** Public pressure probe (used by status reporting and tests). */
  evaluate(
    conversation: PersistedConversationMessage[],
    providerId: string,
    modelId: string,
  ): ContextPressure & { shouldCompact: boolean } {
    return evaluateCompactionNeed({
      conversation,
      providerId,
      modelId,
      lookupModelContextWindow: this.options.lookupModelContextWindow,
      lookupProviderContextWindow: this.options.lookupProviderContextWindow,
    });
  }

  /**
   * Attempt compaction for a task. Never throws for expected failures —
   * outcomes carry the reason. PrivacyViolationError propagates (host must
   * surface it; nothing was sent anywhere).
   */
  async compactIfNeeded(
    taskId: string,
    providerId: string,
    modelId: string,
  ): Promise<CompactionOutcome> {
    const store = this.options.store;
    const task = await store.get(taskId);
    if (!task?.conversation || task.conversation.length === 0) {
      return {
        ran: false,
        mode: "skipped",
        reason: "no conversation to compact",
      };
    }

    const pressure = this.evaluate(task.conversation, providerId, modelId);
    if (!pressure.shouldCompact) {
      return {
        ran: false,
        mode: "skipped",
        reason: `zone=${pressure.zone} ratio=${pressure.ratio.toFixed(2)}`,
        pressure,
      };
    }

    // ---- Boundary: keep the recent 40% of entries, cut at a safe point ----
    const total = task.conversation.length;
    const keepCount = Math.max(4, Math.floor(total * 0.4));
    const proposedToIndex = total - keepCount;
    const toIndex = safeCompactionBoundary(task.conversation, proposedToIndex);
    if (toIndex <= 0) {
      return {
        ran: false,
        mode: "skipped",
        reason: "no safe protocol boundary for compaction",
        pressure,
      };
    }
    const toTs = task.conversation[toIndex]!.timestampMs;

    // ---- Idempotency: same boundary already compacted? Reuse. ----
    const existingId = `compact-${boundaryHash(taskId, toTs)}`;
    const existing = (task.compactions ?? []).find((a) => a.id === existingId);
    if (existing) {
      return {
        ran: false,
        mode: existing.mode,
        reason: "boundary already compacted (artifact reused)",
        pressure,
        artifact: existing,
        compactedMessages: this.composeCompactedMessages(
          existing,
          task.conversation,
        ),
      };
    }

    const segment = buildInitialMessages({
      ...task,
      conversation: task.conversation.slice(0, toIndex),
    });
    if (segment.length === 0) {
      return { ran: false, mode: "skipped", reason: "empty segment", pressure };
    }

    const tokensBefore = pressure.estimatedTokens;
    const tail = task.conversation.slice(toIndex);
    const tailTokens = this.evaluate(tail, providerId, modelId).estimatedTokens;

    // ---- Semantic path: REAL model summarization ----
    const summarizerConfig = await this.options.resolveSummarizerConfig();
    if (summarizerConfig) {
      const prior = (task.compactions ?? []).at(-1);
      const priorSummaryText =
        prior?.mode === "semantic" && prior.summary
          ? renderSummaryText(prior.summary)
          : undefined;
      const summarize = this.options.summarizeForTest ?? summarizeConversation;
      const result = await summarize(
        shrinkSegmentForSummary(segment),
        summarizerConfig,
        { priorSummary: priorSummaryText },
      );
      if (result) {
        const summaryText = renderSummaryText(result.summary);
        const artifact: CompactionArtifact = {
          id: existingId,
          createdAtMs: Date.now(),
          sourceRange: {
            fromIndex: 0,
            toIndex,
            fromTs: task.conversation[0]!.timestampMs,
            toTs,
          },
          summarizedMessageCount: toIndex,
          remainingMessageCount: total - toIndex,
          summary: result.summary,
          summaryText,
          summarizer: {
            providerId: result.providerId,
            modelId: result.modelId,
          },
          tokensBefore,
          tokensAfter: tailTokens + Math.ceil(summaryText.length / 4),
          mode: "semantic",
          summaryVersion: 1,
          reason: `zone=${pressure.zone} ratio=${pressure.ratio.toFixed(2)}`,
        };
        await this.persistArtifact(taskId, artifact);
        return {
          ran: true,
          mode: "semantic",
          artifact,
          reason: artifact.reason,
          pressure,
          compactedMessages: this.composeCompactedMessages(
            artifact,
            task.conversation,
          ),
          summaryCost: {
            promptTokensEstimate: result.promptTokensEstimate,
            outputTokensEstimate: result.outputTokensEstimate,
            latencyMs: result.latencyMs,
          },
        };
      }
      // Fall through: summarization failed — bounded truncation fallback.
    }

    // ---- Fallback: bounded truncation (history preserved in TaskStore) ----
    const fallbackSummaryText =
      "Earlier conversation was compacted by bounded truncation (semantic summarization was unavailable). " +
      `Original objective: "${task.title.slice(0, 300)}". ${toIndex} earlier messages are preserved in the task store.`;
    const artifact: CompactionArtifact = {
      id: existingId,
      createdAtMs: Date.now(),
      sourceRange: {
        fromIndex: 0,
        toIndex,
        fromTs: task.conversation[0]!.timestampMs,
        toTs,
      },
      summarizedMessageCount: toIndex,
      remainingMessageCount: total - toIndex,
      summaryText: fallbackSummaryText,
      tokensBefore,
      tokensAfter: tailTokens + Math.ceil(fallbackSummaryText.length / 4),
      mode: "truncation-fallback",
      summaryVersion: 1,
      reason: `summarizer unavailable or failed; zone=${pressure.zone}`,
    };
    await this.persistArtifact(taskId, artifact);
    return {
      ran: true,
      mode: "truncation-fallback",
      artifact,
      reason: artifact.reason,
      pressure,
      compactedMessages: this.composeCompactedMessages(
        artifact,
        task.conversation,
      ),
    };
  }

  /**
   * Read-only composition for RESUME: rebuild summary + recent tail from the
   * task's LATEST persisted artifact. Never performs a summarization call —
   * artifacts are produced by post-run compaction (compactIfNeeded), resume
   * only consumes them. Returns null when no usable artifact exists.
   */
  composeFromTask(
    task: Pick<PersistedTask, "conversation" | "compactions">,
  ): ResumeWireMessage[] | null {
    const artifact = (task.compactions ?? []).at(-1);
    if (!artifact?.summaryText) return null;
    const composed = this.composeCompactedMessages(
      artifact,
      task.conversation ?? [],
    );
    return composed.length > 0 ? composed : null;
  }

  /**
   * Compose summary message + remaining conversation, validated. Returns
   * null when the composed shape would violate the protocol (caller keeps
   * the uncompacted history — never sends invalid wire shape).
   */
  composeCompactedMessages(
    artifact: CompactionArtifact,
    conversation: PersistedConversationMessage[],
  ): ResumeWireMessage[] {
    if (!artifact.summaryText) return [];
    const boundary = artifact.sourceRange.toIndex;
    const tail = conversation.slice(boundary);
    const tailWire = buildInitialMessages({
      ...conversation,
      conversation: tail,
    } as never);
    const summaryMessage: ResumeWireMessage = {
      role: "user",
      content: `${artifact.summaryText}\n\n(The above is a faithful summary of the earlier conversation; the original full history is preserved. Continue the task.)`,
    };
    const composed = [summaryMessage, ...tailWire];
    const validation = validateConversationProtocol(
      composed as Parameters<typeof validateConversationProtocol>[0],
    );
    if (!validation.valid) return [];
    return composed;
  }

  private async persistArtifact(
    taskId: string,
    artifact: CompactionArtifact,
  ): Promise<void> {
    await this.options.store.addCompactionArtifact(taskId, artifact);
  }
}

export { PrivacyViolationError };
