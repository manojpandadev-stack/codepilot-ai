# CodePilot AI — Security Model

## Overview

CodePilot AI is designed as a **local-first, privacy-conscious** AI coding assistant. This document describes the security architecture, tool governance, and privacy guarantees.

## Privacy Modes

| Mode           | Description                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------- |
| **LOCAL ONLY** | All model inference happens locally. No source code leaves the machine. No cloud API calls. |
| **HYBRID**     | Remote providers are permitted where configured; turns that stay on local providers keep local-only guarantees. |
| **CLOUD**      | Selected cloud provider handles inference. Source code is sent to the provider's API.       |

The current privacy mode is displayed prominently in the UI. **CodePilot AI never silently sends source code to external services** — remote use under LOCAL ONLY is refused loudly, not downgraded quietly.

> CodePilot's guarantees end where your data leaves for a provider: once
> source code reaches a cloud provider's API, that provider's own data
> policy governs it. Choose LOCAL ONLY when nothing may leave the machine.

## Tool Governance

Every tool request goes through the **PolicyEngine** before execution:

```
Agent → Tool Request → PolicyEngine → Permission Decision → Execution
```

### Default Tool Permissions

| Tool             | Permission | Category |
| ---------------- | ---------- | -------- |
| `read_files`     | AUTO       | read     |
| `search`         | AUTO       | read     |
| `git_diff`       | AUTO       | read     |
| `git_status`     | AUTO       | read     |
| `list_directory` | AUTO       | read     |
| `write_file`     | APPROVAL   | write    |
| `apply_patch`    | APPROVAL   | write    |
| `bash`           | APPROVAL   | execute  |
| `web_fetch`      | APPROVAL   | network  |
| `web_search`     | APPROVAL   | network  |

### Blocked Commands

The following commands are always blocked, regardless of policy:

- `rm -rf /` and `rm -rf /*`
- `mkfs` (filesystem formatting)
- `dd` (disk writing)
- `> /dev/sda` (disk overwrite)
- `format` (Windows disk formatting)
- Fork bombs (`:(){:|:&};:`)
- `sudo` (require explicit admin elevation)
- `curl | bash` and `wget | sh` (pipe-to-shell)
- `nc -l` (netcat listeners)

### Command Validation

The `CommandValidator` class applies regex-based security checks before any shell command execution. Additional patterns can be added per-project.

### Tool Approval Flow

1. Agent requests tool execution
2. PolicyEngine checks tool category and permission
3. For `auto` tools: execution proceeds immediately
4. For `approval` tools: UI shows approval dialog to user
5. For `blocked` tools: execution is refused with audit log entry
6. All decisions are logged in the audit trail

## Secret Protection

### Storage

- **VS Code SecretStorage** is used for API keys in the extension
- API keys are **never** stored in:
  - Source code
  - Configuration files (committed to git)
  - PostgreSQL database
  - React WebView
  - Log files
  - Environment variables in production

### Redaction

A single canonical scrubber in `@codepilot/shared` (`scrubSecretsText`, exposed
as `redactSecrets` by the audit logger) detects and redacts:

- `API_KEY=...`
- `SECRET=...`
- `PASSWORD=...`
- `TOKEN=...`
- `BEARER ...`
- `sk-...` (OpenAI-style keys)

Every audit path — the in-memory ring and the persistent JSONL sink — funnels
through it, so no second redaction implementation can drift.

### Memory Safety

Credentials are never persisted: task history, audit entries, and provider
usage records store redacted metadata only. Provider API keys live exclusively
in VS Code SecretStorage.

## WebView Security

- **Content Security Policy (CSP)**: Strict CSP prevents unauthorized script execution
- **Message Validation**: All messages between WebView and extension host are validated
- **No Direct Node Access**: WebView cannot access Node.js APIs directly
- **No API Keys in WebView**: Secrets never enter the WebView context

## Workspace Isolation

- File operations are restricted to the workspace root
- Path traversal attacks (`../../etc/passwd`) are blocked
- MCP tool permissions enforce workspace boundaries
- Agent cannot modify files outside the workspace

## MCP Security

- Each MCP server connection requires explicit user configuration
- Tool permissions are enforced per MCP tool
- MCP servers run in isolated contexts
- All MCP operations go through PolicyEngine

## Audit Logging

All tool executions, permission decisions, and policy changes are logged:

```typescript
interface AuditEntry {
  timestamp: number;
  toolName: string;
  action: string;
  detail?: string;
}
```

Audit logs are stored locally and never sent externally.

## Offline Mode

When operating in LOCAL ONLY mode with Ollama, CodePilot itself makes no
external network requests:

- No internet connection required by CodePilot
- No telemetry is sent (telemetry is opt-in and defaults off)
- Chat, editing, git, terminal, and test tooling work offline
- Local MCP servers continue to function

## Dependency Security

- Dependencies are installed from lockfile-pinned versions; CI runs the
  test suite on changes
- No hardcoded secrets in the CodePilot codebase (enforced by redaction
  tests and secret sweeps)
- Docker infrastructure uses minimal base images

## Reporting Security Issues

If you discover a security vulnerability, please report it responsibly by opening a private issue or contacting the maintainers directly.
