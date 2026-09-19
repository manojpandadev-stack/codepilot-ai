/**
 * M18 — ObservabilityService: extension-host backend for the Metrics dashboard.
 *
 * The SINGLE aggregation point for dashboard data. It reads ONLY existing
 * infrastructure and NEVER creates a second collection system:
 *  - M18 MetricsRegistry snapshot (counters/histograms/gauges),
 *  - M18 StructuredLogger ring buffer (already redacted at write time),
 *  - M18 SpanTracker (latencyByName; empty in production → unavailable),
 *  - TaskHistoryService summaries (task counts, durations, providers,
 *    models, tool/ retry/file/ checkpoint aggregates, error flags),
 *  - ScheduleService/TeamService/TerminalSessionManager/live runtime for
 *    the ACTIVE section (capped, output-free snapshots).
 *
 * Honesty rules (never weaken):
 * - Every number is either a real aggregate or null (= unavailable, with a
 *   note). Session-cumulative registry counters are labeled as such: the
 *   time-range filter applies to TASK-derived data; counters are session
 *   totals. Percentiles come only from M18 histogram snapshots (with sample
 *   counts); nothing is fabricated from insufficient data.
 * - Tool labels never contain raw inputs/paths (M18 records names only);
 *   the service additionally strips terminal output, prompts, message
 *   bodies and checkpoint contents — views carry counts and capped excerpts
 *   that were already redacted upstream.
 * - The diagnostic export is built from allowlisted fields and passed
 *   through redactLogValue before leaving the host.
 * - Stateless: no listeners, no timers, no subscriptions. All reads are
 *   pull-based and bounded.
 */

import {
  redactLogValue,
  type MetricsRegistry,
  type StructuredLogger,
  type SpanTracker,
} from "@codepilot/shared";
import type { TaskHistoryService, TaskSummary } from "./task-history-service";
import type { ScheduleService } from "./schedule-service";
import type { TeamView } from "./team-service";
import type { TerminalSessionSnapshot } from "@codepilot/tool-engine";
import type { LiveTaskSnapshot } from "./task-history-service";

// ============================================================================
// View types (wire format — mirrors the WebView contract)
// ============================================================================

/** A dashboard number: real value or explicit unavailable marker. */
export interface MetricValue {
  key: string;
  label: string;
  value: number | null;
  unit?: string;
  /** Present exactly when value is null. */
  unavailableReason?: string;
  /** Session-cumulative counters are labeled so; task data honors ranges. */
  scope: "range" | "session";
}

export interface ToolMetricsRow {
  name: string;
  category: string;
  invocations: number;
  failures: number;
  success: number;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  samples: number;
}

export interface ProviderModelRow {
  model: string;
  tasks: number;
}

export interface ProviderRow {
  provider: string;
  tasks: number;
  models: ProviderModelRow[];
}

export interface ErrorCategoryRow {
  category: string;
  count: number;
  taskCount: number;
  recentAtMs?: number;
}

export interface RecentError {
  source: "task" | "log";
  taskId?: string;
  summary: string;
  atMs: number;
}

export interface ActiveTaskView {
  kind: "runtime" | "terminal" | "scheduled" | "team";
  id: string;
  label: string;
  status: string;
  startedAtMs?: number;
  elapsedMs?: number;
  detail?: string;
}

export interface DashboardFilter {
  fromMs?: unknown;
  toMs?: unknown;
  status?: unknown;
  provider?: unknown;
  model?: unknown;
  mode?: unknown;
  limit?: unknown;
}

export interface ValidatedDashboardFilter {
  fromMs?: number;
  toMs?: number;
  status?: string;
  provider?: string;
  model?: string;
  mode?: string;
  limit: number;
}

export interface DashboardView {
  generatedAtMs: number;
  rangeNote: string;
  overview: MetricValue[];
  performance: {
    taskDurations: { count: number; avgMs: number | null; minMs: number | null; maxMs: number | null };
    toolLatency: ToolMetricsRow[];
    modelLatency: MetricValue;
    contextLatency: MetricValue;
    terminalDuration: MetricValue;
    mcpDuration: MetricValue;
  };
  tools: ToolMetricsRow[];
  providers: ProviderRow[];
  tokens: { input: MetricValue; output: MetricValue };
  errors: { categories: ErrorCategoryRow[]; recent: RecentError[] };
  active: ActiveTaskView[];
}

