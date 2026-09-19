# CodePilot AI v0.2.0 Roadmap

**Date:** 2026-08-25  
**Baseline:** v0.1.0  
**Target:** v0.2.0 (Cline-class capabilities)

---

## Overview

This roadmap describes the incremental implementation of CodePilot AI v0.2.0 from its current baseline to a production-grade AI coding agent with Cline-class capabilities.

**Key Principles:**

- Do not break existing functionality
- Implement incrementally, milestone-by-milestone
- Build-test-typecheck after each milestone
- No skipping tests
- No continue-on-error in CI

---

## Milestones

### Milestone 1: Agent Runtime 2.0

**Status:** ✅ COMPLETE (delivered: state machine, typed events, exactly-once streaming, cancellation, timeout)  
**Priority:** HIGH  
**Estimated Time:** 2 weeks

#### Goals

- Implement explicit agent state machine
- Add typed agent events
- Ensure exactly-once event delivery
- Add cancellation and timeout support

#### Tasks

| Task          | Description                                                                                                                                                                                                                                                                                                                    | Success Criteria                               | Tests                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | ------------------------- |
| State Machine | Add states: CREATED, INITIALIZING, PLANNING, EXECUTING, WAITING_FOR_APPROVAL, RUNNING_TOOL, VALIDATING, HEALING, COMPLETED, FAILED, CANCELLED                                                                                                                                                                                  | State machine implemented and documented       | State transition tests    |
| Agent Events  | Add events: agent.started, agent.thinking, agent.plan_created, agent.tool_requested, agent.tool_started, agent.tool_progress, agent.tool_completed, agent.approval_required, agent.validation_started, agent.validation_failed, agent.healing_started, agent.healing_completed, agent.completed, agent.failed, agent.cancelled | All events typed and delivered                 | Event type tests          |
| Exactly-Once  | Ensure exactly-one core listener and one event delivery                                                                                                                                                                                                                                                                        | No duplicates across sessions                  | Streaming regression test |
| Cancellation  | Add abort() with proper cleanup                                                                                                                                                                                                                                                                                                | Abort cancels current run cleanly              | Cancel tests              |
| Timeout       | Add configurable timeouts to agent operations                                                                                                                                                                                                                                                                                  | Timeout throws error after configured duration | Timeout tests             |

#### Dependencies

- None (can be done immediately)

#### Gate Criteria

- [x] All new states and events implemented
- [x] Streaming regression test passes
- [x] Cancel/timeout tests pass
- [x] Build passes
- [x] Typecheck passes
- [x] 521+ tests pass

---

### Milestone 2: Provider System

**Status:** ✅ COMPLETE (delivered: `@codepilot/model-gateway` — ModelProvider interface, OllamaProvider, OpenAICompatibleProvider, ProviderRegistry with discovery/health/fallback/observability, config validation, error normalization, SecretStorage key handling, runtime + WebView integration. See docs/PROVIDER_ARCHITECTURE.md.)
**Priority:** HIGH  
**Estimated Time:** 2 weeks

#### Goals

- Create unified `ModelProvider` interface
- Support multiple providers (Ollama, OpenAI, OpenAI-compatible)
- Add model discovery and health checks

#### Tasks

| Task                    | Description                                                                                                                             | Success Criteria                               | Tests                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------- |
| ModelProvider Interface | Create interface with generate(), stream(), chat(), healthCheck(), listModels(), supportsTools(), supportsVision(), supportsStreaming() | Interface defined and implemented              | Provider contract tests |
| Ollama Provider         | Implement Ollama provider                                                                                                               | All existing Ollama tests pass                 | Ollama tests            |
| OpenAI Provider         | Implement OpenAI provider                                                                                                               | OpenAI API tests pass                          | OpenAI tests            |
| Generic HTTP Provider   | Implement generic HTTP provider                                                                                                         | Generic API tests pass                         | Generic provider tests  |
| Model Discovery         | Extend discoverOllamaModels() to all providers                                                                                          | discoverModels() works for all providers       | Model discovery tests   |
| Model Selection         | Add dynamic model picker in WebView                                                                                                     | User can select model from dropdown            | Model selector tests    |
| Health Checks           | Add healthCheck() method                                                                                                                | Health check returns provider status           | Health check tests      |
| Timeout Support         | Add timeout to provider calls                                                                                                           | Timeout throws error after configured duration | Timeout tests           |

