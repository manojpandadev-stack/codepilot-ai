/** @packageDocumentation
 * M6 — Workspace index.
 *
 * Ingests discovered FileMeta entries into a content-bearing workspace index
 * with symbol extraction, import/export resolution, secret redaction, and
 * incremental change detection. The index is the backing store for retrieval
 * (ranking + RAG) and is invalidated by file changes via the M5 event bridge.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  extractSymbols,
  extractImports,
  extractExports,
  resolveModuleSpecifier,
} from "./symbols.js";
import { redactSecrets } from "./security.js";
import { estimateTokens, tokenize } from "./tokens.js";
import type {
  FileMeta,
  IndexedFile,
  RetrievalRequest,
  RetrievalResult,
  SelectedContext,
  OmittedContext,
  RankedCandidate,
  RagHit,
  SelectionTier,
} from "./types.js";

// ============================================================================
// Indexing policy
// ============================================================================

export interface WorkspaceIndexingPolicy {
  /** Maximum total bytes of in-memory content across indexed files. */
  readonly maxIndexedContentBytes: number;
  /** Maximum tokens of content returned from a single retrieval request. */
  readonly maxRetrievalTokens: number;
  /** Max files included in the retrieval result (default 12). */
  readonly maxRetrievalFiles: number;
  /** When true, include test files as full content-bearing entries. */
  readonly includeTests: boolean;
  /** When true, include generated files. */
  readonly includeGenerated: boolean;
}

export const DEFAULT_INDEXING_POLICY: WorkspaceIndexingPolicy = {
  maxIndexedContentBytes: 4 * 1024 * 1024,
  maxRetrievalTokens: 20_000,
  maxRetrievalFiles: 12,
  includeTests: true,
  includeGenerated: false,
};

// ============================================================================
// Workspace index
// ============================================================================

/** Mutable internal shape of the index stats (snapshotted on read). */
interface MutableIndexStats {
  indexed: number;
  skippedSensitive: number;
  skippedOversized: number;
  skippedMetaOnly: number;
  redactionsApplied: number;
  readErrors: number;
}

export class WorkspaceIndex {
  private readonly root: string;
  private readonly policy: WorkspaceIndexingPolicy;
  private files = new Map<string, IndexedFile>();
  private knownPaths = new Set<string>();
  private totalContentBytes = 0;
  private stats: MutableIndexStats = {
    indexed: 0,
    skippedSensitive: 0,
    skippedOversized: 0,
    skippedMetaOnly: 0,
    redactionsApplied: 0,
    readErrors: 0,
  };

  constructor(root: string, policy = DEFAULT_INDEXING_POLICY) {
    this.root = fs.realpathSync(root);
    this.policy = policy;
  }

  get rootPath(): string {
    return this.root;
  }

  get statsSnapshot(): IndexStats {
    return { ...this.stats };
  }

  get fileCount(): number {
    return this.files.size;
  }

  /** Total estimated content tokens currently held in memory. */
  get contentTokens(): number {
    let total = 0;
    for (const entry of this.files.values()) {
      total += estimateTokens(entry.content);
    }
    return total;
  }

  // ---------------------------------------------------------------------
  // Incremental indexing
  // ---------------------------------------------------------------------

  /** Index a discovered set of FileMeta entries, skipping unchanged files. */
  indexDiscovered(files: readonly FileMeta[]): IndexResult {
    const before = this.files.size;
    const candidates = files.filter(
      (f) =>
        !f.isSensitive &&
        !f.isBinary &&
        !f.metaOnly &&
        (this.policy.includeTests || !f.isTest) &&
        (this.policy.includeGenerated || !f.isGenerated),
    );

    for (const meta of candidates) {
      this.privateIndex(meta);
      if (this.totalContentBytes >= this.policy.maxIndexedContentBytes) {
        break;
      }
    }

    // Re-resolve cross-file import references now that the full batch is
    // known (a file may be indexed before the module it imports).
    this.reResolveImports();

    return {
      indexed: this.files.size - before,
      alreadyIndexed: files.filter((f) => this.files.has(f.relativePath))
        .length,
      stats: this.statsSnapshot,
    };
  }

