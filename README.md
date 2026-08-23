# CodePilot AI

**Production-Grade Agentic Software Engineering Platform for VS Code**

CodePilot AI is an autonomous AI coding assistant that understands your entire repository, searches code semantically, generates implementation plans, modifies multiple files, runs tests, analyzes failures, and fixes them automatically — all while respecting your privacy and security policies.

## Features

### Core Agent Capabilities
- **Autonomous Coding**: Understand requests, plan, implement, test, and review
- **Multi-File Editing**: Modify multiple files with syntax-aware diffs
- **Terminal Execution**: Run build tools, tests, and shell commands
- **Git Intelligence**: Checkpoints, diffs, branch awareness, commit generation
- **Self-Verification**: Run tests, analyze failures, and fix automatically

### Privacy & Security
- **Local-First**: Works 100% offline with Ollama
- **Three Privacy Modes**: Local Only, Hybrid, Cloud
- **Tool Governance**: Per-tool approval policies
- **Command Validation**: Blocks dangerous shell commands
- **SecretStorage**: API keys never exposed to WebView

### AI Provider Support
- **Ollama** (local) — qwen2.5-coder, llama3.2, etc.
- **OpenAI** — GPT-4o, o3
- **Anthropic** — Claude Sonnet 4, Claude Opus 4
- **Google** — Gemini 2.5 Pro/Flash
- **AWS Bedrock**, **Mistral**, **OpenAI-compatible**

### Agent Modes
- **Ask**: Conversational assistance without modifications
- **Plan**: Analyze and create implementation plans
- **Act**: Execute approved plans with file modifications
- **Review**: Code review with severity-classified findings
- **Auto**: Autonomous execution under configured policies

### Developer Tools
- **Architecture Analysis**: Detect frameworks, modules, dependency graphs
- **Code Review Dashboard**: Critical/High/Medium/Low findings with suggested fixes
- **Test Intelligence**: Framework detection, affected test discovery
- **Repository Intelligence**: File discovery, language detection, symbol extraction
- **Three-Layer Memory**: Project, user, and task memory
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
ollama pull qwen2.5-coder:7b
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
4. Select `apps/vscode-extension/dist/codepilot-ai-*.vsix`

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

1. In the agent panel, use the model dropdown to select your Ollama model
2. For cloud providers, configure your API key in Settings

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
  "codepilot.model": "qwen2.5-coder:7b",
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

Create `.cline/rules/` in your project root:

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
│   ├── web-dashboard/       # Optional standalone dashboard
│   └── cli/                 # Optional CLI
├── packages/
│   ├── shared/              # Common types and constants
│   ├── agent-runtime/       # ClineCore integration
│   ├── model-gateway/       # Provider abstraction
│   ├── tool-engine/         # Repository analysis, review, testing tools
│   ├── policy-engine/       # Tool governance and security
│   ├── context-engine/      # Context budgeting and management
│   ├── repository-engine/   # File discovery and indexing
│   ├── rag-engine/          # Embeddings and semantic search
│   ├── memory-engine/       # Three-layer memory system
│   ├── mcp-manager/         # MCP server management
│   ├── git-engine/          # Git intelligence and checkpoints
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

Built with ❤️ using the [Cline SDK](https://github.com/cline/cline), React, Spring Boot, and TypeScript.
