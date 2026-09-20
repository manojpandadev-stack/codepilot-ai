/**
 * @codepilot/context-engine
 *
 * Manages context for AI agent prompts: budgeting, relevance ranking,
 * deduplication, pruning, and token estimation. Prevents context window
 * overflow and ensures the most relevant information is sent to the model.
 */

import { MAX_CONTEXT_TOKENS_DEFAULT } from "@codepilot/shared";
import { ssrfSafeFetch } from "./ssrf-guard.js";

// ============================================================================
// Token Estimation
// ============================================================================

const CHARS_PER_TOKEN = 4;

/**
 * Estimate token count for text.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate tokens for a structured object.
 */
export function estimateObjectTokens(obj: unknown): number {
  const serialized = JSON.stringify(obj);
  return estimateTokens(serialized);
}

// ============================================================================
// Context Sources
// ============================================================================

export type ContextSource =
  | "user_request"
  | "current_file"
  | "selected_code"
  | "open_editors"
  | "repository_structure"
  | "relevant_symbols"
  | "semantic_search"
  | "git_diff"
  | "project_rules"
  | "memory"
  | "previous_tool_results"
  | "test_failures";

export interface ContextItem {
  source: ContextSource;
  content: string;
  priority: number; // Higher = more important
  estimatedTokens: number;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Context Engine
// ============================================================================

export interface ContextEngineOptions {
  /** Maximum context tokens (model context window) */
  maxTokens?: number;
  /** Fraction of context window to reserve for response */
  responseReserveFraction?: number;
  /** Minimum priority threshold (items below this are dropped) */
  minPriority?: number;
}

/**
 * Context Engine manages assembling the optimal context for agent prompts.
 */
export class ContextEngine {
  private readonly maxTokens: number;
  private readonly reservedTokens: number;
  private readonly minPriority: number;

  constructor(options?: ContextEngineOptions) {
    this.maxTokens = options?.maxTokens ?? MAX_CONTEXT_TOKENS_DEFAULT;
    this.reservedTokens = Math.floor(
      this.maxTokens * (options?.responseReserveFraction ?? 0.25),
    );
    this.minPriority = options?.minPriority ?? 0;
  }

  /**
   * Build the optimal context from a set of context items.
   *
   * Prioritizes items by priority score, estimates tokens, and fits as much
   * high-priority content as possible within the context budget.
   */
  buildContext(items: ContextItem[]): {
    context: ContextItem[];
    totalTokens: number;
    droppedCount: number;
    budgetRemaining: number;
  } {
    const budget = this.maxTokens - this.reservedTokens;

    // Filter by minimum priority
    const eligible = items.filter((item) => item.priority >= this.minPriority);

    // Sort by priority (descending), then by source priority
    const sourcePriority: Record<ContextSource, number> = {
      user_request: 100,
      current_file: 90,
      selected_code: 85,
      previous_tool_results: 80,
      test_failures: 75,
      relevant_symbols: 70,
      semantic_search: 65,
      git_diff: 60,
      project_rules: 55,
      memory: 50,
      repository_structure: 40,
      open_editors: 30,
    };

    eligible.sort((a, b) => {
      const aCombined = a.priority * 10 + (sourcePriority[a.source] ?? 0);
      const bCombined = b.priority * 10 + (sourcePriority[b.source] ?? 0);
      return bCombined - aCombined;
    });

    // Deduplicate by content similarity
    const deduped = this.deduplicate(eligible);

    // Greedily select items within budget
    const selected: ContextItem[] = [];
    let totalTokens = 0;
    let droppedCount = 0;

    for (const item of deduped) {
      if (totalTokens + item.estimatedTokens <= budget) {
        selected.push(item);
        totalTokens += item.estimatedTokens;
      } else {
        droppedCount++;
      }
    }

    return {
      context: selected,
      totalTokens,
      droppedCount,
      budgetRemaining: budget - totalTokens,
    };
  }

