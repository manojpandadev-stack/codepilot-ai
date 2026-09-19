# CodePilot AI — Provider System

CodePilot AI's provider ecosystem is built around **one authoritative
curated catalogue** owned by CodePilot (`CODEPILOT_PROVIDER_CATALOG` in
`@codepilot/llm`) — 12 providers covering local runtimes, major clouds,
and OpenAI-compatible endpoints. The live agent runtime resolves models
through CodePilot's **native LLM registry** (`createLlmProvider`); there
is no third-party runtime in the generation path. The UI never maintains
its own provider list.

## Architecture

```
@codepilot/llm  CODEPILOT_PROVIDER_CATALOG   ← SINGLE SOURCE OF TRUTH
(curated: ids, endpoints, capabilities, static models, config fields)
        │
        ▼
@codepilot/model-gateway  provider-catalog.ts
        │            (adds status/category/usage overlay)
        ▼
Extension host  provider-service.ts
        │  • credentials → VS Code SecretStorage (never leaves the host)
        │  • non-secret config (base URL overrides) → globalState
        │  • health checks (models endpoint probe)
        │  • usage: OpenRouter credits API / local ledger
        ▼
CodePilotRuntime → native LLM registry   (providerId routes to a native
        │                                 Ollama / OpenAI-compatible /
        │                                 Anthropic / Gemini provider)
        ▼
WebView  ProviderSelector.tsx   (search, badges, credentials form, usage)
```

## Provider statuses

| Status | Meaning |
|---|---|
| `SUPPORTED` | CodePilot can configure it and route a real model request through the production runtime today. |
| `CONFIGURABLE` | Works through the OpenAI-compatible protocol with a user-supplied base URL/key/model. |
| `GATEWAY` | Accessed through a supported router/gateway (OpenRouter, Requesty, LiteLLM, …). |
| `LOCAL` | Local runtime (Ollama, LM Studio) — nothing leaves your machine. |
| `SUBSCRIPTION` | Requires a provider subscription/OAuth login (ChatGPT/Copilot/Claude plans). Configure via the provider's own login; not key-based. |
| `PLANNED` | Listed for completeness. **Not** usable today — never presented as supported. |

Status assignment is evidence-based: local runtimes are `LOCAL`;
router/subscription ids from the overlay sets are `GATEWAY`/`SUBSCRIPTION`;
catalogue ids with a dedicated native provider are `SUPPORTED`; any other
catalogue id works through its explicit base URL as `CONFIGURABLE`.

## Credentials & security

- API keys are stored **only** in VS Code SecretStorage under
  `codepilot.apiKey.<providerId>`. Legacy installs' keys are migrated
  transparently (read-through).
- The WebView receives **presence booleans only** — never a key.
- Keys never enter logs, TaskStore, telemetry, or error messages.
- Custom base URLs are validated with the M13 navigation policy (blocks
  metadata IPs, link-local, private ranges for cloud providers; loopback is
  allowed only for LOCAL providers). URLs with embedded credentials are
  rejected.
- Provider switching changes **only** the model endpoint. Every tool call
  still flows through the M4 permission pipeline; provider configuration
  cannot create an alternate tool-execution path.

## Usage / billing

- `provider-api`: a documented, key-authenticated usage endpoint exists.
  Currently: **OpenRouter** (`GET /api/v1/credits`). Numbers shown come
  directly from the provider.
- `local-tracking`: CodePilot records real token usage per task in a bounded
  local ledger (200 records) and estimates cost from the catalogue's
  published per-Mtok pricing. Estimates are always labelled as estimates.
- `none`: local runtimes — "Local usage — no provider API billing."
- If no pricing data exists for a model, no cost is displayed — never a
  fabricated number.

## Model catalogue

- Local/OpenAI-compatible providers: **live discovery** through the M2
  gateway (`/models` endpoint probe) when reachable.
- All other providers: curated static model entries shipped in the
  catalogue (context windows, capabilities, pricing where published).
- Model selection per provider updates the live runtime on the next task.

## Adding a provider

Providers are added explicitly — nothing appears automatically:

1. **Catalogue entry** — add the provider to `CODEPILOT_PROVIDER_CATALOG`
   in `packages/llm/src/catalogue.ts` (id, endpoints, capabilities,
   static models, config fields).
2. **Protocol/routing** — add a case in the native registry
   (`packages/agent-runtime/src/native/llm/registry.ts`), or rely on the
   OpenAI-compatible default when the provider speaks that protocol and
   the user supplies a base URL.
3. **Status/category/usage facts** — edit the overlay sets in
   `packages/model-gateway/src/provider-catalog.ts`
   (`USAGE_PROVIDER_API`, `BILLING_PORTALS`, `SUBSCRIPTION_IDS`,
   `LOCAL_IDS`, `GATEWAY_IDS`, `DESCRIPTION_OVERRIDES`).
4. **New usage API** — add the endpoint call in
   `apps/vscode-extension/src/provider-service.ts` (`getUsage`) and add the
   provider id to `USAGE_PROVIDER_API`.
5. **Tests** — extend `packages/model-gateway/src/provider-catalog.test.ts`
   and `tests/provider-contracts.test.ts`.

No UI changes are required to add a provider — the selector derives
everything from the catalogue payload.
