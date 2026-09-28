# CodePilot AI — Dependency & License Audit

**Audit date:** 2026-09-28
**Scope:** all workspace `package.json` files, `pnpm-lock.yaml`, resolved `node_modules/.pnpm` versions, and production VSIX bundling.
**Method:** direct dependencies read from each package manifest; exact resolved versions and licenses read from the pnpm store `package.json` files. No dependency was removed or modified during this audit.

---

## 1. Direct dependencies (production runtime)

| Package | Version | License | Used by | Bundled in VSIX | Classification |
|---|---|---|---|---|---|
| `@modelcontextprotocol/sdk` | 1.30.1 | MIT | `codepilot-ai` (extension), `@codepilot/mcp-manager` | Yes (MCP transports) | KEEP |
| `react` | 19.2.8 | MIT | `@codepilot/webview` | Yes (WebView UI) | KEEP |
| `react-dom` | 19.2.8 | MIT | `@codepilot/webview` | Yes (WebView UI) | KEEP |
| `playwright-core` | 1.63.0 | Apache-2.0 | `@codepilot/browser-engine` | Yes (browser automation) | KEEP — notice/attribution required (Apache-2.0 §4) |
| `simple-git` | 3.36.0 | MIT | `@codepilot/git-engine` | Yes (git tools) | KEEP |
| `pg` | 8.23.0 | MIT | `@codepilot/rag-engine` | Yes (RAG vector store) | KEEP |

All `@codepilot/*` entries are `workspace:*` (first-party, no external license).

## 2. Transitive dependencies (resolved)

### 2.1 MCP SDK transitive tree (`@modelcontextprotocol/sdk@1.30.1`)

| Package | Version | License |
|---|---|---|
| `@hono/node-server` | 1.19.9 / 2.0.5 | MIT |
| `ajv` | 8.20.0 | MIT |
| `ajv-formats` | 3.0.1 | MIT |
| `content-type` | 1.0.5 | MIT |
| `cors` | 2.8.6 | MIT |
| `cross-spawn` | 7.0.6 | MIT |
| `eventsource` | 3.0.7 | MIT |
| `eventsource-parser` | 3.1.1 | MIT |
| `express` | 5.2.1 | MIT |
| `express-rate-limit` | 8.7.0 | MIT |
| `hono` | 4.13.8 | MIT |
| `jose` | 6.2.12 | MIT |
| `json-schema-typed` | 8.0.2 | BSD-2-Clause |
| `pkce-challenge` | 5.0.1 | MIT |
| `raw-body` | 3.0.2 | MIT |
| `zod` | 4.4.3 | MIT |
| `zod-to-json-schema` | 3.25.2 | ISC |

### 2.2 Other transitive trees

`react`, `react-dom`, `simple-git`, `pg`, and `playwright-core` pull only small MIT/ISC/BSD-2-Clause utility trees (scheduler, tar, pg-protocol, pg-types, etc.). No copyleft or source-available licenses were found in any resolved tree.

## 3. License obligation summary

| License | Obligation | Action |
|---|---|---|
| MIT | Retain copyright + license notice in distributions | Notices included in VSIX via bundled `NOTICE`/license headers where applicable |
| Apache-2.0 (playwright-core) | Retain NOTICE + license; state changes | **Attribution required** — include Playwright copyright/NOTICE in product documentation |
| ISC (zod-to-json-schema) | Retain copyright + license notice | Same as MIT |
| BSD-2-Clause (json-schema-typed) | Retain copyright + license notice | Same as MIT |

**No GPL / AGPL / LGPL / SSPL / BUSL / Commons Clause / source-available / non-commercial licenses were found anywhere in the resolved dependency set.**

## 4. Prohibited-license scan result

| License family | Found |
|---|---|
| GPL / AGPL / LGPL | **No** |
| SSPL | **No** |
| BUSL | **No** |
| Commons Clause | **No** |
| Source-available / non-commercial | **No** |
| Unknown license | **No** (every resolved package reported a license) |

## 5. Classification

- **KEEP** — all 6 direct dependencies (MIT/Apache-2.0, attribution handled).
- **PLATFORM API** — `vscode` (VS Code extension API; not an npm dependency).
- **LEGAL REVIEW** — none required at this time; re-run if any dependency is added or upgraded.
- **REPLACE** — none.
- **UNKNOWN** — none.

## 6. Notes for acquisition

- The dependency surface is small and permissively licensed; the only attribution obligation beyond MIT is **Apache-2.0 (playwright-core)**.
- All first-party packages are `workspace:*` and owned.
- This audit is a point-in-time snapshot; re-run on any dependency change.