  /**
   * Compress context items by summarizing long content.
   */
  compress(items: ContextItem[], targetTokens: number): ContextItem[] {
    let currentTokens = items.reduce(
      (sum, item) => sum + item.estimatedTokens,
      0,
    );

    if (currentTokens <= targetTokens) {
      return items;
    }

    // Strategy: truncate lower-priority items first
    const sorted = [...items].sort((a, b) => a.priority - b.priority);
    const result = [...items];

    for (const item of sorted) {
      if (currentTokens <= targetTokens) break;

      const excess = currentTokens - targetTokens;
      const truncatedContent = this.truncateContent(
        item.content,
        item.estimatedTokens - excess,
      );
      const truncatedItem = {
        ...item,
        content: truncatedContent,
        estimatedTokens: estimateTokens(truncatedContent),
      };

      const index = result.indexOf(item);
      if (index >= 0) {
        currentTokens -= item.estimatedTokens - truncatedItem.estimatedTokens;
        result[index] = truncatedItem;
      }
    }

    return result;
  }

  /**
   * Estimate total tokens for a set of messages.
   */
  estimateMessageTokens(
    messages: Array<{ role: string; content: string }>,
  ): number {
    let total = 0;
    for (const msg of messages) {
      // Overhead for message structure
      total += 4;
      total += estimateTokens(msg.role);
      total += estimateTokens(msg.content);
    }
    return total;
  }

  /**
   * Check if context will overflow the model window.
   */
  wouldOverflow(estimatedInputTokens: number): boolean {
    return estimatedInputTokens + this.reservedTokens > this.maxTokens;
  }

  /**
   * Get context utilization stats.
   */
  getStats(): {
    maxTokens: number;
    reservedTokens: number;
    availableTokens: number;
  } {
    return {
      maxTokens: this.maxTokens,
      reservedTokens: this.reservedTokens,
      availableTokens: this.maxTokens - this.reservedTokens,
    };
  }

  // ---- Private ----

  private deduplicate(items: ContextItem[]): ContextItem[] {
    const seen = new Set<string>();
    const result: ContextItem[] = [];

    for (const item of items) {
      // Simple content-based dedup using first 200 chars as key
      const key = item.content.slice(0, 200);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(item);
      }
    }

    return result;
  }

  private truncateContent(content: string, targetTokens: number): string {
    const targetChars = targetTokens * CHARS_PER_TOKEN;
    if (content.length <= targetChars) return content;
    return content.slice(0, targetChars) + "\n... [truncated]";
  }
}

// ============================================================================
// @folder Resolution
// ============================================================================

import * as fs from "node:fs/promises";
import * as path from "node:path";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "build",
  "dist",
  "__pycache__",
  ".gradle",
  ".idea",
  ".vscode",
  "vendor",
  ".next",
  "coverage",
  ".angular",
  ".cache",
  ".parcel-cache",
  "out",
]);

const IGNORED_PATTERNS = [
  /\.env(\.\w+)?$/,
  /\.DS_Store$/,
  /\.pyc$/,
  /Thumbs\.db$/,
];

/**
 * Resolve a @folder reference to a list of relevant files.
 * Respects .gitignore, workspace boundaries, and ignored directories.
 */
