# CodePilot AI — Acquisition FAQ

**What is CodePilot?** An autonomous AI coding agent as a VS Code extension — reads, writes, tests, and debugs code with human-in-the-loop approval.

**What is included?** 11 first-party packages, VS Code extension, WebView, agent runtime, M4 security, browser engine, MCP manager, persistence, 2547-test suite, documentation, VSIX artifact.

**What is excluded?** Cloud provider credentials, AWS Bedrock generation, Azure, real brand/domain/trademark ownership, any Cline code.

**Technology stack?** TypeScript (ESM), Node.js, VS Code Extension API, React 19, Playwright, MCP SDK, pnpm workspaces.

**How many tests?** 2547/2547 pass, 161 files. Typecheck 19/19. Build PASS.

**Security controls?** M4 deny-closed gate, scoped approval grants with fingerprints, mode filtering, workspace boundaries, terminal restrictions, SSRF, MCP security, secret redaction, persistence corruption quarantine.

**Does it use Cline code?** No. 0 production deps, 0 runtime, 0 copied source. Fully independent.

**Third-party dependencies?** 6 direct (MCP SDK, react, react-dom, playwright-core, simple-git, pg) — all MIT/Apache-2.0. Playwright requires Apache attribution.

**Providers actually implemented?** Ollama (native, live-verified), OpenAI/Anthropic/Google (native), OpenAI-compatible (OpenRouter/DeepSeek/Mistral/LM Studio/llama.cpp). Bedrock discovery-only. Azure not implemented.

**Does it support local models?** Yes — Ollama is first-class; privacy mode blocks remote providers.

**How does M4 work?** Every tool call passes a deny-closed gate (policy → risk → approval → security) before execution. Risky operations surface an approval card.

**How does browser automation work?** 15 Playwright tools with SSRF enforcement, console/network capture (redacted, bounded), screenshot→image pipeline.

**How does MCP work?** stdio/SSE/streamable-HTTP with connect deadlines, execution timeouts, SSRF, approval parity, redaction.

**How is the product built?** `pnpm -r build` then `vsce package --no-dependencies`.

**Known limitations?** Bedrock discovery-only, Azure not implemented, cloud providers not live-verified, qwen3:8b browser-loop model limitation.

**Proposed transaction structure?** One-time technology/IP acquisition. Target asking price: $2,000,000 (seller target, not a verified valuation).
