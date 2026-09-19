/**
 * Tools-tab display contract (Phase 4, option B).
 *
 * The Tools tab must never show a builtin name the model cannot resolve:
 * every display entry either names its exact native callable tool or is
 * explicitly policy-coverage-only with the resolution path stated in its
 * description. M4 gating is untouched — this only labels what the gate
 * already enforces.
 */
import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOL_DISPLAY_CONTRACT,
  type ToolDisplayEntry,
} from "../apps/vscode-extension/src/tool-contract.js";
import {
  CODEPILOT_MODEL_TOOL_NAMES,
  createCodePilotBuiltinTools,
} from "../packages/agent-runtime/src/builtin-tools.js";
import { normalizeToolList } from "../apps/webview/src/lib/messages.js";

function byName(name: string): ToolDisplayEntry {
  const entry = BUILTIN_TOOL_DISPLAY_CONTRACT.find((e) => e.name === name);
  if (!entry) throw new Error(`contract entry missing: ${name}`);
  return entry;
}

describe("tool display contract — integrity", () => {
  it("display names are unique and fully populated", () => {
    const names = BUILTIN_TOOL_DISPLAY_CONTRACT.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const e of BUILTIN_TOOL_DISPLAY_CONTRACT) {
      expect(e.name.length).toBeGreaterThan(0);
      expect(e.category.length).toBeGreaterThan(0);
      expect(e.description.length).toBeGreaterThan(0);
    }
  });

  it("every non-null callableName is a real native model-facing tool", () => {
    const callable = new Set<string>(CODEPILOT_MODEL_TOOL_NAMES);
    for (const e of BUILTIN_TOOL_DISPLAY_CONTRACT) {
      if (e.callableName === null) continue;
      expect(
        callable.has(e.callableName),
        `${e.name} resolves to unknown tool ${e.callableName}`,
      ).toBe(true);
    }
  });

  it("policy-coverage-only rows state their resolution path", () => {
    const coverage = BUILTIN_TOOL_DISPLAY_CONTRACT.filter(
      (e) => e.callableName === null,
    );
    expect(coverage.length).toBeGreaterThan(0);
    for (const e of coverage) {
      expect(
        /policy coverage|via the/i.test(e.description),
        `${e.name} names no callable tool and states no path`,
      ).toBe(true);
    }
  });

  it("known alias pairs resolve to the callable name", () => {
    expect(byName("search").callableName).toBe("search_codebase");
    expect(byName("web_fetch").callableName).toBe("fetch_web_content");
    expect(byName("write_file").callableName).toBe("editor");
    expect(byName("read_files").callableName).toBe("read_files");
    expect(byName("bash").callableName).toBe("bash");
    expect(byName("run_commands").callableName).toBe("run_commands");
    expect(byName("web_search").callableName).toBe("web_search");
  });
});

describe("tool display contract — coverage", () => {
  it("every native callable tool is reachable from the tab", () => {
    const reachable = new Set(
      BUILTIN_TOOL_DISPLAY_CONTRACT.map((e) => e.callableName).filter(
        (n): n is string => n !== null,
      ),
    );
    for (const name of CODEPILOT_MODEL_TOOL_NAMES) {
      expect(
        reachable.has(name),
        `native tool ${name} is invisible in the Tools tab`,
      ).toBe(true);
    }
  });

  it("all-enabled factory output equals the canonical tool set", () => {
    const names = createCodePilotBuiltinTools({
      cwd: process.cwd(),
      enableBash: true,
      enableWebFetch: true,
    }).map((t) => t.name);
    expect([...names].sort()).toEqual(
      [...CODEPILOT_MODEL_TOOL_NAMES].sort(),
    );
  });
});

describe("tool display contract — webview passthrough", () => {
  it("normalizeToolList preserves callableName (string, null, absent)", () => {
    const out = normalizeToolList({
      tools: [
        {
          name: "search",
          category: "read",
          description: "d",
          source: "builtin",
          permission: "auto",
          callableName: "search_codebase",
        },
        {
          name: "git_status",
          category: "git",
          description: "d",
          source: "builtin",
          permission: "auto",
          callableName: null,
        },
        {
          name: "bash",
          category: "execute",
          description: "d",
          source: "builtin",
          permission: "approval",
        },
      ],
    });
    expect(out).toHaveLength(3);
    expect(out[0]?.callableName).toBe("search_codebase");
    expect(out[1]?.callableName).toBeNull();
    expect(out[2]?.callableName).toBeUndefined();
  });
});