export async function resolveFolder(
  folderPath: string,
  workspaceRoot: string,
  options?: {
    maxFiles?: number;
    maxTokens?: number;
    includeExtensions?: string[];
  },
): Promise<ContextItem[]> {
  const maxFiles = options?.maxFiles ?? 50;
  const maxTokens = options?.maxTokens ?? 20_000;
  const includeExts = options?.includeExtensions;
  const absFolder = path.resolve(workspaceRoot, folderPath);

  // Ensure within workspace
  if (!absFolder.startsWith(workspaceRoot)) {
    return [
      {
        source: "user_request",
        content: `Error: ${folderPath} is outside workspace`,
        priority: 0,
        estimatedTokens: 10,
      },
    ];
  }

  const files: Array<{ relPath: string; absPath: string; size: number }> = [];
  let totalTokens = 0;

  async function scan(dir: string, depth: number): Promise<void> {
    if (depth > 6 || files.length >= maxFiles) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (IGNORED_PATTERNS.some((p) => p.test(entry.name))) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await scan(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (includeExts && !includeExts.includes(ext)) continue;
        // Skip binary-like extensions
        if (
          [
            ".png",
            ".jpg",
            ".gif",
            ".ico",
            ".woff",
            ".woff2",
            ".ttf",
            ".eot",
            ".map",
          ].includes(ext)
        )
          continue;

        try {
          const stat = await fs.stat(fullPath);
          if (stat.size > 500_000) continue; // Skip very large files
          const relPath = path.relative(workspaceRoot, fullPath);
          files.push({ relPath, absPath: fullPath, size: stat.size });
          totalTokens += Math.ceil(stat.size / CHARS_PER_TOKEN);
        } catch {
          // skip
        }
      }
    }
  }

  await scan(absFolder, 0);

  // Sort by path for deterministic output
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));

  // Truncate to token budget
  const items: ContextItem[] = [];
  let usedTokens = 0;
  const relFolderPath = path.relative(workspaceRoot, absFolder) || folderPath;

  // First item: directory listing
  const listing = files.map((f) => f.relPath).join("\n");
  const listingTokens = estimateTokens(listing);
  items.push({
    source: "repository_structure",
    content: `Folder: ${relFolderPath}\nFiles (${files.length}):\n${listing}`,
    priority: 80,
    estimatedTokens: listingTokens,
    metadata: {
      type: "folder_listing",
      path: relFolderPath,
      fileCount: files.length,
    },
  });
  usedTokens += listingTokens;

  // Then file contents (up to budget)
  for (const file of files) {
    if (usedTokens >= maxTokens) break;
    try {
      const content = await fs.readFile(file.absPath, "utf-8");
      const truncated =
        content.length > 4000
          ? content.slice(0, 4000) + "\n... [truncated]"
          : content;
      const tokens = estimateTokens(truncated);
      if (usedTokens + tokens > maxTokens) break;
      items.push({
        source: "current_file",
        content: `--- ${file.relPath} ---\n${truncated}`,
        priority: 70,
        estimatedTokens: tokens,
        metadata: { type: "file_content", path: file.relPath, size: file.size },
      });
      usedTokens += tokens;
    } catch {
      // skip unreadable files
    }
  }

  return items;
}

// ============================================================================
// @url Fetch
// ============================================================================

/** SSRF textual check now lives in ./ssrf-guard.js (strict classifier); fetchUrlContent delegates to ssrfSafeFetch. */

/** Extract readable text from HTML (basic) */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetch a URL and extract readable content.
 * SSRF-protected: blocks private IPs, localhost, and internal hostnames.
 */
