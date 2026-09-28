# CodePilot AI — Known Limitations

## Providers

- **Bedrock** — discovery-only (no generation path). False "supported" claim corrected.
- **Azure** — not implemented.
- **Cloud providers** (OpenAI/Anthropic/Google/OpenRouter/DeepSeek/Mistral) — implemented but NOT live-verified (no credentials).
- **LM Studio / llama.cpp** — implemented but not live-verified (no local server).

## Model limitations

- **qwen3:8b** (local test model) — browser autonomous debug loop transport hung after 30 events (MODEL LIMITATION). In plan mode it planned directly without reading (by design).

## Browser

- Autonomous debug loop not fully demonstrated end-to-end (model limitation above).
- Test-only SSRF override exists for local testing; cannot be enabled in production.

## MCP

- Hung-server deterministic test added; full live MCP loopback verified.

## Documentation

- Extension manifest publisher/license/repo fields require user input (not invented).

## Not claimed

- Not "100% Cline parity".
- Not "all models support autonomous tools".
- Not "all providers supported".
- No guaranteed sale price.
