# Jev Decision Routing (TypeSafe AI)

Optional intent-classification layer for CodePilot AI. Jev suggests which
**existing** workflow a turn belongs to; it never replaces the agent runtime,
code-generation models, tool execution, approvals, or verification.

## Official integration (verified 2026-09-30)

- Docs: https://docs.typesafe.ai (llms.txt index + JS SDK, models, API,
  primitives, confidence, intent-routing pattern pages all fetched and read).
- Package: `@typesafe-ai/sdk@0.6.0` (npm, MIT, repo
  `typesafe-ai/typesafe-sdk-js`; ESM + CJS + declarations; Node ≥ 20).
  Exports verified at runtime: `TypeSafeClient`, `choice`, `score`, `noul`,
  `APITimeoutError`, `APIUserAbortError`, `RateLimitError`,
  `AuthenticationError`, `ENV`, `VERSION`.
- Auth: `TYPESAFE_API_KEY` env / `Authorization: Bearer` (we pass the key
  explicitly from VS Code SecretStorage; env fallback untouched).
- Endpoint: `POST https://api.typesafe.ai/v1/systemone`
  (`{state, model, questions}` → `{model, answers, usage}`).
- Models: `jev-latest` (default, currently `jev-1.13.0`), `jev-preview`,
  pinned `jev-1.13.0`. Input billed ($0.042/Mtok), output free; 429/529 with
  SDK backoff; 64k context; text only.
- Primitives: Choice (≤ 255 options, probabilities + confidence), Score
  (2–10 levels), Noul (yes-probability). Confidence-gated routing (0.5
  threshold convention) and the intent+complexity pattern come straight from
  the official intent-routing guide.
- NOT official: `langchain-typesafe` never appears in TypeSafe docs — it is
  not used. No latency/cost claims are made (unmeasured).

## Architecture

- `packages/decision-router` (isolated, no VS Code dependency):
  `IntentRouter` interface, typed intent/complexity/confidence contracts,
  `JevIntentRouter` (official SDK, strict schema validation, single
  intent-Choice + complexity-Score call), `FallbackIntentRouter`
  (deterministic local keywords), workflow policy (advisory-first; assist
  only ever maps auto-mode turns to ask/act), content-free metrics, and
  Score/Noul/analytics interfaces reserved for later (not executed).
- Host wiring (`apps/vscode-extension/src/extension.ts` + settings): the
  narrowest pre-dispatch point in `sendPromptToAgent`, after prompt
  composition, before `runtime.startSession`. Failures never block the run.
- The classifier receives the **raw user request text (capped at 2000
  chars) plus dispatch mode only** — never files, history, or attachments.

## Configure the key securely

1. Settings → Decision routing (Jev) → enter the TypeSafe API key → Save.
   It is stored in VS Code SecretStorage under `codepilot.apiKey.jev`.
2. The webview only ever sees a presence boolean. Keys never appear in
   logs, source, settings files, or test output.

## Enable / disable

- `codepilot.jev.enabled` (default `false`): master switch. Off = existing
  routing, zero behavior change.
- `codepilot.jev.mode`: `advisory` (record + display only, default) or
  `assist` (may select ask/act **only** on turns dispatched with agent mode
  `auto`; explicit ask/plan/act/review modes are never overridden).
- `codepilot.jev.model` (default `jev-latest`), `codepilot.jev.timeoutMs`
  (default 8000, clamped 1000–30000), `codepilot.jev.confidenceThreshold`
  (default 0.5).
- Provider and model selection are never touched by routing.

## Privacy

Jev is a cloud service. Under Local Only mode it is **never called** —
classification falls back to the local deterministic router with no network.
Remote classification requires cloud/hybrid mode (the existing explicit
opt-in) **and** a stored key. Privacy mode is never switched automatically.

## Tests

- `packages/decision-router/src/*.test.ts`: six intents, schema/invalid
  responses, timeout, unavailable service, low confidence, cancellation,
  policy mapping, metrics (mocked transport; no key, no network).
- `tests/jev-routing-integration.test.ts`: disabled preserves behavior,
  Local-Only sends nothing remote, assist+auto cannot bypass privacy or
  approvals, key lifecycle is presence-only (hermetic).
- `tests/jev-live.test.ts`: opt-in only (`CODEPILOT_JEV_LIVE=1` plus a real
  `TYPESAFE_API_KEY`); skipped otherwise. Live Jev inference has NOT been
  tested in this environment (no key available).

## Limitations

- No live Jev request has succeeded yet — integration is complete but
  unverified end-to-end pending a key + explicit cloud opt-in.
- No speed/cost claims (unmeasured).
- Score-based context relevance and Noul security signals are interfaces
  only; deterministic checks + user approval remain authoritative.
- Model discovery for cloud providers (`provider/models`) still uses public
  endpoints when switching providers; out of scope for this change.