#### Dependencies

- Milestone 1 (Agent Runtime 2.0)

#### Gate Criteria

- [x] ModelProvider interface implemented
- [x] All providers work
- [x] Model discovery works for all providers
- [x] Build passes
- [x] Typecheck passes
- [x] 521+ tests pass

---

### Milestone 3: Tool Registry

**Status:** After M2  
**Priority:** HIGH  
**Estimated Time:** 3 weeks

#### Goals

- Create `ToolRegistry` with all required tools
- Enforce workspace boundaries
- Add permission integration

#### Tasks

| Task                  | Description                                      | Success Criteria                 | Tests                       |
| --------------------- | ------------------------------------------------ | -------------------------------- | --------------------------- |
| ToolRegistry Class    | Create registry with registration/deregistration | Registry works                   | Registration tests          |
| Read File             | Implement read_file tool                         | Existing tests pass              | File read tests             |
| Read Files            | Implement read_files tool                        | Existing tests pass              | Files read tests            |
| Write File            | Implement write_file tool                        | Existing tests pass              | File write tests            |
| Edit File             | Implement edit_file tool                         | Existing tests pass              | File edit tests             |
| Delete File           | Implement delete_file tool                       | Existing tests pass              | File delete tests           |
| List Directory        | Implement list_directory tool                    | Existing tests pass              | Directory list tests        |
| Search Files          | Implement search_files tool                      | Existing tests pass              | Search tests                |
| Grep                  | Implement grep tool                              | Existing tests pass              | Grep tests                  |
| Terminal Execute      | Implement terminal_execute tool                  | Existing tests pass              | Terminal tests              |
| Run Tests             | Implement run_tests tool                         | Test execution tests pass        | Test execution tests        |
| Run Build             | Implement run_build tool                         | Build execution tests pass       | Build execution tests       |
| Diagnostics           | Implement diagnostics tool                       | Existing tests pass              | Diagnostics tests           |
| Workspace Info        | Implement workspace_info tool                    | Workspace info tests pass        | Workspace info tests        |
| Git Status            | Implement git_status tool                        | Git tests pass                   | Git status tests            |
| Git Diff              | Implement git_diff tool                          | Git tests pass                   | Git diff tests              |
| Git Log               | Implement git_log tool                           | Git tests pass                   | Git log tests               |
| Git Branch            | Implement git_branch tool                        | Git tests pass                   | Git branch tests            |
| Dependency Inspection | Implement dependency_inspection tool             | Dependency inspection tests pass | Dependency inspection tests |

#### Dependencies

- Milestone 2 (Provider System)

#### Gate Criteria

- [ ] ToolRegistry implemented
- [ ] All tools work
- [ ] Workspace boundaries enforced
- [ ] Build passes
- [ ] Typecheck passes
- [ ] 521+ tests pass

---

### Milestone 4: Permission System

**Status:** After M3  
**Priority:** HIGH  
**Estimated Time:** 1 week

#### Goals

- Implement granular permission categories
- Add multiple approval modes
- Ensure dangerous commands require confirmation

#### Tasks

| Task                  | Description                                      | Success Criteria               | Tests                    |
| --------------------- | ------------------------------------------------ | ------------------------------ | ------------------------ |
| Permission Categories | READ, EDIT, DELETE, COMMAND, NETWORK, MCP, GIT   | All categories implemented     | Category tests           |
| Permission Modes      | AUTO, ASK, DENY                                  | All modes implemented          | Mode tests               |
| Approve Once          | Single approval for each tool call               | Approval flow works            | Approval tests           |
| Approve Session       | Session-wide approval cache                      | Session approval works         | Session approval tests   |
| Approve Workspace     | Workspace-wide approval cache                    | Workspace approval works       | Workspace approval tests |
| Dangerous Commands    | rm -rf, format, credentials require confirmation | All dangerous commands blocked | Dangerous command tests  |

#### Dependencies

- Milestone 3 (Tool Registry)

#### Gate Criteria

- [ ] All permission categories implemented
- [ ] All approval modes work
- [ ] Dangerous commands blocked
- [ ] Build passes
- [ ] Typecheck passes
- [ ] 521+ tests pass

