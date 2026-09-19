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
  type CatalogProvider,
} from "@codepilot/model-gateway";
import { checkNavigationPolicy } from "@codepilot/context-engine";

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
  openai: "codepilot.apiKey.openai",
  "openai-compatible": "codepilot.apiKey.openaiCompatible",
  anthropic: "codepilot.apiKey.anthropic",
  google: "codepilot.apiKey.google",
  bedrock: "codepilot.apiKey.bedrock",
  mistral: "codepilot.apiKey.mistral",
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

  constructor(context: vscode.ExtensionContext) {
    this.secrets = context.secrets;
    this.state = context.globalState;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  // ------------------------------------------------------------------
  // Catalogue
  // ------------------------------------------------------------------

  listProviders(): CatalogProvider[] {
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
    if (!trimmed) return;
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
  ): Promise<HealthResult> {
    const provider = getCatalogProvider(providerId);
    if (!provider) {
      return { state: "invalid-config", message: "Unknown provider." };
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
    const apiKey = await this.getCredential(providerId);
    if (provider.health.requiresApiKeyForProbe && !apiKey) {
      return {
        state: "auth-required",
        message: "API key required before testing this provider.",
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
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const response = await fetch(probeUrl, {
        signal: effectiveSignal,
        headers,
      });
      const latencyMs = Date.now() - started;
      if (response.status === 401 || response.status === 403) {
        return {
          state: "auth-invalid",
          message: "Provider rejected the credential (HTTP 401/403).",
          latencyMs,
        };
      }
      if (response.status === 429) {
        return {
          state: "rate-limited",
          message: "Provider is rate-limiting requests (HTTP 429).",
          latencyMs,
        };
      }
      if (!response.ok) {
        return {
          state: "unavailable",
          message: `Provider responded HTTP ${response.status}.`,
          latencyMs,
        };
      }
      // Validate the body actually looks like a model list.
      const body: unknown = await response.json().catch(() => undefined);
      const looksLikeModels =
        !!body &&
        typeof body === "object" &&
        (Array.isArray((body as { data?: unknown }).data) ||
          Array.isArray((body as { models?: unknown }).models) ||
          Array.isArray(body));
      if (!looksLikeModels) {
        return {
          state: "unavailable",
          message: "Endpoint reachable but did not return a model list.",
          latencyMs,
        };
      }
      return {
        state: "connected",
        message: "Connected.",
        latencyMs,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Timeout/abort classification; message is secret-free by construction.
      if (/time.?out|abort/i.test(msg)) {
        return {
          state: "unavailable",
          message: "Provider did not respond in time.",
        };
      }
      return { state: "unavailable", message: `Network error: ${msg}` };
    }
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
    signal?: AbortSignal,
  ): Promise<ProviderUsageSnapshot> {
    const provider = getCatalogProvider(providerId);
    if (!provider) {
      return { providerId, kind: "none", error: "Unknown provider." };
    }
    const snapshot: ProviderUsageSnapshot = {
      providerId,
      kind: provider.usage.kind,
      billingPortalUrl: provider.usage.billingPortalUrl,
    };
    if (provider.usage.kind !== "provider-api") return snapshot;

    const apiKey = await this.getCredential(providerId);
    if (!apiKey) {
      return {
        ...snapshot,
        error: "API key required to fetch provider usage.",
      };
    }
    // OpenRouter: GET /api/v1/credits — documented usage endpoint.
    if (providerId === "openrouter") {
      const base =
        this.effectiveBaseUrl(providerId) ?? "https://openrouter.ai/api/v1";
      try {
        const effectiveSignal =
          AbortSignal.any?.([
            AbortSignal.timeout(8_000),
            ...(signal ? [signal] : []),
          ]) ?? AbortSignal.timeout(8_000);
        const creditsUrl = new URL("/api/v1/credits", base).toString();
        const response = await fetch(creditsUrl, {
          signal: effectiveSignal,
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!response.ok) {
          return {
            ...snapshot,
            error: `Usage endpoint returned HTTP ${response.status}.`,
          };
        }
        const body = (await response.json()) as {
          data?: {
            total_credits?: number;
            total_usage?: number;
          };
        };
        const totalCredits = body.data?.total_credits;
        const totalUsage = body.data?.total_usage;
        if (typeof totalCredits !== "number") {
          return {
            ...snapshot,
            error: "Usage endpoint returned an unexpected shape.",
          };
        }
        return {
          ...snapshot,
          usage: {
            usedUsd: typeof totalUsage === "number" ? totalUsage : undefined,
            limitUsd: totalCredits,
            remainingUsd:
              typeof totalUsage === "number"
                ? Math.round((totalCredits - totalUsage) * 1e6) / 1e6
                : undefined,
          },
        };
      } catch (err) {
        return {
          ...snapshot,
          error: `Usage fetch failed: ${
            err instanceof Error ? err.message : "network error"
          }`,
        };
      }
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
    return this.state.get<string[]>(FAVORITES_KEY) ?? [];
  }

  toggleFavorite(providerId: string): boolean {
    const current = this.favorites();
    const next = current.includes(providerId)
      ? current.filter((id) => id !== providerId)
      : [...current, providerId].slice(0, 20);
    void this.state.update(FAVORITES_KEY, next);
    return next.includes(providerId);
  }

  recent(): string[] {
    return this.state.get<string[]>(RECENT_KEY) ?? [];
  }

  noteUsed(providerId: string): void {
    const next = [
      providerId,
      ...this.recent().filter((id) => id !== providerId),
    ].slice(0, RECENT_MAX);
    void this.state.update(RECENT_KEY, next);
  }
}
