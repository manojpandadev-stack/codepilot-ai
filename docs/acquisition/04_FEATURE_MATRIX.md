# CodePilot AI — Feature Matrix

Every feature has one honest classification. Evidence references point to test files.

| # | Feature | Classification | Evidence |
|---|---|---|---|
| 1 | Task planning | PASS | `task-plan.test.ts` (14), plan-pause-integration (8) |
| 2 | Autonomous execution | PASS | agent loop, multi-step continuation |
| 3 | Human-in-the-loop (M4) | PASS | m4-approval-tool-automation, mode-escape regression |
| 4 | Pause/resume | PASS | resume.test.ts, cancellation.test.ts |
| 5 | Task progress tracking | PASS | webview-messages, chat-lifecycle |
| 6 | Token/cost tracking | PASS | provider-catalog (20), usage-summary-integration (3) |
| 7 | File create/read/edit/delete | PASS | file-automation, changeset suites |
| 8 | AST/code-structure (inspect_symbols) | PASS | code-structure (8), builtin-tools inspect (5) |
| 9 | Regex/project search | PASS | search.test.ts (9), builtin-tools search (3) |
| 10 | Visual diffs | PASS | diff-engine, m5-integration |
| 11 | Sequential checkpoints | PASS | checkpoint-manager (18), durability (6) |
| 12 | Terminal command execution | PASS | terminal-streaming, m4-approval |
| 13 | Interactive/background sessions | PASS | agent-terminal-sessions (25), stdin (3) |
| 14 | Automatic failure recovery | PASS | self-healing, m13-command-repair (20) |
| 15 | SSH environment support | PASS | terminal-environment (14) |
| 16 | WSL support | PASS | wsl-distros (7) |
| 17 | Headless browser | PASS | browser-e2e (17), url-policy |
| 18 | Browser click/type/scroll/nav | PASS | browser-tools (16), e2e |
| 19 | Browser console monitoring | PASS | browser-tools, e2e |
| 20 | Browser network monitoring | PASS | browser-tools, e2e |
| 21 | Browser screenshots | PASS | browser-tools hook, e2e |
| 22 | Autonomous browser debug loop | **MODEL LIMITATION** | qwen3:8b transport hung (Phase E) |
| 23 | Contextual references (@file/@diff/@terminal) | PASS | composer-context (34), context-grounding (7) |
| 24 | Custom instructions (rules) | PASS | skills-activation (53) |
| 25 | `.clinerules` compatibility | PASS | rules-loading tests |
| 26 | Large-output/paste (outputRef) | PASS | output-sidecar (8), streaming-shell (23) |
| 27 | Provider routing | PASS | providers.test.ts, provider-factory |
| 28 | Anthropic | **NOT LIVE VERIFIED** | native adapter; no key |
| 29 | OpenAI | **NOT LIVE VERIFIED** | native adapter; no key |
| 30 | Google/Gemini | **NOT LIVE VERIFIED** | native adapter; no key |
| 31 | DeepSeek-compatible | **NOT LIVE VERIFIED** | OpenAI-compatible gateway; no key |
| 32 | AWS Bedrock | **DISCOVERY-ONLY** | `BedrockProvider.listModels`; no generation |
| 33 | Azure OpenAI | **NOT IMPLEMENTED** | no adapter |
| 34 | OpenRouter | **NOT LIVE VERIFIED** | OpenAI-compatible; no key |
| 35 | Together-compatible | **NOT IMPLEMENTED** | catalogue entry only |
| 36 | Mistral-compatible | **NOT LIVE VERIFIED** | OpenAI-compatible gateway; no key |
| 37 | Ollama | PASS | live suites |
| 38 | LM Studio | **NOT LIVE VERIFIED** | OpenAI-compatible; no server |
| 39 | llama.cpp | **NOT LIVE VERIFIED** | generic adapter; no server |
| 40 | Secure SecretStorage | PASS | vscode-integration-security, m19-regression |
| 41 | MCP | PASS | index.test.ts (53), m8, live-loopback, hung-server |
| 42 | MCP external tools/resources | PASS | approval blocks, loopback |
| 43 | Observability | PASS | observability.test.ts, observability-service (26) |
| 44 | Usage/cost UI | PASS | usage-summary-integration, task-history cost |
| 45 | Recovery/self-healing | PASS | self-healing, m10-loop-guard |
| 46 | Multi-step autonomous loops | PASS | loop suites |
| 47 | Security enforcement | PASS | six security suites (163), mode-escape |

## Cross-cutting

| Gap | Classification |
|---|---|
| Aggregate matrix test | **NOT IMPLEMENTED** |
| WebView loading watchdog | **NOT IMPLEMENTED** |
| React error boundary | **NOT IMPLEMENTED** |
| Dead/legacy code (cline-compare script) | **PARTIAL** — repository-engine removed (proven dead); cline-compare benchmark script remains (non-production) |
| E2E scripts outside vitest include | **PARTIAL** |

## Not claimed

- Not "100% Cline parity".
- Not "all models support autonomous tools".
- Not "all providers supported".
