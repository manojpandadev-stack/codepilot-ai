/**
 * M12 v4 — run conversation capture (pure, host-agnostic).
 *
 * ONE capture object per runtime run. The host accumulates the run's parts
 * (streamed assistant text, tool_use requests, tool_result payloads) in memory
 * and composes the persisted entry deterministically:
 *
 *     [ text ] + [ tool_use … ] + [ tool_result … ]
 *
 * Composition is from memory — never read → mutate stored entry → write — so
 * a tool_result can never be lost to a concurrent write, and blocks can never
 * be duplicated by overlapping flushes. Every mutation marks the capture
 * dirty; the host flushes on a short debounce and at every structural
 * boundary (tool transition, completion, error, cancellation).
 *
 * Bounded memory: assistant text is hard-capped (`maxTextChars`), tool
 * inputs/results are bounded at record time. The store bounds + redacts again
 * on write (defense in depth); this module owns the in-memory cap.
 */

import { boundedSerialize } from "./m12-task-store.js";
import type { PersistedConversationMessage } from "./m12-task-store.js";

/** Structured blocks of one persisted run entry. */
export type CapturedBlocks = NonNullable<
  PersistedConversationMessage["blocks"]
>;

/** Default in-memory cap for one run's captured assistant text. */
export const DEFAULT_MAX_CAPTURED_TEXT = 200_000;
/** Default bound for one captured tool input (matches the store's limit). */
export const DEFAULT_MAX_CAPTURED_INPUT = 4_000;
/** Default bound for one captured tool result (matches the store's limit). */
export const DEFAULT_MAX_CAPTURED_RESULT = 8_000;

/** Bounded tool-result payload held in memory until flush. */
export interface CapturedToolResult {
  content: string;
  isError: boolean;
}

/**
 * Mutable per-run accumulation state. The host owns the instance; every
 * helper below is pure with respect to the store (no I/O).
 */
export interface RunCaptureState {
  /** Stable per-run key — the host upserts ONE entry per key. */
  key: string;
  /** Accumulated assistant text for this run (bounded). */
  text: string;
  /** toolCallId → raw input, insertion-ordered. */
  toolInputs: Map<string, unknown>;
  /** toolCallId → tool name. */
  toolNames: Map<string, string>;
  /** toolCallId → bounded result, insertion-ordered. */
  toolResults: Map<string, CapturedToolResult>;
  /** True when unflushed mutations exist. */
  dirty: boolean;
}

/** Fresh capture for a new run. */
export function createRunCapture(): RunCaptureState {
  return {
    key: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text: "",
    toolInputs: new Map(),
    toolNames: new Map(),
    toolResults: new Map(),
    dirty: false,
  };
}

/**
 * Accumulate streamed assistant text. When the runtime provides the full
 * `accumulated` string it wins verbatim; otherwise the delta is appended.
 * The result is hard-capped at `maxChars` (head kept) so a pathological
 * stream cannot grow memory without bound.
 */
export function appendCaptureText(
  capture: RunCaptureState,
  text: string,
  accumulated: string | undefined,
  maxChars: number = DEFAULT_MAX_CAPTURED_TEXT,
): void {
  const next =
    typeof accumulated === "string" && accumulated.length > 0
      ? accumulated
      : capture.text + text;
  capture.text = next.length > maxChars ? next.slice(0, maxChars) : next;
  capture.dirty = true;
}

/** Record a tool_use request (idempotent per toolCallId). */
export function recordCaptureToolUse(
  capture: RunCaptureState,
  toolCallId: string,
  toolName: string,
  input: unknown,
): void {
  if (!capture.toolNames.has(toolCallId)) {
    capture.toolNames.set(toolCallId, toolName);
  }
  if (input !== undefined && input !== null) {
    capture.toolInputs.set(toolCallId, input);
  }
  capture.dirty = true;
}

/**
 * Record a tool_result payload, bounded at record time. Unknown-agnostic:
 * objects are JSON-serialized, strings kept verbatim, always hard-capped.
 */
