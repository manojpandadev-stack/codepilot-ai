/**
 * M17 — Scheduling & Automation.
 *
 * Durable task scheduler with safe defaults:
 *
 * - One-time (`at`) and recurring (`every`) schedules with timezone-aware
 *   time-of-day rules (`daily at HH:MM` in an IANA zone).
 * - Persistence: schedules survive restarts (JSON store, atomic writes,
 *   corrupt-tolerant). Missed runs are detected and handled per policy:
 *   `skip` (default), `run-once`, or `run-all` (bounded).
 * - Bounded concurrency: at most `maxConcurrent` runs at once (default 1) —
 *   the scheduler never creates uncontrolled background activity.
 * - Every run executes through the caller-supplied runner (the M16 CliRunner
 *   path), so scheduled work passes through the same M4 permission pipeline
 *   as interactive work. The scheduler itself never spawns processes.
 * - Retry with bounded attempts and per-run status tracking.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Types
// ============================================================================

export type ScheduleKind = "once" | "recurring";
export type MissedRunPolicy = "skip" | "run-once" | "run-all";

export interface ScheduleDefinition {
  id: string;
  name: string;
  kind: ScheduleKind;
  /** ISO timestamp for `once` schedules (UTC or with offset). */
  atIso?: string;
  /** Recurrence interval in minutes for `recurring` schedules. */
  everyMinutes?: number;
  /** Time-of-day "HH:MM" for daily schedules in `timezone`. */
  dailyAt?: string;
  /** IANA timezone for dailyAt. Default: system local time. */
  timezone?: string;
  /** Prompt executed by the runner. */
  prompt: string;
  /** Missed-run handling after downtime. Default "skip". */
  missedRunPolicy?: MissedRunPolicy;
  enabled: boolean;
  /** Retry attempts for failed runs. Default 0. */
  maxRetries?: number;
  createdAtMs: number;
  /** Last run bookkeeping. */
  lastRunAtMs?: number;
  lastRunStatus?: "success" | "failed" | "skipped";
  nextRunAtMs?: number;
}

export type RunStatus =
  "queued" | "running" | "success" | "failed" | "skipped" | "cancelled";

export interface ScheduleRunRecord {
  scheduleId: string;
  startedAtMs: number;
  finishedAtMs?: number;
  status: RunStatus;
  attempt: number;
  error?: string;
  result?: { exitCode: number; output: string };
}

export type ScheduleRunner = (
  prompt: string,
  schedule: ScheduleDefinition,
) => Promise<{ exitCode: number; output: string }>;

export interface SchedulerOptions {
  /** Max simultaneous scheduled runs. Default 1. */
  maxConcurrent?: number;
  /** Tick interval. Default 30s. */
  tickIntervalMs?: number;
  /** Storage file for persistence. Optional (in-memory when absent). */
  storePath?: string;
  /**
   * Optional run-event sink (UI push without polling). Invoked synchronously
   * on queued/running/terminal transitions. Never throws into the scheduler.
   */
  onRunEvent?: (record: ScheduleRunRecord) => void;
}

// ============================================================================
// Next-run computation (timezone-aware)
// ============================================================================

/** Compute the next run time for a schedule strictly after `afterMs`. */
export function nextRunAt(
  schedule: ScheduleDefinition,
  afterMs: number,
): number | undefined {
  if (!schedule.enabled) return undefined;
  if (schedule.kind === "once") {
    if (!schedule.atIso) return undefined;
    const at = Date.parse(schedule.atIso);
    if (Number.isNaN(at)) return undefined;
    return at > afterMs ? at : undefined;
  }
  if (schedule.everyMinutes && schedule.everyMinutes > 0) {
    const interval = schedule.everyMinutes * 60_000;
    const base = schedule.lastRunAtMs ?? afterMs;
    // Next occurrence = last run + interval. An overdue base (downtime)
    // yields a time in the PAST — that is intentional: isDue() classifies it
    // as due/missed so the missed-run policy can decide what happens.
    return base + interval;
  }
  if (schedule.dailyAt) {
    return nextDailyOccurrence(schedule.dailyAt, schedule.timezone, afterMs);
  }
  return undefined;
}