---

### Milestone 5: Advanced Plan/Act

**Status:** After M4  
**Priority:** MEDIUM  
**Estimated Time:** 2 weeks

#### Goals

- Enhance Plan mode with better analysis
- Enhance Act mode with better execution

#### Tasks

| Task          | Description                         | Success Criteria                  | Tests               |
| ------------- | ----------------------------------- | --------------------------------- | ------------------- |
| Plan Analysis | Enhance with more context           | Plan includes files, risks, tests | Plan analysis tests |
| Plan Steps    | Structured plan output format       | Plan includes steps, risks, tests | Plan format tests   |
| Plan Approval | User approves plan before execution | Plan approval works               | Plan approval tests |
| Act Execution | Execute approved plan               | Act mode works                    | Act mode tests      |

#### Dependencies

- Milestone 4 (Permission System)

#### Gate Criteria

- [ ] Plan mode enhanced
- [ ] Act mode enhanced
- [ ] Plan/Act workflow works
- [ ] Build passes
- [ ] Typecheck passes
- [ ] 521+ tests pass

---

### Milestone 6: Checkpoints

**Status:** After M5  
**Priority:** MEDIUM  
**Estimated Time:** 1 week

#### Goals

- Implement filesystem checkpoint storage
- Add restore/rollback functionality

#### Tasks

| Task               | Description             | Success Criteria          | Tests             |
| ------------------ | ----------------------- | ------------------------- | ----------------- |
| Checkpoint Storage | Persistent storage      | Checkpoints saved to disk | Persistence tests |
| Restore Checkpoint | Revert to checkpoint    | Restore works             | Restore tests     |
| Rollback Changes   | Revert specific changes | Rollback works            | Rollback tests    |

#### Dependencies

- Milestone 5 (Advanced Plan/Act)

#### Gate Criteria

- [ ] Checkpoints work
- [ ] Restore works
- [ ] Rollback works
- [ ] Build passes
- [ ] Typecheck passes
- [ ] 521+ tests pass

---

### Milestone 7: Self-Healing 2.0

**Status:** After M6  
**Priority:** MEDIUM  
**Estimated Time:** 2 weeks

#### Goals

- Enhance self-healing with UI status
- Add configurable retry count

#### Tasks

| Task               | Description               | Success Criteria         | Tests                 |
| ------------------ | ------------------------- | ------------------------ | --------------------- |
| UI Status          | Healing status visible    | Status shows in WebView  | Healing status tests  |
| Configurable Retry | Configurable max attempts | Retry count configurable | Retry config tests    |
| Diagnosis          | Analyze failure           | Diagnosis works          | Diagnosis tests       |
| Propose Fix        | Generate fix              | Fix proposal works       | Fix proposal tests    |
| Apply Fix          | Execute fix               | Fix application works    | Fix application tests |
| Validate Fix       | Run validation            | Validation works         | Validation tests      |

#### Dependencies

- Milestone 6 (Checkpoints)

#### Gate Criteria

- [ ] Self-healing enhanced
- [ ] UI status works
- [ ] Retry configurable
- [ ] Build passes
- [ ] Typecheck passes
- [ ] 521+ tests pass

---

### Milestone 8: Context Engine

**Status:** After M7  
**Priority:** MEDIUM  
**Estimated Time:** 2 weeks

#### Goals

- Enhance context engine with prioritization
- Add token budgeting
- Add relevance scoring

#### Tasks

| Task              | Description              | Success Criteria                   | Tests                 |
| ----------------- | ------------------------ | ---------------------------------- | --------------------- |
| Prioritization    | Priority-based selection | High-priority items included first | Priority tests        |
| Token Budgeting   | Limit context tokens     | Context budget enforced            | Token budgeting tests |
| Deduplication     | Remove duplicate content | Deduplication works                | Deduplication tests   |
| Relevance Scoring | Rank by relevance        | Relevant items ranked higher       | Relevance tests       |

#### Dependencies

- Milestone 7 (Self-Healing 2.0)

#### Gate Criteria

- [ ] Context engine enhanced
- [ ] Prioritization works
- [ ] Token budgeting works
- [ ] Build passes
- [ ] Typecheck passes
- [ ] 521+ tests pass

---

### Milestone 9: Project Memory

