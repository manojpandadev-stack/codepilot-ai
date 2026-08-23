-- V2: Normalize RAG schema
-- Drops the old document_chunks (vector(384)) and replaces with rag_chunks (vector(768))
-- Adds repository_files for incremental indexing metadata

-- Drop old document_chunks table and its indexes
DROP INDEX IF EXISTS idx_document_chunks_language;
DROP INDEX IF EXISTS idx_document_chunks_project_id;
DROP TABLE IF EXISTS document_chunks;

-- RAG chunks — single source of truth for both Spring Boot and TypeScript
CREATE TABLE IF NOT EXISTS rag_chunks (
    id TEXT PRIMARY KEY,
    project_id UUID NOT NULL,
    file_path TEXT NOT NULL,
    language TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding vector(768),
    metadata JSONB DEFAULT '{}',
    indexed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rag_chunks_project ON rag_chunks (project_id);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_file ON rag_chunks (project_id, file_path);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_embedding ON rag_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Repository files — persistent metadata for incremental indexing
CREATE TABLE IF NOT EXISTS repository_files (
    id SERIAL PRIMARY KEY,
    project_id UUID NOT NULL,
    file_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    last_indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, file_path)
);

CREATE INDEX IF NOT EXISTS idx_repository_files_project ON repository_files (project_id);