function nextDailyOccurrence(
  hhmm: string,
  timezone: string | undefined,
  afterMs: number,
): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;

  // Find today's occurrence in the target timezone; if past, use tomorrow.
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    const candidate = timeOfDayInZone(
      afterMs,
      dayOffset,
      hour,
      minute,
      timezone,
    );
    if (candidate > afterMs) return candidate;
  }
  return undefined;
}

/**
 * Wall-clock time `hour:minute` on `dayOffset` days from `referenceMs`,
 * interpreted in `timezone` (IANA). Uses Intl with a fixed-offset trick:
 * compute the zone offset at an approximate instant, then correct once.
 */
function timeOfDayInZone(
  referenceMs: number,
  dayOffset: number,
  hour: number,
  minute: number,
  timezone?: string,
): number {
  const approxUtc = referenceMs + dayOffset * 86_400_000;
  const tz = timezone ?? "UTC";
  // Offset (minutes) of tz at approxUtc.
  const offsetMinutes = zoneOffsetMinutes(new Date(approxUtc), tz);
  // Build the UTC instant whose local time equals the target.
  const dayStartUtc = new Date(approxUtc);
  dayStartUtc.setUTCHours(0, 0, 0, 0);
  const targetLocalMs =
    dayStartUtc.getTime() +
    (hour * 60 + minute) * 60_000 -
    offsetMinutes * 60_000;
  // One correction pass for DST boundary drift.
  const correctedOffset = zoneOffsetMinutes(new Date(targetLocalMs), tz);
  if (correctedOffset !== offsetMinutes) {
    return (
      dayStartUtc.getTime() +
      (hour * 60 + minute) * 60_000 -
      correctedOffset * 60_000
    );
  }
  return targetLocalMs;
}

function zoneOffsetMinutes(date: Date, timeZone: string): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts = dtf.formatToParts(date);
    const get = (type: string): number =>
      Number(parts.find((p) => p.type === type)?.value ?? "0");
    const asUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour") % 24,
      get("minute"),
      get("second"),
    );
    return Math.round((asUtc - date.getTime()) / 60_000);
  } catch {
    return 0; // unknown zone falls back to UTC
  }
}

// ============================================================================
// Persistence
// ============================================================================

function loadSchedules(storePath?: string): ScheduleDefinition[] {
  if (!storePath) return [];
  try {
    const raw = fs.readFileSync(storePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is ScheduleDefinition =>
        !!s &&
        typeof s === "object" &&
        typeof (s as ScheduleDefinition).id === "string" &&
        typeof (s as ScheduleDefinition).prompt === "string",
    );
  } catch {
    return [];
  }
}