**Status:** After M8  
**Priority:** MEDIUM  
**Estimated Time:** 2 weeks

#### Goals

- Implement persistent project memory
- Add project instructions
- Add task summaries

#### Tasks

| Task                    | Description             | Success Criteria          | Tests              |
| ----------------------- | ----------------------- | ------------------------- | ------------------ |
| Project Instructions    | .codepilot/rules/ files | Instructions loaded       | Rules tests        |
| Architecture Notes      | Memory storage          | Architecture notes stored | Architecture tests |
| Important Decisions     | Memory storage          | Decisions stored          | Decision tests     |
| User Preferences        | Memory storage          | Preferences stored        | Preference tests   |
| Previous Task Summaries | Memory storage          | Task summaries stored     | Task summary tests |
| Persistent Storage      | Disk persistence        | Memory persisted          | Persistence tests  |

#### Dependencies

- Milestone 8 (Context Engine)

#### Gate Criteria

- [ ] Project memory implemented
- [ ] Persistent storage works
- [ ] Build passes
- [ ] Typecheck passes
- [ ] 521+ tests pass

---

### Milestone 10: Multi-Agent System

**Status:** After M9  
**Priority:** MEDIUM  
**Estimated Time:** 3 weeks

#### Goals

- Implement dedicated agents
- Add sequential and parallel execution
- Ensure context isolation

#### Tasks

| Task                 | Description                 | Success Criteria           | Tests                   |
| -------------------- | --------------------------- | -------------------------- | ----------------------- |
| Planner Agent        | Plan generation             | Planner agent works        | Planner tests           |
| Coder Agent          | Code generation             | Coder agent works          | Coder tests             |
| Reviewer Agent       | Code review                 | Reviewer agent works       | Reviewer tests          |
| Tester Agent         | Test generation             | Tester agent works         | Tester tests            |
| Debugger Agent       | Debugging                   | Debugger agent works       | Debugger tests          |
| Security Agent       | Security review             | Security agent works       | Security tests          |
| Documentation Agent  | Doc generation              | Documentation agent works  | Documentation tests     |
| Context Isolation    | Agents don't leak context   | Context isolated           | Context isolation tests |
| Sequential Execution | One agent after another     | Sequential execution works | Sequential tests        |
| Parallel Execution   | Multiple agents in parallel | Parallel execution works   | Parallel tests          |

#### Dependencies

- Milestone 9 (Project Memory)

#### Gate Criteria

- [ ] All agents implemented
- [ ] Sequential execution works
- [ ] Parallel execution works
- [ ] Context isolation verified
- [ ] Build passes
- [ ] Typecheck passes
- [ ] 521+ tests pass

---

### Milestone 11: MCP

**Status:** After M10  
**Priority:** LOW  
**Estimated Time:** 1 week

#### Goals

- Enhance MCP with health checks
- Add resource discovery
- Add reconnect support

#### Tasks

| Task               | Description            | Success Criteria         | Tests                    |
| ------------------ | ---------------------- | ------------------------ | ------------------------ |
| Health Status      | Server health          | Health status available  | Health status tests      |
| Reconnect          | Auto reconnect         | Reconnect works          | Reconnect tests          |
| Timeout            | Request timeouts       | Timeout works            | Timeout tests            |
| Resource Discovery | Discover MCP resources | Resource discovery works | Resource discovery tests |

#### Dependencies

- Milestone 10 (Multi-Agent System)

#### Gate Criteria

- [ ] MCP enhanced
- [ ] Health status works
- [ ] Reconnect works
- [ ] Build passes
- [ ] Typecheck passes
- [ ] 521+ tests pass

---

### Milestone 12: Skills/Plugins

**Status:** After M11  
**Priority:** LOW  
**Estimated Time:** 2 weeks

#### Goals

- Implement skills system
- Add skill metadata
- Add workspace-specific skills

#### Tasks

| Task             | Description                  | Success Criteria         | Tests                   |
| ---------------- | ---------------------------- | ------------------------ | ----------------------- |
| Skills Directory | .codepilot/skills/           | Skills directory created | Skills tests            |
| Skill Metadata   | skill.json schema            | Metadata works           | Metadata tests          |
| Instructions     | Skill instructions           | Instructions loaded      | Instruction tests       |
| Allowed Tools    | Tool permissions per skill   | Tool permissions work    | Skill permissions tests |
| Workflows        | Optional skill workflows     | Workflows work           | Workflow tests          |
| Workspace Skills | .codepilot/workspace/skills/ | Workspace skills work    | Workspace skills tests  |

