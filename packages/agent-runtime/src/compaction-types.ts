/**
 * M12 — Context compaction types.
 *
 * Shared by the compaction engine, the summarizer, and the TaskStore
 * (artifact persistence). JSON-safe by construction: artifacts are persisted
 * inside the task record and must round-trip without transformation.
 */

/**
 * Structured conversation summary. Every field is REQUIRED so validation can
 * reject malformed model output deterministically (empty arrays are valid —
 * missing keys are not).
 */
export interface CompactionSummary {
  /** The user's original objective, restated. */
  objective: string;
  /** Constraints the work must respect (explicit user constraints + rules). */
  constraints: string[];
  /** What has actually been done so far. */
  completedWork: string[];
  /** Files created/modified/deleted (paths only — never file contents). */
  filesChanged: string[];
  /** Important decisions and their rationale (bounded). */
  decisions: string[];
  /** Facts discovered from tools/repo that later work depends on. */
  importantFindings: string[];
  /** Errors encountered and their resolution status. */
  errors: string[];
  /** Test/verification results. */
  tests: string[];
  /** Remaining work. */
  pendingWork: string[];
  /** Relevant tool/MCP state (running processes, applied changesets, etc.). */
  toolState: string[];
  /** Checkpoint ids available for restore. */
  checkpoints: string[];
  /** Concrete instructions for the next turn. */
  resumeInstructions: string[];
}

/** Which compaction produced/updated this artifact. */
export type CompactionMode =
  /** A real model-generated structured summary was produced and used. */
  | "semantic"
  /** Summarization failed/blocked — bounded truncation kept recent history. */
  | "truncation-fallback";

/**
 * Persisted compaction artifact. The canonical `conversation` history is
 * NEVER mutated — the artifact records which range it covers so resume can
 * reconstruct `summary + messages-after-range` and audits can still read the
 * original history.
 */
export interface CompactionArtifact {
  id: string;
  createdAtMs: number;
  /** Conversation-index range covered (advisory; timestamps are authoritative). */
  sourceRange: {
    /** Inclusive start index in the conversation at compaction time. */
    fromIndex: number;
    /** Exclusive end index in the conversation at compaction time. */
    toIndex: number;
    /** Authoritative boundary: entries with ts <= toTs are summarized. */
    toTs: number;
    fromTs: number;
  };
  summarizedMessageCount: number;
  remainingMessageCount: number;
  /** Structured summary (semantic mode only; truncation artifacts omit it). */
  summary?: CompactionSummary;
  /** Rendered summary text injected into the model context (semantic mode). */
  summaryText?: string;
  /** Which provider/model produced the summary (semantic mode only). */
  summarizer?: { providerId: string; modelId: string };
  tokensBefore: number;
  tokensAfter: number;
  mode: CompactionMode;
  /** Schema version for future evolution. */
  summaryVersion: 1;
  /** Why compaction ran (zone/ratio/privacy note) — no secrets. */
  reason: string;
}
