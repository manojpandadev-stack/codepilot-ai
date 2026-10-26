/**
 * CONTROL CENTER — frontend state-derivation tests.
 *
 * These tests pin the honest-state contract of the Control Center UI:
 * every state is derived from REAL runtime data (tool events, approvals,
 * problems counts, usage payloads, ChangeSet entries). Where the backend
 * does not emit a signal (tests/build/typecheck/security results, provider
 * cost), the contract requires an explicit "Not available" representation —
 * never a fabricated value.
 *
 * Scope: webview/lib only (pure derivations). No backend code is exercised.
 */

import { describe, expect, it } from "vitest";
import {
  buildActivityRows,
  controlCenterPhaseLabel,
  controlCenterPhaseTone,
  countRetries,
  deriveControlCenterPhase,
  deriveVerificationState,
  formatCostView,
  summarizeChanges,
  verificationEvidenceRows,
  verificationLabel,
  VERIFICATION_COPY,
  type ControlCenterPhaseInput,
} from "../apps/webview/src/lib/controlcenter";
import type { ToolEvent } from "../apps/webview/src/types";
import type { FileChange } from "../apps/webview/src/DiffViewer";

// ---------------------------------------------------------------------------
// Fixtures — shapes match the real host payloads (types.ts / DiffViewer)
// ---------------------------------------------------------------------------

function toolEvent(overrides: Partial<ToolEvent> & { id?: string }): ToolEvent {
  return {
    id: overrides.id ?? "t1",
    name: "search_codebase",
    status: "completed",
    ...overrides,
  };
}

function phaseInput(overrides: Partial<ControlCenterPhaseInput>): ControlCenterPhaseInput {
  return {
    isRunning: false,
    statusMessage: "",
    pendingApprovals: 0,
    cancelRequested: false,
    verifying: false,
    endedWithoutFinalAnswer: false,
    outcome: null,
    ...overrides,
  };
}

const baseVerification = {
  outcome: "completed" as const,
  problemsCount: null as number | null,
  failedCommands: 0,
  okCommands: 0,
  healingActive: false,
  healingSucceeded: null as boolean | null,
};

// ---------------------------------------------------------------------------
// STEP 2 — primary-screen run states
// ---------------------------------------------------------------------------

describe("Control Center phases", () => {
  it("idle: no turn yet — honest 'Ready', never a guess", () => {
    expect(deriveControlCenterPhase(phaseInput({}))).toBe("idle");
    expect(controlCenterPhaseLabel("idle")).toBe("Ready");
    expect(controlCenterPhaseTone("idle")).toBe("muted");
  });

  it("planning: run active with a planning-shaped host message", () => {
    expect(
      deriveControlCenterPhase(
        phaseInput({ isRunning: true, statusMessage: "Analyzing repository structure…" }),
      ),
    ).toBe("planning");
    expect(controlCenterPhaseLabel("planning")).toBe("Planning");
  });

  it("executing: run active with a running tool", () => {
    expect(
      deriveControlCenterPhase(
        phaseInput({ isRunning: true, runningToolName: "bash" }),
      ),
    ).toBe("executing");
    expect(
      deriveControlCenterPhase(
        phaseInput({ isRunning: true, statusMessage: "Generating…" }),
      ),
    ).toBe("executing");
  });

  it("approval: pending approvals outrank the running tool", () => {
    expect(
      deriveControlCenterPhase(
        phaseInput({ isRunning: true, runningToolName: "bash", pendingApprovals: 1 }),
      ),
    ).toBe("approval");
    expect(controlCenterPhaseTone("approval")).toBe("warning");
  });

  it("verifying: real verification work in flight (self-healing re-check)", () => {
    expect(
      deriveControlCenterPhase(phaseInput({ isRunning: true, verifying: true })),
    ).toBe("verifying");
  });

  it("completed / failed: settled outcomes from the runtime", () => {
    expect(deriveControlCenterPhase(phaseInput({ outcome: "completed" }))).toBe("completed");
    expect(deriveControlCenterPhase(phaseInput({ outcome: "failed" }))).toBe("failed");
    expect(controlCenterPhaseTone("completed")).toBe("success");
    expect(controlCenterPhaseTone("failed")).toBe("danger");
  });

  it("cancelled: user stop settles as CANCELLED, not FAILED", () => {
    expect(deriveControlCenterPhase(phaseInput({ outcome: "stopped" }))).toBe("cancelled");
    expect(controlCenterPhaseLabel("cancelled")).toBe("Cancelled");
  });

  it("incomplete: turn ended without a final answer", () => {
    expect(
      deriveControlCenterPhase(
        phaseInput({ outcome: "failed", endedWithoutFinalAnswer: true }),
      ),
    ).toBe("incomplete");
    expect(controlCenterPhaseLabel("incomplete")).toBe("Incomplete");
  });
});

// ---------------------------------------------------------------------------
// STEP 3 — agent activity timeline rows
// ---------------------------------------------------------------------------