#### Dependencies

- Milestone 11 (MCP)

#### Gate Criteria

- [ ] Skills system implemented
- [ ] Workspace skills work
- [ ] Build passes
- [ ] Typecheck passes
- [ ] 521+ tests pass

---

### Milestone 13: Codebase Intelligence

**Status:** After M12  
**Priority:** LOW  
**Estimated Time:** 2 weeks

#### Goals

- Implement semantic search
- Add indexing
- Add symbol search

#### Tasks

| Task             | Description          | Success Criteria       | Tests                  |
| ---------------- | -------------------- | ---------------------- | ---------------------- |
| Filename Search  | search files by name | Filename search works  | Filename search tests  |
| Text Search      | search file content  | Text search works      | Text search tests      |
| Symbol Search    | search symbols       | Symbol search works    | Symbol search tests    |
| Dependency Graph | dependency analysis  | Dependency graph works | Dependency graph tests |
| Import Graph     | import analysis      | Import graph works     | Import graph tests     |
| Related Files    | find related files   | Related files works    | Related files tests    |
| Semantic Search  | vector search        | Semantic search works  | Semantic search tests  |
| Indexing         | Build index          | Indexing works         | Indexing tests         |

#### Dependencies

- Milestone 12 (Skills/Plugins)

#### Gate Criteria

- [ ] Codebase intelligence implemented
- [ ] Indexing works
- [ ] Build passes
- [ ] Typecheck passes
- [ ] 521+ tests pass

---

### Milestone 14: Git Intelligence

**Status:** After M13  
**Priority:** LOW  
**Estimated Time:** 1 week

#### Goals

- Enhance Git with branch info
- Add PR preparation

#### Tasks

| Task              | Description             | Success Criteria      | Tests                 |
| ----------------- | ----------------------- | --------------------- | --------------------- |
| Branch Info       | branches                | Branch info available | Branch tests          |
| Staged Changes    | staged diff             | Staged changes work   | Staged tests          |
| Commit Suggestion | generate commit message | Commit message works  | Commit msg tests      |
| Safe Commit       | require approval        | Commit approval works | Commit approval tests |
| PR Preparation    | PR creation             | PR preparation works  | PR prep tests         |

#### Dependencies

- Milestone 13 (Codebase Intelligence)

#### Gate Criteria

- [ ] Git intelligence enhanced
- [ ] Branch info works
- [ ] PR preparation works
- [ ] Build passes
- [ ] Typecheck passes
- [ ] 521+ tests pass

---

### Milestone 15: Task History

**Status:** After M14  
**Priority:** LOW  
**Estimated Time:** 2 weeks

#### Goals

- Implement persistent task storage
- Add resume, rename, delete, search

#### Tasks

| Task             | Description      | Success Criteria  | Tests             |
| ---------------- | ---------------- | ----------------- | ----------------- |
| Task Persistence | Save to disk     | Tasks persisted   | Persistence tests |
| Task Resume      | Resume task      | Resume works      | Resume tests      |
| Task Rename      | Rename task      | Rename works      | Rename tests      |
| Task Delete      | Delete task      | Delete works      | Delete tests      |
| Task Search      | Search history   | Search works      | Search tests      |
| Messages         | Store messages   | Messages stored   | Message tests     |
| Tool Calls       | Store tool calls | Tool calls stored | Tool call tests   |
| Changes          | Store changes    | Changes stored    | Changes tests     |

#### Dependencies

- Milestone 14 (Git Intelligence)

#### Gate Criteria

- [ ] Task history implemented
- [ ] Resume works
- [ ] Search works
- [ ] Build passes
- [ ] Typecheck passes
- [ ] 521+ tests pass

---

### Milestone 16: Observability

**Status:** After M15  
**Priority:** LOW  
**Estimated Time:** 1 week

#### Goals

- Add structured logging
- Add token/cost tracking
- Add latency tracking

#### Tasks

