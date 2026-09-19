/**
 * M12/M5 — TaskHistoryService: extension-host backend for the Task History UX.
 *
 * The SINGLE source of truth for task-history views. The WebView never holds
 * authoritative state: every list/details/compare/resume/restart/discard
 * request flows WebView → validated extension handler → here → the EXISTING
 * M12 TaskStore, M5 CheckpointManager/FileMutationService and (for live
 * data) the CodePilotRuntime snapshot. No second persistence system, no
 * frontend-computed diffs, no fake state.
 *
 * Data honesty rules:
 * - Persisted task records (M12) provide identity/title/status/messages/
 *   model config/timestamps. The TaskStore redacts secret-shaped values.
 * - Run metrics (tool calls, retries, files) come from persisted agentState
 *   counters (written on completion/failure) or, for the ACTIVE task only,
 *   from the live runtime snapshot. Absent data renders as empty/unknown —
 *   never invented.
 * - Timeline phases are DERIVED from real persisted messages + checkpoint
 *   timestamps (documented mapping, no synthetic phases).
 * - File summaries come from the M5 mutation ledger (applied truth).
 * - Checkpoint comparison reuses the M5 computeDiff engine with hard bounds.
 * - Restore is NOT implemented here: callers must use the existing
 *   M4-gated checkpoint/restore path (CheckpointManager → FileMutationService
 *   → PathGuard). This module only enforces checkpoint OWNERSHIP checks.
 */

import type { TaskStore, PersistedTask } from "@codepilot/agent-runtime";
import type {
  Checkpoint,
  TrackedChange,
} from "@codepilot/changeset-engine";
import { computeDiff } from "@codepilot/changeset-engine";

// ============================================================================
// View types (wire format — mirrors the WebView contract)
// ============================================================================

export interface TaskToolSummary {
  name: string;
  count: number;
  totalDurationMs: number;
}

export interface TaskSummary {
  id: string;
  sessionId?: string;
  title: string;
  promptExcerpt: string;
  status: string;
  mode?: string;
  provider?: string;
  model?: string;
  createdAtMs: number;
  updatedAtMs: number;
  durationMs?: number;
  messageCount: number;
  toolCallCount: number;
  retryCount: number;
  filesChangedCount: number;
  checkpointCount: number;
  hasErrors: boolean;
  resultExcerpt?: string;
}

export interface TimelineEvent {
  timestampMs: number;
  /** Derived phase label (see mapping docs on buildTimeline). */
  phase: string;
  kind: "created" | "prompt" | "response" | "system" | "tool" | "checkpoint" | "status";
  summary: string;
}

export interface TaskFileEntry {
  path: string;
  changeType: "created" | "modified" | "deleted" | "renamed" | "moved";
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Bounded unified-diff excerpt from the M5 ledger (never computed here). */
  diffExcerpt?: string;
}

export interface TaskFileSummary {
  created: TaskFileEntry[];
  modified: TaskFileEntry[];
  deleted: TaskFileEntry[];
  renamed: TaskFileEntry[];
  totalAdditions: number;
  totalDeletions: number;
}

export interface TaskCheckpointView {
  checkpointId: string;
  taskId: string;
  timestamp: number;
  description: string;
  fileCount: number;
  status: string;
  files: string[];
}

export interface TaskDetails extends TaskSummary {
  timeline: TimelineEvent[];
  files: TaskFileSummary;
  checkpoints: TaskCheckpointView[];
  /** Bounded message excerpts (oldest→newest, capped). */
  messages: Array<{ role: string; excerpt: string; timestampMs: number }>;
  tools: TaskToolSummary[];
  approvalsNote: string;
  errors: string[];
  metrics: {
    toolCallCount: number;
    retryCount: number;
    filesChangedCount: number;
    checkpointCount: number;
    messageCount: number;
  };
  interruption?: {
    interruptedAtMs: number;
    lastPhase: string;
    lastAssistantExcerpt?: string;
    pendingSummary: string;
    filesChanged: string[];
    checkpointsAvailable: number;
    error?: string;
  };
}

export interface TaskFilter {
  status?: string;
  provider?: string;
  model?: string;
  mode?: string;
  query?: string;
  failedOnly?: boolean;
  interruptedOnly?: boolean;
  completedOnly?: boolean;
  hasCheckpoints?: boolean;
  hasFiles?: boolean;
  fromMs?: number;
  toMs?: number;
  limit?: number;
}

export type CompareVerdict = "SAME" | "BETTER" | "WORSE" | "DIFFERENT" | "UNKNOWN";

export interface CompareRow {
  metric: string;
  a: string;
  b: string;
  verdict: CompareVerdict;
  note?: string;
}

export interface CheckpointFileDiff {
  path: string;
  oldPath?: string;
  operation: "added" | "removed" | "modified" | "renamed" | "unchanged";
  additions: number;
  deletions: number;
  binary: boolean;
  unifiedDiff?: string;
}

