/**
 * CodePilot AI — provider service (extension host side).
 *
 * Bridges the authoritative provider catalogue (@codepilot/model-gateway
 * provider-catalog) with VS Code:
 *
 *   - credentials: VS Code SecretStorage only. The webview NEVER receives a
 *     key — only presence booleans. Keys never enter logs, TaskStore, or
 *     globalState.
 *   - config: non-secret provider configuration (base URL overrides, local
 *     endpoints) in VS Code globalState under a single namespaced key.
 *   - health: probe the provider's catalogue health endpoint (per-provider
 *     `probePath`: Ollama → /api/tags, OpenAI-compatible → /models); never
 *     throws; bounded; classifies auth/rate-limit/network states.
 *   - usage: real provider usage APIs where documented (OpenRouter credits);
 *     everything else reports "local tracking only". No fabricated numbers.
 *
 * This service holds no tool-execution capability — provider configuration
 * cannot create an alternate tool path; the live M4 pipeline is untouched.
 */

import * as vscode from "vscode";
import {
  getCatalogProvider,
  getProviderCatalog,
  getCuratedProviderCatalog,
  isSupportedProviderId,
  type CatalogProvider,
} from "@codepilot/model-gateway";
import { checkNavigationPolicy } from "@codepilot/context-engine";
import { isRemoteProvider } from "@codepilot/agent-runtime";

// ============================================================================
// Secret key mapping
// ============================================================================

/** SecretStorage key for a provider: `codepilot.apiKey.<providerId>`. */
export function secretKeyFor(providerId: string): string {
  return `codepilot.apiKey.${providerId}`;
}

/**
 * Providers whose credentials map to a LEGACY secret key (pre-catalogue
 * installs). Reading falls back to these so existing users keep working.
 */
const LEGACY_SECRET_KEYS: Readonly<Record<string, string>> = {
  "openai-native": "codepilot.apiKey.openai",
  openai: "codepilot.apiKey.openai",
  gemini: "codepilot.apiKey.google",
  google: "codepilot.apiKey.google",
};

// ============================================================================
// Non-secret provider configuration (globalState)
// ============================================================================

const CONFIG_STATE_KEY = "codepilot.providerConfig.v1";

/** Non-secret, per-provider configuration the user may set. */
export interface ProviderConfigEntry {
  /** Base URL override (validated before storage). */
  baseUrl?: string;
  /** Non-secret fields from the catalogue (region, projectId, profile…). */
  fields?: Record<string, string>;
}

type ProviderConfigMap = Record<string, ProviderConfigEntry>;

// ============================================================================
// URL validation (SSRF-safe)
// ============================================================================

/**
 * Validate a user-supplied provider base URL.
 *
 * Reuses the M13 WebAgent navigation policy (strict IP classification:
 * blocks loopback, link-local, private ranges, metadata IPs, non-HTTP(S)
 * schemes) — but explicitly ALLOWS loopback/private for LOCAL providers,
 * where pointing at localhost is the entire point.
 *
 * Returns the normalized URL or an error reason (never echoes secrets —
 * URLs must not contain credentials).
 */
export function validateProviderBaseUrl(
  url: string,
  providerId: string,
): { ok: true; url: string } | { ok: false; reason: string } {
  const provider = getCatalogProvider(providerId);
  const isLocal = provider?.category === "local" || provider?.supportsLocal;

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { ok: false, reason: "Not a valid URL." };
  }
  if (url.trim() !== parsed.toString().trim() && url.includes("@")) {
    // userinfo in URL = embedded credentials — reject, never store.
    return {
      ok: false,
      reason: "URL must not contain embedded credentials (user:pass@host).",
    };
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      reason: "URL must not contain embedded credentials (user:pass@host).",
    };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "Only http(s) URLs are allowed." };
  }
  if (isLocal) {
    // Local runtimes: loopback/private explicitly allowed.
    return { ok: true, url: parsed.toString() };
  }
  // Cloud providers: strict M13 policy (blocks private/metadata/link-local).
  const verdict = checkNavigationPolicy(parsed.toString());
  if (!verdict.allowed) {
    return { ok: false, reason: `Blocked: ${verdict.reason}.` };
  }
  return { ok: true, url: parsed.toString() };
}