export interface DiagnosticSummary {
  generatedAtMs: number;
  counts: Record<string, number>;
  tools: Array<{ name: string; invocations: number; failures: number }>;
  errors: RecentError[];
  active: number;
  notes: string[];
}

// ============================================================================
// Validation
// ============================================================================

const KNOWN_STATUSES = new Set([
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "archived",
]);

const MAX_LIMIT = 200;

export function validateDashboardFilter(
  filter: DashboardFilter,
): { ok: true; value: ValidatedDashboardFilter } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  let fromMs: number | undefined;
  let toMs: number | undefined;
  if (filter.fromMs !== undefined) {
    if (typeof filter.fromMs !== "number" || !Number.isFinite(filter.fromMs) || filter.fromMs < 0) {
      errors.push("fromMs must be a non-negative timestamp");
    } else {
      fromMs = Math.floor(filter.fromMs);
    }
  }
  if (filter.toMs !== undefined) {
    if (typeof filter.toMs !== "number" || !Number.isFinite(filter.toMs) || filter.toMs < 0) {
      errors.push("toMs must be a non-negative timestamp");
    } else {
      toMs = Math.floor(filter.toMs);
    }
  }
  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
    errors.push("fromMs must not be after toMs");
  }
  let status: string | undefined;
  if (filter.status !== undefined) {
    if (typeof filter.status !== "string" || !KNOWN_STATUSES.has(filter.status)) {
      errors.push(`status must be one of ${[...KNOWN_STATUSES].join(" | ")}`);
    } else {
      status = filter.status;
    }
  }
  const str64 = (v: unknown, name: string): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== "string" || v.length === 0 || v.length > 64) {
      errors.push(`${name} must be a string of 1-64 chars`);
      return undefined;
    }
    return v;
  };
  const provider = str64(filter.provider, "provider");
  const model = str64(filter.model, "model");
  const mode = str64(filter.mode, "mode");
  let limit = MAX_LIMIT;
  if (filter.limit !== undefined) {
    if (typeof filter.limit !== "number" || !Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > MAX_LIMIT) {
      errors.push(`limit must be an integer 1-${MAX_LIMIT}`);
    } else {
      limit = filter.limit;
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      ...(fromMs !== undefined ? { fromMs } : {}),
      ...(toMs !== undefined ? { toMs } : {}),
      ...(status ? { status } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(mode ? { mode } : {}),
      limit,
    },
  };
}

// ============================================================================
// Error categorization (deterministic, keyword-based, on redacted text)
// ============================================================================

export type ErrorCategory =
  | "timeout"
  | "permission"
  | "validation"
  | "network"
  | "provider"
  | "unknown";

export function categorizeError(summary: string): ErrorCategory {
  const text = summary.toLowerCase();
  if (/\btimeout\b|\btimed out\b|deadline/.test(text)) return "timeout";
  if (/permission|denied|forbidden|not allowed|approval/.test(text)) return "permission";
  if (/invalid|malformed|validation|schema|unexpected/.test(text)) return "validation";
  if (/network|econn|enotfound|socket|fetch failed|offline/.test(text)) return "network";
  if (/provider|model|ollama|unauthorized|rate limit|quota|overloaded/.test(text)) return "provider";
  return "unknown";
}

// ============================================================================
// Tool grouping (names only — labels never carry arguments)
// ============================================================================

export function toolCategory(name: string): string {
  const n = name.toLowerCase();
  if (n.startsWith("mcp__")) return "MCP";
  if (n.includes("terminal") || n === "bash" || n === "run_commands" || n.startsWith("terminal.")) {
    return "terminal";
  }
  if (n.startsWith("web_") || n.includes("fetch") || n.includes("search") || n === "browser") {
    return "browser";
  }
  if (
    n.startsWith("read_") ||
    n.startsWith("write_") ||
    n.startsWith("edit_") ||
    n.startsWith("apply_patch") ||
    n.startsWith("delete_") ||
    n.startsWith("list_") ||
    n.includes("file") ||
    n.includes("folder") ||
    n.includes("directory")
  ) {
    return "filesystem";
  }
  if (n.includes("agent") || n.includes("orchestrat") || n.includes("team") || n.includes("checkpoint")) {
    return "orchestration";
  }
  if (n.includes("plugin") || n.includes("mcp")) return "plugins";
  return "other";
}

