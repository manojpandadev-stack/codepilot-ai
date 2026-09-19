# CodePilot AI Architecture Audit

**Date:** 2026-08-25  
**Version:** v0.1.0 Baseline  
**Auditor:** Kiro AI Engineering Assistant

> **Historical snapshot.** This audit predates the removal of the delegated
> runtime: statements below describing `@cline/core` integration no longer
> apply — the runtime is CodePilot-owned native code (see
> `docs/architecture/ARCHITECTURE.md`). Retained unchanged as an
> engineering record.

---

## Executive Summary

CodePilot AI is a **well-architected VS Code extension** with a robust TypeScript foundation. The codebase demonstrates strong engineering practices with:

- Modular package structure
- Clear separation of concerns
- Comprehensive type definitions
- Production-grade CI/CD pipeline
- 521+ regression tests

The **existing architecture is production-ready** and requires **incremental enhancement**, not wholesale replacement.

**Risk Level:** LOW - Existing architecture is solid  
**Estimated Complexity:** MEDIUM - Features can be built incrementally  
**Current Maturity:** v0.1.0 - Stable baseline

---

## 1. Current CodePilot Architecture

### 1.1 Package Structure

```
codepilot-ai/
├── apps/
│   ├── vscode-extension/          # VS Code extension (main entry point)
│   ├── webview/                   # React/WebView UI
│   └── cli/                       # CLI (future)
├── packages/
│   ├── agent-runtime/             # Runtime wrapper around @cline/core
│   ├── shared/                    # Shared types and utilities
│   ├── policy-engine/             # Tool governance and approval
│   ├── context-engine/            # Context budgeting and resolution
│   ├── mcp-manager/               # MCP server management
│   ├── git-engine/                # Git intelligence
│   ├── changeset-engine/          # ChangeSet lifecycle management
│   ├── memory-engine/             # Three-layer memory system
│   ├── rag-engine/                # Semantic search (future)
│   ├── repository-engine/         # Repository indexing (future)
│   └── event-engine/              # Event streaming (future)
├── services/
│   └── control-plane/             # Java microservice
├── infrastructure/
│   ├── docker/                    # Docker configuration
│   ├── postgres/                  # Database init
│   ├── redis/                     # Cache
│   └── kafka/                     # Message queue
├── tests/
└── docs/
```

### 1.2 Key Components

#### Agent Runtime (`@codepilot/agent-runtime`)

- Wraps `@cline/core` Agent with CodePilot-specific defaults
- Manages session lifecycle with exactly-one-subscription semantics
- Handles tool approval through PolicyEngine
- Stages write operations as ChangeSets (never writes directly)
- Supports streaming with proper cancellation

**Key Classes:**

- `CodePilotRuntime` - Main runtime wrapper
- `PolicyEngine` - Tool governance
- `SelfHealingEngine` - Auto-healing workflow

#### Policy Engine (`@codepilot/policy-engine`)

- Classifies tools into categories: read, write, execute, network, git, mcp
- Permission modes: auto, approval, blocked
- Command validation with blocked patterns
- Agent mode enforcement (plan mode blocks write tools)

#### VS Code Extension

- Webview provider for chat interface
- Command handlers for plan/act modes
- Context resolution (@file, @folder, @url, @problems)
- ChangeSet management integration
- MCP manager integration
- Recovery manager for auto-healing

#### Shared Types (`@codepilot/shared`)

- `PrivacyMode`: local, hybrid, cloud
- `CodePilotAgentMode`: ask, plan, act, review, auto
- `TaskStatus`, `TaskType`, `AgentRole`
- Tool categories and permissions
- File/Folder/URL/Diagnostic context structures
- Self-healing types and events
- Webview message types

### 1.3 Data Flow

```
User Input → Webview → Extension Host
              ↓
         CodePilotRuntime
              ↓
         ClineCore (Agent)
              ↓
         Tool Registry
              ↓
         PolicyEngine → Approval
              ↓
         File System (via ChangeSet)
              ↓
         Event Stream → WebView
```

### 1.4 Current Capabilities

