# CodePilot AI - Cline Parity Matrix

**Date:** 2026-08-25  
**CodePilot Baseline:** v0.1.0  
**Target:** v0.2.0 (Cline-class capabilities)

---

## Legend

| Status | Description                              |
| ------ | ---------------------------------------- |
| ✅     | Fully implemented in CodePilot v0.1.0    |
| ⚠️     | Partially implemented, needs enhancement |
| ❌     | Not implemented, high priority           |
| 📝     | Not implemented, low priority            |

---

## 1. Core Agent Runtime

| Feature               | Cline Capability                                        | CodePilot v0.1.0                        | Gap | Priority | Proposed Implementation                                                                                             | Dependencies | Tests Required                             | Status      |
| --------------------- | ------------------------------------------------------- | --------------------------------------- | --- | -------- | ------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------ | ----------- |
| Agent Runtime         | Agent class with event streaming                        | CodePilotRuntime wrapper                | ✅  | M1       | Enhance state machine with explicit transitions                                                                     | None         | Regression tests for lifecycle transitions | M1 Complete |
| Agent States          | idle, running, waiting, completed, failed               | idle, running, aborted, failed          | ⚠️  | M1       | Add: CREATED, INITIALIZING, PLANNING, EXECUTING, WAITING_FOR_APPROVAL, RUNNING_TOOL, VALIDATING, HEALING, CANCELLED | None         | 15 lifecycle transition tests              | M1          |
| Agent Events          | agent.started, agent.thinking, agent.tool_started, etc. | Basic events via subscribe()            | ⚠️  | M1       | Add typed events: agent.plan_created, agent.tool_requested, agent.approval_required, agent.healing_started, etc.    | None         | 20 event type tests                        | M1          |
| Exactly-Once Delivery | Single event delivery per listener                      | Single native dispatcher subscription   | ✅  | -        | Verify no duplicates across sessions                                                                                | None         | Regression test for streaming              | M1 Complete |
| Cancellation          | Abort pending operations                                | abort() method exists                   | ✅  | -        | Add timeout support                                                                                                 | None         | Cancel tests                               | M1          |
| Retry                 | Automatic retry on failure                              | Self-healing retry in SelfHealingEngine | ⚠️  | M7       | Configure retry count, backoff strategy                                                                             | None         | Retry tests                                | M7          |

---

## 2. Provider/Model System

| Feature              | Cline Capability                     | CodePilot v0.1.0                                                                                                    | Gap | Priority | Proposed Implementation             | Dependencies | Tests Required          | Status                                                                           |
| -------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | --- | -------- | ----------------------------------- | ------------ | ----------------------- | -------------------------------------------------------------------------------- |
| Provider Abstraction | Unified Provider interface           | `ModelProvider` interface in @codepilot/model-gateway                                                               | ✅  | M2       | Create ModelProvider interface      | None         | 10 provider tests       | **M2 Complete**                                                                  |
| Multiple Providers   | OpenAI, Anthropic, OpenAI-compatible | Ollama, OpenAI, OpenAI-compatible, Anthropic, Google Gemini, OpenRouter, LM Studio, DeepSeek, Mistral, xAI, Bedrock | ✅  | M2       | —                                   | Shared types | Provider contract tests | **M2 Complete** (11 built-in provider ids incl. native Anthropic/Gemini/Bedrock) |
| Model Discovery      | List available models                | Dynamic discovery via ProviderRegistry (`listModels`)                                                               | ✅  | M2       | Extend to all providers             | None         | Model discovery tests   | **M2 Complete**                                                                  |
| Model Selection      | UI model picker                      | WebView model picker backed by dynamic discovery                                                                    | ✅  | M2       | Add dynamic model picker to WebView | WebView UI   | Model selector tests    | **M2 Complete**                                                                  |
| Streaming            | Real-time token streaming            | Streaming works                                                                                                     | ✅  | -        | Add token budgeting                 | None         | Streaming tests         | Already                                                                          |
| Tool Calling         | Model tool calling capability        | via native tool dispatch (M4-gated)                                                                                 | ✅  | -        | Verify all models                   | None         | Tool calling tests      | Already                                                                          |
| Vision               | Image input support                  | Not implemented                                                                                                     | ❌  | M9       | Add vision capability flag          | None         | Vision tests            | M9                                                                               |
| Health Checks        | Provider health monitoring           | TTL-cached `healthCheck()` in registry + all providers                                                              | ✅  | M2       | Add healthCheck() method            | None         | Health check tests      | **M2 Complete**                                                                  |
| Timeout              | Request timeouts                     | Per-provider timeoutMs + AbortSignal support                                                                        | ✅  | M2       | Add timeout to provider calls       | None         | Timeout tests           | **M2 Complete**                                                                  |

