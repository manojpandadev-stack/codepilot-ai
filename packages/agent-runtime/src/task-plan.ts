/**
 * @codepilot/agent-runtime — TaskPlan: the structured execution plan artifact.
 *
 * A TaskPlan is produced in PLAN mode (model `plan` tool call or a parseable
 * plan block in the assistant text), persisted on the task, and advanced by
 * explicit `plan` tool updates during execution. Every field is derived from
 * real model output or explicit tool calls — nothing here is fabricated.
 *
 * Design rules:
 * - Strict, bounded, deterministic: creation and step transitions validate
 *   hard (unknown references, illegal transitions, oversized text throw) so a
 *   malformed call becomes a structured tool error the model can correct.
 * - Progress (completed/failed/current) is always DERIVED from step states —
 *   never stored twice, never drifts.
 * - Pure module: no imports from types/runtime (safe for persistence layers).
 */

export type TaskPlanStepStatus = "pending" | "running" | "completed" | "failed";

export interface TaskPlanStep {
  id: string;
  title: string;
  status: TaskPlanStepStatus;
  /** Step ids that must complete before this one starts. */
  dependsOn?: string[];
  /** Workspace-relative files this step expects to touch. */
  affectedFiles?: string[];
  /** How this step will be validated (command/check description). */
  validation?: string;
  /** How many times the step has entered `running` (1 = first attempt). */
  attempts: number;
  /** Last failure note (cleared when the step later succeeds). */
  lastError?: string;
  /** Free-form progress note from the model (bounded). */
  note?: string;
}

export interface TaskPlan {
  version: 1;
  id: string;
  objective: string;
  createdAtMs: number;
  updatedAtMs: number;
  steps: TaskPlanStep[];
  /** The step currently marked `running`, when one is. */
  currentStepId?: string;
}

export interface TaskPlanProgress {
  total: number;
  completed: number;
  failed: number;
  running: number;
  pending: number;
  currentStepId?: string;
}

export const MAX_PLAN_STEPS = 50;
export const MAX_PLAN_OBJECTIVE_CHARS = 1_000;
export const MAX_PLAN_STEP_TITLE_CHARS = 400;
export const MAX_PLAN_NOTE_CHARS = 500;
export const MAX_PLAN_AFFECTED_FILES = 20;
export const MAX_PLAN_AFFECTED_FILE_CHARS = 300;

const STEP_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "completed",
  "failed",
]);

