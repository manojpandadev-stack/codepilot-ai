/**
 * Runtime per-run observability (deterministic, stubbed provider).
 *
 * Proves: correlation IDs on every event, TTFT capture, enriched
 * RunMetrics (provider/model/mode/iterations/failures/cost), metrics on
 * failed/cancelled settlement, retry accounting, tool-failure counting,
 * and secret redaction in failure paths.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodePilotRuntime, NATIVE_AGENT_ID } from "./runtime.js";
import type { AgentEvent } from "./types.js";
import { stubOllamaFetch, type OllamaStub } from "./ollama-fetch-stub.js";

let stub: OllamaStub | null = null;

afterEach(() => {
  stub?.restore();
  stub = null;
  vi.unstubAllGlobals();
});

function makeRuntime(
  overrides: Partial<ConstructorParameters<typeof CodePilotRuntime>[0]> = {},
): CodePilotRuntime {
  return new CodePilotRuntime({
    workspaceRoot: process.cwd(),
    providerId: "ollama",
    modelId: "qwen3:8b",
    agentMode: "act",
    requestApproval: async () => ({ approved: true }),
    ...overrides,
  });
}

function collect(runtime: CodePilotRuntime): AgentEvent[] {
  const events: AgentEvent[] = [];
  runtime.subscribe((e) => {
    events.push(e);
  });
  return events;
}

describe("run correlation", () => {
  it("stamps runId/agentId/taskId/sessionId on run-scoped events", async () => {
    stub = stubOllamaFetch([{ texts: ["hi."] }]);
    const runtime = makeRuntime();
    const events = collect(runtime);
    try {
      await runtime.initialize();
      const sessionId = await runtime.startSession("hello");
      expect(sessionId).toBeTruthy();
      expect(events.length).toBeGreaterThan(0);
      // Pre-run status events (initialize) legitimately carry no run ids;
      // every run-scoped event carries the full correlation triple.
      for (const e of events) {
        const c = e as { taskId?: string; runId?: string; agentId?: string };
        if (c.taskId === undefined) continue;
        expect(c.runId).toBe(c.taskId);
        expect(c.agentId).toBe(NATIVE_AGENT_ID);
      }
      const completed = events.filter((e) => e.type === "completed");
      expect(completed.length).toBeGreaterThan(0);
      for (const e of completed) {
        const c = e as { taskId?: string; runId?: string; agentId?: string };
        expect(c.taskId).toBeTruthy();
        expect(c.runId).toBe(c.taskId);
        expect(c.agentId).toBe(NATIVE_AGENT_ID);
      }
      expect(NATIVE_AGENT_ID).toBe("codepilot-agent");
    } finally {
      await runtime.dispose();
    }
  });
});

describe("run metrics — success", () => {
  it("records TTFT, provider/model/mode, iterations, usage, and cost", async () => {
    stub = stubOllamaFetch([
      { texts: ["hello there."], usage: { in: 11, out: 7 } },
    ]);
    const runtime = makeRuntime();
    try {
      await runtime.initialize();
      await runtime.startSession("hello");
      const metrics = runtime.getState().lastRunMetrics;
      expect(metrics).toBeDefined();
      expect(metrics?.failed).toBe(false);
      expect(metrics?.cancelled).toBe(false);
      expect(metrics?.providerId).toBe("ollama");
      expect(metrics?.modelId).toBe("qwen3:8b");
      expect(metrics?.agentMode).toBe("act");
      expect(metrics?.runId).toBe(metrics?.taskId);
      expect(metrics?.agentId).toBe("codepilot-agent");
      expect(metrics?.iterations).toBeGreaterThanOrEqual(1);
      expect(metrics?.toolCallCount).toBe(0);
      expect(metrics?.toolFailures).toBe(0);
      expect(metrics?.inputTokens).toBe(11);
      expect(metrics?.outputTokens).toBe(7);
      // First token timing: TTFT present and within the run bounds.
      expect(metrics?.firstTokenAt).toBeGreaterThanOrEqual(
        metrics?.startedAt ?? 0,
      );
      expect(metrics?.timeToFirstTokenMs).toBeGreaterThanOrEqual(0);
      expect(metrics?.timeToFirstTokenMs).toBeLessThanOrEqual(
        metrics?.durationMs ?? Number.MAX_SAFE_INTEGER,
      );
      expect(metrics?.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("carries TTFT on the agent.completed event", async () => {
    stub = stubOllamaFetch([{ texts: ["yo."] }]);
    const runtime = makeRuntime();
    const events = collect(runtime);
    try {
      await runtime.initialize();
      await runtime.startSession("hi");
      const done = events.find((e) => e.type === "agent.completed") as
        { timeToFirstTokenMs?: number } | undefined;
      expect(done).toBeDefined();
      expect(done?.timeToFirstTokenMs).toBeGreaterThanOrEqual(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("stamps tool completions with execution durations", async () => {
    stub = stubOllamaFetch([
      {
        texts: ["reading."],
        toolCalls: [{ name: "read_files", args: { path: "package.json" } }],
      },
      { texts: ["done."] },
    ]);
    const runtime = makeRuntime();
    const events = collect(runtime);
    try {
      await runtime.initialize();
      await runtime.startSession("read the project file");
      const completed = events.filter(
        (e) => e.type === "tool_completed",
      ) as Array<{
        durationMs?: unknown;
        toolName?: string;
      }>;
      expect(completed.length).toBeGreaterThan(0);
      for (const e of completed) {
        expect(typeof e.durationMs).toBe("number");
        expect(e.durationMs as number).toBeGreaterThanOrEqual(0);
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("counts denied tools as failures and reports them", async () => {
    stub = stubOllamaFetch([
      {
        texts: ["trying."],
        toolCalls: [{ name: "bash", args: { command: "echo hi" } }],
      },
      { texts: ["done."] },
    ]);
    const runtime = makeRuntime({
      requestApproval: async () => ({
        approved: false,
        reason: "audit denies everything",
      }),
    });
    const events = collect(runtime);
    try {
      await runtime.initialize();
      await runtime.startSession("run something");
      expect(
        events.filter((e) => e.type === "tool_failed").length,
      ).toBeGreaterThan(0);
      const metrics = runtime.getState().lastRunMetrics;
      expect(metrics?.failed).toBe(false);
      expect(metrics?.toolFailures).toBeGreaterThanOrEqual(1);
      expect(metrics?.toolCallCount).toBeGreaterThanOrEqual(1);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("run metrics — failure and retry", () => {
  it("records failed runs with retry accounting", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(
          typeof input === "string" ? input : (input as Request).url,
        );
        if (!url.includes("/api/chat")) {
          return new Response("not found", { status: 404 });
        }
        calls += 1;
        if (calls === 1)
          throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
        return new Response("boom", { status: 500 });
      }) as unknown as typeof fetch,
    );
    const runtime = makeRuntime({ maxRetries: 1 });
    const events = collect(runtime);
    try {
      await runtime.initialize();
      await expect(runtime.startSession("hi")).rejects.toThrow();
      expect(
        events.filter((e) => e.type === "agent.retry").length,
      ).toBeGreaterThanOrEqual(1);
      expect(events.some((e) => e.type === "agent.failed")).toBe(true);
      const metrics = runtime.getState().lastRunMetrics;
      expect(metrics?.failed).toBe(true);
      expect(metrics?.cancelled).toBe(false);
      expect(metrics?.retriesConsumed).toBeGreaterThanOrEqual(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("redacts secret-shaped text in failure events", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(
          "connect failed with key sk-live-9999888877776666 at host",
        );
      }) as unknown as typeof fetch,
    );
    const runtime = makeRuntime({ maxRetries: 0 });
    const events = collect(runtime);
    try {
      await runtime.initialize();
      await expect(runtime.startSession("hi")).rejects.toThrow();
      const failed = events.find((e) => e.type === "agent.failed") as
        { error?: { message?: string; technicalDetail?: string } } | undefined;
      expect(failed).toBeDefined();
      const wire = JSON.stringify(failed?.error ?? {});
      expect(wire).not.toContain("sk-live-9999888877776666");
      expect(wire).toContain("[REDACTED]");
      expect(runtime.getState().lastError ?? "").not.toContain(
        "sk-live-9999888877776666",
      );
    } finally {
      await runtime.dispose();
    }
  });
});

describe("run metrics — cancellation", () => {
  it("records cancelled runs with metrics", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          }),
      ) as unknown as typeof fetch,
    );
    const runtime = makeRuntime();
    const events = collect(runtime);
    try {
      await runtime.initialize();
      const run = runtime.startSession("long task");
      const deadline = Date.now() + 15_000;
      while (
        (runtime.getState().status as string) !== "running" &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(runtime.getState().status as string).toBe("running");
      await runtime.abort();
      await run.catch(() => undefined);
      expect(events.some((e) => e.type === "cancelled")).toBe(true);
      const metrics = runtime.getState().lastRunMetrics;
      expect(metrics?.cancelled).toBe(true);
      expect(metrics?.failed).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });
});