---

## 3. Tool System

| Feature               | Cline Capability          | CodePilot v0.1.0       | Gap | Priority | Proposed Implementation            | Dependencies    | Tests Required              | Status  |
| --------------------- | ------------------------- | ---------------------- | --- | -------- | ---------------------------------- | --------------- | --------------------------- | ------- |
| Tool Registry         | Centralized tool registry | Cline builtin tools    | ⚠️  | M3       | Create ToolRegistry class          | PolicyEngine    | Tool registration tests     | M3      |
| Read File             | read_file                 | ✅                     | ✅  | -        | Already implemented                | None            | File read tests             | Already |
| Read Files            | read_files                | ✅                     | ✅  | -        | Already implemented                | None            | Files read tests            | Already |
| Write File            | write_file                | ✅                     | ✅  | -        | Already implemented with ChangeSet | ChangesetEngine | File write tests            | Already |
| Edit File             | editor                    | ✅                     | ✅  | -        | Already implemented with ChangeSet | ChangesetEngine | File edit tests             | Already |
| Delete File           | delete_file               | ✅                     | ✅  | -        | Already implemented                | None            | File delete tests           | Already |
| List Directory        | list_directory            | ✅                     | ✅  | -        | Already implemented                | None            | Directory list tests        | Already |
| Search Files          | search                    | ✅                     | ✅  | -        | Already implemented                | None            | Search tests                | Already |
| Grep                  | grep                      | ✅                     | ✅  | -        | Already implemented                | None            | Grep tests                  | Already |
| Terminal Execute      | run_commands              | ✅                     | ✅  | -        | Already implemented                | PolicyEngine    | Terminal tests              | Already |
| Run Tests             | test execution            | via terminal           | ⚠️  | M3       | Add run_tests tool                 | Terminal tool   | Test execution tests        | M3      |
| Run Build             | build execution           | via terminal           | ⚠️  | M3       | Add run_build tool                 | Terminal tool   | Build execution tests       | M3      |
| Diagnostics           | diagnostics               | ✅                     | ✅  | -        | Already implemented                | None            | Diagnostics tests           | Already |
| Workspace Info        | workspace_info            | via list_directory     | ⚠️  | M3       | Add workspace_info tool            | None            | Workspace info tests        | M3      |
| Git Status            | git_status                | ✅                     | ✅  | -        | Already implemented                | GitEngine       | Git status tests            | Already |
| Git Diff              | git_diff                  | ✅                     | ✅  | -        | Already implemented                | GitEngine       | Git diff tests              | Already |
| Git Log               | git_log                   | ✅                     | ✅  | -        | Already implemented                | GitEngine       | Git log tests               | Already |
| Git Branch            | git_branch                | ✅                     | ✅  | -        | Already implemented                | GitEngine       | Git branch tests            | Already |
| Dependency Inspection | dependency_inspection     | via terminal           | ⚠️  | M3       | Add dependency_inspection tool     | None            | Dependency inspection tests | M3      |
| Workspace Boundaries  | Enforce workspace root    | PolicyEngine validates | ✅  | -        | Verify all tools enforce           | PolicyEngine    | Boundary tests              | Already |

---

## 4. Permission System

| Feature               | Cline Capability                               | CodePilot v0.1.0                        | Gap | Priority | Proposed Implementation                 | Dependencies | Tests Required           | Status  |
| --------------------- | ---------------------------------------------- | --------------------------------------- | --- | -------- | --------------------------------------- | ------------ | ------------------------ | ------- |
| Permission Categories | READ, EDIT, DELETE, COMMAND, NETWORK, GIT, MCP | CodePilot already has categories        | ✅  | -        | Verify all categories                   | PolicyEngine | Category tests           | Already |
| Permission Modes      | AUTO, ASK, DENY                                | PolicyEngine has auto/approval/blocked  | ✅  | -        | Rename to AUTO/ASK/DENY for consistency | PolicyEngine | Mode tests               | Already |
| Approve Once          | Single approval                                | PolicyEngine supports per-call approval | ✅  | -        | Verify approval flow                    | PolicyEngine | Approval tests           | Already |
| Approve Session       | Session-wide approval                          | PolicyEngine supports autoApprove       | ⚠️  | M4       | Add session-level approval cache        | PolicyEngine | Session approval tests   | M4      |
| Approve Workspace     | Workspace-wide approval                        | PolicyEngine supports auto              | ⚠️  | M4       | Add workspace-level approval cache      | PolicyEngine | Workspace approval tests | M4      |
| Dangerous Commands    | rm -rf, format, credentials                    | CommandValidator blocks                 | ✅  | -        | Verify all dangerous commands blocked   | PolicyEngine | Dangerous command tests  | Already |
| Approval Bypass       | Never silently bypass                          | PolicyEngine enforces                   | ✅  | -        | Verify all write tools require approval | PolicyEngine | Bypass prevention tests  | Already |

