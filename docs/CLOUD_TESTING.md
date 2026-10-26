# Cloud-first testing (CodePilot AI)

CodePilot is cloud-first: fresh installs default to OpenRouter, and Ollama
is an explicit opt-in. The test strategy separates deterministic verification
from live cloud verification.

## Normal suite (mocked — no key, no Ollama, no network)

```bash
pnpm test        # vitest run — must pass with nothing installed/running
pnpm typecheck
pnpm build
```

Rules for the normal suite:

- Provider HTTP is mocked (`vi.stubGlobal("fetch", ...)` / injected
  transports) or fail-closed (privacy blocks, auth-required without a key).
- Public model discovery degrades to the static catalogue when the network
  is unavailable (`modelsForProvider` catches and falls through).
- Tests that need a local provider behaviour pin it explicitly
  (`settings/set provider=ollama` or `configOverrides`), never relying on
  a global default.
- No test prints credentials; fake keys (`sk-*-test-key-not-real`) are
  never valid key shapes and are asserted absent from all messages.

## Opt-in live cloud tests (real network, your saved credentials stay home)

These are skipped unless `CODEPILOT_LIVE_CLOUD=1`:

```bash
CODEPILOT_LIVE_CLOUD=1 npx vitest run tests/provider-cloud-confirm-e2e.test.ts
```

They use fake keys and assert the provider's real HTTP verdicts (e.g.
OpenRouter 401) — proving the request path reaches the API without ever
needing a valid key. Auth failures are asserted, never retried.

Excluded by filename either way: `tests/**/*live*.test.ts`,
`tests/ollama-integration.test.ts` (run via `pnpm test:live`).

## In-extension live test (real key, real SecretStorage)

The only place your saved OpenRouter key exists is your real VS Code
SecretStorage — automated tests can never see it (the harness uses isolated
storage). To verify with YOUR key and YOUR selected model:

1. Settings → Model → OpenRouter → save key, pick a model.
2. Switch Privacy mode to Cloud (explicit opt-in; Local Only refuses).
3. Command Palette → **CodePilot: Live Cloud Test (Saved Credentials)**.
4. Read the `Output → CodePilot AI` channel (`[LiveCloudTest]` lines):
   discovery count, tool-calling support for the selected model
   (supported / NOT supported / unknown — from catalogue capabilities,
   never assumed), one bounded inference verdict
   (Success / Authentication failed / Credits unavailable / Rate limited /
   other), and remaining credits where available.

The probe prompt is the fixed word "ping" (5 tokens), single attempts
only, 8s discovery / 20s inference aborts, no retries on auth/credits/
rate-limit verdicts. The command never changes provider, model, or
privacy mode, and never prints the key.

## Jev decision routing

Optional and off by default (`codepilot.jev.enabled`). When disabled,
tasks route through the existing provider (OpenRouter by default) with
zero extra traffic. See `docs/JEV_DECISION_ROUTING.md`. Its live test
(`tests/jev-live.test.ts`) needs `CODEPILOT_JEV_LIVE=1` plus a real
`TYPESAFE_API_KEY` and skips otherwise.

## What is NOT automatically verified

- Real OpenRouter inference with a valid key (run the in-extension
  command above; report Success vs Authentication failed vs Credits
  unavailable vs Rate limited).
- Live tool-calling on a specific OpenRouter model (the command reports
  catalogue support; autonomous live runs are untested here).
- Live streaming/cancellation against a cloud endpoint (covered by
  scripted-event suites; live path untested here).
