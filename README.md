# CodePilot AI

**Production-Grade Agentic Software Engineering Platform for VS Code**

CodePilot — an independently implemented AI coding assistant for VS Code.

CodePilot AI is an AI coding assistant for VS Code that works with your
repository: it can read and search code, propose and stage file changes for
your approval, run terminal commands through an approval gate, and keep a
persistent, resumable record of each task — all while respecting your
privacy and security policies. Agentic actions always pass explicit
approval boundaries; nothing executes silently.

## Features

### Core Agent Capabilities
- **Assisted Coding**: Understand requests, plan, implement, test, and review
- **Multi-File Editing**: Propose changes across files as reviewable diffs (ChangeSet approval)
- **Terminal Execution**: Run build tools, tests, and shell commands (approval-gated)
- **Git Intelligence**: Checkpoints, diffs, branch awareness
- **Self-Verification**: Run tests and surface failures for approved follow-ups

### Privacy & Security
- **Local-First**: Runs fully on-machine with Ollama once models are pulled
- **Three Privacy Modes**: Local Only, Hybrid, Cloud
- **Tool Governance**: Per-tool approval policies
- **Command Validation**: Blocks dangerous shell commands
- **SecretStorage**: API keys never exposed to WebView

### AI Provider Support

Provider support is driven by a single authoritative CodePilot-owned
catalogue (`CODEPILOT_PROVIDER_CATALOG` in `@codepilot/llm`, see
`docs/PROVIDERS.md`):

- **12 curated providers** appear in the provider selector: **Ollama** and
  **LM Studio** (local), **OpenAI**, **Anthropic**, **Google Gemini**,
  **OpenRouter**, **ZhipuAI / Z.AI**, plus generic **OpenAI-compatible**
  and **custom** endpoints (custom base URL + API key)
- Any other OpenAI-compatible endpoint works through the custom provider
  (base URL + key); credentials are stored in VS Code SecretStorage
- Local providers discover models live from the running server; cloud
  providers offer curated catalogue models

> Live-verified in this repository: Ollama (full E2E including native tool
> calling and M4 approval). Other providers share the same native provider
> path and are covered by stubbed-wire suites — use the provider
> selector's Test Connection probe before relying on a new provider.

### Agent Modes
- **Ask**: Conversational assistance without modifications
- **Plan**: Analyze and create implementation plans
- **Act**: Execute approved plans with file modifications
- **Review**: Code review with severity-classified findings
- **Auto**: Autonomous execution under configured policies

### Developer Tools
- **Browser Tools**: Navigate pages and extract content through policy-checked, SSRF-protected fetching
- **Architecture Analysis**: Agent-driven codebase surveys via the Analyze Repository command
- **Code Review**: Severity-classified findings via review mode and Review commands
- **Test Execution**: Run suites via approval-gated terminal commands
- **Workspace Search**: File discovery and content search across the workspace
- **Task Memory**: Persistent per-task history with resume and continuity
- **MCP Manager**: Configure and manage MCP servers

### Optional Backend (Spring Boot)
- REST API for project and agent run management
- PostgreSQL with pgvector for semantic search
- Redis for caching and state management
- JWT authentication (optional)
- Kafka event streaming (optional)

## Quick Start

### Prerequisites
- Node.js 22+
- Java 21 (for Spring Boot control plane)
- Maven 3.9+ (for Spring Boot control plane)
- Ollama installed and running

### Install Ollama Models

```bash
ollama pull qwen3:8b
```

### Setup (Extension Only)

```bash
# Clone and install
cd codepilot-ai
pnpm install

# Build packages
pnpm build:packages

# Build extension
pnpm build:extension
```

### Install in VS Code

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X)
3. Click "..." → "Install from VSIX..."
4. Select `apps/vscode-extension/codepilot-ai-0.1.0.vsix`

Or press F5 in the extension project to launch the Extension Development Host.

### Setup with Control Plane (Optional)

```bash
# Start infrastructure
docker compose up -d postgres redis

# Start control plane
docker compose --profile backend up -d control-plane

# Or run directly with Maven
cd services/control-plane
mvn spring-boot:run
```

## Usage

### Open the Agent Panel

- **Keyboard**: `Ctrl+Shift+A` (or `Cmd+Shift+A` on Mac)
- **Command Palette**: "CodePilot: Open Agent"
- **Sidebar**: Click the robot icon in the activity bar

### Select Your Provider

1. In the agent panel, use the provider selector (search the curated
   providers, check status badges, and configure credentials — keys go to VS Code SecretStorage)
2. Local providers (Ollama/LM Studio) list models discovered from the running
   server; cloud providers offer their catalogue models

### Start Coding

Type your request in the chat:
- "Add Redis caching to the OrderService"
- "Review this file for security issues"
- "Generate unit tests for the UserController"
- "Explain the architecture of this repository"

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+A` | Open Agent Panel |
| `Ctrl+Shift+E` | Explain Selection |
| `Ctrl+Shift+.` | Stop Agent |
| `Enter` | Send Message |
| `Shift+Enter` | New Line |

## Configuration

### Settings

```json
{
  "codepilot.provider": "ollama",
  "codepilot.model": "qwen3:8b",
  "codepilot.privacyMode": "local",
  "codepilot.agentMode": "act",
  "codepilot.localAI.ollama.baseUrl": "http://localhost:11434",
  "codepilot.autoApproval.read": true,
  "codepilot.autoApproval.write": false,
  "codepilot.autoApproval.terminal": false,
  "codepilot.maxIterations": 50
}
```

### Project Rules

Create `.codepilot/rules/` in your project root (global rules live in
`~/.codepilot/rules/`):

```markdown
---
name: Java Standards
globs: "**/*.java"
---

- Use Java 21 features where appropriate
- Follow Google Java Style Guide
- All public methods must have Javadoc
- Use Optional instead of null returns
```

## Architecture

See [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md) for detailed architecture documentation.

## Project Structure

```
codepilot-ai/
├── apps/
│   ├── vscode-extension/    # VS Code extension + React UI
│   └── cli/                 # Headless CLI runner
├── packages/
│   ├── shared/              # Common types and constants
│   ├── agent-runtime/       # Native CodePilot agent runtime (sessions, tools, continuity)
│   ├── model-gateway/       # Provider abstraction
│   ├── tool-engine/         # Terminal/streaming execution, M4 bridge, audit
│   ├── policy-engine/       # Tool governance and security
│   ├── context-engine/      # Context budgeting and management
│   ├── repository-engine/   # File discovery and indexing
│   ├── rag-engine/          # Embeddings and semantic search
│   ├── memory-engine/       # Three-layer memory system
│   ├── mcp-manager/         # MCP server management
│   ├── git-engine/          # Git utilities (tested library; live git flows via terminal)
│   └── event-engine/        # Event bus for streaming
├── services/
│   └── control-plane/       # Spring Boot backend
├── infrastructure/          # Docker, PostgreSQL, Redis, Kafka
├── docs/                    # Architecture and API docs
└── tests/                   # Integration tests
```

## Testing

```bash
# Run all tests
pnpm test

# Run package tests
pnpm --filter @codepilot/agent-runtime test
pnpm --filter @codepilot/tool-engine test

# Run Spring Boot tests
cd services/control-plane && mvn test
```

## Security

- API keys stored in VS Code SecretStorage (never plaintext)
- Dangerous commands blocked by Policy Engine
- WebView CSP prevents script injection
- Tool approval policies enforced before execution
- No telemetry by default (opt-in only)
- Local mode sends zero data externally

## License

Apache License 2.0

---

Built with React, TypeScript, and CodePilot's native agent runtime.
