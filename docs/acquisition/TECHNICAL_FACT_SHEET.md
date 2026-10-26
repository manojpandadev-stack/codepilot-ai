# CodePilot AI — Technical Fact Sheet

**All facts below are verified from the repository state. Nothing here is inferred or aspirational.**

| Field | Value |
|---|---|
| Project | CodePilot AI |
| Type | Controlled autonomous AI coding agent (VS Code extension + WebView + CLI) |
| Freeze commit | `1814f94` — `chore: freeze CodePilot AI for acquisition` (local only; not pushed, not tagged, not published) |

## Validation (all PASS)

| Check | Result |
|---|---|
| Deterministic tests | **2547/2547 pass, 161 test files** |
| Typecheck | **19/19 workspace projects PASS** (`pnpm -r typecheck`) |
| Build | **PASS** (`pnpm -r build`) |
| MCP suite | **PASS (72/72)** incl. hung-server connect-deadline regression |
| SSRF/security suites | **PASS** (SSRF 44/44; M4 deny-closed; redaction; boundaries) |
| Browser Chromium E2E | **PASS (17/17, real Chromium)** |
| Release-hygiene audit | **PASS (13/13 phases)** |

## Final VSIX

| Field | Value |
|---|---|
| Filename | `codepilot-freeze-20260928.vsix` |
| Size | 3,817,993 bytes (3.64 MB) |
| Files | 124 |
| SHA-256 | `53752541CA26892FA05A54F4626F4FED3418BD02B0E48EE60E899A2DD76DF73E` |
| Forbidden entries | 0 (no tests/coverage/sandbox/.env/credentials/source-maps/@cline) |
| Status | Built for review only — not published, not installed |

Reproducibility note: a rebuild produces a different SHA-256 because ZIP timestamp metadata differs; entry-level content (file names, sizes, CRC32s) is identical.

## Cline

- Zero production Cline runtime in the tree.
- Zero `@cline/*` runtime dependencies in any `package.json` or the lockfile.
- Zero copied Cline production source.
- Only references: documentation, a non-production benchmark script (`scripts/benchmark/cline-compare.ts`, imports undeclared `@cline/*`), the `.cline/` directory-name convention (gitignored), and historical header comments. See `docs/CLINE_INDEPENDENCE_AUDIT.md`.

## Dependencies

- 6 direct external dependencies, documented with licenses: `@modelcontextprotocol/sdk` (MIT), `react`/`react-dom` (MIT), `playwright-core` (Apache-2.0 — attribution required), `simple-git` (MIT), `pg` (MIT).
- Transitive licenses: MIT/ISC/BSD-2-Clause. No copyleft.
- **This project does use third-party software** (npm dependencies + bundled React inside the built `apps/vscode-extension/dist/webview.js` + Playwright). It does not claim zero third-party software. See `docs/DEPENDENCY_LICENSE_AUDIT.md` and `THIRD_PARTY_NOTICES.md`.

## Workspace shape (verified via `pnpm ls -r`)

- 19 workspace projects: 15 `@codepilot/*` packages + 3 apps (`vscode-extension`, `webview`, `cli`) + root.
- Optional Java backend: `services/control-plane` (Spring Boot, Maven, not a pnpm project) + `docker-compose.yml` + `infrastructure/postgres/init.sql`.

## Known limitations (explicit)

- **Azure** — NOT IMPLEMENTED (no adapter).
- **AWS Bedrock generation** — NOT IMPLEMENTED (discovery-only; no generation path).
- **Cloud providers (OpenAI/Anthropic/Google/OpenRouter/DeepSeek/Mistral)** — implemented, NOT LIVE VERIFIED (no credentials available in this environment).
- **qwen3:8b autonomous browser debug loop** — MODEL LIMITATION (transport hung after 30 events); the model also did not trigger a protected `write_file` in the live approval test. A model limitation is not a software defect.
- **Native tool calling** — claimed only where actually verified; the live demonstration against qwen3:8b was NOT completed. The runtime uses native structured tool calling and does not interpret prose JSON as a tool call.
- **Extension manifest identity** — `homepage`, `bugs`, `author` absent; marketplace publisher account requires user input (not invented).
- **No commercial validation** — no customers, revenue, retention, or production-deployment evidence exists. Asking price is a seller target, not a verified valuation.