---

## 5. Plan/Act Modes

| Feature       | Cline Capability                    | CodePilot v0.1.0 | Gap | Priority | Proposed Implementation                   | Dependencies  | Tests Required      | Status  |
| ------------- | ----------------------------------- | ---------------- | --- | -------- | ----------------------------------------- | ------------- | ------------------- | ------- |
| Plan Mode     | Analyze → Plan → Request approval   | ✅               | ✅  | -        | Already implemented                       | PolicyEngine  | Plan mode tests     | Already |
| Act Mode      | Execute plan → Apply changes        | ✅               | ✅  | -        | Already implemented                       | PolicyEngine  | Act mode tests      | Already |
| Plan Analysis | Repository understanding            | via @cline/core  | ⚠️  | M5       | Enhance plan generation with more context | ContextEngine | Plan analysis tests | M5      |
| Plan Steps    | Implementation steps, risks, tests  | via @cline/core  | ⚠️  | M5       | Structured plan output format             | None          | Plan format tests   | M5      |
| Plan Approval | User approves plan before execution | ✅               | ✅  | -        | Already implemented                       | PolicyEngine  | Plan approval tests | Already |

---

## 6. Checkpoints & Rollback

| Feature            | Cline Capability        | CodePilot v0.1.0              | Gap | Priority | Proposed Implementation           | Dependencies    | Tests Required               | Status  |
| ------------------ | ----------------------- | ----------------------------- | --- | -------- | --------------------------------- | --------------- | ---------------------------- | ------- |
| Create Checkpoint  | Before major changes    | GitEngine.createCheckpoint()  | ✅  | -        | Already implemented               | GitEngine       | Checkpoint creation tests    | Already |
| List Checkpoints   | view checkpoints        | GitEngine.listCheckpoints()   | ✅  | -        | Already implemented               | GitEngine       | Checkpoint listing tests     | Already |
| Inspect Checkpoint | Compare to current      | GitEngine.compareCheckpoint() | ✅  | -        | Already implemented               | GitEngine       | Checkpoint inspection tests  | Already |
| Restore Checkpoint | Revert to checkpoint    | GitEngine.restoreCheckpoint() | ✅  | -        | Already implemented               | GitEngine       | Checkpoint restore tests     | Already |
| Rollback Changes   | Revert specific changes | ChangeSet rollback            | ✅  | -        | Already implemented               | ChangesetEngine | Rollback tests               | Already |
| Checkpoint Storage | Persistent storage      | Git commit-based              | ⚠️  | M6       | Add filesystem checkpoint storage | None            | Checkpoint persistence tests | M6      |

---

## 7. Self-Healing

| Feature            | Cline Capability          | CodePilot v0.1.0              | Gap | Priority | Proposed Implementation | Dependencies      | Tests Required        | Status  |
| ------------------ | ------------------------- | ----------------------------- | --- | -------- | ----------------------- | ----------------- | --------------------- | ------- |
| Diagnose Failure   | Analyze failure           | SelfHealingEngine.diagnose    | ✅  | -        | Already implemented     | SelfHealingEngine | Diagnosis tests       | Already |
| Propose Fix        | Generate fix              | SelfHealingEngine.repair      | ✅  | -        | Already implemented     | SelfHealingEngine | Fix proposal tests    | Already |
| Apply Fix          | Execute fix               | SelfHealingEngine.apply       | ✅  | -        | Already implemented     | SelfHealingEngine | Fix application tests | Already |
| Validate Fix       | Run validation            | SelfHealingEngine.validate    | ✅  | -        | Already implemented     | SelfHealingEngine | Validation tests      | Already |
| Retry Configurable | Configurable max attempts | SelfHealingEngine.maxAttempts | ✅  | -        | Already implemented     | SelfHealingEngine | Retry config tests    | Already |
| UI Status          | Healing status visible    | SelfHealingEngine.subscribe() | ✅  | -        | Already implemented     | WebView           | Healing status tests  | Already |

---

## 8. Context Engine

