# CodePilot AI — Provider Architecture

**Version:** v0.2.0 (Milestone 2)  
**Package:** `@codepilot/model-gateway`  
**Status:** Implemented and tested

> **Superseded in part — read first.** This document describes the
> Milestone-2 design. Since then, model generation moved from delegated
> SDK handlers to CodePilot's **native LLM providers**
> (`packages/agent-runtime/src/native/llm/`, curated catalogue
> `CODEPILOT_PROVIDER_CATALOG` in `@codepilot/llm`, 12 providers). The
> discovery/health/capability layer described below is still accurate;
> anything stating generation is delegated, or naming providers outside
> the curated catalogue (e.g. Bedrock/Vertex), is historical. The current
> catalogue contract is documented in [`PROVIDERS.md`](PROVIDERS.md).

---

## Overview

The provider layer decouples the CodePilot agent runtime from any specific AI
inference backend. Every provider implements the `ModelProvider` interface and
is managed by a `ProviderRegistry` that handles discovery, health checks,
caching, fallback, and observability.

**Generation** (token streaming, tool calls) is implemented by CodePilot's
native LLM providers (`packages/agent-runtime/src/native/llm/`).  
**Discovery, health, capabilities, and configuration** are owned by this
package, which also exposes the curated static model entries.

```
┌──────────────────────────────────────────┐
│           VS Code Extension              │
│  (extension.ts — model/list, settings)  │
└─────────────────────┬────────────────────┘
                      │ discoverOllamaModels()
                      │ checkOllamaHealth()
                      ▼
┌──────────────────────────────────────────┐
│         @codepilot/agent-runtime         │
│  (runtime.ts — adapter shim)            │
└─────────────────────┬────────────────────┘
                      │ ProviderRegistry + OllamaProvider
                      ▼
┌──────────────────────────────────────────┐
│        @codepilot/model-gateway          │
│                                          │
│  ProviderRegistry                        │
│    ├─ OllamaProvider                     │
│    │    ├─ /api/tags  (discovery)        │
│    │    ├─ /api/tags  (health check)     │
│    │    └─ capability metadata           │
│    ├─ OpenAICompatibleProvider           │
│    │    ├─ /v1/models (discovery)        │
│    │    ├─ /v1/models (health check)     │
│    │    └─ capability metadata           │
│    └─ Cloud providers (RestCatalogProvider base)
│         ├─ AnthropicProvider   (/v1/models)
│         ├─ GoogleGeminiProvider (/v1beta/models)
│         ├─ BedrockProvider     (static catalog*)
│         ├─ OpenRouterProvider  (/v1/models)
│         ├─ LMStudioProvider    (/v1/models)
│         ├─ DeepSeekProvider    (/v1/models)
│         ├─ MistralProvider     (/models)
│         └─ XAIProvider         (/v1/models)
└─────────────────────┬────────────────────┘
                       │ createLlmProvider(providerId, { apiKey, baseUrl })
                       ▼
┌──────────────────────────────────────────┐
│     CodePilot native LLM providers       │
│  (Ollama / OpenAI-compatible /           │
│   Anthropic / Gemini — owned, in-repo)   │
└──────────────────────────────────────────┘
```
(Historical: Bedrock/Vertex rows below describe the Milestone-2 design
and are not part of the curated catalogue.)

\* Bedrock model listing requires SigV4-signed requests beyond simple REST
discovery; CodePilot ships a static capability catalogue for Bedrock and
marks dynamic Bedrock discovery as PARTIAL in the parity matrix.

---

## ModelProvider Interface

Every provider implements `ModelProvider` from `src/provider.ts`.

```typescript
interface ModelProvider {
  readonly id: string;
  readonly name: string;
  readonly type: ProviderType;

  // Discovery
  listModels(signal?: AbortSignal): Promise<DiscoveredModel[]>;
  getModel(
    modelId: string,
    signal?: AbortSignal,
  ): Promise<DiscoveredModel | null>;

  // Health
  healthCheck(signal?: AbortSignal): Promise<ProviderHealth>;

  // Capability queries
  supportsStreaming(): boolean;
  supportsTools(): boolean;
  supportsVision(): boolean;
  supportsStructuredOutput(): boolean;
  supportsEmbeddings(): boolean;
  getCapabilities(modelId: string): ModelCapabilitySet;

  // Configuration
  getConfig(): Omit<ProviderConfig, "apiKey">;
  updateConfig(patch: Partial<ProviderConfig>): void;
}
```

