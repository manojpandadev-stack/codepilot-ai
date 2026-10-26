import { describe, expect, it } from "vitest";
import {
  applyDiffResult,
  computeDiffStats,
  isActiveChange,
  parseSlashCommand,
  normalizeModelList,
  normalizeProviderList,
  normalizeToolList,
  connectionSummary,
  privacyClaim,
  createStableId,
  appendToolEvent,
  reconcileDiffStatus,
  classifyToolRegistryState,
  isLoadFailureState,
  normalizeTaskPlan,
  normalizeTaskDetails,
  historyStatusMeta,
  validateMetricsAction,
  deriveTaskPhase,
  normalizeRecoveryEvent,
  appendRecoveryEvent,
  recoveryRowView,
  normalizeVerificationCheck,
  reduceVerificationState,
  MAX_RECOVERY_ROWS,
  type FileChange,
  type ToolEventLike,
} from "../apps/webview/src/lib/messages.js";

const SAMPLE_DIFF = [
  "--- a/sample.ts",
  "+++ b/sample.ts",
  "@@ -1,3 +1,4 @@",
  "const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
].join("\n");

const makeChange = (overrides: Partial<FileChange> = {}): FileChange => ({
  path: "src/sample.ts",
  changeSetId: "cs-1",
  changeId: "ch-1",
  status: "modified",
  diff: SAMPLE_DIFF,
  ...overrides,
});

describe("computeDiffStats", () => {
  it("counts additions and deletions, excluding diff headers", () => {
    expect(computeDiffStats(SAMPLE_DIFF)).toEqual({
      additions: 2,
      deletions: 1,
    });
  });

  it("returns zeros for undefined or header-only diffs", () => {
    expect(computeDiffStats(undefined)).toEqual({ additions: 0, deletions: 0 });
    expect(computeDiffStats("--- a\n+++ b")).toEqual({
      additions: 0,
      deletions: 0,
    });
  });
});

describe("applyDiffResult", () => {
  it("single accept marks only that change applied and keeps it visible for rollback", () => {
    const changes = [
      makeChange({ changeId: "ch-1" }),
      makeChange({ changeId: "ch-2", path: "src/other.ts" }),
    ];
    const result = applyDiffResult(changes, "accept", {
      changeSetId: "cs-1",
      changeId: "ch-1",
      success: true,
    });
    expect(result.changes.find((c) => c.changeId === "ch-1")?.status).toBe(
      "applied",
    );
    expect(result.changes.find((c) => c.changeId === "ch-2")?.status).toBe(
      "modified",
    );
    expect(result.pendingApproval).toBe(true);
  });

  it("pendingApproval clears when the last active change is accepted", () => {
    const changes = [
      makeChange({ changeId: "ch-1", status: "applied" }),
      makeChange({ changeId: "ch-2" }),
    ];
    const result = applyDiffResult(changes, "accept", {
      changeSetId: "cs-1",
      changeId: "ch-2",
      success: true,
    });
    expect(result.pendingApproval).toBe(false);
  });

  it("single reject removes only that change", () => {
    const changes = [
      makeChange({ changeId: "ch-1" }),
      makeChange({ changeId: "ch-2", path: "b.ts" }),
    ];
    const result = applyDiffResult(changes, "reject", {
      changeSetId: "cs-1",
      changeId: "ch-1",
      success: true,
    });
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]!.changeId).toBe("ch-2");
  });

  it("accept_all marks the whole set applied", () => {
    const changes = [
      makeChange({ changeId: "ch-1" }),
      makeChange({ changeId: "ch-2" }),
    ];
    const result = applyDiffResult(changes, "accept_all", {
      changeSetId: "cs-1",
      success: true,
    });
    expect(result.changes.every((c) => c.status === "applied")).toBe(true);
    expect(result.pendingApproval).toBe(false);
  });

  it("reject_all removes the whole set but never touches other sets", () => {
    const changes = [
      makeChange({ changeId: "ch-1" }),
      makeChange({ changeSetId: "cs-2", changeId: "ch-9" }),
    ];
    const result = applyDiffResult(changes, "reject_all", {
      changeSetId: "cs-1",
      success: true,
    });
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]!.changeSetId).toBe("cs-2");
  });

  it("rollback marks the change rolled_back and closes approval (engine treats it as terminal)", () => {
    const changes = [makeChange({ status: "applied" })];
    const result = applyDiffResult(changes, "rollback", {
      changeSetId: "cs-1",
      changeId: "ch-1",
      success: true,
    });
    expect(result.changes[0]!.status).toBe("rolled_back");
    expect(result.pendingApproval).toBe(false);
  });

  it("failure keeps the list untouched and surfaces the error", () => {
    const changes = [makeChange()];
    const result = applyDiffResult(changes, "accept", {
      changeSetId: "cs-1",
      changeId: "ch-1",
      success: false,
      error: "conflict",
    });
    expect(result.changes).toEqual(changes);
    expect(result.pendingApproval).toBe(true);
    expect(result.error).toBe("conflict");
  });
});

