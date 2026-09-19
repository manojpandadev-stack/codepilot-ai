/**
 * M17 — ScheduleService: extension-host backend for the Scheduler UI.
 *
 * The SINGLE source of truth for schedule state. The WebView never holds
 * authoritative state: every create/update/enable/disable/remove/run-now
 * request flows WebView → validated extension handler → here → the EXISTING
 * M17 TaskScheduler (never replaced, never duplicated).
 *
 * Execution path (one funnel, no alternate routes):
 *   tick due → queue → pump → runner → executor (live runtime, M4-gated)
 *   Run Now → SAME queue → pump → runner → executor (live runtime, M4-gated)
 * The service never executes prompts itself and never spawns processes.
 *
 * Security properties (never weaken):
 * - Schedules are validated server-side (this module). UI validation is
 *   convenience only and cannot be used to bypass these checks.
 * - Run Now and retries use the same runner as scheduled runs — a manual
 *   trigger cannot bypass the scheduler/runtime/security chain.
 * - Views are sanitized (bounded strings). Prompts may contain workspace
 *   references but never credentials; nothing secret is ever added.
 */

import {
  TaskScheduler,
  nextRunAt,
  type MissedRunPolicy,
  type ScheduleDefinition,
  type ScheduleRunRecord,
} from "@codepilot/agent-runtime";

// ============================================================================
// View types (wire format — mirrors the WebView contract)
// ============================================================================

export type ScheduleKind = "once" | "recurring";

export interface ScheduleView {
  id: string;
  name: string;
  prompt: string;
  kind: ScheduleKind;
  atIso?: string;
  everyMinutes?: number;
  dailyAt?: string;
  timezone?: string;
  missedRunPolicy: MissedRunPolicy;
  enabled: boolean;
  maxRetries: number;
  createdAtMs: number;
  lastRunAtMs?: number;
  lastRunStatus?: "success" | "failed" | "skipped";
  nextRunAtMs?: number;
  /** Live execution state derived from queued/running records. */
  liveStatus: "idle" | "queued" | "running";
  /** Aggregate counts from bounded in-memory history. */
  runCount: number;
  successCount: number;
  failedCount: number;
}

export interface ScheduleRunView {
  scheduleId: string;
  scheduleName: string;
  startedAtMs: number;
  finishedAtMs?: number;
  durationMs?: number;
  status: string;
  attempt: number;
  error?: string;
  exitCode?: number;
  outputExcerpt?: string;
}

export interface ScheduleDetailsView {
  schedule: ScheduleView;
  history: ScheduleRunView[];
}

export type ScheduleServiceEvent =
  | { type: "schedules/changed" }
  | { type: "schedule/run"; scheduleId: string; status: string };

export type ScheduleServiceListener = (event: ScheduleServiceEvent) => void;

export interface ScheduleInput {
  id?: unknown;
  name?: unknown;
  prompt?: unknown;
  kind?: unknown;
  atIso?: unknown;
  everyMinutes?: unknown;
  dailyAt?: unknown;
  timezone?: unknown;
  missedRunPolicy?: unknown;
  enabled?: unknown;
  maxRetries?: unknown;
}

// ============================================================================
// Server-side validation (authoritative — UI checks are convenience only)
// ============================================================================

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DAILY_PATTERN = /^(\d{1,2}):(\d{2})$/;
/** Safety floor: sub-minute recurrence is refused (runaway protection). */
const MIN_EVERY_MINUTES = 1;
/** Sanity ceiling: intervals beyond ~30 days are almost certainly a mistake. */
const MAX_EVERY_MINUTES = 43200;
/** Retry bound: M17 retries are automatic and bounded. */
const MAX_RETRIES = 5;

export function isValidScheduleId(id: unknown): id is string {
  return typeof id === "string" && ID_PATTERN.test(id);
}

export function isValidTimezone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.length === 0 || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export interface ValidatedSchedule {
  kind: "once" | "recurring";
  atIso?: string;
  everyMinutes?: number;
  dailyAt?: string;
  timezone?: string;
  missedRunPolicy: MissedRunPolicy;
  enabled: boolean;
  maxRetries: number;
  name: string;
  prompt: string;
}