// ============================================================================
// Local Only policy — ONE authoritative answer for every provider request
// ============================================================================

/**
 * The decision every outbound provider-service path must consult before it
 * touches the network.
 */
export interface ProviderRequestPolicy {
  /** FALSE ⇒ the request must not be attempted at all. */
  allowed: boolean;
  /** Secret-free, actionable refusal (present only when `allowed` is false). */
  reason?: string;
  /**
   * `fetch` redirect mode.
   *
   * Local Only uses `"manual"` and NEVER follows a redirect. The gate can only
   * validate the CONFIGURED endpoint; a loopback server that answers
   * `302 Location: https://…` would otherwise send the request off the
   * machine via a destination the policy never inspected — a silent Local Only
   * bypass. Outside Local Only the default follow behaviour is preserved, so
   * cloud providers that legitimately redirect are unaffected.
   */
  redirect: "follow" | "manual";
}

/**
 * The single authoritative Local Only policy for provider-service requests.
 *
 * Locality is decided by the EFFECTIVE DESTINATION through the canonical
 * runtime policy (`isRemoteProvider`), never by the provider id alone: a local
 * provider id pointed at a remote `baseUrl` is still remote, and an unknown
 * provider or unparsable endpoint fails closed. Mirrors the runtime guard
 * exactly — only `"local"` forbids the network.
 */
export function providerRequestPolicy(
  privacyMode: "local" | "hybrid" | "cloud",
  providerId: string,
  effectiveBaseUrl: string | undefined,
): ProviderRequestPolicy {
  if (
    privacyMode === "local" &&
    isRemoteProvider(providerId, effectiveBaseUrl)
  ) {
    return {
      allowed: false,
      redirect: "manual",
      reason: `Local Only privacy mode blocks network access to the "${providerId}" provider. No request was made. Switch privacy mode in Settings to use it.`,
    };
  }
  return {
    allowed: true,
    redirect: privacyMode === "local" ? "manual" : "follow",
  };
}

/**
 * Refusal used when a Local Only endpoint answers with a redirect. The request
 * was attempted against a permitted loopback destination, but following it
 * would leave the machine — so the honest outcome is a policy block, never a
 * fabricated "connected"/"unavailable" verdict about the remote target.
 */
function redirectRefusal(providerId: string): string {
  return `Local Only privacy mode blocked a redirect from the "${providerId}" provider to a remote endpoint. No request was made beyond the local endpoint.`;
}

/**
 * A mask-style value (such as "••••••••••••••••") used as a UI placeholder.
 * Mask strings must NEVER overwrite real credentials or be saved to SecretStorage.
 */
export function isCredentialMask(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return (
    trimmed.includes("•") ||
    trimmed.includes("●") ||
    /^[\u2022\u25cf\*]+$/.test(trimmed)
  );
}

// ============================================================================
// Provider service
// ============================================================================

export type HealthState =
  | "connected"
  | "auth-required"
  | "auth-invalid"
  | "rate-limited"
  | "unavailable"
  | "invalid-config"
  | "no-endpoint";

export interface HealthResult {
  state: HealthState;
  /** Human-readable, secret-free detail (safe for webview + logs). */
  message: string;
  latencyMs?: number;
}

/**
 * Honest, host-verified provider connection states.
 *
 * CRITICAL RULE: "API key exists" ≠ "provider connected". Only a positive
 * host-side probe may produce "connected". Credential presence alone is
 * "configured" (cloud) / "unverified" — never "connected".
 */
export type ConnectionState =
  | "configured"
  | "checking"
  | "connected"
  | "unavailable"
  | "auth-required"
  | "auth-invalid"
  | "rate-limited"
  | "no-endpoint"
  | "unverified";

/** One entry of `provider/list` — per-provider connection truth. */
export interface ConnectionStateEntry {
  id: string;
  name: string;
  state: ConnectionState;
  /** Derived convenience: true ONLY for a positive host-side probe. */
  connected: boolean;
  /** Secret-free detail (HTTP status / network error text). */
  detail?: string;
  latencyMs?: number;
  /** Host time of the probe that produced this state (ISO-8601), if probed. */
  checkedAt?: string;
}

