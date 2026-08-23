# CodePilot AI — Development Guide

## Project Structure

```
codepilot-ai/
├── apps/
│   ├── vscode-extension/     # VS Code extension (TypeScript)
│   ├── webview/               # React sidebar UI
│   └── cli/                   # CLI tool (planned)
│
├── packages/
│   ├── shared/                # Shared types and utilities
│   ├── agent-runtime/         # Cline SDK integration, multi-agent orchestrator
│   ├── model-gateway/         # Provider abstraction (Ollama, OpenAI, etc.)
│   ├── tool-engine/           # Tool definitions and execution
│   ├── policy-engine/         # Tool permission governance
│   ├── context-engine/        # Context budgeting and management
│   ├── repository-engine/     # Repository intelligence
│   ├── rag-engine/            # RAG with pgvector + Ollama embeddings
│   ├── memory-engine/         # Project/user/task memory
│   ├── mcp-manager/           # MCP server management
│   ├── git-engine/            # Git integration
│   └── event-engine/          # Event streaming
│
├── services/
│   └── control-plane/         # Spring Boot backend (Java 21)
│
├── infrastructure/
│   └── postgres/init.sql      # Database initialization
│
├── tests/                     # Integration tests
├── docs/                      # Documentation
└── docker-compose.yml         # Infrastructure
```

## Technology Stack

| Layer | Technology |
|---|---|
| Extension | TypeScript, VS Code API |
| UI | React 19, Vite, Tailwind CSS |
| Agent Runtime | Cline SDK 0.0.75 |
| AI Provider | Ollama (local), OpenAI, Anthropic, Gemini |
| Embeddings | Ollama nomic-embed-text |
| Database | PostgreSQL 16 + pgvector |
| Cache | Redis 7 |
| Events | Apache Kafka |
| Backend | Java 21, Spring Boot 3.5 |
| Testing | Vitest (TS), JUnit 5 (Java) |
| CI/CD | GitHub Actions |

## Development Workflow

### 1. Start Services

```bash
# Start PostgreSQL and Redis
docker compose up -d postgres redis

# Start Ollama (separate terminal)
ollama serve
```

### 2. Build Packages

```bash
# Build all TypeScript packages
for pkg in shared agent-runtime model-gateway policy-engine context-engine \
  event-engine memory-engine tool-engine git-engine repository-engine \
  rag-engine mcp-manager; do
  (cd packages/$pkg && npx tsc -p tsconfig.json)
done
```

### 3. Run Tests

```bash
# Run all automated tests
pnpm exec vitest run

# Run specific package tests
pnpm exec vitest run packages/policy-engine
pnpm exec vitest run packages/git-engine
```

### 4. Build Extension

```bash
# Build webview
cd apps/webview && npx vite build

# Build extension
cd ../vscode-extension && node esbuild.mjs

# Package VSIX
npx @vscode/vsce package --no-dependencies --allow-missing-repository
```

### 5. Install Extension

```bash
code --install-extension apps/vscode-extension/codepilot-ai-0.1.0.vsix
```

## Adding a New Package

1. Create directory: `packages/my-package/`
2. Add `package.json`:
```json
{
  "name": "@codepilot/my-package",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@codepilot/shared": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.2.0"
  }
}
```
3. Add `tsconfig.json` extending the root
4. Create `src/index.ts`
5. Run `pnpm install`

## Code Style

- **TypeScript**: Strict mode, no `any` types
- **Imports**: Use `.js` extension for ESM compatibility
- **Naming**: camelCase for variables/functions, PascalCase for classes/types
- **Exports**: Named exports, no default exports
- **Tests**: Colocated with source: `src/index.test.ts`

## Testing

### Unit Tests (Vitest)

```bash
# Run all tests
pnpm exec vitest run

# Run with coverage
pnpm exec vitest run --coverage

# Watch mode
pnpm exec vitest watch
```

### Integration Tests

```bash
# RAG integration test (requires PostgreSQL + Ollama)
pnpm exec tsx tests/rag-integration-test.ts

# Vertical slice test (requires Ollama)
node --experimental-strip-types tests/vertical-slice-prove.ts
```

### Java Tests

```bash
cd services/control-plane
mvn test
mvn verify  # Includes integration tests
```

## Architecture Decisions

### Why Cline SDK?

CodePilot AI uses the official Cline SDK (`@cline/sdk`, `@cline/core`, `@cline/agents`) as the agent runtime foundation. This provides:
- Proven agent loop implementation
- Structured tool calling
- Session persistence
- Provider abstraction

### Why pgvector?

PostgreSQL with pgvector provides:
- Vector similarity search for RAG
- Hybrid search (semantic + keyword)
- Incremental indexing
- SQL-based metadata filtering

### Why qwen3:8b?

`qwen3:8b` is the recommended local model because it:
- Supports structured tool calls (not just text)
- Has strong coding capability
- Runs on 16GB RAM
- Has 32K context window

### Modular Architecture

Each package has a single responsibility:
- Changes to the RAG engine don't affect the policy engine
- The MCP manager can be used independently
- The policy engine works with any tool provider

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes with tests
4. Run `pnpm exec vitest run`
5. Run `for pkg in ...; do (cd packages/$pkg && npx tsc --noEmit); done`
6. Submit a pull request

## Release Process

1. Update version in `apps/vscode-extension/package.json`
2. Build all packages
3. Run all tests
4. Build VSIX: `cd apps/vscode-extension && npx @vscode/vsce package --no-dependencies --allow-missing-repository`
5. Tag release: `git tag v0.1.0`
6. Upload VSIX artifact