// ============================================================================
// Service
// ============================================================================

export interface ObservabilityServiceDeps {
  metrics: MetricsRegistry;
  logger: StructuredLogger;
  spans: SpanTracker;
  taskHistory: TaskHistoryService;
  /** Scheduler backend (null when never initialized). */
  scheduler: () => ScheduleService | null;
  /** Running teams only (bounded by the implementation). */
  runningTeams: () => Promise<Array<Pick<TeamView, "teamId" | "objective" | "status">>>;
  /** Terminal snapshots (output stripped by this module). */
  terminals: () => TerminalSessionSnapshot[];
  /** Live runtime task (null when idle). */
  liveTask: () => LiveTaskSnapshot | null;
  /** Extension version for the export bundle. */
  extensionVersion?: string;
}

const MAX_TOOL_ROWS = 50;
const MAX_RECENT_ERRORS = 20;
const MAX_ACTIVE_ROWS = 50;

export class ObservabilityService {
  constructor(private readonly deps: ObservabilityServiceDeps) {}

  // ---- Dashboard ---------------------------------------------------------------

  async dashboard(
    filter: DashboardFilter = {},
  ): Promise<{ ok: true; dashboard: DashboardView } | { ok: false; errors: string[] }> {
    const validated = validateDashboardFilter(filter);
    if (!validated.ok) return validated;
    const f = validated.value;
    const tasks = await this.deps.taskHistory.list({
      ...(f.status ? { status: f.status } : {}),
      ...(f.provider ? { provider: f.provider } : {}),
      ...(f.model ? { model: f.model } : {}),
      ...(f.mode ? { mode: f.mode } : {}),
      ...(f.fromMs !== undefined ? { fromMs: f.fromMs } : {}),
      ...(f.toMs !== undefined ? { toMs: f.toMs } : {}),
      limit: f.limit,
    });
    const snap = this.deps.metrics.snapshot();
    const counter = (name: string, labels?: Record<string, string>): number | null => {
      let total = 0;
      let found = false;
      for (const c of snap.counters) {
        if (c.name !== name) continue;
        if (labels) {
          let match = true;
          for (const [k, v] of Object.entries(labels)) {
            if (String(c.labels[k] ?? "") !== v) {
              match = false;
              break;
            }
          }
          if (!match) continue;
        }
        found = true;
        total += c.value;
      }
      return found ? total : null;
    };
    const orZero = (v: number | null): number => v ?? 0;

    const byStatus = (status: string): number => tasks.filter((t) => t.status === status).length;
    const durations = tasks
      .map((t) => t.durationMs)
      .filter((d): d is number => typeof d === "number");
    const avg = (xs: number[]): number | null =>
      xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

    const toolCalls = tasks.reduce((n, t) => n + t.toolCallCount, 0);
    const retries = tasks.reduce((n, t) => n + t.retryCount, 0);
    const filesChanged = tasks.reduce((n, t) => n + t.filesChangedCount, 0);
    const checkpoints = tasks.reduce((n, t) => n + t.checkpointCount, 0);
    const approvals = orZero(counter("codepilot_approvals_total"));
    const tasksTotal = (status: string): number | null => counter("codepilot_tasks_total", { status });

    const overview: MetricValue[] = [
      { key: "tasks", label: "Tasks (in range)", value: tasks.length, scope: "range" },
      { key: "completed", label: "Completed", value: byStatus("completed"), scope: "range" },
      { key: "failed", label: "Failed", value: byStatus("failed"), scope: "range" },
      { key: "cancelled", label: "Cancelled", value: byStatus("cancelled"), scope: "range" },
      { key: "interrupted", label: "Interrupted", value: byStatus("interrupted"), scope: "range" },
      {
        key: "totalRuntime",
        label: "Total runtime",
        value: durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0)) : null,
        unit: "ms",
        ...(durations.length > 0 ? {} : { unavailableReason: "no completed durations in range" }),
        scope: "range",
      },
      {
        key: "avgRuntime",
        label: "Average runtime",
        value: avg(durations) === null ? null : Math.round(avg(durations) as number),
        unit: "ms",
        ...(durations.length > 0 ? {} : { unavailableReason: "no completed durations in range" }),
        scope: "range",
      },
      { key: "toolCalls", label: "Tool calls", value: toolCalls, scope: "range" },
      {
        key: "toolFailures",
        label: "Tool failures",
        value: orZero(counter("codepilot_tool_failures_total")),
        scope: "session",
      },
      { key: "retries", label: "Retries", value: retries, scope: "range" },
      { key: "approvals", label: "Approvals", value: approvals, scope: "session" },
      { key: "filesChanged", label: "Files changed", value: filesChanged, scope: "range" },
      // Checkpoint counts come from per-task history (range scope). The
      // session counter only records creations this session and would
      // double-count, so it is intentionally not mixed in.
      { key: "checkpoints", label: "Checkpoints", value: checkpoints, scope: "range" },
      { key: "terminalExecutions", label: "Terminal executions", value: orZero(counter("codepilot_terminal_sessions_total")), scope: "session" },
      { key: "mcpExecutions", label: "MCP executions", value: orZero(counter("codepilot_mcp_executions_total")), scope: "session" },
      { key: "pluginExecutions", label: "Plugin executions", value: orZero(counter("codepilot_plugin_executions_total")), scope: "session" },
      { key: "teamRuns", label: "Multi-agent runs", value: orZero(counter("codepilot_team_runs_total")), scope: "session" },
      { key: "scheduledRuns", label: "Scheduled executions", value: orZero(counter("codepilot_scheduled_runs_total")), scope: "session" },
      {
        key: "tasksCompletedCounter",
        label: "Tasks completed (session counter)",
        value: tasksTotal("completed"),
        ...(tasksTotal("completed") === null ? { unavailableReason: "no task completions recorded this session" } : {}),
        scope: "session",
      },
    ];

    const tools = this.buildToolRows(snap);
    const providers = this.buildProviderRows(tasks);
    const tokens = {
      input: {
        key: "inputTokens",
        label: "Input tokens",
        value: counter("codepilot_model_input_tokens"),
        ...((counter("codepilot_model_input_tokens") === null) ? { unavailableReason: "no token usage recorded this session" } : {}),
        scope: "session" as const,
      },
      output: {
        key: "outputTokens",
        label: "Output tokens",
        value: counter("codepilot_model_output_tokens"),
        ...((counter("codepilot_model_output_tokens") === null) ? { unavailableReason: "no token usage recorded this session" } : {}),
        scope: "session" as const,
      },
    };
    const errors = this.buildErrors(tasks);
    const active = await this.buildActive();
    const taskDurationList = durations;
    const performance = {
      taskDurations: {
        count: taskDurationList.length,
        avgMs: avg(taskDurationList) === null ? null : Math.round(avg(taskDurationList) as number),
        minMs: taskDurationList.length > 0 ? Math.min(...taskDurationList) : null,
        maxMs: taskDurationList.length > 0 ? Math.max(...taskDurationList) : null,
      },
      toolLatency: tools.slice(0, MAX_TOOL_ROWS),
      modelLatency: {
        key: "modelLatency",
        label: "Model latency",
        value: null,
        unavailableReason: "model latency is not instrumented",
        scope: "session" as const,
      },
      contextLatency: this.spanLatency("context.retrieve"),
      terminalDuration: {
        key: "terminalDuration",
        label: "Terminal execution duration",
        value: null,
        unavailableReason: "terminal durations are not instrumented",
        scope: "session" as const,
      },
      mcpDuration: {
        key: "mcpDuration",
        label: "MCP execution duration",
        value: null,
        unavailableReason: "MCP durations are not instrumented",
        scope: "session" as const,
      },
    };

    return {
      ok: true,
      dashboard: {
        generatedAtMs: Date.now(),
        rangeNote:
          f.fromMs !== undefined || f.toMs !== undefined || f.status || f.provider || f.model || f.mode
            ? "Task-derived metrics honor the filter; session counters are session totals."
            : "Task-derived metrics cover all available tasks; session counters are session totals.",
        overview,
        performance,
        tools: tools.slice(0, MAX_TOOL_ROWS),
        providers,
        tokens,
        errors,
        active: active.slice(0, MAX_ACTIVE_ROWS),
      },
    };
  }

  // ---- Diagnostic export (sanitized allowlist) --------------------------------------

  async diagnosticSummary(): Promise<{ ok: true; summary: DiagnosticSummary }> {
    const result = await this.dashboard({});
    const dashboard = result.ok ? result.dashboard : null;
    const counts: Record<string, number> = {};
    if (dashboard) {
      for (const m of dashboard.overview) {
        counts[m.key] = m.value ?? 0;
      }
    }
    const tools = (dashboard?.tools ?? []).slice(0, 20).map((t) => ({
      name: t.name,
      invocations: t.invocations,
      failures: t.failures,
    }));
    const errors = (dashboard?.errors.recent ?? []).slice(0, 10);
    const summary: DiagnosticSummary = {
      generatedAtMs: Date.now(),
      counts,
      tools,
      errors,
      active: dashboard?.active.length ?? 0,
      notes: [
        "Sanitized diagnostic bundle: counts, tool names and redacted error summaries only.",
        "No prompts, message bodies, tool arguments, file contents, checkpoints or credentials are included.",
      ],
    };
    // Defense in depth: the bundle is already allowlisted, and is redacted again here.
    return { ok: true, summary: redactLogValue(summary) as DiagnosticSummary };
  }

  // ---- Private --------------------------------------------------------------------------

  private buildToolRows(snap: ReturnType<MetricsRegistry["snapshot"]>): ToolMetricsRow[] {
    const byTool = new Map<
      string,
      { calls: number; failures: number; durations: { count: number; sum: number; p50: number | null; p95: number | null; max: number } | null }
    >();
    for (const c of snap.counters) {
      if (c.name !== "codepilot_tool_calls_total" && c.name !== "codepilot_tool_failures_total") continue;
      const tool = String(c.labels.tool ?? "unknown").slice(0, 64);
      const entry = byTool.get(tool) ?? {
        calls: 0,
        failures: 0,
        durations: null,
      };
      if (c.name === "codepilot_tool_calls_total") entry.calls += c.value;
      else entry.failures += c.value;
      byTool.set(tool, entry);
    }
    for (const h of snap.histograms) {
      if (h.name !== "codepilot_tool_duration_ms") continue;
      const tool = String(h.labels.tool ?? "unknown").slice(0, 64);
      const entry = byTool.get(tool) ?? { calls: 0, failures: 0, durations: null };
      entry.durations = { count: h.count, sum: h.sumMs, p50: h.p50Ms, p95: h.p95Ms, max: h.maxMs };
      byTool.set(tool, entry);
    }
    const rows: ToolMetricsRow[] = [];
    for (const [name, entry] of byTool) {
      const d = entry.durations;
      rows.push({
        name,
        category: toolCategory(name),
        invocations: entry.calls,
        failures: entry.failures,
        success: Math.max(0, entry.calls - entry.failures),
        avgMs: d && d.count > 0 ? Math.round(d.sum / d.count) : null,
        // Percentiles only when the underlying sample supports them.
        p50Ms: d && d.count >= 2 ? d.p50 : null,
        p95Ms: d && d.count >= 2 ? d.p95 : null,
        maxMs: d && d.count > 0 ? d.max : null,
        samples: d?.count ?? 0,
      });
    }
    return rows.sort((a, b) => b.invocations - a.invocations).slice(0, MAX_TOOL_ROWS);
  }

  private buildProviderRows(tasks: TaskSummary[]): ProviderRow[] {
    const byProvider = new Map<string, Map<string, number>>();
    for (const t of tasks) {
      const provider = t.provider ?? "unknown";
      const model = t.model ?? "unknown";
      let models = byProvider.get(provider);
      if (!models) {
        models = new Map();
        byProvider.set(provider, models);
      }
      models.set(model, (models.get(model) ?? 0) + 1);
    }
    const rows: ProviderRow[] = [];
    for (const [provider, models] of byProvider) {
      rows.push({
        provider: provider.slice(0, 64),
        tasks: [...models.values()].reduce((a, b) => a + b, 0),
        models: [...models.entries()]
          .map(([model, count]) => ({ model: model.slice(0, 64), tasks: count }))
          .sort((a, b) => b.tasks - a.tasks)
          .slice(0, 20),
      });
    }
    return rows.sort((a, b) => b.tasks - a.tasks).slice(0, 20);
  }

  private buildErrors(tasks: TaskSummary[]): {
    categories: ErrorCategoryRow[];
    recent: RecentError[];
  } {
    const byCategory = new Map<ErrorCategory, { count: number; tasks: Set<string>; recentAtMs: number }>();
    const bump = (category: ErrorCategory, taskId: string | undefined, atMs: number): void => {
      const entry = byCategory.get(category) ?? { count: 0, tasks: new Set(), recentAtMs: 0 };
      entry.count += 1;
      if (taskId) entry.tasks.add(taskId);
      entry.recentAtMs = Math.max(entry.recentAtMs, atMs);
      byCategory.set(category, entry);
    };
    // Task-derived error flags (bounded by the task list cap).
    for (const t of tasks) {
      if (t.hasErrors) bump("unknown", t.id, t.updatedAtMs);
      if (t.status === "failed") bump("unknown", t.id, t.updatedAtMs);
    }
    // Recent redacted log records (already sanitized at write time).
    const recent: RecentError[] = [];
    try {
      for (const record of this.deps.logger.recent(100)) {
        if (record.level !== "error" && record.level !== "warn") continue;
        const summary = `${record.message}`.slice(0, 200);
        bump(categorizeError(summary), undefined, record.timestampMs);
        if (recent.length < MAX_RECENT_ERRORS) {
          recent.push({ source: "log", summary, atMs: record.timestampMs });
        }
      }
    } catch {
      // logger unavailable — categories from tasks still stand
    }
    const categories: ErrorCategoryRow[] = [...byCategory.entries()].map(([category, entry]) => ({
      category,
      count: entry.count,
      taskCount: entry.tasks.size,
      ...(entry.recentAtMs > 0 ? { recentAtMs: entry.recentAtMs } : {}),
    }));
    categories.sort((a, b) => b.count - a.count);
    return { categories: categories.slice(0, 20), recent };
  }

  private async buildActive(): Promise<ActiveTaskView[]> {
    const out: ActiveTaskView[] = [];
    try {
      const live = this.deps.liveTask();
      if (live) {
        out.push({
          kind: "runtime",
          id: live.taskId ?? live.sessionId ?? "active",
          label: "Agent task",
          status: live.status,
          detail: `${live.toolCalls.reduce((n, t) => n + t.count, 0)} tool calls`,
        });
      }
    } catch {
      // no live task — omit, never fail the dashboard
    }
    try {
      for (const s of this.deps.terminals().slice(0, 20)) {
        out.push({
          kind: "terminal",
          // Output streams are NEVER included — id/status only.
          id: String(s.id).slice(0, 128),
          label: "Terminal session",
          status: String(s.status),
        });
      }
    } catch {
      // terminals unavailable — omit
    }
    try {
      const scheduler = this.deps.scheduler();
      if (scheduler) {
        for (const s of scheduler.list()) {
          if (s.liveStatus === "idle") continue;
          out.push({
            kind: "scheduled",
            id: s.id,
            label: s.name.slice(0, 100),
            status: s.liveStatus,
          });
          if (out.length >= MAX_ACTIVE_ROWS) break;
        }
      }
    } catch {
      // scheduler unavailable — omit
    }
    try {
      for (const t of (await this.deps.runningTeams()).slice(0, 20)) {
        out.push({
          kind: "team",
          id: t.teamId,
          label: t.objective.slice(0, 120),
          status: t.status,
        });
        if (out.length >= MAX_ACTIVE_ROWS) break;
      }
    } catch {
      // teams unavailable — omit
    }
    return out.slice(0, MAX_ACTIVE_ROWS);
  }

  private spanLatency(name: string): MetricValue {
    try {
      const stats = this.deps.spans.latencyByName().get(name);
      if (!stats || stats.count === 0) {
        return {
          key: `${name}Latency`,
          label: `${name} latency`,
          value: null,
          unavailableReason: "no spans recorded",
          scope: "session",
        };
      }
      return {
        key: `${name}Latency`,
        label: `${name} latency (avg)`,
        value: Math.round(stats.avgMs),
        unit: "ms",
        scope: "session",
      };
    } catch {
      return {
        key: `${name}Latency`,
        label: `${name} latency`,
        value: null,
        unavailableReason: "span reader unavailable",
        scope: "session",
      };
    }
  }
}
