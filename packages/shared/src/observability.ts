/**
 * M18 — Observability & Telemetry.
 *
 * A single dependency-free module other packages log into:
 *
 * - Metrics: counters, histograms, gauges with bounded label cardinality.
 * - Structured logger: JSON lines, levels, correlation IDs, and secret
 *   redaction — API keys/tokens/private keys never reach log output.
 * - Spans: lightweight task/child spans for latency tracing with
 *   parent/child correlation.
 *
 * Nothing here performs network telemetry: exporting is the caller's
 * concern, keeping the runtime offline-first.
 */

// ============================================================================
// Secret redaction for logs — delegates to the canonical shared scrubber
// (./secrets.js). No local secret patterns: one rule set for every sink.
// ============================================================================

import { scrubSecretsText } from "./secrets.js";

/** Redact secret-looking material from a string. */
export function redactLogText(text: string): string {
  return scrubSecretsText(text);
}

/** Deep-redact a value for logging (keys and embedded secrets). */
export function redactLogValue<T>(value: T, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactLogText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => redactLogValue(v, depth + 1));
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactLogText(value.message) };
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] =
        /pass(word)?|secret|token|api[_-]?key|credential|authorization|auth|cookie|session[_-]?id/i.test(
          key,
        )
          ? "[REDACTED]"
          : redactLogValue(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

// ============================================================================
// Metrics
// ============================================================================

export type MetricLabels = Record<string, string | number | boolean>;

/** Bounded cardinality: label values are truncated, series capped. */
function labelString(labels?: MetricLabels): string {
  if (!labels || Object.keys(labels).length === 0) return "";
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${String(labels[k]).slice(0, 64)}`)
    .join(",");
}

export interface CounterSnapshot {
  name: string;
  labels: MetricLabels;
  value: number;
}

export interface HistogramSnapshot {
  name: string;
  labels: MetricLabels;
  count: number;
  sumMs: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number;
}

export class MetricsRegistry {
  private counters = new Map<string, Map<string, number>>();
  private histograms = new Map<
    string,
    Map<
      string,
      { count: number; sum: number; values: number[]; labels: MetricLabels }
    >
  >();
  private gauges = new Map<string, Map<string, number>>();
  private readonly maxSeries = 500;

  increment(name: string, labels?: MetricLabels, by = 1): void {
    const key = name;
    let series = this.counters.get(key);
    if (!series) {
      series = new Map();
      this.counters.set(key, series);
    }
    const ls = labelString(labels);
    if (!series.has(ls) && series.size >= this.maxSeries) return;
    series.set(ls, (series.get(ls) ?? 0) + by);
  }

  observeMs(name: string, durationMs: number, labels?: MetricLabels): void {
    let series = this.histograms.get(name);
    if (!series) {
      series = new Map();
      this.histograms.set(name, series);
    }
    const ls = labelString(labels);
    let entry = series.get(ls);
    if (!entry) {
      if (series.size >= this.maxSeries) return;
      entry = { count: 0, sum: 0, values: [], labels: labels ?? {} };
      series.set(ls, entry);
    }
    entry.count += 1;
    entry.sum += durationMs;
    // Keep a bounded sample for percentile estimation.
    entry.values.push(durationMs);
    if (entry.values.length > 2048) {
      entry.values = entry.values.slice(-1024);
    }
  }

  setGauge(name: string, value: number, labels?: MetricLabels): void {
    let series = this.gauges.get(name);
    if (!series) {
      series = new Map();
      this.gauges.set(name, series);
    }
    const ls = labelString(labels);
    if (!series.has(ls) && series.size >= this.maxSeries) return;
    series.set(ls, value);
  }

  snapshot(): {
    counters: CounterSnapshot[];
    histograms: HistogramSnapshot[];
    gauges: Array<{ name: string; labels: MetricLabels; value: number }>;
  } {
    const counters: CounterSnapshot[] = [];
    for (const [name, series] of this.counters) {
      for (const [ls, value] of series) {
        counters.push({ name, labels: parseLabels(ls), value });
      }
    }
    const histograms: HistogramSnapshot[] = [];
    for (const [name, series] of this.histograms) {
      for (const [ls, entry] of series) {
        const sorted = [...entry.values].sort((a, b) => a - b);
        const pick = (q: number): number | null =>
          sorted.length === 0
            ? null
            : (sorted[
                Math.min(sorted.length - 1, Math.floor(q * sorted.length))
              ] ?? null);
        histograms.push({
          name,
          labels: parseLabels(ls),
          count: entry.count,
          sumMs: entry.sum,
          p50Ms: pick(0.5),
          p95Ms: pick(0.95),
          maxMs: sorted[sorted.length - 1] ?? 0,
        });
      }
    }
    const gauges: Array<{ name: string; labels: MetricLabels; value: number }> =
      [];
    for (const [name, series] of this.gauges) {
      for (const [ls, value] of series) {
        gauges.push({ name, labels: parseLabels(ls), value });
      }
    }
    return { counters, histograms, gauges };
  }

  reset(): void {
    this.counters.clear();
    this.histograms.clear();
    this.gauges.clear();
  }
}

function parseLabels(ls: string): MetricLabels {
  if (!ls) return {};
  const out: MetricLabels = {};
  for (const pair of ls.split(",")) {
    const idx = pair.indexOf("=");
    if (idx > 0) out[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return out;
}

// ============================================================================
// Structured logger
// ============================================================================

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  timestampMs: number;
  level: LogLevel;
  message: string;
  /** Correlation id — task/run/session id for tracing. */
  correlationId?: string;
  fields?: Record<string, unknown>;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Sink receives redacted JSON lines. Default: console (debug suppressed). */
  sink?: (record: LogRecord) => void;
  /** Keep an in-memory ring buffer for diagnostics. Default true. */
  bufferSize?: number;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class StructuredLogger {
  private records: LogRecord[] = [];
  private readonly level: LogLevel;
  private readonly sink: (record: LogRecord) => void;
  private readonly bufferSize: number;

  constructor(options?: LoggerOptions) {
    this.level = options?.level ?? "info";
    this.bufferSize = options?.bufferSize ?? 1000;
    this.sink = options?.sink ?? defaultSink;
  }

  debug(
    message: string,
    fields?: Record<string, unknown>,
    correlationId?: string,
  ): void {
    this.log("debug", message, fields, correlationId);
  }

  info(
    message: string,
    fields?: Record<string, unknown>,
    correlationId?: string,
  ): void {
    this.log("info", message, fields, correlationId);
  }

  warn(
    message: string,
    fields?: Record<string, unknown>,
    correlationId?: string,
  ): void {
    this.log("warn", message, fields, correlationId);
  }

  error(
    message: string,
    fields?: Record<string, unknown>,
    correlationId?: string,
  ): void {
    this.log("error", message, fields, correlationId);
  }

  log(
    level: LogLevel,
    message: string,
    fields?: Record<string, unknown>,
    correlationId?: string,
  ): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const record: LogRecord = {
      timestampMs: Date.now(),
      level,
      message: redactLogText(message),
      correlationId,
      fields: fields
        ? (redactLogValue(fields) as Record<string, unknown>)
        : undefined,
    };
    this.records.push(record);
    if (this.records.length > this.bufferSize) {
      this.records = this.records.slice(-Math.floor(this.bufferSize / 2));
    }
    this.sink(record);
  }

  /** Recent records (diagnostics bundle). */
  recent(limit = 100): LogRecord[] {
    return this.records.slice(-limit);
  }

  /** Records for one correlation id. */
  forCorrelation(correlationId: string, limit = 200): LogRecord[] {
    return this.records
      .filter((r) => r.correlationId === correlationId)
      .slice(-limit);
  }
}

function defaultSink(record: LogRecord): void {
  if (record.level === "debug") return; // quiet by default
  const line = JSON.stringify({
    t: record.timestampMs,
    l: record.level,
    m: record.message,
    ...(record.correlationId ? { c: record.correlationId } : {}),
    ...(record.fields ? { f: record.fields } : {}),
  });
  if (record.level === "error") {
    console.error(line);
  } else if (record.level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// ============================================================================
// Spans
// ============================================================================

export interface Span {
  name: string;
  correlationId?: string;
  parentSpanId?: string;
  spanId: string;
  startedAtMs: number;
  endedAtMs?: number;
  attributes?: Record<string, unknown>;
  status: "active" | "ok" | "error";
}

export class SpanTracker {
  private spans = new Map<string, Span>();
  private completed: Span[] = [];
  private nextId = 1;
  private readonly maxCompleted = 500;

  startSpan(
    name: string,
    options?: {
      correlationId?: string;
      parentSpanId?: string;
      attributes?: Record<string, unknown>;
    },
  ): Span {
    const span: Span = {
      name,
      spanId: `span-${this.nextId++}`,
      correlationId: options?.correlationId,
      parentSpanId: options?.parentSpanId,
      startedAtMs: Date.now(),
      attributes: options?.attributes
        ? (redactLogValue(options.attributes) as Record<string, unknown>)
        : undefined,
      status: "active",
    };
    this.spans.set(span.spanId, span);
    return span;
  }

  endSpan(span: Span, status: "ok" | "error" = "ok"): void {
    if (span.status !== "active") return;
    span.endedAtMs = Date.now();
    span.status = status;
    this.spans.delete(span.spanId);
    this.completed.push(span);
    if (this.completed.length > this.maxCompleted) {
      this.completed = this.completed.slice(-Math.floor(this.maxCompleted / 2));
    }
  }

  /** Completed spans for a correlation id (task trace). */
  trace(correlationId: string): Span[] {
    return this.completed.filter((s) => s.correlationId === correlationId);
  }

  /** Total latency stats per span name. */
  latencyByName(): Map<string, { count: number; avgMs: number }> {
    const out = new Map<string, { count: number; avgMs: number }>();
    for (const span of this.completed) {
      if (span.endedAtMs === undefined) continue;
      const stats = out.get(span.name) ?? { count: 0, avgMs: 0 };
      stats.avgMs =
        (stats.avgMs * stats.count + (span.endedAtMs - span.startedAtMs)) /
        (stats.count + 1);
      stats.count += 1;
      out.set(span.name, stats);
    }
    return out;
  }
}

// ============================================================================
// Facade
// ============================================================================

export interface Observability {
  metrics: MetricsRegistry;
  logger: StructuredLogger;
  spans: SpanTracker;
}

/** Create an isolated observability bundle. */
export function createObservability(options?: LoggerOptions): Observability {
  return {
    metrics: new MetricsRegistry(),
    logger: new StructuredLogger(options),
    spans: new SpanTracker(),
  };
}
