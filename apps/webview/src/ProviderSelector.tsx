// ============================================================================
// ProviderSelector — searchable provider picker + credentials + usage.
//
// Derives EVERYTHING from the host's provider/catalog payload (the
// CodePilot-owned curated catalogue). No hard-coded provider
// lists here.
//
// Security posture:
//   - API keys are typed once and sent to the host; they are never stored in
//     webview state beyond the single controlled input, never rendered back,
//     and never persisted by the webview (host stores them in SecretStorage).
//   - The webview only ever receives credential PRESENCE (booleans).
//   - Usage numbers come only from the host (real provider API or CodePilot's
//     local ledger). No fabricated data.
// ============================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CatalogProviderLite,
  ProviderHealthLite,
  ProviderStatusLite,
  ProviderUsageLite,
} from "./lib/messages.js";
import { Badge, Button, Card, Field, Input } from "./lib/ui.js";

// ============================================================================
// Status / category presentation
// ============================================================================

const STATUS_LABEL: Record<CatalogProviderLite["status"], string> = {
  SUPPORTED: "Supported",
  CONFIGURABLE: "Configurable",
  GATEWAY: "Gateway",
  LOCAL: "Local",
  SUBSCRIPTION: "Subscription",
  PLANNED: "Planned",
};

const STATUS_TONE: Record<
  CatalogProviderLite["status"],
  "success" | "info" | "neutral" | "warning"
> = {
  SUPPORTED: "success",
  CONFIGURABLE: "info",
  GATEWAY: "info",
  LOCAL: "success",
  SUBSCRIPTION: "warning",
  PLANNED: "neutral",
};

const CATEGORY_LABEL: Record<CatalogProviderLite["category"], string> = {
  cloud: "Cloud",
  local: "Local",
  gateway: "Gateway",
  custom: "Custom",
};

function authStateLabel(
  p: CatalogProviderLite,
  cred: boolean | undefined,
): string {
  if (p.category === "local") return "Local — no key needed";
  if (cred) return "Key configured";
  if (p.requiresApiKey) return "API key required";
  return "Optional key";
}

// ============================================================================
// Provider row
// ============================================================================

interface ProviderRowProps {
  provider: CatalogProviderLite;
  cred?: boolean;
  isFavorite: boolean;
  isSelected: boolean;
  active: boolean; // keyboard-highlighted
  onSelect: () => void;
  onToggleFavorite: () => void;
  registerRef: (el: HTMLButtonElement | null) => void;
}