export interface CheckpointCompareView {
  aId: string;
  bId: string;
  added: string[];
  removed: string[];
  modified: string[];
  renamed: Array<{ from: string; to: string }>;
  unchanged: number;
  diffs: CheckpointFileDiff[];
  truncated: boolean;
}

// ============================================================================
// Live runtime snapshot (active task only; null when unavailable)
// ============================================================================

export interface LiveTaskSnapshot {
  taskId: string | null;
  sessionId: string | null;
  status: string;
  agentState: string;
  toolCalls: TaskToolSummary[];
  retries: number;
  filesChanged: string[];
  inputTokens: number;
  outputTokens: number;
  error: string | null;
}

// ============================================================================
// Validation
// ============================================================================

const TASK_ID_PATTERN = /^task-[0-9]+-[a-z0-9]+$/;
const CHECKPOINT_ID_PATTERN = /^cp-[a-z0-9]+-[a-f0-9]+$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isValidTaskId(id: unknown): id is string {
  return typeof id === "string" && TASK_ID_PATTERN.test(id);
}

export function isValidCheckpointId(id: unknown): id is string {
  return typeof id === "string" && CHECKPOINT_ID_PATTERN.test(id);
}

export function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID_PATTERN.test(id);
}

function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// Bounds (memory + WebView payload discipline).
const MAX_LIST = 200;
const MAX_TIMELINE = 200;
const MAX_MESSAGES = 100;
const MESSAGE_EXCERPT = 1000;
const MAX_FILES = 50;
const DIFF_EXCERPT_CHARS = 5000;
const MAX_COMPARE_FILES = 20;
const MAX_COMPARE_BYTES = 30_000;

// ============================================================================
// Resume prompt builder (pure — shared by session/resume and task/resume)
// ============================================================================

export interface ResumeContext {
  title: string;
  messages: Array<{ role: string; content: string }>;
  checkpointsAvailable: number;
  filesChanged: string[];
}

/**
 * Build a resume prompt from REAL persisted context. Rules (no blind repeat):
 * - tool outputs are stale across restarts → excluded;
 * - completed work is named explicitly with a do-not-repeat instruction;
 * - history is bounded (12 turns) and excerpted;
 * - no approval/auto language is ever emitted (M4 still gates everything).
 */
export function buildResumePrompt(ctx: ResumeContext): string {
  const HISTORY_TURNS = 12;
  const history = ctx.messages
    .filter((m) => m.role !== "tool")
    .slice(-HISTORY_TURNS * 2)
    .map((m) => `[${m.role}] ${clean(m.content, 400)}`)
    .join("\n");
  const lastAssistant = [...ctx.messages].reverse().find((m) => m.role === "assistant");
  const parts = [
    `Resume task: ${clean(ctx.title, 200)}`,
    history ? `Previous conversation (most recent last):\n${history}` : undefined,
    lastAssistant
      ? `Last assistant response ended with: "${clean(lastAssistant.content, 200)}". Continue from where the task left off. Do not repeat completed work.`
      : "Continue the task.",
  ];
  if (ctx.filesChanged.length > 0) {
    parts.push(`Files already changed (do not redo): ${ctx.filesChanged.slice(0, 20).join(", ")}`);
  }
  if (ctx.checkpointsAvailable > 0) {
    parts.push(`${ctx.checkpointsAvailable} checkpoint(s) are available for restore if needed.`);
  }
  return parts.filter(Boolean).join("\n\n");
}

// ============================================================================
// Service
// ============================================================================

export interface TaskHistoryDeps {
  taskStore: TaskStore;
  listCheckpoints: (taskId?: string) => Checkpoint[];
  getCheckpoint: (checkpointId: string) => Checkpoint | undefined;
  listMutations: (taskId?: string) => TrackedChange[];
  /** Live snapshot of the ACTIVE task, or null. */
  getLiveSnapshot?: () => LiveTaskSnapshot | null;
}

interface AgentStateCounters {
  sessionId?: string;
  mode?: string;
  toolCalls?: TaskToolSummary[];
  toolCallCount?: number;
  retries?: number;
  filesChanged?: string[];
  inputTokens?: number;
  outputTokens?: number;
  lastError?: string;
}

