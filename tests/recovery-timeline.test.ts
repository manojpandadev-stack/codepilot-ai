/**
 * Phase 10 — Activity Timeline recovery events (webview side).
 *
 * The host streams `recovery/event` payloads; the webview must validate and
 * bound them, and the row mapping must stay honest: a PARTIAL_SUCCESS or
 * exhausted recovery is NEVER rendered as a success.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_RECOVERY_ROWS,
  appendRecoveryEvent,
  recoveryRowView,
} from "../apps/webview/src/lib/messages";

const event = (over: Record<string, unknown> = {}) => ({
  phase: "FAILURE_DETECTED",
  attempt: 0,
  maxAttempts: 3,
  timestamp: 1_700_000_000_000,
  category: "TEST_FAILURE",
  summary: "TEST_FAILURE (exit 1): AssertionError …",
  ...over,
});

describe("appendRecoveryEvent", () => {
  it("accepts a valid event with bounded fields", () => {
    const next = appendRecoveryEvent([], event({ files: ["src/add.js"] }));
    expect(next).toHaveLength(1);
    expect(next[0]!.phase).toBe("FAILURE_DETECTED");
    expect(next[0]!.category).toBe("TEST_FAILURE");
    expect(next[0]!.files).toEqual(["src/add.js"]);
  });

  it("drops malformed payloads instead of rendering fake rows", () => {
    expect(appendRecoveryEvent([], null)).toHaveLength(0);
    expect(appendRecoveryEvent([], "FAILURE_DETECTED")).toHaveLength(0);
    expect(appendRecoveryEvent([], {})).toHaveLength(0);
    expect(appendRecoveryEvent([], { phase: "" })).toHaveLength(0);
    expect(appendRecoveryEvent([], { phase: "x".repeat(500) })).toHaveLength(0);
  });

  it("bounds summary, files, and the overall list size", () => {
    const withJunk = appendRecoveryEvent(
      [],
      event({
        summary: "s".repeat(5_000),
        files: [
          ...Array.from({ length: 40 }, (_, i) => `f${i}.ts`),
          42,
          null,
          "ok.ts",
        ],
      }),
    );
    expect(withJunk[0]!.summary!.length).toBeLessThanOrEqual(400);
    expect(withJunk[0]!.files!.length).toBeLessThanOrEqual(20);
    expect(withJunk[0]!.files!.every((f) => typeof f === "string")).toBe(true);

    let rows: ReturnType<typeof appendRecoveryEvent> = [];
    for (let i = 0; i < MAX_RECOVERY_ROWS + 25; i += 1) {
      rows = appendRecoveryEvent(rows, event({ attempt: i }));
    }
    expect(rows).toHaveLength(MAX_RECOVERY_ROWS);
    // Oldest rows drop; the newest survives.
    expect(rows.at(-1)!.attempt).toBe(MAX_RECOVERY_ROWS + 24);
  });
});

describe("recoveryRowView — honest Activity Timeline rows", () => {
  it("maps the failure and approval phases", () => {
    expect(recoveryRowView(event())).toMatchObject({
      kind: "failure",
      state: "error",
    });
    expect(
      recoveryRowView(event({ phase: "DIAGNOSIS_STARTED" })),
    ).toMatchObject({ kind: "retry", state: "running" });
    expect(
      recoveryRowView(event({ phase: "REPAIR_APPROVAL_REQUIRED" })),
    ).toMatchObject({ kind: "approval", state: "running" });
    expect(
      recoveryRowView(event({ phase: "VERIFICATION_STARTED" })),
    ).toMatchObject({ kind: "verification", state: "running" });
  });

  it("shows SUCCESS as done and every other settlement as an error", () => {
    expect(
      recoveryRowView(
        event({ phase: "RECOVERY_COMPLETED", status: "SUCCESS" }),
      ),
    ).toMatchObject({
      kind: "completion",
      state: "done",
      label: "Recovery succeeded",
    });

    for (const status of [
      "PARTIAL_SUCCESS",
      "FAILED",
      "CANCELLED",
      "TIMEOUT",
    ]) {
      const row = recoveryRowView(
        event({ phase: "RECOVERY_COMPLETED", status }),
      );
      expect(row.state).toBe("error");
      expect(row.label).not.toBe("Recovery succeeded");
    }
    expect(
      recoveryRowView(event({ phase: "RECOVERY_EXHAUSTED" })),
    ).toMatchObject({ kind: "completion", state: "error" });
  });

  it("surfaces a NEW failure explicitly", () => {
    const row = recoveryRowView(
      event({
        phase: "VERIFICATION_FAILED",
        newFailure: true,
        summary: "NEW failure",
      }),
    );
    expect(row.label).toBe("NEW failure detected");
    expect(row.state).toBe("error");
  });
});
