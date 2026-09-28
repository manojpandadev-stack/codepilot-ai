# CodePilot AI — IP Checklist

## Owned / developed

- All `@codepilot/*` packages (11 first-party packages).
- VS Code extension (`apps/vscode-extension`).
- WebView (`apps/webview`).
- Agent runtime, tool engine, model gateway, browser engine, MCP manager, context engine, changeset engine, git engine, policy engine.
- Security system (M4, SSRF, redaction, approval).
- Persistence layer.
- Test suite (2547 tests).
- Documentation.

## Third-party licensed

- `@modelcontextprotocol/sdk` (MIT) — MCP.
- `react` / `react-dom` (MIT) — WebView.
- `playwright-core` (Apache-2.0) — browser. **Attribution required.**
- `simple-git` (MIT) — git.
- `pg` (MIT) — RAG.

## Platform API

- `vscode` Extension API (Microsoft VS Code). Not an npm dependency; obligations under the VS Code Extension API terms.

## Open source

- No open-source copyleft components. All third-party deps are permissively licensed.

## Requires legal review

- None identified at this time. Re-run dependency audit on any change.
- Extension manifest publisher/license/repo fields require user input before publication.

## Cline

- 0 Cline runtime/source/dependency. Fully independent.

## Note

This checklist describes technology ownership assumptions. It is not a legal opinion. Buyer counsel should verify all IP representations.
