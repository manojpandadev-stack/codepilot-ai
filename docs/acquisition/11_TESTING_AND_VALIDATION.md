# CodePilot AI — Testing & Validation

## Deterministic suite

- **2547/2547 tests pass, 161 files**
- `npx vitest run --maxWorkers=4` (canonical: `pnpm test`)
- 19/19 packages typecheck PASS
- `pnpm -r build` PASS

## Live suite ( Ollama )

Run via `pnpm test:live` (serial, shared local model server):
- File deletion approve/reject (real ChangeSet + M4)
- Plan-mode restrictions (zero exec/write/delete)
- Browser autonomous debug loop (qwen3:8b — MODEL LIMITATION: transport hung)
- Terminal streaming, skills, continuity, security fixes

## Security suites

SSRF 44/44, M4 approval automation, mode-escape regression, secret redaction, workspace boundary, path traversal, symlink escape, terminal restrictions, approval replay, persistence corruption, MCP security, browser security, WebView message validation.

## Browser E2E

17/17 real-Chromium tests (system Chrome/Edge via Playwright).

## MCP

72/72 tests including the deterministic hung-server regression.

## Coverage areas

Agent runtime, context assembly, repository understanding, file ops, ChangeSets, M4 approvals, terminal execution, browser automation, MCP, git tools, persistence, WebView messages, outputRef, command repair, WSL/SSH transports.
