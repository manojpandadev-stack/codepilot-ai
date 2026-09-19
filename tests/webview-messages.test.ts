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
  type FileChange,
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
    expect(normalizeModelList(models)).toEqual(models);
  });

  it("accepts a { models } wrapper payload", () => {
    const models = [{ id: "m", name: "m", provider: "ollama" }];
    expect(normalizeModelList({ models })).toEqual(models);
  });

  it("returns an empty array for null or malformed payloads", () => {
    expect(normalizeModelList(null)).toEqual([]);
    expect(normalizeModelList(undefined)).toEqual([]);
    expect(normalizeModelList({})).toEqual([]);
    expect(normalizeModelList("nope")).toEqual([]);
  });
});

describe("normalizeProviderList", () => {
  it("accepts a bare array payload", () => {
    const providers = [
      { id: "ollama", name: "Ollama (Local)", connected: true },
    ];
    expect(normalizeProviderList(providers)).toEqual(providers);
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
