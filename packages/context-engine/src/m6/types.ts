/**
 * M6 — Context Engine: shared types.
 *
 * The context engine turns a workspace into ranked, budgeted, redacted
 * context for agent prompts. All types are plain data so the engine stays
 * trivially testable and host-agnostic (VS Code, CLI, tests).
 */

// ============================================================================
// File metadata
// ============================================================================

export type FileKind =
  "source" | "test" | "config" | "docs" | "binary" | "other";

export interface FileMeta {
  /** Workspace-relative path with forward slashes (deterministic key). */
  readonly relativePath: string;
  readonly language: string;
  readonly size: number;
  /** sha256(content) truncated to 16 hex chars; "-" for meta-only entries. */
  readonly hash: string;
  readonly lastModified: number;
  readonly kind: FileKind;
  readonly isTest: boolean;
  readonly isGenerated: boolean;
  readonly isBinary: boolean;
  /** True when the file matches sensitive-path policy (never ingested). */
  readonly isSensitive: boolean;
  /** True when only metadata was recorded (content not read into the index). */
  readonly metaOnly: boolean;
}

export type SymbolKind =
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "function"
  | "method"
  | "constant"
  | "heading"
  | "key";

export interface SymbolInfo {
  readonly name: string;
  readonly kind: SymbolKind;
  /** 1-based line number of the declaration. */
  readonly line: number;
  /** 1-based inclusive end line when block extent was determined. */
  readonly endLine?: number;
}

export interface ImportInfo {
  /** Raw module specifier as written in the source. */
  readonly specifier: string;
  /** Names imported from the module (empty for side-effect/namespace). */
  readonly names: string[];
  /** Workspace-relative resolved path; undefined for bare/external specifiers. */
  readonly resolvedPath?: string;
}

// ============================================================================
// Index record
// ============================================================================

/** A file ingested into the workspace index (content-bearing). */
export interface IndexedFile {
  readonly meta: FileMeta;
  readonly symbols: SymbolInfo[];
  readonly imports: ImportInfo[];
  readonly exports: string[];
  /** Redacted content kept in memory for retrieval (bounded by maxIndexedContentBytes). */
  readonly content: string;
}

// ============================================================================
// Retrieval
// ============================================================================

export type SelectionTier = "explicit" | "high" | "medium" | "low";

export interface RankedCandidate {
  readonly path: string;
  /** 0–100, rounded to 0.1 for determinism. */
  readonly score: number;
  /** Explainable, human-readable reasons in stable order. */
  readonly reasons: string[];
  readonly tier: SelectionTier;
  readonly tokenEstimate: number;
}

export interface DiagnosticRef {
  readonly file: string;
  readonly line?: number;
  readonly severity: "error" | "warning" | "info";
  readonly message?: string;
}

export interface GitContextInfo {
  readonly branch?: string;
  readonly modifiedFiles?: string[];
  readonly stagedFiles?: string[];
  readonly untrackedFiles?: string[];
}

export interface RetrievalRequest {
  readonly task: string;
  readonly activeFile?: string;
  readonly selection?: string;
  readonly openFiles?: string[];
  readonly mentionedFiles?: string[];
  readonly diagnostics?: DiagnosticRef[];
  readonly git?: GitContextInfo;
  /** Model context window in tokens (model-aware budgeting). */
  readonly modelContextWindow?: number;
  readonly reservedOutputTokens?: number;
  readonly systemPromptTokens?: number;
  readonly toolDefinitionsTokens?: number;
  readonly conversationTokens?: number;
  /** Hard override for the available context budget. */
  readonly tokenBudget?: number;
  /** Maximum files included in the result (default 12). */
  readonly maxFiles?: number;
}

export type SelectionKind = "full" | "symbols" | "truncated";

export interface SelectedContext {
  readonly path: string;
  readonly score: number;
  readonly reasons: string[];
  readonly kind: SelectionKind;
  readonly tokens: number;
  /** Redacted content or extracted symbol blocks. */
  readonly content: string;
  readonly tier: SelectionTier;
}

export interface OmittedContext {
  readonly path: string;
  readonly reason: string;
}

export interface BudgetBreakdown {
  readonly contextWindow: number;
  readonly reservedOutputTokens: number;
  readonly systemPromptTokens: number;
  readonly toolDefinitionsTokens: number;
  readonly conversationTokens: number;
  readonly availableContextTokens: number;
  readonly usedContextTokens: number;
}

export interface RetrievalResult {
  readonly selected: SelectedContext[];
  readonly omitted: OmittedContext[];
  readonly budget: BudgetBreakdown;
  readonly warnings: string[];
}

// ============================================================================
// RAG
// ============================================================================

/** Offline-safe lexical search over the indexed workspace. */
export interface RagHit {
  readonly path: string;
  /** 0–1 relevance. */
  readonly score: number;
  readonly matchedTerms: string[];
}

/** Optional semantic embedder — when absent, retrieval stays lexical-only. */
export interface SemanticEmbedder {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface RagProvider {
  /** Score indexed files against the query; returns hits sorted by score desc. */
  search(queryTerms: string[], limit: number): RagHit[];
}