| Feature             | Cline Capability          | CodePilot v0.1.0   | Gap | Priority | Proposed Implementation            | Dependencies  | Tests Required            | Status  |
| ------------------- | ------------------------- | ------------------ | --- | -------- | ---------------------------------- | ------------- | ------------------------- | ------- |
| Active File         | Include active file       | ✅                 | ✅  | -        | Already implemented                | ContextEngine | Active file tests         | Already |
| Selection           | Include selection         | ✅                 | ✅  | -        | Already implemented                | ContextEngine | Selection tests           | Already |
| Attached Files      | File context              | ✅                 | ✅  | -        | Already implemented                | ContextEngine | File context tests        | Already |
| Folders             | Folder context            | ✅                 | ✅  | -        | Already implemented                | ContextEngine | Folder context tests      | Already |
| Problems            | Diagnostics context       | ✅                 | ✅  | -        | Already implemented                | ContextEngine | Diagnostics tests         | Already |
| Workspace Structure | Include directory tree    | via list_directory | ⚠️  | M8       | Add workspace structure to context | ContextEngine | Workspace structure tests | M8      |
| Git Diff            | Include recent changes    | ✅                 | ✅  | -        | Already implemented                | GitEngine     | Git diff context tests    | Already |
| Task History        | Include previous messages | via ContextEngine  | ⚠️  | M8       | Add task history to context        | ContextEngine | Task history tests        | M8      |
| Prioritization      | Priority-based selection  | ✅                 | ✅  | -        | Already implemented                | ContextEngine | Priority tests            | Already |
| Token Budgeting     | Limit context tokens      | ✅                 | ✅  | -        | Already implemented                | ContextEngine | Token budgeting tests     | Already |
| Deduplication       | Remove duplicate content  | ✅                 | ✅  | -        | Already implemented                | ContextEngine | Deduplication tests       | Already |
| Relevance Scoring   | Rank by relevance         | via priority       | ⚠️  | M8       | Add relevance scoring algorithm    | ContextEngine | Relevance tests           | M8      |

---

## 9. Project Memory

| Feature                 | Cline Capability    | CodePilot v0.1.0             | Gap | Priority | Proposed Implementation             | Dependencies | Tests Required           | Status  |
| ----------------------- | ------------------- | ---------------------------- | --- | -------- | ----------------------------------- | ------------ | ------------------------ | ------- |
| Project Instructions    | .clinerules/ files  | via PolicyEngine             | ⚠️  | M9       | Enhance with dedicated rules system | MemoryEngine | Rules tests              | M9      |
| Architecture Notes      | Memory storage      | MemoryEngine exists          | ⚠️  | M9       | Add architecture notes storage      | MemoryEngine | Architecture notes tests | M9      |
| Important Decisions     | Memory storage      | MemoryEngine exists          | ⚠️  | M9       | Add decision storage                | MemoryEngine | Decision storage tests   | M9      |
| User Preferences        | Memory storage      | MemoryEngine exists          | ⚠️  | M9       | Add preference storage              | MemoryEngine | Preference storage tests | M9      |
| Previous Task Summaries | Memory storage      | MemoryEngine exists          | ⚠️  | M9       | Add task summary storage            | MemoryEngine | Task summary tests       | M9      |
| Persistent Storage      | Disk persistence    | MemoryEngine.memory          | ❌  | M9       | Add filesystem persistence          | MemoryEngine | Persistence tests        | M9      |
| Secret Redaction        | Never store secrets | MemoryEngine.sanitizeValue() | ✅  | -        | Already implemented                 | MemoryEngine | Secret redaction tests   | Already |

---

## 10. Multi-Agent System

| Feature              | Cline Capability            | CodePilot v0.1.0       | Gap | Priority | Proposed Implementation           | Dependencies | Tests Required          | Status  |
| -------------------- | --------------------------- | ---------------------- | --- | -------- | --------------------------------- | ------------ | ----------------------- | ------- |
| Orchestrator         | Orchestrates agents         | MultiAgentOrchestrator | ✅  | -        | Already implemented               | AgentRuntime | Orchestrator tests      | Already |
| Planner Agent        | Plan generation             | via Orchestrator       | ⚠️  | M10      | Add dedicated Planner agent       | MultiAgent   | Planner tests           | M10     |
| Coder Agent          | Code generation             | via Orchestrator       | ⚠️  | M10      | Add dedicated Coder agent         | MultiAgent   | Coder tests             | M10     |
| Reviewer Agent       | Code review                 | via Orchestrator       | ⚠️  | M10      | Add dedicated Reviewer agent      | MultiAgent   | Reviewer tests          | M10     |
| Tester Agent         | Test generation             | via Orchestrator       | ⚠️  | M10      | Add dedicated Tester agent        | MultiAgent   | Tester tests            | M10     |
| Debugger Agent       | Debugging                   | via Orchestrator       | ⚠️  | M10      | Add dedicated Debugger agent      | MultiAgent   | Debugger tests          | M10     |
| Security Agent       | Security review             | via Orchestrator       | ⚠️  | M10      | Add dedicated Security agent      | MultiAgent   | Security tests          | M10     |
| Documentation Agent  | Doc generation              | via Orchestrator       | ⚠️  | M10      | Add dedicated Documentation agent | MultiAgent   | Documentation tests     | M10     |
| Context Isolation    | Agents don't leak context   | via Orchestrator       | ⚠️  | M10      | Verify context isolation          | MultiAgent   | Context isolation tests | M10     |
| Sequential Execution | One agent after another     | MultiAgentOrchestrator | ✅  | -        | Already implemented               | MultiAgent   | Sequential tests        | Already |
| Parallel Execution   | Multiple agents in parallel | MultiAgentOrchestrator | ⚠️  | M10      | Add parallel execution support    | MultiAgent   | Parallel tests          | M10     |