  /** Re-index a single file after a change, preserving the rest of the index. */
  reindexFile(relativePath: string): boolean {
    const abs = path.resolve(this.root, relativePath);
    if (!isInsideWorkspace(this.root, abs)) return false;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      this.files.delete(relativePath);
      this.knownPaths.delete(relativePath);
      return false;
    }
    const meta: FileMeta = {
      relativePath,
      language: detectLanguageFromPath(relativePath),
      size: stat.size,
      hash: "-",
      lastModified: stat.mtimeMs,
      kind: classifyKind(relativePath),
      isTest: isTestPath(relativePath),
      isGenerated: isGeneratedPath(relativePath),
      isBinary: isBinaryExtension(relativePath),
      isSensitive: false,
      metaOnly: false,
    };
    const existingContent = this.files.get(relativePath)?.content;
    const next = readAndRedact(abs);
    if (existingContent !== next.content) {
      this.files.delete(relativePath);
      this.privateIndex(meta);
    }
    return this.files.has(relativePath);
  }

  /** Remove stale entries for files that no longer exist. */
  pruneMissing(knownRelPaths: readonly string[]): number {
    const existing = new Set(knownRelPaths);
    let removed = 0;
    for (const [rel] of this.files) {
      if (!existing.has(rel)) {
        this.files.delete(rel);
        removed++;
      }
    }
    return removed;
  }

  // ---------------------------------------------------------------------
  // Retrieval
  // ---------------------------------------------------------------------

  /** Retrieve, rank, and budget context for a task. */
  retrieve(request: RetrievalRequest): RetrievalResult {
    const tokens =
      request.modelContextWindow ??
      DEFAULT_INDEXING_POLICY.maxRetrievalTokens * 4;
    const reserved =
      (request.reservedOutputTokens ?? 2048) +
      (request.systemPromptTokens ?? 2048) +
      (request.toolDefinitionsTokens ?? 1536) +
      (request.conversationTokens ?? 4096);
    // An explicit tokenBudget is the caller's hard budget; otherwise derive
    // the available context from the model window minus reserved headroom.
    const available =
      request.tokenBudget !== undefined
        ? Math.max(0, request.tokenBudget)
        : Math.max(0, tokens - reserved);

    const candidates = WorkspaceIndex.rankCandidates(this, request);
    const { selected, omitted } = WorkspaceIndex.budgetCandidates(
      candidates,
      this,
      available,
      request.maxFiles ?? this.policy.maxRetrievalFiles,
    );

    return {
      selected,
      omitted,
      budget: {
        contextWindow: tokens,
        reservedOutputTokens: request.reservedOutputTokens ?? 2048,
        systemPromptTokens: request.systemPromptTokens ?? 2048,
        toolDefinitionsTokens: request.toolDefinitionsTokens ?? 1536,
        conversationTokens: request.conversationTokens ?? 4096,
        availableContextTokens: available,
        usedContextTokens: selected.reduce((acc, s) => acc + s.tokens, 0),
      },
      warnings: [],
    };
  }

  // ---------------------------------------------------------------------
  // RAG helper (lexical over the index)
  // ---------------------------------------------------------------------

  /** Lexical search over the in-memory index. Returns hits sorted by score. */
  ragSearch(queryTerms: string[], limit = 10): RagHit[] {
    const hits: RagHit[] = [];
    for (const entry of this.files.values()) {
      const lowered = entry.content.toLowerCase();
      let score = 0;
      const matched: string[] = [];
      for (const term of queryTerms) {
        const termLower = term.toLowerCase();
        if (lowered.includes(termLower)) {
          score += 1;
          matched.push(term);
        }
      }
      if (score > 0) {
        hits.push({
          path: entry.meta.relativePath,
          score: Math.min(1, score / Math.max(1, queryTerms.length)),
          matchedTerms: matched,
        });
      }
    }
    hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return hits.slice(0, limit);
  }

  // ---------------------------------------------------------------------
  // Direct lookup
  // ---------------------------------------------------------------------

  getFile(relativePath: string): IndexedFile | undefined {
    return this.files.get(relativePath);
  }

  hasFile(relativePath: string): boolean {
    return this.files.has(relativePath);
  }

  filePaths(): string[] {
    return Array.from(this.files.keys());
  }

  /** Clear all content-bearing entries (policy/config changes). */
  clear(): void {
    this.files.clear();
    this.knownPaths.clear();
    this.totalContentBytes = 0;
    this.stats = {
      indexed: 0,
      skippedSensitive: 0,
      skippedOversized: 0,
      skippedMetaOnly: 0,
      redactionsApplied: 0,
      readErrors: 0,
    };
  }

  // ---------------------------------------------------------------------
  // Static helpers (avoid implicit-this inference in nested closures)
  // ---------------------------------------------------------------------

  static rankCandidates(
    index: WorkspaceIndex,
    request: RetrievalRequest,
  ): RankedCandidate[] {
    const tokens = tokenize(request.task);
    const scored: RankedCandidate[] = [];

    for (const entry of index.files.values()) {
      const candidate = WorkspaceIndex.scoreCandidate(entry, tokens);
      if (candidate.score > 0) {
        scored.push(candidate);
      }
    }

    const applyBonus = (
      candidate: RankedCandidate,
      addScore: number,
      reason: string,
    ): RankedCandidate => ({
      ...candidate,
      score: Math.min(100, candidate.score + addScore),
      reasons: candidate.reasons.includes(reason)
        ? candidate.reasons
        : [...candidate.reasons, reason],
    });

    // Explicit mention bonuses
    for (const rel of request.mentionedFiles ?? []) {
      const idx = scored.findIndex((c) => c.path === rel);
      const candidate = idx >= 0 ? scored[idx] : undefined;
      if (candidate)
        scored[idx] = applyBonus(candidate, 45, "explicitly mentioned by user");
    }

    // Active file bonus
    if (request.activeFile) {
      const idx = scored.findIndex((c) => c.path === request.activeFile);
      const candidate = idx >= 0 ? scored[idx] : undefined;
      if (candidate)
        scored[idx] = applyBonus(candidate, 25, "active editor file");
    }

    // Open files bonus
    for (const rel of request.openFiles ?? []) {
      const idx = scored.findIndex((c) => c.path === rel);
      const candidate = idx >= 0 ? scored[idx] : undefined;
      if (candidate) scored[idx] = applyBonus(candidate, 12, "open in editor");
    }

    // Diagnostic proximity: boost files with errors
    for (const diag of request.diagnostics ?? []) {
      const idx = scored.findIndex((c) => c.path === diag.file);
      const candidate = idx >= 0 ? scored[idx] : undefined;
      if (candidate) {
        const boost = diag.severity === "error" ? 30 : 12;
        scored[idx] = applyBonus(
          candidate,
          boost,
          `diagnostic: ${diag.severity}`,
        );
      }
    }

    scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return scored;
  }

  static scoreCandidate(entry: IndexedFile, tokens: string[]): RankedCandidate {
    const canonical = entry.meta.relativePath;
    const content = entry.content;
    const lowered = content.toLowerCase();

    let overlap = 0;
    const uniqueTokens = new Set(tokens);
    for (const token of uniqueTokens) {
      if (lowered.includes(token)) overlap++;
    }
    const termScore = uniqueTokens.size > 0 ? overlap / uniqueTokens.size : 0;

    let symbolOverlap = 0;
    const names = new Set<string>();
    for (const s of entry.symbols) names.add(s.name.toLowerCase());
    for (const imp of entry.imports) names.add(imp.specifier.toLowerCase());
    for (const exp of entry.exports) names.add(exp.toLowerCase());
    for (const name of names) {
      if (uniqueTokens.has(name)) symbolOverlap++;
    }
    const symbolScore =
      names.size > 0 ? symbolOverlap / Math.max(1, uniqueTokens.size) : 0;

    const tokenEstimate = estimateTokens(content);
    const lengthPenalty = Math.min(1, 20000 / Math.max(1, tokenEstimate));

    const pathTerms = tokenize(canonical).filter((t) => uniqueTokens.has(t));
    const pathScore = pathTerms.length / Math.max(1, uniqueTokens.size);

    let score =
      termScore * 50 + symbolScore * 30 + pathScore * 15 + lengthPenalty * 5;

    const reasons: string[] = [];
    if (termScore > 0.05) reasons.push("task term overlap");
    if (symbolScore > 0.05) reasons.push("symbol/import/export overlap");
    if (pathScore > 0) reasons.push("path similarity");
    if (entry.meta.isTest) reasons.push("test file");

    let tier: SelectionTier = "low";
    if (score >= 70) tier = "explicit";
    else if (score >= 45) tier = "high";
    else if (score >= 20) tier = "medium";

    return {
      path: canonical,
      score: round1(score),
      reasons,
      tier,
      tokenEstimate,
    };
  }

  static budgetCandidates(
    candidates: RankedCandidate[],
    index: WorkspaceIndex,
    availableTokens: number,
    maxFiles: number,
  ): { selected: SelectedContext[]; omitted: OmittedContext[] } {
    const selected: SelectedContext[] = [];
    const omitted: OmittedContext[] = [];
    let used = 0;

    for (const candidate of candidates.slice(0, maxFiles * 4)) {
      if (selected.length >= maxFiles) {
        omitted.push({ path: candidate.path, reason: "max files reached" });
        continue;
      }
      if (used + candidate.tokenEstimate > availableTokens) {
        omitted.push({
          path: candidate.path,
          reason: "would exceed token budget",
        });
        continue;
      }
      const entry = index.files.get(candidate.path);
      const content = entry?.content ?? "";
      selected.push({
        path: candidate.path,
        score: candidate.score,
        reasons: candidate.reasons,
        kind: "full",
        tokens: candidate.tokenEstimate,
        content,
        tier: candidate.tier,
      });
      used += candidate.tokenEstimate;
    }

    return { selected, omitted };
  }

  /** Re-resolve every stored import against the current known file set. */
  private reResolveImports(): void {
    const known = new Set(this.knownPaths);
    for (const [rel, entry] of this.files) {
      const imports = entry.imports.map((imp) => ({
        ...imp,
        resolvedPath: resolveModuleSpecifier(rel, imp.specifier, known),
      }));
      this.files.set(rel, {
        ...entry,
        imports,
      });
    }
  }

  // ---------------------------------------------------------------------
  // Private: ingest one file into the index (redacted, bounded).
  // ---------------------------------------------------------------------

  private privateIndex(meta: FileMeta): void {
    const abs = path.resolve(this.root, meta.relativePath);
    if (!isInsideWorkspace(this.root, abs)) return;

    const { content, redactions } = readAndRedact(abs);
    if (content === "") {
      if (redactions === 0) {
        this.stats.readErrors++;
      } else {
        this.stats.redactionsApplied += redactions;
      }
      return;
    }

    if (
      Buffer.byteLength(content, "utf8") > this.policy.maxIndexedContentBytes
    ) {
      this.stats.skippedOversized++;
      return;
    }

    const symbols = extractSymbols(meta.language, meta.relativePath, content);
    const imports = extractImports(content);
    const exports = extractExports(content);
    const knownPaths = Array.from(this.files.keys()).concat(
      Array.from(this.knownPaths),
    );
    const resolvedImports = imports.map((imp) => ({
      ...imp,
      resolvedPath: resolveModuleSpecifier(
        meta.relativePath,
        imp.specifier,
        new Set(knownPaths),
      ),
    }));

    this.files.set(meta.relativePath, {
      meta,
      symbols,
      imports: resolvedImports,
      exports,
      content,
    });
    this.knownPaths.add(meta.relativePath);
    this.totalContentBytes += Buffer.byteLength(content, "utf8");
    this.stats.indexed++;
    this.stats.redactionsApplied += redactions;
  }
}

