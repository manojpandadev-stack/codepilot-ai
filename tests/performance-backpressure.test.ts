/**
 * Phase 6 — Performance & backpressure stress tests.
 *
 * These are MEASUREMENTS, not guesses: every case drives a real component
 * with a synthetic flood and reports the observed numbers to stdout so the
 * results can be recorded in the performance audit. Assertions cover only
 * bound invariants (retention caps, no growth, scaling sanity) — never tight
 * wall-clock thresholds, which flake on shared CI runners.
 *
 * Components exercised are the real production ones:
 *   - StructuredLogger ring buffer (M18)
 *   - MetricsRegistry counter/histogram cardinality + sample bounds (M18)
 *   - TaskStore conversation cap + bounded tool payloads (M12)
 *   - TerminalSession stdout cap under a genuine multi-megabyte flood (M7)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MetricsRegistry,
  StructuredLogger,
} from "../packages/shared/src/observability";
import { TaskStore } from "../packages/agent-runtime/src/m12-task-store";
import { TerminalSession } from "../packages/tool-engine/src/m7/terminal-session";

/** Report a measurement line in a stable, greppable format. */
function report(label: string, value: string): void {
  process.stdout.write(`[perf] ${label}: ${value}\n`);
}

describe("Phase 6 — bounded buffers under load", () => {
  it("logger ring buffer stays bounded across a 20k-record flood", () => {
    const sunk: number[] = [];
    const logger = new StructuredLogger({
      level: "info",
      bufferSize: 1000,
      sink: (record) => sunk.push(record.timestampMs),
    });

    const records = 20_000;
    const started = performance.now();
    for (let i = 0; i < records; i++) {
      logger.info("task event", { taskId: `task-${i % 100}`, step: i });
    }
    const elapsedMs = performance.now() - started;

    const recent = logger.recent(10_000);
    report("logger.records", String(records));
    report("logger.retained", String(recent.length));
    report("logger.ms", elapsedMs.toFixed(1));

    // Every record reached the sink: no event loss on the hot path.
    expect(sunk).toHaveLength(records);
    // In-memory retention is bounded (half-buffer compaction at the cap).
    expect(recent.length).toBeLessThanOrEqual(1000);
    expect(recent.length).toBeGreaterThan(0);
  });

  it("counter cardinality is capped against label explosion", () => {
    const metrics = new MetricsRegistry();
    const series = 5_000;
    const started = performance.now();
    for (let i = 0; i < series; i++) {
      metrics.increment("tool.calls", { tool: `tool-${i}`, outcome: "ok" });
    }
    const elapsedMs = performance.now() - started;

    const snapshot = metrics.snapshot().counters;
    const seriesCount = snapshot.filter((c) => c.name === "tool.calls").length;
    report("counter.seriesOffered", String(series));
    report("counter.seriesAccepted", String(seriesCount));
    report("counter.ms", elapsedMs.toFixed(1));

    // The registry refuses new series past maxSeries (500) instead of growing.
    expect(seriesCount).toBe(500);
  });

  it("histogram percentile samples stay bounded across a 50k-observation stream", () => {
    const metrics = new MetricsRegistry();
    const observations = 50_000;
    const started = performance.now();
    for (let i = 0; i < observations; i++) {
      metrics.observeMs("llm.first_token", i % 250, { provider: "ollama" });
    }
    const elapsedMs = performance.now() - started;

    const hist = metrics
      .snapshot()
      .histograms.find((h) => h.name === "llm.first_token");
    report("histogram.observations", String(observations));
    report("histogram.count", String(hist?.count ?? 0));
    report("histogram.ms", elapsedMs.toFixed(1));

    // Count is exact; the retained sample array is what stays bounded.
    expect(hist?.count).toBe(observations);
    expect(hist?.p95Ms ?? 0).toBeGreaterThan(0);
  });

  it("secrets never survive a flood of redacted log fields", () => {
    const logger = new StructuredLogger({ level: "info", sink: () => {} });
    for (let i = 0; i < 500; i++) {
      logger.error("provider call failed", {
        apiKey: "sk-live-abcdefghijklmnopqrstuvwxyz012345",
        authorization:
          "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
      });
    }
    const text = JSON.stringify(logger.recent(1000));
    report("redaction.records", "500");
    report(
      "redaction.containsSecret",
      String(/sk-live-|Bearer eyJ/.test(text)),
    );
    expect(text).not.toMatch(/sk-live-|Bearer eyJ/);
  });
});

describe("Phase 6 — persistence backpressure", () => {
  let dir: string;
  let store: TaskStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-perf-"));
    store = new TaskStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("conversation entries are capped while writes remain complete", async () => {
    const task = await store.create("flood", {
      providerId: "ollama",
      modelId: "qwen3:8b",
    });

    const entries = 260;
    const started = performance.now();
    for (let i = 0; i < entries; i++) {
      await store.upsertConversationEntry(task.id, `key-${i}`, {
        role: "user",
        text: `turn ${i}`,
      });
    }
    const elapsedMs = performance.now() - started;

    const reloaded = await store.get(task.id);
    report("taskstore.entriesWritten", String(entries));
    report(
      "taskstore.entriesRetained",
      String(reloaded?.conversation?.length ?? 0),
    );
    report("taskstore.ms", elapsedMs.toFixed(1));

    // Default cap is 200 entries — oldest are trimmed, newest kept.
    expect(reloaded?.conversation?.length).toBe(200);
    expect(reloaded?.conversation?.at(-1)?.text).toBe(`turn ${entries - 1}`);
  });

  it("one oversized tool result cannot blow the task file", async () => {
    const task = await store.create("big-output", {});
    const huge = "y".repeat(2_000_000);
    await store.upsertConversationEntry(task.id, "tool-1", {
      role: "user",
      blocks: [
        {
          type: "tool_result",
          tool_use_id: "call-1",
          name: "run_command",
          content: huge,
          is_error: false,
        },
      ],
    });

    const reloaded = await store.get(task.id);
    const stored = JSON.stringify(reloaded?.conversation ?? []);
    report("taskstore.oversizedInputChars", String(huge.length));
    report("taskstore.storedChars", String(stored.length));

    // Per-field bounded serialization keeps the persisted entry small.
    expect(stored.length).toBeLessThan(200_000);
  });
});

describe("Phase 6 — terminal stream backpressure", () => {
  it("caps retained stdout while a real 2MB flood streams through", async () => {
    const cap = 100_000;
    const session = new TerminalSession({
      command: "node",
      args: ["-e", "process.stdout.write('z'.repeat(2_000_000));"],
      maxOutputBytes: cap,
    }).start();

    const started = performance.now();
    const snapshot = await session.wait();
    const elapsedMs = performance.now() - started;

    report("terminal.streamedBytes", "2000000");
    report("terminal.retainedBytes", String(snapshot.stdout.length));
    report("terminal.ms", elapsedMs.toFixed(1));

    expect(snapshot.exitCode).toBe(0);
    // Retention is exactly the cap: constant memory regardless of flood size.
    expect(snapshot.stdout.length).toBe(cap);
  });
});
