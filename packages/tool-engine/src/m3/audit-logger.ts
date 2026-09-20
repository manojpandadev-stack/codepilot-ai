/**
 * @codepilot/tool-engine — M3 ToolAuditLogger
 *
 * Records one entry per tool execution: who, what, permission decision,
 * duration, outcome. Never logs secrets — messages are redacted with the same
 * patterns used across CodePilot (API keys, bearer tokens, passwords, PEM).
 * Bounded in-memory ring; callers can opt into console mirroring.
 */

import type { ToolError } from "./types.js";
import type { ToolExecutionStatus } from "./lifecycle.js";
import { scrubSecretsText } from "@codepilot/shared";

export interface ToolAuditEntry {
  executionId: string;
  toolId: string;
  sessionId?: string;
  taskId?: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  status: ToolExecutionStatus;
  permissionDecision?: string;
  errorCategory?: ToolError["category"];
  retries: number;
  /**
   * Coarse action category from the M4 action map ("write_file",
   * "execute_command", …). Optional so older persisted records stay valid.
   */
  action?: string;
  /** Risk level assigned by the risk engine. Safe, bounded label. */
  risk?: string;
  /**
   * Sanitized target descriptor — a basename, host, or command name only.
   * NEVER a full path, full command line, or raw tool input. Redacted on
   * write by both sinks.
   */
  safeTarget?: string;
  /** True when the M4 pipeline approved the execution. */
  approved?: boolean;
}

/**
 * The audit-sink contract every consumer depends on. Both the in-memory
 * `ToolAuditLogger` and the durable `PersistentAuditLogger` satisfy it, so the
 * host can swap the sink (memory-only → persistent JSONL) without any call
 * site — including `LiveToolPermissionBridge` — knowing which one it holds.
 */
export interface ToolAuditSink {
  /** Record one decision/execution. Must never throw. */
  record(entry: ToolAuditEntry): void;
  /** Most recent entries (newest last), bounded by `limit`. */
  list(limit?: number): ToolAuditEntry[];
}

export interface ToolAuditLoggerOptions {
  /** Maximum in-memory entries (default 10_000, trims to 5_000). */
  maxEntries?: number;
  /** Mirror entries to console at this level (default: off). */
  consoleLevel?: "off" | "info" | "debug";
  /** Redact secret-like strings in recorded messages. */
  redact?: boolean;
}

/**
 * NOTE: the rule set itself lives in @codepilot/shared (./secrets.js) — THE
 * canonical scrubber shared by logs, audit, and task persistence. This module
 * keeps only the stable `redactSecrets` name its callers depend on.
 */

/**
 * THE single shared secret scrubber. Every audit path (in-memory ring and the
 * persistent JSONL sink) funnels through here — which itself delegates to the
 * canonical @codepilot/shared implementation, so no second redaction
 * implementation can drift.
 */
export function redactSecrets(message: string): string {
  return scrubSecretsText(message);
}

export class ToolAuditLogger implements ToolAuditSink {
  private entries: ToolAuditEntry[] = [];
  private readonly maxEntries: number;
  private readonly consoleLevel: "off" | "info" | "debug";
  private readonly redact: boolean;

  constructor(options: ToolAuditLoggerOptions = {}) {
    this.maxEntries = options.maxEntries ?? 10_000;
    this.consoleLevel = options.consoleLevel ?? "off";
    this.redact = options.redact ?? true;
  }

  record(entry: ToolAuditEntry): void {
    const safe: ToolAuditEntry = this.redact
      ? {
          ...entry,
          permissionDecision: entry.permissionDecision
            ? redactSecrets(entry.permissionDecision)
            : undefined,
          // safeTarget is derived from tool input, so it is scrubbed too —
          // a URL query credential or a `--token=…` command flag must never
          // reach either sink.
          safeTarget: entry.safeTarget
            ? redactSecrets(entry.safeTarget)
            : undefined,
        }
      : entry;
    this.entries.push(safe);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-Math.floor(this.maxEntries / 2));
    }
    if (this.consoleLevel !== "off") {
      const line = `[tool-audit] ${safe.toolId} ${safe.status} ${safe.durationMs ?? 0}ms exec=${safe.executionId}`;
      if (this.consoleLevel === "debug") {
        console.debug(line);
      } else {
        console.info(line);
      }
    }
  }

  /** Most recent entries, newest last. */
  list(limit = 100): ToolAuditEntry[] {
    return this.entries.slice(-limit);
  }

  /** Entries for one execution id. */
  forExecution(executionId: string): ToolAuditEntry[] {
    return this.entries.filter((e) => e.executionId === executionId);
  }

  size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }
}

