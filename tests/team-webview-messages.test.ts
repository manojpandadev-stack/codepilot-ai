/**
 * Team WebView contract tests — message validation, normalization, status
 * display, DAG grouping and role labels.
 *
 * Every helper is pure: malformed host payloads can never produce fake rows,
 * and invalid outbound actions are rejected before posting to the host.
 */

import { describe, expect, it } from "vitest";
import {
  normalizeTeamList,
  normalizeTeamView,
  normalizeTeamTask,
  normalizeTeamDetails,
  validateTeamAction,
  teamStatusMeta,
  groupTasksByLevel,
  teamRoleLabel,
  type TeamView,
  type TeamTaskView,
} from "../apps/webview/src/lib/messages.js";

function task(overrides: Partial<TeamTaskView> = {}): TeamTaskView {
  return {
    taskId: "task-1",
    role: "coder",
    roleLabel: "Implementer",
    description: "do work",
    dependencies: [],
    dependents: [],
    level: 0,
    status: "pending",
    retryCount: 0,
    maxRetries: 1,
    files: [],
    ...overrides,
  };
}

function team(overrides: Partial<TeamView> = {}): TeamView {
  return {
    teamId: "team-12345678-abcd1234",
    taskId: "task-1",
    objective: "implement caching",
    mode: "act",
    status: "idle",
    roles: ["architect", "coder"],
    maxConcurrency: 2,
    tasks: [],
    locks: [],
    runCount: 0,
    createdAtMs: 1,
    updatedAtMs: 2,
    completedCount: 0,
    failedCount: 0,
    ...overrides,
  };
}

describe("validateTeamAction (outbound WebView message validation)", () => {
  it("accepts well-formed actions", () => {
    expect(validateTeamAction("team/list", {}).ok).toBe(true);
    expect(validateTeamAction("team/create", { objective: "do x" }).ok).toBe(true);
    expect(
      validateTeamAction("team/create", { objective: "do x", roles: ["coder"], maxConcurrency: 2 }).ok,
    ).toBe(true);
    expect(validateTeamAction("team/start", { teamId: "team-123-abc" }).ok).toBe(true);
    expect(validateTeamAction("team/cancel", { teamId: "team-123-abc", runId: "run-1-a" }).ok).toBe(true);
    expect(validateTeamAction("team/retry", { teamId: "team-123-abc" }).ok).toBe(true);
    expect(validateTeamAction("team/remove", { teamId: "team-123-abc" }).ok).toBe(true);
    expect(validateTeamAction("team/details", { teamId: "team-123-abc" }).ok).toBe(true);
  });

  it("rejects unknown actions", () => {
    expect(validateTeamAction("team/nuke", { teamId: "team-123-abc" }).ok).toBe(false);
    expect(validateTeamAction("chat/send", {}).ok).toBe(false);
  });

  it("rejects malformed ids (unknown/stale/cross-task blocked at both layers)", () => {
    expect(validateTeamAction("team/start", { teamId: "nope" }).ok).toBe(false);
    expect(validateTeamAction("team/start", {}).ok).toBe(false);
    expect(validateTeamAction("team/cancel", { teamId: "team-123-abc", runId: "bogus" }).ok).toBe(false);
    expect(validateTeamAction("team/details", { teamId: 42 }).ok).toBe(false);
  });

  it("rejects malformed create payloads", () => {
    expect(validateTeamAction("team/create", { objective: "" }).ok).toBe(false);
    expect(validateTeamAction("team/create", {}).ok).toBe(false);
    expect(validateTeamAction("team/create", { objective: "x", roles: [] }).ok).toBe(false);
    expect(validateTeamAction("team/create", { objective: "x", roles: ["coder", "coder", "coder", "coder", "coder", "coder", "coder"] }).ok).toBe(false);
    expect(validateTeamAction("team/create", { objective: "x", maxConcurrency: 99 }).ok).toBe(false);
    expect(validateTeamAction("team/create", { objective: "x", mode: "yolo" }).ok).toBe(false);
  });
});

