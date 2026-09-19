/**
 * Continuity message validation (Phase 11/19) — the webview-side fail-safe
 * for `continuity/state` payloads. Malformed traffic must never corrupt the
 * continuity display; these tests pin the accept/reject boundary.
 */
import { describe, expect, it } from "vitest";
import {
  validateContinuityState,
  type ContinuityStateView,
} from "../apps/webview/src/lib/messages.js";

function validPayload(): Record<string, unknown> {
  return {
    active: true,
    chainLength: 2,
    currentTaskId: "task-2",
    turns: [
      {
        taskId: "task-1",
        turn: 1,
        title: "first question",
        status: "completed",
        createdAtMs: 1000,
        updatedAtMs: 2000,
        compacted: false,
        trimmed: false,
      },
      {
        taskId: "task-2",
        turn: 2,
        title: "second question",
        status: "running",
        createdAtMs: 3000,
        updatedAtMs: 4000,
        compacted: true,
        trimmed: true,
      },
    ],
    compacted: true,
    truncated: false,
  };
}

describe("validateContinuityState", () => {
  it("accepts a well-formed snapshot", () => {
    const state = validateContinuityState(validPayload());
    expect(state).not.toBeNull();
    expect(state).toMatchObject({ active: true, chainLength: 2 });
    expect(state!.turns).toHaveLength(2);
  });

  it("accepts an empty chain (fresh/reset session)", () => {
    const state = validateContinuityState({
      active: false,
      chainLength: 0,
      currentTaskId: null,
      turns: [],
      compacted: false,
      truncated: false,
    });
    expect(state).not.toBeNull();
    expect(state!).toMatchObject({ active: false, chainLength: 0 });
  });

  it("rejects non-objects and wrong field types", () => {
    expect(validateContinuityState(null)).toBeNull();
    expect(validateContinuityState(undefined)).toBeNull();
    expect(validateContinuityState("continuity")).toBeNull();
    expect(validateContinuityState([])).toBeNull();
    expect(validateContinuityState({ ...validPayload(), active: "yes" })).toBeNull();
    expect(validateContinuityState({ ...validPayload(), chainLength: -1 })).toBeNull();
    expect(validateContinuityState({ ...validPayload(), chainLength: 1.5 })).toBeNull();
    expect(validateContinuityState({ ...validPayload(), compacted: 1 })).toBeNull();
    expect(validateContinuityState({ ...validPayload(), turns: "nope" })).toBeNull();
  });

  it("rejects count mismatch between chainLength and turns", () => {
    const p = validPayload();
    (p as { chainLength: number }).chainLength = 5;
    expect(validateContinuityState(p)).toBeNull();
  });

  it("rejects malformed turns", () => {
    const bad = (turn: unknown): unknown => {
      const p = validPayload();
      (p as { turns: unknown[] }).turns = [turn];
      (p as { chainLength: number }).chainLength = 1;
      return p;
    };
    expect(validateContinuityState(bad(null))).toBeNull();
    expect(validateContinuityState(bad({}))).toBeNull();
    expect(
      validateContinuityState(
        bad({ taskId: "", turn: 1, title: "t", status: "s", createdAtMs: 1, updatedAtMs: 2, compacted: false, trimmed: false }),
      ),
    ).toBeNull();
    expect(
      validateContinuityState(
        bad({ taskId: "x", turn: 0, title: "t", status: "s", createdAtMs: 1, updatedAtMs: 2, compacted: false, trimmed: false }),
      ),
    ).toBeNull();
  });

  it("bounds overlong strings instead of rejecting", () => {
    const p = validPayload();
    const turns = (p as { turns: Array<Record<string, unknown>> }).turns;
    turns[0]!.title = "x".repeat(500);
    turns[0]!.status = "y".repeat(100);
    const state = validateContinuityState(p) as ContinuityStateView;
    expect(state.turns[0]!.title.length).toBeLessThanOrEqual(120);
    expect(state.turns[0]!.status.length).toBeLessThanOrEqual(32);
  });

  it("rejects oversized chains", () => {
    const p = validPayload();
    (p as { turns: unknown[] }).turns = Array.from({ length: 65 }, (_, i) => ({
      taskId: `t${i}`,
      turn: i + 1,
      title: "t",
      status: "s",
      createdAtMs: 1,
      updatedAtMs: 2,
      compacted: false,
      trimmed: false,
    }));
    (p as { chainLength: number }).chainLength = 65;
    expect(validateContinuityState(p)).toBeNull();
  });
});