// ============================================================================
// Index result
// ============================================================================

export interface IndexStats {
  readonly indexed: number;
  readonly skippedSensitive: number;
  readonly skippedOversized: number;
  readonly skippedMetaOnly: number;
  readonly redactionsApplied: number;
  readonly readErrors: number;
}

export interface IndexResult {
  readonly indexed: number;
  readonly alreadyIndexed: number;
  readonly stats: IndexStats;
}

// ============================================================================
// Private helpers
// ============================================================================

function isInsideWorkspace(root: string, absolutePath: string): boolean {
  const rel = path.relative(root, absolutePath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isBinaryExtension(relPath: string): boolean {
  const ext = path.extname(relPath).toLowerCase();
  return /\\.(png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|wasm|exe|dll|so|dylib|bin|o|a|lib|mp3|mp4|avi|mov|wav|flac|ogg|woff2?|ttf|otf|eot|db|sqlite3?|pyc|pak|node)$/i.test(
    ext,
  );
}

function detectLanguageFromPath(relPath: string): string {
  const ext = path.extname(relPath).toLowerCase();
  const map: Record<string, string> = {
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
  return map[ext] ?? "other";
}

function isTestPath(rel: string): boolean {
  return (
    /(^|\/)(__tests__|__mocks__|tests?|spec)(\/|$)/i.test(rel) ||
    /\.(test|spec)\.[a-z]+$/i.test(rel)
  );
}

function isGeneratedPath(rel: string): boolean {
  return /(^|\/)(generated|__generated__|__snapshots__)(\/|$)/i.test(rel);
}

function classifyKind(relPath: string): FileMeta["kind"] {
  const ext = path.extname(relPath).toLowerCase();
  const test = isTestPath(relPath);
  if (isBinaryExtension(relPath)) return "binary";
  if (test) return "test";
  if (
    [
      "package.json",
      "tsconfig.json",
      "jsconfig.json",
      "vitest.config.ts",
    ].includes(path.posix.basename(relPath)) ||
    /(\\.config\\.[a-z]+|[\\._\\-][a-z]+rc)$/i.test(relPath)
  )
    return "config";
  if (new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]).has(ext)) return "docs";
  if (!ext || !SOURCE_EXTS.has(ext)) return "other";
  return "source";
}

const SOURCE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".java",
  ".py",
  ".json",
  ".md",
  ".mdx",
  ".css",
  ".scss",
  ".less",
  ".html",
  ".htm",
  ".yaml",
  ".yml",
  ".xml",
  ".sql",
  ".go",
  ".rs",
  ".c",
  ".h",
  ".cpp",
  ".sh",
  ".txt",
]);

function readAndRedact(absPath: string): {
  content: string;
  redactions: number;
} {
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, "utf8");
  } catch {
    return { content: "", redactions: 0 };
  }
  const { content, redactions } = redactSecrets(raw);
  return { content, redactions };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