### Key Design Decisions

| Decision                                                  | Rationale                                                                   |
| --------------------------------------------------------- | --------------------------------------------------------------------------- |
| `listModels()` returns `DiscoveredModel[]` not `string[]` | Callers need capability metadata (context window, tools, etc.)              |
| `healthCheck()` never throws                              | UI must always get a status, never a crash                                  |
| `getConfig()` omits `apiKey`                              | Secrets must not be serialized or returned to callers                       |
| `updateConfig()` accepts `apiKey` patch                   | Callers may update credentials at runtime (e.g. from VS Code SecretStorage) |
| Static fallback in `listModels()`                         | Cloud providers return a known model list when `/v1/models` is unreachable  |

---

## DiscoveredModel

```typescript
interface DiscoveredModel {
  id: string; // Provider-qualified model id, e.g. "qwen3:8b"
  displayName: string; // Human-readable display name
  providerId: string; // e.g. "ollama", "openai"
  capabilities: ModelCapabilitySet;
  locallyAvailable: boolean;
  sizeBytes: number | null;
  lastModified: string | null;
}
```

### ModelCapabilitySet

```typescript
interface ModelCapabilitySet {
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  structuredOutput: boolean;
  embeddings: boolean;
  reasoning: boolean;
  functionCalling: boolean;
  contextWindow: number;
  maxOutputTokens: number | null;
  estimatedMemoryMB: number | null;
  codingCapability: "excellent" | "good" | "fair" | "poor" | "unknown";
  recommendedFor: string[];
  parameterSize: string | null;
}
```

Providers report capabilities **honestly**. The `unknown` coding capability
value is never returned by the agent-runtime adapter (mapped to `"fair"`
for backward compatibility).

---

## ProviderRegistry

Central manager for all registered providers.

```typescript
class ProviderRegistry {
  register(provider: ModelProvider): void; // throws on duplicate
  unregister(providerId: string): void; // no-op if not found
  registerOrReplace(provider: ModelProvider): void;
  get(providerId: string): ModelProvider | undefined;
  list(): ModelProvider[];
  listEnabled(): ModelProvider[];

  // Discovery (TTL-cached)
  listModels(providerId: string, options?): Promise<DiscoveredModel[]>;
  listAllModels(options?): Promise<DiscoveredModel[]>;
  resolve(providerId, modelId, options?): Promise<ModelResolution | null>;

  // Health (TTL-cached)
  healthCheck(providerId, options?): Promise<ProviderHealth>;
  healthCheckAll(options?): Promise<Map<string, ProviderHealth>>;

  // Fallback
  withFallback<T>(
    primaryId,
    fallbackIds,
    operation,
  ): Promise<FallbackResult<T>>;

  // Config / cache
  updateProviderConfig(providerId, patch): void;
  invalidateCache(providerId): void;
  invalidateAllCaches(): void;

  // Observability
  subscribe(listener: RegistryEventListener): () => void;
  dispose(): void;
}
```

### Caching

| Cache           | Default TTL |
| --------------- | ----------- |
| Model discovery | 60 000 ms   |
| Health check    | 15 000 ms   |

Both TTLs are configurable via `ProviderRegistry` constructor options. Caches are
invalidated automatically when `updateProviderConfig()` is called.

---

## OllamaProvider

**File:** `src/providers/ollama.ts`

| Capability   | Implementation                                        |
| ------------ | ----------------------------------------------------- |
| Discovery    | `GET {baseUrl}/api/tags`                              |
| Health check | `GET {baseUrl}/api/tags` (fast probe)                 |
| Capabilities | `KNOWN_OLLAMA_MODEL_CAPABILITIES` lookup + heuristics |
| Default URL  | `http://localhost:11434` (from `config.ts` constant)  |
| Streaming    | Native Ollama provider (NDJSON `/api/chat`)           |

### Known Model Capabilities

The following models have static capability metadata baked in. All others
receive heuristic classification based on model name patterns (`qwen3*`,
`*coder*`, `mistral*`, etc.).

