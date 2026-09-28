# CodePilot AI — Product Overview

## Target users

Software developers and engineering teams who want an AI coding agent inside VS Code that can autonomously read, write, test, and debug code — with human-in-the-loop approval for risky operations.

## Primary workflow

1. User describes a task in the WebView chat.
2. The agent plans (optional plan mode), then executes: reads files, edits code, runs terminal commands, automates a browser, calls MCP tools.
3. Every tool call passes the **M4 gate** (policy → risk → approval). Risky operations surface an approval card; the user approves/denies.
4. Writes are staged as **ChangeSets** and applied only on approval.
5. Results, diffs, and approval history stream back to the WebView and persist across restarts.

## Major features

- **Autonomous agent loop** — multi-step tool continuation with iteration cap.
- **File operations** — read/write/edit/delete via ChangeSet staging.
- **Terminal execution** — streaming shell, interactive stdin, command repair loop.
- **Browser automation** — 15 Playwright tools with SSRF enforcement.
- **MCP** — external tools/resources with connect deadlines and approval parity.
- **Task planning** — structured plans with step tracking.
- **Checkpoints/restore** — durable, conflict-detecting file snapshots.
- **Usage/cost tracking** — per-token/cost ledger with honest "unavailable" reporting.
- **@diff / @terminal / @file** composer context chips.
- **outputRef** — large tool output persisted and retrievable.
- **Git tools** — status/diff/log/show as model-callable builtins.
- **inspect_symbols** — structural code outline.
- **Pause/resume** — task interruption and continuation.

## Model gateway

A provider abstraction (`ModelProvider`) with a factory and 11 catalogue provider ids: olmama, openai-native, openai, openai-compatible, custom, anthropic, gemini, google, openrouter, zai/zhipuai, lmstudio. OpenAI-compatible providers share one adapter.

## Security

M4 deny-closed gate on every dispatch; scoped approval grants with operation fingerprints; mode filtering (plan/ask); workspace boundaries; terminal restrictions; SSRF; secret redaction; persistence corruption quarantine.

## Local AI

Ollama is a first-class native adapter. Privacy mode "local" blocks remote providers (fail-closed).
