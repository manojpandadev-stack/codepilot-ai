# CodePilot AI — Final Acquisition Readiness Report

**Date:** 2026-09-28
**Target transaction:** One-time technology/IP acquisition
**Target asking price:** $2,000,000 (seller target — not an independently verified valuation)

---

## A. Current technical status

| Metric | Result |
|---|---|
| Tests | **2547/2547 pass, 161 files** |
| Typecheck | **19/19 packages PASS** |
| Build | **`pnpm -r build` PASS** |
| SSRF | **44/44 PASS** |
| M4 | **PASS** |
| Browser E2E | **17/17 PASS** |
| MCP | **72/72 PASS** (incl. hung-server regression) |

## B. Verified capabilities

- Autonomous agent loop with multi-step tool continuation.
- File operations via ChangeSet staging; M4-gated.
- Terminal execution: streaming shell, interactive stdin, command repair loop.
- Browser automation: 15 Playwright tools, SSRF enforcement, console/network capture, screenshot→image pipeline.
- MCP: stdio/SSE/streamable-HTTP with connect deadlines, approval parity, redaction.
- Persistence: tasks, checkpoints (durable), approval timeline, audit log — all atomic, corruption-quarantined.
- Multi-provider model gateway (11 catalogue ids).
- Local-first AI (Ollama native; privacy mode blocks remote).
- Security: M4 deny-closed gate, scoped grants, fingerprints, mode filtering, workspace boundaries, secret redaction.
- Cline independence: 0 deps, 0 runtime, 0 copied source.

## C. Remaining limitations

- **Bedrock** — discovery-only (no generation). **Azure** — not implemented.
- **Cloud providers** — implemented, not live-verified (no credentials).
- **qwen3:8b** — browser autonomous debug loop model limitation (transport hung).
- **Extension manifest** publisher/license/repo require user input before publication.
- **Acquisition data room** is documentation-only; no credentials/secrets.

## D. Security

M4 deny-closed gate on every dispatch; scoped approval grants with operation fingerprints (1h TTL); mode filtering (plan/ask); workspace boundaries; terminal restrictions; SSRF (44/44); MCP security (connect/execution deadlines, SSRF, redaction); secret redaction via canonical scrubber; persistence corruption quarantine. No security rule was relaxed during this work.

## E. Dependency/license status

6 direct dependencies: `@modelcontextprotocol/sdk` (MIT), `react`/`react-dom` (MIT), `playwright-core` (Apache-2.0 — attribution required), `simple-git` (MIT), `pg` (MIT). All transitive deps MIT/ISC/BSD-2-Clause. No copyleft/source-available licenses. See `12_DEPENDENCY_LICENSES.md`.

## F. Cline independence

0 production `@cline/*` deps, 0 Cline runtime, 0 ClineCore, 0 copied source. Only legitimate references: `.clinerules/` directory convention, documentation, one non-production benchmark script. See `13_CLINE_INDEPENDENCE.md`.

## G. VSIX

| Field | Value |
|---|---|
| Filename | `codepilot-final-20260928.vsix` |
| Size | 3,817,993 bytes (3.64 MB) |
| Files | 124 |
| SHA-256 | `3FF7FE9FB7B702B6CFA89A82AEB6934BA936EB1B897157D2DA5EEB77ADCEBFA0` |
| Forbidden entries | 0 (no tests/coverage/sandbox/.env/credentials/source-maps/@cline) |

Built for review only. Not published.

## H. IP/asset inventory

All `@codepilot/*` packages first-party. Third-party components permissively licensed (Playwright Apache attribution). VS Code Extension API (platform). No Cline IP. Brand/domain/trademark ownership not established in this audit. See `16_IP_CHECKLIST.md` and `17_ASSET_INVENTORY.md`.

## I. Buyer handover

Repository (git, pnpm workspaces), build (`pnpm -r build`), dev environment (Node 24/pnpm 11/VS Code 1.100+), providers (Settings + SecretStorage), tests (`pnpm test` + `pnpm test:live`), VSIX packaging, documentation (`docs/` + `docs/acquisition/`). See `18_HANDOVER_PLAN.md`.

## J. Target transaction

One-time technology/IP acquisition. Target asking price: **$2,000,000**. This is a seller target, not a verified valuation.

## K. Items requiring lawyer review

- Extension manifest publisher/license/repo identity (user input).
- Apache-2.0 attribution for Playwright in product documentation.
- Brand/domain/trademark ownership (not established).
- VS Code Extension API terms (platform).

## L. Items requiring buyer due diligence

- Cloud provider live verification (requires credentials).
- Azure implementation (not present).
- Bedrock generation (not present).
- qwen3:8b autonomous browser loop (model limitation).
- Repository-engine dead code; cline-compare benchmark script (non-production).
- E2E scripts outside the vitest include.

---

**Git status:** `git status --short` and `git diff --stat` executed. No add/commit/push/tag/reset/clean performed. Repository uncommitted and unpublished.