| Model                 | Context Window | Tools | Reasoning | Coding    |
| --------------------- | -------------- | ----- | --------- | --------- |
| qwen3:8b              | 32 768         | ✅    | ✅        | good      |
| qwen3:14b             | 32 768         | ✅    | ✅        | excellent |
| qwen3:30b-a3b         | 32 768         | ✅    | ✅        | excellent |
| qwen2.5-coder:7b      | 32 768         | ❌    | ❌        | good      |
| qwen2.5-coder:14b     | 32 768         | ❌    | ❌        | excellent |
| llama3.2:3b           | 131 072        | ❌    | ❌        | fair      |
| codellama:13b         | 16 384         | ❌    | ❌        | good      |
| deepseek-coder-v2:16b | 163 840        | ❌    | ❌        | excellent |
| mistral:7b            | 32 768         | ✅    | ❌        | good      |

### Error Normalization (Ollama)

| Raw Error         | Normalized Code             | Retryable |
| ----------------- | --------------------------- | --------- |
| `ECONNREFUSED`    | `NETWORK`                   | ✅        |
| `HTTP 404`        | `MODEL_NOT_FOUND`           | ❌        |
| `HTTP 500`        | `NETWORK`                   | ✅        |
| Aborted / timeout | `UNAVAILABLE` health status | —         |

---

## OpenAICompatibleProvider

**File:** `src/providers/openai-compatible.ts`

Supports **any** OpenAI Chat Completions compatible endpoint:

- OpenAI (`https://api.openai.com/v1`)
- Enterprise AI gateways
- Local OpenAI-compatible servers (LM Studio, vLLM, llama.cpp)
- Any other endpoint that implements `GET /v1/models` and `POST /v1/chat/completions`

| Capability     | Implementation                                                         |
| -------------- | ---------------------------------------------------------------------- |
| Discovery      | `GET {baseUrl}/models` (falls back to static list for known providers) |
| Health check   | `GET {baseUrl}/models` with 401/403 detection                          |
| Capabilities   | `KNOWN_OPENAI_MODEL_CAPABILITIES` lookup + heuristics                  |
| Authentication | `Authorization: Bearer {apiKey}` header                |
| Streaming      | Native OpenAI-compatible provider (SSE `/chat/completions`) |

### Static Model Catalogue (OpenAI)

| Model       | Context Window | Vision | Tools | Reasoning |
| ----------- | -------------- | ------ | ----- | --------- |
| gpt-4o      | 128 000        | ✅     | ✅    | ❌        |
| gpt-4o-mini | 128 000        | ✅     | ✅    | ❌        |
| o3          | 200 000        | ❌     | ✅    | ✅        |
| o4-mini     | 200 000        | ❌     | ✅    | ✅        |

---

## Provider Configuration

**File:** `src/config.ts`

### Built-in Defaults

All 11 built-in provider ids are declared in `BUILTIN_PROVIDER_IDS`
(`config.ts`) with defaults in `BUILTIN_PROVIDER_DEFAULTS`:

| Provider id         | Type                | Discovery endpoint                        | Auth (env var)                           |
| ------------------- | ------------------- | ----------------------------------------- | ---------------------------------------- |
| `ollama`            | `ollama`            | `GET /api/tags`                           | none (local)                             |
| `openai`            | `openai-compatible` | `GET /v1/models`                          | `OPENAI_API_KEY`                         |
| `openai-compatible` | `openai-compatible` | `GET /v1/models`                          | user-supplied                            |
| `anthropic`         | `anthropic`         | `GET /v1/models`                          | `ANTHROPIC_API_KEY`                      |
| `google`            | `gemini`            | `GET /v1beta/models`                      | `GEMINI_API_KEY` (alt: `GOOGLE_API_KEY`) |
| `openrouter`        | `openai-compatible` | `GET /v1/models`                          | `OPENROUTER_API_KEY`                     |
| `lmstudio`          | `openai-compatible` | `GET /v1/models`                          | none (local)                             |
| `deepseek`          | `openai-compatible` | `GET /v1/models`                          | `DEEPSEEK_API_KEY`                       |
| `mistral`           | `openai-compatible` | `GET /v1/models`                          | `MISTRAL_API_KEY`                        |
| `xai`               | `openai-compatible` | `GET /v1/models`                          | `XAI_API_KEY`                            |
| `bedrock`           | `bedrock`           | static catalog (SigV4 needed for dynamic) | AWS credential chain                     |

All cloud providers except Ollama/LM Studio are **disabled by default** and
must be enabled explicitly (`enabled: true`) with credentials supplied via
`apiKey` or the mapped environment variable. `apiKeyFromEnv("google")` checks
`GEMINI_API_KEY` first and falls back to `GOOGLE_API_KEY`.