describe("normalizeTeamList / normalizeTeamView (inbound host payload)", () => {
  it("normalizes a rich payload", () => {
    const list = normalizeTeamList({
      teams: [team({ tasks: [task()], locks: [{ file: "src/a.ts", holderTaskId: "task-1", holderRole: "Implementer", acquiredAtMs: 5 }] })],
    });
    expect(list).toHaveLength(1);
    expect(list[0]!.tasks).toHaveLength(1);
    expect(list[0]!.locks).toHaveLength(1);
  });

  it("drops malformed rows instead of rendering fake state", () => {
    const list = normalizeTeamList({
      teams: [team(), null, 42, { teamId: "BAD!!" }, { objective: "no id" }],
    });
    expect(list).toHaveLength(1);
  });

  it("returns empty state for garbage payloads", () => {
    expect(normalizeTeamList(undefined)).toEqual([]);
    expect(normalizeTeamList(null)).toEqual([]);
    expect(normalizeTeamList("nope")).toEqual([]);
    expect(normalizeTeamList({})).toEqual([]);
  });

  it("bounds untrusted string lengths", () => {
    const big = "x".repeat(5000);
    const v = normalizeTeamView(team({ objective: big }));
    expect(v!.objective.length).toBeLessThanOrEqual(2000);
  });

  it("falls back safely on unknown task status", () => {
    const t = normalizeTeamTask(task({ status: "teleporting" as never }));
    expect(t!.status).toBe("pending");
  });
});

describe("normalizeTeamDetails", () => {
  it("extracts the team view", () => {
    expect(
      normalizeTeamDetails({ team: team({ teamId: "team-9999-zzzzzzzz" }) })?.teamId,
    ).toBe("team-9999-zzzzzzzz");
  });

  it("returns null for garbage", () => {
    expect(normalizeTeamDetails(undefined)).toBeNull();
    expect(normalizeTeamDetails({})).toBeNull();
    expect(normalizeTeamDetails({ team: { teamId: "BAD" } })).toBeNull();
  });
});

describe("teamStatusMeta", () => {
  it("labels team and task statuses distinctly", () => {
    expect(teamStatusMeta("running").tone).toBe("blue");
    expect(teamStatusMeta("completed").tone).toBe("green");
    expect(teamStatusMeta("failed").tone).toBe("red");
    expect(teamStatusMeta("cancelled").tone).toBe("yellow");
    expect(teamStatusMeta("interrupted").tone).toBe("orange");
    expect(teamStatusMeta("pending").label).toBe("QUEUED");
    expect(teamStatusMeta("blocked").tone).toBe("red");
    expect(teamStatusMeta("retrying").tone).toBe("orange");
  });
});

describe("groupTasksByLevel (DAG tree)", () => {
  it("groups roots first, parallel tasks together, join last", () => {
    const tasks = [
      task({ taskId: "task-1", level: 0 }),
      task({ taskId: "task-2", level: 1 }),
      task({ taskId: "task-3", level: 1 }),
      task({ taskId: "task-4", level: 2 }),
    ];
    const levels = groupTasksByLevel(tasks);
    expect(levels.length).toBe(3);
    expect(levels[0]!.map((t) => t.taskId)).toEqual(["task-1"]);
    expect(levels[1]!.map((t) => t.taskId)).toEqual(["task-2", "task-3"]);
    expect(levels[2]!.map((t) => t.taskId)).toEqual(["task-4"]);
  });

  it("handles empty input", () => {
    expect(groupTasksByLevel([])).toEqual([]);
  });
});

describe("teamRoleLabel", () => {
  it("maps engine roles to friendly names", () => {
    expect(teamRoleLabel("architect")).toBe("Planner");
    expect(teamRoleLabel("coder")).toBe("Implementer");
    expect(teamRoleLabel("tester")).toBe("Tester");
    expect(teamRoleLabel("reviewer")).toBe("Reviewer");
  });
});

describe("team state synchronization", () => {
  it("authoritative details replace the stale row", () => {
    const list = [team({ teamId: "team-1111-aaaaaaaa", status: "running" })];
    const details = team({ teamId: "team-1111-aaaaaaaa", status: "completed" });
    const next = list.map((t) => (t.teamId === details.teamId ? details : t));
    expect(next[0]!.status).toBe("completed");
  });
});
