# Changelog

All notable changes to CodePilot AI are documented here.

## [0.1.0] — Initial integrated release

### Runtime (M1–M5, baseline)
- Agent runtime with state machine, cancellation, timeout, retry, event correlation
- Provider & model system (Ollama local-first, OpenAI-compatible, Anthropic, Google) with SecretStorage-backed API keys
- Tool registry with permission policies
- Permission & approval pipeline (RiskEngine → PolicyEngine → ApprovalManager → SecurityValidator → AuditLogger)
- File mutation: atomic writes, optimistic concurrency, ChangeSets, diffs, checkpoints

### Advanced capabilities (M6–M21)
- **M6 Context Engine** — workspace indexing, symbol extraction, hybrid retrieval, token budgeting, sensitive-file filtering; integrated into the live prompt path via `AgentContextService`
- **M7 Terminal & Process Engine** — controlled spawn primitives and tracked `TerminalSession`s (streaming, kill, timeout); host-side `TerminalSessionManager` gated by M4
- **M8 MCP Platform** — stdio, streamable-HTTP, and SSE transports; tool/resource/prompt discovery; per-tool permissions and approvals; unsupported configs rejected explicitly
- **M9 Rules & Skills** — scoped rules (user/workspace/project/task), precedence, sanitization, untrusted-content handling; integrated into prompt assembly
- **M10 Self-Healing 2.0** — failure classification, bounded repair attempts, loop prevention, rollback
- **M11 VS Code UX** — chat with streaming, Plan/Act modes, diff viewer with accept/reject/rollback, MCP approval UI, checkpoint list/restore, history & resume
- **M12 Task Persistence & Resume** — durable `TaskStore` (atomic writes, corruption quarantine, secret redaction); sessions restore from real persisted state; crash recovery marks interrupted tasks
- **M13 Web Agent** — fetch-based with SSRF/domain policy, secret redaction, prompt-injection detection and untrusted-content isolation
- **M14 Multi-Agent Orchestration** — TaskDAG with dependency-aware execution, role agents, file-lock conflict prevention; `/agents` slash command entry point; every role agent's tool calls pass the M4 pipeline via the `beforeTool` hook
- **M15 Plugin Platform** — capability-based permissions, trust tiers, manifest validation, on-disk discovery (`PluginManager.discover`); community plugins never get terminal capability and require explicit enablement
- **M16 CLI** — `apps/cli` executable (`codepilot`) reusing the same runtime: run, task, resume, models, providers, sessions, config, version, help; JSON output and CI-friendly exit codes
- **M17 Scheduling & Automation** — durable `TaskScheduler` (once/recurring/daily with timezones, missed-run policies, bounded concurrency); scheduled prompts execute through the live runtime
- **M18 Observability** — dependency-free metrics/spans/structured logging with secret redaction and bounded cardinality; real runtime events (tool calls, permission decisions, checkpoint restores, token usage) are recorded
- **M19 Security** — deny-closed M4 evaluation for every tool path, checkpoint restore gated by M4, symlink/traversal guards on file mutation, no plaintext secrets in persistence or logs
- **M20 Release** — Apache-2.0 LICENSE, this changelog, VSIX packaging, CLI bin packaging
- **M21 Benchmarking** — evaluation framework with reproducible tasks (see `packages/eval-framework`); live-model results are environment-dependent and never invented

### Known limitations
- Web agent is fetch-based; full browser automation (JS rendering, screenshots, forms) is not implemented
- HTTP/SSE MCP transports require reachable endpoints and are not covered by live CI tests
- Evaluation framework results require model credentials; no numbers are asserted without execution
