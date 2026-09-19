/**
 * M12 — Verbatim resume planning (pure functions, no I/O).
 *
 * Turns a persisted task into a concrete resume plan:
 *
 *   persisted conversation (v2) → native `initialMessages`
 *   persisted modelConfig       → provider/model restore steps
 *
 * Purity is deliberate: the extension resolves live credentials (SecretStorage)
 * and validates workspace identity; this module owns the message
 * reconstruction + fidelity classification rules. It never invents history:
 *
 *   FULL    — v2 conversation present, ends on a clean user boundary
 *   PARTIAL — v2 conversation present, tail is mid-response
 *   LIMITED — v1 record (text log only) → continuation-prompt fallback
 */

import type { PersistedTask } from "./m12-task-store.js";

// ============================================================================
// Conversation reconstruction
// ============================================================================

/** Wire-shaped conversation message (native resume wire format). */
export interface ResumeWireMessage {
  role: "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
        | {
            type: "tool_result";
            tool_use_id: string;
            name: string;
            content: string;
            is_error?: boolean;
          }
      >;
  ts?: number;
}

/** Text/tool_use blocks allowed in an assistant message. */
type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

/** Tool_result blocks live in a following user message (protocol shape). */
type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  name: string;
  content: string;
  is_error?: boolean;
};

/** Any block in a wire message's content array (exported for consumers). */
export type WireBlock = AssistantBlock | ToolResultBlock;

/**
 * Build the `initialMessages` payload for a native session start from a persisted
 * task's v2 conversation. Storage pairs tool results inside the assistant
 * entry for compactness; the provider protocol requires them in a following
 * USER message, so they are re-split here. Bounded tool inputs are parsed
 * back to objects when valid JSON; non-JSON input is omitted rather than
 * guessed. Returns [] for v1 records — callers fall back to the continuation
 * prompt (see classifyResumeFidelity).
 */
export function buildInitialMessages(task: PersistedTask): ResumeWireMessage[] {
  const out: ResumeWireMessage[] = [];
  for (const entry of task.conversation ?? []) {
    if (entry.role === "user" || !entry.blocks) {
      // User entries may carry their content as plain `text` OR as `blocks`
      // (the TaskStore upsert path writes text blocks for user turns). Read
      // both — a user entry with blocks-only content must NOT become an
      // empty wire message (that breaks role alternation assumptions and
      // loses the user's words from restored history).
      const text =
        entry.text ??
        (entry.blocks ?? [])
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("\n");
      out.push({
        role: entry.role,
        content: text,
        ...(entry.timestampMs ? { ts: entry.timestampMs } : {}),
      });
      continue;
    }
    const assistantBlocks: AssistantBlock[] = [];
    const resultBlocks: ToolResultBlock[] = [];
    for (const b of entry.blocks) {
      if (b.type === "text") {
        assistantBlocks.push({ type: "text", text: b.text });
      } else if (b.type === "tool_use") {
        let input: Record<string, unknown> = {};
        if (b.input !== undefined) {
          try {
            const parsed: unknown = JSON.parse(b.input);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              input = parsed as Record<string, unknown>;
            }
          } catch {
            // Non-JSON (truncated/plain) — omitted rather than guessed.
          }
        }
        assistantBlocks.push({ type: "tool_use", id: b.id, name: b.name, input });
      } else {
        resultBlocks.push({
          type: "tool_result",
          tool_use_id: b.tool_use_id,
          name: b.name,
          content: b.content,
          ...(b.is_error ? { is_error: true } : {}),
        });
      }
    }
    if (assistantBlocks.length > 0) {
      out.push({
        role: "assistant",
        content: assistantBlocks,
        ...(entry.timestampMs ? { ts: entry.timestampMs } : {}),
      });
    }
    if (resultBlocks.length > 0) {
      out.push({
        role: "user",
        content: resultBlocks,
        ...(entry.timestampMs ? { ts: entry.timestampMs } : {}),
      });
    }
  }
  return out;
}

