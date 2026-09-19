/**
 * Task history WebView contract tests — message validation, normalization,
 * filter payloads, status/verdict display and duration formatting.
 *
 * Every helper is pure: malformed host payloads can never produce fake rows,
 * and invalid outbound actions are rejected before posting to the host.
 */

import { describe, expect, it } from "vitest";
import {
  normalizeTaskHistoryList,
  normalizeTaskSummary,
  normalizeTaskDetails,
  validateHistoryAction,
  normalizeRunCompare,
  normalizeCheckpointCompare,
  buildHistoryFilterPayload,
  historyStatusMeta,
  compareVerdictMeta,
  formatTaskDuration,
} from "../apps/webview/src/lib/messages.js";

function summary(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-12345678-abcd1234",
    title: "do things",
    promptExcerpt: "do things now",
    status: "completed",
    createdAtMs: 1,
    updatedAtMs: 2,
    messageCount: 2,
    toolCallCount: 1,
    retryCount: 0,
    filesChangedCount: 1,
    checkpointCount: 0,
    hasErrors: false,
    ...overrides,
  };
}

describe("validateHistoryAction (outbound WebView message validation)", () => {
  it("accepts well-formed actions", () => {
    expect(validateHistoryAction("history/list", {}).ok).toBe(true);
    expect(validateHistoryAction("history/details", { taskId: "task-12345678-abcd1234" }).ok).toBe(true);
    expect(
      validateHistoryAction("history/compare", { aTaskId: "task-11111111-aaaaaaaa", bTaskId: "task-22222222-bbbbbbbb" }).ok,
    ).toBe(true);
    expect(
      validateHistoryAction("history/checkpoint-compare", { aCheckpointId: "cp-1-abcdef0123", bCheckpointId: "cp-2-456789abcd" }).ok,
    ).toBe(true);
    expect(validateHistoryAction("history/resume", { taskId: "task-12345678-abcd1234" }).ok).toBe(true);
    expect(validateHistoryAction("history/restart", { taskId: "task-12345678-abcd1234" }).ok).toBe(true);
    expect(validateHistoryAction("history/discard", { taskId: "task-12345678-abcd1234" }).ok).toBe(true);
  });

  it("rejects unknown actions", () => {
    expect(validateHistoryAction("history/nuke", { taskId: "task-12345678-abcd1234" }).ok).toBe(false);
    expect(validateHistoryAction("task/retry", { text: "x" }).ok).toBe(false);
  });

  it("rejects malformed/stale/cross-task ids", () => {
    expect(validateHistoryAction("history/details", { taskId: "nope" }).ok).toBe(false);
    expect(validateHistoryAction("history/details", {}).ok).toBe(false);
    expect(validateHistoryAction("history/resume", { taskId: 42 }).ok).toBe(false);
    expect(
      validateHistoryAction("history/compare", { aTaskId: "task-11111111-aaaaaaaa", bTaskId: "evil" }).ok,
    ).toBe(false);
    expect(
      validateHistoryAction("history/checkpoint-compare", { aCheckpointId: "cp-1-abcdef0123", bCheckpointId: "nope" }).ok,
    ).toBe(false);
  });
});

describe("normalizeTaskHistoryList / normalizeTaskSummary (inbound host payload)", () => {
  it("normalizes rich rows", () => {
    const list = normalizeTaskHistoryList({ tasks: [summary()] });
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("task-12345678-abcd1234");
  });

  it("drops malformed rows instead of rendering fake state", () => {
    const list = normalizeTaskHistoryList({
      tasks: [summary(), null, 42, { id: "BAD" }, { title: "no id" }],
    });
    expect(list).toHaveLength(1);
  });

  it("returns [] for garbage payloads", () => {
    expect(normalizeTaskHistoryList(undefined)).toEqual([]);
    expect(normalizeTaskHistoryList(null)).toEqual([]);
    expect(normalizeTaskHistoryList("nope")).toEqual([]);
    expect(normalizeTaskHistoryList({})).toEqual([]);
  });

  it("bounds untrusted strings", () => {
    const big = "x".repeat(9000);
    const v = normalizeTaskSummary(summary({ title: big, promptExcerpt: big }));
    expect(v!.title.length).toBeLessThanOrEqual(200);
    expect(v!.promptExcerpt.length).toBeLessThanOrEqual(300);
  });
});