export function validateScheduleInput(
  input: ScheduleInput,
): { ok: true; value: ValidatedSchedule } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  const name = typeof input.name === "string" ? input.name.trim().slice(0, 100) : "";
  if (!name) errors.push("name is required (1-100 chars)");
  const prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 4000) : "";
  if (!prompt) errors.push("prompt is required (1-4000 chars)");

  if (input.kind !== "once" && input.kind !== "recurring") {
    errors.push("kind must be 'once' or 'recurring'");
  }

  let atIso: string | undefined;
  let everyMinutes: number | undefined;
  let dailyAt: string | undefined;
  let timezone: string | undefined;

  if (input.kind === "once") {
    if (typeof input.atIso !== "string" || input.atIso.trim().length === 0) {
      errors.push("atIso is required for one-time schedules (ISO date-time)");
    } else {
      const at = Date.parse(input.atIso);
      if (Number.isNaN(at)) {
        errors.push(`atIso is not a valid date-time: '${input.atIso.slice(0, 64)}'`);
      } else if (at <= Date.now()) {
        errors.push("atIso is in the past — a one-time schedule there would never run");
      } else {
        atIso = new Date(at).toISOString();
      }
    }
    if (input.everyMinutes !== undefined || input.dailyAt !== undefined) {
      errors.push("once schedules accept only atIso (no everyMinutes/dailyAt)");
    }
  }

  if (input.kind === "recurring") {
    const hasEvery = input.everyMinutes !== undefined;
    const hasDaily = input.dailyAt !== undefined;
    if (hasEvery === hasDaily) {
      errors.push("recurring schedules need exactly one of everyMinutes or dailyAt");
    }
    if (hasEvery) {
      const n =
        typeof input.everyMinutes === "string" && input.everyMinutes.trim() !== ""
          ? Number(input.everyMinutes)
          : input.everyMinutes;
      if (typeof n !== "number" || !Number.isInteger(n)) {
        errors.push("everyMinutes must be an integer number of minutes");
      } else if (n < MIN_EVERY_MINUTES) {
        errors.push(`everyMinutes must be at least ${MIN_EVERY_MINUTES} (runaway protection)`);
      } else if (n > MAX_EVERY_MINUTES) {
        errors.push(`everyMinutes must be at most ${MAX_EVERY_MINUTES} (~30 days)`);
      } else {
        everyMinutes = n;
      }
    }
    if (hasDaily) {
      if (typeof input.dailyAt !== "string") {
        errors.push("dailyAt must be 'HH:MM'");
      } else {
        const m = DAILY_PATTERN.exec(input.dailyAt.trim());
        const hh = m ? Number(m[1]) : -1;
        const mm = m ? Number(m[2]) : -1;
        if (!m || hh > 23 || mm > 59) {
          errors.push(`dailyAt must be a valid time 'HH:MM' (00:00-23:59), got '${input.dailyAt.slice(0, 16)}'`);
        } else {
          dailyAt = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
        }
      }
      if (input.timezone !== undefined) {
        if (!isValidTimezone(input.timezone)) {
          errors.push(`unknown IANA timezone: '${String(input.timezone).slice(0, 64)}'`);
        } else {
          timezone = input.timezone;
        }
      }
    } else if (input.timezone !== undefined) {
      errors.push("timezone applies only to dailyAt schedules");
    }
    if (input.atIso !== undefined) {
      errors.push("recurring schedules do not accept atIso");
    }
  }

  let missedRunPolicy: MissedRunPolicy = "skip";
  if (input.missedRunPolicy !== undefined) {
    if (input.missedRunPolicy !== "skip" && input.missedRunPolicy !== "run-once" && input.missedRunPolicy !== "run-all") {
      errors.push("missedRunPolicy must be skip | run-once | run-all");
    } else {
      missedRunPolicy = input.missedRunPolicy;
    }
  }

  let enabled = true;
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") {
      errors.push("enabled must be a boolean");
    } else {
      enabled = input.enabled;
    }
  }

  let maxRetries = 0;
  if (input.maxRetries !== undefined) {
    const r = typeof input.maxRetries === "string" && input.maxRetries.trim() !== "" ? Number(input.maxRetries) : input.maxRetries;
    if (typeof r !== "number" || !Number.isInteger(r) || r < 0 || r > MAX_RETRIES) {
      errors.push(`maxRetries must be an integer 0-${MAX_RETRIES}`);
    } else {
      maxRetries = r;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      kind: input.kind as "once" | "recurring",
      ...(atIso ? { atIso } : {}),
      ...(everyMinutes !== undefined ? { everyMinutes } : {}),
      ...(dailyAt ? { dailyAt } : {}),
      ...(timezone ? { timezone } : {}),
      missedRunPolicy,
      enabled,
      maxRetries,
      name,
      prompt,
    },
  };
}

