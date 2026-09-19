/**
 * M9 — Rules & Skills types.
 *
 * Rules shape agent behaviour; skills are named, metadata-described
 * instruction bundles the agent can activate. Both are loaded from the
 * repository and are therefore UNTRUSTED INPUT: size caps, control
 * stripping, and metadata parsing (not free-text trust) are security
 * controls, not conveniences.
 */

export type RuleSource = "global" | "user" | "project" | "task";

/** Precedence order — later wins. task > project > user > global. */
export const RULE_PRECEDENCE: readonly RuleSource[] = [
  "global",
  "user",
  "project",
  "task",
];

export interface Rule {
  /** Stable id, e.g. `project:.codepilot/rules/style.md`. */
  id: string;
  /** Which scope the rule was discovered in. */
  source: RuleSource;
  /** Workspace-relative (or `~`-relative for global/user) path. */
  filePath: string;
  /** Sanitized instruction content. */
  content: string;
  /** Glob-ish path pattern this rule applies to; `**` = always. */
  pattern: string;
  /** Higher number wins on identical id/pattern conflicts. */
  priority: number;
  enabled: boolean;
  /** mtime at load, used for cache/hot-reload invalidation. */
  loadedAtMs: number;
}

export interface Skill {
  /** Unique skill identifier, e.g. `release-checklist`. */
  id: string;
  /** Unique skill name from frontmatter, e.g. `release-checklist`. */
  name: string;
  description: string;
  /** Workspace-relative skill file path. */
  filePath: string;
  /** Sanitized instruction body. */
  instructions: string;
  /** Optional file-path activation globs. */
  appliesTo: string[];
  /** Optional free-form tags for discovery. */
  tags: string[];
  /** mtime at load, used for cache/hot-reload invalidation. */
  loadedAtMs: number;
  /** Activation state — only active skills are injected into the prompt. */
  enabled: boolean;
  /** Skill version, for tracking updates. */
  version?: string;
  /** Source scope where the skill was discovered. */
  source: RuleSource;
  /** Additional metadata (tool caps, etc.). */
  metadata?: Record<string, unknown>;
  /** Capabilities/tool names this skill may invoke. */
  allowedTools?: string[];
}

/** Result of loading rules for a scope — includes skipped-file reasons. */
export interface RulesLoadResult {
  rules: Rule[];
  skills: Skill[];
  /** Paths intentionally skipped (oversized, injected controls, etc.). */
  skipped: Array<{ path: string; reason: string }>;
  /** Skill names that are active (will be injected into the prompt). */
  activeSkillNames: Set<string>;
}

/** Options controlling discovery and enforcement. */
export interface RulesOptions {
  /** Max bytes per rule/skill file. Default 64 KiB. */
  maxFileBytes?: number;
  /** Max files scanned per directory. Default 200. */
  maxFilesPerDir?: number;
  /** Max total rules loaded. Default 200. */
  maxRules?: number;
  /** Max total skills loaded. Default 100. */
  maxSkills?: number;
}