// ============================================================================
// PersistentAuditLogger — bounded append-only JSONL persistence
// ============================================================================

/**
 * Minimal host abstraction so the sink is testable without VS Code.
 * The extension host adapts `vscode.ExtensionContext.globalStorageUri` to it.
 */
export interface AuditStorageAdapter {
  /** Absolute directory that exists (host must ensure it). */
  directory(): string;
  /** Read a file as utf8, or null when missing. */
  readFile(name: string): string | null;
  /** Append a single utf8 line (caller supplies the trailing newline). */
  appendLine(name: string, line: string): void;
  /** Delete a file (used by rotation); missing file is not an error. */
  removeFile(name: string): void;
  /** List audit files with sizes; used for disk accounting and rotation. */
  listFiles(): Array<{ name: string; size: number }>;
  /** Synchronize pending writes to disk (crash-safety flush point). */
  sync(): void;
}

export interface PersistentAuditLoggerOptions {
  /** Per-file rotation threshold in bytes (default 5 MiB). */
  maxFileBytes?: number;
  /** Total disk budget across rotated files in bytes (default 20 MiB). */
  maxTotalBytes?: number;
  /** Maximum number of rotated files kept (default 8). */
  maxFiles?: number;
  /** Base file name; rotation produces `name.1`, `name.2`, … */
  baseName?: string;
  /**
   * Bounded durability window in ms: queued lines are flushed at least this
   * often (default 250). Short enough that a crash cannot lose a meaningful
   * audit tail, long enough to coalesce bursts into one write+sync.
   */
  flushDelayMs?: number;
}

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_FILES = 8;
const DEFAULT_BASE_NAME = "tool-audit.jsonl";
/** Durability window: queued audit lines are written within this window. */
const DEFAULT_FLUSH_DELAY_MS = 250;

/**
 * Bounded, append-only JSONL audit sink.
 *
 * Design rules:
 * - Records are ONLY written through `redactSecrets` (single shared redaction
 *   implementation — no duplicated secret-scrubbing logic).
 * - The file is bounded: per-file rotation at `maxFileBytes`, total disk
 *   capped by pruning the OLDEST rotated segment first. Deterministic order.
 * - Crash safety: appends are whole lines, synced via `sync()` on a bounded
 *   cadence. On load, a torn (incomplete) final line is dropped, never parsed.
 * - No unbounded memory: a small in-memory tail of the most recent entries is
 *   kept as a fast recent cache.
 * - All writes flow through ONE serialized promise chain, so concurrent
 *   record() calls can never interleave/corrupt JSONL lines.
 */
export class PersistentAuditLogger implements ToolAuditSink {
  private readonly adapter: AuditStorageAdapter;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxFiles: number;
  private readonly baseName: string;
  /** Fast recent cache — newest last, bounded. */
  private recent: ToolAuditEntry[] = [];
  /** Pending line batch awaiting sync (crash-safety flush point). */
  private pendingLines: string[] = [];
  private pendingBytes = 0;
  /** Rotation guard: current segment size estimate. */
  private currentSegmentBytes = 0;
  private flushedOnce = false;
  /** Serializes all writes; keeps JSONL append order under concurrency. */
  private chain: Promise<void> = Promise.resolve();
  /** Pending durability timer (null when nothing is scheduled). */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Durability window for queued lines. */
  private readonly flushDelayMs: number;
  /** After dispose, no new timer is scheduled and queued lines are flushed. */
  private disposed = false;

