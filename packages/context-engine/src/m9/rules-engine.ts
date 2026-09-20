/**
 * M9 — Rules & Skills engine.
 *
 * Discovery + precedence + security for instruction files.
 *
 * Layout conventions (all optional, all discovered automatically):
 *   ~/.codepilot/rules/**          → source "global"   (machine-wide)
 *   ~/.codepilot/skills/**         → global skills
 *   <root>/.codepilot/rules/**     → source "project"
 *   <root>/.codepilot/skills/**    → project skills
 *   <root>/.codepilot/tasks/<id>/** → source "task"
 *
 * Security model:
 * - Rule/skill files are UNTRUSTED REPOSITORY INPUT. They can shape model
 *   behaviour but must never be able to smuggle terminal control characters,
 *   hidden injection markers, or oversized payloads past the engine.
 * - Content is capped, control characters are stripped, and frontmatter is
 *   parsed as data only. Instructions are plain text by construction.
 * - Rules can influence agent behaviour, but they can never grant
 *   permissions: M4 approval always applies downstream.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  type Rule,
  type RuleSource,
  type Skill,
  type RulesLoadResult,
  type RulesOptions,
  RULE_PRECEDENCE,
} from "./types.js";

const DEFAULTS = {
  maxFileBytes: 64 * 1024,
  maxFilesPerDir: 200,
  maxRules: 200,
  maxSkills: 100,
};

const RULE_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);
const SKILL_EXTENSIONS = new Set([".md", ".mdx"]);

/** Strip control characters (except \n \t) that could hide injection. */
export function sanitizeInstructionText(input: string): string {
  return input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\u200B|\u200C|\u200D|\uFEFF/g, ""); // zero-widths
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  appliesTo?: string[];
  tags?: string[];
  allowedTools?: string[];
}

/**
 * Skill version format: conservative dotted/tag shape (`1.2.3`, `v2`,
 * `2024.01-rc1`). Versions are display/tracking metadata only — they never
 * influence security decisions. Malformed values fail closed to `undefined`
 * (dropped, skill still loads) so untrusted input cannot smuggle payloads
 * into version-filtered paths.
 */
export const SKILL_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,31}$/;

/**
 * A single declared tool/capability name. Same conservative shape as plugin
 * tool names: must start alnum, bounded length. Entries failing this are
 * dropped at discovery (fail-closed); see collectSkills.
 */
