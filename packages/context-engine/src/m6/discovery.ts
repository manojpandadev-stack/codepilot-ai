/**
 * M6 — Workspace discovery.
 *
 * Deterministic, bounded filesystem walk producing FileMeta for every
 * indexable file. Respects: default ignore dirs, caller ignore patterns
 * (globs with * / **), root .gitignore (documented subset: plain patterns,
 * dir patterns, anchored patterns; negations are ignored), binary detection,
 * sensitive-path policy, and configurable size/count limits. Nothing is read
 * here beyond directory entries and stat data — content reads happen in the
 * workspace index.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { FileKind, FileMeta } from "./types.js";
import { isSensitivePath } from "./security.js";
import { M6ContextError } from "./errors.js";

export interface ContextDiscoveryOptions {
  readonly workspaceRoot: string;
  /** Skip files larger than this (default 1 MiB). */
  readonly maxFileSize?: number;
  /** Hard cap on discovered files (default 5000). */
  readonly maxFiles?: number;
  /** Extra ignore globs (* and ** supported). */
  readonly ignoredPatterns?: readonly string[];
  /** Index test files (default true; when false they are meta-only). */
  readonly includeTests?: boolean;
  /** Index generated files' content (default false → metaOnly). */
  readonly includeGenerated?: boolean;
  /** Discover dotfiles (default false). */
  readonly includeHidden?: boolean;
}

export interface DiscoveryStats {
  readonly scanned: number;
  readonly skippedIgnored: number;
  readonly skippedSensitive: number;
  readonly skippedOversized: number;
  readonly skippedHidden: number;
  readonly truncatedByMaxFiles: boolean;
}

export interface DiscoveryResult {
  readonly files: FileMeta[];
  readonly stats: DiscoveryStats;
}

export const DEFAULT_IGNORED_DIRS: readonly string[] = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".nuxt",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".gradle",
  ".idea",
  ".cache",
  ".vscode-test",
];

const IGNORED_FILES: readonly string[] = [".DS_Store", "Thumbs.db"];

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".java": "java",
  ".py": "python",
  ".json": "json",
  ".md": "markdown",
  ".mdx": "markdown",
  ".css": "css",
  ".scss": "css",
  ".less": "css",
  ".html": "html",
  ".htm": "html",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".xml": "xml",
  ".sql": "sql",
  ".go": "go",
  ".rs": "rust",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".sh": "shell",
  ".txt": "text",
};

export function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return LANGUAGE_BY_EXT[ext] ?? "other";
}

const GENERATED_DIR = /(^|\/)(generated|__generated__|__snapshots__)(\/|$)/;
const GENERATED_SUFFIX =
  /\.min\.[jt]sx?$|\.generated\.[a-z]+$|\.d\.ts$|-lock\.json$|\.lock$|\.snap$/;
const GENERATED_FILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "poetry.lock",
  "composer.lock",
]);
const CONFIG_NAMES = new Set([
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "vitest.config.ts",
  "eslint.config.js",
  "eslint.config.mjs",
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.js",
  ".prettierrc",
  "vite.config.ts",
  "jest.config.js",
  "Makefile",
  "Dockerfile",
  "docker-compose.yml",
]);
const CONFIG_PATTERN =
  /(^|\/)(\.[\w.-]*rc(\.(json|js|yml|yaml))?|[\w.-]+\.config\.[a-z]+)$/i;
const DOC_EXT = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]);
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|wasm|exe|dll|so|dylib|bin|o|a|lib|mp3|mp4|avi|mov|wav|flac|ogg|woff2?|ttf|otf|eot|db|sqlite3?|pyc|pak|node)$/i;

function isTestPath(rel: string): boolean {
  return (
    /(^|\/)(__tests__|__mocks__|tests?|spec)(\/|$)/i.test(rel) ||
    /\.(test|spec)\.[a-z]+$/i.test(rel)
  );
}

function classify(
  rel: string,
  fileName: string,
  language: string,
  isBinary: boolean,
): { kind: FileKind; isTest: boolean; isGenerated: boolean } {
  const isTest = !isBinary && isTestPath(rel);
  const isGenerated =
    GENERATED_DIR.test(rel) ||
    GENERATED_SUFFIX.test(rel) ||
    GENERATED_FILES.has(fileName);
  let kind: FileKind;
  if (isBinary) kind = "binary";
  else if (isTest) kind = "test";
  else if (CONFIG_NAMES.has(fileName) || CONFIG_PATTERN.test(rel))
    kind = "config";
  else if (DOC_EXT.has(path.extname(fileName).toLowerCase())) kind = "docs";
  else if (language !== "other") kind = "source";
  else kind = "other";
  return { kind, isTest, isGenerated };
}

// ============================================================================
// Ignore matching
// ============================================================================

/**
 * Convert a caller-supplied ignore pattern into a matcher. Supports:
 *   `name`      — matches any path segment equal to name
 *   `*.ext`     — matches any file with that extension
 *   `dir/**`    — everything under dir
 *   `a/b/c`     — exact relative path prefix
 */