| Capability         | Status | Notes                                |
| ------------------ | ------ | ------------------------------------ |
| VS Code Extension  | ✅     | Fully functional                     |
| WebView UI         | ✅     | React-based                          |
| Agent Runtime      | ✅     | Robust with exactly-one subscription |
| Tool Execution     | ✅     | Through ClineCore                    |
| File Context       | ✅     | @file, @folder resolution            |
| Problems Context   | ✅     | VS Code diagnostics                  |
| Plan/Act Modes     | ✅     | With PolicyEngine enforcement        |
| ChangeSet Workflow | ✅     | Staged writes with approval          |
| Self-Healing       | ✅     | Validation → Diagnosis → Repair      |
| MCP Support        | ✅     | Server management with approval      |
| Git Intelligence   | ✅     | Status, diff, log, checkpoints       |
| Context Engine     | ✅     | Token budgeting, deduplication       |
| Memory Engine      | ✅     | Project/user/task layers             |
| CI/CD              | ✅     | Full pipeline with tests             |
| Docker             | ✅     | Build and compose                    |

---

## 2. Cline Architecture (Reference)

### 2.1 Architecture Overview

Cline uses a more **integrated architecture** with:

- Direct integration of ClineCore components
- Built-in multi-agent orchestration
- Built-in web search and browser automation
- Built-in task history and persistence
- Built-in skills/plugins system

### 2.2 Key Cline Features (for Comparison)

| Feature              | Cline Implementation   | CodePilot Equivalent        |
| -------------------- | ---------------------- | --------------------------- |
| Agent Runtime        | ClineCore Agent        | CodePilotRuntime (wrapper)  |
| Provider Abstraction | Configurable providers | Ollama-focused              |
| Tool System          | Builtin tools + MCP    | PolicyEngine + MCP Manager  |
| Context Engine       | Built-in               | Separate package            |
| Multi-Agent          | Orchestrator           | MultiAgentOrchestrator      |
| Self-Healing         | Built-in               | Separate package            |
| Checkpoints          | Git-aware              | Git Engine with checkpoints |
| Skills               | Plugin architecture    | Future implementation       |

### 2.3 Cline Strengths to Emulate

1. **Model Provider Abstraction** - Support multiple providers with unified interface
2. **Multi-Agent Orchestration** - Sequential and parallel agent execution
3. **Task History** - Persistent task storage and resume
4. **Skills/Plugins** - Extensible plugin architecture
5. **Web Search** - Built-in web fetching with SSRF protection
6. **Browser Automation** - Headless browser for web tasks

---

## 3. Architecture Gaps

### 3.1 Provider Abstraction

**Gap:** CodePilot is Ollama-focused with hardcoded `qwen3:8b`.  
**Cline:** Supports OpenAI, Anthropic, and OpenAI-compatible APIs.  
**Impact:** Limited model flexibility for users.

### 3.2 Multi-Agent System

**Gap:** MultiAgentOrchestrator exists but is not fully integrated.  
**Cline:** Built-in planner/coder/reviewer agents.  
**Impact:** Single-agent limitation for complex tasks.

### 3.3 Task Persistence

**Gap:** No persistent task storage.  
**Cline:** Tasks saved to disk with resume capability.  
**Impact:** Session loss on extension reload.

### 3.4 Skills/Plugins

**Gap:** No skills system.  
**Cline:** Plugin architecture for custom workflows.  
**Impact:** Limited extensibility.

### 3.5 Token/Cost Tracking

**Gap:** Usage reported but not persisted or visualized.  
**Cline:** Token counts and cost estimates visible.  
**Impact:** No observability into model usage.

### 3.6 Codebase Intelligence

**Gap:** Basic search exists but no semantic search or indexing.  
**Cline:** Codebase indexing with symbol search.  
**Impact:** Limited repository understanding.

### 3.7 Project Memory

**Gap:** Memory engine exists but not fully integrated into prompts.  
**Cline:** Project instructions loaded from `.clinerules/`.  
**Impact:** Agents don't learn from project history.

---

## 4. Duplicate Functionality

| Area           | CodePilot           | Cline    | Recommendation                |
| -------------- | ------------------- | -------- | ----------------------------- |
| Agent Runtime  | CodePilotRuntime    | Agent    | Keep CodePilotRuntime wrapper |
| Policy Engine  | PolicyEngine        | Built-in | Keep separate, enhance        |
| Context Engine | ContextEngine       | Built-in | Keep separate                 |
| Self-Healing   | SelfHealingEngine   | Built-in | Keep separate                 |
| MCP Manager    | CodePilotMCPManager | Built-in | Keep separate                 |