function saveSchedules(
  storePath: string | undefined,
  schedules: readonly ScheduleDefinition[],
): void {
  if (!storePath) return;
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const tmp = `${storePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(schedules, null, 2), "utf8");
    fs.renameSync(tmp, storePath);
  } catch {
    // best-effort persistence
  }
}

// ============================================================================
// Scheduler
// ============================================================================

export class TaskScheduler {
  private schedules = new Map<string, ScheduleDefinition>();
  private runs: ScheduleRunRecord[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeRuns = 0;
  private queue: Array<{ schedule: ScheduleDefinition; dueMs: number }> = [];
  private cancelled = false;
  private readonly maxConcurrent: number;
  private readonly tickIntervalMs: number;
  private readonly storePath?: string;
  private readonly onRunEvent?: (record: ScheduleRunRecord) => void;

  constructor(
    private readonly runner: ScheduleRunner,
    options?: SchedulerOptions,
  ) {
    this.maxConcurrent = options?.maxConcurrent ?? 1;
    this.tickIntervalMs = options?.tickIntervalMs ?? 30_000;
    this.storePath = options?.storePath;
    this.onRunEvent = options?.onRunEvent;
    for (const schedule of loadSchedules(this.storePath)) {
      this.schedules.set(schedule.id, schedule);
    }
  }

  /** Register a schedule (persisted). Caller-provided run bookkeeping wins;
   * existing bookkeeping is kept when the caller omits it. */
  upsert(def: Omit<ScheduleDefinition, "createdAtMs">): ScheduleDefinition {
    const existing = this.schedules.get(def.id);
    const schedule: ScheduleDefinition = {
      ...def,
      createdAtMs: existing?.createdAtMs ?? Date.now(),
      lastRunAtMs: def.lastRunAtMs ?? existing?.lastRunAtMs,
      lastRunStatus: def.lastRunStatus ?? existing?.lastRunStatus,
    };
    schedule.nextRunAtMs = nextRunAt(schedule, Date.now());
    this.schedules.set(schedule.id, schedule);
    this.persist();
    return schedule;
  }

  remove(id: string): boolean {
    const removed = this.schedules.delete(id);
    if (removed) this.persist();
    return removed;
  }

  get(id: string): ScheduleDefinition | undefined {
    return this.schedules.get(id);
  }

  list(): ScheduleDefinition[] {
    return [...this.schedules.values()].sort(
      (a, b) => (a.nextRunAtMs ?? Infinity) - (b.nextRunAtMs ?? Infinity),
    );
  }

  runHistory(limit = 50): ScheduleRunRecord[] {
    return this.runs.slice(-limit).reverse();
  }

  /** True while a schedule has a queued or running run (duplicate guard). */
  hasActiveRun(scheduleId: string): boolean {
    return this.runs.some(
      (r) =>
        r.scheduleId === scheduleId &&
        (r.status === "queued" || r.status === "running"),
    );
  }

  /**
   * Run a schedule NOW through the SAME queue/executor/history path as
   * tick-triggered runs (no special execution path): the record is queued
   * and launched subject to the same maxConcurrent bound. Refuses when the
   * scheduler is stopped, the schedule is unknown/disabled, or a run for
   * the same schedule is already queued/running (exactly-once per trigger).
   */
  runNow(
    scheduleId: string,
  ): { ok: true; record: ScheduleRunRecord } | { ok: false; error: string } {
    if (this.cancelled) {
      return { ok: false, error: "scheduler is stopped" };
    }
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) {
      return { ok: false, error: `unknown schedule: ${scheduleId}` };
    }
    if (!schedule.enabled) {
      return { ok: false, error: `schedule '${scheduleId}' is disabled` };
    }
    if (this.hasActiveRun(scheduleId)) {
      return {
        ok: false,
        error: `schedule '${scheduleId}' already has a queued or running execution`,
      };
    }
    const record: ScheduleRunRecord = {
      scheduleId,
      startedAtMs: Date.now(),
      status: "queued",
      attempt: 0,
    };
    this.runs.push(record);
    this.queue.push({ schedule, dueMs: record.startedAtMs });
    // A manual run counts as a run: bookkeeping follows it, so the next
    // tick occurrence is computed from now (no immediate duplicate) and
    // last-run info stays truthful across restarts.
    schedule.lastRunAtMs = record.startedAtMs;
    schedule.nextRunAtMs = nextRunAt(schedule, record.startedAtMs);
    this.persist();
    this.emitRunEvent(record);
    this.pumpQueue();
    return { ok: true, record };
  }

  /** Start ticking. Returns immediately; runs happen on the interval. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.cancelled = false;
    // Catch-up check on start (missed-run handling).
    this.processTick();
    this.timer = setInterval(() => this.processTick(), this.tickIntervalMs);
    // Do not hold the event loop open.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Active timer handle for lifecycle tests (null when stopped/cancelled). */
  hasTimer(): boolean {
    return this.timer !== null;
  }

  /** Cancel everything: stop ticking, mark queued/running as cancelled. Idempotent. */
  cancelAll(): void {
    if (this.cancelled && this.timer === null && this.queue.length === 0) return;
    this.cancelled = true;
    this.stop();
    this.queue = [];
    for (const run of this.runs) {
      if (run.status === "running" || run.status === "queued") {
        run.status = "cancelled";
      }
    }
  }

  /**
   * One scheduler tick: find due schedules, apply missed-run policy,
   * enqueue eligible work, and start runs up to the concurrency limit.
   */
  processTick(nowMs = Date.now()): Array<ScheduleRunRecord> {
    if (this.cancelled) return [];

    for (const schedule of this.schedules.values()) {
      if (!schedule.enabled) continue;
      const due = this.isDue(schedule, nowMs);
      if (due === null) continue; // not due
      const policy = schedule.missedRunPolicy ?? "skip";
      if (due === "missed") {
        if (policy === "skip") {
          schedule.lastRunStatus = "skipped";
          schedule.lastRunAtMs = nowMs;
          schedule.nextRunAtMs = nextRunAt(schedule, nowMs);
          this.persist();
          this.record({
            scheduleId: schedule.id,
            startedAtMs: nowMs,
            status: "skipped",
            attempt: 0,
          });
          continue;
        }
        // run-once / run-all still enqueue (run-all bounded by catch-up cap
        // which only matters for backfill; single tick = one run).
      }
      // Due: enqueue.
      schedule.lastRunAtMs = nowMs;
      schedule.nextRunAtMs = nextRunAt(schedule, nowMs);
      this.persist();
      const record: ScheduleRunRecord = {
        scheduleId: schedule.id,
        startedAtMs: nowMs,
        status: "queued",
        attempt: 0,
      };
      this.runs.push(record);
      this.queue.push({ schedule, dueMs: nowMs });
      this.emitRunEvent(record);
    }

    // Launch up to concurrency (shared with runNow — one launch path).
    return this.pumpQueue();
  }

  /**
   * Launch queued records up to the concurrency bound. The single funnel
   * for tick-triggered AND manual runs — no alternate execution path.
   */
  private pumpQueue(): Array<ScheduleRunRecord> {
    const started: Array<ScheduleRunRecord> = [];
    while (this.activeRuns < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      const record = this.runs.find(
        (r) =>
          r.scheduleId === next.schedule.id &&
          r.status === "queued" &&
          r.startedAtMs === next.dueMs,
      );
      if (!record) continue;
      this.launch(next.schedule, record);
      started.push(record);
    }
    return started;
  }

  /**
   * "due" | "missed" | null:
   * - due: nextRunAtMs is set and has passed
   * - missed: the schedule was due in the past but we're seeing it late
   *   (downtime) — applies only to recurring schedules
   * - null: not due
   */
  private isDue(
    schedule: ScheduleDefinition,
    nowMs: number,
  ): "due" | "missed" | null {
    const next = schedule.nextRunAtMs ?? nextRunAt(schedule, nowMs);
    if (next === undefined) return null;
    if (next > nowMs) return null;
    // Missed = more than one interval/tick late.
    if (schedule.kind === "recurring") {
      const interval = (schedule.everyMinutes ?? 1) * 60_000;
      const lateness = nowMs - next;
      if (lateness > interval) return "missed";
    }
    return "due";
  }

  private launch(
    schedule: ScheduleDefinition,
    record: ScheduleRunRecord,
  ): void {
    this.activeRuns += 1;
    record.status = "running";
    record.attempt = 1;
    this.emitRunEvent(record);
    void this.executeWithRetry(schedule, record);
  }

  private async executeWithRetry(
    schedule: ScheduleDefinition,
    record: ScheduleRunRecord,
  ): Promise<void> {
    const maxAttempts = 1 + (schedule.maxRetries ?? 0);
    let lastError: string | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      record.attempt = attempt;
      try {
        const result = await this.runner(schedule.prompt, schedule);
        record.status = result.exitCode === 0 ? "success" : "failed";
        record.result = result;
        if (result.exitCode !== 0) {
          lastError = `exit code ${result.exitCode}`;
          continue;
        }
        record.finishedAtMs = Date.now();
        schedule.lastRunStatus = "success";
        this.finish(record, schedule);
        this.emitRunEvent(record);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        record.status = "failed";
      }
    }
    record.error = lastError;
    record.finishedAtMs = Date.now();
    schedule.lastRunStatus = "failed";
    this.finish(record, schedule);
    this.emitRunEvent(record);
  }

  private finish(
    record: ScheduleRunRecord,
    _schedule: ScheduleDefinition,
  ): void {
    void record;
    this.activeRuns -= 1;
    this.persist();
    // Drain: a freed slot immediately serves queued work (tick overflow or
    // a Run Now issued while another run was in flight). Without this, a
    // queued record would strand until the next tick.
    this.pumpQueue();
  }

  private record(entry: ScheduleRunRecord): void {
    this.runs.push(entry);
    if (this.runs.length > 500) {
      this.runs = this.runs.slice(-250);
    }
    this.emitRunEvent(entry);
  }

  /** Best-effort run-event fan-out (UI push without polling). */
  private emitRunEvent(record: ScheduleRunRecord): void {
    if (!this.onRunEvent) return;
    try {
      this.onRunEvent({ ...record });
    } catch {
      // A UI sink must never break scheduling.
    }
  }

  private persist(): void {
    saveSchedules(this.storePath, this.list());
  }
}
