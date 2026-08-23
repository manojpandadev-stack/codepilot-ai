-- CodePilot AI Control Plane Schema
-- V1: Initial schema

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Projects
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    repository_path VARCHAR(1024) NOT NULL,
    default_branch VARCHAR(255),
    technology VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE
);

-- Agent runs
CREATE TABLE agent_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id VARCHAR(255) NOT NULL,
    mode VARCHAR(50),
    provider VARCHAR(100),
    model VARCHAR(255),
    privacy_mode VARCHAR(50),
    status VARCHAR(50) NOT NULL DEFAULT 'running',
    prompt TEXT,
    result TEXT,
    duration_ms BIGINT,
    input_tokens BIGINT,
    output_tokens BIGINT,
    total_cost DOUBLE PRECISION,
    files_changed INTEGER,
    tests_run INTEGER,
    tests_passed INTEGER,
    tests_failed INTEGER,
    started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_agent_runs_project_id ON agent_runs(project_id);
CREATE INDEX idx_agent_runs_status ON agent_runs(status);
CREATE INDEX idx_agent_runs_started_at ON agent_runs(started_at DESC);

-- Tool calls
CREATE TABLE tool_calls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    tool_name VARCHAR(255) NOT NULL,
    input TEXT,
    output TEXT,
    status VARCHAR(50),
    duration_ms BIGINT,
    error TEXT,
    started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_tool_calls_agent_run_id ON tool_calls(agent_run_id);
CREATE INDEX idx_tool_calls_tool_name ON tool_calls(tool_name);

-- Checkpoints
CREATE TABLE checkpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
    git_commit_hash VARCHAR(64),
    files JSONB,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_checkpoints_agent_run_id ON checkpoints(agent_run_id);

-- Memory
CREATE TABLE memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    scope VARCHAR(50) NOT NULL,
    key VARCHAR(255) NOT NULL,
    value TEXT NOT NULL,
    tags JSONB DEFAULT '[]',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE,
    UNIQUE(project_id, scope, key)
);

CREATE INDEX idx_memory_project_scope ON memory(project_id, scope);

-- Document chunks for RAG
CREATE TABLE document_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_path VARCHAR(1024) NOT NULL,
    language VARCHAR(50),
    start_line INTEGER,
    end_line INTEGER,
    content TEXT NOT NULL,
    embedding vector(384),
    metadata JSONB DEFAULT '{}',
    indexed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_document_chunks_project_id ON document_chunks(project_id);
CREATE INDEX idx_document_chunks_language ON document_chunks(language);

-- Audit events
CREATE TABLE audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR(100) NOT NULL,
    actor VARCHAR(255),
    details JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_events_type ON audit_events(event_type);
CREATE INDEX idx_audit_events_created_at ON audit_events(created_at DESC);