| Task                | Description           | Success Criteria     | Tests                |
| ------------------- | --------------------- | -------------------- | -------------------- |
| Input Tokens        | Track input tokens    | Token tracking works | Token tracking tests |
| Output Tokens       | Track output tokens   | Token tracking works | Token tracking tests |
| Latency             | Track latency         | Latency tracked      | Latency tests        |
| Tool Execution Time | Track tool timing     | Tool timing tracked  | Tool timing tests    |
| Task Duration       | Track task duration   | Duration tracked     | Duration tests       |
| Structured Logs     | Structured log format | Logs structured      | Logging tests        |
| Correlation IDs     | Trace requests        | Tracing works        | Trace tests          |

#### Dependencies

- Milestone 15 (Task History)

#### Gate Criteria

- [ ] Observability implemented
- [ ] Structured logs work
- [ ] Build passes
- [ ] Typecheck passes
- [ ] 521+ tests pass

---

### Milestone 17: UI/UX

**Status:** After M16  
**Priority:** LOW  
**Estimated Time:** 2 weeks

#### Goals

- Enhance UI with new tabs
- Add model selector
- Add streaming render improvements

#### Tasks

| Task              | Description             | Success Criteria          | Tests                     |
| ----------------- | ----------------------- | ------------------------- | ------------------------- |
| Chat Tab          | Chat interface          | Chat tab works            | Chat tests                |
| Plan Tab          | Plan display            | Plan tab works            | Plan tab tests            |
| Tools Tab         | Tools list              | Tools tab works           | Tools tab tests           |
| Changes Tab       | ChangeSet display       | Changes tab works         | Changes tab tests         |
| Problems Tab      | Diagnostics             | Problems tab works        | Problems tab tests        |
| History Tab       | Task history            | History tab works         | History tab tests         |
| Agents Tab        | Agent list              | Agents tab works          | Agents tab tests          |
| Memory Tab        | Memory display          | Memory tab works          | Memory tab tests          |
| MCP Tab           | MCP servers/tools       | MCP tab works             | MCP tab tests             |
| Settings Tab      | Settings UI             | Settings tab works        | Settings tab tests        |
| Model Selector    | Model picker            | Model selector works      | Model selector tests      |
| Plan/Act Toggle   | Mode selector           | Mode selector works       | Mode selector tests       |
| File Attachment   | File picker             | File picker works         | File picker tests         |
| Folder Attachment | Folder picker           | Folder picker works       | Folder picker tests       |
| Problems Context  | Diagnostics context     | Diagnostics context works | Diagnostics context tests |
| Selection Context | Selection context       | Selection context works   | Selection context tests   |
| Streaming Render  | Single render per token | Single render works       | Streaming render tests    |

#### Dependencies

- Milestone 16 (Observability)

#### Gate Criteria

- [ ] All tabs implemented
- [ ] Model selector works
- [ ] Streaming render works
- [ ] Build passes
- [ ] Typecheck passes
- [ ] 521+ tests pass

---

### Milestone 18: Security

**Status:** After M17  
**Priority:** LOW  
**Estimated Time:** 1 week

#### Goals

- Verify workspace sandboxing
- Verify secret redaction

#### Tasks

| Task                 | Description            | Success Criteria         | Tests                    |
| -------------------- | ---------------------- | ------------------------ | ------------------------ |
| Workspace Sandboxing | Enforce workspace root | Sandbox enforced         | Sandbox tests            |
| Command Approval     | Terminal approval      | Command approval works   | Command approval tests   |
| Network Permission   | Network tools          | Network permission works | Network permission tests |
| MCP Permission       | MCP tools              | MCP permission works     | MCP permission tests     |
| Secret Redaction     | Never expose secrets   | Secrets redacted         | Secret redaction tests   |
| Safe Logging         | No secrets in logs     | Logs safe                | Safe logging tests       |
| Path Traversal       | Block path traversal   | Traversal blocked        | Traversal tests          |
| Binary Files         | Handle binary safely   | Binary handled           | Binary tests             |
| Oversized Files      | Reject oversized       | Size limit enforced      | Size limit tests         |

#### Dependencies

- Milestone 17 (UI/UX)

#### Gate Criteria

- [ ] All security features work
- [ ] Secrets redacted
- [ ] Build passes
- [ ] Typecheck passes
- [ ] 521+ tests pass

---

### Milestone 19: Performance