  constructor(
    adapter: AuditStorageAdapter,
    options: PersistentAuditLoggerOptions = {},
  ) {
    this.adapter = adapter;
    this.maxFileBytes = Math.max(
      64 * 1024,
      options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    );
    this.maxTotalBytes = Math.max(
      this.maxFileBytes,
      options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    );
    this.maxFiles = Math.max(2, options.maxFiles ?? DEFAULT_MAX_FILES);
    this.baseName = options.baseName ?? DEFAULT_BASE_NAME;
    this.flushDelayMs = Math.max(
      0,
      options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS,
    );
    this.recoverFromStartup();
  }
  // ------------------------------------------------------------------
  // Startup recovery: truncate a torn final line, load the recent tail.
  // ------------------------------------------------------------------
  private recoverFromStartup(): void {
    try {
      const raw = this.adapter.readFile(this.baseName);
      if (raw === null) return;
      let content = raw;
      // Torn tail: last line has no trailing newline — it was never durably
      // appended, so discard it (JSONL append-only contract).
      const torn = content.length > 0 && !content.endsWith("\n");
      if (torn) {
        const lastNl = content.lastIndexOf("\n");
        content = lastNl === -1 ? "" : content.slice(0, lastNl + 1);
        // Truncate the torn bytes on disk NOW: otherwise the next append
        // would glue its record onto the fragment and corrupt BOTH lines.
        // Best-effort remove + re-append of the complete lines only.
        try {
          this.adapter.removeFile(this.baseName);
          for (const line of content.split("\n")) {
            if (line.length > 0)
              this.adapter.appendLine(this.baseName, `${line}\n`);
          }
          this.adapter.sync();
        } catch {
          // Recovery is best-effort; an unwritable store must not break startup.
        }
      }
      this.currentSegmentBytes = Buffer.byteLength(content, "utf8");
      // Rebuild the recent cache from the last ~200 complete lines.
      const lines = content.split("\n").filter((l) => l.length > 0);
      for (const line of lines.slice(-200)) {
        try {
          this.recent.push(JSON.parse(line) as ToolAuditEntry);
        } catch {
          // Skip corrupt historical lines — never throw during recovery.
        }
      }
    } catch {
      // Recovery is best-effort; an unreadable store must not break startup.
    }
  }

  // ------------------------------------------------------------------
  // record(): same shape as ToolAuditLogger.record — redacts, persists.
  // ------------------------------------------------------------------
  record(entry: ToolAuditEntry): void {
    // Redact with the SHARED redaction function — the only secret scrubber.
    const safe: ToolAuditEntry = {
      ...entry,
      permissionDecision: entry.permissionDecision
        ? redactSecrets(entry.permissionDecision)
        : undefined,
      // Derived from tool input → scrubbed before it can reach disk.
      safeTarget: entry.safeTarget
        ? redactSecrets(entry.safeTarget)
        : undefined,
    };
    // Bounded in-memory tail (fast cache — mirrors ToolAuditLogger behavior).
    this.recent.push(safe);
    if (this.recent.length > 1_000) {
      this.recent = this.recent.slice(-500);
    }
    // Queue the JSONL line; all writes flow through one serialized chain.
    const line = JSON.stringify(safe) + "\n";
    this.pendingLines.push(line);
    this.pendingBytes += Buffer.byteLength(line, "utf8");
    if (this.pendingBytes >= 512 * 1024) {
      this.flushNow();
      return;
    }
    this.scheduleFlush();
  }