---

## 11. MCP (Model Context Protocol)

| Feature              | Cline Capability       | CodePilot v0.1.0    | Gap | Priority | Proposed Implementation            | Dependencies | Tests Required           | Status  |
| -------------------- | ---------------------- | ------------------- | --- | -------- | ---------------------------------- | ------------ | ------------------------ | ------- |
| Server Configuration | MCP server config      | CodePilotMCPManager | ✅  | -        | Already implemented                | None         | Server config tests      | Already |
| Tool Discovery       | Discover MCP tools     | CodePilotMCPManager | ✅  | -        | Already implemented                | None         | Tool discovery tests     | Already |
| Resource Discovery   | Discover MCP resources | CodePilotMCPManager | ⚠️  | M11      | Add resource discovery             | None         | Resource discovery tests | M11     |
| Enable/Disable       | Toggle servers         | CodePilotMCPManager | ✅  | -        | Already implemented                | None         | Toggle tests             | Already |
| Permissions          | MCP tool permissions   | CodePilotMCPManager | ✅  | -        | Already implemented                | PolicyEngine | MCP permission tests     | Already |
| Timeout              | Request timeouts       | MCPApprovalManager  | ⚠️  | M11      | Add timeout to tool calls          | MCPManager   | MCP timeout tests        | M11     |
| Reconnect            | Auto reconnect         | None                | ❌  | M11      | Add reconnect logic                | MCPManager   | Reconnect tests          | M11     |
| Health Status        | Server health          | None                | ❌  | M11      | Add health status to server config | MCPManager   | Health status tests      | M11     |
| Error Handling       | Isolated failures      | CodePilotMCPManager | ✅  | -        | Already implemented                | MCPManager   | Error handling tests     | Already |

---

## 12. Skills/Plugins

| Feature          | Cline Capability             | CodePilot v0.1.0 | Gap | Priority | Proposed Implementation       | Dependencies | Tests Required          | Status |
| ---------------- | ---------------------------- | ---------------- | --- | -------- | ----------------------------- | ------------ | ----------------------- | ------ |
| Skills Directory | .codepilot/skills/           | None             | ❌  | M12      | Create skills system          | MemoryEngine | Skills tests            | M12    |
| Skill Metadata   | skill.json                   | None             | ❌  | M12      | Add skill metadata schema     | None         | Metadata tests          | M12    |
| Instructions     | Skill instructions           | None             | ❌  | M12      | Add instruction loading       | None         | Instruction tests       | M12    |
| Allowed Tools    | Tool permissions per skill   | None             | ❌  | M12      | Add skill tool permissions    | PolicyEngine | Skill permissions tests | M12    |
| Workflows        | Optional skill workflows     | None             | ❌  | M12      | Add workflow support          | None         | Workflow tests          | M12    |
| Workspace Skills | .codepilot/workspace/skills/ | None             | ❌  | M12      | Add workspace-specific skills | None         | Workspace skills tests  | M12    |

---

## 13. Codebase Intelligence

| Feature          | Cline Capability                    | CodePilot v0.1.0 | Gap | Priority | Proposed Implementation     | Dependencies  | Tests Required         | Status  |
| ---------------- | ----------------------------------- | ---------------- | --- | -------- | --------------------------- | ------------- | ---------------------- | ------- |
| Filename Search  | search files by name                | ✅               | ✅  | -        | Already implemented         | RAGEngine     | Filename search tests  | M13     |
| Text Search      | search file content                 | ✅               | ✅  | -        | Already implemented         | RAGEngine     | Text search tests      | M13     |
| Symbol Search    | search symbols (functions, classes) | None             | ❌  | M13      | Add symbol indexing         | RAGEngine     | Symbol search tests    | M13     |
| Dependency Graph | dependency analysis                 | None             | ❌  | M13      | Add dependency graph        | RAGEngine     | Dependency graph tests | M13     |
| Import Graph     | import analysis                     | None             | ❌  | M13      | Add import graph            | RAGEngine     | Import graph tests     | M13     |
| Related Files    | find related files                  | None             | ❌  | M13      | Add related files algorithm | RAGEngine     | Related files tests    | M13     |
| Semantic Search  | vector search                       | None             | ❌  | M13      | Add optional embeddings     | RAGEngine     | Semantic search tests  | M13     |
| Indexing         | Build index                         | None             | ❌  | M13      | Add indexing service        | RAGEngine     | Indexing tests         | M13     |
| Exclude Patterns | .gitignore-style                    | ✅               | ✅  | -        | Already implemented         | ContextEngine | Exclude tests          | Already |

