# Cline Dependency Map — CodePilot AI

> **Historical record — removal complete.** This map inventoried every
> production `@cline/*` import site to drive the independent-runtime
> migration. As of the current tree: **zero production `@cline/*`
> imports, zero manifest dependencies, zero lockfile entries, zero
> runtime code in `dist/` and the VSIX** (verified by sweeps). Everything
> below describes the pre-removal state and is retained as the removal
> record — not as current architecture.

Audited against `@cline/*@0.0.75` as resolved in this workspace
(`node_modules/.pnpm/@cline+*@0.0.75*/`) and every production import site.
Behavioral contract source of truth: `packages/agent-runtime/src/core-event-mapper.ts`
(empirically verified wire shapes) plus the passing test suite and live runs.

Only production (`apps/*/src`, `packages/*/src`, excluding `*.test.ts`) imports
are listed. Test-only mocks (`vi.mock("@cline/core")` in ~6 agent-runtime
tests) and manual `scripts/probe-*.ts` probes are out of scope for removal but
noted where they must be retargeted.

## 1. `@cline/core` — production consumers

### 1a. `packages/agent-runtime/src/runtime.ts` (CodePilotRuntime — PRIMARY)
Consumed API:
- `ClineCore.create({ clientName, backendMode })` → core instance.
- `cline.subscribe(listener)` — additive, exactly-once-per-instance subscription
  to `CoreSessionEvent`s.
- `cline.start({ config, capabilities, localRuntime, source, prompt,
  interactive, initialMessages? })` → `{ sessionId, result }`.
  - `config`: providerId, modelId, apiKey, baseUrl, mode, systemPrompt,
    cwd, workspaceRoot, enableTools, enableSpawnAgent, enableAgentTeams,
    thinking, maxIterations, temperature, extraTools, toolPolicies.
  - `capabilities`: `{ requestToolApproval, toolExecutors? }`.
  - `localRuntime.hooks.beforeTool(ctx)` → `undefined` (allow) or
    `{ skip: true, reason }` (deny). Context: `ctx.tool.name`,
    `ctx.toolCall.toolCallId`, `ctx.input`.
  - `initialMessages`: provider-protocol history seed (roles user/assistant,
    text/tool_use/tool_result blocks); orphaned tool calls repaired core-side.
- `cline.send({ sessionId, prompt, mode })`, `cline.abort(sessionId)`,
  `cline.stop(sessionId)`, `cline.list(limit)` → session records
  `{ sessionId, metadata?: { title? }, updatedAt? }`, `cline.dispose()`.
- Types: `ToolApprovalRequest`, `ToolApprovalResult`, `RuntimeCapabilities`.
- Result: `{ sessionId, result: { outputText? | text?, usage? } }`.

Replacement: CodePilot-owned `CodePilotCore` in `packages/agent-runtime`
(same method surface, same `CoreSessionEvent` wire shapes so
`core-event-mapper.ts` is untouched).

### 1b. `packages/agent-runtime/src/agent.ts` (CodePilotAgent — USED by orchestrator)
Consumed API:
- `Agent` class + `createBuiltinTools({ cwd, enableBash, enableWebFetch })`
  from `@cline/core`; `AgentTool` types from `@cline/agents`.
- Public surface to preserve: constructor (CodePilotAgentConfig),
  `initialize()`, `run(message) → { text, usage }`, M4 `beforeTool` hook.
- `MultiAgentOrchestrator` (`orchestrator.ts:688`) constructs it per role task.

Replacement: reimplement `agent.ts` on `CodePilotCore` (same public API);
owned `createBuiltinTools`.

### 1c. `packages/agent-runtime/src/write-tools.ts`
Consumed API:
- `computePatchChanges(patch, cwd)` → `{ changes: Record<path,
  { type, newContent?, oldContent? }> }` (unified-diff preview).

Replacement: owned unified-diff parser/applier with identical result shape.

## 2. `@cline/agents` — production consumers

### 2a. Types (`agent-runtime/src/types.ts`, `index.ts`, extension/browser/mcp)
- `AgentTool`: `{ name, description?, inputSchema?, timeoutMs?, execute(input, ctx?) }`
  where `ctx` carries `{ conversationId?, agentId?, sessionId?, signal? }`
  (proven by `agent-terminal-session-tools.ts` + MCP/browser wrappers).
- `AgentUsage`: `{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalCost? }`.
- `AgentMessage`: `{ role, content }` wire-compatible message.

Replacement: owned identical types in new `packages/llm` (structural parity).

### 2b. `createTool` (`packages/tool-engine/src/index.ts`)
Trivial factory `{ name, description, inputSchema, execute }` → tool object.
Replacement: owned one-function factory, same call shape.

## 3. `@cline/shared` — production consumers

### 3a. Types (`packages/policy-engine/src/index.ts`)
- `ToolPolicy { enabled, autoApprove }`,
  `ToolApprovalRequest`, `ToolApprovalResult`.

Replacement: owned identical types in `@codepilot/shared` (our package).

### 3b. Shell helpers (`packages/tool-engine/src/m3/streaming-shell.ts`)
- `getDefaultShell(platform: string): string` (powershell on win32, bash/posix).
- `getShellInvocation(shell, command): { args, input? }` (PowerShell source
  via Unicode-safe stdin; `-c`-style for posix; shell-kind classification).

