/**
 * Phase 2 — structured plan + pause/resume integration (REAL host pipeline).
 *
 * Drives the actual extension module through the integration seams:
 *   - `agent.plan_created` / `agent.plan_updated` flow through the REAL
 *     `forwardAgentEvent` → persist (TaskStore.plan, per-task queue) and
 *     fan out `plan/updated` to the WebView sink;
 *   - `agent/pause` sets pause intent and records the task PAUSED (resume-
 *     ready, never running) via the REAL stop/reconcile path;
 *   - a later `cancelled` event agrees with that intent instead of
 *     overwriting it with `interrupted` (intent is NOT consumed);
 *   - a plain `cancelled` with no intent stays `interrupted`;
 *   - explicit `agent/stop` drops the intent (a stop is never a pause);
 *   - paused + plan survive an extension restart (reopenHost);
 *   - `history/resume` rehydrates the plan into the runtime, pushes
 *     `plan/updated`, and clears the pause (status leaves `paused`).
 *
 * Deterministic: no network (stubOllamaFetch for the resume leg), no React.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  freshHost,
  reopenHost,
  sleep,
  DEBOUNCE_WAIT_MS,
  type FreshHost,
} from "./vscode-integration-harness";
import { TaskStore } from "../packages/agent-runtime/src/m12-task-store";
import { createTaskPlan } from "../packages/agent-runtime/src/task-plan";
import type { TaskPlan } from "../packages/agent-runtime/src/task-plan";
import type { AgentEvent } from "../packages/agent-runtime/src/types";
import { stubOllamaFetch } from "../packages/agent-runtime/src/ollama-fetch-stub";

interface CapturedMessage {
  type: string;
  payload?: Record<string, unknown>;
}

type CapturedHost = FreshHost & { captured: CapturedMessage[] };

function planMessages(host: CapturedHost): CapturedMessage[] {
  return host.captured.filter((m) => m.type === "plan/updated");
}

async function hostWithCapture(): Promise<CapturedHost> {
  const host = await freshHost();
  const captured: CapturedMessage[] = [];
  host.ext.__setWebviewSinkForIntegrationTest((m) => {
    captured.push(m as CapturedMessage);
  });
  return Object.assign(host, { captured });
}

async function send(
  host: FreshHost,
  type: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await host.seams.handleMessage({
    type: type as never,
    id: `plan-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    payload,
    timestamp: Date.now(),
  } as never);
}

async function teardown(host: CapturedHost): Promise<void> {
  host.ext.__clearWebviewSinkForIntegrationTest();
  await host.ext.deactivate().catch(() => {});
  host.cleanup();
}

function samplePlan(objective: string): TaskPlan {
  return createTaskPlan(
    {
      objective,
      steps: [
        { title: "inspect the code" },
        { title: "apply the change" },
        { title: "run the tests", dependsOn: ["step-2"] },
      ],
    },
    Date.now(),
  );
}

const hosts: CapturedHost[] = [];

async function trackedHost(): Promise<CapturedHost> {
  const host = await hostWithCapture();
  hosts.push(host);
  return host;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  while (hosts.length > 0) {
    const host = hosts.pop()!;
    await teardown(host).catch(() => {});
  }
});

describe("plan events → persistence + WebView fan-out", () => {
  it("agent.plan_created persists the plan and pushes plan/updated", async () => {
    const host = await trackedHost();
    const taskId = await host.seams.beginTask("plan persistence");
    expect(taskId).not.toBeNull();

    const plan = samplePlan("Ship the release");
    host.seams.ingestAgentEvent({
      type: "agent.plan_created",
      plan: JSON.stringify(plan),
      stepsCount: plan.steps.length,
      taskPlan: plan,
    } as AgentEvent);

    // Fan-out is immediate (direct postMessage); persistence is queued.
    const pushed = planMessages(host);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.payload).toMatchObject({ plan });
    // The host always pairs the plan with a request correlation key.
    expect("requestId" in pushed[0]!.payload!).toBe(true);

    await host.seams.drainPersistence(taskId!);
    const stored = await new TaskStore(host.tasksDir).get(taskId!);
    expect(stored?.plan?.objective).toBe("Ship the release");
    expect(stored?.plan?.steps.map((s) => s.title)).toEqual([
      "inspect the code",
      "apply the change",
      "run the tests",
    ]);
  });

  it("agent.plan_updated overwrites the persisted plan and re-pushes", async () => {
    const host = await trackedHost();
    const taskId = await host.seams.beginTask("plan update flow");

    const plan = samplePlan("First objective");
    host.seams.ingestAgentEvent({
      type: "agent.plan_created",
      plan: JSON.stringify(plan),
      stepsCount: plan.steps.length,
      taskPlan: plan,
    } as AgentEvent);

    const advanced = createTaskPlan(
      { objective: "Second objective", steps: [{ title: "only step" }] },
      Date.now(),
    );
    host.seams.ingestAgentEvent({
      type: "agent.plan_updated",
      taskPlan: advanced,
    } as AgentEvent);

    await host.seams.drainPersistence(taskId!);
    const stored = await new TaskStore(host.tasksDir).get(taskId!);
    expect(stored?.plan?.objective).toBe("Second objective");
    expect(stored?.plan?.steps).toHaveLength(1);
    const pushed = planMessages(host);
    expect(pushed).toHaveLength(2);
    expect((pushed[1]!.payload!.plan as TaskPlan).objective).toBe(
      "Second objective",
    );
  });
});

describe("agent/pause → paused status", () => {
  it("pauses the running task (status paused, lastStep task_paused) and keeps the plan", async () => {
    const host = await trackedHost();
    const taskId = await host.seams.beginTask("pause me");
    const plan = samplePlan("Pausable work");
    host.seams.ingestAgentEvent({
      type: "agent.plan_created",
      plan: JSON.stringify(plan),
      stepsCount: plan.steps.length,
      taskPlan: plan,
    } as AgentEvent);
    await host.seams.drainPersistence(taskId!);

    await send(host, "agent/pause");
    await sleep(50);
    await host.seams.drainPersistence(taskId!);

    const stored = await new TaskStore(host.tasksDir).get(taskId!);
    expect(stored?.status).toBe("paused");
    expect(stored?.lastStep).toBe("task_paused");
    expect(stored?.plan?.objective).toBe("Pausable work");
    expect(host.seams.getActiveTaskId()).toBe(taskId);
  });

  it("a later cancelled event AGREES with the pause (intent not consumed)", async () => {
    const host = await trackedHost();
    const taskId = await host.seams.beginTask("pause then cancel");
    await send(host, "agent/pause");
    // The aborted run's terminal event arrives afterwards — exactly the
    // race the pause intent exists for.
    host.seams.ingestAgentEvent({ type: "cancelled" } as AgentEvent);
    await sleep(DEBOUNCE_WAIT_MS);
    await host.seams.drainPersistence(taskId!);

    const stored = await new TaskStore(host.tasksDir).get(taskId!);
    expect(stored?.status).toBe("paused");
    expect(stored?.lastStep).toBe("task_paused");
  });

  it("without pause intent a cancelled event stays interrupted", async () => {
    const host = await trackedHost();
    const taskId = await host.seams.beginTask("plain cancel");
    host.seams.ingestAgentEvent({ type: "cancelled" } as AgentEvent);
    await sleep(DEBOUNCE_WAIT_MS);
    await host.seams.drainPersistence(taskId!);

    const stored = await new TaskStore(host.tasksDir).get(taskId!);
    expect(stored?.status).toBe("interrupted");
    expect(stored?.lastStep).toBe("run_interrupted");
  });

  it("explicit agent/stop after a pause keeps the task paused but drops the intent", async () => {
    const host = await trackedHost();
    const taskId = await host.seams.beginTask("pause then stop");
    await send(host, "agent/pause");
    await send(host, "agent/stop"); // clears pause intent, reconcile no-ops
    await sleep(50);
    // Stopping already-paused must not disturb the record...
    let stored = await new TaskStore(host.tasksDir).get(taskId!);
    expect(stored?.status).toBe("paused");

    // ...but with the intent dropped, a subsequent cancel is a real cancel.
    host.seams.ingestAgentEvent({ type: "cancelled" } as AgentEvent);
    await sleep(DEBOUNCE_WAIT_MS);
    await host.seams.drainPersistence(taskId!);
    stored = await new TaskStore(host.tasksDir).get(taskId!);
    expect(stored?.status).toBe("interrupted");
  });
});

describe("pause across restart and resume", () => {
  it("paused status and plan survive an extension restart", async () => {
    const host = await trackedHost();
    const storageDir = host.storageDir;
    const taskId = await host.seams.beginTask("persist across restart");
    const plan = samplePlan("Survives restarts");
    host.seams.ingestAgentEvent({
      type: "agent.plan_created",
      plan: JSON.stringify(plan),
      stepsCount: plan.steps.length,
      taskPlan: plan,
    } as AgentEvent);
    await host.seams.drainPersistence(taskId!);
    await send(host, "agent/pause");
    await sleep(50);

    host.ext.__clearWebviewSinkForIntegrationTest();
    await host.ext.deactivate().catch(() => {});

    const reopened = await reopenHost(storageDir);
    try {
      const store = new TaskStore(reopened.tasksDir);
      const stored = await store.get(taskId!);
      expect(stored?.status).toBe("paused");
      expect(stored?.lastStep).toBe("task_paused");
      expect(stored?.plan?.objective).toBe("Survives restarts");
      // Startup recovery must NOT rewrite paused → interrupted.
      expect(await store.markInterruptedOnStartup()).toBe(0);
      expect((await store.get(taskId!))?.status).toBe("paused");
    } finally {
      await reopened.ext.deactivate().catch(() => {});
    }
  });

  it("history/resume rehydrates the plan, pushes plan/updated, and leaves paused", async () => {
    stubOllamaFetch([{ texts: ["resumed turn done."] }]);
    const host = await trackedHost();
    const taskId = await host.seams.beginTask("resume with plan");
    const plan = samplePlan("Resume keeps this plan");
    host.seams.ingestAgentEvent({
      type: "agent.plan_created",
      plan: JSON.stringify(plan),
      stepsCount: plan.steps.length,
      taskPlan: plan,
    } as AgentEvent);
    await host.seams.drainPersistence(taskId!);
    await send(host, "agent/pause");
    await sleep(50);

    await host.seams.ensureRuntime();
    await send(host, "history/resume", { taskId: taskId! });
    await sleep(DEBOUNCE_WAIT_MS);
    await host.seams.drainPersistence(taskId!);

    const stored = await new TaskStore(host.tasksDir).get(taskId!);
    // The pause was consumed: the task is live again (running or already
    // finished), never paused — and the plan is still attached.
    expect(stored?.status).not.toBe("paused");
    expect(["running", "completed"]).toContain(stored?.status);
    expect(stored?.plan?.objective).toBe("Resume keeps this plan");

    // Resume always pushes the plan (null clears a stale stepper; ours is not).
    const pushed = planMessages(host);
    expect(pushed.length).toBeGreaterThanOrEqual(1);
    const last = pushed[pushed.length - 1]!.payload!.plan as TaskPlan | null;
    expect(last?.objective).toBe("Resume keeps this plan");

    const results = host.captured.filter((m) => m.type === "history/result");
    expect(results.at(-1)?.payload).toMatchObject({
      success: true,
      action: "resume",
      taskId: taskId,
    });
  });
});
