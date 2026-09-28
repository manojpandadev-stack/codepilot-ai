# CodePilot AI — Executive Summary

**Product:** CodePilot AI
**Category:** Autonomous AI coding agent / developer productivity platform
**Target transaction:** One-time technology/IP acquisition
**Target asking price:** $2,000,000

> The asking price is a target set by the seller. It is not an independently verified valuation.

## What it is

CodePilot AI is a VS Code extension that provides an autonomous AI coding agent. It reads, writes, edits, and tests code in a workspace; runs terminal commands; automates a browser; connects to external tools via MCP; and persists tasks, checkpoints, and approval history across restarts.

## Verified capabilities (with evidence)

| Capability | Evidence |
|---|---|
| Deterministic test suite | **2547/2547 tests pass, 161 files** |
| Typecheck | **19/19 packages PASS** |
| Production build | **`pnpm -r build` PASS** |
| SSRF / browser security | **44/44 tests PASS** |
| M4 approval gate | **PASS** (deny-closed, plan-mode restrictions proven live) |
| Browser automation | **17/17 real-Chromium E2E PASS** |
| Live file deletion (approve/reject) | **PASS** (ChangeSet + M4) |
| Plan-mode restrictions | **PASS** (live: zero exec/write/delete) |
| Cline independence | **0** production deps, **0** runtime, **0** copied source |
| Dependency audit | **6 direct deps**, all MIT/Apache-2.0, no copyleft |
| VSIX | **124 files, 3.64 MB**, 0 forbidden entries |

## Architecture (one line)

WebView → VS Code extension → agent runtime → model gateway → tool dispatcher → M4 policy → executors → ChangeSets/persistence → results/events → WebView.

## Key differentiators

- **M4 security gate** on every tool call (deny-closed, scoped grants, fingerprints).
- **Local-first AI** — Ollama is a first-class provider; privacy mode blocks remote providers.
- **Multi-provider** — 11 provider ids via a model gateway.
- **Browser automation** with SSRF enforcement and secret redaction.
- **MCP** with connect deadlines, SSRF, and approval parity.
- **Persistence & recovery** — tasks, checkpoints, approval timeline survive restarts.

## Known limitations

- **Bedrock** is discovery-only (no generation path). **Azure** is not implemented.
- **Cloud providers** (OpenAI/Anthropic/Google/OpenRouter) are implemented but **not live-verified** (no credentials).
- **qwen3:8b** (local test model) has a model limitation: its transport hung during the autonomous browser debug loop.
- **MCP hung-server** deterministic test added; full live MCP loopback verified.
- **Acquisition data room** is documentation-only; no credentials or secrets included.

## Technology stack

TypeScript (ESM), Node.js, VS Code Extension API, React 19 (WebView), Playwright (browser), MCP SDK, pnpm workspaces (11 packages).

## Intellectual property

All `@codepilot/*` packages are first-party (owned/developed). Third-party components are separately licensed (see `12_DEPENDENCY_LICENSES.md`). No Cline runtime/source is used (see `13_CLINE_INDEPENDENCE.md`).
