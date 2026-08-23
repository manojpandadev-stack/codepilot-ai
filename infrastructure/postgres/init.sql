-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Create application user if needed
-- (docker-compose already handles this via POSTGRES_USER)