function readCounters(task: PersistedTask): AgentStateCounters {
  const s = task.agentState;
  if (!s || typeof s !== "object") return {};
  const c = s as Record<string, unknown>;
  const tools = Array.isArray(c.toolCalls)
    ? (c.toolCalls as unknown[]).flatMap((t) => {
        if (!t || typeof t !== "object") return [];
        const r = t as Record<string, unknown>;
        if (typeof r.name !== "string") return [];
        return [
          {
            name: r.name.slice(0, 64),
            count: typeof r.count === "number" ? r.count : 0,
            totalDurationMs: typeof r.totalDurationMs === "number" ? r.totalDurationMs : 0,
          },
        ];
      })
    : undefined;
  return {
    ...(typeof c.sessionId === "string" ? { sessionId: c.sessionId } : {}),
    ...(typeof c.mode === "string" ? { mode: c.mode } : {}),
    ...(tools ? { toolCalls: tools } : {}),
    ...(typeof c.toolCallCount === "number" ? { toolCallCount: c.toolCallCount } : {}),
    ...(typeof c.retries === "number" ? { retries: c.retries } : {}),
    ...(Array.isArray(c.filesChanged)
      ? { filesChanged: c.filesChanged.filter((f): f is string => typeof f === "string").slice(0, 100) }
      : {}),
    ...(typeof c.inputTokens === "number" ? { inputTokens: c.inputTokens } : {}),
    ...(typeof c.outputTokens === "number" ? { outputTokens: c.outputTokens } : {}),
    ...(typeof c.lastError === "string" ? { lastError: c.lastError.slice(0, 500) } : {}),
  };
}

function firstUserPrompt(task: PersistedTask): string {
  const first = task.messages.find((m) => m.role === "user");
  return first ? first.content : task.title;
}

function lastAssistantResult(task: PersistedTask): string | undefined {
  const last = [...task.messages].reverse().find((m) => m.role === "assistant");
  return last?.content;
}

function messageErrors(task: PersistedTask): string[] {
  return task.messages
    .filter((m) => m.role === "system" && m.content.startsWith("Error:"))
    .map((m) => m.content.slice(0, 500));
}

export class TaskHistoryService {
  constructor(private readonly deps: TaskHistoryDeps) {}

  // ---- List (backend filtering; bounded) --------------------------------------