// ============================================================================
// Per-turn continuation selection (M12 v5)
// ----------------------------------------------------------------------------
// Shared builder for seeding a NEW turn with a previous task's canonical
// history. Same conversion as resume (buildInitialMessages), same compacted
// preference rule, plus an optional trailing trim so an interrupted tool
// exchange is never seeded as an unpaired tool_use (providers reject those;
// the store keeps the original untouched — only the seeded VIEW is trimmed).
// The caller MUST still run the strict protocol validator before passing the
// result to a native session and MUST seed nothing when validation fails.
// ============================================================================

export interface ContinuationSelectOptions {
  /**
   * Pre-composed compacted alternative (CompactionEngine.composeFromTask).
   * Preferred only when strictly shorter and non-empty (resume rule).
   */
  compacted?: ResumeWireMessage[] | null;
  /**
   * Drop a trailing assistant message whose tool_use blocks have no paired
   * tool_result (only possible as the last message). Default false so the
   * resume path keeps its exact long-standing behavior; per-turn seeding
   * passes true.
   */
  trimIncompleteTail?: boolean;
}

/**
 * Drop a trailing assistant message's unpaired tool_use blocks. Tool_result
 * blocks live in the message FOLLOWING their tool_use, so a tool_use in the
 * LAST message is unpaired by construction (providers reject those). Any
 * trailing text is preserved as a text-only message — only the unpairable
 * tool calls are withheld. The store keeps the original untouched; only the
 * seeded VIEW is adjusted. Fully-paired and text-only tails pass through.
 */
export function trimTrailingIncompleteToolExchange(
  messages: ResumeWireMessage[],
): ResumeWireMessage[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1]!;
  if (last.role !== "assistant" || !Array.isArray(last.content)) {
    return messages;
  }
  const hasUnpairedUse = last.content.some((b) => b.type === "tool_use");
  if (!hasUnpairedUse) return messages;
  const texts = last.content.filter((b) => b.type === "text");
  if (texts.length === 0) return messages.slice(0, -1);
  return [...messages.slice(0, -1), { ...last, content: texts }];
}

/**
 * Select history for a new turn from a previous task's canonical record.
 * Pure: reads nothing, invents nothing. Returns [] when there is no usable
 * history (v1 record, empty conversation, or everything trimmed away).
 */
export function selectContinuationMessages(
  task: PersistedTask,
  opts: ContinuationSelectOptions = {},
): ResumeWireMessage[] {
  let messages = buildInitialMessages(task);
  const compacted = opts.compacted;
  if (compacted && compacted.length > 0 && compacted.length < messages.length) {
    messages = compacted;
  }
  if (opts.trimIncompleteTail) {
    messages = trimTrailingIncompleteToolExchange(messages);
  }
  return messages;
}

// ============================================================================
// Multi-turn chain selection (M12 v5)
// ----------------------------------------------------------------------------
// A chat session is a CHAIN of per-turn tasks (one TaskStore record per
// turn). Seeding only the immediately previous task reaches exactly one turn
// back — turn 3 would lose turn 1. The chain selector concatenates every
// task's selected history in session order (each via selectContinuationMessages
// with its own compacted alternative), so the model receives the whole
// conversation. Bounded to the most recent tasks; each segment is trimmed so
// no boundary carries an unpaired tool_use into the provider request.
// ============================================================================

/** Hard bound on chained tasks per seed (context discipline). */
export const MAX_TURN_CHAIN_TASKS = 10;

export interface ContinuationChainOptions {
  /**
   * Per-task compacted alternative resolver (CompactionEngine.composeFromTask).
   * May return null; throwing resolvers are treated as null.
   */
  composeCompacted?: (task: PersistedTask) => ResumeWireMessage[] | null;
  /** Maximum tasks from the tail of the chain to include. */
  maxTasks?: number;
}

