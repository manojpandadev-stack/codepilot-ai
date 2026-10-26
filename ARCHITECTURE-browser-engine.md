# CodePilot AI — Secure Browser + Computer-Use Engine: Architecture Sign-Off

Session handoff from the 5-hour deep implementation. Read-only record; no code changes yet.

## 1. Truth the repo already contained (verified by reading)

- **`packages/browser-engine/` already exists** and is NOT a stub: it ships a complete,
  production-ready M3 browser tool set (`browser-tools.ts` → 15 `ToolDefinition`s),
  a real `BrowserService` over **playwright-core**, a strict layered **URL/network
  SSRF policy** (`url-policy.ts`), a full test suite, and a published package
  (`@codepilot/browser-engine`, `workspace:*` pinned in `apps/vscode-extension`,
  `pnpm-lock.yaml`, and the VSIX `package.json`).
- **playwright-core + chromium-bidi are already vendored** in the extension build
  (`apps/vscode-extension/esbuild.mjs` externalizes them) and shipped in the VSIX
  (`THIRD_PARTY_NOTICES.md` records the Apache-2.0 license).
- The extension already owns the host: `apps/vscode-extension/src/browser-service.ts`
  (`ExtensionBrowserService`) exposes `buildAgentTools()` (each call goes through the
  live M4 gate → `ToolExecutionService` → `BrowserService` → Chromium), and
  `apps/vscode-extension/src/extension.ts` wires the live M4 pipeline,
  `tool/request_approval` / `tool/approval_result` dispatch, and the snapshot hook.
- **playwright-core is NOT a dev-time npm install** in this repo — `pnpm install`
  did NOT install playwright browser binaries. That is by design (the VSIX ships
  playwright-core without a browser download; the host discovers a system Chrome/Edge
  channel via `discoverBrowserChannel()`). Any implementation that `npm i playwright`
  or tries to `playwright install chromium` would ship a broken product.
- The engine `agent-loop` / `session` / `tool-dispatch` / `runtime` already pass
  every tool through `gate` (deny-closed M4) with per-call `timeoutMs`, `AbortSignal`
  propagation, bounded output, and cancellation. Cancel proceeds.
- The webview already knows `tool/started`, `tool/completed`, `tool/request_approval`,
  `tool/approval_resolved`, `tool/approval_result`, `ToolEvent`
  (`{ id, name, status, detail, durationMs }`), and `M4ApprovalRequest`.
- `autocompleteOn` (in `types.ts` / `App.tsx` settings) is the app-level live-chat
  setting for *built-in* tools, NOT for the browser tool set. Try using it to
  "auto-approve browser" would edit unrelated settings and break existing behavior.

## 2. Integration seam to implement (the only new surface)

`buildBrowserAgentTools()` in `apps/vscode-extension/src/extension.ts` already builds
an `AgentTool[]` for the live agent where the M4 gate → `ToolExecutionService` →
`BrowserService` pipeline runs. It is *not* the extension's `autocompleteOn`.

From the test standpoint the authoritative check is
`apps/vscode-extension/src/browser-service.test.ts` (the existing battle-tested test
page) — not a webview-only mock. The exact extension hook names are:

- `[agent]` event dispatch → live agent tool stream (M4-gated per call)
- `tool/request_approval` → `M4PermissionPipeline` → `ApprovalManager`
- `tool/approval_result` → host resolves the SAME `ApprovalManager` request (single-use:
  stale/duplicate IDs rejected)
- `tool/approval_resolved` → retired approval card

The `browser_service.ts` `ExtensionBrowserService` already owns the singleton
`BrowserService`, per-task session isolation, per-task teardown, and the image
staging hook. The `M4` pipeline is in `M4PermissionPipeline` with
`ApprovalManager` + `ApprovalPresentation` + `UserApprovalChoice`, and the webview
`ToolEvent` (`name`, `status`) already provides the timeline row.

## 3. Scope of changes (optimal, minimal, no regressions)

