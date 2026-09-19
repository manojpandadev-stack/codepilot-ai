/**
 * M9 — Rules & Skills tests.
 *
 * Covers discovery, precedence, task scoping, skill activation,
 * cache invalidation, and security (control stripping, size caps,
 * injection resistance).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  RulesEngine,
  globMatches,
  parseSkillFrontmatter,
  sanitizeInstructionText,
} from "./rules-engine.js";
import type { RulesOptions } from "./types.js";

function makeWorkspace(): { root: string; home: string } {
  return {
    root: fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-ws-")),
    home: fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-home-")),
  };
}

describe("M9 sanitizeInstructionText", () => {
  it("strips control characters but keeps newlines and tabs", () => {
    const input = "line1\nline2\tend\u0000\u001F\u007F";
    expect(sanitizeInstructionText(input)).toBe("line1\nline2\tend");
  });

  it("removes zero-width injection characters", () => {
    expect(sanitizeInstructionText("in\u200Bstr\uFEFFuction")).toBe(
      "instruction",
    );
  });
});

describe("M9 parseSkillFrontmatter", () => {
  it("parses name, description, appliesTo and tags", () => {
    const parsed = parseSkillFrontmatter(
      [
        "---",
        "name: release-checklist",
        "description: Steps before release",
        'appliesTo: ["package.json", "changelog/**"]',
        "tags: [release, ops]",
        "---",
        "1. Run tests",
      ].join("\n"),
    );
    expect(parsed?.meta.name).toBe("release-checklist");
    expect(parsed?.meta.appliesTo).toEqual(["package.json", "changelog/**"]);
    expect(parsed?.meta.tags).toEqual(["release", "ops"]);
    expect(parsed?.body.trim()).toBe("1. Run tests");
  });

  it("returns null without frontmatter", () => {
    expect(parseSkillFrontmatter("just text")).toBeNull();
  });
});

describe("M9 globMatches", () => {
  it("matches **, * and literals", () => {
    expect(globMatches("**", "any/path/file.ts")).toBe(true);
    expect(globMatches("src/**", "src/a/b.ts")).toBe(true);
    expect(globMatches("src/**", "lib/a/b.ts")).toBe(false);
    expect(globMatches("*.test.ts", "foo.test.ts")).toBe(true);
    expect(globMatches("*.test.ts", "foo.ts")).toBe(false);
    expect(globMatches("src/*.ts", "src/a/b.ts")).toBe(false);
  });
});

describe("M9 RulesEngine", () => {
  let root: string;
  let home: string;

  beforeEach(() => {
    const ws = makeWorkspace();
    root = ws.root;
    home = ws.home;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  function engine(options?: RulesOptions): RulesEngine {
    return new RulesEngine({ root, home }, options);
  }

  it("returns empty results when no rule directories exist", () => {
    const result = engine().load();
    expect(result.rules).toEqual([]);
    expect(result.skills).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("discovers project rules from .codepilot/rules", () => {
    fs.mkdirSync(path.join(root, ".codepilot", "rules"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".codepilot", "rules", "style.md"),
      "Always use strict TypeScript.",
      "utf8",
    );
    const result = engine().load();
    expect(result.rules).toHaveLength(1);
    const rule = result.rules[0];
    expect(rule?.source).toBe("project");
    expect(rule?.content).toContain("strict TypeScript");
    expect(rule?.pattern).toBe("**");
  });

  it("discovers legacy .clinerules directory", () => {
    fs.mkdirSync(path.join(root, ".clinerules"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".clinerules", "conventions.md"),
      "Legacy rules apply.",
      "utf8",
    );
    const result = engine().load();
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]?.source).toBe("project");
  });

  it("discovers global rules from home .codepilot/rules", () => {
    fs.mkdirSync(path.join(home, ".codepilot", "rules"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".codepilot", "rules", "global.md"),
      "Global behaviour.",
      "utf8",
    );
    const result = engine().load();
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]?.source).toBe("global");
  });

  it("orders rulesFor by precedence: task > project > user > global", () => {
    fs.mkdirSync(path.join(home, ".codepilot", "rules"), { recursive: true });
    fs.mkdirSync(path.join(root, ".codepilot", "rules"), { recursive: true });
    fs.mkdirSync(path.join(root, ".codepilot", "tasks", "t1"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(home, ".codepilot", "rules", "g.md"),
      "g",
      "utf8",
    );
    fs.writeFileSync(
      path.join(root, ".codepilot", "rules", "p.md"),
      "p",
      "utf8",
    );
    fs.writeFileSync(
      path.join(root, ".codepilot", "tasks", "t1", "t.md"),
      "t",
      "utf8",
    );

    const active = engine().rulesFor("src/index.ts", "t1");
    expect(active.map((r) => r.source)).toEqual(["task", "project", "global"]);
  });

  it("filters rules by path pattern", () => {
    fs.mkdirSync(path.join(root, ".codepilot", "rules"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".codepilot", "rules", "java.md"),
      "pattern: backend/**\nUse Java conventions.",
      "utf8",
    );
    const e = engine();
    expect(e.rulesFor("backend/Order.java", undefined)).toHaveLength(1);
    expect(e.rulesFor("src/index.ts", undefined)).toHaveLength(0);
  });

  it("discovers and activates skills by name", () => {
    fs.mkdirSync(path.join(root, ".codepilot", "skills"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".codepilot", "skills", "release.md"),
      [
        "---",
        "name: release",
        "description: release steps",
        "---",
        "Run the full validation suite.",
      ].join("\n"),
      "utf8",
    );
    const e = engine();
    const skill = e.findSkill("release");
    expect(skill).toBeDefined();
    expect(skill?.instructions).toContain("full validation suite");
    expect(e.findSkill("RELEASE")).toBeDefined(); // case-insensitive fallback
    expect(e.findSkill("missing")).toBeUndefined();
  });

  it("caches loads and invalidates on demand", () => {
    fs.mkdirSync(path.join(root, ".codepilot", "rules"), { recursive: true });
    const file = path.join(root, ".codepilot", "rules", "a.md");
    fs.writeFileSync(file, "v1", "utf8");
    const e = engine();
    expect(e.load().rules[0]?.content).toBe("v1");

    // Same-mtime rewrite is still cached (fingerprint = mtime).
    fs.writeFileSync(file, "v2", "utf8");
    expect(e.load().rules[0]?.content).toBe("v2"); // mtime changed

    // Cache survives a second identical call.
    const first = e.load();
    const second = e.load();
    expect(second).toBe(first);
    e.invalidate();
    expect(e.load()).not.toBe(first);
  });

  it("skips oversized rule files with a reason", () => {
    fs.mkdirSync(path.join(root, ".codepilot", "rules"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".codepilot", "rules", "huge.md"),
      "x".repeat(2048),
      "utf8",
    );
    const result = engine({ maxFileBytes: 1024 }).load();
    expect(result.rules).toHaveLength(0);
    expect(result.skipped[0]?.reason).toContain("exceeds");
  });

  it("strips control characters from loaded rule content", () => {
    fs.mkdirSync(path.join(root, ".codepilot", "rules"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".codepilot", "rules", "evil.md"),
      "ok\u001F\u0007hidden",
      "utf8",
    );
    const rule = engine().load().rules[0];
    expect(rule?.content).toBe("okhidden");
  });

  it("rejects skills without a usable name", () => {
    fs.mkdirSync(path.join(root, ".codepilot", "skills"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".codepilot", "skills", "bad.md"),
      "no frontmatter body",
      "utf8",
    );
    // Falls back to filename, so this one works:
    const skill = engine().findSkill("bad");
    expect(skill).toBeDefined();

    // A name declared in frontmatter that sanitizes to empty falls back to
    // the filename, so an explicitly empty name is still skipped safely.
    fs.writeFileSync(
      path.join(root, ".codepilot", "skills", "empty-name.md"),
      ["---", "name: \u200B\u200C", "---", "body"].join("\n"),
      "utf8",
    );
    const result = engine().load();
    expect(result.skills.map((s) => s.name)).not.toContain("");
  });
});