```typescript
const BUILTIN_PROVIDER_DEFAULTS = {
  ollama: {
    id: "ollama",
    name: "Ollama (Local)",
    type: "ollama",
    baseUrl: "http://localhost:11434",
    enabled: true,
    timeoutMs: 120_000,
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    type: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    defaultModelId: "gpt-4o-mini",
    enabled: false, // disabled until user supplies an API key
    timeoutMs: 120_000,
  },
  "openai-compatible": {
    id: "openai-compatible",
    name: "OpenAI-Compatible",
    type: "openai-compatible",
    baseUrl: "", // must be set by user
    enabled: false,
    timeoutMs: 120_000,
  },
};
```

### Validation Rules

| Rule                                                | Error Level |
| --------------------------------------------------- | ----------- |
| Empty provider id or name                           | Error       |
| `openai-compatible` without `baseUrl`               | Error       |
| `baseUrl` not starting with `http://` or `https://` | Error       |
| Plain `http://` for non-localhost                   | Warning     |
| `timeoutMs <= 0`                                    | Error       |

### Environment Variables

| Provider  | Environment Variable |
| --------- | -------------------- |
| openai    | `OPENAI_API_KEY`     |
| anthropic | `ANTHROPIC_API_KEY`  |
| google    | `GOOGLE_API_KEY`     |
| mistral   | `MISTRAL_API_KEY`    |

Read via `apiKeyFromEnv(providerId)`. Never logged or stored in source code.

---

## Health Checks

```
ProviderHealthStatus =
  | "HEALTHY"       — server reachable, models available
  | "DEGRADED"      — server reachable but auth error or 5xx
  | "UNAVAILABLE"   — server not reachable / timeout
  | "UNKNOWN"       — provider not registered
```

Health probes:

- **Ollama:** `GET /api/tags` — timeout 5 s
- **OpenAI-compatible:** `GET /v1/models` — timeout 5 s, detects 401/403

Health results are cached for 15 s by default. The UI should display
`ProviderHealth.status` and `ProviderHealth.error` directly.

---

## Streaming

Streaming is handled entirely by CodePilot's **native LLM providers**
(supersedes the delegated design below, kept for history):

```
User Prompt
  → CodePilotRuntime.startSession()
    → native agent engine → native provider (Ollama / OpenAI-compatible /
       Anthropic / Gemini: HTTP POST /api/chat or /chat/completions, SSE/NDJSON)
      → native stream events → AgentEvent
        → Extension → WebView
```

<details>
<summary>Historical Milestone-2 design (delegated generation — no longer used)</summary>

Streaming was handled by delegated SDK handlers:

```
User Prompt
  → CodePilotRuntime.startSession()
    → ClineCore.start({ config, ... })
      → @cline/llms createHandler({ providerId, modelId, apiKey, baseUrl })
        → HTTP POST /api/chat (Ollama) or /v1/chat/completions (OpenAI)
          → ApiStreamChunk stream
            → mapCoreEvent() → AgentEvent
              → Extension → WebView
```

The M1 **exactly-once-delivery** guarantee is preserved by the native
architecture — `model-gateway` is only called for discovery and health,
never for generation.

</details>

---

## Cancellation

Provider requests that originate from `listModels()` and `healthCheck()`
accept an `AbortSignal`:

```typescript
const controller = new AbortController();
const models = await registry.listModels("ollama", {
  signal: controller.signal,
});
// Cancel at any time:
controller.abort();
```

The M1 `CancellationSource` propagates cancellation through the agent
runtime and into `AbortSignal` when needed.

---

## Retry and Fallback

Retry for transient errors is handled by the M1 `withRetry()` utility in
`@codepilot/agent-runtime/cancellation.ts`. The `isTransientError()` predicate
determines whether an error is safe to retry.

Provider fallback is available via `ProviderRegistry.withFallback()`:

```typescript
const result = await registry.withFallback(
  "openai", // primary
  ["ollama"], // fallback chain
  (provider) => provider.listModels(),
);
if (result.fell_back) {
  console.log(`Fell back to ${result.usedProviderId}`);
}
```

A `PROVIDER_FALLBACK` event is emitted to registry subscribers when a fallback
occurs so the UI can display an appropriate message.

---

## Error Normalization

All provider errors are normalized into `NormalizedProviderError`:

```typescript
interface NormalizedProviderError {
  code: ProviderErrorCode;
  message: string; // safe for UI display, secrets redacted
  technicalDetail?: string; // for logs only, secrets redacted
  retryable: boolean;
  cause?: unknown;
}
```