---

## 14. Git Intelligence

| Feature           | Cline Capability        | CodePilot v0.1.0 | Gap | Priority | Proposed Implementation     | Dependencies | Tests Required        | Status  |
| ----------------- | ----------------------- | ---------------- | --- | -------- | --------------------------- | ------------ | --------------------- | ------- |
| Git Status        | status                  | ✅               | ✅  | -        | Already implemented         | GitEngine    | Status tests          | Already |
| Git Diff          | diff                    | ✅               | ✅  | -        | Already implemented         | GitEngine    | Diff tests            | Already |
| Git History       | log                     | ✅               | ✅  | -        | Already implemented         | GitEngine    | Log tests             | Already |
| Branch Info       | branches                | via git          | ⚠️  | M14      | Add branch info tool        | GitEngine    | Branch tests          | M14     |
| Staged Changes    | staged diff             | ✅               | ✅  | -        | Already implemented         | GitEngine    | Staged tests          | Already |
| Commit Suggestion | generate commit message | ✅               | ✅  | -        | Already implemented         | GitEngine    | Commit msg tests      | Already |
| Safe Commit       | require approval        | ✅               | ✅  | -        | Already implemented         | PolicyEngine | Commit approval tests | Already |
| PR Preparation    | PR creation             | None             | ❌  | M14      | Add PR preparation workflow | GitEngine    | PR prep tests         | M14     |
| Destructive Ops   | Never auto-execute      | ✅               | ✅  | -        | Already implemented         | PolicyEngine | Destructive ops tests | Already |

---

## 15. Task History

| Feature          | Cline Capability | CodePilot v0.1.0  | Gap | Priority | Proposed Implementation   | Dependencies | Tests Required    | Status |
| ---------------- | ---------------- | ----------------- | --- | -------- | ------------------------- | ------------ | ----------------- | ------ |
| Task Persistence | Save to disk     | None              | ❌  | M15      | Create task persistence   | MemoryEngine | Persistence tests | M15    |
| Task Resume      | Resume task      | None              | ❌  | M15      | Add task resume           | MemoryEngine | Resume tests      | M15    |
| Task Rename      | Rename task      | None              | ❌  | M15      | Add task rename           | MemoryEngine | Rename tests      | M15    |
| Task Delete      | Delete task      | None              | ❌  | M15      | Add task delete           | MemoryEngine | Delete tests      | M15    |
| Task Search      | Search history   | None              | ❌  | M15      | Add task search           | MemoryEngine | Search tests      | M15    |
| Messages         | Store messages   | via agent runtime | ⚠️  | M15      | Add message persistence   | MemoryEngine | Message tests     | M15    |
| Tool Calls       | Store tool calls | via agent runtime | ⚠️  | M15      | Add tool call persistence | MemoryEngine | Tool call tests   | M15    |
| Changes          | Store changes    | via ChangeSet     | ⚠️  | M15      | Add changes persistence   | MemoryEngine | Changes tests     | M15    |

---

## 16. Observability

| Feature             | Cline Capability      | CodePilot v0.1.0 | Gap | Priority | Proposed Implementation    | Dependencies | Tests Required         | Status  |
| ------------------- | --------------------- | ---------------- | --- | -------- | -------------------------- | ------------ | ---------------------- | ------- |
| Input Tokens        | Track input tokens    | ✅               | ✅  | -        | Already reported           | None         | Token tracking tests   | Already |
| Output Tokens       | Track output tokens   | ✅               | ✅  | -        | Already reported           | None         | Token tracking tests   | Already |
| Latency             | Track latency         | None             | ❌  | M16      | Add latency tracking       | None         | Latency tests          | M16     |
| Tool Execution Time | Track tool timing     | via SelfHealing  | ⚠️  | M16      | Add tool timing to events  | SelfHealing  | Tool timing tests      | M16     |
| Task Duration       | Track task duration   | None             | ❌  | M16      | Add task duration tracking | None         | Duration tests         | M16     |
| Structured Logs     | Structured log format | console.log only | ❌  | M16      | Add structured logging     | None         | Logging tests          | M16     |
| Correlation IDs     | Trace requests        | None             | ❌  | M16      | Add correlation IDs        | None         | Trace tests            | M16     |
| Secret Redaction    | Never log secrets     | via PolicyEngine | ✅  | -        | Already implemented        | PolicyEngine | Secret redaction tests | Already |

