# CodePilot AI — Asset Inventory

## Owned / developed

| Asset | Type | Notes |
|---|---|---|
| Source code (11 packages) | Owned | TypeScript ESM, pnpm workspaces |
| VS Code extension | Owned | `apps/vscode-extension` |
| WebView | Owned | React 19, `apps/webview` |
| Agent runtime | Owned | `packages/agent-runtime` |
| Tool engine + M4 security | Owned | `packages/tool-engine` |
| Model gateway | Owned | `packages/model-gateway` |
| Browser engine | Owned | `packages/browser-engine` |
| MCP manager | Owned | `packages/mcp-manager` |
| Context/changeset/git/policy engines | Owned | `packages/*` |
| Persistence layer | Owned | tasks, checkpoints, approval timeline |
| Test suite | Owned | 2547 tests, 161 files |
| Documentation | Owned | `docs/`, `docs/acquisition/` |
| Build/release config | Owned | package.json, tsconfig, vitest configs |
| VSIX artifact | Owned | `codepilot-audit-20260928.vsix` (review only) |

## Third-party licensed

| Component | License | Obligation |
|---|---|---|
| `@modelcontextprotocol/sdk` | MIT | Notice |
| `react` / `react-dom` | MIT | Notice |
| `playwright-core` | Apache-2.0 | **Notice + attribution** |
| `simple-git` | MIT | Notice |
| `pg` | MIT | Notice |

## Platform API

- `vscode` Extension API (Microsoft) — terms apply.

## Open source

- No copyleft components.

## Requires legal review

- None identified. Extension manifest publisher/license/repo fields require user input.

## Unknown

- Brand/domain/trademark ownership not established in this audit (not invented).