  /**
   * Bounded durability window: queued lines are always written within
   * `flushDelayMs`, so a crash loses at most that window of audit records.
   * The timer is unref'd — an audit flush must never keep the host alive.
   */
  private scheduleFlush(): void {
    if (this.flushTimer !== null || this.disposed) return;
    const timer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow();
    }, this.flushDelayMs);
    (timer as { unref?: () => void }).unref?.();
    this.flushTimer = timer;
  }

  /** Durably write all pending lines. Never throws. */
  flushNow(): void {
    if (this.pendingLines.length === 0) return;
    const lines = this.pendingLines;
    this.pendingLines = [];
    this.pendingBytes = 0;
    this.chain = this.chain
      .then(() => {
        for (const line of lines) {
          this.appendWithRotation(line);
        }
        this.adapter.sync();
        this.flushedOnce = true;
      })
      .catch(() => {
        // Persistence failure must never be fatal to the caller.
      });
  }

  private appendWithRotation(line: string): void {
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (
      this.flushedOnce &&
      this.currentSegmentBytes + lineBytes > this.maxFileBytes
    ) {
      this.rotateLocked();
    }
    this.adapter.appendLine(this.baseName, line);
    this.currentSegmentBytes += lineBytes;
    this.enforceDiskBudgetLocked();
  }

  /** Deterministic rotation: active → .1 → .2 … oldest pruned first. */
  private rotateLocked(): void {
    try {
      // Shift rotated segments: .N-1 → .N, starting from the highest index.
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const from = i === 1 ? this.baseName : `${this.baseName}.${i - 1}`;
        const to = `${this.baseName}.${i}`;
        const data = this.adapter.readFile(from);
        this.adapter.removeFile(to);
        if (data !== null) {
          for (const line of data.split("\n")) {
            if (line.length > 0) this.adapter.appendLine(to, line + "\n");
          }
        }
        this.adapter.removeFile(from);
      }
      this.currentSegmentBytes = 0;
      this.enforceDiskBudgetLocked();
    } catch {
      // Rotation is best-effort; the audit sink must never throw at runtime.
    }
  }

  /** Prune oldest rotated segments until total disk usage fits the budget. */
  private enforceDiskBudgetLocked(): void {
    try {
      const seq = (n: string): number =>
        n === this.baseName
          ? 0
          : Number(n.slice(this.baseName.length + 1)) || 0;
      const files = this.adapter
        .listFiles()
        .filter(
          (f) =>
            f.name === this.baseName || f.name.startsWith(`${this.baseName}.`),
        )
        .sort((a, b) => seq(a.name) - seq(b.name));
      let total = files.reduce((sum, f) => sum + f.size, 0);
      // Always keep the active file; prune the OLDEST rotated segment first
      // (highest sequence number — rotation moves active → .1 → .2 …, so a
      // higher index is strictly older). Pruning from the front would delete
      // the newest backup.
      const rotated = files
        .filter((f) => f.name !== this.baseName)
        .sort((a, b) => seq(b.name) - seq(a.name));
      let idx = 0;
      while (total > this.maxTotalBytes && idx < rotated.length) {
        const victim = rotated[idx]!;
        this.adapter.removeFile(victim.name);
        total -= victim.size;
        idx++;
      }
    } catch {
      // Best-effort accounting.
    }
  }

  /** Most recent entries from the in-memory cache (newest last). */
  list(limit = 100): ToolAuditEntry[] {
    return this.recent.slice(-limit);
  }

  /**
   * Read persisted records from all segments (oldest → newest), bounded to
   * the `limit` most recent. Used by diagnostics and restart-recovery tests.
   */
  readPersisted(limit = 500): ToolAuditEntry[] {
    const all: ToolAuditEntry[] = [];
    try {
      const seq = (n: string): number =>
        n === this.baseName
          ? 0
          : Number(n.slice(this.baseName.length + 1)) || 0;
      // Rotation moves active → .1 → .2 …, so a HIGHER index is OLDER and the
      // active file always holds the newest records: read highest-first, the
      // active file last. (Ascending order would return newest-first and make
      // slice(-limit) keep the oldest records.)
      const files = this.adapter
        .listFiles()
        .filter(
          (f) =>
            f.name === this.baseName || f.name.startsWith(`${this.baseName}.`),
        )
        .sort((a, b) => seq(b.name) - seq(a.name));
      for (const f of files) {
        const raw = this.adapter.readFile(f.name);
        if (raw === null) continue;
        for (const line of raw.split("\n")) {
          if (line.length === 0) continue;
          try {
            all.push(JSON.parse(line) as ToolAuditEntry);
          } catch {
            // Corrupt line: skip, never throw.
          }
        }
      }
    } catch {
      // Best-effort read.
    }
    return all.slice(-limit);
  }

  size(): number {
    return this.recent.length;
  }

  /** Drop the in-memory tail only — persisted records remain on disk. */
  clearCache(): void {
    this.recent = [];
  }

  /** Await durability (test convenience — resolves after the write chain). */
  async flush(): Promise<void> {
    this.flushNow();
    await this.chain;
  }

  /**
   * Stop the durability timer and write everything still queued. Idempotent;
   * safe to call from the extension's deactivate() path.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushNow();
    await this.chain;
  }
}
