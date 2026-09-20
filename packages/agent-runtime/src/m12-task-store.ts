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
import { containsSecretText, MAX_IMAGE_BYTES } from "@codepilot/shared";
import { buildInitialMessages } from "./resume.js";
import type { CompactionArtifact } from "./compaction-types.js";

/** Max staged images kept per task (across turns). */
export const MAX_STAGED_IMAGES_PER_TASK = 8;
/** Max bytes per staged image (mirrors the shared validation cap). */
export const MAX_STAGED_IMAGE_BYTES = MAX_IMAGE_BYTES;

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
  /** Structured content blocks (tool_use / tool_result / text / image). */
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
    | {
        type: "image";
        mime: string;
        /**
         * Task-scoped relative filename (`images/<id>.bin`) — resolved
         * against the task directory at resume. Inline bytes are NEVER
         * persisted (keeps the task record bounded; no base64 in JSON).
         */
        fileRef: string;
        /**
         * Inline bytes for the LIVE request only (in-memory; the persist
         * path strips this field — see boundConversationEntry).
         */
        dataBase64?: string;
        /** Sanitized display name (never a path). */
        name?: string;
        sizeBytes?: number;
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
  /**
   * Monotonic mutation clock (see nextWriteMs): Date.now() alone can repeat
   * within one millisecond, which made newest-first listing depend on
   * directory read order when tasks are created/updated back-to-back.
   */
  private lastWriteMs = 0;

  constructor(storageDir: string, options?: TaskStoreOptions) {
    this.tasksDir = storageDir;
    this.options = {
      maxMessages: options?.maxMessages ?? 500,
      maxTaskBytes: options?.maxTaskBytes ?? 2 * 1024 * 1024,
      maxConversationEntries:
        options?.maxConversationEntries ?? DEFAULT_MAX_CONVERSATION_ENTRIES,
      maxToolInputChars:
        options?.maxToolInputChars ?? DEFAULT_MAX_TOOL_INPUT_CHARS,
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
    task.updatedAtMs = this.nextWriteMs();
    await this.write(task);
    return task;
  }

  /** Create a new persisted task. */
  async create(
    title: string,
    modelConfig?: Record<string, unknown>,
    opts?: { workspaceRoot?: string },
  ): Promise<PersistedTask> {
    const now = this.nextWriteMs();
    const task: PersistedTask = {
      id: `task-${now}-${Math.random().toString(36).slice(2, 8)}`,
      createdAtMs: now,
      updatedAtMs: now,
      status: "running",
      title,
      messages: [],
      modelConfig: modelConfig ? redactForPersistence(modelConfig) : undefined,
      ...(opts?.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {}),
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
    // Newest first. Within one process the mutation clock is strictly
    // monotonic (nextWriteMs), so updatedAtMs is already a total order;
    // createdAtMs then id break ties for records written by older processes
    // (pre-fix files, concurrent stores) — never directory read order.
    return tasks.sort(
      (a, b) =>
        b.updatedAtMs - a.updatedAtMs ||
        b.createdAtMs - a.createdAtMs ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
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
    opts?: {
      /**
       * Structured blocks for the v2 conversation entry (e.g. image
       * fileRefs for an image turn). The legacy text log always records
       * `content`; when provided, blocks replace the auto-derived text
       * entry. Image blocks persist fileRefs only (never inline bytes).
       */
      blocks?: PersistedConversationMessage["blocks"];
    },
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
        this.boundConversationEntry({
          role: "user",
          text: content,
          timestampMs,
          ...(opts?.blocks ? { blocks: opts.blocks } : {}),
        }),
      );
      if (task.conversation.length > this.options.maxConversationEntries) {
        task.conversation = task.conversation.slice(
          -this.options.maxConversationEntries,
        );
      }
    }
    task.updatedAtMs = this.nextWriteMs();
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
    task.updatedAtMs = this.nextWriteMs();
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
    task.updatedAtMs = this.nextWriteMs();
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
    if (patch.lastStep !== undefined)
      task.lastStep = patch.lastStep.slice(0, 120);
    task.updatedAtMs = this.nextWriteMs();
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
      fs.rmSync(this.taskImagesDir(id), { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Staged image attachments for a task.
   *
   * Validated, metadata-stripped bytes are written to
   * `<tasksDir>/<taskId>/images/<random>.bin`; the conversation persists
   * only the relative `fileRef` (`images/<random>.bin`). Absolute paths
   * never enter the record, so local filesystem layout cannot leak to the
   * model. Returns the `fileRef`, or an `{ error }` when bounds reject it.
   */
  async stageImage(
    id: string,
    image: { mime: string; name: string; sizeBytes: number; bytes: Uint8Array },
  ): Promise<{ fileRef: string } | { error: string }> {
    if (image.bytes.length > MAX_STAGED_IMAGE_BYTES) {
      return { error: "image exceeds per-image size limit" };
    }
    const dir = this.taskImagesDir(id);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const existing = fs.readdirSync(dir).filter((f) => f.endsWith(".bin"));
      if (existing.length >= MAX_STAGED_IMAGES_PER_TASK) {
        return { error: "task image limit reached" };
      }
      const leaf = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.bin`;
      const absolute = path.join(dir, leaf);
      const tmp = `${absolute}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, image.bytes);
      fs.renameSync(tmp, absolute);
      return { fileRef: `images/${leaf}` };
    } catch (err) {
      return {
        error: `cannot stage image: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Read staged image bytes for resume. `fileRef` must be a bare
   * `images/<name>.bin` leaf — anything else (absolute paths, `..`,
   * separators) is rejected, and the resolved path must stay inside the
   * task's images directory. Returns null on any failure.
   */
  readStagedImage(id: string, fileRef: string): Uint8Array | null {
    if (!/^images\/[A-Za-z0-9][A-Za-z0-9._-]{0,64}\.bin$/.test(fileRef)) {
      return null;
    }
    try {
      const dir = this.taskImagesDir(id);
      const absolute = path.resolve(dir, path.basename(fileRef));
      const root = path.resolve(dir) + path.sep;
      if (!absolute.startsWith(root)) return null;
      const data = fs.readFileSync(absolute);
      if (data.length === 0 || data.length > MAX_STAGED_IMAGE_BYTES) {
        return null;
      }
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } catch {
      return null;
    }
  }

  private taskImagesDir(id: string): string {
    const safe = path.basename(id);
    return path.join(this.tasksDir, safe, "images");
  }

  // --------------------------------------------------------------------------

  /**
   * Strictly monotonic mutation timestamp: max(Date.now(), last+1).
   * Guarantees back-to-back create/update calls never share an updatedAtMs,
   * so newest-first listing is deterministic within a process.
   */
  private nextWriteMs(): number {
    const now = Date.now();
    this.lastWriteMs = now > this.lastWriteMs ? now : this.lastWriteMs + 1;
    return this.lastWriteMs;
  }

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
    if (entry.modelId !== undefined)
      bounded.modelId = entry.modelId.slice(0, 120);
    if (entry.providerId !== undefined)
      bounded.providerId = entry.providerId.slice(0, 120);
    if (entry.blocks !== undefined) {
      bounded.blocks = entry.blocks.map((b) => {
        if (b.type === "text") {
          return {
            type: "text",
            text: b.text.slice(0, this.options.maxToolOutputChars),
          };
        }
        if (b.type === "tool_use") {
          return {
            type: "tool_use",
            id: b.id,
            name: b.name.slice(0, 120),
            ...(b.input !== undefined
              ? {
                  input: boundedSerialize(
                    b.input,
                    this.options.maxToolInputChars,
                  ),
                }
              : {}),
          };
        }
        if (b.type === "image") {
          // Persist the file reference ONLY — inline bytes must never reach
          // disk (task record stays bounded; no base64 in JSON). A block
          // without a resolvable reference degrades to an honest marker.
          if (typeof b.fileRef !== "string" || b.fileRef.length === 0) {
            return {
              type: "text",
              text: `[image omitted: ${b.name ?? "unnamed image"} has no persisted reference]`.slice(
                0,
                this.options.maxToolOutputChars,
              ),
            };
          }
          return {
            type: "image",
            mime: b.mime.slice(0, 64),
            fileRef: String(b.fileRef).slice(0, 160),
            ...(b.name ? { name: b.name.slice(0, 128) } : {}),
            ...(b.sizeBytes !== undefined ? { sizeBytes: b.sizeBytes } : {}),
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