/**
 * Concatenate per-task continuation histories oldest→newest. Pure.
 * Missing/empty tasks contribute nothing; unpaired tool tails are trimmed
 * per segment so every task boundary handed to the provider is clean.
 */
export function selectContinuationChain(
  tasksInOrder: PersistedTask[],
  opts: ContinuationChainOptions = {},
): ResumeWireMessage[] {
  const maxTasks = Math.max(1, opts.maxTasks ?? MAX_TURN_CHAIN_TASKS);
  const recent = tasksInOrder.slice(-maxTasks);
  const out: ResumeWireMessage[] = [];
  for (const task of recent) {
    let compacted: ResumeWireMessage[] | null = null;
    if (opts.composeCompacted) {
      try {
        compacted = opts.composeCompacted(task);
      } catch {
        compacted = null;
      }
    }
    out.push(
      ...selectContinuationMessages(task, {
        ...(compacted ? { compacted } : {}),
        trimIncompleteTail: true,
      }),
    );
  }
  return out;
}

// ============================================================================
// Fidelity classification
// ============================================================================

export type ResumeFidelity = "FULL" | "PARTIAL" | "LIMITED";

export interface ResumeFidelityInfo {
  fidelity: ResumeFidelity;
  /** Human-readable reason shown in logs/UI; no secrets. */
  reason: string;
}

/**
 * Classify how faithfully this task can be resumed. Deliberately honest:
 * - v1 records (no v2 conversation) are LIMITED — continuation prompt only.
 * - v2 conversation ending on an assistant entry (mid-response) is PARTIAL.
 * - v2 ending on a clean user boundary is FULL.
 */
export function classifyResumeFidelity(task: PersistedTask): ResumeFidelityInfo {
  const conv = task.conversation;
  if (!conv || conv.length === 0) {
    return {
      fidelity: "LIMITED",
      reason:
        "Persisted before verbatim resume (v1 record): only the title and bounded text log exist, so resume uses a continuation prompt.",
    };
  }
  const last = conv[conv.length - 1]!;
  if (last.role === "assistant") {
    return {
      fidelity: "PARTIAL",
      reason:
        "Conversation ends with an assistant entry (possibly mid-response); history is restored verbatim but the interrupted turn may repeat partially completed work.",
    };
  }
  return {
    fidelity: "FULL",
    reason: "Faithful conversation restored from the persisted task record.",
  };
}

// ============================================================================
// Provider/model restoration plan
// ============================================================================

/** Safe provider metadata subset (never carries credentials). */
export interface ResumeProviderPlan {
  providerId: string;
  modelId: string;
  /** Where each value came from — surfaced to the user honestly. */
  source: "task" | "current";
  notes: string[];
}

/**
 * Plan provider/model restoration: prefer the task's own config when the
 * provider is still known, otherwise keep current settings and say so.
 * Credentials are NEVER part of the plan — the host re-resolves them from
 * SecretStorage at start time.
 */
export function planProviderRestore(
  task: PersistedTask,
  currentProviderId: string,
  isKnownProvider: (id: string) => boolean,
): ResumeProviderPlan {
  const mc = (task.modelConfig ?? {}) as Record<string, unknown>;
  const taskProvider = typeof mc.providerId === "string" ? mc.providerId : undefined;
  const taskModel = typeof mc.modelId === "string" ? mc.modelId : undefined;
  const notes: string[] = [];
  if (taskProvider && isKnownProvider(taskProvider)) {
    return {
      providerId: taskProvider,
      modelId: taskModel ?? "",
      source: "task",
      notes,
    };
  }
  if (taskProvider) {
    notes.push(
      `Task provider "${taskProvider}" is no longer available; using current provider "${currentProviderId}".`,
    );
  }
  return {
    providerId: currentProviderId,
    modelId: taskModel ?? "",
    source: "current",
    notes,
  };
}