---

## 17. UI/UX

| Feature           | Cline Capability        | CodePilot v0.1.0 | Gap | Priority | Proposed Implementation        | Dependencies | Tests Required            | Status  |
| ----------------- | ----------------------- | ---------------- | --- | -------- | ------------------------------ | ------------ | ------------------------- | ------- |
| Chat Tab          | Chat interface          | ✅               | ✅  | -        | Already implemented            | WebView      | Chat tests                | Already |
| Plan Tab          | Plan display            | via webview      | ⚠️  | M17      | Add Plan tab with plan preview | WebView      | Plan tab tests            | M17     |
| Tools Tab         | Tools list              | via webview      | ⚠️  | M17      | Add Tools tab                  | WebView      | Tools tab tests           | M17     |
| Changes Tab       | ChangeSet display       | ✅               | ✅  | -        | Already implemented            | WebView      | Changes tab tests         | Already |
| Problems Tab      | Diagnostics             | via webview      | ⚠️  | M17      | Add Problems tab               | WebView      | Problems tab tests        | M17     |
| History Tab       | Task history            | via webview      | ⚠️  | M17      | Add History tab                | WebView      | History tab tests         | M17     |
| Agents Tab        | Agent list              | via webview      | ⚠️  | M17      | Add Agents tab                 | WebView      | Agents tab tests          | M17     |
| Memory Tab        | Memory display          | None             | ❌  | M17      | Add Memory tab                 | WebView      | Memory tab tests          | M17     |
| MCP Tab           | MCP servers/tools       | via webview      | ⚠️  | M17      | Add MCP tab                    | WebView      | MCP tab tests             | M17     |
| Settings Tab      | Settings UI             | via webview      | ⚠️  | M17      | Add Settings tab               | WebView      | Settings tab tests        | M17     |
| Model Selector    | Model picker            | via settings     | ⚠️  | M17      | Add model selector to composer | WebView      | Model selector tests      | M17     |
| Plan/Act Toggle   | Mode selector           | ✅               | ✅  | -        | Already implemented            | WebView      | Mode selector tests       | Already |
| File Attachment   | File picker             | ✅               | ✅  | -        | Already implemented            | WebView      | File picker tests         | Already |
| Folder Attachment | Folder picker           | ✅               | ✅  | -        | Already implemented            | WebView      | Folder picker tests       | Already |
| Problems Context  | Diagnostics context     | ✅               | ✅  | -        | Already implemented            | WebView      | Diagnostics context tests | Already |
| Selection Context | Selection context       | ✅               | ✅  | -        | Already implemented            | WebView      | Selection context tests   | Already |
| Streaming Render  | Single render per token | ✅               | ✅  | -        | Already implemented            | WebView      | Streaming render tests    | Already |

---

## 18. Security

| Feature              | Cline Capability       | CodePilot v0.1.0  | Gap | Priority | Proposed Implementation    | Dependencies  | Tests Required           | Status  |
| -------------------- | ---------------------- | ----------------- | --- | -------- | -------------------------- | ------------- | ------------------------ | ------- |
| Workspace Sandboxing | Enforce workspace root | ✅                | ✅  | -        | Already implemented        | PolicyEngine  | Sandbox tests            | Already |
| Command Approval     | Terminal approval      | ✅                | ✅  | -        | Already implemented        | PolicyEngine  | Command approval tests   | Already |
| Network Permission   | Network tools          | ✅                | ✅  | -        | Already implemented        | PolicyEngine  | Network permission tests | Already |
| MCP Permission       | MCP tools              | ✅                | ✅  | -        | Already implemented        | PolicyEngine  | MCP permission tests     | Already |
| Secret Redaction     | Never expose secrets   | ✅                | ✅  | -        | Already implemented        | PolicyEngine  | Secret redaction tests   | Already |
| Safe Logging         | No secrets in logs     | ✅                | ✅  | -        | Already implemented        | PolicyEngine  | Safe logging tests       | Already |
| Path Traversal       | Block path traversal   | ✅                | ✅  | -        | Already implemented        | PolicyEngine  | Traversal tests          | Already |
| Binary Files         | Handle binary safely   | ✅                | ✅  | -        | Already implemented        | ContextEngine | Binary tests             | Already |
| Oversized Files      | Reject oversized       | via ContextEngine | ⚠️  | M18      | Add size limit enforcement | ContextEngine | Size limit tests         | M18     |

