# CodePilot AI — Handover Plan

## 1. Repository

Single git repo, pnpm workspaces, 11 packages. Branch: feature work uncommitted (as required by the audit constraints).

## 2. Build

```bash
pnpm install
pnpm -r typecheck
pnpm -r build
```

## 3. Development environment

Node.js 24, pnpm 11, VS Code 1.100+, TypeScript 5.7. Optional: local Ollama for live tests; system Chrome/Edge for browser E2E.

## 4. Providers

Configure via Settings (model, API key, base URL). Keys stored in VS Code SecretStorage. Ollama needs no key (local).

## 5. Secrets

No real credentials in the repository. Buyer must supply their own API keys. SecretStorage is the canonical secret sink.

## 6. VSIX

```bash
cd apps/vscode-extension && pnpm exec vsce package --no-dependencies --out <name>.vsix
```

Set publisher/license/repo in `package.json` before publication (currently USER INPUT REQUIRED).

## 7. Tests

```bash
pnpm test                 # deterministic (2547)
pnpm test:live            # live Ollama suites (serial)
```

## 8. Deployment

VS Code extension — install the VSIX or publish to a marketplace (requires publisher identity).

## 9. Browser subsystem

Playwright-core uses the system Chrome/Edge channel (auto-discovered). No browser download bundled.

## 10. MCP

Configure servers in Settings (stdio/SSE/streamable-HTTP). Connect deadlines and approval parity enforced.

## 11. Documentation

`docs/` (architecture, security, parity, provider, dependency, VSIX, Cline audits) and `docs/acquisition/` (20-file data room).
