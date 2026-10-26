import { describe, expect, it } from "vitest";
import { resolveRouting, workflowForIntent } from "./policy.js";

describe("workflow policy", () => {
  it("maps every intent to its workflow bucket", () => {
    expect(workflowForIntent("explain_code")).toBe("fast");
    expect(workflowForIntent("debug_error")).toBe("debug");
    expect(workflowForIntent("write_tests")).toBe("test");
    expect(workflowForIntent("refactor")).toBe("capable");
    expect(workflowForIntent("generate_new_code")).toBe("capable");
    expect(workflowForIntent("general_chat")).toBe("chat");
    expect(workflowForIntent("uncertain")).toBe("default");
    expect(workflowForIntent("something-else")).toBe("default");
  });

  it("is advisory by default: never overrides the user mode", () => {
    const r = resolveRouting(
      { intent: "debug_error", confidence: 0.95, source: "jev" },
      { assist: false, userMode: "auto" },
    );
    expect(r.workflow).toBe("debug");
    expect(r.assistMode).toBeNull();
  });

  it("assist + auto + confident explanation runs lean", () => {
    const r = resolveRouting(
      { intent: "explain_code", confidence: 0.9, source: "jev" },
      { assist: true, userMode: "auto" },
    );
    expect(r.workflow).toBe("fast");
    expect(r.assistMode).toBe("ask");
  });

  it("assist + auto + confident build work runs the full agent", () => {
    const r = resolveRouting(
      { intent: "generate_new_code", confidence: 0.9, source: "fallback" },
      { assist: true, userMode: "auto" },
    );
    expect(r.workflow).toBe("capable");
    expect(r.assistMode).toBe("act");
  });

  it("never overrides an explicit user mode, even in assist", () => {
    for (const mode of ["ask", "plan", "act", "review"]) {
      const r = resolveRouting(
        { intent: "debug_error", confidence: 0.95, source: "jev" },
        { assist: true, userMode: mode },
      );
      expect(r.assistMode).toBeNull();
      expect(r.workflow).toBe("debug");
    }
  });

  it("uncertain decisions keep default routing", () => {
    const r = resolveRouting(
      { intent: "uncertain", confidence: 0, source: "uncertain" },
      { assist: true, userMode: "auto" },
    );
    expect(r.workflow).toBe("default");
    expect(r.assistMode).toBeNull();
  });

  it("low-confidence decisions keep the user mode in assist", () => {
    const r = resolveRouting(
      { intent: "debug_error", confidence: 0.4, source: "jev" },
      { assist: true, userMode: "auto" },
    );
    expect(r.assistMode).toBeNull();
  });
});