function ProviderRow({
  provider: p,
  cred,
  isFavorite,
  isSelected,
  active,
  onSelect,
  onToggleFavorite,
  registerRef,
}: ProviderRowProps) {
  return (
    <div
      className="flex items-start gap-2"
      role="option"
      aria-selected={isSelected}
    >
      <button
        ref={registerRef}
        type="button"
        onClick={onSelect}
        title={p.description ?? p.displayName}
        className={`flex-1 min-w-0 text-left rounded px-2.5 py-2 border transition-colors ${
          active
            ? "border-vscode-focusBorder bg-vscode-list-hover"
            : "border-transparent hover:bg-vscode-list-hover"
        } ${isSelected ? "bg-vscode-list-active" : ""}`}
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-vscode-fg truncate">
            {p.displayName}
          </span>
          <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
          {p.category !== "cloud" && (
            <Badge tone="neutral">{CATEGORY_LABEL[p.category]}</Badge>
          )}
          {isFavorite && (
            <span
              aria-label="Favorite"
              title="Favorite"
              className="text-[10px]"
            >
              ★
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-1 min-w-0">
          <span
            aria-hidden
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
              cred
                ? "bg-vscode-testing-run"
                : p.category === "local"
                  ? "bg-vscode-charts-blue"
                  : "bg-vscode-charts-yellow"
            }`}
          />
          <span
            className={`text-[10px] truncate ${
              cred ? "text-vscode-fg" : "text-vscode-desc"
            }`}
          >
            {authStateLabel(p, cred)}
          </span>
        </div>
      </button>
      <button
        type="button"
        onClick={onToggleFavorite}
        aria-pressed={isFavorite}
        aria-label={`${isFavorite ? "Unfavorite" : "Favorite"} ${p.displayName}`}
        title={isFavorite ? "Remove from favorites" : "Add to favorites"}
        className={`mt-1.5 rounded p-1 text-[11px] flex-shrink-0 hover:bg-vscode-list-hover ${
          isFavorite ? "text-vscode-charts-yellow" : "text-vscode-desc"
        }`}
      >
        {isFavorite ? "★" : "☆"}
      </button>
    </div>
  );
}

// ============================================================================
// Credential + config form for the selected provider
// ============================================================================

interface ProviderDetailProps {
  provider: CatalogProviderLite;
  status?: ProviderStatusLite;
  health?: ProviderHealthLite;
  usage?: ProviderUsageLite;
  onSave: (input: {
    providerId: string;
    baseUrl?: string;
    fields?: Record<string, string>;
    apiKey?: string;
    clearApiKey?: boolean;
  }) => void;
  onTest: (providerId: string) => void;
  onFetchUsage: (providerId: string) => void;
  onUseProvider: (providerId: string) => void;
  inUse: boolean;
}

function ProviderDetail({
  provider: p,
  status,
  health,
  usage,
  onSave,
  onTest,
  onFetchUsage,
  onUseProvider,
  inUse,
}: ProviderDetailProps) {
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState(status?.baseUrl ?? p.baseUrl ?? "");
  const [fields, setFields] = useState<Record<string, string>>(
    status?.fields ?? {},
  );

  useEffect(() => {
    setApiKey("");
    setShowKey(false);
    setBaseUrl(status?.baseUrl ?? p.baseUrl ?? "");
    setFields(status?.fields ?? {});
  }, [p.id, status?.baseUrl, status?.fields]);

  const secretFields = p.fields.filter((f) => f.type === "password");
  const plainFields = p.fields.filter((f) => f.type !== "password");
  const localUsage = usage?.local;

  return (
    <Card className="mt-1.5 px-3 py-2.5 space-y-2.5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="text-xs font-medium text-vscode-fg">
            {p.displayName}
          </div>
          {p.description && (
            <div className="text-[10px] text-vscode-desc mt-0.5">
              {p.description}
            </div>
          )}
        </div>
        <Button
          variant={inUse ? "secondary" : "primary"}
          size="sm"
          onClick={() => onUseProvider(p.id)}
          disabled={inUse}
        >
          {inUse ? "Active provider" : "Use provider"}
        </Button>
      </div>

      {/* API key (never rendered back from host) */}
      {p.requiresApiKey && (
        <Field label="API key" htmlFor="prov-key">
          <div className="flex gap-1.5 items-center">
            <Input
              id="prov-key"
              type={showKey ? "text" : "password"}
              value={apiKey}
              placeholder={
                status?.credentialConfigured
                  ? "•••••••• (configured — leave blank to keep)"
                  : "Enter API key"
              }
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
              className="flex-1"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowKey((v) => !v)}
              aria-pressed={showKey}
            >
              {showKey ? "Hide" : "Show"}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                if (apiKey.trim()) {
                  onSave({ providerId: p.id, apiKey: apiKey.trim() });
                  setApiKey("");
                }
              }}
              disabled={!apiKey.trim()}
            >
              Save
            </Button>
            {status?.credentialConfigured && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onSave({ providerId: p.id, clearApiKey: true })}
              >
                Clear
              </Button>
            )}
          </div>
          <p className="text-[9px] text-vscode-desc mt-0.5">
            Stored in VS Code SecretStorage. Never shown again, never logged.
          </p>
        </Field>
      )}

      {/* Base URL */}
      {p.supportsCustomBaseUrl && (
        <Field label="Base URL" htmlFor="prov-baseurl">
          <div className="flex gap-1.5 items-center">
            <Input
              id="prov-baseurl"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://…"
              className="flex-1"
            />
            <Button
              variant="primary"
              size="sm"
              onClick={() => onSave({ providerId: p.id, baseUrl })}
            >
              Save
            </Button>
          </div>
        </Field>
      )}

      {/* Provider-specific non-secret fields */}
      {plainFields.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {plainFields.map((f) => (
            <Field key={f.path} label={f.label} htmlFor={`prov-f-${f.path}`}>
              <Input
                id={`prov-f-${f.path}`}
                value={fields[f.path] ?? ""}
                onChange={(e) =>
                  setFields((prev) => ({ ...prev, [f.path]: e.target.value }))
                }
                placeholder={f.placeholder}
              />
            </Field>
          ))}
          <div>
            <Button
              variant="primary"
              size="sm"
              onClick={() =>
                onSave({
                  providerId: p.id,
                  fields,
                })
              }
            >
              Save settings
            </Button>
          </div>
        </div>
      )}
      {secretFields.length > 0 && (
        <p className="text-[9px] text-vscode-desc">
          This provider uses additional credentials (e.g. AWS keys). Configure
          them via the matching environment variables or a profile — CodePilot
          never stores them outside SecretStorage.
        </p>
      )}

      {/* Connection test */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="secondary" size="sm" onClick={() => onTest(p.id)}>
          Test connection
        </Button>
        {health && (
          <span
            role="status"
            className={`text-[10px] ${
              health.state === "connected"
                ? "text-vscode-testing-run"
                : health.state === "no-endpoint"
                  ? "text-vscode-desc"
                  : "text-vscode-errorForeground"
            }`}
          >
            {health.state === "connected"
              ? `✓ Connected${health.latencyMs ? ` (${health.latencyMs}ms)` : ""}`
              : health.state === "no-endpoint"
                ? "No testable endpoint — run a task to verify"
                : `⚠ ${health.message}`}
          </span>
        )}
      </div>

      {/* Usage / billing */}
      <div className="border-t border-vscode-border pt-2 space-y-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onFetchUsage(p.id)}
          >
            Refresh usage
          </Button>
          {usage?.billingPortalUrl && (
            <a
              href={usage.billingPortalUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[10px] text-vscode-textLink underline"
            >
              Billing portal ↗
            </a>
          )}
        </div>
        {usage?.kind === "none" ? (
          <p className="text-[10px] text-vscode-desc">
            Local usage — no provider API billing.
          </p>
        ) : usage?.usage ? (
          <div className="text-[10px] text-vscode-fg space-y-0.5">
            {usage.usage.usedUsd !== undefined && (
              <div>Used: ${usage.usage.usedUsd.toFixed(4)}</div>
            )}
            {usage.usage.remainingUsd !== undefined && (
              <div>
                Remaining: ${usage.usage.remainingUsd.toFixed(4)}
                {usage.usage.limitUsd !== undefined &&
                  ` of $${usage.usage.limitUsd.toFixed(2)}`}
              </div>
            )}
            <p className="text-[9px] text-vscode-desc">
              Numbers come directly from the provider's usage API.
            </p>
          </div>
        ) : usage?.error ? (
          <p className="text-[10px] text-vscode-errorForeground">
            {usage.error}
          </p>
        ) : usage?.kind === "provider-api" ? (
          <p className="text-[10px] text-vscode-desc">
            Press "Refresh usage" to fetch provider billing data.
          </p>
        ) : (
          <p className="text-[10px] text-vscode-desc">
            Usage information unavailable from this provider. CodePilot tracks
            local token estimates below.
          </p>
        )}
        {localUsage && (
          <p className="text-[10px] text-vscode-desc">
            Local estimate: {localUsage.requests} request
            {localUsage.requests !== 1 ? "s" : ""} ·{" "}
            {localUsage.inputTokens.toLocaleString()} in ·{" "}
            {localUsage.outputTokens.toLocaleString()} out
            {localUsage.estimatedCostUsd > 0 &&
              ` · ≈$${localUsage.estimatedCostUsd.toFixed(4)} (estimate)`}
          </p>
        )}
      </div>
    </Card>
  );
}

// ============================================================================
// Main selector
// ============================================================================

export interface ProviderSelectorProps {
  providers: CatalogProviderLite[];
  statuses: Record<string, ProviderStatusLite>;
  favorites: string[];
  selectedId: string;
  activeProviderId: string;
  health?: ProviderHealthLite;
  usage?: ProviderUsageLite;
  onOpen: (providerId: string) => void;
  onToggleFavorite: (providerId: string) => void;
  onSave: ProviderDetailProps["onSave"];
  onTest: (providerId: string) => void;
  onFetchUsage: (providerId: string) => void;
  onUseProvider: (providerId: string) => void;
}

export function ProviderSelector(props: ProviderSelectorProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<
    CatalogProviderLite["category"] | "all"
  >("all");
  const [openId, setOpenId] = useState<string | null>(
    props.activeProviderId || null,
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return props.providers.filter((p) => {
      if (category !== "all" && p.category !== category) return false;
      if (!q) return true;
      return (
        p.id.toLowerCase().includes(q) ||
        p.displayName.toLowerCase().includes(q) ||
        (p.description?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [props.providers, query, category]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: props.providers.length };
    for (const p of props.providers) c[p.category] = (c[p.category] ?? 0) + 1;
    return c;
  }, [props.providers]);

  useEffect(() => {
    itemRefs.current = itemRefs.current.slice(0, filtered.length);
  }, [filtered.length]);

  const scrollTo = (i: number) => {
    const el = itemRefs.current[i];
    el?.scrollIntoView({ block: "nearest" });
  };

  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const i = Math.min(activeIndex + 1, filtered.length - 1);
      setActiveIndex(i);
      scrollTo(i);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const i = Math.max(activeIndex - 1, 0);
      setActiveIndex(i);
      scrollTo(i);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const p = filtered[activeIndex];
      if (p) props.onOpen(p.id);
    }
  };

  return (
    <Card className="px-3 py-2.5 space-y-2.5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-[10px] font-semibold tracking-wider text-vscode-desc uppercase">
          Model provider · {props.providers.length} available
        </span>
      </div>

      <Input
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIndex(0);
        }}
        onKeyDown={onSearchKeyDown}
        placeholder="Search providers… (↑↓ to navigate, Enter to open)"
        aria-label="Search providers"
        role="combobox"
        aria-expanded="true"
        aria-controls="provider-listbox"
        className="w-full"
      />

      <div
        className="flex gap-1 flex-wrap"
        role="tablist"
        aria-label="Filter by category"
      >
        {(["all", "local", "cloud", "gateway", "custom"] as const).map((c) => (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={category === c}
            onClick={() => {
              setCategory(c);
              setActiveIndex(0);
            }}
            className={`px-2 py-0.5 rounded text-[10px] border ${
              category === c
                ? "border-vscode-focusBorder bg-vscode-list-active text-vscode-fg"
                : "border-vscode-border text-vscode-desc hover:bg-vscode-list-hover"
            }`}
          >
            {c === "all" ? "All" : CATEGORY_LABEL[c]} ({counts[c] ?? 0})
          </button>
        ))}
      </div>

      <div
        ref={listRef}
        id="provider-listbox"
        role="listbox"
        aria-label="Providers"
        className="max-h-64 overflow-y-auto space-y-0.5"
      >
        {filtered.length === 0 ? (
          <p className="text-[10px] text-vscode-desc px-1 py-2">
            No providers match "{query}".
          </p>
        ) : (
          filtered.map((p, i) => (
            <ProviderRow
              key={p.id}
              provider={p}
              cred={props.statuses[p.id]?.credentialConfigured}
              isFavorite={props.favorites.includes(p.id)}
              isSelected={openId === p.id}
              active={i === activeIndex}
              onSelect={() => setOpenId(openId === p.id ? null : p.id)}
              onToggleFavorite={() => props.onToggleFavorite(p.id)}
              registerRef={(el) => {
                itemRefs.current[i] = el;
              }}
            />
          ))
        )}
      </div>

      {(() => {
        const p = props.providers.find((x) => x.id === openId);
        if (!p) return null;
        return (
          <ProviderDetail
            provider={p}
            status={props.statuses[p.id]}
            health={
              props.health?.providerId === p.id ? props.health : undefined
            }
            usage={props.usage?.providerId === p.id ? props.usage : undefined}
            onSave={props.onSave}
            onTest={props.onTest}
            onFetchUsage={props.onFetchUsage}
            onUseProvider={props.onUseProvider}
            inUse={props.activeProviderId === p.id}
          />
        );
      })()}
    </Card>
  );
}