/** Human-readable schedule expression (uses the ACTUAL supported syntax). */
export function describeSchedule(def: {
  kind: string;
  atIso?: string;
  everyMinutes?: number;
  dailyAt?: string;
  timezone?: string;
}): string {
  if (def.kind === "once") return `once ${def.atIso ?? "(unset)"}`;
  if (def.everyMinutes !== undefined) {
    const m = def.everyMinutes;
    if (m % 1440 === 0) return `every ${m / 1440}d`;
    if (m % 60 === 0) return `every ${m / 60}h`;
    return `every ${m}m`;
  }
  if (def.dailyAt) return `daily ${def.dailyAt}${def.timezone ? ` (${def.timezone})` : ""}`;
  return "recurring (unset)";
}

// ============================================================================
// ScheduleService
// ============================================================================

export type ScheduleExecutor = (
  prompt: string,
  schedule: ScheduleDefinition,
) => Promise<{ exitCode: number; output: string }>;

export interface ScheduleServiceOptions {
  storePath?: string;
  maxConcurrent?: number;
  tickIntervalMs?: number;
}

function newScheduleId(): string {
  return `sched-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export class ScheduleService {
  private readonly scheduler: TaskScheduler;
  private readonly listeners = new Set<ScheduleServiceListener>();
  private started = false;
  private disposed = false;

  constructor(
    private readonly executor: ScheduleExecutor,
    options?: ScheduleServiceOptions,
  ) {
    this.scheduler = new TaskScheduler(
      async (prompt, schedule) => this.executor(prompt, schedule),
      {
        maxConcurrent: options?.maxConcurrent ?? 1,
        tickIntervalMs: options?.tickIntervalMs ?? 30_000,
        storePath: options?.storePath,
        onRunEvent: () => this.emitChanged(),
      },
    );
  }

  subscribe(listener: ScheduleServiceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Number of active listeners (lifecycle introspection for tests). */
  listenerCount(): number {
    return this.listeners.size;
  }

  /** Underlying scheduler (introspection for tests; mutations go through here). */
  get taskScheduler(): TaskScheduler {
    return this.scheduler;
  }

  /** Ensure the tick loop runs when any enabled schedule exists. Idempotent. */
  ensureStarted(): void {
    if (this.disposed || this.started) return;
    if (this.scheduler.list().some((s) => s.enabled)) {
      this.scheduler.start();
      this.started = true;
    }
  }

  // ---- Create ---------------------------------------------------------------

  create(
    input: ScheduleInput,
  ): { ok: true; schedule: ScheduleView } | { ok: false; errors: string[] } {
    if (this.disposed) return { ok: false, errors: ["service disposed"] };
    const validated = validateScheduleInput(input);
    if (!validated.ok) return validated;
    let id: string;
    if (input.id === undefined) {
      id = newScheduleId();
    } else if (isValidScheduleId(input.id)) {
      if (this.scheduler.get(input.id)) {
        return { ok: false, errors: [`schedule id '${input.id}' already exists`] };
      }
      id = input.id;
    } else {
      return { ok: false, errors: ["id must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"] };
    }
    const def = this.scheduler.upsert({ id, ...validated.value });
    this.ensureStarted();
    this.emitChanged();
    return { ok: true, schedule: this.toView(def) };
  }

  // ---- Update (edit) ----------------------------------------------------------

  update(
    id: unknown,
    input: ScheduleInput,
  ): { ok: true; schedule: ScheduleView } | { ok: false; errors: string[] } {
    if (this.disposed) return { ok: false, errors: ["service disposed"] };
    if (!isValidScheduleId(id)) return { ok: false, errors: ["invalid schedule id"] };
    const existing = this.scheduler.get(id);
    if (!existing) return { ok: false, errors: [`unknown schedule: ${id}`] };
    // Merge over the stored definition so unspecified fields (including
    // maxRetries and run bookkeeping) survive an edit.
    const merged: ScheduleInput = {
      name: input.name ?? existing.name,
      prompt: input.prompt ?? existing.prompt,
      kind: input.kind ?? existing.kind,
      atIso: input.atIso ?? existing.atIso,
      everyMinutes: input.everyMinutes ?? existing.everyMinutes,
      dailyAt: input.dailyAt ?? existing.dailyAt,
      timezone: input.timezone ?? existing.timezone,
      missedRunPolicy: input.missedRunPolicy ?? existing.missedRunPolicy ?? "skip",
      enabled: input.enabled ?? existing.enabled,
      maxRetries: input.maxRetries ?? existing.maxRetries ?? 0,
    };
    const validated = validateScheduleInput(merged);
    if (!validated.ok) return validated;
    // A disabled schedule stays disabled unless the edit says otherwise.
    const def = this.scheduler.upsert({ id, ...validated.value });
    this.ensureStarted();
    this.emitChanged();
    return { ok: true, schedule: this.toView(def) };
  }

  // ---- Enable / disable ---------------------------------------------------------

  setEnabled(
    id: unknown,
    enabled: unknown,
  ): { ok: true; schedule: ScheduleView } | { ok: false; errors: string[] } {
    if (this.disposed) return { ok: false, errors: ["service disposed"] };
    if (!isValidScheduleId(id)) return { ok: false, errors: ["invalid schedule id"] };
    if (typeof enabled !== "boolean") return { ok: false, errors: ["enabled must be a boolean"] };
    const existing = this.scheduler.get(id);
    if (!existing) return { ok: false, errors: [`unknown schedule: ${id}`] };
    // Preserve EVERYTHING (maxRetries, missed policy, bookkeeping) — a
    // toggle must never reset retry configuration.
    const def = this.scheduler.upsert({ ...existing, enabled });
    this.ensureStarted();
    this.emitChanged();
    return { ok: true, schedule: this.toView(def) };
  }

  // ---- Remove ---------------------------------------------------------------------

  remove(id: unknown): { ok: true } | { ok: false; errors: string[] } {
    if (this.disposed) return { ok: false, errors: ["service disposed"] };
    if (!isValidScheduleId(id)) return { ok: false, errors: ["invalid schedule id"] };
    // Refuse while a run for this schedule is in flight: removal stops
    // FUTURE runs, and an in-flight execution must not be orphaned silently.
    if (this.scheduler.hasActiveRun(id)) {
      return { ok: false, errors: [`schedule '${id}' has an active execution — wait for it to finish first`] };
    }
    const removed = this.scheduler.remove(id);
    if (!removed) return { ok: false, errors: [`unknown schedule: ${id}`] };
    this.emitChanged();
    return { ok: true };
  }

  // ---- Run now ----------------------------------------------------------------------

  runNow(id: unknown): { ok: true; status: string } | { ok: false; errors: string[] } {
    if (this.disposed) return { ok: false, errors: ["service disposed"] };
    if (!isValidScheduleId(id)) return { ok: false, errors: ["invalid schedule id"] };
    const result = this.scheduler.runNow(id);
    if (!result.ok) return { ok: false, errors: [result.error] };
    this.ensureStarted();
    this.emitChanged();
    return { ok: true, status: result.record.status };
  }

  // ---- Read ---------------------------------------------------------------------------

  list(): ScheduleView[] {
    return this.scheduler.list().map((s) => this.toView(s));
  }

  details(id: unknown): { ok: true; details: ScheduleDetailsView } | { ok: false; errors: string[] } {
    if (!isValidScheduleId(id)) return { ok: false, errors: ["invalid schedule id"] };
    const def = this.scheduler.get(id);
    if (!def) return { ok: false, errors: [`unknown schedule: ${id}`] };
    const history = this.scheduler
      .runHistory(50)
      .filter((r) => r.scheduleId === id)
      .map((r) => this.toRunView(r, def.name));
    return { ok: true, details: { schedule: this.toView(def), history } };
  }

  history(limit = 50): ScheduleRunView[] {
    const capped = Math.max(1, Math.min(50, Math.floor(limit)));
    const names = new Map(this.scheduler.list().map((s) => [s.id, s.name] as const));
    return this.scheduler
      .runHistory(capped)
      .map((r) => this.toRunView(r, names.get(r.scheduleId) ?? r.scheduleId));
  }

  /** Aggregate run metrics (computed from bounded history). */
  metrics(): { total: number; success: number; failed: number; running: number; queued: number } {
    const history = this.scheduler.runHistory(50);
    return {
      total: history.length,
      success: history.filter((r) => r.status === "success").length,
      failed: history.filter((r) => r.status === "failed").length,
      running: history.filter((r) => r.status === "running").length,
      queued: history.filter((r) => r.status === "queued").length,
    };
  }

  /** Stop ticking and mark in-flight records cancelled. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.scheduler.cancelAll();
    } catch {
      // best effort
    }
    this.listeners.clear();
  }

  /** True after dispose (lifecycle introspection for tests). */
  isDisposed(): boolean {
    return this.disposed;
  }

  // ---- Private --------------------------------------------------------------------------

  private emitChanged(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener({ type: "schedules/changed" });
      } catch {
        // never break scheduling
      }
    }
  }

  private liveStatus(id: string): "idle" | "queued" | "running" {
    const rec = this.scheduler
      .runHistory(50)
      .find((r) => r.scheduleId === id && (r.status === "queued" || r.status === "running"));
    return rec?.status === "running" ? "running" : rec ? "queued" : "idle";
  }

  private toView(def: ScheduleDefinition): ScheduleView {
    const history = this.scheduler.runHistory(50).filter((r) => r.scheduleId === def.id);
    const successCount = history.filter((r) => r.status === "success").length;
    const failedCount = history.filter((r) => r.status === "failed").length;
    // Next run is computed fresh (never a stale persisted value); disabled
    // or unsatisfiable schedules expose no next run.
    const freshNext = def.enabled ? nextRunAt(def, Date.now()) : undefined;
    return {
      id: def.id,
      name: def.name.slice(0, 100),
      prompt: def.prompt.slice(0, 4000),
      kind: def.kind,
      ...(def.atIso ? { atIso: def.atIso } : {}),
      ...(def.everyMinutes !== undefined ? { everyMinutes: def.everyMinutes } : {}),
      ...(def.dailyAt ? { dailyAt: def.dailyAt } : {}),
      ...(def.timezone ? { timezone: def.timezone } : {}),
      missedRunPolicy: def.missedRunPolicy ?? "skip",
      enabled: def.enabled,
      maxRetries: def.maxRetries ?? 0,
      createdAtMs: def.createdAtMs,
      ...(def.lastRunAtMs !== undefined ? { lastRunAtMs: def.lastRunAtMs } : {}),
      ...(def.lastRunStatus ? { lastRunStatus: def.lastRunStatus } : {}),
      ...(freshNext !== undefined ? { nextRunAtMs: freshNext } : {}),
      liveStatus: this.liveStatus(def.id),
      runCount: history.length,
      successCount,
      failedCount,
    };
  }

  private toRunView(record: ScheduleRunRecord, scheduleName: string): ScheduleRunView {
    const view: ScheduleRunView = {
      scheduleId: record.scheduleId,
      scheduleName: scheduleName.slice(0, 100),
      startedAtMs: record.startedAtMs,
      status: record.status,
      attempt: record.attempt,
    };
    if (record.finishedAtMs !== undefined) {
      view.finishedAtMs = record.finishedAtMs;
      view.durationMs = Math.max(0, record.finishedAtMs - record.startedAtMs);
    }
    if (record.error) view.error = record.error.slice(0, 500);
    if (record.result) {
      view.exitCode = record.result.exitCode;
      view.outputExcerpt = record.result.output.slice(0, 500);
    }
    return view;
  }
}
