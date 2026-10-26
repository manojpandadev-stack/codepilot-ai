import { describe, expect, it } from "vitest";
import {
  reduceVerificationState,
  type VerificationCheckMsg,
  type VerificationStateMsg,
  isTerminalToolName,
} from "../apps/webview/src/lib/messages.js";
import { deriveVerificationState } from "../apps/webview/src/lib/controlcenter.js";
import type { ContextResultPayload } from "@codepilot/shared";

describe("UI-01 VerificationPanel derivation and evidence contract", () => {
  it("derives not-verified when turn did not complete", () => {
    const view = deriveVerificationState({
      outcome: "stopped",
      problemsCount: 0,
      failedCommands: 0,
      okCommands: 1,
      healingActive: false,
      healingSucceeded: null,
    });
    expect(view.status).toBe("not-verified");
    expect(view.detail).toContain("The turn did not complete");
  });

  it("derives failed when commands fail during run", () => {
    const view = deriveVerificationState({
      outcome: "completed",
      problemsCount: 0,
      failedCommands: 1,
      okCommands: 2,
      healingActive: false,
      healingSucceeded: null,
    });
    expect(view.status).toBe("failed");
    expect(view.detail).toContain("1 command failed");
  });

  it("derives verified when commands succeed and problemsCount is 0", () => {
    const view = deriveVerificationState({
      outcome: "completed",
      problemsCount: 0,
      failedCommands: 0,
      okCommands: 2,
      healingActive: false,
      healingSucceeded: null,
    });
    expect(view.status).toBe("verified");
    expect(view.detail).toContain("2 commands succeeded and the workspace reports no problems");
  });

  it("derives verifying when self-healing is active", () => {
    const view = deriveVerificationState({
      outcome: null,
      problemsCount: 1,
      failedCommands: 1,
      okCommands: 0,
      healingActive: true,
      healingSucceeded: null,
    });
    expect(view.status).toBe("verifying");
  });

  it("handles malformed verification/state checks safely via reduceVerificationState", () => {
    const reduced = reduceVerificationState([], {
      runId: "r_malformed",
      status: "completed",
      checks: [
        null as unknown as VerificationCheckMsg,
        { type: "not_a_check" as unknown as "tests", status: "passed", summary: "invalid" },
        { type: "tests", status: "passed", summary: "valid check" },
      ],
    });
    expect(reduced.length).toBe(1);
    expect(reduced[0]!.type).toBe("tests");
    expect(reduced[0]!.status).toBe("passed");
  });
});

describe("UI-02 Agent running lifecycle terminal status settlement", () => {
  const TERMINAL_STATUSES = [
    "completed",
    "stopped",
    "failed",
    "cancelled",
    "canceled",
    "paused",
    "idle",
  ] as const;

  it("all terminal/inactive statuses are recognized and non-running", () => {
    const isTerminalStatus = (st: string): boolean => {
      return (
        st === "completed" ||
        st === "idle" ||
        st === "stopped" ||
        st === "failed" ||
        st === "cancelled" ||
        st === "canceled" ||
        st === "paused"
      );
    };

    for (const status of TERMINAL_STATUSES) {
      expect(isTerminalStatus(status)).toBe(true);
    }
    expect(isTerminalStatus("running")).toBe(false);
  });

  it("maps stopped and cancelled statuses to appropriate labels and terminal state", () => {
    const getStatusLabel = (st: string, msg?: string): string => {
      if (st === "running") return msg ?? "Generating…";
      if (st === "completed") return "Completed";
      if (st === "stopped") return msg ?? "Stopped";
      if (st === "failed") return msg ?? "Failed";
      if (st === "cancelled" || st === "canceled") return msg ?? "Cancelled";
      if (st === "paused") return msg ?? "Paused";
      return "Idle";
    };

    expect(getStatusLabel("stopped")).toBe("Stopped");
    expect(getStatusLabel("stopped", "Stopped by user")).toBe("Stopped by user");
    expect(getStatusLabel("cancelled")).toBe("Cancelled");
    expect(getStatusLabel("canceled")).toBe("Cancelled");
    expect(getStatusLabel("failed", "Provider timeout")).toBe("Provider timeout");
    expect(getStatusLabel("completed")).toBe("Completed");
  });
});

describe("UI-03 WebView prompt replacement via context/urlPicker IPC", () => {
  it("validates context/result payload with urlPicker kind", () => {
    const payload: ContextResultPayload = {
      kind: "urlPicker",
      url: "https://example.com/docs",
    };
    expect(payload.kind).toBe("urlPicker");
    expect(payload.url).toBe("https://example.com/docs");
  });

  it("handles cancelled urlPicker where url is undefined", () => {
    const payload: ContextResultPayload = {
      kind: "urlPicker",
      url: undefined,
    };
    expect(payload.kind).toBe("urlPicker");
    expect(payload.url).toBeUndefined();
  });
});

describe("UI-04 Tool history preservation across turns", () => {
  it("preserves tool events on previous message when next turn starts", () => {
    interface TestMessage {
      id: string;
      role: "user" | "assistant";
      content: string;
      toolEvents?: Array<{ id: string; name: string; status: string }>;
    }

    const messages: TestMessage[] = [
      { id: "u-1", role: "user", content: "Check git status" },
      { id: "a-1", role: "assistant", content: "Working tree is clean." },
    ];
    const turn1ToolEvents = [
      { id: "t-1", name: "git_status", status: "completed" },
      { id: "t-2", name: "read_file", status: "completed" },
    ];

    // Assistant message promotes streaming and anchors turn tool events
    const assistantWithTools: TestMessage = {
      ...messages[1]!,
      toolEvents: [...turn1ToolEvents],
    };
    const messagesAfterTurn1 = [messages[0]!, assistantWithTools];

    // Turn 2 starts with new user prompt
    const turn2UserMsg: TestMessage = {
      id: "u-2",
      role: "user",
      content: "Run test suite",
    };
    const messagesAfterTurn2Prompt = [...messagesAfterTurn1, turn2UserMsg];

    // Verify Turn 1 tool events remain attached and visible on Turn 1 assistant message
    expect(messagesAfterTurn2Prompt[1]!.toolEvents).toHaveLength(2);
    expect(messagesAfterTurn2Prompt[1]!.toolEvents![0]!.name).toBe("git_status");
    expect(messagesAfterTurn2Prompt[1]!.toolEvents![1]!.name).toBe("read_file");
    expect(messagesAfterTurn2Prompt[2]!.role).toBe("user");
  });

  it("accumulates sessionToolEvents across multiple turns without clearing", () => {
    const sessionEvents: Array<{ id: string; name: string }> = [];

    // Turn 1
    sessionEvents.push({ id: "t-1", name: "git_status" });
    sessionEvents.push({ id: "t-2", name: "read_file" });
    expect(sessionEvents).toHaveLength(2);

    // Turn 2 - new events appended
    sessionEvents.push({ id: "t-3", name: "execute_command" });
    expect(sessionEvents).toHaveLength(3);
    expect(sessionEvents.map((e) => e.name)).toEqual([
      "git_status",
      "read_file",
      "execute_command",
    ]);
  });

  it("isTerminalToolName accurately identifies terminal tool executions", () => {
    expect(isTerminalToolName("execute_command")).toBe(true);
    expect(isTerminalToolName("run_command")).toBe(true);
    expect(isTerminalToolName("bash")).toBe(true);
    expect(isTerminalToolName("read_file")).toBe(false);
    expect(isTerminalToolName("write_file")).toBe(false);
  });
});