/** Result of an inference probe (chat-completions round trip). */
export interface InferenceProbeResult {
  /**
   * - "blocked"  — Local Only refused the probe BEFORE any request; nothing
   *   was sent and nothing can be concluded about the provider.
   * - "auth-failed" — credentials rejected.
   * - "failed" — the probe ran and the model did not complete a turn.
   * - "success" — the provider actually completed a chat-completions call.
   */
  state: "success" | "failed" | "auth-failed" | "blocked";
  /** Echoed model id (present whenever a probe was attempted). */
  modelId?: string;
  /** Human-readable, secret-free detail (safe for webview + logs). */
  message: string;
  latencyMs?: number;
}

export interface ProviderUsageSnapshot {
  providerId: string;
  kind: "provider-api" | "local-tracking" | "none";
  /** Present only for provider-api kind. */
  usage?: {
    /** USD, as reported by the provider API. */
    usedUsd?: number;
    /** USD, as reported by the provider API. */
    limitUsd?: number;
    remainingUsd?: number;
  };
  billingPortalUrl?: string;
  /** Set when the provider-API fetch failed (no fabricated fallback). */
  error?: string;
}

export class ProviderService implements vscode.Disposable {
  private readonly secrets: vscode.SecretStorage;
  private readonly state: vscode.Memento;
  private readonly disposables: vscode.Disposable[] = [];
  /**
   * Effective privacy mode. Injected by the host so probes/discovery honour
   * the SAME Local Only decision as the runtime.
   *
   * Defaults to "cloud" ONLY for direct construction outside the host (unit
   * harnesses). The extension ALWAYS injects the real user setting, so
   * product behaviour is governed by the user's privacy mode, never by this
   * default.
   */
  private readonly privacyMode: () => "local" | "hybrid" | "cloud";

  constructor(
    context: vscode.ExtensionContext,
    privacyMode?: () => "local" | "hybrid" | "cloud",
  ) {
    this.secrets = context.secrets;
    this.state = context.globalState;
    this.privacyMode = privacyMode ?? (() => "cloud");
  }

  /**
   * The CURRENT policy for one provider, read fresh on every call so a privacy
   * change takes effect immediately on a long-lived service instance.
   *
   * This is the ONLY gate every outbound provider-service path consults.
   */
  requestPolicy(providerId: string): ProviderRequestPolicy {
    return providerRequestPolicy(
      this.privacyMode(),
      providerId,
      this.effectiveBaseUrl(providerId),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  // ------------------------------------------------------------------
  // Catalogue
  // ------------------------------------------------------------------

  listProviders(): CatalogProvider[] {
    return getCuratedProviderCatalog();
  }

  listAllProviders(): CatalogProvider[] {
    return getProviderCatalog();
  }

  // ------------------------------------------------------------------
  // Credentials (SecretStorage only — never leaves the host)
  // ------------------------------------------------------------------

  async hasCredential(providerId: string): Promise<boolean> {
    return (await this.getCredential(providerId)) !== undefined;
  }

  /** Resolve a credential for live runtime use (host-side only). */
  async getCredential(providerId: string): Promise<string | undefined> {
    const key = secretKeyFor(providerId);
    try {
      const v = await this.secrets.get(key);
      if (v !== undefined) return v;
    } catch {
      // fall through to legacy
    }
    const legacy = LEGACY_SECRET_KEYS[providerId];
    if (!legacy || legacy === key) return undefined;
    try {
      return await this.secrets.get(legacy);
    } catch {
      return undefined;
    }
  }

  async setCredential(providerId: string, value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed || isCredentialMask(trimmed)) return;
    await this.secrets.store(secretKeyFor(providerId), trimmed);
  }

  async clearCredential(providerId: string): Promise<void> {
    await this.secrets.delete(secretKeyFor(providerId));
    const legacy = LEGACY_SECRET_KEYS[providerId];
    if (legacy && legacy !== secretKeyFor(providerId)) {
      await this.secrets.delete(legacy);
    }
  }

  // ------------------------------------------------------------------
  // Non-secret config (globalState)
  // ------------------------------------------------------------------

  getConfig(providerId: string): ProviderConfigEntry {
    const map = this.state.get<ProviderConfigMap>(CONFIG_STATE_KEY) ?? {};
    return map[providerId] ?? {};
  }

  setConfig(providerId: string, entry: ProviderConfigEntry): void {
    const map = this.state.get<ProviderConfigMap>(CONFIG_STATE_KEY) ?? {};
    const cleaned: ProviderConfigEntry = {};
    if (entry.baseUrl !== undefined) cleaned.baseUrl = entry.baseUrl;
    if (entry.fields !== undefined) {
      // Defensive scrub: never persist secret-shaped values here.
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(entry.fields)) {
        if (/key|token|secret|password|credential/i.test(k)) continue;
        fields[k] = String(v).slice(0, 256);
      }
      cleaned.fields = fields;
    }
    if (Object.keys(cleaned).length === 0) {
      delete map[providerId];
    } else {
      map[providerId] = cleaned;
    }
    void this.state.update(CONFIG_STATE_KEY, map);
  }

