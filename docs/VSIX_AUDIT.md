# CodePilot AI — VSIX Audit

**Audit date:** 2026-09-28
**Tool:** `@vscode/vsce@3.9.2` (devDependency; `package --no-dependencies`)
**Output:** `codepilot-audit-20260928.vsix`

---

## Package record

| Field | Value |
|---|---|
| VSIX filename | `codepilot-audit-20260928.vsix` |
| VSIX size | 3,817,311 bytes (3.64 MB) |
| Unpacked size | 16,574,322 bytes (15.8 MB) |
| File count | 124 |
| SHA-256 | `73038F8873305569FB39D5CDBDB925FDC892BA13CA27DC631A8B85482C17B403` |

## Forbidden-content scan

| Forbidden | Found |
|---|---|
| tests (`.test.`/`tests/`) | **0** |
| coverage | **0** |
| sandbox | **0** |
| `.env` / `.local` | **0** |
| credentials / API keys | **0** |
| debug logs / temp files | **0** |
| test fixtures | **0** |
| source maps (`.map`) | **0** |
| `__mocks__` | **0** |
| `.clinerules` | **0** |
| `@cline/*` packages | **0** |
| Cline runtime | **0** |

**Result: CLEAN.** The VSIX contains only production extension code, the WebView bundle, the MCP SDK, and platform assets.

## Production dependency summary (bundled)

| Dependency | Version | License | Role |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | 1.30.1 | MIT | MCP transports |
| `react` / `react-dom` | 19.2.8 | MIT | WebView UI |
| `playwright-core` | 1.63.0 | Apache-2.0 | Browser automation |
| `simple-git` | 3.36.0 | MIT | Git tools |
| `pg` | 8.23.0 | MIT | RAG vector store |

All `@codepilot/*` packages are `workspace:*` (first-party). No native modules; no `@cline/*`; no test/coverage/debug artifacts.

## Notes

- The extension manifest declares `engines.vscode: "^1.100.0"`.
- The extension entry is `dist/extension.js` (esbuild bundle).
- A transitive `npm list` warning referenced a phantom `@cline/sdk` path under `apps/vscode-extension/node_modules/@cline/`; direct inspection confirmed **no such directory exists** and the VSIX contains **zero** Cline entries. No action needed; recorded for transparency.
- Not published, not installed. For acquisition review only.
