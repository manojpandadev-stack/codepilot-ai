/**
 * Repository indexer for CodePilot RAG.
 * Scans repository files, chunks them, generates embeddings, and stores in pgvector.
 * Supports incremental indexing using file hashes.
 */

import { createHash } from "crypto";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, extname, relative } from "path";
import { PgVectorStore, type StoredChunk } from "./pgvector-store.js";
import { generateEmbedding, type EmbeddingConfig } from "./embeddings.js";

const SUPPORTED_EXTENSIONS = new Set([
  ".java", ".ts", ".tsx", ".js", ".jsx", ".py",
  ".sql", ".json", ".yaml", ".yml", ".md",
  ".xml", ".properties", ".gradle", ".kt",
]);

const IGNORED_DIRS = new Set([
  ".git", "node_modules", "target", "build", "dist",
  ".gradle", ".mvn", "__pycache__", ".next", ".nuxt",
  "vendor", ".vagrant", ".idea", ".vscode",
]);

const IGNORED_FILES = new Set([
  ".env", ".env.local", ".env.production",
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  ".gitignore", ".dockerignore",
]);

function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const langMap: Record<string, string> = {
    ".java": "java", ".ts": "typescript", ".tsx": "typescript",
    ".js": "javascript", ".jsx": "javascript",
    ".py": "python", ".sql": "sql", ".json": "json",
    ".yaml": "yaml", ".yml": "yaml", ".md": "markdown",
    ".xml": "xml", ".properties": "properties",
    ".gradle": "gradle", ".kt": "kotlin",
  };
  return langMap[ext] ?? "text";
}

export interface IndexResult {
  filesScanned: number;
  filesIndexed: number;
  filesSkipped: number;
  chunksCreated: number;
  embeddingsCreated: number;
  errors: string[];
  durationMs: number;
}

export interface IndexerConfig {
  /** PostgreSQL connection */
  pgConfig: {
    connectionString?: string;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
  };
  /** Ollama embedding config */
  embeddingConfig: EmbeddingConfig;
  /** Maximum file size in bytes (default: 1MB) */
  maxFileSize?: number;
  /** Chunk size in lines (default: 50) */
  chunkSize?: number;
}

export class RepositoryIndexer {
  private store: PgVectorStore;
  private embeddingConfig: EmbeddingConfig;
  private maxFileSize: number;
  private chunkSize: number;

  constructor(config: IndexerConfig) {
    this.store = new PgVectorStore(config.pgConfig);
    this.embeddingConfig = config.embeddingConfig;
    this.maxFileSize = config.maxFileSize ?? 1024 * 1024;
    this.chunkSize = config.chunkSize ?? 50;
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  /**
   * Index a repository directory.
   * Only re-indexes files whose content hash has changed.
   */
  async indexRepository(
    repoPath: string,
    projectId: string,
    onProgress?: (message: string) => void
  ): Promise<IndexResult> {
    const startTime = Date.now();
    const result: IndexResult = {
      filesScanned: 0, filesIndexed: 0, filesSkipped: 0,
      chunksCreated: 0, embeddingsCreated: 0, errors: [], durationMs: 0,
    };

    try {
      // Scan all supported files
      const files = this.scanFiles(repoPath);
      result.filesScanned = files.length;
      onProgress?.(`Scanned ${files.length} files`);

      for (const filePath of files) {
        try {
          const fullPath = join(repoPath, filePath);
          const content = readFileSync(fullPath, "utf-8");

          // Skip files that are too large
          if (Buffer.byteLength(content, "utf-8") > this.maxFileSize) {
            result.filesSkipped++;
            continue;
          }

          // Check if file has changed (incremental indexing via PostgreSQL)
          const contentHash = createHash("sha256").update(content).digest("hex");
          const prevHash = await this.store.getFileHash(projectId, filePath);
          if (prevHash === contentHash) {
            result.filesSkipped++;
            continue;
          }
          const language = detectLanguage(filePath);

          // Delete old chunks for this file
          await this.store.deleteFileChunks(projectId, filePath);

          // Chunk the file
          const lines = content.split("\n");
          const chunks: Array<{ startLine: number; endLine: number; content: string }> = [];

          for (let i = 0; i < lines.length; i += this.chunkSize) {
            const end = Math.min(i + this.chunkSize, lines.length);
            chunks.push({
              startLine: i + 1,
              endLine: end,
              content: lines.slice(i, end).join("\n"),
            });
          }

          // Generate embeddings for each chunk
          for (const chunk of chunks) {
            try {
              const embeddingResult = await generateEmbedding(chunk.content, this.embeddingConfig);

              const stored: StoredChunk = {
                id: `${projectId}:${filePath}:${chunk.startLine}`,
                projectId,
                filePath,
                language,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                content: chunk.content,
                embedding: embeddingResult.embedding,
                metadata: { contentHash, chunkSize: this.chunkSize },
                indexedAt: new Date(),
              };

              await this.store.upsertChunk(stored);
              result.chunksCreated++;
              result.embeddingsCreated++;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              result.errors.push(`Embedding failed for ${filePath}:${chunk.startLine} - ${msg}`);
            }
          }

          // Persist file hash for future incremental checks
          await this.store.upsertFileHash(projectId, filePath, contentHash, Buffer.byteLength(content, "utf-8"));
          result.filesIndexed++;
          onProgress?.(`Indexed ${filePath} (${chunks.length} chunks)`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`Failed to index ${filePath}: ${msg}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Repository scan failed: ${msg}`);
    }

    result.durationMs = Date.now() - startTime;
    return result;
  }

  /**
   * Search the repository index using hybrid search.
   */
  async search(
    query: string,
    projectId: string,
    options: { limit?: number; language?: string } = {}
  ): Promise<Array<StoredChunk & { score: number; matchType: string }>> {
    // Generate query embedding
    try {
      const embeddingResult = await generateEmbedding(query, this.embeddingConfig);
      return await this.store.hybridSearch(query, embeddingResult.embedding, {
        projectId,
        limit: options.limit ?? 10,
      });
    } catch {
      // Fall back to keyword search if embedding fails
      const kwResults = await this.store.keywordSearch(query, {
        projectId,
        limit: options.limit ?? 10,
        language: options.language,
      });
      return kwResults.map((r) => ({ ...r, matchType: "keyword" as const }));
    }
  }

  /** Get index statistics */
  async getStats(projectId: string): Promise<{
    chunkCount: number;
  }> {
    const chunkCount = await this.store.getChunkCount(projectId);
    return { chunkCount };
  }

  /** Clear the index for a project */
  async clearIndex(projectId: string): Promise<number> {
    return await this.store.clearProject(projectId);
  }

  private scanFiles(dirPath: string, basePath?: string): string[] {
    const base = basePath ?? dirPath;
    const files: string[] = [];

    const entries = readdirSync(dirPath);
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry) || IGNORED_FILES.has(entry)) continue;

      const fullPath = join(dirPath, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        files.push(...this.scanFiles(fullPath, base));
      } else if (
        stat.isFile() &&
        SUPPORTED_EXTENSIONS.has(extname(entry).toLowerCase()) &&
        stat.size <= this.maxFileSize
      ) {
        files.push(relative(base, fullPath).replace(/\\/g, "/"));
      }
    }

    return files;
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}