  /**
   * Effective base URL for a provider: user override → catalogue default →
   * undefined. Validated at set-time; re-validated here defensively.
   */
  effectiveBaseUrl(providerId: string): string | undefined {
    const cfg = this.getConfig(providerId);
    if (cfg.baseUrl) {
      const v = validateProviderBaseUrl(cfg.baseUrl, providerId);
      if (v.ok) return v.url;
    }
    return getCatalogProvider(providerId)?.baseUrl;
  }

  // ------------------------------------------------------------------
  // Health (test connection)
  // ------------------------------------------------------------------

  /**
   * Probe a provider through its catalogue health endpoint (the
   * authoritative per-provider `health.probePath` — Ollama is probed at
   * `/api/tags`, OpenAI-compatible style endpoints at `/models`). The base
   * URL is normalized (trailing slashes stripped) before appending the
   * probe path; the root endpoint (`/`) is NEVER probed. Never throws,
   * bounded, and never includes secrets in results.
   */
  async testConnection(
    providerId: string,
    signal?: AbortSignal,
    overrideApiKey?: string,
  ): Promise<HealthResult> {
    const provider = getCatalogProvider(providerId);
    if (!provider || !isSupportedProviderId(providerId)) {
      return { state: "invalid-config", message: "Unsupported provider." };
    }
    // Local Only is checked FIRST so the reported reason is the policy — not a
    // misleading "configure a base URL" or "no testable endpoint" that would still be blocked afterwards.
    const policy = this.requestPolicy(providerId);
    if (!policy.allowed) {
      return { state: "invalid-config", message: policy.reason ?? "Blocked." };
    }
    if (!provider.health.supportsTestConnection) {
      return {
        state: "no-endpoint",
        message:
          "This provider has no testable HTTP endpoint. Configure a key and run a task to verify.",
      };
    }
    const base = this.effectiveBaseUrl(providerId);
    if (!base) {
      return {
        state: "invalid-config",
        message: "No base URL configured for this provider.",
      };
    }
    const apiKey = overrideApiKey ?? (await this.getCredential(providerId));
    if (provider.health.requiresApiKeyForProbe && !apiKey) {
      return {
        state: "auth-required",
        message:
          providerId === "gemini"
            ? "Gemini API key is required."
            : "API key required before testing this provider.",
      };
    }

    const probePath = provider.health.probePath ?? "/models";
    // Normalize safely: strip trailing slashes, then append the probe path
    // verbatim. `http://localhost:11434/` → `http://localhost:11434` +
    // `/api/tags` — the root endpoint is never requested.
    const probeUrl = `${base.replace(/\/+$/, "")}${probePath}`;

    const started = Date.now();
    try {
      const effectiveSignal =
        AbortSignal.any?.([
          AbortSignal.timeout(8_000),
          ...(signal ? [signal] : []),
        ]) ?? AbortSignal.timeout(8_000);
      const headers: Record<string, string> = { Accept: "application/json" };
      if (apiKey) {
        if (providerId === "gemini") {
          headers["x-goog-api-key"] = apiKey;
        } else {
          headers.Authorization = `Bearer ${apiKey}`;
        }
      }
      const response = await fetch(probeUrl, {
        signal: effectiveSignal,
        headers,
        redirect: policy.redirect,
      });
      const latencyMs = Date.now() - started;
      // Local Only never follows a redirect off the machine; an attempted
      // escape is reported as a policy block, not as a provider verdict.
      if (
        policy.redirect === "manual" &&
        response.status >= 300 &&
        response.status < 400
      ) {
        return {
          state: "invalid-config",
          message: redirectRefusal(providerId),
          latencyMs,
        };
      }
      if (
        response.status === 401 ||
        response.status === 403 ||
        (providerId === "gemini" && response.status === 400)
      ) {
        return {
          state: "auth-invalid",
          message:
            providerId === "gemini"
              ? "Gemini API key is invalid or could not be verified."
              : "Provider rejected the credential (HTTP 401/403).",
          latencyMs,
        };
      }
      if (response.status === 402) {
        return {
          state: "rate-limited",
          message:
            providerId === "gemini"
              ? "Gemini API quota/rate limit reached."
              : "Provider reported insufficient credits or quota (HTTP 402).",
          latencyMs,
        };
      }
      if (response.status === 429) {
        return {
          state: "rate-limited",
          message:
            providerId === "gemini"
              ? "Gemini API quota/rate limit reached."
              : "Provider is rate-limiting requests (HTTP 429).",
          latencyMs,
        };
      }
      if (response.status === 503) {
        return {
          state: "unavailable",
          message:
            providerId === "gemini"
              ? "Gemini is temporarily busy. Try again shortly or select another available model."
              : "Provider is temporarily unavailable (HTTP 503).",
          latencyMs,
        };
      }
      if (!response.ok) {
        return {
          state: "unavailable",
          message:
            providerId === "gemini"
              ? "Could not reach Gemini. Check your network connection."
              : `Provider responded HTTP ${response.status}.`,
          latencyMs,
        };
      }
      // Validate the body actually looks like a model list (or valid /key probe response).
      const body: unknown = await response.json().catch(() => undefined);
      if (probePath === "/key") {
        if (!body || typeof body !== "object") {
          return {
            state: "unavailable",
            message: "Endpoint reachable but did not return a valid response.",
            latencyMs,
          };
        }
      } else {
        const looksLikeModels =
          !!body &&
          typeof body === "object" &&
          (Array.isArray((body as { data?: unknown }).data) ||
            Array.isArray((body as { models?: unknown }).models) ||
            Array.isArray(body));
        if (!looksLikeModels) {
          return {
            state: "unavailable",
            message:
              providerId === "gemini"
                ? "Could not reach Gemini. Check your network connection."
                : "Endpoint reachable but did not return a model list.",
            latencyMs,
          };
        }
      }
      return {
        state: "connected",
        message: providerId === "gemini" ? "Gemini Connected" : "Connected.",
        latencyMs,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Timeout/abort classification; message is secret-free by construction.
      if (/time.?out|abort/i.test(msg)) {
        return {
          state: "unavailable",
          message:
            providerId === "gemini"
              ? "Could not reach Gemini. Check your network connection."
              : "Provider did not respond in time.",
        };
      }
      return {
        state: "unavailable",
        message:
          providerId === "gemini"
            ? "Could not reach Gemini. Check your network connection."
            : `Network error: ${msg}`,
      };
    }
  }

  /**
   * Connection truth for every catalogue provider, in list order.
   *
   * BUG 1 FIX — connection false positive: the previous implementation
   * reported `connected: true` for key-based cloud providers from credential
   * PRESENCE alone. "API key exists" ≠ "provider connected": an unreachable
   * endpoint, a rejected key (401) or a rate limit all presented as
   * "Connected" in the UI. Every provider now reports an honest typed
   * ConnectionState derived ONLY from an actual host-side probe of its OWN
   * authoritative endpoint (per-provider `health.probePath` + effective base
   * URL).
   *
   * Honest states per category:
   *   local providers  → LIVE probe at the provider's OWN endpoint
   *                      (catalogue probePath + effective base URL).
   *   cloud/gateway    → credential presence maps to "configured" (static,
   *                      NO network on panel open) — never "connected". A
   *                      real verdict requires an actual probe, which the
   *                      SELECTED provider gets via connectionState() and
   *                      every provider via provider/test.
   * Selection is irrelevant for the list: every local provider reports its
   * own live truth, so a selected provider can never inherit another
   * provider's verdict. Results are secret-free by construction.
   */
  async listConnectionStates(): Promise<ConnectionStateEntry[]> {
    return Promise.all(
      this.listProviders().map(async (p): Promise<ConnectionStateEntry> => {
        const base = { id: p.id, name: p.displayName };
        const configured = await this.hasCredential(p.id);
        const staticState = (): ConnectionStateEntry => ({
          ...base,
          state: configured ? "configured" : "unverified",
          connected: false,
        });
        if (p.category !== "local") {
          // Cloud/gateway/custom: honest STATIC state for the list. No
          // network on panel open; credential presence is "configured".
          return staticState();
        }
        if (!p.health.supportsTestConnection || !this.effectiveBaseUrl(p.id)) {
          return staticState();
        }
        const result = await this.testConnection(p.id);
        const state: ConnectionState =
          result.state === "invalid-config" ? "unverified" : result.state;
        return {
          ...base,
          state,
          connected: state === "connected",
          ...(result.message !== "Connected." &&
          result.message !== "Gemini Connected"
            ? { detail: result.message }
            : {}),
          ...(result.latencyMs !== undefined
            ? { latencyMs: result.latencyMs }
            : {}),
          checkedAt: new Date().toISOString(),
        };
      }),
    );
  }

  // ------------------------------------------------------------------
  // Inference probe (chat-completions round trip)
  // ------------------------------------------------------------------

  /**
   * Probe a provider with a real bounded chat-completions request.
   *
   * Unlike testConnection (catalogue `/models` reachability), this verifies
   * the full inference path: credentials + endpoint + model + a minimal
   * non-streaming completion with strict response-shape validation. A bare
   * HTTP 2xx is NEVER reported as success — error envelopes, missing
   * choices, reasoning-only payloads, empty content, and non-JSON bodies
   * are all explicit failures. Exactly one request is issued (no retries:
   * auth failures must surface immediately). Never throws; results are
   * secret-free (only the Authorization header's presence is structural,
   * its value never inspected, logged, or returned).
   */
  async testInference(
    providerId: string,
    modelId: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<InferenceProbeResult> {
    const provider = getCatalogProvider(providerId);
    if (!provider || !isSupportedProviderId(providerId)) {
      return { state: "failed", message: "Unsupported provider." };
    }
    if (!modelId || modelId.trim().length === 0) {
      return { state: "failed", message: "Model id is required." };
    }
    const base = this.effectiveBaseUrl(providerId);
    // Local Only FIRST: the refusal is the honest reason no request was made.
    const policy = this.requestPolicy(providerId);
    // Missing credential is also request-free, so the more actionable verdict
    // wins: with no key there is provably nothing to send, in any mode.
    const apiKey = await this.getCredential(providerId);
    if (provider.requiresApiKey && !apiKey) {
      return {
        state: "auth-failed",
        modelId,
        message: "API key required before testing inference.",
      };
    }
    if (!policy.allowed) {
      // Verdict is "blocked", not "failed": nothing was sent, so the provider
      // was never actually tested and the UI must not show it as broken.
      return { state: "blocked", message: policy.reason ?? "Blocked." };
    }
    if (!base) {
      return {
        state: "failed",
        message: "No base URL configured for this provider.",
      };
    }

    const probeUrl = `${base.replace(/\/+$/, "")}/chat/completions`;
    const started = Date.now();
    const timeoutMs = opts?.timeoutMs ?? 8_000;
    let response: Response;
    try {
      const effectiveSignal =
        AbortSignal.any?.([
          AbortSignal.timeout(timeoutMs),
          ...(opts?.signal ? [opts.signal] : []),
        ]) ?? AbortSignal.timeout(timeoutMs);
      response = await fetch(probeUrl, {
        method: "POST",
        signal: effectiveSignal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 16,
        }),
        redirect: policy.redirect,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/abort|cancel/i.test(msg)) {
        return {
          state: "failed",
          modelId,
          message: "Inference probe cancelled.",
        };
      }
      if (/time.?out/i.test(msg)) {
        return {
          state: "failed",
          modelId,
          message: "Provider did not respond in time.",
        };
      }
      return { state: "failed", modelId, message: `Network error: ${msg}` };
    }
    const latencyMs = Date.now() - started;

    // Local Only never follows a redirect off the machine; an attempted
    // escape is a policy block, not a provider verdict.
    if (
      policy.redirect === "manual" &&
      response.status >= 300 &&
      response.status < 400
    ) {
      return {
        state: "blocked",
        modelId,
        message: redirectRefusal(providerId),
        latencyMs,
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        state: "auth-failed",
        modelId,
        message: "Provider rejected the credential (HTTP 401/403).",
        latencyMs,
      };
    }
    if (response.status === 503) {
      return {
        state: "failed",
        modelId,
        message:
          providerId === "gemini"
            ? "Gemini is temporarily busy. Try again shortly or select another available model."
            : "Provider is temporarily unavailable (HTTP 503).",
        latencyMs,
      };
    }
    if (!response.ok) {
      return {
        state: "failed",
        modelId,
        message: `Provider responded HTTP ${response.status}.`,
        latencyMs,
      };
    }

    let body: unknown;
    try {
      const text = await response.text();
      body = JSON.parse(text);
    } catch {
      return {
        state: "failed",
        modelId,
        message: "Provider returned a non-JSON response.",
        latencyMs,
      };
    }
    if (!body || typeof body !== "object") {
      return {
        state: "failed",
        modelId,
        message: "Provider returned a non-JSON response.",
        latencyMs,
      };
    }
    const envelope = body as {
      error?: unknown;
      choices?: unknown;
      content?: unknown;
    };
    if (envelope.error !== undefined) {
      const detail =
        typeof envelope.error === "object" && envelope.error !== null
          ? String(
              (envelope.error as { message?: unknown }).message ??
                JSON.stringify(envelope.error).slice(0, 200),
            )
          : String(envelope.error);
      return {
        state: "failed",
        modelId,
        message: `Provider error: ${detail.slice(0, 200)}`,
        latencyMs,
      };
    }
    if (!Array.isArray(envelope.choices)) {
      // Legacy content-array shape ({ content: [{ text }] }).
      if (Array.isArray(envelope.content)) {
        const first = (envelope.content as Array<{ text?: unknown }>)[0];
        if (
          first &&
          typeof first.text === "string" &&
          first.text.trim().length > 0
        ) {
          return {
            state: "success",
            modelId,
            message: "Model response received.",
            latencyMs,
          };
        }
      }
      return {
        state: "failed",
        modelId,
        message: "Provider returned no completion choices.",
        latencyMs,
      };
    }
    if (envelope.choices.length === 0) {
      return {
        state: "failed",
        modelId,
        message: "Provider returned no completion choices.",
        latencyMs,
      };
    }
    const first = envelope.choices[0] as
      | {
          message?: {
            content?: unknown;
            reasoning_content?: unknown;
            reasoning?: unknown;
          };
          text?: unknown;
        }
      | undefined;
    const message = first?.message;
    const text =
      typeof message?.content === "string"
        ? message.content
        : typeof first?.text === "string"
          ? first.text
          : undefined;
    if (text === undefined) {
      if (
        message &&
        typeof message === "object" &&
        ("reasoning_content" in message || "reasoning" in message)
      ) {
        return {
          state: "failed",
          modelId,
          message: "Provider returned reasoning without message content.",
          latencyMs,
        };
      }
      return {
        state: "failed",
        modelId,
        message: "Provider returned no completion choices.",
        latencyMs,
      };
    }
    if (text.trim().length === 0) {
      return {
        state: "failed",
        modelId,
        message: "Provider returned empty content.",
        latencyMs,
      };
    }
    return {
      state: "success",
      modelId,
      message: "Model response received.",
      latencyMs,
    };
  }

  /**
   * Connection truth for ONE provider — the selected-provider path.
   * Identical derivation to listConnectionStates for a single id.
   */
  async connectionState(providerId: string): Promise<ConnectionStateEntry> {
    const provider = getCatalogProvider(providerId);
    if (!provider) {
      return {
        id: providerId,
        name: providerId,
        state: "unverified",
        connected: false,
      };
    }
    const base = { id: providerId, name: provider.displayName };
    const configured = await this.hasCredential(providerId);
    if (
      !provider.health.supportsTestConnection ||
      !this.effectiveBaseUrl(providerId)
    ) {
      return {
        ...base,
        state: configured ? "configured" : "unverified",
        connected: false,
      };
    }
    const result = await this.testConnection(providerId);
    const state: ConnectionState =
      result.state === "invalid-config" ? "unverified" : result.state;
    return {
      ...base,
      state,
      connected: state === "connected",
      ...(result.message !== "Connected." ? { detail: result.message } : {}),
      ...(result.latencyMs !== undefined
        ? { latencyMs: result.latencyMs }
        : {}),
      checkedAt: new Date().toISOString(),
    };
  }

  // ------------------------------------------------------------------
  // Usage / billing
  // ------------------------------------------------------------------

  /**
   * Usage snapshot. Only OpenRouter has a documented key-authenticated
   * usage endpoint in this catalogue; everything else reports local
   * tracking (or none for local runtimes). Numbers are never invented.
   */
  async getUsage(
    providerId: string,
    _signal?: AbortSignal,
  ): Promise<ProviderUsageSnapshot> {
    const provider = getCatalogProvider(providerId);
    if (!provider || !isSupportedProviderId(providerId)) {
      return { providerId, kind: "none", error: "Unsupported provider." };
    }
    const snapshot: ProviderUsageSnapshot = {
      providerId,
      kind: provider.usage.kind,
      billingPortalUrl: provider.usage.billingPortalUrl,
    };

    // Local Only: refuse BEFORE any probe leaves the machine.
    const policy = this.requestPolicy(providerId);
    if (!policy.allowed) {
      return { ...snapshot, error: policy.reason ?? "Blocked." };
    }

    if (provider.usage.kind !== "provider-api") return snapshot;

    const apiKey = await this.getCredential(providerId);
    if (!apiKey) {
      return {
        ...snapshot,
        error: "API key required to fetch provider usage.",
      };
    }

    return snapshot;
  }
}

// ============================================================================
// Favorites / recently used (globalState — non-secret)
// ============================================================================

const FAVORITES_KEY = "codepilot.providerFavorites.v1";
const RECENT_KEY = "codepilot.providerRecent.v1";
const RECENT_MAX = 8;

export class ProviderPreferenceStore implements vscode.Disposable {
  constructor(private readonly state: vscode.Memento) {}

  dispose(): void {}

  favorites(): string[] {
    const raw = this.state.get<string[]>(FAVORITES_KEY) ?? [];
    return raw.filter((id) => isSupportedProviderId(id));
  }

  toggleFavorite(providerId: string): boolean {
    if (!isSupportedProviderId(providerId)) return false;
    const current = this.favorites();
    const next = current.includes(providerId)
      ? current.filter((id) => id !== providerId)
      : [...current, providerId].slice(0, 20);
    void this.state.update(FAVORITES_KEY, next);
    return next.includes(providerId);
  }

  recent(): string[] {
    const raw = this.state.get<string[]>(RECENT_KEY) ?? [];
    return raw.filter((id) => isSupportedProviderId(id));
  }

  noteUsed(providerId: string): void {
    if (!isSupportedProviderId(providerId)) return;
    const next = [
      providerId,
      ...this.recent().filter((id) => id !== providerId),
    ].slice(0, RECENT_MAX);
    void this.state.update(RECENT_KEY, next);
  }
}