describe("normalizeTaskDetails", () => {
  it("normalizes sections with bounds", () => {
    const d = normalizeTaskDetails({
      details: {
        ...summary(),
        timeline: [{ timestampMs: 1, phase: "prompt", kind: "prompt", summary: "hi" }, null],
        files: {
          created: [{ path: "a.ts", changeType: "created", status: "applied", additions: 1, deletions: 0, binary: false }],
          modified: [],
          deleted: [],
          renamed: [],
          totalAdditions: 1,
          totalDeletions: 0,
        },
        checkpoints: [{ checkpointId: "cp-1-abcdef0123", taskId: "t", timestamp: 1, description: "d", fileCount: 1, status: "active", files: ["a.ts"] }],
        messages: [{ role: "user", excerpt: "hi", timestampMs: 1 }],
        tools: [{ name: "bash", count: 1, totalDurationMs: 5 }],
        approvalsNote: "note",
        errors: ["e1"],
        metrics: { toolCallCount: 1, retryCount: 0, filesChangedCount: 1, checkpointCount: 1, messageCount: 2 },
      },
    });
    expect(d?.timeline).toHaveLength(1);
    expect(d?.files.created).toHaveLength(1);
    expect(d?.checkpoints).toHaveLength(1);
    expect(d?.tools).toHaveLength(1);
  });

  it("returns null for garbage", () => {
    expect(normalizeTaskDetails(undefined)).toBeNull();
    expect(normalizeTaskDetails({})).toBeNull();
    expect(normalizeTaskDetails({ details: { id: "BAD" } })).toBeNull();
  });
});

describe("normalizeRunCompare / normalizeCheckpointCompare", () => {
  it("normalizes verdict rows, defaulting unknown verdicts", () => {
    const c = normalizeRunCompare({
      aTaskId: "task-11111111-aaaaaaaa",
      bTaskId: "task-22222222-bbbbbbbb",
      rows: [
        { metric: "status", a: "completed", b: "failed", verdict: "BETTER" },
        { metric: "x", a: "1", b: "2", verdict: "MADE-UP" },
        null,
      ],
    });
    expect(c?.rows).toHaveLength(2);
    expect(c?.rows[0]!.verdict).toBe("BETTER");
    expect(c?.rows[1]!.verdict).toBe("UNKNOWN");
  });

  it("returns null for garbage", () => {
    expect(normalizeRunCompare(undefined)).toBeNull();
    expect(normalizeRunCompare({})).toBeNull();
  });

  it("normalizes checkpoint compare with bounds", () => {
    const c = normalizeCheckpointCompare({
      compare: {
        aId: "cp-1-abcdef0123",
        bId: "cp-2-456789abcd",
        added: ["b.ts"],
        removed: [],
        modified: ["a.ts"],
        renamed: [{ from: "o.ts", to: "n.ts" }],
        unchanged: 3,
        diffs: [
          { path: "a.ts", operation: "modified", additions: 1, deletions: 0, binary: false, unifiedDiff: "+x" },
        ],
        truncated: false,
      },
    });
    expect(c?.added).toEqual(["b.ts"]);
    expect(c?.renamed).toEqual([{ from: "o.ts", to: "n.ts" }]);
    expect(normalizeCheckpointCompare({})).toBeNull();
  });
});

describe("buildHistoryFilterPayload", () => {
  it("builds a bounded backend filter, omitting defaults", () => {
    const p = buildHistoryFilterPayload({
      query: "  login  ",
      status: "all",
      provider: "",
      model: "",
      mode: "all",
      flag: "failed",
    });
    expect(p).toEqual({ query: "login", failedOnly: true, limit: 200 });
  });

  it("maps all flags and fields", () => {
    expect(
      buildHistoryFilterPayload({ query: "", status: "failed", provider: "ollama", model: "m", mode: "act", flag: "all" }),
    ).toEqual({ status: "failed", provider: "ollama", model: "m", mode: "act", limit: 200 });
    expect(
      buildHistoryFilterPayload({ query: "", status: "all", provider: "", model: "", mode: "all", flag: "has-files" }),
    ).toEqual({ hasFiles: true, limit: 200 });
  });
});

describe("historyStatusMeta / compareVerdictMeta / formatTaskDuration", () => {
  it("labels distinctly", () => {
    expect(historyStatusMeta("completed").tone).toBe("green");
    expect(historyStatusMeta("failed").tone).toBe("red");
    expect(historyStatusMeta("interrupted").tone).toBe("orange");
    expect(compareVerdictMeta("BETTER").tone).toBe("green");
    expect(compareVerdictMeta("WORSE").tone).toBe("red");
    expect(compareVerdictMeta("UNKNOWN").tone).toBe("yellow");
  });

  it("formats durations", () => {
    expect(formatTaskDuration(undefined)).toBe("—");
    expect(formatTaskDuration(500)).toBe("500ms");
    expect(formatTaskDuration(1500)).toBe("1.5s");
    expect(formatTaskDuration(120000)).toBe("2m");
  });
});

describe("history state synchronization", () => {
  it("authoritative details replace the stale row", () => {
    const list = [summary({ status: "running" })];
    const details = { ...summary(), status: "completed" };
    const next = list.map((t) => (t.id === details.id ? details : t));
    expect(next[0]!.status).toBe("completed");
  });
});
