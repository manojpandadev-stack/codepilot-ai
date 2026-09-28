# CodePilot AI — MCP (Model Context Protocol)

## Capability

Connect to external MCP servers over three transports: stdio, SSE, streamable-HTTP. Discover and call tools, resources, and prompts. Approval parity with native tools.

## Security

- **SSRF:** server URLs validated before connect.
- **Connect deadline:** a server that spawns but never completes the handshake is aborted at the configured bound (default 15s). Deterministic hung-server regression test proves no indefinite hang, child cleanup, and continued usability.
- **Execution timeout:** per-tool-call deadline (default 120s, server override).
- **Redaction:** env values and headers redacted on persistence.
- **Approval:** MCP tool calls surface the same M4 approval cards.

## Transports

stdio (child process), SSE (HTTP), streamable-HTTP. Each has connect + execution deadlines. Unsupported/misconfigured transports throw explicitly — never a silent fallback.

## Evidence

MCP suite: 72/72 tests pass (config persistence, redaction, health, reconnect, hung-server regression, live loopback).
