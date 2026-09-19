/**
 * M12 — Task persistence & resume.
 *
 * Durable task/session store with crash-safe writes and safe recovery:
 *
 * - Each task is a single JSON file (index.json for the registry) written
 *   atomically (tmp + rename) so a crash never leaves a half-written task.
 * - Corrupt or truncated files are quarantined (renamed *.corrupt), never
 *   crash the loader, and never block listing the remaining tasks.
 * - Secret redaction: env-shaped keys and token-looking strings are replaced
 *   before anything hits disk. Secrets must never be persisted in plaintext.
 * - Resume: the store returns the persisted snapshot; the caller decides how
 *   to continue. Interrupted tasks are detected via `status: "interrupted"`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { containsSecretText } from "@codepilot/shared";
import { buildInitialMessages } from "./resume.js";
import type { CompactionArtifact } from "./compaction-types.js";

// ============================================================================
// Types
// ============================================================================

export type PersistedTaskStatus =
  "running" | "interrupted" | "completed" | "failed" | "cancelled" | "archived";

/**
 * A persisted tool call in the faithful conversation record (v2).
 *
 * Captured from REAL runtime events (`tool_requested`/`tool_started` +
 * `tool_completed`/`tool_failed`). Tool results are BOUNDED (max chars per
 * result) — this is resume context, not a full transcript. Secrets never
 * reach here: inputs/outputs pass through the store's redaction on write.
 */
export interface PersistedToolCall {
  /** Native tool-call id — links tool_use ↔ tool_result blocks. */
  id: string;
  toolName: string;
  /** Bounded JSON-serialized input as requested (redacted on persist). */
  input?: string;
  /** Bounded output as returned (redacted on persist); error message on failure. */
  output?: string;
  is_error?: boolean;
  /** "requested" = recorded at approval time; "executed" = result captured. */
  phase: "requested" | "executed";
  timestampMs: number;
}

/**
 * A faithful conversation entry (v2) that round-trips into the native
 * engine's resume wire format (`initialMessages`). Only "user" and "assistant"
 * roles exist at the provider protocol level — tool calls ride inside the
 * assistant message as `tool_use` blocks and their results as a following
 * user message of `tool_result` blocks (persisted as a user message of `tool_result` blocks, matching resume.ts
 * its own session history).
 */
export interface PersistedConversationMessage {
  role: "user" | "assistant";
  /** Plain text content. Mutually exclusive with structured `blocks`. */
  text?: string;
  /** Structured content blocks (tool_use / tool_result / text). */
  blocks?: Array<
    | { type: "text"; text: string }
    | {
        type: "tool_use";
        id: string;
        name: string;
        /** Bounded JSON input (redacted on persist). */
        input?: string;
      }
    | {
        type: "tool_result";
        tool_use_id: string;
        name: string;
        /** Bounded result content (redacted on persist). */
        content: string;
        is_error?: boolean;
      }
  >;
  /**
   * Stable per-run key — lets the host upsert the SAME in-progress assistant
   * turn incrementally (crash-safe) instead of appending duplicates.
   */
  key?: string;
  /** Model that produced an assistant message (safe metadata only). */
  modelId?: string;
  providerId?: string;
  timestampMs: number;
}

/** A persisted task snapshot. Kept small: state needed to resume, nothing more. */
export interface PersistedTask {
  id: string;
  /** Monotonic per-task sequence for conversation ordering. */
  createdAtMs: number;
  updatedAtMs: number;
  status: PersistedTaskStatus;
  /** User-visible task title/prompt. */
  title: string;
  /** Conversation history (user/assistant/tool turns) — legacy text log. */
  messages: Array<{
    role: "user" | "assistant" | "tool" | "system";
    content: string;
    timestampMs: number;
  }>;
  /**
   * v2 faithful conversation: ordered user/assistant entries with tool_use/
   * tool_result blocks, round-trippable into the native `initialMessages`.
   * Absent on v1 records (resume falls back to the continuation prompt).
   */
  conversation?: PersistedConversationMessage[];
  /** Workspace identity captured at task creation (resume validation). */
  workspaceRoot?: string;
  /**
   * How many times this task has been resumed. Monotonic — guards against
   * replaying a stale conversation snapshot after a partial interruption.
   */
  resumeGeneration?: number;
  /**
   * Compaction artifacts (append-only). The canonical conversation above is
   * NEVER rewritten by compaction — artifacts record which range was
   * summarized so resume composes summary + messages-after-range while the
   * full original history stays available for audit.
   */
  compactions?: CompactionArtifact[];
  /** Last recoverable step marker written by the host (best-effort). */
  lastStep?: string;
  /** Agent state snapshot (state machine state, attempt counters). */
  agentState?: Record<string, unknown>;
  /** Model/provider configuration used for this task. */
  modelConfig?: Record<string, unknown>;
  /** Checkpoint ids produced during the task (M5 integration point). */
  checkpointIds?: string[];
  /** Files the task was mutating — used for conflict detection on resume. */
  touchedFiles?: string[];
}

