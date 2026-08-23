# CodePilot AI — Architecture

## Overview

CodePilot AI is a production-grade agentic software engineering platform built as a VS Code extension. It wraps the Cline SDK for core agent runtime capabilities while adding repository intelligence, RAG, multi-agent orchestration, and a Spring Boot control plane.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         VS Code Extension                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ React UI │  │ Commands │  │ WebView  │  │  SecretStorage  │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────────────┘  │
│       │              │              │                            │
│  ┌────┴──────────────┴──────────────┴────────────────────────┐  │
│  │              Extension Host Bridge                         │  │
│  └────────────────────────┬──────────────────────────────────┘  │
└───────────────────────────┼─────────────────────────────────────┘
                            │
┌───────────────────────────┼─────────────────────────────────────┐
│                    Agent Runtime Layer                           │
│  ┌────────────────────────┴──────────────────────────────────┐  │
│  │               ClineCore / AgentRuntime                     │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │  │
│  │  │ Sessions │  │   Tools  │  │  Hooks   │  │  Plugins │  │  │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐    │
│  │ Policy Engine │  │ Context Eng. │  │  Tool Engine       │    │
│  │ (governance)  │  │ (budgeting)  │  │  (repo analysis)   │    │
│  └──────────────┘  └──────────────┘  └────────────────────┘    │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐    │
│  │  Git Engine  │  │ Memory Eng.  │  │  Event Engine      │    │
│  │  (checkpoints│  │ (3 layers)   │  │  (streaming)       │    │
│  └──────────────┘  └──────────────┘  └────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                            │
┌───────────────────────────┼─────────────────────────────────────┐
│                   Model Gateway Layer                            │
│  ┌────────────────────────┴──────────────────────────────────┐  │
│  │           DefaultGateway (Cline LLMs)                      │  │
│  │  ┌────────┐ ┌────────┐ ┌──────────┐ ┌────────┐           │  │
│  │  │ Ollama │ │ OpenAI │ │Anthropic │ │ Google │ ...        │  │
│  │  └────────┘ └────────┘ └──────────┘ └────────┘           │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                            │
┌───────────────────────────┼─────────────────────────────────────┐
│              Optional Control Plane (Spring Boot)                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │ Projects │  │  Runs    │  │   RAG    │  │  Auth (JWT)  │   │
│  │  (JPA)   │  │  (JPA)   │  │(pgvector)│  │              │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────────────┘   │
│       │              │              │                            │
│  ┌────┴──────────────┴──────────────┴────────────────────────┐  │
│  │  PostgreSQL + pgvector  │  Redis  │  Kafka (optional)     │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### 1. Cline SDK as Agent Foundation

Rather than building an agent loop from scratch, CodePilot leverages the Cline SDK v0.0.75:
- **ClineCore**: Session lifecycle, persistence, checkpoints, MCP, hooks, teams
- **AgentRuntime**: Core agent loop with tools, tool policies, streaming events
- **DefaultGateway**: Multi-provider model routing (Ollama, OpenAI, Anthropic, etc.)
- **Built-in tools**: read_files, search, apply_patch, shell, web_fetch

CodePilot adds value on top via:
- Repository intelligence engine
- Context budgeting and management
- Multi-agent task DAG orchestration
- Policy engine with command validation
- Three-layer memory system
- React UI designed for developer workflows

### 2. Local-First Architecture

The extension is fully functional without the backend:
- All inference via Ollama (local)
- SQLite for session persistence (Cline default)
- File-based memory
- No telemetry unless opted in

The Spring Boot control plane is optional for:
- Multi-user deployments
- PostgreSQL-backed RAG with pgvector
- Centralized metadata and analytics
- JWT authentication for server mode

### 3. Privacy by Design

- LOCAL ONLY mode: zero network requests for inference
- Explicit per-task cloud routing in HYBRID mode
- No source code sent to cloud providers unless explicitly configured
- API keys stored in VS Code SecretStorage
- CSP-enforced WebView isolation

## Package Dependencies

```
@codepilot/shared           (types, constants)
    ↑
@codepilot/agent-runtime    (ClineCore wrapper)
@codepilot/model-gateway    (provider abstraction)
@codepilot/policy-engine    (tool governance)
@codepilot/context-engine   (context management)
@codepilot/tool-engine      (repo analysis, review, testing)
@codepilot/git-engine       (checkpoints, diff, commits)
@codepilot/event-engine     (event bus)
@codepilot/memory-engine    (3-layer memory)
@codepilot/repository-engine (file discovery, indexing)
@codepilot/rag-engine       (embeddings, search)
@codepilot/mcp-manager      (MCP server management)
    ↑
@codepilot/vscode-extension (VS Code shell + React UI)
    ↑
com.codepilot.control-plane (Spring Boot backend)
```

## Data Flow

### User sends a message

1. React UI → `chat/send` message → Extension Host
2. Extension Host → `CodePilotRuntime.startSession(prompt)`
3. Runtime → builds system prompt (with context engine, memory)
4. Runtime → `ClineCore.start({ config, prompt })`
5. ClineCore → creates Agent, wires tools, hooks, policies
6. Agent loop → model request → streaming response
7. Tool calls → Policy Engine → approval check → execute → result
8. Events → EventBus → forwarded to Webview
9. Completion → diff display, checkpoint, summary

### Tool execution flow

```
Agent Tool Request
    ↓
Policy Engine.checkPermission(toolName, input)
    ↓
  ┌─ AUTO → execute
  ├─ APPROVAL → UI approval dialog → execute/reject
  └─ BLOCKED → reject with reason
    ↓
Tool Executor (built-in or CodePilot)
    ↓
Result → Agent → continue or finish
```

## Technology Stack

| Layer | Technology |
|-------|-----------|
| VS Code Extension | TypeScript, VS Code API |
| React UI | React, Tailwind CSS |
| Agent Runtime | @cline/sdk v0.0.75 (ClineCore, AgentRuntime) |
| Model Gateway | @cline/llms (DefaultGateway) |
| Ollama | Ollama API (localhost:11434) |
| Control Plane | Java 21, Spring Boot 3.5, Spring Security |
| Database | PostgreSQL 16, pgvector |
| Cache | Redis 7 |
| Events | Kafka 3.8 (optional) |
| Containerization | Docker, Docker Compose |
| Build | pnpm workspaces, esbuild, Maven |
| Testing | Vitest, JUnit 5, Mockito, Testcontainers |