| Code                     | Examples                  | Retryable |
| ------------------------ | ------------------------- | --------- |
| `AUTHENTICATION`         | 401, "Invalid API key"    | ❌        |
| `AUTHORIZATION`          | 403, "Forbidden"          | ❌        |
| `RATE_LIMIT`             | 429, "Too many requests"  | ❌        |
| `TIMEOUT`                | ETIMEDOUT, "timed out"    | ✅        |
| `NETWORK`                | ECONNREFUSED, 502, 503    | ✅        |
| `MODEL_NOT_FOUND`        | 404, "no such model"      | ❌        |
| `CANCELLED`              | AbortError                | ❌        |
| `PROVIDER_UNAVAILABLE`   | "No providers available"  | ✅        |
| `STREAM_INTERRUPTED`     | "stream interrupted"      | ✅        |
| `INVALID_REQUEST`        | 400, "invalid_request"    | ❌        |
| `UNSUPPORTED_CAPABILITY` | "does not support vision" | ❌        |
| `UNKNOWN`                | Everything else           | ❌        |

---

## Security

| Concern                           | Mitigation                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------- |
| API key logging                   | `getConfig()` omits `apiKey`; `redactSecrets()` strips keys from error messages |
| API key in source code            | Never stored; injected at runtime from VS Code SecretStorage                    |
| Unencrypted remote endpoints      | `validateProviderConfig()` warns about non-localhost http://                    |
| Private network access via Ollama | No change — Ollama is local-only by default                                     |
| SSRF via URL fetch                | Provider URLs set by the user; no URL-from-prompt execution                     |

---

## Observability

Registry emits structured events to subscribers:

```
PROVIDER_REGISTERED
PROVIDER_UNREGISTERED
MODEL_DISCOVERY_STARTED
MODEL_DISCOVERY_COMPLETED
MODEL_DISCOVERY_FAILED
HEALTH_CHECK_STARTED
HEALTH_CHECK_COMPLETED
PROVIDER_FALLBACK
```

Each event includes `providerId`, `timestamp`, and an optional `detail` string.
**No API keys, no secrets, no user data** appear in any event.

---

## Testing

| Test File                             | Tests | Coverage                                                  |
| ------------------------------------- | ----- | --------------------------------------------------------- |
| `provider.test.ts`                    | 20    | Core types, error normalization, secret redaction         |
| `config.test.ts`                      | 17    | Validation, defaults, env-var helpers                     |
| `providers/ollama.test.ts`            | 21    | Discovery, health, capabilities, security                 |
| `providers/openai-compatible.test.ts` | 21    | Discovery, health, capabilities, security                 |
| `registry.test.ts`                    | 27    | Registration, caching, fallback, observability            |
| `integration.test.ts`                 | 7     | End-to-end: discovery + health + fallback + secret safety |
| `runtime-provider.test.ts`            | 6     | agent-runtime ↔ model-gateway integration                 |

**Total M2 tests:** 119 (model-gateway) + 10 (agent-runtime M2 tests) = **129 new tests**

All tests use mocked `fetch` — no live network access required.

---

## Factory Helpers

The `model-gateway` package exports convenience factories:

```typescript
// Registry pre-loaded with Ollama
const registry = createRegistryWithOllama("http://localhost:11434");

// Individual providers
const ollama = createOllamaProvider({ baseUrl: "http://localhost:11434" });
const openai = createOpenAICompatibleProvider({
  id: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-...", // from SecretStorage
});
```

---

## Limitations (current)

1. **Live verification coverage** — Ollama is live-verified end to end in
   this repository (including native tool calling). Cloud providers share
   the same native provider path and are covered by stubbed-wire suites
   plus the selector's Test Connection probe, but are not live-verified
   here — use Test Connection before relying on a new provider.
2. **Streaming cancellation via AbortSignal** — the native providers wire
   the run/request signals through to fetch and enforce an inactivity
   timeout on idle streams; cancellation is covered by deterministic and
   live suites.
3. **Dynamic OpenAI-compatible discovery** — falls back to static list on
   auth failure. The user must configure the API key through VS Code
   settings (SecretStorage) for dynamic discovery to work.

(The Milestone-2 limitations about unimplemented Anthropic/Google
providers and unwired AbortSignal propagation no longer apply: native
Anthropic/Gemini providers exist and signal propagation is implemented
and tested.)