export interface TaskStoreOptions {
  /** Max messages persisted per task; older ones are dropped. Default 500. */
  maxMessages?: number;
  /** Max total persisted size per task in bytes. Default 2 MiB. */
  maxTaskBytes?: number;
  /** Max entries kept in the v2 faithful conversation. Default 200. */
  maxConversationEntries?: number;
  /** Max chars per persisted tool input. Default 4_000. */
  maxToolInputChars?: number;
  /** Max chars per persisted tool output/result. Default 8_000. */
  maxToolOutputChars?: number;
}

const DEFAULT_MAX_CONVERSATION_ENTRIES = 200;
const DEFAULT_MAX_TOOL_INPUT_CHARS = 4_000;
const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 8_000;

// ============================================================================
// Secret redaction
// ============================================================================

const SECRET_KEY_PATTERN =
  /(pass(word)?|secret|token|api[_-]?key|private[_-]?key|credential|auth)/i;

/** Recursively redact secret-shaped values before persistence. */
export function redactForPersistence<T>(value: T): T {
  return redactValue(value, new Set()) as T;
}

/**
 * Bounded serialization for tool inputs/outputs stored in the conversation:
 * JSON where possible, plain string otherwise, hard-capped at `maxChars`.
 * Keeps resume payloads small regardless of tool result size.
 */
export function boundedSerialize(value: unknown, maxChars: number): string {
  let s: string;
  if (typeof value === "string") s = value;
  else {
    try {
      s = JSON.stringify(value) ?? String(value);
    } catch {
      s = String(value);
    }
  }
  return s.length <= maxChars ? s : `${s.slice(0, maxChars)}…[truncated]`;
}

function redactValue(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && looksLikeEmbeddedSecret(value)) {
      return "[REDACTED]";
    }
    return value;
  }
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key) && typeof v === "string" && v.length > 0) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = redactValue(v, seen);
    }
  }
  return out;
}

/**
 * High-confidence embedded secret detection — delegates to the canonical
 * @codepilot/shared scrubber, so every credential shape the audit trail
 * redacts (bearer tokens, key=value pairs, URL credentials, provider keys,
 * PEM) is also caught before task persistence. No local secret patterns.
 */
function looksLikeEmbeddedSecret(text: string): boolean {
  if (text.length < 12) return false;
  return containsSecretText(text);
}

// ============================================================================
// TaskStore
// ============================================================================

export class TaskStore {
  private readonly tasksDir: string;
  private readonly options: Required<TaskStoreOptions>;

  constructor(storageDir: string, options?: TaskStoreOptions) {
    this.tasksDir = storageDir;
    this.options = {
      maxMessages: options?.maxMessages ?? 500,
      maxTaskBytes: options?.maxTaskBytes ?? 2 * 1024 * 1024,
      maxConversationEntries:
        options?.maxConversationEntries ?? DEFAULT_MAX_CONVERSATION_ENTRIES,
      maxToolInputChars: options?.maxToolInputChars ?? DEFAULT_MAX_TOOL_INPUT_CHARS,
      maxToolOutputChars:
        options?.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS,
    };
    fs.mkdirSync(this.tasksDir, { recursive: true });
  }

  /**
   * Upsert a conversation entry by stable key: replaces the existing entry
   * with the same `key` (the host's in-progress assistant turn) or appends
   * when absent. The raw entry is redacted (secret-shaped keys/values) and
   * every string field is bounded before it reaches disk — one oversized tool
   * result can never blow the task file past `maxTaskBytes` on its own.
   */
  async upsertConversationEntry(
    id: string,
    key: string,
    entry: Omit<PersistedConversationMessage, "key">,
  ): Promise<PersistedTask | null> {
    const task = await this.read(id);
    if (!task) return null;
    if (!task.conversation) task.conversation = [];
    const bounded = this.boundConversationEntry(entry);
    const stored: PersistedConversationMessage = { ...bounded, key };
    const idx = task.conversation.findIndex((e) => e.key === key);
    if (idx >= 0) task.conversation[idx] = stored;
    else task.conversation.push(stored);
    if (task.conversation.length > this.options.maxConversationEntries) {
      task.conversation = task.conversation.slice(
        -this.options.maxConversationEntries,
      );
    }
    task.updatedAtMs = Date.now();
    await this.write(task);
    return task;
  }

