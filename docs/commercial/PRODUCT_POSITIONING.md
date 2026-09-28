# CodePilot AI — Product Positioning

**Product:** CodePilot AI
**Category:** Controlled autonomous AI coding agent for VS Code.

## Core capabilities

- **Plan mode** — structured task plans with step tracking; no execution.
- **Act mode** — autonomous multi-step execution with tool continuation.
- **Streaming** — live token, terminal, and tool-event streaming.
- **Read tools** — file read, search, inspect_symbols, git tools.
- **Edit tools** — write/edit/delete via ChangeSet staging.
- **Terminal** — streaming shell, interactive stdin, command repair.
- **Approval workflow** — M4 deny-closed gate; explicit approve/deny for risky operations.
- **MCP** — external tools/resources with connect deadlines and approval parity.
- **Model selection** — 11 catalogue provider ids via a model gateway.
- **Diff/change review** — staged ChangeSets with diff viewer.
- **Security boundaries** — workspace containment, SSRF, redaction, mode filtering.
- **Auditability** — approval timeline, tool audit log, usage/cost tracking.

## Differentiation

- **Controlled autonomy** — the agent acts, but every risky operation passes an explicit approval gate.
- **Explicit approvals** — deny-closed; scoped grants with operation fingerprints.
- **Tool boundaries** — filesystem, terminal, browser, and MCP each have enforced limits.
- **MCP controls** — connect deadlines, execution timeouts, SSRF, redaction.
- **Security-first execution** — M4 on every dispatch; workspace containment; secret redaction.
- **Developer control** — plan/act modes, pause/resume, checkpoint/restore, full audit trail.

## Non-claims

- No superiority claims over Cursor, GitHub Copilot, Claude Code, Codex, or other competitors.
- No invented customer numbers, revenue, benchmarks, or adoption.
- No claim of "100% Cline parity" or "all providers supported".
