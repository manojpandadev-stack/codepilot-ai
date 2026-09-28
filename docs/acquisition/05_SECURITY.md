# CodePilot AI — Security

## M4 (tool approval gate)

Every tool call passes a deny-closed gate BEFORE execution: native dispatcher gate → RiskEngine → PolicyEngine → ApprovalManager → SecurityValidator. No pipeline configured = no execution. Mode filtering blocks mutating tools in plan/ask mode.

## Approval

Approval cards surface in the WebView. Decisions are single-use, bound to the exact command text. Scoped grants bind to operation fingerprints (action + normalized command + target paths) and expire after one hour.

## Workspace boundaries

Filesystem access is contained to the workspace root (PathGuard). Absolute escapes and traversal are rejected. Checkpoint restore stays workspace-bound.

## Terminal security

Shell commands run through the streaming executor with a 48k output cap. Interactive stdin is bounded. The command repair loop is bounded (max 3 attempts, loop guard). M4 re-gates transformed commands.

## SSRF / browser security

Every browser request (navigation, redirects, iframes, XHR) passes the URL policy via a route interceptor. Private networks, loopback, link-local, and cloud-metadata endpoints are blocked by default. 44/44 SSRF tests pass.

## MCP security

MCP server URLs are validated (SSRF). Connect deadlines abort hung handshakes. Tool calls have execution timeouts. Credentials in env/headers are redacted on persistence. Approval parity for MCP tools.

## Secret redaction

A single canonical scrubber (`scrubSecretsText`) funnels every sink (logs, audit, task persistence, sidecar, browser capture). Credentials are redacted BEFORE bytes touch disk.

## Persistence protection

All persistence is atomic (tmp+rename). Corrupt files are quarantined, never thrown. Approval timeline contains no secrets. Checkpoint ownership is enforced host-side.

## Test evidence

Security suites: SSRF 44/44, M4 approval automation, mode-escape regression, secret redaction, workspace boundary, path traversal, symlink escape, terminal restrictions, approval replay, persistence corruption, MCP security, browser security, WebView message validation.
