# CodePilot AI — Compatibility Matrix

## Verified (live)

| Capability | Evidence |
|---|---|
| Local Ollama runtime | Live suites pass |
| MCP (stdio/SSE/streamable-HTTP) | 72/72 tests incl. hung-server regression |
| Security controls (M4, SSRF, redaction) | SSRF 44/44, M4 deny-closed |
| Approval unit lifecycle | Persistence + corruption quarantine tests |
| Browser E2E | 17/17 real-Chromium |
| Terminal (streaming, interactive stdin, repair) | Terminal suites |
| Persistence/recovery | Tasks, checkpoints, approval timeline |

## Runtime supported but NOT LIVE VERIFIED

| Capability | Reason |
|---|---|
| Cloud providers (OpenAI/Anthropic/Google/OpenRouter/DeepSeek/Mistral) | Implemented; no credentials available |
| Native tool calling against cloud models | Requires a cloud model with credentials |

## Not implemented

| Capability | Status |
|---|---|
| Azure OpenAI | NOT IMPLEMENTED |
| Full AWS Bedrock provider (generation) | NOT IMPLEMENTED — discovery-only |
| Together adapter | NOT IMPLEMENTED — catalogue entry only |

## Model limitation

| Capability | Status |
|---|---|
| qwen3:8b autonomous browser debug loop | MODEL LIMITATION — transport hung after 30 events |
| qwen3:8b live approval lifecycle | MODEL LIMITATION — did not trigger protected write_file |
| qwen3:8b native tool-calling demo | MODEL LIMITATION — not demonstrated live |

> A model limitation is not a software defect. The runtime uses native structured tool calling and does NOT interpret prose JSON as a tool call.