Replacement: owned implementation in `@codepilot/shared`, behavior pinned by
`streaming-shell.test.ts` (pwsh/cmd/Unicode/spaces cases).

## 4. `@cline/llms` — production consumers

### 4a. Catalogue data (`packages/model-gateway/src/provider-catalog.ts`)
- `MODEL_COLLECTIONS_BY_PROVIDER_ID`: provider registry (100+ entries with
  models, capabilities, pricing, base URLs, env vars, config fields).

Replacement: owned curated catalogue in new `packages/llm` for the priority
providers (Ollama, OpenAI-compatible incl. LM Studio, OpenAI, Anthropic,
Google, OpenRouter) + generic custom; `model-gateway` mapping functions kept,
dataset swapped, exported `CatalogProvider` interface unchanged.

### 4b. Generation handler (`packages/agent-runtime/src/compaction-summarizer.ts`)
- `createHandler({ providerId, modelId, apiKey?, baseUrl?, taskId })` →
  `ApiHandler`; `handler.createMessage(system, messages)` → async iterable of
  `{ type: "text", text }` / `{ type: "done", success, error? }`.

Replacement: owned one-shot completion over the new LLM layer (same chunk
shapes consumed).

## 5. Consumed-but-absent identifiers (verified)
`toolExecutors`, `localRuntime`, `initialMessages`, `autoApprove`,
`addMissingToolResults`, `createBuiltinTools`, `computePatchChanges` appear
**zero** times in the installed `@cline/*@0.0.75` bundles (minified internals),
yet CodePilot passes them and live runs prove the behaviors (M4 gating,
executor dispatch, history seeding, orphan repair). Conclusion: the CodePilot
contract is defined by **observed behavior** (mapper docs + suite + live
runs), which the CodePilot-owned core implements natively — a strict
behavioral superset, never a copy.

## 6. Builtin tool surface (model-visible, must be preserved)
Core builtins observed: `read_files`, `search_codebase`, `fetch_web_content`,
`web_search`, `ask_question`, `skills`, `editor`, `apply_patch`,
`run_commands` (+ `submit_and_exit`/`spawn_agent`/team tools only when
explicitly enabled — CodePilot disables them). Override seam:
`toolExecutors` entries (`bash`, `editor`, `apply_patch`) replace default
execution. Unknown names are rejected ("Unknown tool" behavior preserved).

## 7. Test-only `@cline/*` references (retarget, do not weaken)
`vi.mock("@cline/core")` + FakeClineCore in: `lifecycle-hardening.test.ts`,
`runtime-provider.test.ts`, `runtime-provider-switch.test.ts`,
`runtime-subscription.test.ts`, `streaming-terminal.test.ts`
(+ `continuation.test.ts` uses scripted paths). Retarget mocks to the new
`codepilot-core.js` module specifier with identical fakes/assertions.
`provider-catalog.test.ts` asserts SDK dataset invariants → rewrite against
the owned dataset (same invariant categories).
Manual `scripts/probe-*.ts`, `scripts/benchmark/cline-compare.ts`,
`scripts/verify-catalog.mjs`, `tests/*-test.ts` scratch probes: dev-only,
uncollected, unreferenced by CI — left untouched (may bit-rot when
`node_modules` prunes `@cline/*`; acceptable, documented here).

## 9. Concurrent-work note (read-only observation, not modified)
During this audit the tree already contained an independent in-progress
migration: `packages/agent-runtime/src/native/` (patch-engine, llm adapters,
engine session/loop/dispatch) plus `packages/tool-engine/src/m3/shell-platform.ts`,
with `streaming-shell.ts` and `write-tools.ts` already rewired to them
(write-tools suite: 14/14 green against the owned patch engine). Those files
are NOT part of this implementation track and were not touched. This track
(`packages/llm`, `codepilot-core.ts`, owned builtins) is intentionally
independent; overlapping coverage is disclosed in the final report rather
than merged, per the parallel-implementation assignment.

## 8. Replacement architecture (CodePilot-owned)
- `packages/llm` (NEW): `LlmProvider` interface + `LlmChunk` streaming
  protocol + adapters (Ollama `/api/chat` NDJSON; OpenAI-compatible
  `/chat/completions` SSE; OpenAI native; Anthropic Messages SSE; Google
  `streamGenerateContent` SSE; OpenRouter) + `createLlmProvider` factory +
  one-shot `completeText` + owned provider catalogue + owned agent/tool
  types (`AgentTool`, `AgentUsage`, `AgentMessage`, `RuntimeCapabilities`).
- `packages/shared` (extend): owned `ToolPolicy`, `ToolApprovalRequest`,
  `ToolApprovalResult`, shell helpers.
- `packages/agent-runtime` (extend): `CodePilotCore` (sessions, agent loop,
  owned builtins, dispatch, identical event wire shapes), owned
  `computePatchChanges`, reimplemented `agent.ts`, rewired
  `compaction-summarizer.ts`; `runtime.ts` swaps the import only.
- `packages/tool-engine`, `packages/policy-engine`, `packages/model-gateway`:
  import swaps only (behavior unchanged).
- M4 stays the single authority: `beforeTool` semantics preserved verbatim
  (allow = `undefined`, deny = `{ skip: true, reason }`), evaluated before
  every dispatch including owned defaults.