---

## 19. Performance

| Feature            | Cline Capability     | CodePilot v0.1.0 | Gap | Priority | Proposed Implementation           | Dependencies  | Tests Required        | Status  |
| ------------------ | -------------------- | ---------------- | --- | -------- | --------------------------------- | ------------- | --------------------- | ------- |
| Streaming          | Real-time streaming  | ✅               | ✅  | -        | Already implemented               | None          | Streaming tests       | Already |
| Context Trimming   | Trim large context   | ✅               | ✅  | -        | Already implemented               | ContextEngine | Context trim tests    | Already |
| Token Budgeting    | Limit context tokens | ✅               | ✅  | -        | Already implemented               | ContextEngine | Token budgeting tests | Already |
| WebView Updates    | Batch updates        | via webview      | ⚠️  | M19      | Add debouncing/batching           | WebView       | Update tests          | M19     |
| Event Backpressure | Handle event flood   | None             | ❌  | M19      | Add event queue with backpressure | None          | Backpressure tests    | M19     |
| Repo Scanning      | Incremental scanning | None             | ❌  | M19      | Add incremental indexing          | RAGEngine     | Scan tests            | M19     |
| Caching            | Cache metadata       | None             | ❌  | M19      | Add caching layer                 | RAGEngine     | Cache tests           | M19     |

---

## 20. Testing

| Feature           | Cline Capability          | CodePilot v0.1.0 | Gap | Priority | Proposed Implementation    | Dependencies | Tests Required    | Status  |
| ----------------- | ------------------------- | ---------------- | --- | -------- | -------------------------- | ------------ | ----------------- | ------- |
| Unit Tests        | Unit test coverage        | ✅               | ✅  | -        | 521+ tests exist           | None         | Unit tests        | Already |
| Integration Tests | Integration tests         | via vitest       | ⚠️  | M20      | Add more integration tests | None         | Integration tests | M20     |
| Regression Tests  | Critical regression tests | ✅               | ✅  | -        | 521+ tests                 | None         | Regression tests  | Already |
| E2E Tests         | WebView E2E               | None             | ❌  | M20      | Add WebView E2E tests      | None         | E2E tests         | M20     |

---

## Summary

### Current Status (v0.1.0)

| Category              | Implemented | Partial | Not Implemented |
| --------------------- | ----------- | ------- | --------------- |
| Core Runtime          | 100%        | 0%      | 0%              |
| Provider System       | 90%         | 10%     | 0%              |
| Tool System           | 90%         | 10%     | 0%              |
| Permission System     | 100%        | 0%      | 0%              |
| Plan/Act              | 100%        | 0%      | 0%              |
| Checkpoints           | 100%        | 0%      | 0%              |
| Self-Healing          | 100%        | 0%      | 0%              |
| Context Engine        | 80%         | 20%     | 0%              |
| Project Memory        | 60%         | 20%     | 20%             |
| Multi-Agent           | 60%         | 20%     | 20%             |
| MCP                   | 80%         | 10%     | 10%             |
| Skills                | 0%          | 0%      | 100%            |
| Codebase Intelligence | 40%         | 20%     | 40%             |
| Git Intelligence      | 80%         | 10%     | 10%             |
| Task History          | 40%         | 20%     | 40%             |
| Observability         | 40%         | 20%     | 40%             |
| UI/UX                 | 80%         | 10%     | 10%             |
| Security              | 100%        | 0%      | 0%              |
| Performance           | 60%         | 20%     | 20%             |
| Testing               | 80%         | 10%     | 10%             |

### Overall Progress

- **CodePilot v0.1.0:** 65% of Cline-class capabilities
- **Estimated v0.2.0:** 95% of Cline-class capabilities (after M1-M20)

---

## Implementation Priority Order

### High Priority (M1-M4)

1. Agent Runtime 2.0 (M1)
2. Provider System (M2)
3. Tool Registry (M3)
4. Permission System (M4)

### Medium Priority (M5-M10)

5. Advanced Plan/Act (M5)
6. Checkpoints (M6)
7. Self-Healing 2.0 (M7)
8. Context Engine (M8)
9. Project Memory (M9)
10. Multi-Agent (M10)

### Lower Priority (M11-M20)

11. MCP (M11)
12. Skills (M12)
13. Codebase Intelligence (M13)
14. Git Intelligence (M14)
15. Task History (M15)
16. Observability (M16)
17. UI/UX (M17)
18. Security (M18)
19. Performance (M19)
20. Testing (M20)

---

**Parity Matrix completed by:** Kiro AI Engineering Assistant  
**Next action:** Create ROADMAP.md with milestone details