**Verdict:** Minimal duplication. CodePilot's separation of concerns is beneficial.

---

## 5. Missing Abstractions

### 5.1 Model Provider Interface

**Missing:** `ModelProvider` interface with:

```typescript
interface ModelProvider {
  generate(prompt: string, options: GenerateOptions): Promise<GenerationResult>;
  stream(prompt: string, options: GenerateOptions): AsyncGenerator<StreamChunk>;
  chat(messages: Message[], options: GenerateOptions): Promise<ChatResult>;
  healthCheck(): Promise<ProviderHealth>;
  listModels(): Promise<ModelInfo[]>;
  supportsTools(): boolean;
  supportsVision(): boolean;
  supportsStreaming(): boolean;
}
```

**Current:** Ollama-specific discovery via `discoverOllamaModels()`.

### 5.2 Agent Lifecycle State Machine

**Missing:** Explicit state machine with transitions:

```
CREATED → INITIALIZING → PLANNING → EXECUTING →
WAITING_FOR_APPROVAL → RUNNING_TOOL → VALIDATING →
HEALING → COMPLETED/FAILED/CANCELLED
```

**Current:** Basic `idle/running/aborted/failed` states.

### 5.3 Tool Registry

**Missing:** Production-grade `ToolRegistry` with:

- Tool registration/deregistration
- Schema validation
- Permission enforcement
- Timeout/cancellation support
- Result normalization

**Current:** Cline's builtin tools via `createBuiltinTools()`.

### 5.4 Event Bus

**Missing:** Centralized event bus with:

- Typed events
- Exactly-once delivery
- Event replay for session resume
- Event filtering

**Current:** Per-runtime `subscribe()` pattern.

---

## 6. Risk Areas

### 6.1 Testing

**Risk:** 521+ tests, but no E2E tests for WebView.  
**Mitigation:** Add WebView snapshot tests and integration tests.

### 6.2 Security

**Risk:** Some `any` types in event mapping.  
**Mitigation:** Replace `any` with proper type guards.

### 6.3 Error Handling

**Risk:** Silent failures in event handlers.  
**Mitigation:** Add structured error logging with correlation IDs.

### 6.4 Performance

**Risk:** Full repository scans for context.  
**Mitigation:** Implement incremental indexing with caching.

---

## 7. Recommended Migration Order

### Milestone 1: Agent Runtime 2.0 ✅ (Next)

- Implement explicit state machine
- Add typed agent events
- Add exactly-once event forwarding
- Add cancellation/timeout support

### Milestone 2: Provider System

- Create `ModelProvider` interface
- Support multiple providers (Ollama, OpenAI, etc.)
- Add model discovery
- Add health checks

### Milestone 3: Tool Registry

- Create `ToolRegistry`
- Implement all required tools
- Enforce workspace boundaries
- Add permission integration

### Milestone 4: Permission System

- Granular permission categories
- Multiple approval modes
- Dangerous command confirmation

### Milestone 5: Context Engine

- Priority-based context assembly
- Token budgeting
- Relevance scoring

### Milestone 6: Project Memory

- Persistent memory storage
- Project instructions
- Task summaries

### Milestone 7: Multi-Agent

- Orchestrate Planner/Coder/Reviewer
- Sequential and parallel execution
- Context isolation

### Milestone 8-20: Remaining features (see ROADMAP.md)

---

## 8. Conclusion

**Current State:** CodePilot has a **solid foundation** with most core capabilities already implemented. The architecture is modular, well-tested, and production-ready.

**Opportunity:** Incremental enhancement can bring CodePilot to **Cline-class capabilities** without breaking existing functionality.

**Approach:** Follow the milestone order above, with **build-test-typecheck** gates after each milestone.

**Risk:** LOW  
**Timeline:** Estimated 8-12 weeks for full v0.2.0 release  
**Dependencies:** None blocking

---

## 9. Next Steps

1. ✅ Complete this audit
2. ✅ Create CLINE_PARITY_MATRIX.md
3. ✅ Create ROADMAP.md
4. 🔄 Start Milestone 1: Agent Runtime 2.0
5. Implement state machine
6. Add typed events
7. Add regression tests
8. Run build/typecheck/tests

---

**Audit completed by:** Kiro AI Engineering Assistant  
**Next action:** Create CLINE_PARITY_MATRIX.md