  async list(filter: TaskFilter = {}): Promise<TaskSummary[]> {
    const limit = Math.max(1, Math.min(MAX_LIST, Math.floor(filter.limit ?? MAX_LIST)));
    const records = await this.deps.taskStore.list();
    const q = (filter.query ?? "").trim().toLowerCase();
    const out: TaskSummary[] = [];
    for (const record of records) {
      if (this.isTeamRecord(record)) continue;
      const summary = this.toSummary(record);
      if (filter.status && summary.status !== filter.status) continue;
      if (filter.provider && summary.provider !== filter.provider) continue;
      if (filter.model && summary.model !== filter.model) continue;
      if (filter.mode && summary.mode !== filter.mode) continue;
      if (filter.failedOnly && summary.status !== "failed") continue;
      if (filter.interruptedOnly && summary.status !== "interrupted") continue;
      if (filter.completedOnly && summary.status !== "completed") continue;
      if (filter.hasCheckpoints && summary.checkpointCount === 0) continue;
      if (filter.hasFiles && summary.filesChangedCount === 0) continue;
      if (filter.fromMs !== undefined && summary.createdAtMs < filter.fromMs) continue;
      if (filter.toMs !== undefined && summary.createdAtMs > filter.toMs) continue;
      if (q) {
        const hay = `${summary.title} ${summary.promptExcerpt} ${summary.id}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      out.push(summary);
      if (out.length >= limit) break;
    }
    return out;
  }

  // ---- Details --------------------------------------------------------------------

  async details(
    taskId: unknown,
  ): Promise<{ ok: true; details: TaskDetails } | { ok: false; errors: string[] }> {
    if (!isValidTaskId(taskId)) return { ok: false, errors: ["invalid task id"] };
    const record = await this.deps.taskStore.get(taskId);
    if (!record || this.isTeamRecord(record)) {
      return { ok: false, errors: [`unknown task: ${taskId}`] };
    }
    const summary = this.toSummary(record);
    const checkpoints = this.checkpointsFor(record);
    const files = this.fileSummaryFor(record);
    const timeline = this.buildTimeline(record, checkpoints.map((c) => ({ id: c.checkpointId, timestamp: c.timestamp })));
    const messages = record.messages.slice(-MAX_MESSAGES).map((m) => ({
      role: m.role,
      excerpt: clean(m.content, MESSAGE_EXCERPT),
      timestampMs: m.timestampMs,
    }));
    const counters = readCounters(record);
    const live = this.liveFor(record.id);
    const tools = live?.toolCalls ?? counters.toolCalls ?? [];
    const errors = [...messageErrors(record)];
    if (counters.lastError && !errors.includes(counters.lastError)) errors.push(counters.lastError);
    if (live?.error && !errors.includes(live.error)) errors.push(live.error);
    const details: TaskDetails = {
      ...summary,
      // Live snapshot wins for the active task only.
      ...(live
        ? {
            status: live.status,
            toolCallCount: live.toolCalls.reduce((n, t) => n + t.count, 0),
            retryCount: live.retries,
            filesChangedCount: live.filesChanged.length,
          }
        : {}),
      timeline,
      files,
      checkpoints,
      messages,
      tools,
      approvalsNote:
        "Per-task approval counts are not tracked. Every tool execution required M4 approval at run time; see the approval history in the chat session.",
      errors: errors.slice(0, 20),
      metrics: {
        toolCallCount: live
          ? live.toolCalls.reduce((n, t) => n + t.count, 0)
          : (counters.toolCallCount ?? tools.reduce((n, t) => n + t.count, 0)),
        retryCount: live?.retries ?? counters.retries ?? 0,
        filesChangedCount: live?.filesChanged.length ?? filesCount(files),
        checkpointCount: checkpoints.length,
        messageCount: record.messages.length,
      },
    };
    if (summary.status === "interrupted" || (live == null && summary.status === "running")) {
      details.interruption = this.interruptionInfo(record, checkpoints.length, files);
    }
    return { ok: true, details };
  }

  // ---- Checkpoints ------------------------------------------------------------------

  async checkpointsForTask(
    taskId: unknown,
  ): Promise<{ ok: true; checkpoints: TaskCheckpointView[] } | { ok: false; errors: string[] }> {
    if (!isValidTaskId(taskId)) return { ok: false, errors: ["invalid task id"] };
    const record = await this.deps.taskStore.get(taskId);
    if (!record || this.isTeamRecord(record)) {
      return { ok: false, errors: [`unknown task: ${taskId}`] };
    }
    return { ok: true, checkpoints: this.checkpointsFor(record) };
  }

  /**
   * Ownership check shared by destructive checkpoint operations: the
   * checkpoint must belong to one of the task's candidate ids.
   */
  async checkCheckpointOwnership(
    taskId: unknown,
    checkpointId: unknown,
  ): Promise<{ ok: true; checkpointId: string } | { ok: false; errors: string[] }> {
    if (!isValidTaskId(taskId)) return { ok: false, errors: ["invalid task id"] };
    if (!isValidCheckpointId(checkpointId)) return { ok: false, errors: ["invalid checkpoint id"] };
    const record = await this.deps.taskStore.get(taskId);
    if (!record || this.isTeamRecord(record)) {
      return { ok: false, errors: [`unknown task: ${taskId}`] };
    }
    const checkpoint = this.deps.getCheckpoint(checkpointId);
    if (!checkpoint) return { ok: false, errors: [`unknown checkpoint: ${checkpointId}`] };
    if (!this.candidateIds(record).includes(checkpoint.taskId)) {
      return {
        ok: false,
        errors: [`checkpoint ${checkpointId} does not belong to task ${taskId} (cross-task rejected)`],
      };
    }
    return { ok: true, checkpointId };
  }

  // ---- Checkpoint comparison (M5 diff engine, bounded) ----------------------------------

  compareCheckpoints(
    aId: unknown,
    bId: unknown,
  ):
    | { ok: true; compare: CheckpointCompareView }
    | { ok: false; errors: string[] } {
    if (!isValidCheckpointId(aId)) return { ok: false, errors: ["invalid checkpoint id (a)"] };
    if (!isValidCheckpointId(bId)) return { ok: false, errors: ["invalid checkpoint id (b)"] };
    const a = this.deps.getCheckpoint(aId);
    const b = this.deps.getCheckpoint(bId);
    if (!a) return { ok: false, errors: [`unknown checkpoint: ${aId}`] };
    if (!b) return { ok: false, errors: [`unknown checkpoint: ${bId}`] };
    if (aId === bId) {
      return {
        ok: true,
        compare: {
          aId,
          bId,
          added: [],
          removed: [],
          modified: [],
          renamed: [],
          unchanged: a.files.length,
          diffs: [],
          truncated: false,
        },
      };
    }
    const mapA = new Map(a.files.map((f) => [f.path, f]));
    const mapB = new Map(b.files.map((f) => [f.path, f]));
    const added: string[] = [];
    const removed: string[] = [];
    const modified: string[] = [];
    let unchanged = 0;
    for (const [p, fa] of mapA) {
      const fb = mapB.get(p);
      if (!fb) {
        removed.push(p);
      } else if ((fa.hash ?? fa.content ?? null) === (fb.hash ?? fb.content ?? null)) {
        unchanged += 1;
      } else {
        modified.push(p);
      }
    }
    for (const p of mapB.keys()) {
      if (!mapA.has(p)) added.push(p);
    }
    // Rename detection: identical content hash across removed↔added.
    const renamed: Array<{ from: string; to: string }> = [];
    const hashToRemoved = new Map<string, string>();
    for (const p of removed) {
      const f = mapA.get(p);
      const h = f?.hash ?? (f?.content !== undefined ? `c:${f.content.length}:${f.content.slice(0, 64)}` : undefined);
      if (h) hashToRemoved.set(h, p);
    }
    const addedSet = new Set(added);
    const removedSet = new Set(removed);
    for (const p of [...added]) {
      const f = mapB.get(p);
      const h = f?.hash ?? (f?.content !== undefined ? `c:${f.content.length}:${f.content.slice(0, 64)}` : undefined);
      const from = h ? hashToRemoved.get(h) : undefined;
      if (h && from && addedSet.has(p) && removedSet.has(from)) {
        renamed.push({ from, to: p });
        addedSet.delete(p);
        removedSet.delete(from);
      }
    }
    const finalAdded = [...addedSet].sort();
    const finalRemoved = [...removedSet].sort();
    const finalModified = [...modified].sort();

    // Bounded per-file diffs via the M5 engine (binary flagged, never raw).
    const diffs: CheckpointFileDiff[] = [];
    let bytes = 0;
    let truncated = false;
    const diffPaths = [...finalModified, ...renamed.map((r) => r.to), ...finalAdded.slice(0, 5), ...finalRemoved.slice(0, 5)];
    for (const p of diffPaths.slice(0, MAX_COMPARE_FILES)) {
      const isRename = renamed.find((r) => r.to === p);
      const oldPath = isRename?.from;
      const fa = oldPath ? mapA.get(oldPath) : mapA.get(p);
      const fb = mapB.get(p);
      const oldContent = fa?.existed ? (fa.content ?? "") : null;
      const newContent = fb?.existed ? (fb.content ?? "") : null;
      const binary =
        (oldContent !== null && oldContent.includes("\0")) ||
        (newContent !== null && newContent.includes("\0"));
      if (binary) {
        diffs.push({
          path: p,
          ...(oldPath ? { oldPath } : {}),
          operation: isRename ? "renamed" : fa && !fa.existed ? "added" : fb && !fb.existed ? "removed" : "modified",
          additions: 0,
          deletions: 0,
          binary: true,
        });
        continue;
      }
      // Skip giant contents before diffing (bounded memory).
      if ((oldContent?.length ?? 0) + (newContent?.length ?? 0) > 200_000) {
        truncated = true;
        diffs.push({
          path: p,
          ...(oldPath ? { oldPath } : {}),
          operation: isRename ? "renamed" : fa && !fa.existed ? "added" : fb && !fb.existed ? "removed" : "modified",
          additions: 0,
          deletions: 0,
          binary: false,
        });
        continue;
      }
      const result = computeDiff({
        filePath: p,
        ...(oldPath ? { oldPath } : {}),
        oldContent,
        newContent,
      });
      const unified = result.unifiedDiff.slice(0, DIFF_EXCERPT_CHARS);
      bytes += unified.length;
      if (bytes > MAX_COMPARE_BYTES) {
        truncated = true;
        break;
      }
      diffs.push({
        path: p,
        ...(oldPath ? { oldPath } : {}),
        operation: result.operation === "created" ? "added" : result.operation === "deleted" ? "removed" : result.operation,
        additions: result.additions,
        deletions: result.deletions,
        binary: false,
        ...(unified ? { unifiedDiff: unified } : {}),
      });
    }
    if (diffPaths.length > MAX_COMPARE_FILES) truncated = true;
    return {
      ok: true,
      compare: {
        aId,
        bId,
        added: finalAdded,
        removed: finalRemoved,
        modified: finalModified,
        renamed,
        unchanged,
        diffs,
        truncated,
      },
    };
  }

  // ---- Run comparison (objective deltas only — no invented scores) ------------------------

  async compareRuns(
    aId: unknown,
    bId: unknown,
  ): Promise<{ ok: true; rows: CompareRow[] } | { ok: false; errors: string[] }> {
    if (!isValidTaskId(aId)) return { ok: false, errors: ["invalid task id (a)"] };
    if (!isValidTaskId(bId)) return { ok: false, errors: ["invalid task id (b)"] };
    const records = await this.deps.taskStore.list();
    const ra = records.find((r) => r.id === aId);
    const rb = records.find((r) => r.id === bId);
    if (!ra || this.isTeamRecord(ra)) return { ok: false, errors: [`unknown task: ${aId}`] };
    if (!rb || this.isTeamRecord(rb)) return { ok: false, errors: [`unknown task: ${bId}`] };
      const sa = this.toSummary(ra);
      const sb = this.toSummary(rb);
      const rows: CompareRow[] = [
        {
          metric: "status",
          a: sa.status,
          b: sb.status,
          verdict: statusVerdict(sa.status, sb.status),
          note: "completed outranks failed/cancelled/interrupted",
        },
        {
          metric: "duration",
          a: formatDuration(sa.durationMs),
          b: formatDuration(sb.durationMs),
          verdict:
            sa.durationMs !== undefined && sb.durationMs !== undefined
              ? sa.status === "completed" && sb.status === "completed"
                ? sa.durationMs === sb.durationMs
                  ? "SAME"
                  : sa.durationMs < sb.durationMs
                    ? "BETTER"
                    : "WORSE"
                : "DIFFERENT"
              : "UNKNOWN",
          note: "shorter is better only when both completed",
        },
        {
          metric: "provider",
          a: sa.provider ?? "unknown",
          b: sb.provider ?? "unknown",
          verdict: sa.provider === sb.provider ? "SAME" : "DIFFERENT",
        },
        {
          metric: "model",
          a: sa.model ?? "unknown",
          b: sb.model ?? "unknown",
          verdict: sa.model === sb.model ? "SAME" : "DIFFERENT",
        },
        {
          metric: "tool calls",
          a: String(sa.toolCallCount),
          b: String(sb.toolCallCount),
          verdict:
            sa.status === "completed" && sb.status === "completed"
              ? sa.toolCallCount === sb.toolCallCount
                ? "SAME"
                : sa.toolCallCount < sb.toolCallCount
                  ? "BETTER"
                  : "WORSE"
              : "DIFFERENT",
          note: "fewer calls = more efficient (completed runs only)",
        },
        {
          metric: "retries",
          a: String(sa.retryCount),
          b: String(sb.retryCount),
          verdict:
            sa.retryCount === sb.retryCount ? "SAME" : sa.retryCount < sb.retryCount ? "BETTER" : "WORSE",
        },
        {
          metric: "files changed",
          a: String(sa.filesChangedCount),
          b: String(sb.filesChangedCount),
          verdict: sa.filesChangedCount === sb.filesChangedCount ? "SAME" : "DIFFERENT",
          note: "count difference is neutral, not a quality signal",
        },
        {
          metric: "errors",
          a: sa.hasErrors ? "yes" : "no",
          b: sb.hasErrors ? "yes" : "no",
          verdict:
            sa.hasErrors === sb.hasErrors ? "SAME" : !sa.hasErrors ? "BETTER" : "WORSE",
        },
        {
          metric: "result quality",
          a: "unmeasured",
          b: "unmeasured",
          verdict: "UNKNOWN",
          note: "outcome quality cannot be measured objectively — inspect both results",
        },
      ];
      return { ok: true, rows };
  }

  // ---- Resume / restart / discard helpers -----------------------------------------------------

  async resumeContext(
    taskId: unknown,
  ): Promise<{ ok: true; context: ResumeContext; taskId: string } | { ok: false; errors: string[] }> {
    if (!isValidTaskId(taskId)) return { ok: false, errors: ["invalid task id"] };
    const record = await this.deps.taskStore.get(taskId);
    if (!record || this.isTeamRecord(record)) {
      return { ok: false, errors: [`unknown task: ${taskId}`] };
    }
    if (record.status === "completed" || record.status === "archived") {
      return { ok: false, errors: [`task is ${record.status} — nothing to resume`] };
    }
    const files = this.fileSummaryFor(record);
    const filesChanged = [
      ...files.created.map((f) => f.path),
      ...files.modified.map((f) => f.path),
      ...files.deleted.map((f) => f.path),
      ...(record.touchedFiles ?? []),
    ].slice(0, 40);
    return {
      ok: true,
      taskId,
      context: {
        title: record.title,
        messages: record.messages.map((m) => ({ role: m.role, content: m.content })),
        checkpointsAvailable: this.checkpointsFor(record).length,
        filesChanged: [...new Set(filesChanged)],
      },
    };
  }

  async restartPrompt(
    taskId: unknown,
  ): Promise<{ ok: true; prompt: string; mode?: string } | { ok: false; errors: string[] }> {
    if (!isValidTaskId(taskId)) return { ok: false, errors: ["invalid task id"] };
    const record = await this.deps.taskStore.get(taskId);
    if (!record || this.isTeamRecord(record)) {
      return { ok: false, errors: [`unknown task: ${taskId}`] };
    }
    const prompt = firstUserPrompt(record);
    if (!prompt.trim()) return { ok: false, errors: ["task has no prompt to restart from"] };
    const counters = readCounters(record);
    return {
      ok: true,
      prompt: prompt.slice(0, 4000),
      ...(counters.mode ? { mode: counters.mode } : {}),
    };
  }

  async discard(
    taskId: unknown,
    options?: { activeTaskId?: string | null },
  ): Promise<{ ok: true } | { ok: false; errors: string[] }> {
    if (!isValidTaskId(taskId)) return { ok: false, errors: ["invalid task id"] };
    if (options?.activeTaskId === taskId) {
      return { ok: false, errors: ["task is currently running — stop it first"] };
    }
    const record = await this.deps.taskStore.get(taskId);
    if (!record || this.isTeamRecord(record)) {
      return { ok: false, errors: [`unknown task: ${taskId}`] };
    }
    if (record.status === "running" && !options?.activeTaskId) {
      // A store-running task with no active in-flight task died with the
      // host; discarding it is safe (it will never resume on its own).
    }
    await this.deps.taskStore.delete(taskId);
    return { ok: true };
  }

  // ---- Private --------------------------------------------------------------------------

  private isTeamRecord(record: PersistedTask): boolean {
    const s = record.agentState;
    return !!s && typeof s === "object" && (s as Record<string, unknown>).kind === "team";
  }

  /** M5 + checkpoint correlation ids for one task (never secrets). */
  private candidateIds(record: PersistedTask): string[] {
    const counters = readCounters(record);
    const ids = [record.id];
    if (counters.sessionId) ids.push(counters.sessionId);
    return ids;
  }

  private liveFor(taskId: string): LiveTaskSnapshot | null {
    try {
      const live = this.deps.getLiveSnapshot?.() ?? null;
      if (!live || live.taskId !== taskId) return null;
      return live;
    } catch {
      return null;
    }
  }

  private checkpointsFor(record: PersistedTask): TaskCheckpointView[] {
    const ids = this.candidateIds(record);
    const out: TaskCheckpointView[] = [];
    try {
      for (const checkpoint of this.deps.listCheckpoints()) {
        if (!ids.includes(checkpoint.taskId)) continue;
        out.push({
          checkpointId: checkpoint.checkpointId,
          taskId: checkpoint.taskId,
          timestamp: checkpoint.timestamp,
          description: checkpoint.description.slice(0, 200),
          fileCount: checkpoint.files.length,
          status: checkpoint.status,
          files: checkpoint.files.map((f) => f.path).slice(0, 100),
        });
      }
    } catch {
      // checkpoint store unavailable — empty, never crash listing
    }
    return out.sort((a, b) => a.timestamp - b.timestamp);
  }

  private fileSummaryFor(record: PersistedTask): TaskFileSummary {
    const ids = this.candidateIds(record);
    const changes: TrackedChange[] = [];
    try {
      for (const id of ids) {
        for (const c of this.deps.listMutations(id)) changes.push(c);
      }
    } catch {
      // ledger unavailable — empty, never crash listing
    }
    const byPath = new Map<string, TrackedChange>();
    for (const c of changes) {
      if (c.status !== "applied") continue;
      byPath.set(c.path, c);
    }
    const summary: TaskFileSummary = {
      created: [],
      modified: [],
      deleted: [],
      renamed: [],
      totalAdditions: 0,
      totalDeletions: 0,
    };
    for (const c of [...byPath.values()].slice(0, MAX_FILES)) {
      const entry = {
        path: c.path,
        status: c.status,
        additions: c.diff?.additions ?? 0,
        deletions: c.diff?.deletions ?? 0,
        binary: c.diff?.binary ?? false,
        ...(c.diff?.unifiedDiff ? { diffExcerpt: c.diff.unifiedDiff.slice(0, DIFF_EXCERPT_CHARS) } : {}),
      };
      summary.totalAdditions += entry.additions;
      summary.totalDeletions += entry.deletions;
      if (c.kind === "create") summary.created.push({ ...entry, changeType: "created" as const });
      else if (c.kind === "delete") summary.deleted.push({ ...entry, changeType: "deleted" as const });
      else if (c.kind === "rename" || c.kind === "move") {
        summary.renamed.push({ ...entry, changeType: c.kind === "rename" ? ("renamed" as const) : ("moved" as const) });
      } else summary.modified.push({ ...entry, changeType: "modified" as const });
    }
    return summary;
  }

  private toSummary(record: PersistedTask): TaskSummary {
    const counters = readCounters(record);
    const checkpoints = this.checkpointsFor(record);
    const messages = record.messages;
    const prompt = firstUserPrompt(record);
    const result = lastAssistantResult(record);
    const errors = messageErrors(record);
    const durationMs =
      record.status === "completed" || record.status === "failed" || record.status === "cancelled" || record.status === "interrupted"
        ? Math.max(0, record.updatedAtMs - record.createdAtMs)
        : undefined;
    const toolCallCount =
      counters.toolCallCount ?? counters.toolCalls?.reduce((n, t) => n + t.count, 0) ?? 0;
    const filesChanged = counters.filesChanged ?? record.touchedFiles ?? [];
    // File count prefers the M5 ledger truth; falls back to counters/touched.
    let filesChangedCount = filesChanged.length;
    try {
      const ids = this.candidateIds(record);
      const seen = new Set<string>();
      for (const id of ids) {
        for (const c of this.deps.listMutations(id)) {
          if (c.status === "applied") seen.add(c.path);
        }
      }
      if (seen.size > 0) filesChangedCount = seen.size;
    } catch {
      // ledger unavailable — counter fallback stands
    }
    return {
      id: record.id,
      ...(counters.sessionId ? { sessionId: counters.sessionId } : {}),
      title: record.title.slice(0, 200),
      promptExcerpt: clean(prompt, 300),
      status: record.status,
      ...(counters.mode ? { mode: counters.mode } : {}),
      ...this.modelInfo(record),
      createdAtMs: record.createdAtMs,
      updatedAtMs: record.updatedAtMs,
      ...(durationMs !== undefined ? { durationMs } : {}),
      messageCount: messages.length,
      toolCallCount,
      retryCount: counters.retries ?? 0,
      filesChangedCount,
      checkpointCount: checkpoints.length,
      hasErrors: errors.length > 0 || !!counters.lastError,
      ...(result ? { resultExcerpt: clean(result, 500) } : {}),
    };
  }

  private modelInfo(record: PersistedTask): { provider?: string; model?: string } {
    const mc = record.modelConfig;
    if (!mc || typeof mc !== "object") return {};
    const provider = (mc as Record<string, unknown>).providerId;
    const model = (mc as Record<string, unknown>).modelId;
    return {
      ...(typeof provider === "string" ? { provider: provider.slice(0, 64) } : {}),
      ...(typeof model === "string" ? { model: model.slice(0, 64) } : {}),
    };
  }

  /**
   * Timeline phases, derived ONLY from real data:
   * - "created" from createdAtMs; "prompt"/"response" from message roles;
   * - "system" for system notes ("error" when the content starts with Error:,
   *   "resume" for resume markers); "tool" for tool-role messages;
   * - "checkpoint" from checkpoint timestamps; a terminal "status" marker
   *   from the stored status. No synthetic phases are ever invented.
   */
  private buildTimeline(
    record: PersistedTask,
    checkpoints: Array<{ id: string; timestamp: number }>,
  ): TimelineEvent[] {
    const events: TimelineEvent[] = [
      { timestampMs: record.createdAtMs, phase: "created", kind: "created", summary: "Task created" },
    ];
    for (const m of record.messages) {
      if (m.role === "user") {
        events.push({
          timestampMs: m.timestampMs,
          phase: "prompt",
          kind: "prompt",
          summary: clean(m.content, 200),
        });
      } else if (m.role === "assistant") {
        events.push({
          timestampMs: m.timestampMs,
          phase: "response",
          kind: "response",
          summary: clean(m.content, 200),
        });
      } else if (m.role === "tool") {
        events.push({
          timestampMs: m.timestampMs,
          phase: "tool",
          kind: "tool",
          summary: clean(m.content, 200),
        });
      } else {
        const phase = m.content.startsWith("Error:")
          ? "error"
          : m.content.includes("resumed") || m.content.includes("Resumed")
            ? "resume"
            : "system";
        events.push({
          timestampMs: m.timestampMs,
          phase,
          kind: "system",
          summary: clean(m.content, 200),
        });
      }
    }
    for (const cp of checkpoints) {
      events.push({
        timestampMs: cp.timestamp,
        phase: "checkpoint",
        kind: "checkpoint",
        summary: `Checkpoint ${cp.id}`,
      });
    }
    if (record.status !== "running") {
      events.push({
        timestampMs: record.updatedAtMs,
        phase: record.status,
        kind: "status",
        summary: `Task ${record.status}`,
      });
    }
    return events
      .sort((a, b) => a.timestampMs - b.timestampMs)
      .slice(0, MAX_TIMELINE);
  }

  private interruptionInfo(
    record: PersistedTask,
    checkpointCount: number,
    files: TaskFileSummary,
  ): TaskDetails["interruption"] {
    const lastAssistant = lastAssistantResult(record);
    const errors = messageErrors(record);
    const counters = readCounters(record);
    const changed = [
      ...files.created.map((f) => f.path),
      ...files.modified.map((f) => f.path),
      ...files.deleted.map((f) => f.path),
      ...(record.touchedFiles ?? []),
      ...(counters.filesChanged ?? []),
    ];
    const lastPhase =
      record.messages.length > 0
        ? record.messages[record.messages.length - 1]!.role === "assistant"
          ? "response"
          : record.messages[record.messages.length - 1]!.role
        : "created";
    return {
      interruptedAtMs: record.updatedAtMs,
      lastPhase,
      ...(lastAssistant ? { lastAssistantExcerpt: clean(lastAssistant, 300) } : {}),
      pendingSummary: lastAssistant
        ? "Assistant produced output before interruption; remaining work is whatever the prompt requested beyond that output."
        : "No assistant output recorded; the original prompt is still pending.",
      filesChanged: [...new Set(changed)].slice(0, 40),
      checkpointsAvailable: checkpointCount,
      ...(errors[0] ?? counters.lastError ? { error: errors[0] ?? counters.lastError } : {}),
    };
  }
}

function filesCount(files: TaskFileSummary): number {
  return files.created.length + files.modified.length + files.deleted.length + files.renamed.length;
}

function statusVerdict(a: string, b: string): CompareVerdict {
  if (a === b) return "SAME";
  const rank = (s: string): number =>
    s === "completed" ? 3 : s === "failed" ? 1 : s === "cancelled" || s === "interrupted" ? 0 : 2;
  const ra = rank(a);
  const rb = rank(b);
  if (ra === rb) return "DIFFERENT";
  return ra > rb ? "BETTER" : "WORSE";
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "n/a";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
