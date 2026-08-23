-- V3: Fix repository_files.project_id type to match rag_chunks (TEXT, not UUID)
-- The TypeScript RAG engine uses string project IDs, not UUIDs.

DROP TABLE IF EXISTS repository_files;

CREATE TABLE repository_files (
    id SERIAL PRIMARY KEY,
    project_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    last_indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, file_path)
);

CREATE INDEX idx_repository_files_project ON repository_files (project_id);
