# CodePilot AI — Provider Matrix

| Provider | Adapter | Connection test | Streaming | Tool calling | Vision | Auth | SecretStorage | Discovery | Tests | Live verified |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Ollama | Native (first-class) | Yes | Yes | Yes | Yes | None (local) | N/A | Yes | Yes | **YES** (local) |
| OpenAI | Native | Yes | Yes | Yes | Yes | API key | Yes | Yes | Yes | NOT LIVE (no key) |
| Anthropic | Native | Yes | Yes | Yes | Yes | API key | Yes | Yes | Yes | NOT LIVE (no key) |
| Google/Gemini | Native | Yes | Yes | Yes | Yes | API key | Yes | Yes | Yes | NOT LIVE (no key) |
| OpenRouter | OpenAI-compatible | Yes | Yes | Yes | Yes | API key | Yes | Yes | Yes | NOT LIVE (no key) |
| DeepSeek | OpenAI-compatible gateway | Yes | Yes | Yes | Partial | API key | Yes | Yes | Yes | NOT LIVE (no key) |
| Mistral | OpenAI-compatible gateway | Yes | Yes | Yes | Partial | API key | Yes | Yes | Yes | NOT LIVE (no key) |
| LM Studio | OpenAI-compatible (local) | Yes | Yes | Yes | Partial | None (local) | N/A | Yes | Yes | NOT LIVE (no server) |
| llama.cpp | OpenAI-compatible (generic) | Yes | Yes | Yes | No | None (local) | N/A | Yes | Yes | NOT LIVE (no server) |
| Bedrock | **Discovery-only** (no generation) | N/A | N/A | N/A | N/A | IAM | N/A | Yes | Yes | NOT LIVE (no AWS) |
| Azure | **NOT IMPLEMENTED** | — | — | — | — | — | — | — | — | — |
| Together | Catalogue entry only | — | — | — | — | — | — | — | — | — |

**Summary:** 11 catalogue provider ids. 4 native adapters (Ollama, OpenAI, Anthropic, Google). OpenAI-compatible shared adapter for OpenRouter/DeepSeek/Mistral/LM Studio/llama.cpp. Bedrock discovery-only. Azure not implemented. Only Ollama is live-verified (local).

False claims removed: Bedrock "supported" claim corrected to discovery-only.
