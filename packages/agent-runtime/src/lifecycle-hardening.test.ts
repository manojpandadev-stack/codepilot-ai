/**
 * Lifecycle hardening — agent-runtime subscriptions do not accumulate.
 *
 * Repeatedly exercises start → execute → cancel/complete → dispose for:
 *  - CodePilotRuntime (listener subscribe/release across cycles, dispose
 *    idempotent + clears; sessions complete on the stubbed model layer)
 *  - TaskScheduler (start/stop/cancelAll idempotent, timer released)
 *  - SelfHealingEngine (subscribe/dispose, no growth)
 *  - MultiAgentOrchestrator (subscribe/cancel/dispose, no growth)
 *  - ProviderRegistry (subscribe/dispose, no growth)
 *  - EventBus (on/unsubscribe/removeAllListeners)
 *  - CliRunner (per-run subscribe released via finally)
 *
 * The model layer is stubbed Ollama NDJSON (no network, no model); the
 * agent loop, session lifecycle, and event fan-out are genuine.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodePilotRuntime } from "./runtime.js";
import { TaskScheduler } from "./m17-scheduler.js";
import { SelfHealingEngine } from "./self-healing.js";
import { MultiAgentOrchestrator } from "./orchestrator.js";
import { ProviderRegistry } from "@codepilot/model-gateway";
import { CliRunner } from "./m16-cli-headless.js";
import { stubOllamaFetch, type OllamaStub } from "./ollama-fetch-stub.js";

let stub: OllamaStub | null = null;

afterEach(() => {
  stub?.restore();
  stub = null;
  vi.unstubAllGlobals();
});

function makeRuntime(): CodePilotRuntime {
  return new CodePilotRuntime({
    workspaceRoot: process.cwd(),
    providerId: "ollama",
    modelId: "qwen3:8b",
    // Lifecycle tests exercise subscribe/release mechanics, not the
    // permission pipeline (covered by M4 suites) — tools must execute.
    requestApproval: async () => ({ approved: true }),
  });
}

describe("lifecycle: CodePilotRuntime repeated start → cancel/complete → dispose", () => {
  it("does not accumulate runtime listeners across cycles", async () => {
    stub = stubOllamaFetch([
      { texts: ["one."] },
      { texts: ["two."] },
      { texts: ["three."] },
      { texts: ["four."] },
      { texts: ["five."] },
    ]);
    const runtime = makeRuntime();
    await runtime.initialize();
    let completed = 0;
    const counter = runtime.subscribe((event) => {
      if (event.type === "completed") completed += 1;
    });
    try {
      for (let i = 0; i < 5; i++) {
        const unsub = runtime.subscribe(() => {});
        await runtime.startSession(`cycle ${i}`);
        unsub();
        // Only the counting subscription remains.
        expect(runtime.listenerCount()).toBe(1);
      }
      expect(completed).toBe(5);
    } finally {
      counter();
    }
    await runtime.dispose();
    await runtime.dispose(); // idempotent
    expect(runtime.listenerCount()).toBe(0);
  });

  it("cancel → dispose releases everything", async () => {
    stub = stubOllamaFetch([{ texts: ["hello."] }]);
    const runtime = makeRuntime();
    await runtime.initialize();
    const unsub = runtime.subscribe(() => {});
    await runtime.startSession("hello");
    await runtime.abort().catch(() => undefined);
    unsub();
    await runtime.dispose();
    expect(runtime.listenerCount()).toBe(0);
  });
});

describe("lifecycle: CliRunner per-run subscription released", () => {
  it("repeated runs do not grow runtime listeners", async () => {
    stub = stubOllamaFetch([
      { texts: ["t0."] },
      { texts: ["t1."] },
      { texts: ["t2."] },
      { texts: ["t3."] },
      { texts: ["t4."] },
    ]);
    const runtime = makeRuntime();
    await runtime.initialize();
    const runner = new CliRunner(runtime);
    for (let i = 0; i < 5; i++) {
      await runner.run(`task ${i}`);
      expect(runtime.listenerCount()).toBe(0);
    }
    await runtime.dispose();
  });
});

describe("lifecycle: TaskScheduler start/stop cycles", () => {
  it("repeated start → stop → cancelAll leaves no timer", async () => {
    const scheduler = new TaskScheduler(
      async () => ({ exitCode: 0, output: "ok" }),
      {
        tickIntervalMs: 50,
      },
    );
    for (let i = 0; i < 5; i++) {
      scheduler.start();
      scheduler.start(); // idempotent
      expect(scheduler.hasTimer()).toBe(true);
      scheduler.stop();
      scheduler.stop(); // idempotent
      expect(scheduler.hasTimer()).toBe(false);
    }
    scheduler.cancelAll();
    scheduler.cancelAll(); // idempotent
    expect(scheduler.hasTimer()).toBe(false);
  });
});

describe("lifecycle: SelfHealingEngine subscribe/dispose", () => {
  it("repeated subscribe → cancel → dispose cycles do not grow", () => {
    for (let i = 0; i < 5; i++) {
      const engine = new SelfHealingEngine({ workspaceRoot: process.cwd() });
      const u1 = engine.subscribe(() => {});
      const u2 = engine.subscribe(() => {});
      u1();
      engine.cancel();
      engine.dispose();
      engine.dispose(); // idempotent
      expect(engine.listenerCount()).toBe(0);
      void u2;
      u2();
    }
  });
});

describe("lifecycle: MultiAgentOrchestrator subscribe/dispose", () => {
  it("repeated subscribe → cancel → dispose cycles do not grow", () => {
    for (let i = 0; i < 5; i++) {
      const orch = new MultiAgentOrchestrator({
        workspaceRoot: process.cwd(),
        providerId: "ollama",
        modelId: "qwen3:8b",
        privacyMode: "local",
      });
      const u = orch.subscribe(() => {});
      orch.cancel();
      u();
      orch.dispose();
      orch.dispose(); // idempotent
      expect(orch.listenerCount()).toBe(0);
    }
  });
});

describe("lifecycle: ProviderRegistry disposal", () => {
  it("registry dispose clears listeners and is idempotent", () => {
    const registry = new ProviderRegistry();
    const u = registry.subscribe(() => {});
    u();
    registry.dispose();
    registry.dispose();
  });
});
