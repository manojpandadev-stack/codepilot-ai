/**
 * PostgreSQL + pgvector store for CodePilot RAG.
 * Provides semantic search via vector embeddings stored in pgvector.
 */

import pg from "pg";

const { Pool } = pg;

export interface PgVectorConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}

export interface StoredChunk {
  id: string;
  projectId: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  content: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  indexedAt: Date;
}

export class PgVectorStore {
  private pool: pg.Pool;

  constructor(config: PgVectorConfig) {
    this.pool = new Pool({
      connectionString: config.connectionString,
      host: config.host ?? "localhost",
      port: config.port ?? 5433,
      database: config.database ?? "codepilot",
      user: config.user ?? "codepilot",
      password: config.password ?? "codepilot",
      max: 10,
    });
  }

  /**
   * Verify connectivity and that the rag_chunks table exists.
   * Schema is managed by Flyway — do NOT create tables here.
   */
  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Verify rag_chunks exists (created by Flyway V2 migration)
      const check = await client.query(
        `SELECT EXISTS (
           SELECT FROM information_schema.tables
           WHERE table_name = 'rag_chunks'
         ) as exists`,
      );
      if (!check.rows[0]?.exists) {
        throw new Error(
          "rag_chunks table not found. Run Flyway migrations first (V2__normalize_rag_schema.sql).",
        );
      }
    } finally {
      client.release();
    }
  }

  /** Upsert a chunk with its embedding */
  async upsertChunk(chunk: StoredChunk): Promise<void> {
    const embeddingStr = `[${chunk.embedding.join(",")}]`;
    await this.pool.query(
      `INSERT INTO rag_chunks (id, project_id, file_path, language, start_line, end_line, content, embedding, metadata, indexed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         content = EXCLUDED.content,
         embedding = EXCLUDED.embedding,
         metadata = EXCLUDED.metadata,
         indexed_at = EXCLUDED.indexed_at`,
      [
        chunk.id,
        chunk.projectId,
        chunk.filePath,
        chunk.language,
        chunk.startLine,
        chunk.endLine,
        chunk.content,
        embeddingStr,
        JSON.stringify(chunk.metadata),
        chunk.indexedAt,
      ],
    );
  }

  /** Delete all chunks for a given file */
  async deleteFileChunks(projectId: string, filePath: string): Promise<number> {
    const result = await this.pool.query(
      "DELETE FROM rag_chunks WHERE project_id = $1 AND file_path = $2",
      [projectId, filePath],
    );
    return result.rowCount ?? 0;
  }

  /** Semantic search using cosine similarity */
  async semanticSearch(
    embedding: number[],
    options: { projectId?: string; limit?: number; language?: string } = {},
  ): Promise<Array<StoredChunk & { score: number }>> {
    const limit = options.limit ?? 10;
    const embeddingStr = `[${embedding.join(",")}]`;

    let query = `
      SELECT *, 1 - (embedding <=> $1::vector) as score
      FROM rag_chunks
      WHERE 1=1
    `;
    const params: unknown[] = [embeddingStr];
    let paramIdx = 2;

    if (options.projectId) {
      query += ` AND project_id = $${paramIdx++}`;
      params.push(options.projectId);
    }
    if (options.language) {
      query += ` AND language = $${paramIdx++}`;
      params.push(options.language);
    }

    query += ` ORDER BY embedding <=> $1::vector LIMIT $${paramIdx}`;
    params.push(limit);

    const result = await this.pool.query(query, params);
    return result.rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      filePath: row.file_path,
      language: row.language,
      startLine: row.start_line,
      endLine: row.end_line,
      content: row.content,
      embedding: [],
      metadata: row.metadata,
      indexedAt: row.indexed_at,
      score: parseFloat(row.score),
    }));
  }

  /** Keyword search (fallback when embeddings unavailable) */
  async keywordSearch(
    query: string,
    options: { projectId?: string; limit?: number; language?: string } = {},
  ): Promise<Array<StoredChunk & { score: number }>> {
    const limit = options.limit ?? 10;
    const searchTerms = query.toLowerCase().split(/\s+/).filter(Boolean);

    let sql = `
      SELECT *, ts_rank_cd(to_tsvector('english', content), plainto_tsquery('english', $1)) as score
      FROM rag_chunks
      WHERE to_tsvector('english', content) @@ plainto_tsquery('english', $1)
    `;
    const params: unknown[] = [searchTerms.join(" ")];
    let paramIdx = 2;

    if (options.projectId) {
      sql += ` AND project_id = $${paramIdx++}`;
      params.push(options.projectId);
    }
    if (options.language) {
      sql += ` AND language = $${paramIdx++}`;
      params.push(options.language);
    }

    sql += ` ORDER BY score DESC LIMIT $${paramIdx}`;
    params.push(limit);

    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      filePath: row.file_path,
      language: row.language,
      startLine: row.start_line,
      endLine: row.end_line,
      content: row.content,
      embedding: [],
      metadata: row.metadata,
      indexedAt: row.indexed_at,
      score: parseFloat(row.score),
    }));
  }

  /** Hybrid search: combine semantic + keyword results */
  async hybridSearch(
    query: string,
    embedding: number[],
    options: { projectId?: string; limit?: number } = {},
  ): Promise<Array<StoredChunk & { score: number; matchType: string }>> {
    const limit = options.limit ?? 10;
    const [semanticResults, keywordResults] = await Promise.all([
      this.semanticSearch(embedding, { ...options, limit: limit * 2 }),
      this.keywordSearch(query, { ...options, limit: limit * 2 }),
    ]);

    const scoreMap = new Map<
      string,
      {
        chunk: StoredChunk & { score: number };
        semanticScore: number;
        keywordScore: number;
      }
    >();

    for (const r of semanticResults) {
      scoreMap.set(r.id, { chunk: r, semanticScore: r.score, keywordScore: 0 });
    }
    for (const r of keywordResults) {
      const existing = scoreMap.get(r.id);
      if (existing) {
        existing.keywordScore = r.score;
      } else {
        scoreMap.set(r.id, {
          chunk: r,
          semanticScore: 0,
          keywordScore: r.score,
        });
      }
    }

    const combined = Array.from(scoreMap.values()).map((entry) => {
      const hybridScore = entry.semanticScore * 0.7 + entry.keywordScore * 0.3;
      const matchType =
        entry.semanticScore > entry.keywordScore ? "semantic" : "keyword";
      return { ...entry.chunk, score: hybridScore, matchType };
    });

    combined.sort((a, b) => b.score - a.score);
    return combined.slice(0, limit);
  }

  /** Get chunk count for a project */
  async getChunkCount(projectId: string): Promise<number> {
    const result = await this.pool.query(
      "SELECT COUNT(*) as count FROM rag_chunks WHERE project_id = $1",
      [projectId],
    );
    return parseInt(result.rows[0].count, 10);
  }

  /** Clear all chunks for a project */
  async clearProject(projectId: string): Promise<number> {
    const result = await this.pool.query(
      "DELETE FROM rag_chunks WHERE project_id = $1",
      [projectId],
    );
    return result.rowCount ?? 0;
  }

  // --- Repository files (incremental indexing metadata) ---

  /** Get the stored content hash for a file */
  async getFileHash(
    projectId: string,
    filePath: string,
  ): Promise<string | null> {
    const result = await this.pool.query(
      "SELECT content_hash FROM repository_files WHERE project_id = $1 AND file_path = $2",
      [projectId, filePath],
    );
    return result.rows[0]?.content_hash ?? null;
  }

  /** Upsert file hash metadata */
  async upsertFileHash(
    projectId: string,
    filePath: string,
    contentHash: string,
    fileSize: number,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO repository_files (project_id, file_path, content_hash, file_size, last_indexed_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (project_id, file_path) DO UPDATE SET
         content_hash = EXCLUDED.content_hash,
         file_size = EXCLUDED.file_size,
         last_indexed_at = NOW()`,
      [projectId, filePath, contentHash, fileSize],
    );
  }

  /** Remove file metadata */
  async removeFileRecord(projectId: string, filePath: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM repository_files WHERE project_id = $1 AND file_path = $2",
      [projectId, filePath],
    );
  }

  /** List all tracked files for a project */
  async listTrackedFiles(projectId: string): Promise<
    Array<{
      filePath: string;
      contentHash: string;
      fileSize: number;
      lastIndexedAt: Date;
    }>
  > {
    const result = await this.pool.query(
      "SELECT file_path, content_hash, file_size, last_indexed_at FROM repository_files WHERE project_id = $1",
      [projectId],
    );
    return result.rows.map((row) => ({
      filePath: row.file_path,
      contentHash: row.content_hash,
      fileSize: row.file_size,
      lastIndexedAt: row.last_indexed_at,
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
