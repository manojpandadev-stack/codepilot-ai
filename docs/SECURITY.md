# CodePilot AI — Security Model

## Overview

CodePilot AI is designed as a **local-first, privacy-conscious** AI coding assistant. This document describes the security architecture, tool governance, and privacy guarantees.

## Privacy Modes

| Mode | Description |
|------|-------------|
| **LOCAL ONLY** | All model inference happens locally. No source code leaves the machine. No cloud API calls. |
| **HYBRID** | User explicitly selects which operations may use cloud providers. All others stay local. |
| **CLOUD** | Selected cloud provider handles inference. Source code is sent to the provider's API. |

The current privacy mode is displayed prominently in the UI. **CodePilot AI never silently sends source code to external services.**

## Tool Governance

Every tool request goes through the **PolicyEngine** before execution:

```
Agent → Tool Request → PolicyEngine → Permission Decision → Execution
```

### Default Tool Permissions

| Tool | Permission | Category |
|------|-----------|----------|
| `read_files` | AUTO | read |
| `search` | AUTO | read |
| `git_diff` | AUTO | read |
| `git_status` | AUTO | read |
| `list_directory` | AUTO | read |
| `write_file` | APPROVAL | write |
| `apply_patch` | APPROVAL | write |
| `bash` | APPROVAL | execute |
| `web_fetch` | APPROVAL | network |
| `web_search` | APPROVAL | network |

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

The `MemoryEngine.sanitizeValue()` method detects and redacts:

- `API_KEY=...`
- `SECRET=...`
- `PASSWORD=...`
- `TOKEN=...`
- `BEARER ...`
- `sk-...` (OpenAI-style keys)

### Memory Safety

The memory system never stores credentials. All memory values are sanitized before persistence.

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

When operating in LOCAL ONLY mode with Ollama:

- No internet connection required
- No telemetry is sent
- No external network requests are made
- All features (chat, editing, Git, tests, RAG) work offline
- Local MCP servers continue to function

## Dependency Security

- Dependencies are audited via CI/CD
- No hardcoded secrets in any dependency
- Docker images use minimal base images
- Flyway migrations are versioned and immutable

## Reporting Security Issues

If you discover a security vulnerability, please report it responsibly by opening a private issue or contacting the maintainers directly.