function bound(value: string, max: number, what: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${what} must not be empty`);
  if (trimmed.length > max) {
    throw new Error(`${what} must be at most ${max} characters`);
  }
  return trimmed;
}

export interface TaskPlanStepInput {
  title: string;
  dependsOn?: unknown;
  affectedFiles?: unknown;
  validation?: unknown;
}

/** Create a validated plan. All steps start `pending`. Throws on bad input. */
export function createTaskPlan(
  input: { objective: string; steps: TaskPlanStepInput[]; id?: string },
  nowMs: number,
): TaskPlan {
  const objective = bound(
    String(input.objective ?? ""),
    MAX_PLAN_OBJECTIVE_CHARS,
    "objective",
  );
  const rawSteps = Array.isArray(input.steps) ? input.steps : [];
  if (rawSteps.length === 0) {
    throw new Error("steps must contain at least one step");
  }
  if (rawSteps.length > MAX_PLAN_STEPS) {
    throw new Error(`steps must contain at most ${MAX_PLAN_STEPS} entries`);
  }
  const steps: TaskPlanStep[] = rawSteps.map((raw, index) => {
    const title = bound(
      String(raw?.title ?? ""),
      MAX_PLAN_STEP_TITLE_CHARS,
      `steps[${index}].title`,
    );
    const step: TaskPlanStep = {
      id: `step-${index + 1}`,
      title,
      status: "pending",
      attempts: 0,
    };
    if (raw?.dependsOn !== undefined) {
      if (!Array.isArray(raw.dependsOn)) {
        throw new Error(`steps[${index}].dependsOn must be an array`);
      }
      step.dependsOn = raw.dependsOn.map((d) => String(d));
    }
    if (raw?.affectedFiles !== undefined) {
      if (!Array.isArray(raw.affectedFiles)) {
        throw new Error(`steps[${index}].affectedFiles must be an array`);
      }
      if (raw.affectedFiles.length > MAX_PLAN_AFFECTED_FILES) {
        throw new Error(
          `steps[${index}].affectedFiles must contain at most ${MAX_PLAN_AFFECTED_FILES} entries`,
        );
      }
      step.affectedFiles = raw.affectedFiles.map((f, fi) =>
        bound(
          String(f),
          MAX_PLAN_AFFECTED_FILE_CHARS,
          `steps[${index}].affectedFiles[${fi}]`,
        ),
      );
    }
    if (raw?.validation !== undefined) {
      step.validation = bound(
        String(raw.validation),
        MAX_PLAN_STEP_TITLE_CHARS,
        `steps[${index}].validation`,
      );
    }
    return step;
  });
  // dependsOn must reference earlier steps by id (ordered dependencies only).
  const ids = new Set(steps.map((s) => s.id));
  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!ids.has(dep)) {
        throw new Error(
          `step ${step.id} depends on unknown step '${dep}' (ids are step-1..step-N)`,
        );
      }
      if (dep === step.id) {
        throw new Error(`step ${step.id} cannot depend on itself`);
      }
    }
  }
  return {
    version: 1,
    id: input.id ?? `plan-${nowMs.toString(36)}`,
    objective,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    steps,
  };
}

export interface StepUpdateInput {
  stepId?: string;
  /** 1-based step number (used when stepId is absent). */
  stepNumber?: number;
  status: string;
  note?: string;
  error?: string;
}

/**
 * Apply a validated step transition. Returns a NEW plan (inputs are never
 * mutated). Legal transitions:
 *   pending  → running | completed | failed
 *   running  → completed | failed
 *   failed   → running   (retry — attempts increments)
 *   completed→ running   (reopen — attempts increments)
 * Entering `running` always increments attempts and moves currentStepId;
 * any other terminal state clears currentStepId when it pointed here.
 */
export function updateTaskPlanStep(
  plan: TaskPlan,
  update: StepUpdateInput,
  nowMs: number,
): { plan: TaskPlan; step: TaskPlanStep } {
  if (!STEP_STATUSES.has(update.status)) {
    throw new Error(
      `status must be one of pending|running|completed|failed (got '${String(update.status)}')`,
    );
  }
  const status = update.status as TaskPlanStepStatus;
  const stepIndex = resolveStepIndex(plan, update);
  const previous = plan.steps[stepIndex]!;
  const legal =
    (previous.status === "pending" &&
      (status === "running" ||
        status === "completed" ||
        status === "failed")) ||
    (previous.status === "running" &&
      (status === "completed" || status === "failed")) ||
    (previous.status === "failed" && status === "running") ||
    (previous.status === "completed" && status === "running") ||
    previous.status === status; // no-op re-assert (idempotent)
  if (!legal) {
    throw new Error(
      `illegal transition for ${previous.id}: ${previous.status} → ${status}`,
    );
  }
  const step: TaskPlanStep = { ...previous, status };
  if (status === "running" && previous.status !== "running") {
    step.attempts = previous.attempts + 1;
    step.lastError = undefined;
  }
  if (update.note !== undefined) {
    step.note = bound(String(update.note), MAX_PLAN_NOTE_CHARS, "note");
  }
  if (update.error !== undefined && status === "failed") {
    step.lastError = bound(
      String(update.error),
      MAX_PLAN_NOTE_CHARS,
      "error",
    );
  }
  const steps = plan.steps.map((s, i) => (i === stepIndex ? step : s));
  const currentStepId =
    status === "running"
      ? step.id
      : plan.currentStepId === step.id
        ? undefined
        : plan.currentStepId;
  const next: TaskPlan = {
    ...plan,
    steps,
    updatedAtMs: nowMs,
    currentStepId,
  };
  return { plan: next, step };
}

function resolveStepIndex(plan: TaskPlan, update: StepUpdateInput): number {
  if (typeof update.stepId === "string" && update.stepId.length > 0) {
    const idx = plan.steps.findIndex((s) => s.id === update.stepId);
    if (idx < 0) throw new Error(`unknown step id '${update.stepId}'`);
    return idx;
  }
  if (typeof update.stepNumber === "number") {
    const idx = update.stepNumber - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= plan.steps.length) {
      throw new Error(
        `stepNumber must be 1..${plan.steps.length} (got ${String(update.stepNumber)})`,
      );
    }
    return idx;
  }
  throw new Error("update requires { stepId } or { stepNumber }");
}

/** Derived progress — never persisted, computed on read. */
export function planProgress(plan: TaskPlan): TaskPlanProgress {
  let completed = 0;
  let failed = 0;
  let running = 0;
  let pending = 0;
  for (const s of plan.steps) {
    if (s.status === "completed") completed += 1;
    else if (s.status === "failed") failed += 1;
    else if (s.status === "running") running += 1;
    else pending += 1;
  }
  return {
    total: plan.steps.length,
    completed,
    failed,
    running,
    pending,
    ...(plan.currentStepId !== undefined
      ? { currentStepId: plan.currentStepId }
      : {}),
  };
}

/**
 * Lenient text fallback: parse a structured plan out of model prose when the
 * model did not call the `plan` tool. Accepts, in order:
 *   1. a ```codepilot-plan fenced JSON block: { objective, steps: [...] }
 *   2. any ```json fenced object with the same shape
 *   3. an ordered/bulleted markdown list (each item becomes a pending step)
 * Returns null when no plan-shaped content exists — NEVER guesses.
 */
export function parseModelPlanText(
  text: string,
  nowMs: number,
  id?: string,
): TaskPlan | null {
  if (typeof text !== "string" || text.trim().length === 0) return null;
  const fenced =
    /```(?:codepilot-plan|json)\s*\n([\s\S]*?)```/.exec(text) ?? null;
  if (fenced?.[1]) {
    try {
      const parsed: unknown = JSON.parse(fenced[1].trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const rec = parsed as Record<string, unknown>;
        const objective =
          typeof rec.objective === "string"
            ? rec.objective
            : firstLine(text);
        const steps = Array.isArray(rec.steps)
          ? (rec.steps as unknown[]).map((s) =>
              typeof s === "object" && s !== null
                ? (s as Record<string, unknown>)
                : { title: String(s) },
            )
          : [];
        if (steps.length > 0) {
          return createTaskPlan(
            {
              objective,
              steps: steps.map((s) => ({
                title: String(s.title ?? s.description ?? ""),
                ...(Array.isArray(s.dependsOn) ? { dependsOn: s.dependsOn } : {}),
                ...(Array.isArray(s.affectedFiles)
                  ? { affectedFiles: s.affectedFiles }
                  : {}),
                ...(typeof s.validation === "string"
                  ? { validation: s.validation }
                  : {}),
              })),
              ...(id ? { id } : {}),
            },
            nowMs,
          );
        }
      }
    } catch {
      // fall through to the list parser
    }
  }
  const listItems: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:\d{1,2}[.)]|[-*+])\s+(.+)$/.exec(line);
    if (m?.[1]) listItems.push(m[1].trim());
  }
  if (listItems.length === 0 || listItems.length > MAX_PLAN_STEPS) return null;
  try {
    return createTaskPlan(
      {
        objective: firstLine(text),
        steps: listItems.map((title) => ({ title })),
        ...(id ? { id } : {}),
      },
      nowMs,
    );
  } catch {
    return null;
  }
}

function firstLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line ?? "Plan").replace(/^#+\s*/, "");
}
