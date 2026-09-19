# CodePilot AI — Local Development Setup

## Prerequisites

- **Node.js** 22+
- **pnpm** 11+
- **Java** 21+ (for Spring Boot control plane)
- **Maven** 3.9+
- **Docker** (for PostgreSQL, Redis, Kafka)
- **Ollama** (for local AI models)
- **VS Code** (for the extension)

## Quick Start

### 1. Install Dependencies

```bash
cd codepilot-ai
pnpm install
```

### 2. Start Ollama

```bash
# Start Ollama server
ollama serve

# Pull the recommended model (tool-calling capable)
ollama pull qwen3:8b

# Pull embedding model for RAG
ollama pull nomic-embed-text
```

### 3. Start Infrastructure (Optional — for control plane features)

```bash
# Start PostgreSQL (with pgvector) and Redis
docker compose up -d postgres redis

# Verify
docker compose ps
```

### 4. Build TypeScript Packages

```bash
# Build all packages
for pkg in shared agent-runtime model-gateway policy-engine context-engine \
  event-engine memory-engine tool-engine git-engine repository-engine \
  rag-engine mcp-manager; do
  (cd packages/$pkg && npx tsc -p tsconfig.json)
done
```

### 5. Run Tests

```bash
# Run all automated tests
pnpm exec vitest run
```

### 6. Build the VS Code Extension

```bash
# Build the React webview
cd apps/webview && npx vite build

# Build the extension
cd ../vscode-extension && node esbuild.mjs

# Package as VSIX
npx @vscode/vsce package --no-dependencies --allow-missing-repository
```

### 7. Install the Extension

```bash
# From VS Code: Extensions → ... → Install from VSIX
# Or from command line:
code --install-extension apps/vscode-extension/codepilot-ai-0.1.0.vsix
```

## Spring Boot Control Plane (Optional)

```bash
# Start PostgreSQL and Redis
docker compose up -d postgres redis

# Run Spring Boot
cd services/control-plane
mvn spring-boot:run

# Verify health
curl http://localhost:8081/actuator/health
```

## Configuration

### VS Code Settings

Open Settings (Ctrl+,) and search for "CodePilot":

| Setting                            | Default                  | Description                       |
| ---------------------------------- | ------------------------ | --------------------------------- |
| `codepilot.provider`               | `ollama`                 | AI provider                       |
| `codepilot.model`                  | `qwen3:8b`               | Model ID                          |
| `codepilot.privacyMode`            | `local`                  | Privacy mode (local/hybrid/cloud) |
| `codepilot.agentMode`              | `act`                    | Default agent mode                |
| `codepilot.localAI.ollama.baseUrl` | `http://localhost:11434` | Ollama URL                        |
| `codepilot.maxIterations`          | `50`                     | Max agent iterations              |

### Privacy Modes

- **LOCAL ONLY**: All inference happens locally. No source code leaves the machine.
- **HYBRID**: User selects which tasks can use cloud providers.
- **CLOUD**: Uses configured API providers.

## Architecture

```
VS Code Extension
├── React WebView (sidebar UI)
├── Extension Host (Node.js)
├── Agent Runtime (CodePilot native engine)
│   └── CodePilotRuntime → native sessions, tools, continuity
├── Provider Gateway
│   ├── Ollama (local)
│   ├── OpenAI
│   ├── Anthropic
│   └── Google Gemini
├── Tool Engine
├── Policy Engine
├── Context Engine
├── RAG Engine (pgvector)
├── Multi-Agent Orchestrator
├── Memory Engine
└── MCP Manager

Optional Control Plane (Spring Boot)
├── REST API
├── PostgreSQL + pgvector
├── Redis
└── Kafka
```

## Troubleshooting

### Ollama not connecting

```bash
# Check if Ollama is running
curl http://localhost:11434/api/tags

# Restart Ollama
ollama serve
```

### Port conflicts

```bash
# Check what's using a port
netstat -ano | grep :5432
netstat -ano | grep :8081

# Update ports in:
# - docker-compose.yml (PostgreSQL: 5433)
# - services/control-plane/src/main/resources/application.yml (server.port: 8081)
```

### TypeScript compilation errors

```bash
# Clean and rebuild
for pkg in shared agent-runtime model-gateway policy-engine context-engine \
  event-engine memory-engine tool-engine git-engine repository-engine \
  rag-engine mcp-manager; do
  (cd packages/$pkg && rm -rf dist && npx tsc -p tsconfig.json)
done
```