describe("isActiveChange", () => {
  it("is true for pending states and false for applied/rolled_back", () => {
    expect(isActiveChange(makeChange({ status: "added" }))).toBe(true);
    expect(isActiveChange(makeChange({ status: "applied" }))).toBe(false);
    expect(isActiveChange(makeChange({ status: "rolled_back" }))).toBe(false);
  });

  it("is false after rollback", () => {
    expect(isActiveChange(makeChange({ status: "rolled_back" }))).toBe(false);
  });
});

describe("parseSlashCommand", () => {
  it("parses known commands with args", () => {
    expect(parseSlashCommand("/plan review the auth module")).toEqual({
      command: "plan",
      args: "review the auth module",
      prompt: "review the auth module",
      instruction: "",
    });
  });

  it("parses UI-only commands with empty prompt", () => {
    expect(parseSlashCommand("/clear")).toEqual({
      command: "clear",
      args: "",
      prompt: "",
      instruction: "",
    });
  });

  it("passes unknown slash input through as a normal prompt", () => {
    const result = parseSlashCommand("/nope do a thing");
    expect(result.command).toBe("");
    expect(result.prompt).toBe("/nope do a thing");
  });

  it("passes plain text through unchanged", () => {
    expect(parseSlashCommand("  fix the bug  ")).toEqual({
      command: "",
      args: "",
      prompt: "fix the bug",
      instruction: "",
    });
  });

  it("is case-insensitive", () => {
    expect(parseSlashCommand("/ACT").command).toBe("act");
  });
});

describe("normalizeModelList", () => {
  it("accepts a bare array payload", () => {
    const models = [{ id: "qwen3:8b", name: "qwen3:8b", provider: "ollama" }];
    // Entries gain the defensive toolCalling tri-state (absent → "unknown").
    expect(normalizeModelList(models)).toEqual([
      { ...models[0], toolCalling: "unknown" },
    ]);
  });

  it("accepts a { models } wrapper payload", () => {
    const models = [{ id: "m", name: "m", provider: "ollama" }];
    expect(normalizeModelList({ models })).toEqual([
      { ...models[0], toolCalling: "unknown" },
    ]);
  });

  it("returns an empty array for null or malformed payloads", () => {
    expect(normalizeModelList(null)).toEqual([]);
    expect(normalizeModelList(undefined)).toEqual([]);
    expect(normalizeModelList({})).toEqual([]);
    expect(normalizeModelList("nope")).toEqual([]);
  });
});

describe("normalizeProviderList", () => {
  it("accepts a bare array payload and derives connected from the typed state", () => {
    // BUG 1: entries carry the typed ConnectionState; `connected` is derived
    // (true ONLY for state "connected"), legacy connected-only entries map
    // through providerStateOf.
    const providers = [
      { id: "ollama", name: "Ollama (Local)", state: "connected" as const },
    ];
    expect(normalizeProviderList(providers)).toEqual([
      {
        id: "ollama",
        name: "Ollama (Local)",
        state: "connected",
        connected: true,
      },
    ]);
    expect(
      normalizeProviderList([{ id: "or", name: "OR", connected: true }]),
    ).toEqual([{ id: "or", name: "OR", state: "connected", connected: true }]);
  });

  it("returns an empty array for malformed payloads", () => {
    expect(normalizeProviderList(null)).toEqual([]);
    expect(normalizeProviderList(42)).toEqual([]);
  });
});

