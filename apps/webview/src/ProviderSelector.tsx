// ============================================================================
// ProviderSelector — Canonical Simple Provider & Model Settings UI
//
// Simple, non-technical interface:
//   - Gemini: Provider selector, Model selector, API key input, Connect button,
//     and clear Connected status. ZERO Base URL. ZERO Advanced Settings.
//   - Ollama: Provider selector, Model selector, Connected status.
//     ZERO Base URL in normal view. Standard local endpoint (http://localhost:11434)
//     used internally. Configurable Base URL only behind "Advanced Settings".
//   - OpenAI / Hosted / Custom: API key + Connected status. Base URL only
//     under "Advanced Settings" where genuinely applicable.
// ============================================================================

import { useEffect, useState } from "react";
import type {
  CatalogProviderLite,
  ProviderHealthLite,
  ProviderStatusLite,
  ProviderUsageLite,
} from "./lib/messages.js";
import { Button, ConfirmCard, Field, Input, Select } from "./lib/ui.js";

export interface ProviderSelectorProps {
  providers: CatalogProviderLite[];
  statuses: Record<string, ProviderStatusLite>;
  favorites?: string[];
  selectedId?: string;
  activeProviderId: string;
  models?: Array<{ id: string; name: string }>;
  modelsLoading?: boolean;
  selectedModelId?: string;
  onModelChange?: (modelId: string) => void;
  health?: ProviderHealthLite;
  usage?: ProviderUsageLite;
  onOpen?: (providerId: string) => void;
  onToggleFavorite?: (providerId: string) => void;
  onSave: (input: {
    providerId: string;
    modelId?: string;
    baseUrl?: string;
    fields?: Record<string, string>;
    apiKey?: string;
    clearApiKey?: boolean;
  }) => void;
  onTest: (providerId: string) => void;
  onFetchUsage?: (providerId: string) => void;
  onUseProvider: (providerId: string) => void;
}