export function recordCaptureToolResult(
  capture: RunCaptureState,
  toolCallId: string,
  toolName: string,
  output: unknown,
  isError: boolean,
  maxChars: number = DEFAULT_MAX_CAPTURED_RESULT,
): void {
  if (!capture.toolNames.has(toolCallId)) {
    capture.toolNames.set(toolCallId, toolName);
  }
  const content =
    typeof output === "string"
      ? output.slice(0, maxChars)
      : boundedSerialize(output, maxChars);
  capture.toolResults.set(toolCallId, { content, isError });
  capture.dirty = true;
}

/** True when the capture holds nothing worth persisting. */
export function isCaptureEmpty(capture: RunCaptureState): boolean {
  return (
    capture.text.length === 0 &&
    capture.toolInputs.size === 0 &&
    capture.toolResults.size === 0 &&
    capture.toolNames.size === 0
  );
}
/**
 * Deterministically compose the persisted blocks: optional leading text,
 * then tool_use blocks in first-seen order, then tool_result blocks in
 * completion order. A result whose request was never captured still emits its
 * tool_use (name known, empty input) so tool_use/tool_result pairing required
 * for faithful resume is never broken.
 */
export function composeRunBlocks(
  capture: RunCaptureState,
  maxInputChars: number = DEFAULT_MAX_CAPTURED_INPUT,
): CapturedBlocks {
  const blocks: CapturedBlocks = [];
  if (capture.text.length > 0) {
    blocks.push({ type: "text", text: capture.text });
  }
  const useIds = new Set<string>([
    ...capture.toolInputs.keys(),
    ...capture.toolNames.keys(),
    ...capture.toolResults.keys(),
  ]);
  for (const toolCallId of useIds) {
    const input = capture.toolInputs.get(toolCallId);
    blocks.push({
      type: "tool_use",
      id: toolCallId,
      name: (capture.toolNames.get(toolCallId) ?? "unknown").slice(0, 120),
      ...(input !== undefined && input !== null
        ? { input: boundedSerialize(input, maxInputChars) }
        : {}),
    });
  }
  for (const [toolCallId, result] of capture.toolResults) {
    blocks.push({
      type: "tool_result",
      tool_use_id: toolCallId,
      name: (capture.toolNames.get(toolCallId) ?? "unknown").slice(0, 120),
      content: result.content,
      ...(result.isError ? { is_error: true } : {}),
    });
  }
  return blocks;
}

// ============================================================================
// Debounced flush scheduling
// ============================================================================

/**
 * Schedules debounced persistence flushes for run captures.
 *
 * ONLY persistence is debounced — the host forwards live deltas to the UI
 * synchronously and independently. Each `schedule()` marks the capture dirty
 * and arms a single short timer; when it fires, every pending dirty capture
 * is handed to `flush` (which the host routes through TaskPersistenceQueue).
 * Captures are independent objects, so a run rotation never strands or
 * corrupts an older run's pending flush.
 *
 * Flush on: idle debounce, tool transition (host calls `flushNow`-equivalent
 * by enqueueing directly), iteration completion, final completion, error,
 * cancellation. `cancel()` drops the timer and the pending set — terminal
 * paths call it because they perform the final flush themselves inside the
 * terminal queue op.
 */
export class CaptureFlushScheduler {
  private pending = new Map<
    string,
    { taskId: string; capture: RunCaptureState }
  >();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly debounceMs: number,
    private readonly flush: (taskId: string, capture: RunCaptureState) => void,
  ) {}

  /** Mark `capture` dirty and ensure a flush is scheduled. Never throws. */
  schedule(taskId: string, capture: RunCaptureState): void {
    capture.dirty = true;
    this.pending.set(capture.key, { taskId, capture });
    if (this.timer !== null) return;
    const timer = setTimeout(
      () => {
        this.timer = null;
        const due = [...this.pending.values()];
        this.pending.clear();
        for (const { taskId: id, capture: cap } of due) {
          if (!cap.dirty) continue;
          cap.dirty = false;
          try {
            this.flush(id, cap);
          } catch {
            // A throwing flush must never break the scheduling of others.
          }
        }
      },
      Math.max(0, this.debounceMs),
    );
    // An audit/persistence timer must never keep the host alive.
    (timer as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  /** Drop the timer and pending set (terminal paths flush explicitly). */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
  }

  /** Pending dirty captures (test introspection). */
  get pendingCount(): number {
    return this.pending.size;
  }
}