**Status:** After M18  
**Priority:** LOW  
**Estimated Time:** 2 weeks

#### Goals

- Optimize streaming
- Add event backpressure
- Add caching

#### Tasks

| Task               | Description          | Success Criteria   | Tests                 |
| ------------------ | -------------------- | ------------------ | --------------------- |
| Streaming          | Real-time streaming  | Streaming fast     | Streaming tests       |
| Context Trimming   | Trim large context   | Context trimmed    | Context trim tests    |
| Token Budgeting    | Limit context tokens | Budget enforced    | Token budgeting tests |
| WebView Updates    | Batch updates        | Updates batched    | Update tests          |
| Event Backpressure | Handle event flood   | Backpressure works | Backpressure tests    |
| Repo Scanning      | Incremental scanning | Scanning fast      | Scan tests            |
| Caching            | Cache metadata       | Caching works      | Cache tests           |

#### Dependencies

- Milestone 18 (Security)

#### Gate Criteria

- [ ] All performance improvements work
- [ ] Build passes
- [ ] Typecheck passes
- [ ] 521+ tests pass

---

### Milestone 20: Full E2E Validation

**Status:** After M19  
**Priority:** LOW  
**Estimated Time:** 2 weeks

#### Goals

- Add E2E tests
- Verify all critical flows
- Verify all regression tests

#### Tasks

| Task             | Description  | Success Criteria    | Tests            |
| ---------------- | ------------ | ------------------- | ---------------- |
| E2E Tests        | WebView E2E  | E2E tests pass      | E2E tests        |
| Critical Flows   | Verify flows | All flows work      | Flow tests       |
| Regression Tests | Verify all   | All 521+ tests pass | Regression tests |

#### Dependencies

- Milestone 19 (Performance)

#### Gate Criteria

- [ ] All E2E tests pass
- [ ] All regression tests pass
- [ ] Build passes
- [ ] Typecheck passes
- [ ] 521+ tests pass

---

## Summary

| Milestone                 | Priority | Estimated Time | Dependencies |
| ------------------------- | -------- | -------------- | ------------ |
| M1 Agent Runtime 2.0      | HIGH     | 2 weeks        | None         |
| M2 Provider System        | HIGH     | 2 weeks        | M1           |
| M3 Tool Registry          | HIGH     | 3 weeks        | M2           |
| M4 Permission System      | HIGH     | 1 week         | M3           |
| M5 Advanced Plan/Act      | MEDIUM   | 2 weeks        | M4           |
| M6 Checkpoints            | MEDIUM   | 1 week         | M5           |
| M7 Self-Healing 2.0       | MEDIUM   | 2 weeks        | M6           |
| M8 Context Engine         | MEDIUM   | 2 weeks        | M7           |
| M9 Project Memory         | MEDIUM   | 2 weeks        | M8           |
| M10 Multi-Agent           | MEDIUM   | 3 weeks        | M9           |
| M11 MCP                   | LOW      | 1 week         | M10          |
| M12 Skills/Plugins        | LOW      | 2 weeks        | M11          |
| M13 Codebase Intelligence | LOW      | 2 weeks        | M12          |
| M14 Git Intelligence      | LOW      | 1 week         | M13          |
| M15 Task History          | LOW      | 2 weeks        | M14          |
| M16 Observability         | LOW      | 1 week         | M15          |
| M17 UI/UX                 | LOW      | 2 weeks        | M16          |
| M18 Security              | LOW      | 1 week         | M17          |
| M19 Performance           | LOW      | 2 weeks        | M18          |
| M20 Full E2E              | LOW      | 2 weeks        | M19          |

**Total Estimated Time:** ~30 weeks (6-7 months)

---

## Next Steps

1. ~~Start M1: Agent Runtime 2.0~~ ✅ Complete
2. ~~Implement state machine~~ ✅ Complete
3. ~~Add typed events~~ ✅ Complete
4. ~~Add regression tests~~ ✅ Complete
5. ~~Run build/typecheck/tests~~ ✅ Complete
6. ~~Continue to M2 (Provider System)~~ ✅ Complete
7. **Next: Start M3 — Tool Registry**

---

**Roadmap created by:** Kiro AI Engineering Assistant  
**Next action:** Implement Milestone 1 (Agent Runtime 2.0)
