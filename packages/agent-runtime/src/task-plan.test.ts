/**
 * TaskPlan model — Phase 2 structured execution plan.
 *
 * Strict, bounded, deterministic: creation and step transitions validate hard
 * (unknown references, illegal transitions, oversized text throw), progress
 * is always DERIVED from step states, and the text fallback never guesses.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_PLAN_AFFECTED_FILES,
  MAX_PLAN_STEPS,
  createTaskPlan,
  parseModelPlanText,
  planProgress,
  updateTaskPlanStep,
} from "./task-plan.js";
import type { TaskPlan } from "./task-plan.js";

const NOW = 1_700_000_000_000;

function sample(): TaskPlan {
  return createTaskPlan(
    {
      objective: "Ship the release",
      steps: [
        { title: "Write tests" },
        { title: "Run suite", dependsOn: ["step-1"] },
        { title: "Tag release" },
      ],
    },
    NOW,
  );
}

describe("createTaskPlan", () => {
  it("creates ordered step ids, all pending, version 1", () => {
    const plan = sample();
    expect(plan.version).toBe(1);
    expect(plan.objective).toBe("Ship the release");
    expect(plan.steps.map((s) => s.id)).toEqual([
      "step-1",
      "step-2",
      "step-3",
    ]);
    expect(plan.steps.every((s) => s.status === "pending")).toBe(true);
    expect(plan.steps.every((s) => s.attempts === 0)).toBe(true);
    expect(plan.steps[1]!.dependsOn).toEqual(["step-1"]);
    expect(plan.currentStepId).toBeUndefined();
    expect(plan.createdAtMs).toBe(NOW);
    expect(plan.updatedAtMs).toBe(NOW);
  });

  it("trims text and rejects empty/oversized input", () => {
    expect(() =>
      createTaskPlan({ objective: "   ", steps: [{ title: "a" }] }, NOW),
    ).toThrow(/objective/);
    expect(() =>
      createTaskPlan({ objective: "x".repeat(1001), steps: [{ title: "a" }] }, NOW),
    ).toThrow(/at most 1000/);
    expect(() =>
      createTaskPlan({ objective: "ok", steps: [] }, NOW),
    ).toThrow(/at least one step/);
    expect(() =>
      createTaskPlan(
        { objective: "ok", steps: [{ title: "x".repeat(401) }] },
        NOW,
      ),
    ).toThrow(/at most 400/);
    const many = Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, i) => ({
      title: `s${i}`,
    }));
    expect(() => createTaskPlan({ objective: "ok", steps: many }, NOW)).toThrow(
      new RegExp(`at most ${MAX_PLAN_STEPS}`),
    );
  });

  it("rejects unknown and self dependencies", () => {
    expect(() =>
      createTaskPlan(
        { objective: "ok", steps: [{ title: "a", dependsOn: ["step-9"] }] },
        NOW,
      ),
    ).toThrow(/unknown step/);
    expect(() =>
      createTaskPlan(
        { objective: "ok", steps: [{ title: "a", dependsOn: ["step-1"] }] },
        NOW,
      ),
    ).toThrow(/cannot depend on itself/);
  });

  it("bounds affected_files (count and per-entry length)", () => {
    expect(() =>
      createTaskPlan(
        {
          objective: "ok",
          steps: [
            {
              title: "a",
              affectedFiles: Array.from(
                { length: MAX_PLAN_AFFECTED_FILES + 1 },
                (_, i) => `f${i}.ts`,
              ),
            },
          ],
        },
        NOW,
      ),
    ).toThrow(/at most 20/);
    expect(() =>
      createTaskPlan(
        { objective: "ok", steps: [{ title: "a", affectedFiles: ["x".repeat(301)] }] },
        NOW,
      ),
    ).toThrow(/at most 300/);
  });
});

describe("updateTaskPlanStep", () => {
  it("pending → running increments attempts and moves currentStepId", () => {
    const plan = sample();
    const { plan: next, step } = updateTaskPlanStep(
      plan,
      { stepId: "step-1", status: "running" },
      NOW + 1,
    );
    expect(step.status).toBe("running");
    expect(step.attempts).toBe(1);
    expect(next.currentStepId).toBe("step-1");
    expect(next.updatedAtMs).toBe(NOW + 1);
    expect(plan.steps[0]!.status).toBe("pending"); // inputs never mutated
  });

  it("running → completed clears currentStepId; progress derives", () => {
    let plan = sample();
    plan = updateTaskPlanStep(plan, { stepId: "step-1", status: "running" }, NOW).plan;
    plan = updateTaskPlanStep(plan, { stepId: "step-1", status: "completed" }, NOW).plan;
    expect(plan.currentStepId).toBeUndefined();
    expect(planProgress(plan)).toEqual({
      total: 3,
      completed: 1,
      failed: 0,
      running: 0,
      pending: 2,
    });
  });

  it("failed → running retries (attempts++, lastError cleared)", () => {
    let plan = sample();
    // First real attempt: pending → running (attempts 1).
    plan = updateTaskPlanStep(
      plan,
      { stepNumber: 1, status: "running" },
      NOW,
    ).plan;
    // Then it fails with an error...
    plan = updateTaskPlanStep(
      plan,
      { stepNumber: 1, status: "failed", error: "boom" },
      NOW,
    ).plan;
    expect(plan.steps[0]!.lastError).toBe("boom");
    expect(plan.steps[0]!.attempts).toBe(1);
    // ...and a retry re-enters running: second attempt, error cleared.
    plan = updateTaskPlanStep(
      plan,
      { stepNumber: 1, status: "running" },
      NOW + 1,
    ).plan;
    expect(plan.steps[0]!.attempts).toBe(2);
    expect(plan.steps[0]!.lastError).toBeUndefined();
  });

  it("rejects illegal transitions and unknown steps", () => {
    const plan = sample();
    // Legal (documented): pending → running|completed|failed. Illegal:
    // completed → pending (terminal steps only reopen to running).
    const running = updateTaskPlanStep(
      plan,
      { stepId: "step-1", status: "running" },
      NOW,
    ).plan;
    const done = updateTaskPlanStep(
      running,
      { stepId: "step-1", status: "completed" },
      NOW,
    ).plan;
    expect(() =>
      updateTaskPlanStep(done, { stepId: "step-1", status: "pending" }, NOW),
    ).toThrow(/illegal transition/);
    expect(() =>
      updateTaskPlanStep(plan, { stepId: "step-9", status: "running" }, NOW),
    ).toThrow(/unknown step id/);
    expect(() =>
      updateTaskPlanStep(plan, { stepNumber: 99, status: "running" }, NOW),
    ).toThrow(/stepNumber/);
    expect(() =>
      updateTaskPlanStep(plan, { status: "running" }, NOW),
    ).toThrow(/requires \{ stepId \}/);
    expect(() =>
      updateTaskPlanStep(plan, { stepId: "step-1", status: "bogus" }, NOW),
    ).toThrow(/must be one of/);
  });

  it("no-op re-assert of the same status is idempotent", () => {
    const running = updateTaskPlanStep(
      sample(),
      { stepId: "step-1", status: "running" },
      NOW,
    ).plan;
    const again = updateTaskPlanStep(
      running,
      { stepId: "step-1", status: "running" },
      NOW + 5,
    ).plan;
    expect(again.steps[0]!.attempts).toBe(1); // not double-counted
    expect(again.currentStepId).toBe("step-1");
  });

  it("records a bounded note", () => {
    const { plan } = updateTaskPlanStep(
      sample(),
      { stepId: "step-2", status: "running", note: "in progress" },
      NOW,
    );
    expect(plan.steps[1]!.note).toBe("in progress");
    expect(() =>
      updateTaskPlanStep(
        plan,
        { stepId: "step-2", status: "completed", note: "x".repeat(501) },
        NOW,
      ),
    ).toThrow(/at most 500/);
  });
});

describe("parseModelPlanText (never guesses)", () => {
  it("parses a ```codepilot-plan fenced object", () => {
    const text = [
      "Here is the plan:",
      "```codepilot-plan",
      JSON.stringify({
        objective: "Do the thing",
        steps: [{ title: "one" }, { title: "two", dependsOn: ["step-1"] }],
      }),
      "```",
    ].join("\n");
    const plan = parseModelPlanText(text, NOW);
    expect(plan).not.toBeNull();
    expect(plan!.objective).toBe("Do the thing");
    expect(plan!.steps.map((s) => s.title)).toEqual(["one", "two"]);
    expect(plan!.steps[1]!.dependsOn).toEqual(["step-1"]);
  });

  it("parses an ordered markdown list when no fence exists", () => {
    const plan = parseModelPlanText(
      "1. first step\n2. second step\n3. third step",
      NOW,
    );
    expect(plan).not.toBeNull();
    expect(plan!.steps.map((s) => s.title)).toEqual([
      "first step",
      "second step",
      "third step",
    ]);
    expect(plan!.steps.every((s) => s.status === "pending")).toBe(true);
  });

  it("returns null for prose (never invents steps)", () => {
    expect(parseModelPlanText("I will think about it later.", NOW)).toBeNull();
    expect(parseModelPlanText("", NOW)).toBeNull();
    expect(parseModelPlanText("   \n  ", NOW)).toBeNull();
  });

  it("returns null when the list exceeds the step bound", () => {
    const many = Array.from(
      { length: MAX_PLAN_STEPS + 1 },
      (_, i) => `${i + 1}. step ${i}`,
    ).join("\n");
    expect(parseModelPlanText(many, NOW)).toBeNull();
  });
});
