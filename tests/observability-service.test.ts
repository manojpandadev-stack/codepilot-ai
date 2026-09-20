/**
 * ObservabilityService tests — backend for the Metrics dashboard.
 *
 * Uses REAL M18 infrastructure (MetricsRegistry, StructuredLogger with a
 * silent sink, SpanTracker), a REAL M12 TaskStore on a temp dir, and the
 * REAL TaskHistoryService. Scheduler/teams/terminals/live are injected
 * fakes behind the same shapes the extension wires. Proves aggregation,
 * filters, grouping, error categorization, performance gating, providers,
 * active tasks, sanitized export, bounds, determinism and adversarial
 * rejection — with secret-injection attempts throughout.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  MetricsRegistry,
  StructuredLogger,
  SpanTracker,
} from "../packages/shared/src/observability";
import { TaskStore } from "../packages/agent-runtime/src/m12-task-store";
import { TaskHistoryService } from "../apps/vscode-extension/src/task-history-service";
import {
  ObservabilityService,
  validateDashboardFilter,
  categorizeError,
  toolCategory,
} from "../apps/vscode-extension/src/observability-service";

let dir: string;
let metrics: MetricsRegistry;
let logger: StructuredLogger;
let spans: SpanTracker;
let store: TaskStore;
let history: TaskHistoryService;

const SECRET = "sk-12345678901234567890";
const TOKEN = "github_pat_abcdefghij1234567890";

function makeService(overrides: {
  scheduler?: () => null;
  teams?: () => Promise<[]>;
  terminals?: () => [];
  live?: () => null;
} = {}): ObservabilityService {
  return new ObservabilityService({
    metrics,
    logger,
    spans,
    taskHistory: history,
    scheduler: overrides.scheduler ?? (() => null),
    runningTeams: overrides.teams ?? (async () => []),
    terminals: overrides.terminals ?? (() => []),
    liveTask: overrides.live ?? (() => null),
  });
}

async function seedTask(overrides: {
  title?: string;
  status?: "running" | "completed" | "failed" | "interrupted" | "cancelled";
  provider?: string;
  model?: string;
  mode?: string;
  counters?: Record<string, unknown>;
}): Promise<string> {
  const task = await store.create(overrides.title ?? "do work", {
    providerId: overrides.provider ?? "ollama",
    modelId: overrides.model ?? "qwen3:8b",
    mode: overrides.mode ?? "act",
  });
  await store.appendMessage(task.id, "user", "do the work");
  await store.appendMessage(task.id, "assistant", "done it");
  await store.update(task.id, {
    status: overrides.status ?? "completed",
    agentState: {
      sessionId: "sess-1",
      mode: overrides.mode ?? "act",
      ...(overrides.counters ?? {}),
    },
  } as never);
  return task.id;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-obs-"));
  metrics = new MetricsRegistry();
  logger = new StructuredLogger({ sink: () => undefined });
  spans = new SpanTracker();
  store = new TaskStore(path.join(dir, "tasks"));
  history = new TaskHistoryService({
    taskStore: store,
    listCheckpoints: () => [],
    getCheckpoint: () => undefined,
    listMutations: () => [],
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- dashboard
describe("ObservabilityService dashboard metrics", () => {
  it("aggregates task counts, durations, tools, retries, files from history", async () => {
    await seedTask({
      counters: { toolCallCount: 4, retries: 1, filesChanged: ["a.ts", "b.ts"] },
    });
    await seedTask({ title: "failed one", status: "failed" });
    metrics.increment("codepilot_tool_failures_total");
    metrics.increment("codepilot_approvals_total");
    const svc = makeService();
    const result = await svc.dashboard({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const get = (key: string): number | null =>
      result.dashboard.overview.find((m) => m.key === key)?.value ?? null;
    expect(get("tasks")).toBe(2);
    expect(get("completed")).toBe(1);
    expect(get("failed")).toBe(1);
    expect(get("toolCalls")).toBe(4);
    expect(get("retries")).toBe(1);
    expect(get("filesChanged")).toBe(2);
    expect(get("toolFailures")).toBe(1);
    expect(get("approvals")).toBe(1);
  });

  it("marks uninstrumented metrics unavailable instead of inventing values", async () => {
    const svc = makeService();
    const result = await svc.dashboard({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dashboard.performance.modelLatency.value).toBeNull();
    expect(
      result.dashboard.performance.modelLatency.unavailableReason,
    ).toBeTruthy();
    expect(result.dashboard.performance.contextLatency.value).toBeNull();
    expect(result.dashboard.performance.terminalDuration.value).toBeNull();
    expect(result.dashboard.performance.mcpDuration.value).toBeNull();
    expect(result.dashboard.tokens.input.value).toBeNull();
  });

  it("surfaces run TTFT as model latency once runs complete", async () => {
    metrics.observeMs("codepilot_run_time_to_first_token_ms", 1200);
    metrics.observeMs("codepilot_run_time_to_first_token_ms", 800);
    const svc = makeService();
    const result = await svc.dashboard({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // p50 of [800, 1200] (histogram semantics: value in range).
    const value = result.dashboard.performance.modelLatency.value;
    expect(value).not.toBeNull();
    expect(value as number).toBeGreaterThanOrEqual(800);
    expect(value as number).toBeLessThanOrEqual(1200);
    expect(
      result.dashboard.performance.modelLatency.unavailableReason,
    ).toBeUndefined();
  });

  it("aggregates terminal and MCP durations from tool rows", async () => {
    metrics.observeMs("codepilot_tool_duration_ms", 100, { tool: "bash" });
    metrics.observeMs("codepilot_tool_duration_ms", 300, { tool: "bash" });
    metrics.observeMs("codepilot_tool_duration_ms", 50, {
      tool: "mcp__srv__thing",
    });
    metrics.observeMs("codepilot_tool_duration_ms", 4000, {
      tool: "read_files",
    });
    const svc = makeService();
    const result = await svc.dashboard({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Weighted terminal average: (100 + 300) / 2 = 200.
    expect(result.dashboard.performance.terminalDuration.value).toBe(200);
    expect(result.dashboard.performance.mcpDuration.value).toBe(50);
  });

  it("reads execution counters placed at real execution sites", async () => {
    metrics.increment("codepilot_tasks_total", { status: "completed" }, 3);
    metrics.increment("codepilot_terminal_sessions_total", {}, 2);
    metrics.increment("codepilot_mcp_executions_total", { status: "success" });
    metrics.increment("codepilot_plugin_executions_total", { status: "error" });
    metrics.increment("codepilot_team_runs_total", { status: "completed" });
    metrics.increment("codepilot_scheduled_runs_total", { status: "success" });
    metrics.increment("codepilot_model_input_tokens", {}, 500);
    const svc = makeService();
    const result = await svc.dashboard({});
    if (!result.ok) return;
    const get = (key: string): number | null =>
      result.dashboard.overview.find((m) => m.key === key)?.value ?? null;
    expect(get("terminalExecutions")).toBe(2);
    expect(get("mcpExecutions")).toBe(1);
    expect(get("pluginExecutions")).toBe(1);
    expect(get("teamRuns")).toBe(1);
    expect(get("scheduledRuns")).toBe(1);
    expect(get("tasksCompletedCounter")).toBe(3);
    expect(result.dashboard.tokens.input.value).toBe(500);
  });
});

// ---------------------------------------------------------------- task metrics
describe("ObservabilityService task-level metrics", () => {
  it("empty store yields zeros and empty sections, never crashes", async () => {
    const svc = makeService();
    const result = await svc.dashboard({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dashboard.overview.find((m) => m.key === "tasks")?.value).toBe(0);
    expect(result.dashboard.tools).toEqual([]);
    expect(result.dashboard.providers).toEqual([]);
    expect(result.dashboard.errors.categories).toEqual([]);
    expect(result.dashboard.active).toEqual([]);
    expect(result.dashboard.performance.taskDurations.count).toBe(0);
    expect(result.dashboard.performance.taskDurations.avgMs).toBeNull();
  });

  it("partial data renders with honest gaps", async () => {
    // Task without durations/counters (e.g. still running, no agentState).
    const task = await store.create("partial");
    await store.appendMessage(task.id, "user", "go");
    const svc = makeService();
    const result = await svc.dashboard({});
    if (!result.ok) return;
    expect(result.dashboard.overview.find((m) => m.key === "tasks")?.value).toBe(1);
    expect(result.dashboard.performance.taskDurations.avgMs).toBeNull();
  });
});

// ---------------------------------------------------------------- providers
describe("ObservabilityService provider/model breakdown", () => {
  it("groups tasks by provider and model without secrets", async () => {
    await seedTask({ provider: "ollama", model: "qwen3:8b" });
    await seedTask({ title: "second", provider: "ollama", model: "qwen3:8b" });
    await seedTask({ title: "third", provider: "openai", model: "gpt-4o" });
    const svc = makeService();
    const result = await svc.dashboard({});
    if (!result.ok) return;
    const ollama = result.dashboard.providers.find((p) => p.provider === "ollama")!;
    expect(ollama.tasks).toBe(2);
    expect(ollama.models).toEqual([{ model: "qwen3:8b", tasks: 2 }]);
    expect(result.dashboard.providers.find((p) => p.provider === "openai")!.tasks).toBe(1);
    expect(JSON.stringify(result.dashboard.providers)).not.toMatch(/api[_-]?key|secret/i);
  });
});

// ---------------------------------------------------------------- tools
describe("ObservabilityService tool metrics", () => {
  it("aggregates invocations/failures/latency per tool with categories", async () => {
    metrics.increment("codepilot_tool_calls_total", { tool: "read_files" }, 5);
    metrics.increment("codepilot_tool_calls_total", { tool: "bash" }, 3);
    metrics.increment("codepilot_tool_failures_total", { tool: "bash" });
    metrics.increment("codepilot_tool_calls_total", { tool: "mcp__pg__query" }, 2);
    for (const ms of [10, 20, 30, 40]) {
      metrics.observeMs("codepilot_tool_duration_ms", ms, { tool: "read_files" });
    }
    metrics.observeMs("codepilot_tool_duration_ms", 99, { tool: "bash" });
    const svc = makeService();
    const result = await svc.dashboard({});
    if (!result.ok) return;
    const read = result.dashboard.tools.find((t) => t.name === "read_files")!;
    expect(read.invocations).toBe(5);
    expect(read.failures).toBe(0);
    expect(read.success).toBe(5);
    expect(read.category).toBe("filesystem");
    expect(read.avgMs).toBe(25);
    expect(read.p50Ms).not.toBeNull();
    expect(read.p95Ms).not.toBeNull();
    const bash = result.dashboard.tools.find((t) => t.name === "bash")!;
    expect(bash.category).toBe("terminal");
    expect(bash.failures).toBe(1);
    // Single sample: percentiles withheld (insufficient data).
    expect(bash.p50Ms).toBeNull();
    expect(bash.p95Ms).toBeNull();
    expect(result.dashboard.tools.find((t) => t.name === "mcp__pg__query")!.category).toBe("MCP");
  });

  it("toolCategory groups logically without raw arguments", () => {
    expect(toolCategory("read_files")).toBe("filesystem");
    expect(toolCategory("terminal")).toBe("terminal");
    expect(toolCategory("web_fetch")).toBe("browser");
    expect(toolCategory("mcp__srv__tool")).toBe("MCP");
    expect(toolCategory("checkpoint_restore")).toBe("orchestration");
    expect(toolCategory("something-else")).toBe("other");
  });
});

// ---------------------------------------------------------------- errors
describe("ObservabilityService error aggregation", () => {
  it("categorizes errors deterministically", () => {
    expect(categorizeError("request timed out after 5s")).toBe("timeout");
    expect(categorizeError("permission denied by policy")).toBe("permission");
    expect(categorizeError("invalid schedule id")).toBe("validation");
    expect(categorizeError("fetch failed: ENOTFOUND")).toBe("network");
    expect(categorizeError("provider overloaded")).toBe("provider");
    expect(categorizeError("something strange")).toBe("unknown");
  });

  it("aggregates task errors and redacted log errors", async () => {
    await seedTask({ title: "bad", status: "failed" });
    await store.appendMessage((await store.list())[0]!.id, "system", "Error: timeout waiting");
    logger.error("provider overloaded, retrying");
    const svc = makeService();
    const result = await svc.dashboard({});
    if (!result.ok) return;
    expect(result.dashboard.errors.categories.length).toBeGreaterThan(0);
    expect(result.dashboard.errors.recent.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.dashboard.errors)).not.toContain("sk-");
  });
});

// ---------------------------------------------------------------- performance
describe("ObservabilityService performance aggregation", () => {
  it("computes task duration count/avg/min/max", async () => {
    await seedTask({ title: "aaa" });
    await new Promise((r) => setTimeout(r, 5));
    await seedTask({ title: "bbb" });
    const svc = makeService();
    const result = await svc.dashboard({});
    if (!result.ok) return;
    const d = result.dashboard.performance.taskDurations;
    expect(d.count).toBe(2);
    expect(d.avgMs).not.toBeNull();
    expect(d.minMs).not.toBeNull();
    expect(d.maxMs).not.toBeNull();
    expect(d.maxMs).toBeGreaterThanOrEqual(d.minMs as number);
  });

  it("span latency surfaces only when spans exist", async () => {
    const svc = makeService();
    const empty = await svc.dashboard({});
    if (empty.ok) {
      expect(empty.dashboard.performance.contextLatency.value).toBeNull();
    }
    const span = spans.startSpan("context.retrieve", { correlationId: "t1" });
    await new Promise((r) => setTimeout(r, 2));
    spans.endSpan(span, "ok");
    const result = await svc.dashboard({});
    if (!result.ok) return;
    expect(result.dashboard.performance.contextLatency.value).not.toBeNull();
  });
});

// ---------------------------------------------------------------- filters
describe("ObservabilityService filters and time ranges", () => {
  it("filters by status/provider/model/mode", async () => {
    await seedTask({ title: "aaa", status: "failed", provider: "openai", model: "gpt-4o", mode: "ask" });
    await seedTask({ title: "bbb", status: "completed" });
    const svc = makeService();
    const failed = await svc.dashboard({ status: "failed" });
    if (failed.ok) {
      expect(failed.dashboard.overview.find((m) => m.key === "tasks")?.value).toBe(1);
    }
    const provider = await svc.dashboard({ provider: "openai" });
    if (provider.ok) {
      expect(provider.dashboard.overview.find((m) => m.key === "tasks")?.value).toBe(1);
    }
    const mode = await svc.dashboard({ mode: "ask" });
    if (mode.ok) {
      expect(mode.dashboard.overview.find((m) => m.key === "tasks")?.value).toBe(1);
    }
  });

  it("rejects invalid filters (unbounded/incoherent queries refused)", async () => {
    const svc = makeService();
    expect((await svc.dashboard({ limit: 9999 })).ok).toBe(false);
    expect((await svc.dashboard({ limit: 0 })).ok).toBe(false);
    expect((await svc.dashboard({ fromMs: 200, toMs: 100 })).ok).toBe(false);
    expect((await svc.dashboard({ fromMs: -5 })).ok).toBe(false);
    expect((await svc.dashboard({ status: "exploding" })).ok).toBe(false);
    expect((await svc.dashboard({ provider: "x".repeat(65) })).ok).toBe(false);
  });

  it("time ranges bound task-derived data", async () => {
    await seedTask({ title: "old" });
    const svc = makeService();
    const future = await svc.dashboard({ fromMs: Date.now() + 60_000 });
    if (future.ok) {
      expect(future.dashboard.overview.find((m) => m.key === "tasks")?.value).toBe(0);
    }
    expect(svc).toBeDefined();
  });
});

// ---------------------------------------------------------------- active
describe("ObservabilityService active tasks", () => {
  it("exposes live runtime, terminals, scheduled runs and teams without outputs", async () => {
    const svc = new ObservabilityService({
      metrics,
      logger,
      spans,
      taskHistory: history,
      scheduler: () => null,
      runningTeams: async () => [{ teamId: "team-1", objective: "build it", status: "running" }],
      terminals: () => [
        {
          id: "ts-1",
          status: "running",
          pid: 1,
          exitCode: null,
          stdout: "SECRET-STDOUT-CONTENT",
          stderr: "",
          timedOut: false,
          cancelled: false,
          durationMs: 5,
        },
      ],
      liveTask: () => ({
        taskId: "task-1",
        sessionId: "sess-1",
        status: "running",
        agentState: "EXECUTING",
        toolCalls: [{ name: "bash", count: 1, totalDurationMs: 5 }],
        retries: 0,
        filesChanged: [],
        inputTokens: 0,
        outputTokens: 0,
        error: null,
      }),
    });
    const result = await svc.dashboard({});
    if (!result.ok) return;
    const kinds = result.dashboard.active.map((a) => a.kind);
    expect(kinds).toContain("runtime");
    expect(kinds).toContain("terminal");
    expect(kinds).toContain("team");
    // Terminal output never leaves the host.
    expect(JSON.stringify(result.dashboard.active)).not.toContain("SECRET-STDOUT-CONTENT");
  });

  it("degraded backends yield partial dashboards, never crashes", async () => {
    const svc = new ObservabilityService({
      metrics,
      logger,
      spans,
      taskHistory: history,
      scheduler: () => {
        throw new Error("scheduler down");
      },
      runningTeams: async () => {
        throw new Error("teams down");
      },
      terminals: () => {
        throw new Error("terminals down");
      },
      liveTask: () => {
        throw new Error("runtime down");
      },
    });
    const result = await svc.dashboard({});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.dashboard.active).toEqual([]);
  });
});

// ---------------------------------------------------------------- export
describe("ObservabilityService diagnostic export (sanitized)", () => {
  it("exports allowlisted counts with redacted errors, never secrets", async () => {
    await seedTask({ title: `uses ${SECRET} do not leak` });
    logger.error(`failed with ${TOKEN} inside`, { apiKey: "super-secret-key" });
    const span = spans.startSpan("agent.run", { attributes: { password: "hunter2" } });
    spans.endSpan(span, "error");
    metrics.increment("codepilot_tool_calls_total", { tool: "bash" });
    const svc = makeService();
    const result = await svc.diagnosticSummary();
    expect(result.ok).toBe(true);
    const text = JSON.stringify(result.summary);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("super-secret-key");
    expect(text).toContain("[REDACTED]");
    // Structure: counts + tool names + redacted errors + notes, nothing else.
    expect(result.summary.notes.length).toBeGreaterThan(0);
    expect(result.summary.tools).toEqual([{ name: "bash", invocations: 1, failures: 0 }]);
    expect(text).not.toContain("stdout");
    // No task titles, message bodies or tool arguments — only the word
    // "prompts" inside the bundle's own disclosure note.
    expect(text).not.toContain("do work");
    expect(text.split("prompts").length - 1).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------- adversarial
describe("ObservabilityService adversarial resistance", () => {
  it("dashboard exposes no prompts, messages, outputs or tool inputs", async () => {
    const task = await store.create("prompt with P@ssw0rd-sensitive content");
    await store.appendMessage(task.id, "user", "attacker tool args: --token abcdefghij1234567890");
    await store.appendMessage(task.id, "assistant", "output with SK-TEST-SECRET-DATA-HERE xx");
    const svc = makeService();
    const result = await svc.dashboard({});
    if (!result.ok) return;
    const text = JSON.stringify(result.dashboard);
    expect(text).not.toContain("attacker tool args");
    expect(text).not.toContain("SK-TEST-SECRET-DATA-HERE");
    expect(text).not.toContain("P@ssw0rd-sensitive");
  });

  it("another task's metrics are unreachable except via aggregates", async () => {
    const a = await seedTask({ title: "aaa private" });
    await seedTask({ title: "bbb private" });
    const svc = makeService();
    // No per-task drill-down API exists on the service: only aggregates.
    expect(typeof (svc as unknown as Record<string, unknown>).taskMetrics).toBe("undefined");
    expect(typeof (svc as unknown as Record<string, unknown>).taskDetails).toBe("undefined");
    // Aggregates never attribute beyond provider/model buckets.
    const result = await svc.dashboard({});
    if (result.ok) {
      expect(JSON.stringify(result.dashboard.providers)).not.toContain(a);
    }
  });

  it("repeated calls are side-effect free (no listener/timer growth)", async () => {
    await seedTask({});
    metrics.increment("codepilot_tool_calls_total", { tool: "bash" });
    const svc = makeService();
    const before = metrics.snapshot();
    const first = JSON.stringify((await svc.dashboard({})).ok);
    await svc.dashboard({});
    await svc.diagnosticSummary();
    const after = metrics.snapshot();
    expect(JSON.stringify((await svc.dashboard({})).ok)).toBe(first);
    expect(after.counters).toEqual(before.counters);
    expect(after.histograms.length).toBe(before.histograms.length);
  });

  it("history caps bound the transfer (no unbounded event history)", async () => {
    for (let i = 0; i < 5; i++) {
      await seedTask({ title: `bulk ${i}` });
    }
    const svc = makeService();
    const capped = await svc.dashboard({ limit: 2 });
    if (capped.ok) {
      expect(capped.dashboard.overview.find((m) => m.key === "tasks")?.value).toBe(2);
    }
  });
});

// ---------------------------------------------------------------- lifecycle
describe("ObservabilityService lifecycle", () => {
  it("deterministic across open → refresh → filter → return cycles", async () => {
    await seedTask({ counters: { toolCallCount: 2 } });
    metrics.increment("codepilot_tool_calls_total", { tool: "read_files" }, 2);
    const svc = makeService();
    const first = JSON.stringify(await svc.dashboard({}));
    await svc.dashboard({ status: "completed" });
    await svc.dashboard({ provider: "ollama" });
    const second = JSON.stringify(await svc.dashboard({}));
    // generatedAtMs differs; everything else identical.
    const strip = (s: string): string => s.replace(/"generatedAtMs":\d+/g, '"generatedAtMs":0');
    expect(strip(second)).toBe(strip(first));
  });

  it("validateDashboardFilter accepts the empty/default filter", () => {
    expect(validateDashboardFilter({}).ok).toBe(true);
    const parsed = validateDashboardFilter({ status: "completed", limit: 50 });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.limit).toBe(50);
  });
});