describe("Activity timeline rows", () => {
  it("maps real tool events to rows with honest states", () => {
    const rows = buildActivityRows([
      toolEvent({ id: "a", name: "read_files", status: "started" }),
      toolEvent({ id: "b", name: "read_files", status: "completed", durationMs: 120 }),
      toolEvent({ id: "c", name: "bash", status: "error", detail: "exit 1" }),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.state).toBe("running");
    expect(rows[1]!.state).toBe("ok");
    expect(rows[2]!.state).toBe("error");
    expect(rows[2]!.kind).toBe("failure");
    expect(rows[2]!.detail).toBe("exit 1");
  });

  it("counts retries only when a tool failed and then completed", () => {
    expect(
      countRetries([
        toolEvent({ id: "1", name: "bash", status: "error" }),
        toolEvent({ id: "2", name: "bash", status: "completed" }),
      ]),
    ).toBe(1);
    expect(countRetries([toolEvent({ id: "3", name: "bash", status: "error" })])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// STEP 6 — verification states (honest, never fabricated)
// ---------------------------------------------------------------------------

describe("Verification states", () => {
  it("completed turn without evidence is NOT VERIFIED — completion is not verification", () => {
    const v = deriveVerificationState(baseVerification);
    expect(v.status).toBe("not-verified");
    expect(v.detail).toContain("without running any verification evidence");
  });

  it("ok commands + clean problems = VERIFIED", () => {
    const v = deriveVerificationState({ ...baseVerification, okCommands: 2, problemsCount: 0 });
    expect(v.status).toBe("verified");
    expect(v.detail).toContain("no problems");
  });

  it("ok commands + reported problems = VERIFYING with explicit caution", () => {
    const v = deriveVerificationState({ ...baseVerification, okCommands: 1, problemsCount: 3 });
    expect(v.status).toBe("verifying");
    expect(v.detail).toContain("3 problems");
  });

  it("failed commands = VERIFICATION FAILED", () => {
    const v = deriveVerificationState({ ...baseVerification, failedCommands: 1 });
    expect(v.status).toBe("failed");
    expect(v.label).toBe(VERIFICATION_COPY.failed);
  });

  it("non-completed turn = NOT VERIFIED", () => {
    const v = deriveVerificationState({ ...baseVerification, outcome: "stopped" });
    expect(v.status).toBe("not-verified");
  });

  it("healing in flight = VERIFYING", () => {
    const v = deriveVerificationState({ ...baseVerification, healingActive: true });
    expect(v.status).toBe("verifying");
  });

  it("evidence rows mark backend-absent signals as explicitly NOT AVAILABLE", () => {
    const rows = verificationEvidenceRows({ problemsCount: null, okCommands: 0, failedCommands: 0 });
    const unavailable = rows.filter((r) => r.kind === "unavailable").map((r) => r.label);
    // Frontend blocked by missing runtime data: no diagnostics pulled yet
    // (problemsCount null) and dedicated test/build/typecheck/security
    // result events do not exist.
    expect(unavailable).toEqual([
      "Problems",
      "Tests",
      "Build",
      "Typecheck",
      "Security checks",
    ]);
    const problems = rows.find((r) => r.label === "Problems")!;
    expect(problems.value).toBe("Not checked");
    expect(problems.kind).toBe("unavailable");
  });

  it("a real diagnostics pull turns Problems into evidence", () => {
    const rows = verificationEvidenceRows({ problemsCount: 2, okCommands: 0, failedCommands: 0 });
    const problems = rows.find((r) => r.label === "Problems")!;
    expect(problems.value).toBe("2");
    expect(problems.kind).toBe("evidence");
    const unavailable = rows.filter((r) => r.kind === "unavailable").map((r) => r.label);
    expect(unavailable).toEqual(["Tests", "Build", "Typecheck", "Security checks"]);
  });

  it("all five verification labels are distinct and text-based", () => {
    const labels = Object.values(VERIFICATION_COPY);
    expect(new Set(labels).size).toBe(5);
    expect(verificationLabel("not-available")).toBe("Verification not available");
  });
});

// ---------------------------------------------------------------------------
// STEP 5 — cost / usage (display-only, honest about absence)
// ---------------------------------------------------------------------------

describe("Cost / usage view", () => {
  it("shows cost only when the provider reported one", () => {
    const v = formatCostView({
      inputTokens: 1200,
      outputTokens: 340,
      totalCost: 0.0123,
      model: "gpt-x",
      provider: "openai",
    });
    expect(v.cost).toBe("$0.0123");
    expect(v.tokens).toBe("1.2k → 340 tok");
    expect(v.costUnavailableReason).toBe("");
  });

  it("cost unavailable is explicit — never an invented price", () => {
    const v = formatCostView({
      inputTokens: 10,
      outputTokens: 5,
      model: "qwen3:8b",
      provider: "ollama",
    });
    expect(v.cost).toBeUndefined();
    expect(v.costUnavailableReason).toContain("not available");
    expect(v.costUnavailableReason).toContain("ollama");
  });
});

// ---------------------------------------------------------------------------
// STEP 7 — ChangeSet summary
// ---------------------------------------------------------------------------

describe("ChangeSet summary", () => {
  const fc = (
    path: string,
    status: FileChange["status"],
    diff?: string,
  ): FileChange => ({
    path,
    status,
    ...(diff !== undefined ? { diff } : {}),
  });

  it("empty ChangeSet — explicit zero state", () => {
    const s = summarizeChanges([]);
    expect(s.total).toBe(0);
    expect(s.added + s.modified + s.deleted).toBe(0);
    expect(s.additions).toBeNull();
  });

  it("counts statuses and sums real diff stats only", () => {
    const s = summarizeChanges([
      fc("a.ts", "added", "@@ -0,0 +1,2 @@\n+one\n+two\n"),
      fc("b.ts", "modified", "@@ -1,2 +1,2 @@\n-old\n+new\n"),
      fc("c.ts", "deleted"),
      fc("d.ts", "applied", "@@ -1 +1 @@\n+x\n-y\n"),
    ]);
    expect(s.total).toBe(4);
    expect(s.added).toBe(1);
    expect(s.modified).toBe(1);
    expect(s.deleted).toBe(1);
    expect(s.applied).toBe(1);
    expect(s.rolledBack).toBe(0);
    expect(s.additions).toBe(4); // one+two +new +x
    expect(s.deletions).toBe(2); // -old -y
  });
});