export const SKILL_TOOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Parse a bounded YAML-ish frontmatter block as plain key: value data. */
export function parseSkillFrontmatter(
  raw: string,
): { meta: SkillFrontmatter; body: string } | null {
  const match = /^---\r?\n([\s\S]{0,4096}?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return null;
  const meta: SkillFrontmatter = {};
  for (const line of match[1]?.split(/\r?\n/) ?? []) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1] ?? "";
    const value = (kv[2] ?? "").trim();
    if (key === "appliesTo" || key === "tags" || key === "allowedTools") {
      meta[key] = value
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
    } else if (key === "name" || key === "description" || key === "version") {
      meta[key] = value.replace(/^['"]|['"]$/g, "");
    }
  }
  return { meta, body: match[2] ?? "" };
}

export interface RulesEngineHost {
  /** Workspace root for project/task scopes. */
  root: string;
  /** Home directory for global/user scopes (defaults to os.homedir()). */
  home?: string;
}

export class RulesEngine {
  private cache: Map<string, { mtimeMs: number; result: RulesLoadResult }> =
    new Map();
  private readonly options: Required<RulesOptions>;
  /** Per-skill enabled state. True = active/injected into prompt. */
  public skillActivation: Map<string, boolean> = new Map();

  constructor(
    private readonly host: RulesEngineHost,
    options?: RulesOptions,
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** Load all rules + skills with precedence ordering. Cached per root set. */
  load(): RulesLoadResult {
    const cacheKey = `${this.host.root}|${this.host.home ?? ""}`;
    const cached = this.cache.get(cacheKey);
    const fingerprint = this.scanFingerprint();
    if (cached && cached.mtimeMs === fingerprint) {
      return cached.result;
    }

    const skipped: RulesLoadResult["skipped"] = [];
    const rules: Rule[] = [];
    const skills: Skill[] = [];

    // Scope roots in precedence order.
    const scopes: Array<{ source: RuleSource; dir: string; base: string }> = [];
    const home = this.host.home ?? "";
    if (home) {
      scopes.push({
        source: "global",
        dir: path.join(home, ".codepilot", "rules"),
        base: "~",
      });
      scopes.push({
        source: "user",
        dir: path.join(home, ".codepilot", "user-rules"),
        base: "~",
      });
    }
    scopes.push({
      source: "project",
      dir: path.join(this.host.root, ".codepilot", "rules"),
      base: "",
    });
    scopes.push({
      source: "project",
      dir: path.join(this.host.root, ".clinerules"),
      base: "",
    });

    for (const scope of scopes) {
      this.collectRules(scope, rules, skipped);
    }

    // Task scope supplied per-load via activate(); discovered here.
    const taskDir = path.join(this.host.root, ".codepilot", "tasks");
    this.collectTaskRules(taskDir, rules, skipped);

    // Skills: project dir only (global skills via home dir).
    if (home) {
      this.collectSkills(
        {
          source: "global",
          dir: path.join(home, ".codepilot", "skills"),
          base: "~",
        },
        skills,
        skipped,
      );
    }
    this.collectSkills(
      {
        source: "project",
        dir: path.join(this.host.root, ".codepilot", "skills"),
        base: "",
      },
      skills,
      skipped,
    );

    // Enforce caps.
    const trimmedRules = rules.slice(0, this.options.maxRules);
    if (rules.length > this.options.maxRules) {
      skipped.push({
        path: "rules/*",
        reason: `rule cap exceeded (${rules.length} > ${this.options.maxRules})`,
      });
    }
    const trimmedSkills = skills.slice(0, this.options.maxSkills);
    if (skills.length > this.options.maxSkills) {
      skipped.push({
        path: "skills/*",
        reason: `skill cap exceeded (${skills.length} > ${this.options.maxSkills})`,
      });
    }

    // Compute active skill names (considering skillActivation map).
    // NOTE: must NOT route through isSkillActive()/findSkill() here — those
    // call load() again before the cache below is populated, which recurses
    // until the stack overflows. Same semantics, computed locally instead:
    // for a skill from THIS load, isSkillActive is exactly
    // skillActivation.get(id) ?? enabled.
    const activeSkillNames = new Set(
      skills
        .filter((s) => this.skillActivation.get(s.id) ?? s.enabled)
        .map((s) => s.name),
    );

    const result: RulesLoadResult = {
      rules: trimmedRules,
      skills: trimmedSkills,
      skipped,
      // Active skill names — skills whose isSkillActive(name) returns true.
      activeSkillNames,
    };
    this.cache.set(cacheKey, { mtimeMs: fingerprint, result });
    return result;
  }

  /** Drop the cache (tests + explicit hot reload). */
  invalidate(): void {
    this.cache.clear();
  }

  /** Rules active for a given file path + optional task id. */
  rulesFor(filePath: string | undefined, taskId?: string): Rule[] {
    const { rules } = this.load();
    const norm = filePath?.replace(/\\/g, "/");
    const active = rules.filter((rule) => {
      if (!rule.enabled) return false;
      if (rule.source === "task" && taskId && !rule.id.includes(taskId)) {
        return false;
      }
      if (!norm || rule.pattern === "**") return true;
      return globMatches(rule.pattern, norm);
    });
    // Higher priority wins; ties broken by source precedence then id.
    return active.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      const ai = RULE_PRECEDENCE.indexOf(a.source);
      const bi = RULE_PRECEDENCE.indexOf(b.source);
      if (bi !== ai) return bi - ai;
      return a.id.localeCompare(b.id);
    });
  }

  /** Find a skill by name (case-sensitive exact match first, then CI). */
  findSkill(name: string): Skill | undefined {
    const { skills } = this.load();
    return (
      skills.find((s) => s.name === name) ??
      skills.find((s) => s.name.toLowerCase() === name.toLowerCase())
    );
  }

  /** Activate a skill (mark it as active/injected into prompt). */
  activateSkill(name: string): boolean {
    const skill = this.findSkill(name);
    if (!skill) return false;
    this.skillActivation.set(skill.id, true);
    skill.enabled = true; // Also set the skill's enabled field
    this.invalidate();
    return true;
  }

  /** Deactivate a skill (mark it as inactive, not injected into prompt). */
  deactivateSkill(name: string): boolean {
    const skill = this.findSkill(name);
    if (!skill) return false;
    this.skillActivation.set(skill.id, false);
    skill.enabled = false; // Also clear the skill's enabled field
    this.invalidate();
    return true;
  }

  /** Whether a skill is currently active (will be injected into prompt). */
  isSkillActive(name: string): boolean {
    const skill = this.findSkill(name);
    if (!skill) return false;
    return this.skillActivation.get(skill.id) ?? skill.enabled;
  }

  /** Get all skills that are currently active (enabled + injected into prompt). */
  getActiveSkills(): Skill[] {
    const { skills } = this.load();
    return skills.filter((s) => this.isSkillActive(s.name));
  }

  // ------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------

  private scanFingerprint(): number {
    // Cheap invalidation: highest mtime across convention directories.
    let latest = 0;
    const dirs = [
      path.join(this.host.root, ".codepilot"),
      path.join(this.host.root, ".clinerules"),
      path.join(this.host.home ?? "", ".codepilot"),
    ].filter(Boolean);
    for (const dir of dirs) {
      try {
        const stat = fs.statSync(dir);
        latest = Math.max(latest, stat.mtimeMs);
        this.walkMtimes(dir, stat.mtimeMs, (t) => {
          latest = Math.max(latest, t);
        });
      } catch {
        // absent
      }
    }
    return latest;
  }

  private walkMtimes(
    dir: string,
    depthBudget: number,
    visit: (t: number) => void,
  ): void {
    if (depthBudget <= 0) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.slice(0, this.options.maxFilesPerDir)) {
      const full = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(entry.isDirectory() ? full : full);
        visit(stat.mtimeMs);
        if (entry.isDirectory()) {
          this.walkMtimes(full, depthBudget - 1, visit);
        }
      } catch {
        // skip unreadable
      }
    }
  }

  private collectRules(
    scope: { source: RuleSource; dir: string; base: string },
    rules: Rule[],
    skipped: RulesLoadResult["skipped"],
  ): void {
    const priority = RULE_PRECEDENCE.indexOf(scope.source);
    this.walkRuleFiles(scope.dir, (abs, rel) => {
      if (rules.length >= this.options.maxRules) {
        skipped.push({ path: rel, reason: "rule cap reached" });
        return;
      }
      const stat = fs.statSync(abs);
      if (stat.size > this.options.maxFileBytes) {
        skipped.push({
          path: rel,
          reason: `file exceeds ${this.options.maxFileBytes} bytes`,
        });
        return;
      }
      let content: string;
      try {
        content = fs.readFileSync(abs, "utf8");
      } catch {
        skipped.push({ path: rel, reason: "unreadable" });
        return;
      }
      const sanitized = sanitizeInstructionText(content).trim();
      if (!sanitized) {
        skipped.push({ path: rel, reason: "empty after sanitization" });
        return;
      }
      // A rule file may declare its own glob in the first line: `pattern: x`
      let pattern = scopePattern(rel);
      const firstLine = sanitized.split(/\r?\n/, 1)[0] ?? "";
      const patternDecl = /^pattern\s*:\s*(\S+)\s*$/.exec(firstLine);
      if (patternDecl) {
        pattern = patternDecl[1] ?? "**";
      }
      rules.push({
        id: `${scope.source}:${rel}`,
        source: scope.source,
        filePath: rel,
        content: patternDecl
          ? sanitized.slice(firstLine.length).trim()
          : sanitized,
        pattern,
        priority,
        enabled: true,
        loadedAtMs: Date.now(),
      });
    });
  }

  private collectTaskRules(
    taskRoot: string,
    rules: Rule[],
    skipped: RulesLoadResult["skipped"],
  ): void {
    let taskIds: string[] = [];
    try {
      taskIds = fs
        .readdirSync(taskRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .slice(0, 50);
    } catch {
      return;
    }
    const priority = RULE_PRECEDENCE.indexOf("task");
    for (const taskId of taskIds) {
      const dir = path.join(taskRoot, taskId);
      this.walkRuleFiles(dir, (abs, rel) => {
        if (rules.length >= this.options.maxRules) return;
        let content: string;
        try {
          content = fs.readFileSync(abs, "utf8");
        } catch {
          skipped.push({ path: rel, reason: "unreadable" });
          return;
        }
        const sanitized = sanitizeInstructionText(content).trim();
        if (!sanitized) return;
        rules.push({
          id: `task:${taskId}:${rel}`,
          source: "task",
          filePath: rel,
          content: sanitized,
          pattern: "**",
          priority,
          enabled: true,
          loadedAtMs: Date.now(),
        });
      });
    }
  }

  private collectSkills(
    scope: { source: RuleSource; dir: string; base: string },
    skills: Skill[],
    skipped: RulesLoadResult["skipped"],
  ): void {
    this.walkRuleFiles(scope.dir, (abs, rel) => {
      if (skills.length >= this.options.maxSkills) {
        skipped.push({ path: rel, reason: "skill cap reached" });
        return;
      }
      const stat = fs.statSync(abs);
      if (stat.size > this.options.maxFileBytes) {
        skipped.push({
          path: rel,
          reason: `file exceeds ${this.options.maxFileBytes} bytes`,
        });
        return;
      }
      let raw: string;
      try {
        raw = fs.readFileSync(abs, "utf8");
      } catch {
        skipped.push({ path: rel, reason: "unreadable" });
        return;
      }
      const parsed = parseSkillFrontmatter(raw);
      const body = sanitizeInstructionText(parsed?.body ?? raw).trim();
      if (!body) {
        skipped.push({ path: rel, reason: "empty after sanitization" });
        return;
      }
      const fallbackName = path.basename(rel).replace(/\.(md|mdx|txt)$/, "");
      const skillId = sanitizeInstructionText(
        parsed?.meta.name ?? fallbackName,
      ).trim();
      const name = sanitizeInstructionText(
        parsed?.meta.name ?? fallbackName,
      ).trim();
      if (!name) {
        skipped.push({ path: rel, reason: "missing skill name" });
        return;
      }
      // Version: optional display/tracking metadata. Validated against a
      // conservative pattern; malformed values are dropped (undefined) —
      // fail-closed, and never security-relevant either way.
      const rawVersion = sanitizeInstructionText(
        parsed?.meta.version ?? "",
      ).trim();
      const version =
        rawVersion && SKILL_VERSION_PATTERN.test(rawVersion)
          ? rawVersion
          : undefined;
      // allowedTools: optional narrowing declaration. Key present (even with
      // zero valid entries) means "restricted"; key absent means
      // unrestricted. Malformed entries are dropped; an explicitly empty
      // list therefore permits NO tools (fail-closed, never unrestricted).
      const declaredTools =
        parsed?.meta.allowedTools !== undefined
          ? parsed.meta.allowedTools
              .map((t) => sanitizeInstructionText(t).trim())
              .filter((t) => SKILL_TOOL_PATTERN.test(t))
          : undefined;
      skills.push({
        id: skillId,
        name,
        description: sanitizeInstructionText(
          parsed?.meta.description ?? "",
        ).trim(),
        filePath: rel,
        instructions: body,
        appliesTo: parsed?.meta.appliesTo ?? [],
        tags: parsed?.meta.tags ?? [],
        loadedAtMs: Date.now(),
        enabled: true,
        version,
        source: scope.source,
        allowedTools: declaredTools,
      });
    });
  }

  private walkRuleFiles(
    dir: string,
    visit: (abs: string, rel: string) => void,
  ): void {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.slice(0, this.options.maxFilesPerDir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walkRuleFiles(full, visit);
      } else if (
        entry.isFile() &&
        (RULE_EXTENSIONS.has(path.extname(entry.name)) ||
          SKILL_EXTENSIONS.has(path.extname(entry.name)))
      ) {
        visit(full, entry.name);
      }
    }
  }
}

/** Derive a default path pattern from a rule's relative filename. */
function scopePattern(_rel: string): string {
  // `style.md` → `**`; `backend-java.md` → `**`; directories map to their tree.
  return "**";
}

/** Minimal glob matching: `**` any segments, `*` within one segment. */
export function globMatches(pattern: string, target: string): boolean {
  const regex = pattern
    .split("/")
    .map((seg) =>
      seg === "**"
        ? "(?:.*)"
        : seg
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, "[^/]*")
            .replace(/\?/g, "[^/]"),
    )
    .join("/");
  return new RegExp(`^${regex}$`).test(target);
}