function getDefaultModels(
  providerId?: string,
): Array<{ id: string; name: string }> {
  switch (providerId) {
    case "gemini":
    case "google":
      return [
        { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
        { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
        { id: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview" },
        { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
        { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      ];
    case "ollama":
      return [
        { id: "qwen3:8b", name: "Qwen 3 8B" },
        { id: "qwen2.5-coder:3b", name: "Qwen 2.5 Coder 3B" },
      ];
    case "openai-native":
    case "openai":
      return [
        { id: "gpt-4o", name: "GPT-4o" },
        { id: "gpt-4o-mini", name: "GPT-4o mini" },
      ];
    default:
      return [{ id: "default", name: "Default model" }];
  }
}

export function ProviderSelector(props: ProviderSelectorProps) {
  const currentProviderId =
    props.activeProviderId || props.selectedId || "gemini";
  const activeProvider = props.providers.find(
    (p) => p.id === currentProviderId,
  ) ??
    props.providers[0] ?? {
      id: currentProviderId,
      displayName:
        currentProviderId === "gemini" ? "Google Gemini" : currentProviderId,
      category: "cloud" as const,
      status: "SUPPORTED" as const,
      curated: true,
      requiresApiKey: currentProviderId !== "ollama",
      supportsCustomBaseUrl: currentProviderId === "ollama",
      baseUrl: undefined as string | undefined,
      fields: [],
      models: [],
    };

  const status = props.statuses[activeProvider.id];
  const isGemini =
    activeProvider.id === "gemini" || activeProvider.id === "google";
  const isOllama = activeProvider.id === "ollama";

  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [baseUrl, setBaseUrl] = useState(
    status?.baseUrl ?? activeProvider.baseUrl ?? "",
  );
  const [fields, setFields] = useState<Record<string, string>>(
    status?.fields ?? {},
  );

  // Reset local form inputs when switching active provider to prevent stale fields
  useEffect(() => {
    setApiKey("");
    setShowKey(false);
    setShowAdvanced(false);
    setIsConnecting(false);
    setConfirmingClear(false);
    setBaseUrl(status?.baseUrl ?? activeProvider.baseUrl ?? "");
    setFields(status?.fields ?? {});
  }, [activeProvider.id, status?.baseUrl, status?.fields]);

  useEffect(() => {
    setIsConnecting(false);
  }, [props.health]);

  const plainFields = (activeProvider.fields ?? []).filter(
    (f) => f.type !== "password",
  );

  // Models list for model selector
  const availableModels =
    props.models && props.models.length > 0
      ? props.models
      : getDefaultModels(activeProvider.id);

  // Synchronize model if selected model is not in available models
  useEffect(() => {
    if (availableModels.length > 0 && props.selectedModelId) {
      const exists = availableModels.some(
        (m) => m.id === props.selectedModelId,
      );
      if (!exists && availableModels[0]) {
        props.onModelChange?.(availableModels[0].id);
      }
    }
  }, [availableModels, props.selectedModelId, props.onModelChange]);

  return (
    <div className="space-y-3">
      {/* 1. PROVIDER SELECTOR */}
      <Field label="Provider" htmlFor="provider-select">
        <Select
          id="provider-select"
          data-testid="provider-select"
          value={activeProvider.id}
          onChange={(e) => {
            const nextId = e.target.value;
            props.onUseProvider(nextId);
            props.onOpen?.(nextId);
          }}
          className="w-full font-medium"
        >
          {props.providers.length > 0 ? (
            props.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName} {p.category === "local" ? "(Local)" : ""}
              </option>
            ))
          ) : (
            <>
              <option value="gemini">Google Gemini</option>
              <option value="ollama">Ollama (Local)</option>
              <option value="openai-native">OpenAI</option>
            </>
          )}
        </Select>
      </Field>

      {/* 2. MODEL SELECTOR */}
      <Field label="Model" htmlFor="model-select">
        <Select
          id="model-select"
          data-testid="model-select"
          value={props.selectedModelId ?? availableModels[0]?.id ?? ""}
          onChange={(e) => props.onModelChange?.(e.target.value)}
          className="w-full font-mono"
          disabled={props.modelsLoading}
        >
          {props.modelsLoading ? (
            <option value="">Loading models…</option>
          ) : (
            availableModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name || m.id}
              </option>
            ))
          )}
        </Select>
      </Field>

      {/* 3. GEMINI PROVIDER CONFIGURATION */}
      {isGemini && (
        <div className="space-y-2.5 pt-1 border-t border-vscode-border/50">
          <Field label="Gemini API Key" htmlFor="gemini-api-key">
            <div className="flex gap-1.5 items-center">
              <Input
                id="gemini-api-key"
                data-testid="gemini-api-key"
                type={showKey ? "text" : "password"}
                value={apiKey}
                placeholder={
                  status?.credentialConfigured
                    ? "•••••••••••••••• (configured)"
                    : "Enter Gemini API key"
                }
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
                className="flex-1 font-mono text-[11px]"
              />
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => setShowKey((v) => !v)}
                aria-pressed={showKey}
              >
                {showKey ? "Hide" : "Show"}
              </Button>
              <Button
                variant="primary"
                size="sm"
                type="button"
                data-testid="gemini-connect-btn"
                onClick={() => {
                  if (apiKey.trim() || status?.credentialConfigured) {
                    setIsConnecting(true);
                    props.onSave({
                      providerId: activeProvider.id,
                      modelId: props.selectedModelId,
                      apiKey: apiKey.trim() || undefined,
                    });
                    if (props.activeProviderId !== activeProvider.id) {
                      props.onUseProvider(activeProvider.id);
                    }
                    if (apiKey.trim()) {
                      setApiKey("");
                    }
                  }
                }}
                disabled={
                  isConnecting ||
                  (!apiKey.trim() && !status?.credentialConfigured)
                }
              >
                {isConnecting
                  ? "Connecting…"
                  : props.health?.state === "connected" &&
                      props.activeProviderId === activeProvider.id
                    ? "✓ Connected"
                    : "Connect"}
              </Button>
              {status?.credentialConfigured && !confirmingClear && (
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  data-testid="gemini-clear-btn"
                  onClick={() => setConfirmingClear(true)}
                >
                  Clear
                </Button>
              )}
              {status?.credentialConfigured && confirmingClear && (
                <ConfirmCard
                  title="Remove saved Gemini API key?"
                  detail="The key stays saved until you remove it here. Removing it will disconnect Gemini until you save a new key."
                  confirmLabel="Remove key"
                  onConfirm={() => {
                    setConfirmingClear(false);
                    props.onSave({
                      providerId: activeProvider.id,
                      clearApiKey: true,
                    });
                  }}
                  onCancel={() => setConfirmingClear(false)}
                />
              )}
            </div>
            <p className="text-[9px] text-vscode-desc mt-0.5">
              Stored securely in VS Code SecretStorage. Never shown again, never
              logged.
            </p>
          </Field>

          {/* Gemini Connection Status */}
          <div className="pt-0.5" data-testid="gemini-status">
            {props.health ? (
              props.health.state === "connected" ? (
                <span
                  role="status"
                  className="text-[11px] font-medium text-vscode-testing-run inline-flex items-center gap-1.5"
                >
                  <span className="w-2 h-2 rounded-full bg-vscode-testing-run inline-block" />
                  ✓ Gemini Connected
                </span>
              ) : (
                <span
                  role="status"
                  className="text-[11px] font-medium text-vscode-errorForeground inline-flex items-center gap-1.5"
                >
                  <span>✗</span>{" "}
                  {props.health.message || "Invalid Gemini API key"}
                </span>
              )
            ) : status?.credentialConfigured ? (
              <span
                role="status"
                className="text-[11px] font-medium text-vscode-testing-run inline-flex items-center gap-1.5"
              >
                <span className="w-2 h-2 rounded-full bg-vscode-testing-run inline-block" />
                ✓ Gemini Connected
              </span>
            ) : (
              <span role="status" className="text-[11px] text-vscode-desc">
                Not connected — enter API key and click Connect
              </span>
            )}
          </div>
        </div>
      )}

      {/* 4. OLLAMA PROVIDER CONFIGURATION */}
      {isOllama && (
        <div className="space-y-2.5 pt-1 border-t border-vscode-border/50">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div data-testid="ollama-status">
              {props.health ? (
                props.health.state === "connected" ? (
                  <span
                    role="status"
                    className="text-[11px] font-medium text-vscode-testing-run inline-flex items-center gap-1.5"
                  >
                    <span className="w-2 h-2 rounded-full bg-vscode-testing-run inline-block" />
                    ✓ Ollama Connected
                    {props.health.latencyMs
                      ? ` (${props.health.latencyMs}ms)`
                      : ""}
                  </span>
                ) : (
                  <span
                    role="status"
                    className="text-[11px] font-medium text-vscode-errorForeground inline-flex items-center gap-1.5"
                  >
                    <span>✗</span> Ollama Not Available ({props.health.message})
                  </span>
                )
              ) : (
                <span
                  role="status"
                  className="text-[11px] font-medium text-vscode-testing-run inline-flex items-center gap-1.5"
                >
                  <span className="w-2 h-2 rounded-full bg-vscode-testing-run inline-block" />
                  ✓ Ollama Connected
                </span>
              )}
            </div>

            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => props.onTest("ollama")}
            >
              Test connection
            </Button>
          </div>

          {/* Advanced Settings toggle (hidden by default) */}
          <div className="pt-0.5">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="text-[11px] text-vscode-textLink hover:underline inline-flex items-center gap-1"
              aria-expanded={showAdvanced}
            >
              Advanced Settings {showAdvanced ? "▲" : "▼"}
            </button>

            {showAdvanced && (
              <div className="mt-2 p-2.5 rounded border border-vscode-border bg-vscode-panel/40 space-y-2">
                <Field label="Ollama Base URL" htmlFor="prov-baseurl">
                  <div className="flex gap-1.5 items-center">
                    <Input
                      id="prov-baseurl"
                      data-testid="ollama-baseurl"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      placeholder="http://localhost:11434"
                      className="flex-1 font-mono text-[11px]"
                    />
                    <Button
                      variant="primary"
                      size="sm"
                      type="button"
                      onClick={() =>
                        props.onSave({
                          providerId: "ollama",
                          baseUrl: baseUrl.trim() || "http://localhost:11434",
                        })
                      }
                    >
                      Save URL
                    </Button>
                  </div>
                  <p className="text-[9px] text-vscode-desc mt-0.5">
                    Default: http://localhost:11434. Uses standard local
                    endpoint internally.
                  </p>
                </Field>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 5. OTHER PROVIDERS (OpenAI, Anthropic, Custom, etc.) */}
      {!isGemini && !isOllama && (
        <div className="space-y-2.5 pt-1 border-t border-vscode-border/50">
          {activeProvider.requiresApiKey && (
            <Field
              label={`${activeProvider.displayName} API Key`}
              htmlFor="prov-key"
            >
              <div className="flex gap-1.5 items-center">
                <Input
                  id="prov-key"
                  data-testid="provider-api-key"
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  placeholder={
                    status?.credentialConfigured
                      ? "•••••••••••••••• (configured)"
                      : `Enter ${activeProvider.displayName} API key`
                  }
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                  className="flex-1 font-mono text-[11px]"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  aria-pressed={showKey}
                >
                  {showKey ? "Hide" : "Show"}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  type="button"
                  onClick={() => {
                    if (apiKey.trim() || status?.credentialConfigured) {
                      setIsConnecting(true);
                      props.onSave({
                        providerId: activeProvider.id,
                        modelId: props.selectedModelId,
                        apiKey: apiKey.trim() || undefined,
                      });
                      if (props.activeProviderId !== activeProvider.id) {
                        props.onUseProvider(activeProvider.id);
                      }
                      if (apiKey.trim()) {
                        setApiKey("");
                      }
                    }
                  }}
                  disabled={
                    isConnecting ||
                    (!apiKey.trim() && !status?.credentialConfigured)
                  }
                >
                  {isConnecting
                    ? "Connecting…"
                    : props.health?.state === "connected" &&
                        props.activeProviderId === activeProvider.id
                      ? "✓ Connected"
                      : "Save"}
                </Button>
                {status?.credentialConfigured && !confirmingClear && (
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    data-testid="provider-clear-btn"
                    onClick={() => setConfirmingClear(true)}
                  >
                    Clear
                  </Button>
                )}
                {status?.credentialConfigured && confirmingClear && (
                  <ConfirmCard
                    title={`Remove saved ${activeProvider.displayName} API key?`}
                    detail="The key stays saved until you remove it here. Removing it will disconnect this provider until you save a new key."
                    confirmLabel="Remove key"
                    onConfirm={() => {
                      setConfirmingClear(false);
                      props.onSave({
                        providerId: activeProvider.id,
                        clearApiKey: true,
                      });
                    }}
                    onCancel={() => setConfirmingClear(false)}
                  />
                )}
              </div>
              <p className="text-[9px] text-vscode-desc mt-0.5">
                Stored in VS Code SecretStorage. Never shown again, never
                logged.
              </p>
            </Field>
          )}

          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              {props.health ? (
                <span
                  role="status"
                  className={`text-[11px] font-medium inline-flex items-center gap-1.5 ${
                    props.health.state === "connected"
                      ? "text-vscode-testing-run"
                      : "text-vscode-errorForeground"
                  }`}
                >
                  {props.health.state === "connected" ? (
                    <>
                      <span className="w-2 h-2 rounded-full bg-vscode-testing-run inline-block" />
                      ✓ {activeProvider.displayName} Connected
                      {props.health.latencyMs
                        ? ` (${props.health.latencyMs}ms)`
                        : ""}
                    </>
                  ) : (
                    <>
                      <span>✗</span> {props.health.message}
                    </>
                  )}
                </span>
              ) : status?.credentialConfigured ? (
                <span
                  role="status"
                  className="text-[11px] font-medium text-vscode-testing-run inline-flex items-center gap-1.5"
                >
                  <span className="w-2 h-2 rounded-full bg-vscode-testing-run inline-block" />
                  ✓ {activeProvider.displayName} Connected
                </span>
              ) : null}
            </div>

            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => props.onTest(activeProvider.id)}
            >
              Test connection
            </Button>
          </div>

          {/* Advanced Settings for Custom / OpenAI-compatible endpoint */}
          {(activeProvider.supportsCustomBaseUrl || plainFields.length > 0) && (
            <div className="pt-0.5">
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="text-[11px] text-vscode-textLink hover:underline inline-flex items-center gap-1"
                aria-expanded={showAdvanced}
              >
                Advanced Settings {showAdvanced ? "▲" : "▼"}
              </button>

              {showAdvanced && (
                <div className="mt-2 p-2.5 rounded border border-vscode-border bg-vscode-panel/40 space-y-2">
                  {activeProvider.supportsCustomBaseUrl && (
                    <Field label="Base URL" htmlFor="prov-baseurl">
                      <div className="flex gap-1.5 items-center">
                        <Input
                          id="prov-baseurl"
                          data-testid="custom-baseurl"
                          value={baseUrl}
                          onChange={(e) => setBaseUrl(e.target.value)}
                          placeholder={activeProvider.baseUrl || "https://…"}
                          className="flex-1 font-mono text-[11px]"
                        />
                        <Button
                          variant="primary"
                          size="sm"
                          type="button"
                          onClick={() =>
                            props.onSave({
                              providerId: activeProvider.id,
                              baseUrl,
                            })
                          }
                        >
                          Save URL
                        </Button>
                      </div>
                    </Field>
                  )}

                  {plainFields.length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                      {plainFields.map((f) => (
                        <Field
                          key={f.path}
                          label={f.label}
                          htmlFor={`prov-f-${f.path}`}
                        >
                          <Input
                            id={`prov-f-${f.path}`}
                            value={fields[f.path] ?? ""}
                            onChange={(e) =>
                              setFields((prev) => ({
                                ...prev,
                                [f.path]: e.target.value,
                              }))
                            }
                            placeholder={f.placeholder}
                            className="text-[11px]"
                          />
                        </Field>
                      ))}
                      <div className="sm:col-span-2">
                        <Button
                          variant="primary"
                          size="sm"
                          type="button"
                          onClick={() =>
                            props.onSave({
                              providerId: activeProvider.id,
                              fields,
                            })
                          }
                        >
                          Save settings
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
