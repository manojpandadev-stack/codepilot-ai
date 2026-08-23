/**
 * @codepilot/rag-engine
 *
 * Repository-aware RAG for CodePilot AI. Supports semantic search via embeddings,
 * keyword search, and hybrid ranking for retrieving relevant code context.
 */

import type { EmbeddingConfig } from "./embeddings.js";
import type { StoredChunk } from "./pgvector-store.js";
import { RepositoryIndexer } from "./repository-indexer.js";
import type { IndexResult } from "./repository-indexer.js";

export interface DocumentChunk {
  id: string;
  repositoryId: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  content: string;
  embedding?: number[];
  metadata: Record<string, unknown>;
}

export interface SearchResult {
  chunk: DocumentChunk;
  score: number;
  matchType: "semantic" | "keyword" | "hybrid";
}

export class RAGEngine {
  private chunks: DocumentChunk[] = [];

  async indexDocument(chunk: DocumentChunk): Promise<void> {
    this.chunks.push(chunk);
  }

  async search(query: string, options?: { limit?: number; language?: string }): Promise<SearchResult[]> {
    const limit = options?.limit ?? 10;
    const results: SearchResult[] = [];

    for (const chunk of this.chunks) {
      if (options?.language && chunk.language !== options.language) continue;
      const score = computeRelevance(query, chunk.content);
      if (score > 0.1) {
        results.push({ chunk, score, matchType: "keyword" });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  async indexFile(filePath: string, content: string, language: string, repositoryId: string): Promise<number> {
    const lines = content.split("\n");
    const chunkSize = 50;
    let count = 0;
    for (let i = 0; i < lines.length; i += chunkSize) {
      const end = Math.min(i + chunkSize, lines.length);
      const chunkContent = lines.slice(i, end).join("\n");
      await this.indexDocument({
        id: `${repositoryId}:${filePath}:${i}`,
        repositoryId, filePath, language,
        startLine: i + 1, endLine: end,
        content: chunkContent, metadata: {},
      });
      count++;
    }
    return count;
  }

  clear(): void { this.chunks = []; }
  getChunkCount(): number { return this.chunks.length; }
}

function computeRelevance(query: string, content: string): number {
  const queryTerms = query.toLowerCase().split(/\s+/);
  const contentLower = content.toLowerCase();
  let matches = 0;
  for (const term of queryTerms) {
    if (contentLower.includes(term)) matches++;
  }
  return matches / queryTerms.length;
}

// ============================================================================
// Production RAG Service
// Unifies the in-memory RAGEngine with PostgreSQL/pgvector storage.
// In production mode, delegates to PgVectorStore + Ollama embeddings.
// In test mode, uses in-memory array.
// ============================================================================

export interface ProductionRAGConfig {
  mode: "production" | "memory";
  pgConfig?: {
    connectionString?: string;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
  };
  embeddingConfig?: EmbeddingConfig;
  chunkSize?: number;
  maxFileSize?: number;
}

export class ProductionRAGService {
  private mode: "production" | "memory";
  private memoryEngine: RAGEngine;
  private indexer: RepositoryIndexer | null = null;

  constructor(config: ProductionRAGConfig) {
    this.mode = config.mode;
    this.memoryEngine = new RAGEngine();

    if (config.mode === "production" && config.pgConfig && config.embeddingConfig) {
      this.indexer = new RepositoryIndexer({
        pgConfig: config.pgConfig,
        embeddingConfig: config.embeddingConfig,
        chunkSize: config.chunkSize,
        maxFileSize: config.maxFileSize,
      });
    }
  }

  async initialize(): Promise<void> {
    if (this.mode === "production" && this.indexer) {
      await this.indexer.initialize();
    }
  }

  /** Index an entire repository */
  async indexRepository(
    repoPath: string,
    projectId: string,
    onProgress?: (message: string) => void
  ): Promise<IndexResult> {
    if (this.mode === "production" && this.indexer) {
      return this.indexer.indexRepository(repoPath, projectId, onProgress);
    }
    // Memory mode: index files into in-memory engine
    const { readdirSync, readFileSync, statSync } = await import("fs");
    const { join, extname, relative } = await import("path");

    const start = Date.now();
    let indexed = 0;
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if ([".git", "node_modules", "target", "dist"].includes(entry)) continue;
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) { walk(full); continue; }
        const ext = extname(entry).toLowerCase();
        if ([".java", ".ts", ".js", ".py", ".sql", ".md", ".json", ".yaml"].includes(ext)) {
          const content = readFileSync(full, "utf-8");
          const langMap: Record<string, string> = { ".java": "java", ".ts": "typescript", ".js": "javascript", ".py": "python" };
          this.memoryEngine.indexFile(relative(repoPath, full).replace(/\\/g, "/"), content, langMap[ext] ?? "text", projectId);
          indexed++;
        }
      }
    };
    walk(repoPath);
    return { filesScanned: indexed, filesIndexed: indexed, filesSkipped: 0, chunksCreated: 0, embeddingsCreated: 0, errors: [], durationMs: Date.now() - start };
  }

  /** Search for relevant code */
  async search(
    query: string,
    projectId: string,
    options: { limit?: number; language?: string } = {}
  ): Promise<SearchResult[]> {
    if (this.mode === "production" && this.indexer) {
      const results = await this.indexer.search(query, projectId, options);
      return results.map((r: StoredChunk & { score: number; matchType: string }) => ({
        chunk: {
          id: r.id, repositoryId: r.projectId, filePath: r.filePath,
          language: r.language, startLine: r.startLine, endLine: r.endLine,
          content: r.content, metadata: r.metadata,
        },
        score: r.score,
        matchType: (r.matchType as "semantic" | "keyword" | "hybrid") ?? "keyword",
      }));
    }
    return this.memoryEngine.search(query, options);
  }

  /** Clear all indexed data for a project */
  async clearIndex(projectId: string): Promise<void> {
    if (this.mode === "production" && this.indexer) {
      await this.indexer.clearIndex(projectId);
    } else {
      this.memoryEngine.clear();
    }
  }

  async close(): Promise<void> {
    if (this.indexer) {
      await this.indexer.close();
    }
  }
}

// Re-export production modules
export { PgVectorStore } from "./pgvector-store.js";
export type { PgVectorConfig, StoredChunk } from "./pgvector-store.js";
export { generateEmbedding, generateBatchEmbeddings, checkEmbeddingService } from "./embeddings.js";
export type { EmbeddingConfig, EmbeddingResult } from "./embeddings.js";
export { RepositoryIndexer } from "./repository-indexer.js";
export type { IndexerConfig } from "./repository-indexer.js";
