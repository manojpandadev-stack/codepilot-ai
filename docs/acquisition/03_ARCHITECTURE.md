# CodePilot AI — Architecture

## Data flow

```
WebView (React 19)
  ↓ chat/send, tool/approval_result
VS Code extension (apps/vscode-extension)
  ↓ activate, message handlers, webview sink
Agent runtime (packages/agent-runtime)
  ↓ agent loop, multi-step tool continuation
Model gateway (packages/model-gateway)
  ↓ provider factory, 11 catalogue ids
Tool dispatcher (native/engine)
  ↓ gate → execute
M4 policy (packages/tool-engine/m4)
  ↓ policy → risk → approval → security
Executors
  ↓ streaming shell, browser, filesystem, MCP
ChangeSets / persistence (packages/agent-runtime/m12)
  ↓ tasks, checkpoints, approval timeline, images
Results / events → WebView
```

## Package responsibilities

| Package | Responsibility |
|---|---|
| `shared` | Types, default tool policies, secret scrubber, composer context |
| `agent-runtime` | Agent loop, builtin tools, task store, repair loop, runtime events |
| `tool-engine` | M4 gate, policy engine, risk engine, approval manager, security validator, streaming shell, output sidecar, MCP tool-id map |
| `model-gateway` | Provider abstraction, factory, discovery, health, fallback |
| `llm` | Provider catalogue, model capabilities, vision detection |
| `context-engine` | Repository understanding, code structure provider, search |
| `changeset-engine` | Staged writes, checkpoint manager, diff engine |
| `browser-engine` | BrowserService, Playwright tools, SSRF route interceptor |
| `mcp-manager` | MCP client lifecycle, connect deadlines, approval, redaction |
| `git-engine` | GitEngine over simple-git |
| `policy-engine` | Permission policy, mode filtering |
| `vscode-extension` | VS Code integration, webview bridge, terminal sessions, browser host |
| `webview` | React chat UI, composer, approval cards, diff viewer |

## Security architecture

Every tool call flows: native dispatcher gate → RiskEngine → PolicyEngine → ApprovalManager → SecurityValidator → (approved) execute. The gate is deny-closed: no pipeline, no execution. Scoped grants bind to operation fingerprints and expire.

## Persistence

JSON files under the extension global storage: `tasks/`, `checkpoints/`, `command-repair.json`, `audit/`. All writes are atomic (tmp+rename). Corrupt files are quarantined (renamed `.corrupt-*`), never thrown.