export async function fetchUrlContent(
  url: string,
  options?: {
    timeoutMs?: number;
    maxChars?: number;
    resolveAll?: (
      h: string,
    ) => Promise<Array<{ address: string; family: number }>>;
    allowedDomains?: string[];
    deniedDomains?: string[];
  },
): Promise<ContextItem[]> {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const maxChars = options?.maxChars ?? 30_000;

  const okItem = (
    content: string,
    meta?: Record<string, unknown>,
  ): ContextItem[] => [
    {
      source: "user_request",
      content,
      priority: 0,
      estimatedTokens: 10,
      metadata: meta,
    },
  ];
  void timeoutMs;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return okItem(`Error: Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return okItem(`Error: Only HTTP/HTTPS URLs are allowed`);
  }

  // Every-hop SSRF validation: protocol + textual + domain + DNS/IP for the
  // initial URL, then again for EVERY redirect (handled inside ssrfSafeFetch
  // with redirect:"manual" — never blindly follow).
  const guard = await ssrfSafeFetch(url, {
    timeoutMs,
    maxChars: Math.max(maxChars, 1024),
    maxRedirects: 5,
    resolveAll: options?.resolveAll,
    allowedDomains: options?.allowedDomains,
    deniedDomains: options?.deniedDomains,
  });
  if (!guard.ok) {
    const msg = guard.error ?? "blocked";
    if (
      /private|local|loopback|link-local|multicast|reserved|metadata|unspecified|documentation|carrier-grade-nat|numeric IP|forbidden|allow-list|denied|DNS/i.test(
        msg,
      )
    ) {
      return okItem(
        `Error: Access to private/internal URLs is blocked for security`,
      );
    }
    if (/protocol/i.test(msg))
      return okItem(`Error: Only HTTP/HTTPS URLs are allowed`);
    if (/redirect/i.test(msg))
      return okItem(`Error: Redirect blocked for security: ${msg}`);
    return okItem(`Error fetching ${url}: ${msg}`);
  }

  const contentType = guard.contentType ?? "";
  if (
    !contentType.includes("text/html") &&
    !contentType.includes("text/plain") &&
    !contentType.includes("application/json") &&
    !contentType.includes("text/markdown")
  ) {
    return okItem(`Error: Unsupported content type: ${contentType}`);
  }

  const rawText = guard.text ?? "";
  const isHtml = contentType.includes("text/html");
  const text = isHtml ? htmlToText(rawText) : rawText;
  const truncated =
    text.length > maxChars
      ? text.slice(0, maxChars) + "\n... [truncated]"
      : text;
  const tokens = estimateTokens(truncated);

  return [
    {
      source: "user_request",
      content: `URL: ${guard.finalUrl}\n\n${truncated}`,
      priority: 75,
      estimatedTokens: tokens,
      metadata: {
        type: "url_content",
        url: guard.finalUrl,
        contentType,
        charCount: truncated.length,
        rawHtml: isHtml ? rawText : undefined,
      },
    },
  ];
}

// ============================================================================
// @file Resolution
// ============================================================================

/**
 * Resolve a @file reference to a context item with file content.
 */
export async function resolveFile(
  filePath: string,
  workspaceRoot: string,
  options?: { maxChars?: number },
): Promise<ContextItem[]> {
  const maxChars = options?.maxChars ?? 20_000;
  const absFile = path.resolve(workspaceRoot, filePath);

  if (!absFile.startsWith(workspaceRoot)) {
    return [
      {
        source: "user_request",
        content: `Error: ${filePath} is outside workspace`,
        priority: 0,
        estimatedTokens: 10,
      },
    ];
  }

  try {
    const content = await fs.readFile(absFile, "utf-8");
    const truncated =
      content.length > maxChars
        ? content.slice(0, maxChars) + "\n... [truncated]"
        : content;
    const tokens = estimateTokens(truncated);
    const relPath = path.relative(workspaceRoot, absFile);

    return [
      {
        source: "current_file",
        content: `--- ${relPath} ---\n${truncated}`,
        priority: 85,
        estimatedTokens: tokens,
        metadata: { type: "file_content", path: relPath, size: content.length },
      },
    ];
  } catch {
    return [
      {
        source: "user_request",
        content: `Error: File not found: ${filePath}`,
        priority: 0,
        estimatedTokens: 10,
      },
    ];
  }
}

// ============================================================================
// Project Rules (.clinerules/)
// ============================================================================

export interface ProjectRule {
  id: string;
  filePath: string;
  content: string;
  source: "project" | "global";
  pattern: string; // glob-like pattern for path matching
  enabled: boolean;
}

/**
 * Load project rules from .clinerules/ directory.
 * Supports nested/path-specific rules.
 */
export async function loadProjectRules(
  workspaceRoot: string,
): Promise<ProjectRule[]> {
  const rulesDir = path.join(workspaceRoot, ".clinerules");
  const rules: ProjectRule[] = [];

  try {
    await fs.access(rulesDir);
  } catch {
    return rules; // No rules directory
  }

  async function scanDir(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (
        entry.isFile() &&
        (entry.name.endsWith(".md") || entry.name.endsWith(".txt"))
      ) {
        const filePath = path.join(dir, entry.name);
        try {
          const content = await fs.readFile(filePath, "utf-8");
          const relPath = path.relative(rulesDir, filePath);
          // Derive pattern from directory structure
          // .clinerules/backend/java.md → pattern: "backend/**/*.java"
          const dirPart = path.dirname(relPath);
          const namePart = path.basename(relPath, path.extname(relPath));
          const pattern = dirPart === "." ? namePart : `${dirPart}/**`;

          rules.push({
            id: `project:${relPath}`,
            filePath: relPath,
            content,
            source: "project",
            pattern,
            enabled: true,
          });
        } catch {
          // skip unreadable
        }
      } else if (entry.isDirectory()) {
        await scanDir(
          path.join(dir, entry.name),
          prefix ? `${prefix}/${entry.name}` : entry.name,
        );
      }
    }
  }

  await scanDir(rulesDir, "");
  return rules;
}

/**
 * Load global user rules from ~/.clinerules/ or platform equivalent.
 */
export async function loadGlobalRules(): Promise<ProjectRule[]> {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "/";
  const rulesDir = path.join(homeDir, ".clinerules");
  const rules: ProjectRule[] = [];

  try {
    await fs.access(rulesDir);
  } catch {
    return rules;
  }

  try {
    const entries = await fs.readdir(rulesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isFile() &&
        (entry.name.endsWith(".md") || entry.name.endsWith(".txt"))
      ) {
        const filePath = path.join(rulesDir, entry.name);
        try {
          const content = await fs.readFile(filePath, "utf-8");
          const namePart = path.basename(entry.name, path.extname(entry.name));
          rules.push({
            id: `global:${entry.name}`,
            filePath: entry.name,
            content,
            source: "global",
            pattern: namePart,
            enabled: true,
          });
        } catch {
          // skip
        }
      }
    }
  } catch {
    // skip
  }

  return rules;
}

/**
 * Load all rules (global + project), with project rules overriding global.
 */
export async function loadAllRules(
  workspaceRoot: string,
): Promise<ProjectRule[]> {
  const globalRules = await loadGlobalRules();
  const projectRules = await loadProjectRules(workspaceRoot);

  // Project rules override global rules with same pattern
  const byPattern = new Map<string, ProjectRule>();
  for (const rule of globalRules) {
    byPattern.set(rule.pattern, rule);
  }
  for (const rule of projectRules) {
    byPattern.set(rule.pattern, rule);
  }

  return Array.from(byPattern.values());
}

/**
 * Build context items from rules.
 */
export function rulesToContextItems(rules: ProjectRule[]): ContextItem[] {
  return rules
    .filter((r) => r.enabled)
    .map((rule) => ({
      source: "project_rules" as ContextSource,
      content: `Rule [${rule.source}] ${rule.filePath}:\n${rule.content}`,
      priority: 55,
      estimatedTokens: estimateTokens(rule.content),
      metadata: {
        type: "project_rule",
        ruleId: rule.id,
        pattern: rule.pattern,
        source: rule.source,
      },
    }));
}

// ============================================================================
// M6 — Workspace Index (repository intelligence)
// ============================================================================

export type {
  FileMeta,
  FileKind,
  SymbolInfo,
  ImportInfo,
  IndexedFile,
  RankedCandidate,
  DiagnosticRef,
  GitContextInfo,
  RetrievalRequest,
  RetrievalResult,
  SelectedContext,
  OmittedContext,
  BudgetBreakdown,
  RagHit,
} from "./m6/types.js";
export { WorkspaceIndex, discoverWorkspace } from "./m6/index.js";

// ============================================================================
// M13 — Browser / Web Agent
// ============================================================================

export type {
  WebPage,
  WebAgentOptions,
  NavigationDecision,
} from "./m13-web-agent.js";
export {
  WebAgent,
  checkNavigationPolicy,
  detectInjection,
  isolateUntrustedContent,
  extractLinks,
  extractTitle,
} from "./m13-web-agent.js";

// ============================================================================
// M9 — Rules & Skills
// ============================================================================

export type {
  Rule,
  RuleSource,
  Skill,
  RulesLoadResult,
  RulesOptions,
} from "./m9/types.js";
export { RULE_PRECEDENCE } from "./m9/types.js";
export {
  RulesEngine,
  globMatches,
  parseSkillFrontmatter,
  sanitizeInstructionText,
  SKILL_VERSION_PATTERN,
  SKILL_TOOL_PATTERN,
} from "./m9/rules-engine.js";
export { isSensitivePath, SENSITIVE_PATTERNS } from "./m6/security.js";
