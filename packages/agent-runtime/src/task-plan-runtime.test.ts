/**
 * Runtime-level structured plan wiring (Phase 2) — deterministic, stub model.
 *
 * Drives the REAL native engine (Ollama NDJSON stub → provider → agent loop
 * → M4 gate → builtin tool dispatch) and proves:
 *   - a `plan` tool call executes, emits agent.plan_created with the full
 *     structured plan, and holds it on the runtime (getTaskPlan);
 *   - a PLAN-mode completion with NO tool call still yields a plan via the
 *     fenced-text fallback (never guesses — only ```codepilot-plan/json).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodePilotRuntime } from "./runtime.js";
import { stubOllamaFetch } from "./ollama-fetch-stub.js";
import { CODEPILOT_MODEL_TOOL_NAMES } from "./builtin-tools.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeRuntime(): CodePilotRuntime {
  return new CodePilotRuntime({
    workspaceRoot: process.cwd(),
    providerId: "ollama",
    modelId: "qwen3:8b",
    // Tests play the permission pipeline (same as other runtime suites);
    // M4 gate behavior itself is covered by the M4 suites.
    requestApproval: async () => ({ approved: true }),
  });
}

describe("CodePilotRuntime — structured plan events", () => {
  it("the plan tool emits agent.plan_created and holds the plan", async () => {
    stubOllamaFetch([
      {
        toolCalls: [
          {
            name: "plan",
            args: {
              action: "create",
              objective: "Release the build",
              steps: [{ title: "Write tests" }, { title: "Run suite" }],
            },
          },
        ],
      },
      { texts: ["Plan recorded."] },
    ]);
    const runtime = makeRuntime();
    const kinds: string[] = [];
    runtime.subscribe((event) => {
      if (event.type === "agent.plan_created") {
        kinds.push("created");
        expect(event.taskPlan.objective).toBe("Release the build");
        expect(event.stepsCount).toBe(2);
      }
      if (event.type === "agent.plan_updated") kinds.push("updated");
    });
    try {
      await runtime.initialize();
      await runtime.startSession("make a plan");
      expect(kinds).toContain("created");
      const plan = runtime.getTaskPlan();
      expect(plan?.objective).toBe("Release the build");
      expect(plan?.steps.map((s) => s.title)).toEqual([
        "Write tests",
        "Run suite",
      ]);
      expect(CODEPILOT_MODEL_TOOL_NAMES).toContain("plan");
    } finally {
      await runtime.dispose();
    }
  });

  it("plan-mode text fallback parses a fenced plan when no tool call happened", async () => {
    const fenced = [
      "```codepilot-plan",
      JSON.stringify({
        objective: "Text-only plan",
        steps: [{ title: "inspect" }, { title: "verify" }],
      }),
      "```",
    ].join("\n");
    stubOllamaFetch([{ texts: [fenced] }]);
    const runtime = makeRuntime();
    const created: string[] = [];
    runtime.subscribe((event) => {
      if (event.type === "agent.plan_created") created.push("created");
    });
    try {
      await runtime.initialize();
      await runtime.startSession("plan this", { agentMode: "plan" });
      expect(created).toEqual(["created"]);
      expect(runtime.getTaskPlan()?.objective).toBe("Text-only plan");
      expect(runtime.getTaskPlan()?.steps).toHaveLength(2);
    } finally {
      await runtime.dispose();
    }
  });

  it("act-mode prose completion never fabricates a plan", async () => {
    stubOllamaFetch([{ texts: ["I will get to it eventually."] }]);
    const runtime = makeRuntime();
    let created = 0;
    runtime.subscribe((event) => {
      if (event.type === "agent.plan_created") created += 1;
    });
    try {
      await runtime.initialize();
      await runtime.startSession("do the thing");
      expect(created).toBe(0);
      expect(runtime.getTaskPlan()).toBeNull();
    } finally {
      await runtime.dispose();
    }
  });
});