describe("normalizeToolList", () => {
  it("accepts a { tools } wrapper payload", () => {
    const tools = [
      {
        name: "read_files",
        category: "read",
        description: "Read files",
        source: "builtin",
        permission: "auto",
      },
    ];
    expect(normalizeToolList({ tools })).toEqual(tools);
  });

  it("accepts a bare array payload", () => {
    const tools = [
      {
        name: "bash",
        category: "execute",
        description: "",
        source: "builtin",
        permission: "approval",
      },
    ];
    expect(normalizeToolList(tools)).toEqual(tools);
  });

  it("drops malformed entries and defaults unknown permissions to approval", () => {
    const result = normalizeToolList({
      tools: [
        null,
        42,
        { name: "" },
        { category: "read" },
        {
          name: "web_fetch",
          source: "mcp",
          serverName: "docs",
          permission: "weird",
        },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: "web_fetch",
      category: "system",
      description: "",
      source: "mcp",
      serverName: "docs",
      permission: "approval",
    });
  });

  it("returns an empty array for malformed payloads", () => {
    expect(normalizeToolList(null)).toEqual([]);
    expect(normalizeToolList({})).toEqual([]);
    expect(normalizeToolList("nope")).toEqual([]);
  });
});

describe("connectionSummary", () => {
  const ollamaCatalog = {
    id: "ollama",
    displayName: "Ollama",
    category: "local" as const,
  };
  const openrouterCatalog = {
    id: "openrouter",
    displayName: "OpenRouter",
    category: "gateway" as const,
  };

  it("A: selected Ollama + Ollama connected → LOCAL / Ollama connected", () => {
    const summary = connectionSummary({
      selectedProviderId: "ollama",
      catalog: ollamaCatalog as never,
      health: { state: "connected" },
      credentialConfigured: true,
      modelCount: 3,
    });
    expect(summary.connected).toBe(true);
    expect(summary.label).toContain("Ollama");
    expect(summary.label).toContain("Connected");
  });

  it("B: OpenRouter selected while Ollama happens to be up → OpenRouter status only", () => {
    // The old bug: first-connected heuristic reported Ollama for any selection.
    // The header must reflect ONLY the selected provider's own health.
    const summary = connectionSummary({
      selectedProviderId: "openrouter",
      catalog: openrouterCatalog as never,
      health: { state: "connected" },
      credentialConfigured: true,
      modelCount: 284,
    });
    expect(summary.connected).toBe(true);
    expect(summary.label).toContain("OpenRouter");
    expect(summary.label).not.toMatch(/ollama/i);
  });

  it("B2: unprobed cloud provider with a stored key stays neutral (CLOUD · name)", () => {
    const summary = connectionSummary({
      selectedProviderId: "openrouter",
      catalog: openrouterCatalog as never,
      health: undefined,
      credentialConfigured: true,
      modelCount: 0,
    });
    expect(summary.label).toMatch(/^CLOUD · OpenRouter$/);
    expect(summary.connected).toBe(false);
  });

  it("C: OpenRouter selected + Ollama unavailable → no Ollama text at all", () => {
    const summary = connectionSummary({
      selectedProviderId: "openrouter",
      catalog: openrouterCatalog as never,
      health: undefined,
      credentialConfigured: false,
      modelCount: 0,
    });
    expect(summary.label).not.toMatch(/ollama/i);
    expect(summary.label).toMatch(/OpenRouter/);
  });

  it("C2: selected local provider down → unavailable message names it", () => {
    const summary = connectionSummary({
      selectedProviderId: "ollama",
      catalog: ollamaCatalog as never,
      health: { state: "unavailable" },
      credentialConfigured: true,
      modelCount: 0,
    });
    expect(summary.connected).toBe(false);
    expect(summary.label).toMatch(/Ollama unavailable/i);
  });

  it("reports an empty selection as unknown", () => {
    const summary = connectionSummary({
      selectedProviderId: "",
      catalog: undefined,
      health: undefined,
      credentialConfigured: undefined,
      modelCount: 0,
    });
    expect(summary.connected).toBe(false);
    expect(summary.label).toContain("—");
  });

  it("never reports connected without a positive host verdict", () => {
    // No health data + no credential → must NOT claim connected.
    const summary = connectionSummary({
      selectedProviderId: "openai-native",
      catalog: {
        id: "openai-native",
        displayName: "OpenAI",
        category: "cloud" as const,
      } as never,
      health: undefined,
      credentialConfigured: false,
      modelCount: 0,
    });
    expect(summary.connected).toBe(false);
    expect(summary.label).toMatch(/not verified/i);
  });
});

describe("privacyClaim", () => {
  it("G: cloud provider + local privacy mode must NOT claim local-only", () => {
    const text = privacyClaim("local", "cloud");
    expect(text).toMatch(/requests WILL leave this machine/i);
    expect(text).not.toMatch(/no data leaves this machine/i);
  });

  it("G: gateway provider + local privacy mode is equally flagged", () => {
    const text = privacyClaim("local", "gateway");
    expect(text).toMatch(/WILL leave this machine/i);
  });

  it("local provider + local privacy mode keeps the local-only promise", () => {
    const text = privacyClaim("local", "local");
    expect(text).toMatch(/no data leaves this machine/i);
  });

  it("cloud/hybrid modes describe their behavior unchanged", () => {
    expect(privacyClaim("cloud", "cloud")).toMatch(/configured API provider/i);
    expect(privacyClaim("hybrid", "local")).toMatch(/selected tasks/i);
  });
});

describe("createStableId", () => {
  it("generates unique ids even within the same millisecond", () => {
    const ids = new Set(Array.from({ length: 500 }, () => createStableId("msg")));
    expect(ids.size).toBe(500);
  });

  it("uses the requested prefix", () => {
    expect(createStableId("assistant").startsWith("assistant-")).toBe(true);
  });
});

describe("connectionSummary (live connections)", () => {
  const base = {
    selectedProviderId: "ollama",
    credentialConfigured: true,
    modelCount: 3,
  };

  it("host live connection verdict wins when present", () => {
    const summary = connectionSummary({
      ...base,
      liveConnections: [{ id: "ollama", connected: true }],
    });
    expect(summary.connected).toBe(true);
    expect(summary.label).toMatch(/Connected/);
  });

  it("offline local provider is reported unavailable, not connected", () => {
    const summary = connectionSummary({
      ...base,
      liveConnections: [{ id: "ollama", connected: false }],
    });
    expect(summary.connected).toBe(false);
    expect(summary.label).toMatch(/unavailable/i);
  });

  it("falls back to previous behavior when no live state exists", () => {
    const summary = connectionSummary({ ...base, liveConnections: [] });
    expect(summary.connected).toBe(false);
  });
});

describe("appendToolEvent", () => {
  const started = (id: string): ToolEventLike => ({
    id,
    name: "execute_command",
    status: "started",
  });

  it("appends a new tool event", () => {
    const next = appendToolEvent([], started("t1"));
    expect(next).toHaveLength(1);
    expect(next[0]!.id).toBe("t1");
  });

  it("does not duplicate a replayed tool/started event", () => {
    const once = appendToolEvent([], started("t1"));
    const twice = appendToolEvent(once, started("t1"));
    expect(twice).toHaveLength(1);
  });

  it("a late started event cannot resurrect a completed tool", () => {
    const withCompleted = appendToolEvent([], {
      id: "t1",
      name: "execute_command",
      status: "completed",
    });
    const next = appendToolEvent(withCompleted, started("t1"));
    expect(next).toHaveLength(1);
    expect(next[0]!.status).toBe("completed");
  });

  it("preserves other events and their order", () => {
    const two = appendToolEvent(appendToolEvent([], started("a")), started("b"));
    const next = appendToolEvent(two, started("b"));
    expect(next.map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("reconcileDiffStatus", () => {
  const changes: FileChange[] = [
    { path: "a.ts", changeSetId: "cs", changeId: "ch-1", status: "modified" },
    { path: "b.ts", changeSetId: "cs", changeId: "ch-2", status: "added" },
  ];

  it("applies host status transitions by changeId", () => {
    const next = reconcileDiffStatus(changes, {
      changeId: "ch-1",
      status: "applied",
    });
    expect(next[0]!.status).toBe("applied");
    expect(next[1]!.status).toBe("added");
  });

  it("falls back to filePath matching when changeId is absent", () => {
    const next = reconcileDiffStatus(changes, { filePath: "b.ts", status: "applied" });
    expect(next[1]!.status).toBe("applied");
    expect(next[0]!.status).toBe("modified");
  });

  it("ignores unknown status values (fail-safe)", () => {
    const next = reconcileDiffStatus(changes, {
      changeId: "ch-1",
      status: "frobnicated",
    });
    expect(next).toEqual(changes);
  });

  it("ignores malformed payloads", () => {
    expect(reconcileDiffStatus(changes, null)).toEqual(changes);
    expect(reconcileDiffStatus(changes, {})).toEqual(changes);
  });
});

describe("classifyToolRegistryState (tools/list_result)", () => {
  it("runtime-not-ready is distinct from an empty ready registry", () => {
    const notReady = classifyToolRegistryState({ tools: [], runtimeReady: false });
    expect(notReady.state).toBe("runtime-not-ready");
    expect(notReady.tools).toEqual([]);

    const readyEmpty = classifyToolRegistryState({ tools: [], runtimeReady: true });
    expect(readyEmpty.state).toBe("available");
    expect(readyEmpty.tools).toEqual([]);
  });

  it("a ready runtime with tools classifies as available", () => {
    const result = classifyToolRegistryState({
      tools: [{ name: "read_file", category: "fs" }],
      runtimeReady: true,
    });
    expect(result.state).toBe("available");
    expect(result.tools).toHaveLength(1);
  });

  it("an error payload is a failure, never silently empty", () => {
    const result = classifyToolRegistryState({ error: "registry exploded" });
    expect(result.state).toBe("error");
    expect(result.tools).toEqual([]);
  });

  it("a missing runtimeReady defaults to available (host contract)", () => {
    expect(classifyToolRegistryState({ tools: [] }).state).toBe("available");
  });
});

describe("isLoadFailureState (skills/teams panels)", () => {
  it("failure with no data renders the failure state, not empty", () => {
    expect(isLoadFailureState("backend unavailable", 0)).toBe(true);
  });

  it("a genuine empty discovery is not a failure", () => {
    expect(isLoadFailureState(null, 0)).toBe(false);
    expect(isLoadFailureState("", 0)).toBe(false);
  });

  it("an error with previously loaded data keeps the data visible", () => {
    expect(isLoadFailureState("backend unavailable", 3)).toBe(false);
  });
});


// ---------------------------------------------------- plan / paused payloads
describe("normalizeTaskPlan (host-pushed plan payloads)", () => {
  const VALID = {
    version: 1,
    id: "plan-1",
    objective: "Ship it",
    createdAtMs: 1,
    updatedAtMs: 2,
    steps: [
      {
        id: "step-1",
        title: "first",
        status: "running",
        attempts: 1,
        dependsOn: [],
        affectedFiles: ["src/a.ts"],
        note: "wip",
      },
      { id: "step-2", title: "second", status: "pending" },
    ],
    currentStepId: "step-1",
  };

  it("accepts a bare plan and a { plan } envelope", () => {
    const bare = normalizeTaskPlan(VALID);
    expect(bare?.objective).toBe("Ship it");
    expect(bare?.currentStepId).toBe("step-1");
    expect(bare?.steps[0]).toMatchObject({
      id: "step-1",
      status: "running",
      attempts: 1,
      note: "wip",
      affectedFiles: ["src/a.ts"],
    });
    const wrapped = normalizeTaskPlan({ plan: VALID, requestId: "r-1" });
    expect(wrapped?.steps).toHaveLength(2);
  });

  it("null for null / non-object / missing fields (never renders junk)", () => {
    expect(normalizeTaskPlan(null)).toBeNull();
    expect(normalizeTaskPlan("plan text")).toBeNull();
    expect(normalizeTaskPlan({ objective: "no steps" })).toBeNull();
    expect(normalizeTaskPlan({ steps: [] })).toBeNull(); // empty objective/steps
    expect(
      normalizeTaskPlan({ objective: "x", steps: "nope" }),
    ).toBeNull();
  });

  it("rejects unknown step statuses and empty step lists", () => {
    expect(
      normalizeTaskPlan({
        objective: "x",
        steps: [{ id: "s", title: "t", status: "sideways" }],
      }),
    ).toBeNull();
    expect(normalizeTaskPlan({ objective: "x", steps: [] })).toBeNull();
  });

  it("bounds oversized plans instead of rendering them", () => {
    const many = Array.from({ length: 51 }, (_, i) => ({
      id: `s${i}`,
      title: `t${i}`,
      status: "pending",
    }));
    expect(normalizeTaskPlan({ objective: "x", steps: many })).toBeNull();
    expect(
      normalizeTaskPlan({ objective: "x".repeat(1001), steps: VALID.steps }),
    ).toBeNull();
    // Long-but-within-limit text is sliced, not rejected.
    const sliced = normalizeTaskPlan({
      objective: "y".repeat(900),
      steps: [{ id: "s", title: "t".repeat(500), status: "pending" }],
    });
    expect(sliced?.steps[0]?.title.length).toBe(400);
  });
});

describe("paused status in the WebView", () => {
  it("historyStatusMeta renders PAUSED with the orange tone", () => {
    expect(historyStatusMeta("paused")).toEqual({
      label: "PAUSED",
      tone: "orange",
    });
    expect(historyStatusMeta("interrupted")).toEqual({
      label: "INTERRUPTED",
      tone: "orange",
    });
  });

  it("validateMetricsAction accepts status=paused and rejects unknowns", () => {
    expect(
      validateMetricsAction("metrics/dashboard", { status: "paused" }),
    ).toEqual({ ok: true });
    expect(
      validateMetricsAction("metrics/dashboard", { status: "exploded" }),
    ).toMatchObject({ ok: false });
    expect(validateMetricsAction("metrics/nope", {})).toMatchObject({
      ok: false,
    });
  });
});

describe("normalizeTaskDetails carries the structured plan", () => {
  const DETAILS = {
    details: {
      id: "task-1700000000000-abc123",
      title: "paused task",
      status: "paused",
      createdAtMs: 1,
      updatedAtMs: 2,
      plan: {
        version: 1,
        id: "plan-9",
        objective: "Resume-ready plan",
        createdAtMs: 1,
        updatedAtMs: 2,
        steps: [{ id: "step-1", title: "one", status: "completed" }],
      },
    },
  };

  it("passes a valid plan through to the renderer", () => {
    const out = normalizeTaskDetails(DETAILS);
    expect(out).not.toBeNull();
    expect(out!.status).toBe("paused");
    expect(out!.plan?.objective).toBe("Resume-ready plan");
    expect(out!.plan?.steps[0]?.status).toBe("completed");
  });

  it("drops a malformed plan without dropping the whole details payload", () => {
    const out = normalizeTaskDetails({
      details: { ...DETAILS.details, plan: { nope: true } },
    });
    expect(out).not.toBeNull();
    expect(out!.plan).toBeUndefined();
  });
});

describe("task phase derivation (F-04)", () => {
  it("blocking states win: approval over healing over outcome", () => {
    expect(
      deriveTaskPhase({
        isRunning: true,
        statusMessage: "",
        pendingApprovals: 2,
        healingActive: true,
        outcome: "failed",
      }),
    ).toBe("approval");
    expect(
      deriveTaskPhase({
        isRunning: true,
        statusMessage: "",
        pendingApprovals: 0,
        healingActive: true,
        outcome: null,
      }),
    ).toBe("healing");
  });

  it("settled outcomes map when idle", () => {
    const base = {
      isRunning: false,
      statusMessage: "",
      pendingApprovals: 0,
      healingActive: false,
    };
    expect(deriveTaskPhase({ ...base, outcome: "completed" })).toBe("completed");
    expect(deriveTaskPhase({ ...base, outcome: "failed" })).toBe("failed");
    expect(deriveTaskPhase({ ...base, outcome: "stopped" })).toBe("stopped");
    expect(deriveTaskPhase({ ...base, outcome: "paused" })).toBe("paused");
    expect(deriveTaskPhase({ ...base, outcome: null })).toBe("idle");
  });

  it("running tools map to their category; unknown names fall back honestly", () => {
    const running = {
      isRunning: true,
      statusMessage: "",
      pendingApprovals: 0,
      healingActive: false,
      outcome: null,
    } as const;
    expect(deriveTaskPhase({ ...running, runningToolName: "read_files" })).toBe("reading");
    expect(deriveTaskPhase({ ...running, runningToolName: "editor" })).toBe("editing");
    expect(deriveTaskPhase({ ...running, runningToolName: "bash" })).toBe("command");
    expect(deriveTaskPhase({ ...running, runningToolName: "search_codebase" })).toBe("searching");
    expect(deriveTaskPhase({ ...running, runningToolName: "git_diff" })).toBe("git");
    expect(deriveTaskPhase({ ...running, runningToolName: "web_fetch" })).toBe("web");
    expect(deriveTaskPhase({ ...running, runningToolName: "plan" })).toBe("planning");
    expect(deriveTaskPhase({ ...running, runningToolName: "mystery_tool" })).toBe("working");
    expect(
      deriveTaskPhase({ ...running, statusMessage: "Thinking through the plan" }),
    ).toBe("thinking");
  });
});

describe("recovery timeline contract (F-04)", () => {
  const VALID = {
    phase: "FAILURE_DETECTED",
    attempt: 1,
    maxAttempts: 3,
    timestamp: 1_700_000_000_000,
    category: "TEST_FAILURE",
    summary: "vitest run failed",
  };

  it("normalizes a host recovery/event payload", () => {
    expect(normalizeRecoveryEvent(VALID)).toEqual(VALID);
  });

  it("drops malformed payloads instead of fabricating rows", () => {
    expect(normalizeRecoveryEvent(null)).toBeNull();
    expect(normalizeRecoveryEvent({ phase: "NOPE", attempt: 1, maxAttempts: 3, timestamp: 1 })).toBeNull();
    expect(normalizeRecoveryEvent({ ...VALID, phase: "" })).toBeNull();
    expect(normalizeRecoveryEvent({ ...VALID, attempt: -1 })).toBeNull();
  });

  it("appends bounded rows, oldest drop first", () => {
    let rows = appendRecoveryEvent([], VALID);
    expect(rows).toHaveLength(1);
    expect(appendRecoveryEvent(rows, null)).toHaveLength(1);
    for (let i = 0; i < MAX_RECOVERY_ROWS + 5; i += 1) {
      rows = appendRecoveryEvent(rows, { ...VALID, attempt: i });
    }
    expect(rows).toHaveLength(MAX_RECOVERY_ROWS);
  });

  it("maps phases to honest rows (partial success is never done)", () => {
    expect(
      recoveryRowView(normalizeRecoveryEvent(VALID)!),
    ).toMatchObject({ kind: "failure", state: "error" });
    expect(
      recoveryRowView(
        normalizeRecoveryEvent({ ...VALID, phase: "RECOVERY_COMPLETED", status: "SUCCESS" })!,
      ),
    ).toMatchObject({ kind: "completion", state: "done", label: "Recovery succeeded" });
    const partial = recoveryRowView(
      normalizeRecoveryEvent({ ...VALID, phase: "RECOVERY_COMPLETED", status: "PARTIAL_SUCCESS" })!,
    );
    expect(partial.state).toBe("error");
    expect(partial.label).not.toBe("Recovery succeeded");
  });
});

describe("verification state reducer (F-04)", () => {
  const check = (type: "tests" | "build" | "typecheck" | "security", status: "passed" | "running" | "failed") => ({
    type,
    status,
    summary: `${type}:${status}`,
  });

  it("merges in stable order and never downgrades settled checks", () => {
    const settled = reduceVerificationState(
      [],
      { runId: "r1", status: "completed", checks: [check("tests", "passed")] },
    );
    expect(
      reduceVerificationState(settled, {
        runId: "r1",
        status: "running",
        checks: [check("tests", "running")],
      })[0]!.status,
    ).toBe("passed");
    const ordered = reduceVerificationState(
      [],
      {
        runId: "r1",
        status: "completed",
        checks: [check("security", "passed"), check("tests", "passed")],
      },
    );
    expect(ordered.map((c) => c.type)).toEqual(["tests", "security"]);
  });
});

describe("verification check contract (F-04)", () => {
  it("normalizes engine check results", () => {
    expect(
      normalizeVerificationCheck({ type: "tests", status: "failed", summary: "3 failed", exitCode: 1 }),
    ).toEqual({ type: "tests", status: "failed", summary: "3 failed", exitCode: 1 });
  });

  it("rejects unknown types, statuses, and empty summaries", () => {
    expect(normalizeVerificationCheck({ type: "lint", status: "passed", summary: "ok" })).toBeNull();
    expect(normalizeVerificationCheck({ type: "tests", status: "weird", summary: "ok" })).toBeNull();
    expect(normalizeVerificationCheck({ type: "tests", status: "passed", summary: "" })).toBeNull();
    expect(normalizeVerificationCheck(null)).toBeNull();
  });
});