  /** Create a new persisted task. */
  async create(
    title: string,
    modelConfig?: Record<string, unknown>,
    opts?: { workspaceRoot?: string },
  ): Promise<PersistedTask> {
    const now = Date.now();
    const task: PersistedTask = {
      id: `task-${now}-${Math.random().toString(36).slice(2, 8)}`,
      createdAtMs: now,
      updatedAtMs: now,
      status: "running",
      title,
      messages: [],
      modelConfig: modelConfig ? redactForPersistence(modelConfig) : undefined,
      ...(opts?.workspaceRoot
        ? { workspaceRoot: opts.workspaceRoot }
        : {}),
      resumeGeneration: 0,
    };
    await this.write(task);
    return task;
  }

  /** Load one task. Returns null when missing or unreadable. */
  async get(id: string): Promise<PersistedTask | null> {
    return this.read(id);
  }

  /** List all tasks, newest first. Corrupt files are skipped (quarantined). */
  async list(): Promise<PersistedTask[]> {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.tasksDir);
    } catch {
      return [];
    }
    const tasks: PersistedTask[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const task = await this.read(entry.slice(0, -5));
      if (task) tasks.push(task);
    }
    return tasks.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  /**
   * Append a message and update the task atomically.
   *
   * v2 note: USER turns are mirrored into the faithful conversation (they are
   * the seed of every run and required for verbatim resume). Assistant/system
   * entries stay in the legacy text log only — assistant turns are captured
   * structurally via upsertConversationEntry keyed per run.
   */
  async appendMessage(
    id: string,
    role: "user" | "assistant" | "tool" | "system",
    content: string,
  ): Promise<PersistedTask | null> {
    const task = await this.read(id);
    if (!task) return null;
    const timestampMs = Date.now();
    task.messages.push({ role, content, timestampMs });
    if (task.messages.length > this.options.maxMessages) {
      task.messages = task.messages.slice(-this.options.maxMessages);
    }
    if (role === "user") {
      if (!task.conversation) task.conversation = [];
      task.conversation.push(
        this.boundConversationEntry({ role: "user", text: content, timestampMs }),
      );
      if (task.conversation.length > this.options.maxConversationEntries) {
        task.conversation = task.conversation.slice(
          -this.options.maxConversationEntries,
        );
      }
    }
    task.updatedAtMs = Date.now();
    await this.write(task);
    return task;
  }

  /**
   * Atomically bump the resume generation and restore `running` status when
   * a task is resumed. Returns the fresh record or null when missing/completed.
   */
  async beginResume(id: string): Promise<PersistedTask | null> {
    const task = await this.read(id);
    if (!task) return null;
    if (task.status === "completed" || task.status === "archived") return null;
    task.resumeGeneration = (task.resumeGeneration ?? 0) + 1;
    task.status = "running";
    task.updatedAtMs = Date.now();
    await this.write(task);
    return task;
  }

  /**
   * Append a compaction artifact (bounded to the most recent 20). Canonical
   * conversation is untouched — artifacts are additive metadata. Idempotent
   * by artifact id: re-persisting the same boundary is a no-op.
   */
  async addCompactionArtifact(
    id: string,
    artifact: CompactionArtifact,
  ): Promise<PersistedTask | null> {
    const task = await this.read(id);
    if (!task) return null;
    if (!task.compactions) task.compactions = [];
    if (task.compactions.some((a) => a.id === artifact.id)) return task;
    task.compactions.push(artifact);
    if (task.compactions.length > 20) {
      task.compactions = task.compactions.slice(-20);
    }
    task.updatedAtMs = Date.now();
    await this.write(task);
    return task;
  }

  /** Update task status/state metadata. */
  async update(
    id: string,
    patch: Partial<
      Pick<
        PersistedTask,
        | "status"
        | "agentState"
        | "modelConfig"
        | "checkpointIds"
        | "touchedFiles"
        | "lastStep"
      >
    >,
  ): Promise<PersistedTask | null> {
    const task = await this.read(id);
    if (!task) return null;
    if (patch.status !== undefined) task.status = patch.status;
    if (patch.agentState !== undefined) {
      task.agentState = redactForPersistence(patch.agentState);
    }
    if (patch.modelConfig !== undefined) {
      task.modelConfig = redactForPersistence(patch.modelConfig);
    }
    if (patch.checkpointIds !== undefined)
      task.checkpointIds = patch.checkpointIds;
    if (patch.touchedFiles !== undefined)
      task.touchedFiles = patch.touchedFiles;
    if (patch.lastStep !== undefined) task.lastStep = patch.lastStep.slice(0, 120);
    task.updatedAtMs = Date.now();
    await this.write(task);
    return task;
  }

  /**
   * Convert the persisted v2 conversation into provider-protocol messages
   * (native resume wire shape). Delegates to the shared
   * pure builder in resume.ts (single implementation, no drift). No messages
   * are invented: a v1 task (no conversation) yields an empty array and
   * callers fall back to the continuation prompt.
   */
  toConversationMessages(
    task: PersistedTask,
  ): ReturnType<typeof buildInitialMessages> {
    return buildInitialMessages(task);
  }

  /**
   * Mark all `running` tasks as interrupted. Called on startup so a crash
   * never leaves phantom running tasks.
   */
  async markInterruptedOnStartup(): Promise<number> {
    const tasks = await this.list();
    let count = 0;
    for (const task of tasks) {
      if (task.status === "running") {
        await this.update(task.id, { status: "interrupted" });
        count += 1;
      }
    }
    return count;
  }

  /** Archive a task (kept for history, excluded from active ops). */
  async archive(id: string): Promise<PersistedTask | null> {
    return this.update(id, { status: "archived" });
  }

  /** Delete a task permanently. */
  async delete(id: string): Promise<boolean> {
    const file = this.taskFile(id);
    try {
      fs.rmSync(file, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------------------

  private taskFile(id: string): string {
    // Defensive: ids are generated here, but never allow traversal.
    const safe = path.basename(id);
    return path.join(this.tasksDir, `${safe}.json`);
  }

  private async write(task: PersistedTask): Promise<void> {
    const file = this.taskFile(task.id);
    const payload = JSON.stringify(redactForPersistence(task), null, 2);
    if (Buffer.byteLength(payload, "utf8") > this.options.maxTaskBytes) {
      // Too big: drop oldest messages until it fits (keep at least 10).
      const shrunk = { ...task };
      while (
        shrunk.messages.length > 10 &&
        Buffer.byteLength(
          JSON.stringify(redactForPersistence(shrunk), null, 2),
          "utf8",
        ) > this.options.maxTaskBytes
      ) {
        shrunk.messages = shrunk.messages.slice(1);
      }
      task.messages = shrunk.messages;
    }
    const final = JSON.stringify(redactForPersistence(task), null, 2);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, final, "utf8");
    fs.renameSync(tmp, file);
  }

  /** Redact + bound one conversation entry before it reaches disk. */
  private boundConversationEntry(
    entry: Omit<PersistedConversationMessage, "key">,
  ): PersistedConversationMessage {
    const bounded: PersistedConversationMessage = {
      role: entry.role,
      timestampMs: entry.timestampMs,
    };
    if (entry.text !== undefined) {
      bounded.text = entry.text.slice(0, this.options.maxToolOutputChars);
    }
    if (entry.modelId !== undefined) bounded.modelId = entry.modelId.slice(0, 120);
    if (entry.providerId !== undefined)
      bounded.providerId = entry.providerId.slice(0, 120);
    if (entry.blocks !== undefined) {
      bounded.blocks = entry.blocks.map((b) => {
        if (b.type === "text") {
          return { type: "text", text: b.text.slice(0, this.options.maxToolOutputChars) };
        }
        if (b.type === "tool_use") {
          return {
            type: "tool_use",
            id: b.id,
            name: b.name.slice(0, 120),
            ...(b.input !== undefined
              ? { input: boundedSerialize(b.input, this.options.maxToolInputChars) }
              : {}),
          };
        }
        return {
          type: "tool_result",
          tool_use_id: b.tool_use_id,
          name: b.name.slice(0, 120),
          content: boundedSerialize(b.content, this.options.maxToolOutputChars),
          ...(b.is_error ? { is_error: true } : {}),
        };
      });
    }
    return redactForPersistence(bounded) as PersistedConversationMessage;
  }

  private async read(id: string): Promise<PersistedTask | null> {
    const file = this.taskFile(id);
    try {
      const raw = fs.readFileSync(file, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isValidTask(parsed)) {
        this.quarantine(file);
        return null;
      }
      return parsed;
    } catch {
      // Missing file is normal; unreadable/corrupt gets quarantined if present.
      if (fs.existsSync(file)) this.quarantine(file);
      return null;
    }
  }

  private quarantine(file: string): void {
    try {
      fs.renameSync(file, `${file}.corrupt`);
    } catch {
      // best effort
    }
  }
}

function isValidTask(value: unknown): value is PersistedTask {
  if (!value || typeof value !== "object") return false;
  const t = value as Partial<PersistedTask>;
  return (
    typeof t.id === "string" &&
    t.id.length > 0 &&
    typeof t.createdAtMs === "number" &&
    typeof t.updatedAtMs === "number" &&
    typeof t.status === "string" &&
    typeof t.title === "string" &&
    Array.isArray(t.messages)
  );
}

/**
 * Normalize a legacy (v1) record: fill new optional fields so downstream
 * code never sees undefined-vs-present divergence. Never mutates history.
 */
export function normalizePersistedTask(task: PersistedTask): PersistedTask {
  return {
    ...task,
    ...(task.conversation === undefined ? { conversation: undefined } : {}),
    ...(task.resumeGeneration === undefined ? { resumeGeneration: 0 } : {}),
  };
}