export function compileIgnorePattern(
  pattern: string,
): (rel: string) => boolean {
  const norm = pattern
    .replace(/\\/g, "/")
    .replace(/^\//, "")
    .replace(/\/$/, "");
  if (norm === "**" || norm === "*") {
    return () => false;
  }
  if (norm.includes("**")) {
    const prefix = norm.slice(0, norm.indexOf("**")).replace(/\/$/, "");
    return (rel) =>
      prefix === "" || rel === prefix || rel.startsWith(`${prefix}/`);
  }
  if (norm.includes("*")) {
    // Single-star glob → regex over the full relative path.
    const escaped = norm
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*");
    const re = new RegExp(`(^|/)${escaped}(/|$)`);
    return (rel) => re.test(rel);
  }
  return (rel) =>
    rel === norm || rel.startsWith(`${norm}/`) || rel.endsWith(`/${norm}`);
}

function readGitignore(root: string): readonly string[] {
  try {
    const raw = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
    const patterns: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!"))
        continue;
      patterns.push(
        trimmed.replace(/\\/g, "/").replace(/^\//, "").replace(/\/$/, ""),
      );
    }
    return patterns;
  } catch {
    return [];
  }
}

// ============================================================================
// The walk
// ============================================================================

export function discoverWorkspace(
  options: ContextDiscoveryOptions,
): DiscoveryResult {
  const root = fs.realpathSync(options.workspaceRoot);
  if (!fs.statSync(root).isDirectory()) {
    throw new M6ContextError(
      "INVALID_WORKSPACE",
      `not a directory: ${options.workspaceRoot}`,
    );
  }

  const maxFileSize = options.maxFileSize ?? 1024 * 1024;
  const maxFiles = options.maxFiles ?? 5000;
  const includeTests = options.includeTests ?? true;
  const includeGenerated = options.includeGenerated ?? false;
  const includeHidden = options.includeHidden ?? false;

  const callerIgnores = (options.ignoredPatterns ?? []).map(
    compileIgnorePattern,
  );
  const gitignore = readGitignore(root).map(compileIgnorePattern);

  const scanned = { value: 0 };
  const skippedIgnored = { value: 0 };
  const skippedSensitive = { value: 0 };
  const skippedOversized = { value: 0 };
  const skippedHidden = { value: 0 };
  const truncatedByMaxFiles = { value: false };

  const stats: DiscoveryStats = {
    get scanned() {
      return scanned.value;
    },
    get skippedIgnored() {
      return skippedIgnored.value;
    },
    get skippedSensitive() {
      return skippedSensitive.value;
    },
    get skippedOversized() {
      return skippedOversized.value;
    },
    get skippedHidden() {
      return skippedHidden.value;
    },
    get truncatedByMaxFiles() {
      return truncatedByMaxFiles.value;
    },
  };
  const files: FileMeta[] = [];

  const isIgnored = (rel: string, isDir: boolean): boolean => {
    if (
      DEFAULT_IGNORED_DIRS.includes(path.posix.basename(rel)) &&
      (isDir || rel.includes("/"))
    ) {
      return true;
    }
    if (IGNORED_FILES.includes(path.posix.basename(rel))) return true;
    for (const matcher of [...callerIgnores, ...gitignore]) {
      if (matcher(rel)) return true;
    }
    return false;
  };

  const visit = (absDir: string, relDir: string): void => {
    if (stats.truncatedByMaxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable dir → skip silently, degrade gracefully
    }
    for (const entry of entries) {
      if (stats.truncatedByMaxFiles) return;
      const name = entry.name;
      const rel = relDir === "" ? name : `${relDir}/${name}`;
      const isHidden = name.startsWith(".");
      if (isHidden && !includeHidden && relDir === "") {
        // Root dotfiles (e.g. .gitignore, .npmrc): never discovered by default.
        skippedHidden.value++;
        continue;
      }
      if (entry.isDirectory()) {
        if (isHidden && !includeHidden) {
          skippedHidden.value++;
          continue;
        }
        if (isIgnored(rel, true)) {
          skippedIgnored.value++;
          continue;
        }
        visit(path.join(absDir, name), rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isHidden && !includeHidden) {
        skippedHidden.value++;
        continue;
      }
      if (isIgnored(rel, false)) {
        skippedIgnored.value++;
        continue;
      }
      scanned.value++;

      const abs = path.join(absDir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue; // raced delete → skip
      }
      const isBinary = BINARY_EXT.test(name);
      const language = detectLanguage(name);
      const { kind, isTest, isGenerated } = classify(
        rel,
        name,
        language,
        isBinary,
      );
      const isSensitive = isSensitivePath(rel);
      if (isSensitive) skippedSensitive.value++;

      // Sensitive files are recorded as meta-only tombstones — never read,
      // never hashed from content, never cached.
      const oversized = stat.size > maxFileSize;
      if (oversized) skippedOversized.value++;
      const metaOnly =
        isSensitive ||
        oversized ||
        isBinary ||
        (isTest && !includeTests) ||
        (isGenerated && !includeGenerated);

      files.push({
        relativePath: rel,
        language,
        size: stat.size,
        hash: metaOnly ? "-" : "",
        lastModified: stat.mtimeMs,
        kind,
        isTest,
        isGenerated,
        isBinary,
        isSensitive,
        metaOnly,
      });
      if (files.length >= maxFiles) {
        truncatedByMaxFiles.value = true;
        return;
      }
    }
  };

  visit(root, "");
  return { files, stats };
}

// @@PART3@@