- **Browser-host interface (`packages/browser-engine/src/browser-host.ts`):**
  the existing `BrowserService` already owns lifecycle, per-task isolation, SSRF
  enforcement, capture (console/network), and bounded extraction. A thin host
  interface adds no new behavior; it documents and unit-tests the contract.
- **Playwright adapter (`packages/browser-engine/src/browser.ts`):**
  the flyweight is `BrowserService` (one `Browser` process → many isolated
  `BrowserContext` + `Page` per task). A `BrowserFocus` interface maps the tool
  contract onto the session API; nothing here bypasses M4.
- **Per-tool timeouts + cancellation:**
  `ToolExecutionService` already arms a per-execution timer that fires `tool.cancel()`
  and aborts the context signal; `dispatchToolCall` (native engine) and
  `ToolExecutionService.execute()` (M4 path) both race on `signal`. Cancelled → status
  `CANCELLED`.
- **SSRF / redirect / download / upload protection:**
  every navigation/request is intercepted at `page.route` (fail-closed).
- **Secret redaction / prompt-injection defense:**
  `redactSecrets` on every extraction; web content is tagged as untrusted data.
- **Control Center UI:**
  `ActivityTimeline` + `ControlCenter` derive rows from real ToolEvents; pending
  approvals surface as blocking rows; M4 approval cards rendered from
  `tool/request_approval` / `tool/approval_result`.
- **Tests:** harden the existing deterministic suites
  (`browser-e2e.test.ts`, `browser-ssrf-hardening.test.ts`,
  `browser-tools.test.ts`), plus new unit suites for the host/adapt
  er/timouts/SSRF/redaction/prompt-injection.
- **Verification:** `verifyBrowserTool` (real state change: text/URL/DOM after the
  action) + `verification-engine.ts` for automated checks.
- **Recovery / observability:** bounded retries, fail-closed, no auto-retry of
  blocked security/payment/account-deletion; per-op `requestId`, `taskId`, `action`,
  `risk`, `duration`, result, error classification; no secrets in logs.

## 4. Verified check results

- `pnpm typecheck` EXIT=0 (all packages, `tsconfig.build.json` + `*.tsbuildinfo`).
- `pnpm build` EXIT=0 (`pnpm -r build`).
- Webview build EXIT=0.
- VSIX = 124 files / 3,888,681 bytes, PKG_EXIT=0.
- `pnpm test` → **3049 passed / 5 skipped / 1 failed**.
  - The 1 failure is the pre-existing `tests/plan-pause-integration.test.ts`
    case (`pause across restart and resume → ... leaves paused`), unrelated to the
    browser engine and already failing at baseline.
  - The `tests/browser-e2e.test.ts` (17 tests) and
    `tests/browser-ssrf-hardening.test.ts` suites both PASS with real Chromium
    (all action/mock capture tests verified with `expect().toHaveBeenCalledTimes(n)`).
  - Deterministic `packages/browser-engine` suites already run clean within the
    aggregate.

## 5. Baseline environment notes

- Node 24, pnpm@11.22.0, vitest 3.2.7, playwright-core ^1.63.0, VS Code + VSCE toolchain.
- No git operations performed (per the session rule). `pnpm test` ran in the repo
  root (`codepilot-ai/`); `--reporter=dot` and explicit status capture preserved.

## 6. Known limitations

- The browser E2E in CI runs against a local test page served by the test suite
  (deterministic; no reliance on random external sites).
- A cloud provider E2E was not executed in this session; HTTP 401 on the key probe is
  reported as a limitation, not a pass.
- Missing new source files: `packages/browser-engine/src/browser-host.ts`,
  `packages/browser-engine/src/browser.ts`,
  `packages/browser-engine/src/browser-host.test.ts`,
  `packages/browser-engine/src/browser.test.ts`.
- No completion unless the requested implementation targets are delivered.

## 7. Recommended next feature

*Context-aware, multi-step browser computer-use: attach the browser session to a
conversation turn (snapshot + redacted extraction as model input), composite
multi-step actions as a single tool with intermediate `tool_progress` events, and
auto-healing of transient `page-crash` / `element-not-visible` failures via the
existing `recovery-controller.ts` path.*
