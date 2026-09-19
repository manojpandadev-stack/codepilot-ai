// ============================================================================
// Webview message-contract helpers (pure functions, unit-tested)
// ============================================================================

/** Lifecycle of a proposed file change inside the Changes tab. */
export type ChangeStatus =
  "added" | "modified" | "deleted" | "applied" | "rolled_back";

export interface FileChange {
  path: string;
  changeSetId?: string;
  changeId?: string;
  status: ChangeStatus;
  oldContent?: string;
  newContent?: string;
  diff?: string;
}

/** Payload sent back by the extension host for every diff/* request. */
export interface DiffResultPayload {
  changeSetId?: string;
  changeId?: string;
  success?: boolean;
  error?: string;
  applied?: number;
  failed?: number;
  conflicts?: number;
  rejected?: number;
}

export type DiffResultKind =
  "accept" | "reject" | "accept_all" | "reject_all" | "rollback";

const ACTIVE_STATUSES: readonly ChangeStatus[] = [
  "added",
  "modified",
  "deleted",
];

/** True while a change still needs (or allows) user action. */
export function isActiveChange(change: FileChange): boolean {
  return ACTIVE_STATUSES.includes(change.status);
}

/**
 * Count additions/deletions from a unified diff body.
 * Header lines (+++/---) are excluded; hunk headers (@@) count as neither.
 */
export function computeDiffStats(diff: string | undefined): {
  additions: number;
  deletions: number;
} {
  if (!diff) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

/**
 * Reduce the local change list after a diff/* result arrives from the host.
 *
 * Semantics (must match ChangeSetManager):
 * - accept (single): the accepted change becomes "applied" and stays visible
 *   so it can be rolled back; other changes keep waiting for approval.
 * - reject (single): the change disappears (file untouched on disk).
 * - accept_all: every change in the set becomes "applied".
 * - reject_all: every change in the set disappears.
 * - rollback: the change becomes "rolled_back" (re-approvable).
 * - any failure: list is returned unchanged so nothing silently vanishes.
 */
export function applyDiffResult(
  changes: FileChange[],
  kind: DiffResultKind,
  result: DiffResultPayload,
): { changes: FileChange[]; pendingApproval: boolean; error?: string } {
  if (result.success === false) {
    return {
      changes,
      pendingApproval: changes.some(isActiveChange),
      error: result.error ?? "Operation failed",
    };
  }

  const byId = (change: FileChange): boolean =>
    change.changeSetId === result.changeSetId &&
    change.changeId === result.changeId;

  switch (kind) {
    case "accept":
    case "rollback": {
      const nextStatus: ChangeStatus =
        kind === "accept" ? "applied" : "rolled_back";
      const next = changes.map((change) =>
        byId(change) ? { ...change, status: nextStatus } : change,
      );
      return { changes: next, pendingApproval: next.some(isActiveChange) };
    }
    case "reject": {
      const next = changes.filter((change) => !byId(change));
      return { changes: next, pendingApproval: next.some(isActiveChange) };
    }
    case "accept_all": {
      const next = changes.map((change) =>
        change.changeSetId === result.changeSetId
          ? { ...change, status: "applied" as const }
          : change,
      );
      return { changes: next, pendingApproval: false };
    }
    case "reject_all": {
      const next = changes.filter(
        (change) => change.changeSetId !== result.changeSetId,
      );
      return { changes: next, pendingApproval: false };
    }
  }
}

// ============================================================================
// Provider / model discovery payloads
// ============================================================================

/** A model advertised by the active provider (from host "model/list"). */
export interface ModelInfoLite {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
}

/** A provider and its live connection state (from host "provider/list"). */
export interface ProviderInfo {
  id: string;
  name: string;
  connected: boolean;
}

/** Normalize a host payload that may be a bare array or { models }/wrapper. */
export function normalizeModelList(payload: unknown): ModelInfoLite[] {
  const raw = Array.isArray(payload)
    ? payload
    : (payload as { models?: unknown } | null)?.models;
  return Array.isArray(raw) ? (raw as ModelInfoLite[]) : [];
}

/** Normalize a host payload that may be a bare array or { providers } wrapper. */
export function normalizeProviderList(payload: unknown): ProviderInfo[] {
  const raw = Array.isArray(payload)
    ? payload
    : (payload as { providers?: unknown } | null)?.providers;
  return Array.isArray(raw) ? (raw as ProviderInfo[]) : [];
}

// ============================================================================
// Provider catalogue contracts (host "provider/catalog")
// ============================================================================

/** A credential/config field rendered in the provider settings form. */
export interface CatalogFieldLite {
  path: string;
  label: string;
  type: "password" | "text" | "url" | "boolean" | "select";
  required: boolean;
  placeholder?: string;
  description?: string;
}

/** A model entry in a provider's catalogue. */
export interface CatalogModelLite {
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning: boolean;
  vision: boolean;
  tools: boolean;
  inputPerMtok?: number;
  outputPerMtok?: number;
}

/** One catalogue entry — never contains credentials. */
export interface CatalogProviderLite {
  id: string;
  displayName: string;
  description?: string;
  category: "cloud" | "local" | "gateway" | "custom";
  status:
    | "SUPPORTED"
    | "CONFIGURABLE"
    | "GATEWAY"
    | "LOCAL"
    | "SUBSCRIPTION"
    | "PLANNED";
  protocol: string;
  baseUrl?: string;
  supportsCustomBaseUrl: boolean;
  requiresApiKey: boolean;
  supportsLocal: boolean;
  supportsModelDiscovery: boolean;
  supportsToolCalling: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  contextWindow?: number;
  fields: CatalogFieldLite[];
  models: CatalogModelLite[];
  defaultModelId: string;
  usage:
    | { kind: "provider-api"; billingPortalUrl?: string }
    | { kind: "local-tracking"; billingPortalUrl?: string }
    | { kind: "none" };
}

/** Credential presence + non-secret config for one provider. */
export interface ProviderStatusLite {
  providerId: string;
  credentialConfigured: boolean;
  baseUrl?: string;
  fields?: Record<string, string>;
}

/** Result of a host-side connection test. */
export interface ProviderHealthLite {
  providerId: string;
  state:
    | "connected"
    | "auth-required"
    | "auth-invalid"
    | "rate-limited"
    | "unavailable"
    | "invalid-config"
    | "no-endpoint";
  message: string;
  latencyMs?: number;
}

/** Usage/billing snapshot — numbers only when actually sourced. */
export interface ProviderUsageLite {
  providerId: string;
  kind: "provider-api" | "local-tracking" | "none";
  usage?: {
    usedUsd?: number;
    limitUsd?: number;
    remainingUsd?: number;
  };
  /** CodePilot's own recorded usage (estimates, from the usage ledger). */
  local?: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
  billingPortalUrl?: string;
  error?: string;
}

/** Normalize a catalog payload (bare array or { providers } wrapper). */
export function normalizeCatalogProviders(
  payload: unknown,
): CatalogProviderLite[] {
  const raw = Array.isArray(payload)
    ? payload
    : (payload as { providers?: unknown } | null)?.providers;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is CatalogProviderLite =>
      !!p &&
      typeof (p as CatalogProviderLite).id === "string" &&
      typeof (p as CatalogProviderLite).displayName === "string" &&
      Array.isArray((p as CatalogProviderLite).fields) &&
      Array.isArray((p as CatalogProviderLite).models),
  );
}

/** Normalize a provider status payload (single or list). */
export function normalizeProviderStatuses(
  payload: unknown,
): ProviderStatusLite[] {
  if (
    !!payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    typeof (payload as ProviderStatusLite).providerId === "string"
  ) {
    return [payload as ProviderStatusLite];
  }
  const raw = Array.isArray(payload)
    ? payload
    : ((payload as { statuses?: unknown } | null)?.statuses ??
      (payload as { status?: unknown } | null)?.status);
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.filter(
    (s): s is ProviderStatusLite =>
      !!s && typeof (s as ProviderStatusLite).providerId === "string",
  );
}

/**
 * What the host health probe reported for the selected provider.
 * "connected" = the host verified the endpoint/credential live.
 * "unverified" = no health data yet (UI stays neutral — never fakes state).
 * "unavailable" = the host probed and the endpoint is down.
 * "no-credential" = provider requires a key and none is stored.
 */
export type SelectedProviderHealth =
  "connected" | "unverified" | "unavailable" | "no-credential";

export interface ConnectionSummaryInput {
  /** The currently SELECTED provider id (settings.provider). */
  selectedProviderId: string;
  /** Authoritative catalogue entry for the selected provider, if loaded. */
  catalog?: CatalogProviderLite;
  /** Host health probe for the selected provider (undefined = not yet probed). */
  health?: Pick<ProviderHealthLite, "state">;
  /** Credential presence for the selected provider. */
  credentialConfigured?: boolean;
  /** Number of models available for the selected provider. */
  modelCount: number;
}

/**
 * Derive the header connection line from the SELECTED provider's own state.
 *
 * This is provider-scoped by design: the header must reflect ONLY the
 * provider the user selected — never whichever provider happens to be
 * reachable (the old first-connected heuristic showed "LOCAL · Connected"
 * whenever Ollama was up, even with OpenRouter selected).
 */
export function connectionSummary(input: ConnectionSummaryInput): {
  connected: boolean;
  label: string;
} {
  const name = input.catalog?.displayName ?? (input.selectedProviderId || "—");
  const isLocal =
    input.catalog?.category === "local" || input.catalog?.id === "ollama";
  const scope = isLocal ? "LOCAL" : "CLOUD";

  // 1. Hard host verdict wins (live probe).
  if (input.health?.state === "connected") {
    return {
      connected: true,
      label: `${name} · Connected`,
    };
  }
  if (input.health?.state === "unavailable") {
    return {
      connected: false,
      label: isLocal
        ? `${name} unavailable — start ${name} and refresh`
        : `${name} unavailable`,
    };
  }
  if (input.health?.state === "no-endpoint") {
    return { connected: false, label: `${name}: no endpoint configured` };
  }

  // 2. Credential gate — only when we actually know the answer.
  if (
    input.credentialConfigured === false &&
    input.health?.state === "auth-required"
  ) {
    return { connected: false, label: `${name}: API key required` };
  }

  // 3. Live endpoint succeeded but credential is missing → auth required.
  if (input.credentialConfigured === false && input.health) {
    return { connected: false, label: `${name}: API key required` };
  }

  // 4. No probe data yet: neutral, honest state — never guess "connected".
  if (input.health === undefined) {
    return {
      connected: false,
      label: input.credentialConfigured
        ? `${scope} · ${name}`
        : `${scope} · ${name} — not verified`,
    };
  }

  // 5. Probed but not clearly up/down (auth-invalid, rate-limited, …).
  return { connected: false, label: `${name} — check connection` };
}

/**
 * Guard the privacy claim: a cloud provider + "local" privacy mode must
 * NEVER present as "Local only — no data leaves this machine".
 * Returns the header's privacy title, downgrading the claim when the
 * selected provider is remote.
 */
export function privacyClaim(
  privacyMode: string,
  selectedProviderCategory: string | undefined,
): string {
  if (
    privacyMode === "local" &&
    selectedProviderCategory &&
    selectedProviderCategory !== "local"
  ) {
    return (
      "Privacy mode is set to Local, but the selected provider is remote — " +
      "requests WILL leave this machine. Switch to a local provider or " +
      "change privacy mode."
    );
  }
  if (privacyMode === "cloud") {
    return "Cloud mode — requests go to the configured API provider";
  }
  if (privacyMode === "hybrid") {
    return "Hybrid mode — cloud used only for selected tasks";
  }
  return "Local only — no data leaves this machine";
}

// ============================================================================
// Slash commands
// ============================================================================

export interface SlashCommand {
  command: string;
  args: string;
  /** The prompt text forwarded to the agent (empty for UI-only commands). */
  prompt: string;
  /** Resolved instruction prefix (template commands only). */
  instruction: string;
}

export interface SlashCommandDef {
  command: string;
  /** Mode the command forces (undefined = keep current mode). */
  mode?: "plan" | "act" | "ask" | "auto" | "review";
  /** Prompt prefix that makes the command a real agent operation. */
  instruction?: string;
  /** UI-only commands (no agent call). */
  uiOnly?: boolean;
  description: string;
}

/**
 * Every slash command maps to a real CodePilot operation. Mode commands switch
 * the agent mode; template commands prefix the user's input with a task
 * instruction; UI-only commands (clear/help) act locally in the webview.
 * No fake commands.
 */
export const SLASH_COMMANDS: readonly SlashCommandDef[] = [
  {
    command: "plan",
    mode: "plan",
    description: "Plan mode — analyze without modifying files",
  },
  {
    command: "act",
    mode: "act",
    description: "Act mode — implement with ChangeSet approval",
  },
  { command: "ask", mode: "ask", description: "Ask mode — read-only Q&A" },
  {
    command: "auto",
    mode: "auto",
    description: "Auto mode — decide and act under policy",
  },
  {
    command: "review",
    mode: "review",
    description: "Review mode — analyze bugs/security/perf",
  },
  {
    command: "explain",
    mode: "ask",
    instruction: "Explain the following:\n",
    description: "Explain code or concepts",
  },
  {
    command: "fix",
    mode: "act",
    instruction: "Fix the following issue:\n",
    description: "Fix a bug or issue",
  },
  {
    command: "test",
    mode: "act",
    instruction: "Write or run tests for:\n",
    description: "Generate or run tests",
  },
  {
    command: "refactor",
    mode: "act",
    instruction: "Refactor the following:\n",
    description: "Refactor code",
  },
  {
    command: "docs",
    mode: "ask",
    instruction: "Write documentation for:\n",
    description: "Add documentation",
  },
  {
    command: "search",
    mode: "ask",
    instruction: "Search the repository for:\n",
    description: "Search the codebase",
  },
  {
    command: "compact",
    mode: "ask",
    instruction:
      "Compactly summarize the current task, decisions, pending file changes, and unresolved issues for continuation:\n",
    description: "Produce a continuation brief",
  },
  {
    command: "agents",
    mode: "act",
    instruction: "Multi-agent pipeline: ",
    description:
      "Run via the multi-agent pipeline (planner → coder → tester → reviewer)",
  },
  { command: "clear", uiOnly: true, description: "Clear this conversation" },
  { command: "help", uiOnly: true, description: "Show available commands" },
];

const KNOWN_COMMANDS = new Set(SLASH_COMMANDS.map((c) => c.command));

/**
 * Parse a leading /command in chat input.
 * Unknown or non-slash input yields command === "" and prompt === input.
 */
export function parseSlashCommand(rawInput: string): SlashCommand {
  const input = rawInput.trim();
  const match = input.match(/^\/(\w+)\s*(.*)$/);
  if (!match || !KNOWN_COMMANDS.has(match[1]!.toLowerCase())) {
    return { command: "", args: "", prompt: input, instruction: "" };
  }
  const command = match[1]!.toLowerCase();
  const args = (match[2] ?? "").trim();
  const def = SLASH_COMMANDS.find((c) => c.command === command);
  return {
    command,
    args,
    prompt: args,
    instruction: def?.instruction ?? "",
  };
}

/** Slash commands matching the given prefix (for the / autocomplete menu). */
export function filterSlashCommands(prefix: string): SlashCommandDef[] {
  const q = prefix.trim().toLowerCase();
  if (!q) return [...SLASH_COMMANDS];
  return SLASH_COMMANDS.filter((c) => c.command.startsWith(q));
}

// ============================================================================
// Tool registry
// ============================================================================

export type ToolSource = "builtin" | "mcp";
export type ToolPermissionLevel = "auto" | "approval" | "blocked";

export interface ToolRegistryEntry {
  name: string;
  category: string;
  description: string;
  source: ToolSource;
  serverName?: string;
  permission: ToolPermissionLevel;
  /**
   * Exact native callable tool name, or null when the row is
   * policy-coverage-only (capability reached through another tool — see
   * the description). Absent on older payloads.
   */
  callableName?: string | null;
}

// ============================================================================
// Composer context (chips + structured metadata — never part of user text)
// ============================================================================

export type ComposerChipKind =
  "file" | "folder" | "url" | "problems" | "selection";

/** A single removable chip shown above the composer textarea. */
export interface ComposerChip {
  id: string;
  kind: ComposerChipKind;
  label: string;
  /** For files/folders: workspace-relative path. For urls: the URL. */
  ref?: string;
}

let chipIdCounter = 0;

function nextChipId(kind: ComposerChipKind): string {
  chipIdCounter += 1;
  return `${kind}-${Date.now().toString(36)}-${chipIdCounter}`;
}

type ComposerCtx = import("@codepilot/shared").ComposerContext;

export function createEmptyComposerContext(): ComposerCtx {
  return {
    files: [],
    folders: [],
    urls: [],
    diagnostics: null,
    selection: null,
  };
}

export function addFileEntriesToContext(
  ctx: ComposerCtx,
  files: Array<{
    relativePath: string;
    name?: string;
    sizeBytes?: number;
    isBinary?: boolean;
  }>,
): ComposerCtx {
  const next = [...ctx.files];
  for (const f of files) {
    const rel = (f.relativePath ?? "").replace(/\\/g, "/");
    if (!rel) continue;
    // Dedupe by relative path — selecting an already-attached file is a no-op.
    if (next.some((existing) => existing.relativePath === rel)) continue;
    next.push({
      id: nextChipId("file"),
      relativePath: rel,
      name: f.name ?? rel.split("/").pop() ?? rel,
      sizeBytes: f.sizeBytes,
      isBinary: f.isBinary,
    });
  }
  return { ...ctx, files: next };
}

export function addFolderEntriesToContext(
  ctx: ComposerCtx,
  folders: Array<{ relativePath: string; name?: string }>,
): ComposerCtx {
  const next = [...ctx.folders];
  for (const f of folders) {
    const rel = (f.relativePath ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (!rel) continue;
    if (next.some((existing) => existing.relativePath === rel)) continue;
    next.push({
      id: nextChipId("folder"),
      relativePath: rel,
      name: f.name ?? rel.split("/").pop() ?? rel,
    });
  }
  return { ...ctx, folders: next };
}

export function addUrlToContext(ctx: ComposerCtx, url: string): ComposerCtx {
  const trimmed = url.trim();
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) return ctx;
  if (ctx.urls.some((u) => u.url === trimmed)) return ctx;
  return {
    ...ctx,
    urls: [...ctx.urls, { id: nextChipId("url"), url: trimmed }],
  };
}

export function setProblemsInContext(
  ctx: ComposerCtx,
  diagnostics: import("@codepilot/shared").DiagnosticsContextPayload | null,
): ComposerCtx {
  return { ...ctx, diagnostics };
}

export function setSelectionInContext(
  ctx: ComposerCtx,
  selection: import("@codepilot/shared").SelectionContextPayload | null,
): ComposerCtx {
  return { ...ctx, selection };
}

/** Removing any chip must never touch the user's message text. */
export function removeContextEntry(ctx: ComposerCtx, id: string): ComposerCtx {
  return {
    files: ctx.files.filter((f) => f.id !== id),
    folders: ctx.folders.filter((f) => f.id !== id),
    urls: ctx.urls.filter((u) => u.id !== id),
    diagnostics: id === "problems" ? null : (ctx.diagnostics ?? null),
    selection: id === "selection" ? null : (ctx.selection ?? null),
  };
}

export function hasAnyContext(ctx: ComposerCtx): boolean {
  return (
    ctx.files.length > 0 ||
    ctx.folders.length > 0 ||
    ctx.urls.length > 0 ||
    !!ctx.diagnostics ||
    !!ctx.selection
  );
}

/** Derive the chip list rendered above the textarea. */
export function contextToChips(ctx: ComposerCtx): ComposerChip[] {
  const chips: ComposerChip[] = [];
  for (const f of ctx.files)
    chips.push({
      id: f.id,
      kind: "file",
      label: `📄 ${f.name}`,
      ref: f.relativePath,
    });
  for (const fo of ctx.folders)
    chips.push({
      id: fo.id,
      kind: "folder",
      label: `📁 ${fo.name}`,
      ref: fo.relativePath,
    });
  for (const u of ctx.urls) {
    chips.push({
      id: u.id,
      kind: "url",
      label: `🔗 ${u.url.length > 40 ? u.url.slice(0, 37) + "…" : u.url}`,
      ref: u.url,
    });
  }
  if (ctx.diagnostics) {
    const n = ctx.diagnostics.items.length;
    chips.push({
      id: "problems",
      kind: "problems",
      label: n === 0 ? "✓ Problems: 0" : `⚠ Problems (${n})`,
    });
  }
  if (ctx.selection) {
    const lines =
      ctx.selection.startLine === ctx.selection.endLine
        ? `${ctx.selection.startLine}`
        : `${ctx.selection.startLine}–${ctx.selection.endLine}`;
    const name =
      ctx.selection.filePath.split("/").pop() ?? ctx.selection.filePath;
    chips.push({
      id: "selection",
      kind: "selection",
      label: `📝 Selection: ${name} L${lines}`,
    });
  }
  return chips;
}

/** Short summary used when several items are attached ("3 items selected"). */
export function contextSummaryLabel(ctx: ComposerCtx): string | null {
  const count = ctx.files.length + ctx.folders.length;
  if (count >= 2) return `${count} items selected`;
  return null;
}

/**
 * Build the chat/send payload. The user's visible text stays untouched —
 * context travels as structured metadata in a separate field.
 */
export function buildChatSendPayload(
  text: string,
  mode: string,
  ctx: ComposerCtx,
  requestId?: string,
): {
  text: string;
  mode: string;
  context: Partial<ComposerCtx>;
  requestId?: string;
} {
  const context: Record<string, unknown> = {};
  if (ctx.files.length > 0) context.files = ctx.files;
  if (ctx.folders.length > 0) context.folders = ctx.folders;
  if (ctx.urls.length > 0) context.urls = ctx.urls;
  if (ctx.diagnostics) context.diagnostics = ctx.diagnostics;
  if (ctx.selection) context.selection = ctx.selection;
  return requestId
    ? { text, mode, context, requestId }
    : { text, mode, context };
}

/**
 * Mint a unique request ID for one chat turn. The host adopts this ID and
 * stamps every streamed event with it, so the webview can ignore events from
 * stale/aborted turns (requirement: request-ID correlation).
 */
export function createRequestId(): string {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Apply a host context/result payload to the composer context.
 * Error payloads are ignored (canceling a picker is not a failure).
 */
export function applyContextResult(
  ctx: ComposerCtx,
  result: import("@codepilot/shared").ContextResultPayload,
): ComposerCtx {
  if (!result || result.error) return ctx;
  let next = ctx;
  if (result.kind === "filePicker" && result.files && result.files.length > 0) {
    next = addFileEntriesToContext(next, result.files);
  }
  if (
    result.kind === "folderPicker" &&
    result.folders &&
    result.folders.length > 0
  ) {
    next = addFolderEntriesToContext(next, result.folders);
  }
  if (result.kind === "problems" && result.diagnostics) {
    next = setProblemsInContext(next, result.diagnostics);
  }
  if (result.kind === "selection" && result.selection) {
    next = setSelectionInContext(next, result.selection);
  }
  return next;
}

/** Retry rebuilds the request from the original prompt text only — never re-attaches stale context. */
export function buildRetryPayload(lastPrompt: string): { text: string } {
  return { text: lastPrompt };
}

/** Enter sends exactly once; Shift+Enter inserts a newline instead. */
export function shouldSendOnKeydown(key: string, shiftKey: boolean): boolean {
  return key === "Enter" && !shiftKey;
}

// ============================================================================
// Self-healing status reducer (single status component, no duplicates)
// ============================================================================

export interface HealingStatusState {
  active: boolean;
  attempt: number;
  maxAttempts: number;
  phase: string;
  message: string;
  success: boolean;
  /** Failure detail excerpt (exit code / stderr) for transparency. */
  failureDetail?: string;
}

export type HealingUiEvent =
  | {
      kind: "started";
      attempt: number;
      maxAttempts: number;
      exitCode?: number;
      stderrExcerpt?: string;
      command?: string;
    }
  | { kind: "progress"; phase: string; attempt: number; message?: string }
  | { kind: "succeeded"; attempt: number; durationMs?: number }
  | { kind: "failed"; message: string }
  | { kind: "exhausted"; maxAttempts: number };

/**
 * Reduce healing events into ONE status object. Every event mutates this
 * single state — events never append duplicate status messages.
 */
export function reduceHealingState(
  prev: HealingStatusState | null,
  event: HealingUiEvent,
): HealingStatusState {
  switch (event.kind) {
    case "started":
      return {
        active: true,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        phase: "validation_failed",
        message: "Self-healing started",
        success: false,
        failureDetail:
          [
            event.exitCode !== undefined ? `exit code ${event.exitCode}` : "",
            event.command ? `command: ${event.command}` : "",
            event.stderrExcerpt
              ? `output: ${event.stderrExcerpt.slice(0, 300)}`
              : "",
          ]
            .filter(Boolean)
            .join(" · ") || undefined,
      };
    case "progress": {
      const base = prev ?? {
        active: true,
        attempt: event.attempt,
        maxAttempts: 3,
        phase: event.phase,
        message: "",
        success: false,
      };
      return {
        ...base,
        active: true,
        attempt: event.attempt || base.attempt,
        phase: event.phase,
        message: event.message ?? base.message,
        success: false,
      };
    }
    case "succeeded":
      return {
        ...(prev ?? {
          attempt: event.attempt,
          maxAttempts: event.attempt,
          phase: "healing_succeeded",
          message: "",
          success: false,
        }),
        active: false,
        attempt: event.attempt,
        success: true,
        message: `Healed after ${event.attempt} attempt${event.attempt === 1 ? "" : "s"}${event.durationMs != null ? ` (${event.durationMs}ms)` : ""}`,
      };
    case "failed":
      return {
        ...(prev ?? {
          attempt: 1,
          maxAttempts: 3,
          phase: "repair_failed",
          message: "",
          success: false,
        }),
        active: false,
        success: false,
        message: event.message,
      };
    case "exhausted":
      return {
        ...(prev ?? {
          attempt: event.maxAttempts,
          maxAttempts: event.maxAttempts,
          phase: "healing_exhausted",
          message: "",
          success: false,
        }),
        active: false,
        success: false,
        message: `Self-healing exhausted after ${event.maxAttempts} attempt${event.maxAttempts === 1 ? "" : "s"} — manual intervention needed`,
      };
  }
}

/**
 * Normalize a tools/list_result payload. Accepts { tools } or a bare array;
 * drops malformed entries instead of rendering fake rows.
 */
export function normalizeToolList(payload: unknown): ToolRegistryEntry[] {
  const raw = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === "object" &&
        Array.isArray((payload as { tools?: unknown }).tools)
      ? (payload as { tools: unknown[] }).tools
      : [];
  const result: ToolRegistryEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const t = item as Record<string, unknown>;
    if (typeof t.name !== "string" || t.name === "") continue;
    const permission =
      t.permission === "auto" || t.permission === "blocked"
        ? t.permission
        : "approval";
    result.push({
      name: t.name,
      category: typeof t.category === "string" ? t.category : "system",
      description: typeof t.description === "string" ? t.description : "",
      source: t.source === "mcp" ? "mcp" : "builtin",
      serverName: typeof t.serverName === "string" ? t.serverName : undefined,
      permission,
      callableName:
        typeof t.callableName === "string" && t.callableName !== ""
          ? t.callableName
          : t.callableName === null
            ? null
            : undefined,
    });
  }
  return result;
}

// ============================================================================
// Plugin management (M15)
// ============================================================================

/** UI trust badge — mirrors the backend PluginDisplayTrust exactly. */
export type PluginDisplayTrust =
  "trusted" | "verified" | "community" | "untrusted" | "blocked";

export interface PluginCapabilityView {
  capability: string;
  permissionLevel: string;
  requiresApproval: boolean;
  sensitive: boolean;
}

export interface PluginToolView {
  name: string;
  description: string;
  registryId: string;
  registered: boolean;
  permissionLevel: string;
  requiresApproval: boolean;
}

export interface PluginView {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  apiVersion: string;
  trustLevel: string;
  displayTrust: PluginDisplayTrust;
  verified: boolean;
  installed: boolean;
  enabled: boolean;
  discovered: boolean;
  capabilities: PluginCapabilityView[];
  tools: PluginToolView[];
  warnings: string[];
  errors: string[];
  installedAtMs?: number;
}

export interface PluginManifestProblem {
  dir: string;
  error: string;
}

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/** Validate an outbound plugin action before it is posted to the host. */
export function validatePluginAction(
  action: string,
  payload: unknown,
): { ok: boolean; error?: string } {
  const validActions = new Set([
    "plugins/list",
    "plugins/install",
    "plugins/uninstall",
    "plugins/details",
    "plugins/invoke",
    "plugins/activate",
    "plugins/deactivate",
  ]);
  if (!validActions.has(action))
    return { ok: false, error: `unknown plugin action: ${action}` };
  if (action === "plugins/list") return { ok: true };
  const p = (payload ?? {}) as Record<string, unknown>;
  if (!PLUGIN_ID_PATTERN.test(String(p.id ?? ""))) {
    return { ok: false, error: "invalid plugin id" };
  }
  if (action === "plugins/invoke") {
    if (
      typeof p.tool !== "string" ||
      p.tool.length === 0 ||
      p.tool.length > 64
    ) {
      return { ok: false, error: "invalid tool name" };
    }
    if (
      p.args !== undefined &&
      (typeof p.args !== "object" || p.args === null)
    ) {
      return { ok: false, error: "args must be a JSON object" };
    }
  }
  return { ok: true };
}

/** Normalize a plugins/list_result payload; drops malformed rows (never renders fake rows). */
export function normalizePluginList(payload: unknown): {
  plugins: PluginView[];
  malformed: PluginManifestProblem[];
} {
  const empty = {
    plugins: [] as PluginView[],
    malformed: [] as PluginManifestProblem[],
  };
  if (!payload || typeof payload !== "object") return empty;
  const p = payload as { plugins?: unknown; malformed?: unknown };
  const plugins: PluginView[] = [];
  if (Array.isArray(p.plugins)) {
    for (const item of p.plugins) {
      const v = normalizePluginView(item);
      if (v) plugins.push(v);
    }
  }
  const malformed: PluginManifestProblem[] = [];
  if (Array.isArray(p.malformed)) {
    for (const item of p.malformed) {
      if (item && typeof item === "object") {
        const m = item as Record<string, unknown>;
        if (typeof m.error === "string") {
          malformed.push({
            dir: typeof m.dir === "string" ? m.dir : "",
            error: m.error.slice(0, 500),
          });
        }
      }
    }
  }
  return { plugins, malformed };
}

/** Normalize one plugin view row; null when the row is unusable. */
export function normalizePluginView(item: unknown): PluginView | null {
  if (!item || typeof item !== "object") return null;
  const t = item as Record<string, unknown>;
  if (!PLUGIN_ID_PATTERN.test(String(t.id ?? ""))) return null;
  const trusts: PluginDisplayTrust[] = [
    "trusted",
    "verified",
    "community",
    "untrusted",
    "blocked",
  ];
  const displayTrust = trusts.includes(t.displayTrust as PluginDisplayTrust)
    ? (t.displayTrust as PluginDisplayTrust)
    : "untrusted";
  const caps = Array.isArray(t.capabilities)
    ? (t.capabilities as unknown[]).flatMap((c) => {
        if (!c || typeof c !== "object") return [];
        const cc = c as Record<string, unknown>;
        if (typeof cc.capability !== "string") return [];
        return [
          {
            capability: cc.capability.slice(0, 64),
            permissionLevel:
              typeof cc.permissionLevel === "string"
                ? cc.permissionLevel.slice(0, 32)
                : "read",
            requiresApproval: cc.requiresApproval === true,
            sensitive: cc.sensitive === true,
          },
        ];
      })
    : [];
  const tools = Array.isArray(t.tools)
    ? (t.tools as unknown[]).flatMap((x) => {
        if (!x || typeof x !== "object") return [];
        const xt = x as Record<string, unknown>;
        if (typeof xt.name !== "string" || xt.name === "") return [];
        return [
          {
            name: xt.name.slice(0, 64),
            description:
              typeof xt.description === "string"
                ? xt.description.slice(0, 300)
                : "",
            registryId:
              typeof xt.registryId === "string"
                ? xt.registryId.slice(0, 128)
                : "",
            registered: xt.registered === true,
            permissionLevel:
              typeof xt.permissionLevel === "string"
                ? xt.permissionLevel.slice(0, 32)
                : "read",
            requiresApproval: xt.requiresApproval === true,
          },
        ];
      })
    : [];
  return {
    id: String(t.id),
    name: typeof t.name === "string" ? t.name.slice(0, 100) : String(t.id),
    description:
      typeof t.description === "string" ? t.description.slice(0, 500) : "",
    version: typeof t.version === "string" ? t.version.slice(0, 32) : "",
    author: typeof t.author === "string" ? t.author.slice(0, 100) : "",
    apiVersion:
      typeof t.apiVersion === "string" ? t.apiVersion.slice(0, 32) : "",
    trustLevel:
      typeof t.trustLevel === "string"
        ? t.trustLevel.slice(0, 32)
        : "community",
    displayTrust,
    verified: t.verified === true,
    installed: t.installed === true,
    enabled: t.enabled === true,
    discovered: t.discovered !== false,
    capabilities: caps,
    tools,
    warnings: Array.isArray(t.warnings)
      ? (t.warnings as unknown[])
          .filter((w): w is string => typeof w === "string")
          .map((w) => w.slice(0, 500))
      : [],
    errors: Array.isArray(t.errors)
      ? (t.errors as unknown[])
          .filter((e): e is string => typeof e === "string")
          .map((e) => e.slice(0, 500))
      : [],
  };
}

/** Normalize a plugins/details_result payload. */
export function normalizePluginDetails(payload: unknown): PluginView | null {
  if (!payload || typeof payload !== "object") return null;
  return normalizePluginView((payload as { plugin?: unknown }).plugin);
}

/** Badge metadata for the trust indicator. */
export function pluginTrustMeta(trust: PluginDisplayTrust): {
  label: string;
  tone: string;
} {
  switch (trust) {
    case "trusted":
      return { label: "TRUSTED", tone: "green" };
    case "verified":
      return { label: "VERIFIED", tone: "blue" };
    case "community":
      return { label: "COMMUNITY", tone: "yellow" };
    case "untrusted":
      return { label: "UNTRUSTED", tone: "orange" };
    case "blocked":
      return { label: "BLOCKED", tone: "red" };
  }
}

/** Installed plugins (backend-installed), sorted by id. */
export function selectInstalledPlugins(plugins: PluginView[]): PluginView[] {
  return plugins
    .filter((p) => p.installed)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Discoverable but not installed. */
export function selectAvailablePlugins(plugins: PluginView[]): PluginView[] {
  return plugins
    .filter((p) => !p.installed && p.discovered)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Filter by free text (id/name/description/capability) + trust badge. */
export function filterPlugins(
  plugins: PluginView[],
  query: string,
  trust: "all" | PluginDisplayTrust,
): PluginView[] {
  const q = query.trim().toLowerCase();
  return plugins.filter((p) => {
    if (trust !== "all" && p.displayTrust !== trust) return false;
    if (!q) return true;
    const hay =
      `${p.id} ${p.name} ${p.description} ${p.capabilities.map((c) => c.capability).join(" ")}`.toLowerCase();
    return hay.includes(q);
  });
}

// ============================================================================
// Multi-agent teams (M14)
// ============================================================================

export type TeamStatus =
  "idle" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export type TeamTaskStatus =
  | "pending"
  | "running"
  | "waiting"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "retrying";

export interface TeamTaskView {
  taskId: string;
  role: string;
  roleLabel: string;
  description: string;
  dependencies: string[];
  dependents: string[];
  level: number;
  status: TeamTaskStatus;
  retryCount: number;
  maxRetries: number;
  startedAtMs?: number;
  completedAtMs?: number;
  files: string[];
  conflictWith?: string;
  error?: string;
  resultExcerpt?: string;
}

export interface TeamLockView {
  file: string;
  holderTaskId: string;
  holderRole: string;
  acquiredAtMs: number;
}

export interface TeamView {
  teamId: string;
  taskId: string;
  objective: string;
  mode: string;
  status: TeamStatus;
  roles: string[];
  maxConcurrency: number;
  tasks: TeamTaskView[];
  locks: TeamLockView[];
  runId?: string;
  runCount: number;
  createdAtMs: number;
  updatedAtMs: number;
  completedCount: number;
  failedCount: number;
  error?: string;
}

export const TEAM_ID_PATTERN = /^team-[0-9]+-[a-z0-9]+$/;
export const TEAM_RUN_ID_PATTERN = /^run-[0-9]+-[a-z0-9]+$/;

const TEAM_TASK_STATUSES: readonly string[] = [
  "pending",
  "running",
  "waiting",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "retrying",
];

const TEAM_STATUSES: readonly string[] = [
  "idle",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

/** Validate an outbound team action before posting to the host. */
export function validateTeamAction(
  action: string,
  payload: unknown,
): { ok: boolean; error?: string } {
  const validActions = new Set([
    "team/create",
    "team/start",
    "team/cancel",
    "team/retry",
    "team/remove",
    "team/list",
    "team/details",
  ]);
  if (!validActions.has(action))
    return { ok: false, error: `unknown team action: ${action}` };
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (action) {
    case "team/list":
      return { ok: true };
    case "team/create": {
      if (typeof p.objective !== "string" || p.objective.trim().length === 0) {
        return { ok: false, error: "objective is required" };
      }
      if (p.objective.length > 2000)
        return { ok: false, error: "objective too long" };
      if (p.roles !== undefined) {
        if (
          !Array.isArray(p.roles) ||
          p.roles.length === 0 ||
          p.roles.length > 6
        ) {
          return { ok: false, error: "roles must be 1-6 entries" };
        }
        for (const r of p.roles) {
          if (typeof r !== "string" || r.length === 0 || r.length > 32) {
            return { ok: false, error: `invalid role: ${String(r)}` };
          }
        }
      }
      if (p.maxConcurrency !== undefined) {
        if (
          typeof p.maxConcurrency !== "number" ||
          !Number.isInteger(p.maxConcurrency) ||
          p.maxConcurrency < 1 ||
          p.maxConcurrency > 4
        ) {
          return { ok: false, error: "maxConcurrency must be an integer 1-4" };
        }
      }
      if (
        p.mode !== undefined &&
        p.mode !== "plan" &&
        p.mode !== "act" &&
        p.mode !== "review"
      ) {
        return { ok: false, error: "mode must be plan | act | review" };
      }
      return { ok: true };
    }
    case "team/start":
      if (!TEAM_ID_PATTERN.test(String(p.teamId ?? "")))
        return { ok: false, error: "invalid team id" };
      if (
        p.mode !== undefined &&
        p.mode !== "plan" &&
        p.mode !== "act" &&
        p.mode !== "review"
      ) {
        return { ok: false, error: "mode must be plan | act | review" };
      }
      return { ok: true };
    case "team/cancel":
      if (!TEAM_ID_PATTERN.test(String(p.teamId ?? "")))
        return { ok: false, error: "invalid team id" };
      if (p.runId !== undefined && !TEAM_RUN_ID_PATTERN.test(String(p.runId))) {
        return { ok: false, error: "invalid run id" };
      }
      return { ok: true };
    case "team/retry":
    case "team/remove":
    case "team/details":
      if (!TEAM_ID_PATTERN.test(String(p.teamId ?? "")))
        return { ok: false, error: "invalid team id" };
      return { ok: true };
    default:
      return { ok: false, error: "unknown team action" };
  }
}

/** Normalize one team task row; null when unusable (never renders fake rows). */
export function normalizeTeamTask(item: unknown): TeamTaskView | null {
  if (!item || typeof item !== "object") return null;
  const t = item as Record<string, unknown>;
  if (
    typeof t.taskId !== "string" ||
    t.taskId.length === 0 ||
    t.taskId.length > 64
  )
    return null;
  const status = TEAM_TASK_STATUSES.includes(String(t.status))
    ? (String(t.status) as TeamTaskStatus)
    : "pending";
  const strArray = (v: unknown): string[] =>
    Array.isArray(v)
      ? v
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.slice(0, 500))
      : [];
  return {
    taskId: t.taskId,
    role: typeof t.role === "string" ? t.role.slice(0, 32) : "",
    roleLabel:
      typeof t.roleLabel === "string"
        ? t.roleLabel.slice(0, 32)
        : String(t.role ?? ""),
    description:
      typeof t.description === "string" ? t.description.slice(0, 500) : "",
    dependencies: strArray(t.dependencies),
    dependents: strArray(t.dependents),
    level:
      typeof t.level === "number" && t.level >= 0 && t.level < 32
        ? Math.floor(t.level)
        : 0,
    status,
    retryCount: typeof t.retryCount === "number" ? t.retryCount : 0,
    maxRetries: typeof t.maxRetries === "number" ? t.maxRetries : 0,
    startedAtMs: typeof t.startedAtMs === "number" ? t.startedAtMs : undefined,
    completedAtMs:
      typeof t.completedAtMs === "number" ? t.completedAtMs : undefined,
    files: strArray(t.files).slice(0, 50),
    conflictWith:
      typeof t.conflictWith === "string"
        ? t.conflictWith.slice(0, 64)
        : undefined,
    error: typeof t.error === "string" ? t.error.slice(0, 500) : undefined,
    resultExcerpt:
      typeof t.resultExcerpt === "string"
        ? t.resultExcerpt.slice(0, 300)
        : undefined,
  };
}

/** Normalize one team view row; null when unusable. */
export function normalizeTeamView(item: unknown): TeamView | null {
  if (!item || typeof item !== "object") return null;
  const t = item as Record<string, unknown>;
  if (!TEAM_ID_PATTERN.test(String(t.teamId ?? ""))) return null;
  const status = TEAM_STATUSES.includes(String(t.status))
    ? (String(t.status) as TeamStatus)
    : "idle";
  const tasks: TeamTaskView[] = [];
  if (Array.isArray(t.tasks)) {
    for (const x of t.tasks) {
      const n = normalizeTeamTask(x);
      if (n) tasks.push(n);
    }
  }
  const locks: TeamLockView[] = [];
  if (Array.isArray(t.locks)) {
    for (const x of t.locks) {
      if (!x || typeof x !== "object") continue;
      const l = x as Record<string, unknown>;
      if (typeof l.file !== "string" || typeof l.holderTaskId !== "string")
        continue;
      locks.push({
        file: l.file.slice(0, 500),
        holderTaskId: l.holderTaskId.slice(0, 64),
        holderRole:
          typeof l.holderRole === "string" ? l.holderRole.slice(0, 32) : "",
        acquiredAtMs: typeof l.acquiredAtMs === "number" ? l.acquiredAtMs : 0,
      });
    }
  }
  return {
    teamId: String(t.teamId),
    taskId: typeof t.taskId === "string" ? t.taskId.slice(0, 128) : "",
    objective:
      typeof t.objective === "string" ? t.objective.slice(0, 2000) : "",
    mode: typeof t.mode === "string" ? t.mode.slice(0, 16) : "act",
    status,
    roles: Array.isArray(t.roles)
      ? t.roles
          .filter((r): r is string => typeof r === "string")
          .map((r) => r.slice(0, 32))
      : [],
    maxConcurrency: typeof t.maxConcurrency === "number" ? t.maxConcurrency : 2,
    tasks,
    locks,
    runId: typeof t.runId === "string" ? t.runId.slice(0, 64) : undefined,
    runCount: typeof t.runCount === "number" ? t.runCount : 0,
    createdAtMs: typeof t.createdAtMs === "number" ? t.createdAtMs : 0,
    updatedAtMs: typeof t.updatedAtMs === "number" ? t.updatedAtMs : 0,
    completedCount: typeof t.completedCount === "number" ? t.completedCount : 0,
    failedCount: typeof t.failedCount === "number" ? t.failedCount : 0,
    error: typeof t.error === "string" ? t.error.slice(0, 500) : undefined,
  };
}

/** Normalize a team/list_result payload. */
export function normalizeTeamList(payload: unknown): TeamView[] {
  if (!payload || typeof payload !== "object") return [];
  const raw = (payload as { teams?: unknown }).teams;
  if (!Array.isArray(raw)) return [];
  const out: TeamView[] = [];
  for (const item of raw) {
    const v = normalizeTeamView(item);
    if (v) out.push(v);
  }
  return out;
}

/** Normalize a team/details_result payload. */
export function normalizeTeamDetails(payload: unknown): TeamView | null {
  if (!payload || typeof payload !== "object") return null;
  return normalizeTeamView((payload as { team?: unknown }).team);
}

/** Display metadata for team/task statuses. */
export function teamStatusMeta(status: string): {
  label: string;
  tone: string;
} {
  switch (status) {
    case "running":
      return { label: "RUNNING", tone: "blue" };
    case "completed":
      return { label: "COMPLETED", tone: "green" };
    case "failed":
      return { label: "FAILED", tone: "red" };
    case "cancelled":
      return { label: "CANCELLED", tone: "yellow" };
    case "interrupted":
      return { label: "INTERRUPTED", tone: "orange" };
    case "pending":
      return { label: "QUEUED", tone: "gray" };
    case "waiting":
      return { label: "WAITING", tone: "yellow" };
    case "blocked":
      return { label: "BLOCKED", tone: "red" };
    case "retrying":
      return { label: "RETRYING", tone: "orange" };
    case "idle":
      return { label: "IDLE", tone: "gray" };
    default:
      return { label: status.toUpperCase().slice(0, 16), tone: "gray" };
  }
}

/** Group tasks by DAG level for tree rendering (roots first). */
export function groupTasksByLevel(tasks: TeamTaskView[]): TeamTaskView[][] {
  const levels = new Map<number, TeamTaskView[]>();
  for (const t of tasks) {
    const list = levels.get(t.level) ?? [];
    list.push(t);
    levels.set(t.level, list);
  }
  return [...levels.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, list]) => list.sort((x, y) => x.taskId.localeCompare(y.taskId)));
}

/** Friendly role label fallback (backend already sends roleLabel). */
export function teamRoleLabel(role: string): string {
  const labels: Record<string, string> = {
    architect: "Planner",
    coder: "Implementer",
    tester: "Tester",
    security: "Security",
    reviewer: "Reviewer",
    documentation: "Docs",
  };
  return labels[role] ?? role;
}

// ============================================================================
// Scheduler (M17)
// ============================================================================

export type ScheduleKind = "once" | "recurring";
export type ScheduleRunStatus =
  "queued" | "running" | "success" | "failed" | "skipped" | "cancelled";

export interface ScheduleView {
  id: string;
  name: string;
  prompt: string;
  kind: ScheduleKind;
  atIso?: string;
  everyMinutes?: number;
  dailyAt?: string;
  timezone?: string;
  missedRunPolicy: string;
  enabled: boolean;
  maxRetries: number;
  createdAtMs: number;
  lastRunAtMs?: number;
  lastRunStatus?: string;
  nextRunAtMs?: number;
  liveStatus: "idle" | "queued" | "running";
  runCount: number;
  successCount: number;
  failedCount: number;
}

export interface ScheduleRunView {
  scheduleId: string;
  scheduleName: string;
  startedAtMs: number;
  finishedAtMs?: number;
  durationMs?: number;
  status: string;
  attempt: number;
  error?: string;
  exitCode?: number;
  outputExcerpt?: string;
}

export interface ScheduleDetailsView {
  schedule: ScheduleView;
  history: ScheduleRunView[];
}

export interface ScheduleMetrics {
  total: number;
  success: number;
  failed: number;
  running: number;
  queued: number;
}

const SCHEDULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Validate an outbound scheduler action before posting to the host. */
export function validateScheduleAction(
  action: string,
  payload: unknown,
): { ok: boolean; error?: string } {
  const validActions = new Set([
    "schedule/list",
    "schedule/create",
    "schedule/update",
    "schedule/remove",
    "schedule/toggle",
    "schedule/run-now",
    "schedule/details",
  ]);
  if (!validActions.has(action))
    return { ok: false, error: `unknown schedule action: ${action}` };
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (action) {
    case "schedule/list":
      return { ok: true };
    case "schedule/create":
    case "schedule/update": {
      if (
        action === "schedule/update" &&
        !SCHEDULE_ID_PATTERN.test(String(p.id ?? ""))
      ) {
        return { ok: false, error: "invalid schedule id" };
      }
      if (
        p.name !== undefined &&
        (typeof p.name !== "string" ||
          p.name.length === 0 ||
          p.name.length > 100)
      ) {
        return { ok: false, error: "name must be 1-100 chars" };
      }
      if (
        p.prompt !== undefined &&
        (typeof p.prompt !== "string" ||
          p.prompt.length === 0 ||
          p.prompt.length > 4000)
      ) {
        return { ok: false, error: "prompt must be 1-4000 chars" };
      }
      if (p.kind !== undefined && p.kind !== "once" && p.kind !== "recurring") {
        return { ok: false, error: "kind must be once | recurring" };
      }
      if (p.everyMinutes !== undefined) {
        const n =
          typeof p.everyMinutes === "string"
            ? Number(p.everyMinutes)
            : p.everyMinutes;
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
          return {
            ok: false,
            error: "everyMinutes must be a positive integer",
          };
        }
      }
      if (
        p.dailyAt !== undefined &&
        (typeof p.dailyAt !== "string" || !/^\d{1,2}:\d{2}$/.test(p.dailyAt))
      ) {
        return { ok: false, error: "dailyAt must be HH:MM" };
      }
      if (
        p.atIso !== undefined &&
        (typeof p.atIso !== "string" || Number.isNaN(Date.parse(p.atIso)))
      ) {
        return { ok: false, error: "atIso must be a valid date-time" };
      }
      if (p.maxRetries !== undefined) {
        const r =
          typeof p.maxRetries === "string"
            ? Number(p.maxRetries)
            : p.maxRetries;
        if (typeof r !== "number" || !Number.isInteger(r) || r < 0 || r > 5) {
          return { ok: false, error: "maxRetries must be an integer 0-5" };
        }
      }
      if (p.enabled !== undefined && typeof p.enabled !== "boolean") {
        return { ok: false, error: "enabled must be a boolean" };
      }
      return { ok: true };
    }
    case "schedule/remove":
    case "schedule/run-now":
    case "schedule/details":
      if (!SCHEDULE_ID_PATTERN.test(String(p.scheduleId ?? p.id ?? ""))) {
        return { ok: false, error: "invalid schedule id" };
      }
      return { ok: true };
    case "schedule/toggle": {
      if (!SCHEDULE_ID_PATTERN.test(String(p.id ?? ""))) {
        return { ok: false, error: "invalid schedule id" };
      }
      if (p.enabled !== undefined && typeof p.enabled !== "boolean") {
        return { ok: false, error: "enabled must be a boolean" };
      }
      return { ok: true };
    }
    default:
      return { ok: false, error: "unknown schedule action" };
  }
}

/** Normalize one schedule row; null when unusable (never renders fake rows). */
export function normalizeScheduleView(item: unknown): ScheduleView | null {
  if (!item || typeof item !== "object") return null;
  const s = item as Record<string, unknown>;
  if (!SCHEDULE_ID_PATTERN.test(String(s.id ?? ""))) return null;
  if (s.kind !== "once" && s.kind !== "recurring") return null;
  const live =
    s.liveStatus === "queued" || s.liveStatus === "running"
      ? s.liveStatus
      : "idle";
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  return {
    id: String(s.id),
    name: typeof s.name === "string" ? s.name.slice(0, 100) : String(s.id),
    prompt: typeof s.prompt === "string" ? s.prompt.slice(0, 4000) : "",
    kind: s.kind,
    atIso: typeof s.atIso === "string" ? s.atIso.slice(0, 64) : undefined,
    everyMinutes: num(s.everyMinutes),
    dailyAt: typeof s.dailyAt === "string" ? s.dailyAt.slice(0, 16) : undefined,
    timezone:
      typeof s.timezone === "string" ? s.timezone.slice(0, 64) : undefined,
    missedRunPolicy:
      typeof s.missedRunPolicy === "string"
        ? s.missedRunPolicy.slice(0, 16)
        : "skip",
    enabled: s.enabled === true,
    maxRetries: num(s.maxRetries) ?? 0,
    createdAtMs: num(s.createdAtMs) ?? 0,
    lastRunAtMs: num(s.lastRunAtMs),
    lastRunStatus:
      typeof s.lastRunStatus === "string"
        ? s.lastRunStatus.slice(0, 16)
        : undefined,
    nextRunAtMs: num(s.nextRunAtMs),
    liveStatus: live,
    runCount: num(s.runCount) ?? 0,
    successCount: num(s.successCount) ?? 0,
    failedCount: num(s.failedCount) ?? 0,
  };
}

/** Normalize a schedule/list_result payload. */
export function normalizeScheduleList(payload: unknown): {
  schedules: ScheduleView[];
  history: ScheduleRunView[];
  metrics: ScheduleMetrics;
} {
  const empty = {
    schedules: [] as ScheduleView[],
    history: [] as ScheduleRunView[],
    metrics: { total: 0, success: 0, failed: 0, running: 0, queued: 0 },
  };
  if (!payload || typeof payload !== "object") return empty;
  const p = payload as {
    schedules?: unknown;
    history?: unknown;
    metrics?: unknown;
  };
  if (Array.isArray(p.schedules)) {
    for (const item of p.schedules) {
      const v = normalizeScheduleView(item);
      if (v) empty.schedules.push(v);
    }
  }
  empty.history = normalizeScheduleHistory(p.history);
  if (p.metrics && typeof p.metrics === "object") {
    const m = p.metrics as Record<string, unknown>;
    for (const k of [
      "total",
      "success",
      "failed",
      "running",
      "queued",
    ] as const) {
      if (typeof m[k] === "number") empty.metrics[k] = m[k];
    }
  }
  return empty;
}

/** Normalize history arrays (list_result history or details history). */
export function normalizeScheduleHistory(payload: unknown): ScheduleRunView[] {
  if (!Array.isArray(payload)) return [];
  const out: ScheduleRunView[] = [];
  for (const item of payload) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.scheduleId !== "string" || typeof r.startedAtMs !== "number")
      continue;
    const num = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) ? v : undefined;
    out.push({
      scheduleId: r.scheduleId.slice(0, 128),
      scheduleName:
        typeof r.scheduleName === "string"
          ? r.scheduleName.slice(0, 100)
          : r.scheduleId.slice(0, 100),
      startedAtMs: r.startedAtMs,
      finishedAtMs: num(r.finishedAtMs),
      durationMs: num(r.durationMs),
      status: typeof r.status === "string" ? r.status.slice(0, 16) : "unknown",
      attempt: num(r.attempt) ?? 0,
      error: typeof r.error === "string" ? r.error.slice(0, 500) : undefined,
      exitCode: num(r.exitCode),
      outputExcerpt:
        typeof r.outputExcerpt === "string"
          ? r.outputExcerpt.slice(0, 500)
          : undefined,
    });
  }
  return out;
}

/** Normalize a schedule/details_result payload. */
export function normalizeScheduleDetails(
  payload: unknown,
): ScheduleDetailsView | null {
  if (!payload || typeof payload !== "object") return null;
  const d = (payload as { details?: unknown }).details;
  if (!d || typeof d !== "object") return null;
  const schedule = normalizeScheduleView(
    (d as { schedule?: unknown }).schedule,
  );
  if (!schedule) return null;
  return {
    schedule,
    history: normalizeScheduleHistory((d as { history?: unknown }).history),
  };
}

/** Human-readable schedule expression (actual supported syntax only). */
export function describeScheduleFrequency(s: {
  kind: string;
  atIso?: string;
  everyMinutes?: number;
  dailyAt?: string;
  timezone?: string;
}): string {
  if (s.kind === "once") {
    if (!s.atIso) return "once (unset)";
    const at = Date.parse(s.atIso);
    if (Number.isNaN(at)) return "once (invalid)";
    return `once ${new Date(at).toLocaleString()}`;
  }
  if (s.everyMinutes !== undefined) {
    const m = s.everyMinutes;
    if (m % 1440 === 0) return `every ${m / 1440}d`;
    if (m % 60 === 0) return `every ${m / 60}h`;
    return `every ${m}m`;
  }
  if (s.dailyAt)
    return `daily ${s.dailyAt}${s.timezone ? ` (${s.timezone})` : ""}`;
  return "recurring (unset)";
}

/** Display metadata for schedule/run statuses. */
export function scheduleStatusMeta(status: string): {
  label: string;
  tone: string;
} {
  switch (status) {
    case "running":
      return { label: "RUNNING", tone: "blue" };
    case "queued":
      return { label: "QUEUED", tone: "yellow" };
    case "success":
    case "completed":
      return { label: status.toUpperCase(), tone: "green" };
    case "failed":
      return { label: "FAILED", tone: "red" };
    case "skipped":
      return { label: "SKIPPED", tone: "gray" };
    case "cancelled":
      return { label: "CANCELLED", tone: "orange" };
    case "enabled":
      return { label: "ENABLED", tone: "green" };
    case "disabled":
      return { label: "DISABLED", tone: "gray" };
    default:
      return { label: status.toUpperCase().slice(0, 16), tone: "gray" };
  }
}

/** Countdown label for the next run (overdue-aware). */
export function nextRunLabel(
  nextRunAtMs: number | undefined,
  nowMs = Date.now(),
): string {
  if (nextRunAtMs === undefined) return "not scheduled";
  const diff = nextRunAtMs - nowMs;
  if (diff <= 0) return "due now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "in <1m";
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

// ============================================================================
// Task history (M12/M5)
// ============================================================================

export interface TaskToolSummary {
  name: string;
  count: number;
  totalDurationMs: number;
}

export interface TaskSummary {
  id: string;
  sessionId?: string;
  title: string;
  promptExcerpt: string;
  status: string;
  mode?: string;
  provider?: string;
  model?: string;
  createdAtMs: number;
  updatedAtMs: number;
  durationMs?: number;
  messageCount: number;
  toolCallCount: number;
  retryCount: number;
  filesChangedCount: number;
  checkpointCount: number;
  hasErrors: boolean;
  resultExcerpt?: string;
}

export interface TimelineEvent {
  timestampMs: number;
  phase: string;
  kind:
    | "created"
    | "prompt"
    | "response"
    | "system"
    | "tool"
    | "checkpoint"
    | "status";
  summary: string;
}

export interface TaskFileEntry {
  path: string;
  changeType: "created" | "modified" | "deleted" | "renamed" | "moved";
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  diffExcerpt?: string;
}

export interface TaskFileSummary {
  created: TaskFileEntry[];
  modified: TaskFileEntry[];
  deleted: TaskFileEntry[];
  renamed: TaskFileEntry[];
  totalAdditions: number;
  totalDeletions: number;
}

export interface TaskCheckpointView {
  checkpointId: string;
  taskId: string;
  timestamp: number;
  description: string;
  fileCount: number;
  status: string;
  files: string[];
}

export interface TaskDetails extends TaskSummary {
  timeline: TimelineEvent[];
  files: TaskFileSummary;
  checkpoints: TaskCheckpointView[];
  messages: Array<{ role: string; excerpt: string; timestampMs: number }>;
  tools: TaskToolSummary[];
  approvalsNote: string;
  errors: string[];
  metrics: {
    toolCallCount: number;
    retryCount: number;
    filesChangedCount: number;
    checkpointCount: number;
    messageCount: number;
  };
  interruption?: {
    interruptedAtMs: number;
    lastPhase: string;
    lastAssistantExcerpt?: string;
    pendingSummary: string;
    filesChanged: string[];
    checkpointsAvailable: number;
    error?: string;
  };
}

export interface CompareRow {
  metric: string;
  a: string;
  b: string;
  verdict: "SAME" | "BETTER" | "WORSE" | "DIFFERENT" | "UNKNOWN";
  note?: string;
}

export interface CheckpointFileDiff {
  path: string;
  oldPath?: string;
  operation: "added" | "removed" | "modified" | "renamed" | "unchanged";
  additions: number;
  deletions: number;
  binary: boolean;
  unifiedDiff?: string;
}

export interface CheckpointCompareView {
  aId: string;
  bId: string;
  added: string[];
  removed: string[];
  modified: string[];
  renamed: Array<{ from: string; to: string }>;
  unchanged: number;
  diffs: CheckpointFileDiff[];
  truncated: boolean;
}

export interface TaskHistoryFilter {
  query: string;
  status: string;
  provider: string;
  model: string;
  mode: string;
  flag:
    | "all"
    | "failed"
    | "interrupted"
    | "completed"
    | "has-checkpoints"
    | "has-files";
  fromMs?: number;
  toMs?: number;
}

export const TASK_ID_PATTERN = /^task-[0-9]+-[a-z0-9]+$/;
export const CHECKPOINT_ID_PATTERN = /^cp-[a-z0-9]+-[a-f0-9]+$/;

/** Validate an outbound history action before posting to the host. */
export function validateHistoryAction(
  action: string,
  payload: unknown,
): { ok: boolean; error?: string } {
  const validActions = new Set([
    "history/list",
    "history/details",
    "history/compare",
    "history/checkpoint-compare",
    "history/resume",
    "history/restart",
    "history/discard",
  ]);
  if (!validActions.has(action))
    return { ok: false, error: `unknown history action: ${action}` };
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (action) {
    case "history/list":
      return { ok: true };
    case "history/details":
    case "history/resume":
    case "history/restart":
    case "history/discard":
      if (!TASK_ID_PATTERN.test(String(p.taskId ?? ""))) {
        return { ok: false, error: "invalid task id" };
      }
      return { ok: true };
    case "history/compare":
      if (
        !TASK_ID_PATTERN.test(String(p.aTaskId ?? "")) ||
        !TASK_ID_PATTERN.test(String(p.bTaskId ?? ""))
      ) {
        return { ok: false, error: "invalid task ids for comparison" };
      }
      return { ok: true };
    case "history/checkpoint-compare":
      if (
        !CHECKPOINT_ID_PATTERN.test(String(p.aCheckpointId ?? "")) ||
        !CHECKPOINT_ID_PATTERN.test(String(p.bCheckpointId ?? ""))
      ) {
        return { ok: false, error: "invalid checkpoint ids for comparison" };
      }
      return { ok: true };
    default:
      return { ok: false, error: "unknown history action" };
  }
}

/** Normalize one task summary row; null when unusable (never fake rows). */
export function normalizeTaskSummary(item: unknown): TaskSummary | null {
  if (!item || typeof item !== "object") return null;
  const t = item as Record<string, unknown>;
  if (!TASK_ID_PATTERN.test(String(t.id ?? ""))) return null;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  return {
    id: String(t.id),
    sessionId:
      typeof t.sessionId === "string" ? t.sessionId.slice(0, 128) : undefined,
    title: typeof t.title === "string" ? t.title.slice(0, 200) : String(t.id),
    promptExcerpt:
      typeof t.promptExcerpt === "string" ? t.promptExcerpt.slice(0, 300) : "",
    status: typeof t.status === "string" ? t.status.slice(0, 32) : "unknown",
    mode: typeof t.mode === "string" ? t.mode.slice(0, 32) : undefined,
    provider:
      typeof t.provider === "string" ? t.provider.slice(0, 64) : undefined,
    model: typeof t.model === "string" ? t.model.slice(0, 64) : undefined,
    createdAtMs: num(t.createdAtMs) ?? 0,
    updatedAtMs: num(t.updatedAtMs) ?? 0,
    durationMs: num(t.durationMs),
    messageCount: num(t.messageCount) ?? 0,
    toolCallCount: num(t.toolCallCount) ?? 0,
    retryCount: num(t.retryCount) ?? 0,
    filesChangedCount: num(t.filesChangedCount) ?? 0,
    checkpointCount: num(t.checkpointCount) ?? 0,
    hasErrors: t.hasErrors === true,
    resultExcerpt:
      typeof t.resultExcerpt === "string"
        ? t.resultExcerpt.slice(0, 500)
        : undefined,
  };
}

/** Normalize a history/list_result payload. */
export function normalizeTaskHistoryList(payload: unknown): TaskSummary[] {
  if (!payload || typeof payload !== "object") return [];
  const raw = (payload as { tasks?: unknown }).tasks;
  if (!Array.isArray(raw)) return [];
  const out: TaskSummary[] = [];
  for (const item of raw) {
    const v = normalizeTaskSummary(item);
    if (v) out.push(v);
  }
  return out;
}

/** Normalize a history/details_result payload (bounded). */
export function normalizeTaskDetails(payload: unknown): TaskDetails | null {
  if (!payload || typeof payload !== "object") return null;
  const d = (payload as { details?: unknown }).details;
  if (!d || typeof d !== "object") return null;
  const base = normalizeTaskSummary(d);
  if (!base) return null;
  const r = d as Record<string, unknown>;
  const strArray = (v: unknown): string[] =>
    Array.isArray(v)
      ? v
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.slice(0, 500))
      : [];
  const timeline = Array.isArray(r.timeline)
    ? (r.timeline as unknown[])
        .flatMap((e) => {
          if (!e || typeof e !== "object") return [];
          const ev = e as Record<string, unknown>;
          if (
            typeof ev.timestampMs !== "number" ||
            typeof ev.phase !== "string"
          )
            return [];
          const kinds = [
            "created",
            "prompt",
            "response",
            "system",
            "tool",
            "checkpoint",
            "status",
          ];
          return [
            {
              timestampMs: ev.timestampMs,
              phase: ev.phase.slice(0, 32),
              kind: (kinds.includes(String(ev.kind))
                ? ev.kind
                : "system") as TimelineEvent["kind"],
              summary:
                typeof ev.summary === "string" ? ev.summary.slice(0, 200) : "",
            },
          ];
        })
        .slice(0, 200)
    : [];
  const fileEntry = (x: unknown): TaskFileEntry | null => {
    if (!x || typeof x !== "object") return null;
    const f = x as Record<string, unknown>;
    if (typeof f.path !== "string") return null;
    const ct = ["created", "modified", "deleted", "renamed", "moved"].includes(
      String(f.changeType),
    )
      ? (String(f.changeType) as TaskFileEntry["changeType"])
      : "modified";
    const num = (v: unknown): number =>
      typeof v === "number" && Number.isFinite(v) ? v : 0;
    return {
      path: f.path.slice(0, 500),
      changeType: ct,
      status: typeof f.status === "string" ? f.status.slice(0, 32) : "",
      additions: num(f.additions),
      deletions: num(f.deletions),
      binary: f.binary === true,
      diffExcerpt:
        typeof f.diffExcerpt === "string"
          ? f.diffExcerpt.slice(0, 5000)
          : undefined,
    };
  };
  const fileList = (v: unknown): TaskFileEntry[] =>
    Array.isArray(v)
      ? v
          .flatMap((x) => {
            const e = fileEntry(x);
            return e ? [e] : [];
          })
          .slice(0, 50)
      : [];
  const files: TaskFileSummary = (() => {
    const f = (r.files ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number =>
      typeof v === "number" && Number.isFinite(v) ? v : 0;
    return {
      created: fileList(f.created),
      modified: fileList(f.modified),
      deleted: fileList(f.deleted),
      renamed: fileList(f.renamed),
      totalAdditions: num(f.totalAdditions),
      totalDeletions: num(f.totalDeletions),
    };
  })();
  const checkpoints = Array.isArray(r.checkpoints)
    ? (r.checkpoints as unknown[]).flatMap((x) => {
        if (!x || typeof x !== "object") return [];
        const c = x as Record<string, unknown>;
        if (typeof c.checkpointId !== "string") return [];
        const num = (v: unknown): number | undefined =>
          typeof v === "number" && Number.isFinite(v) ? v : undefined;
        return [
          {
            checkpointId: c.checkpointId.slice(0, 128),
            taskId: typeof c.taskId === "string" ? c.taskId.slice(0, 128) : "",
            timestamp: num(c.timestamp) ?? 0,
            description:
              typeof c.description === "string"
                ? c.description.slice(0, 200)
                : "",
            fileCount: num(c.fileCount) ?? 0,
            status: typeof c.status === "string" ? c.status.slice(0, 32) : "",
            files: strArray(c.files).slice(0, 100),
          },
        ];
      })
    : [];
  const messages = Array.isArray(r.messages)
    ? (r.messages as unknown[])
        .flatMap((x) => {
          if (!x || typeof x !== "object") return [];
          const m = x as Record<string, unknown>;
          if (typeof m.role !== "string") return [];
          return [
            {
              role: m.role.slice(0, 16),
              excerpt:
                typeof m.excerpt === "string" ? m.excerpt.slice(0, 1000) : "",
              timestampMs:
                typeof m.timestampMs === "number" ? m.timestampMs : 0,
            },
          ];
        })
        .slice(0, 100)
    : [];
  const tools = Array.isArray(r.tools)
    ? (r.tools as unknown[]).flatMap((x) => {
        if (!x || typeof x !== "object") return [];
        const t = x as Record<string, unknown>;
        if (typeof t.name !== "string") return [];
        return [
          {
            name: t.name.slice(0, 64),
            count: typeof t.count === "number" ? t.count : 0,
            totalDurationMs:
              typeof t.totalDurationMs === "number" ? t.totalDurationMs : 0,
          },
        ];
      })
    : [];
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  const m = (r.metrics ?? {}) as Record<string, unknown>;
  return {
    ...base,
    timeline,
    files,
    checkpoints,
    messages,
    tools,
    approvalsNote:
      typeof r.approvalsNote === "string" ? r.approvalsNote.slice(0, 500) : "",
    errors: strArray(r.errors).slice(0, 20),
    metrics: {
      toolCallCount: num(m.toolCallCount),
      retryCount: num(m.retryCount),
      filesChangedCount: num(m.filesChangedCount),
      checkpointCount: num(m.checkpointCount),
      messageCount: num(m.messageCount),
    },
    interruption: (() => {
      const i = r.interruption;
      if (!i || typeof i !== "object") return undefined;
      const it = i as Record<string, unknown>;
      return {
        interruptedAtMs:
          typeof it.interruptedAtMs === "number" ? it.interruptedAtMs : 0,
        lastPhase:
          typeof it.lastPhase === "string"
            ? it.lastPhase.slice(0, 32)
            : "unknown",
        lastAssistantExcerpt:
          typeof it.lastAssistantExcerpt === "string"
            ? it.lastAssistantExcerpt.slice(0, 300)
            : undefined,
        pendingSummary:
          typeof it.pendingSummary === "string"
            ? it.pendingSummary.slice(0, 500)
            : "",
        filesChanged: strArray(it.filesChanged).slice(0, 40),
        checkpointsAvailable:
          typeof it.checkpointsAvailable === "number"
            ? it.checkpointsAvailable
            : 0,
        error:
          typeof it.error === "string" ? it.error.slice(0, 500) : undefined,
      };
    })(),
  };
}

/** Normalize a history/compare_result payload. */
export function normalizeRunCompare(payload: unknown): {
  aTaskId: string;
  bTaskId: string;
  rows: CompareRow[];
} | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { aTaskId?: unknown; bTaskId?: unknown; rows?: unknown };
  if (typeof p.aTaskId !== "string" || typeof p.bTaskId !== "string")
    return null;
  if (!Array.isArray(p.rows)) return null;
  const verdicts = ["SAME", "BETTER", "WORSE", "DIFFERENT", "UNKNOWN"];
  const rows: CompareRow[] = [];
  for (const x of p.rows) {
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    if (typeof r.metric !== "string") continue;
    rows.push({
      metric: r.metric.slice(0, 64),
      a: typeof r.a === "string" ? r.a.slice(0, 200) : "",
      b: typeof r.b === "string" ? r.b.slice(0, 200) : "",
      verdict: verdicts.includes(String(r.verdict))
        ? (String(r.verdict) as CompareRow["verdict"])
        : "UNKNOWN",
      note: typeof r.note === "string" ? r.note.slice(0, 300) : undefined,
    });
  }
  return { aTaskId: p.aTaskId, bTaskId: p.bTaskId, rows };
}

/** Normalize a history/checkpoint-compare_result payload (bounded). */
export function normalizeCheckpointCompare(
  payload: unknown,
): CheckpointCompareView | null {
  if (!payload || typeof payload !== "object") return null;
  const c = (payload as { compare?: unknown }).compare;
  if (!c || typeof c !== "object") return null;
  const r = c as Record<string, unknown>;
  if (typeof r.aId !== "string" || typeof r.bId !== "string") return null;
  const strArray = (v: unknown): string[] =>
    Array.isArray(v)
      ? v
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.slice(0, 500))
      : [];
  const diffs = Array.isArray(r.diffs)
    ? (r.diffs as unknown[])
        .flatMap((x) => {
          if (!x || typeof x !== "object") return [];
          const d = x as Record<string, unknown>;
          if (typeof d.path !== "string") return [];
          const ops = ["added", "removed", "modified", "renamed", "unchanged"];
          const num = (v: unknown): number =>
            typeof v === "number" && Number.isFinite(v) ? v : 0;
          return [
            {
              path: d.path.slice(0, 500),
              oldPath:
                typeof d.oldPath === "string"
                  ? d.oldPath.slice(0, 500)
                  : undefined,
              operation: (ops.includes(String(d.operation))
                ? d.operation
                : "modified") as CheckpointFileDiff["operation"],
              additions: num(d.additions),
              deletions: num(d.deletions),
              binary: d.binary === true,
              unifiedDiff:
                typeof d.unifiedDiff === "string"
                  ? d.unifiedDiff.slice(0, 5000)
                  : undefined,
            },
          ];
        })
        .slice(0, 20)
    : [];
  return {
    aId: r.aId.slice(0, 128),
    bId: r.bId.slice(0, 128),
    added: strArray(r.added),
    removed: strArray(r.removed),
    modified: strArray(r.modified),
    renamed: Array.isArray(r.renamed)
      ? (r.renamed as unknown[]).flatMap((x) => {
          if (!x || typeof x !== "object") return [];
          const n = x as Record<string, unknown>;
          if (typeof n.from !== "string" || typeof n.to !== "string") return [];
          return [{ from: n.from.slice(0, 500), to: n.to.slice(0, 500) }];
        })
      : [],
    unchanged: typeof r.unchanged === "number" ? r.unchanged : 0,
    diffs,
    truncated: r.truncated === true,
  };
}

/** Build the outbound filter payload from UI filter state (bounded). */
export function buildHistoryFilterPayload(
  filter: TaskHistoryFilter,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (filter.query.trim()) payload.query = filter.query.trim().slice(0, 200);
  if (filter.status && filter.status !== "all")
    payload.status = filter.status.slice(0, 32);
  if (filter.provider.trim())
    payload.provider = filter.provider.trim().slice(0, 64);
  if (filter.model.trim()) payload.model = filter.model.trim().slice(0, 64);
  if (filter.mode && filter.mode !== "all")
    payload.mode = filter.mode.slice(0, 32);
  if (filter.flag === "failed") payload.failedOnly = true;
  else if (filter.flag === "interrupted") payload.interruptedOnly = true;
  else if (filter.flag === "completed") payload.completedOnly = true;
  else if (filter.flag === "has-checkpoints") payload.hasCheckpoints = true;
  else if (filter.flag === "has-files") payload.hasFiles = true;
  if (filter.fromMs !== undefined) payload.fromMs = filter.fromMs;
  if (filter.toMs !== undefined) payload.toMs = filter.toMs;
  payload.limit = 200;
  return payload;
}

/** Display metadata for task statuses. */
export function historyStatusMeta(status: string): {
  label: string;
  tone: string;
} {
  switch (status) {
    case "running":
      return { label: "RUNNING", tone: "blue" };
    case "completed":
      return { label: "COMPLETED", tone: "green" };
    case "failed":
      return { label: "FAILED", tone: "red" };
    case "cancelled":
    case "interrupted":
      return { label: status.toUpperCase(), tone: "orange" };
    case "archived":
      return { label: "ARCHIVED", tone: "gray" };
    default:
      return { label: status.toUpperCase().slice(0, 16), tone: "gray" };
  }
}

/** Display metadata for compare verdicts. */
export function compareVerdictMeta(verdict: string): {
  label: string;
  tone: string;
} {
  switch (verdict) {
    case "SAME":
      return { label: "SAME", tone: "gray" };
    case "BETTER":
      return { label: "BETTER", tone: "green" };
    case "WORSE":
      return { label: "WORSE", tone: "red" };
    case "DIFFERENT":
      return { label: "DIFFERENT", tone: "blue" };
    default:
      return { label: "UNKNOWN", tone: "yellow" };
  }
}

/** Compact duration label. */
export function formatTaskDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

// ============================================================================
// Observability dashboard (M18)
// ============================================================================

export interface DashboardMetricValue {
  key: string;
  label: string;
  value: number | null;
  unit?: string;
  unavailableReason?: string;
  scope: "range" | "session";
}

export interface DashboardToolRow {
  name: string;
  category: string;
  invocations: number;
  failures: number;
  success: number;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  samples: number;
}

export interface DashboardProviderRow {
  provider: string;
  tasks: number;
  models: Array<{ model: string; tasks: number }>;
}

export interface DashboardErrorCategory {
  category: string;
  count: number;
  taskCount: number;
  recentAtMs?: number;
}

export interface DashboardRecentError {
  source: string;
  taskId?: string;
  summary: string;
  atMs: number;
}

export interface DashboardActiveTask {
  kind: string;
  id: string;
  label: string;
  status: string;
  startedAtMs?: number;
  elapsedMs?: number;
  detail?: string;
}

export interface DashboardView {
  generatedAtMs: number;
  rangeNote: string;
  overview: DashboardMetricValue[];
  performance: {
    taskDurations: {
      count: number;
      avgMs: number | null;
      minMs: number | null;
      maxMs: number | null;
    };
    toolLatency: DashboardToolRow[];
    modelLatency: DashboardMetricValue;
    contextLatency: DashboardMetricValue;
    terminalDuration: DashboardMetricValue;
    mcpDuration: DashboardMetricValue;
  };
  tools: DashboardToolRow[];
  providers: DashboardProviderRow[];
  tokens: { input: DashboardMetricValue; output: DashboardMetricValue };
  errors: {
    categories: DashboardErrorCategory[];
    recent: DashboardRecentError[];
  };
  active: DashboardActiveTask[];
}

export interface DashboardFilter {
  range: "today" | "7d" | "30d" | "all";
  status: string;
  provider: string;
  model: string;
  mode: string;
}

export interface DiagnosticSummary {
  generatedAtMs: number;
  counts: Record<string, number>;
  tools: Array<{ name: string; invocations: number; failures: number }>;
  errors: DashboardRecentError[];
  active: number;
  notes: string[];
}

const KNOWN_DASHBOARD_STATUSES = new Set([
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "archived",
]);

/** Day boundaries in local time for range presets. */
export function dashboardRangeBounds(
  range: DashboardFilter["range"],
  nowMs = Date.now(),
): { fromMs?: number; toMs?: number } {
  if (range === "all") return {};
  const day = new Date(nowMs);
  day.setHours(0, 0, 0, 0);
  if (range === "today") return { fromMs: day.getTime(), toMs: nowMs };
  const days = range === "7d" ? 7 : 30;
  return { fromMs: nowMs - days * 86_400_000, toMs: nowMs };
}

/** Validate an outbound metrics action before posting to the host. */
export function validateMetricsAction(
  action: string,
  payload: unknown,
): { ok: boolean; error?: string } {
  const validActions = new Set([
    "metrics/get",
    "metrics/dashboard",
    "metrics/export",
  ]);
  if (!validActions.has(action))
    return { ok: false, error: `unknown metrics action: ${action}` };
  if (action === "metrics/get" || action === "metrics/export")
    return { ok: true };
  const p = (payload ?? {}) as Record<string, unknown>;
  for (const k of ["fromMs", "toMs"] as const) {
    if (
      p[k] !== undefined &&
      (typeof p[k] !== "number" ||
        !Number.isFinite(p[k]) ||
        (p[k] as number) < 0)
    ) {
      return { ok: false, error: `${k} must be a non-negative timestamp` };
    }
  }
  if (
    typeof p.fromMs === "number" &&
    typeof p.toMs === "number" &&
    (p.fromMs as number) > (p.toMs as number)
  ) {
    return { ok: false, error: "fromMs must not be after toMs" };
  }
  if (
    p.status !== undefined &&
    (typeof p.status !== "string" || !KNOWN_DASHBOARD_STATUSES.has(p.status))
  ) {
    return { ok: false, error: "invalid status filter" };
  }
  for (const k of ["provider", "model", "mode"] as const) {
    if (
      p[k] !== undefined &&
      (typeof p[k] !== "string" ||
        (p[k] as string).length === 0 ||
        (p[k] as string).length > 64)
    ) {
      return { ok: false, error: `${k} must be a string of 1-64 chars` };
    }
  }
  if (
    p.limit !== undefined &&
    (typeof p.limit !== "number" ||
      !Number.isInteger(p.limit) ||
      (p.limit as number) < 1 ||
      (p.limit as number) > 200)
  ) {
    return { ok: false, error: "limit must be an integer 1-200" };
  }
  return { ok: true };
}

/** Build the outbound dashboard filter payload (bounded). */
export function buildDashboardFilterPayload(
  filter: DashboardFilter,
  nowMs = Date.now(),
): Record<string, unknown> {
  const bounds = dashboardRangeBounds(filter.range, nowMs);
  const payload: Record<string, unknown> = { limit: 200 };
  if (bounds.fromMs !== undefined) payload.fromMs = bounds.fromMs;
  if (bounds.toMs !== undefined) payload.toMs = bounds.toMs;
  if (filter.status && filter.status !== "all")
    payload.status = filter.status.slice(0, 32);
  if (filter.provider.trim())
    payload.provider = filter.provider.trim().slice(0, 64);
  if (filter.model.trim()) payload.model = filter.model.trim().slice(0, 64);
  if (filter.mode && filter.mode !== "all")
    payload.mode = filter.mode.slice(0, 32);
  return payload;
}

const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const numOrZero = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

/** Normalize one metric value; null when unusable (unavailable shown honest). */
export function normalizeMetricValue(
  item: unknown,
): DashboardMetricValue | null {
  if (!item || typeof item !== "object") return null;
  const m = item as Record<string, unknown>;
  if (typeof m.key !== "string" || typeof m.label !== "string") return null;
  return {
    key: m.key.slice(0, 64),
    label: m.label.slice(0, 64),
    value: m.value === null ? null : numOrNull(m.value),
    unit: typeof m.unit === "string" ? m.unit.slice(0, 16) : undefined,
    unavailableReason:
      typeof m.unavailableReason === "string"
        ? m.unavailableReason.slice(0, 200)
        : undefined,
    scope: m.scope === "session" ? "session" : "range",
  };
}

/** Normalize one tool row; null when unusable. */
export function normalizeToolRow(item: unknown): DashboardToolRow | null {
  if (!item || typeof item !== "object") return null;
  const t = item as Record<string, unknown>;
  if (typeof t.name !== "string" || t.name.length === 0) return null;
  return {
    name: t.name.slice(0, 64),
    category:
      typeof t.category === "string" ? t.category.slice(0, 32) : "other",
    invocations: numOrZero(t.invocations),
    failures: numOrZero(t.failures),
    success: numOrZero(t.success),
    avgMs: numOrNull(t.avgMs),
    p50Ms: numOrNull(t.p50Ms),
    p95Ms: numOrNull(t.p95Ms),
    maxMs: numOrNull(t.maxMs),
    samples: numOrZero(t.samples),
  };
}

/** Normalize the dashboard payload (bounded, malformed rows dropped). */
export function normalizeDashboard(payload: unknown): DashboardView | null {
  if (!payload || typeof payload !== "object") return null;
  const d = (payload as { dashboard?: unknown }).dashboard;
  if (!d || typeof d !== "object") return null;
  const r = d as Record<string, unknown>;
  const list = (
    v: unknown,
    fn: (x: unknown) => DashboardToolRow | null,
  ): DashboardToolRow[] =>
    Array.isArray(v)
      ? v
          .flatMap((x) => {
            const row = fn(x);
            return row ? [row] : [];
          })
          .slice(0, 50)
      : [];
  const perf = (r.performance ?? {}) as Record<string, unknown>;
  const td = (perf.taskDurations ?? {}) as Record<string, unknown>;
  const singleMetric = (
    v: unknown,
    key: string,
    label: string,
  ): DashboardMetricValue => {
    const n = normalizeMetricValue(v);
    return (
      n ?? {
        key,
        label,
        value: null,
        unavailableReason: "not reported",
        scope: "session",
      }
    );
  };
  const providers = Array.isArray(r.providers)
    ? (r.providers as unknown[])
        .flatMap((x) => {
          if (!x || typeof x !== "object") return [];
          const p = x as Record<string, unknown>;
          if (typeof p.provider !== "string") return [];
          return [
            {
              provider: p.provider.slice(0, 64),
              tasks: numOrZero(p.tasks),
              models: Array.isArray(p.models)
                ? (p.models as unknown[])
                    .flatMap((m) => {
                      if (!m || typeof m !== "object") return [];
                      const mm = m as Record<string, unknown>;
                      if (typeof mm.model !== "string") return [];
                      return [
                        {
                          model: mm.model.slice(0, 64),
                          tasks: numOrZero(mm.tasks),
                        },
                      ];
                    })
                    .slice(0, 20)
                : [],
            },
          ];
        })
        .slice(0, 20)
    : [];
  const errors = (r.errors ?? {}) as Record<string, unknown>;
  const tokens = (r.tokens ?? {}) as Record<string, unknown>;
  return {
    generatedAtMs: numOrNull(r.generatedAtMs) ?? 0,
    rangeNote: typeof r.rangeNote === "string" ? r.rangeNote.slice(0, 300) : "",
    overview: Array.isArray(r.overview)
      ? (r.overview as unknown[])
          .flatMap((x) => {
            const m = normalizeMetricValue(x);
            return m ? [m] : [];
          })
          .slice(0, 40)
      : [],
    performance: {
      taskDurations: {
        count: numOrZero(td.count),
        avgMs: numOrNull(td.avgMs),
        minMs: numOrNull(td.minMs),
        maxMs: numOrNull(td.maxMs),
      },
      toolLatency: list(perf.toolLatency, normalizeToolRow),
      modelLatency: singleMetric(
        perf.modelLatency,
        "modelLatency",
        "Model latency",
      ),
      contextLatency: singleMetric(
        perf.contextLatency,
        "contextLatency",
        "Context latency",
      ),
      terminalDuration: singleMetric(
        perf.terminalDuration,
        "terminalDuration",
        "Terminal duration",
      ),
      mcpDuration: singleMetric(
        perf.mcpDuration,
        "mcpDuration",
        "MCP duration",
      ),
    },
    tools: list(r.tools, normalizeToolRow),
    providers,
    tokens: {
      input: singleMetric(tokens.input, "inputTokens", "Input tokens"),
      output: singleMetric(tokens.output, "outputTokens", "Output tokens"),
    },
    errors: {
      categories: Array.isArray(errors.categories)
        ? (errors.categories as unknown[])
            .flatMap((x) => {
              if (!x || typeof x !== "object") return [];
              const c = x as Record<string, unknown>;
              if (typeof c.category !== "string") return [];
              return [
                {
                  category: c.category.slice(0, 32),
                  count: numOrZero(c.count),
                  taskCount: numOrZero(c.taskCount),
                  recentAtMs: numOrNull(c.recentAtMs) ?? undefined,
                },
              ];
            })
            .slice(0, 20)
        : [],
      recent: Array.isArray(errors.recent)
        ? (errors.recent as unknown[])
            .flatMap((x) => {
              if (!x || typeof x !== "object") return [];
              const e = x as Record<string, unknown>;
              if (typeof e.summary !== "string" || typeof e.atMs !== "number")
                return [];
              return [
                {
                  source:
                    typeof e.source === "string"
                      ? e.source.slice(0, 16)
                      : "log",
                  taskId:
                    typeof e.taskId === "string"
                      ? e.taskId.slice(0, 128)
                      : undefined,
                  summary: e.summary.slice(0, 200),
                  atMs: e.atMs,
                },
              ];
            })
            .slice(0, 20)
        : [],
    },
    active: Array.isArray(r.active)
      ? (r.active as unknown[])
          .flatMap((x) => {
            if (!x || typeof x !== "object") return [];
            const a = x as Record<string, unknown>;
            if (typeof a.id !== "string" || typeof a.status !== "string")
              return [];
            return [
              {
                kind:
                  typeof a.kind === "string" ? a.kind.slice(0, 16) : "runtime",
                id: a.id.slice(0, 128),
                label: typeof a.label === "string" ? a.label.slice(0, 120) : "",
                status: a.status.slice(0, 32),
                startedAtMs: numOrNull(a.startedAtMs) ?? undefined,
                elapsedMs: numOrNull(a.elapsedMs) ?? undefined,
                detail:
                  typeof a.detail === "string"
                    ? a.detail.slice(0, 200)
                    : undefined,
              },
            ];
          })
          .slice(0, 50)
      : [],
  };
}

/** Normalize the export payload. */
export function normalizeDiagnosticSummary(
  payload: unknown,
): DiagnosticSummary | null {
  if (!payload || typeof payload !== "object") return null;
  const s = (payload as { summary?: unknown }).summary;
  if (!s || typeof s !== "object") return null;
  const r = s as Record<string, unknown>;
  const counts: Record<string, number> = {};
  if (r.counts && typeof r.counts === "object") {
    for (const [k, v] of Object.entries(r.counts as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v))
        counts[k.slice(0, 64)] = v;
    }
  }
  return {
    generatedAtMs: numOrNull(r.generatedAtMs) ?? 0,
    counts,
    tools: Array.isArray(r.tools)
      ? (r.tools as unknown[])
          .flatMap((x) => {
            if (!x || typeof x !== "object") return [];
            const t = x as Record<string, unknown>;
            if (typeof t.name !== "string") return [];
            return [
              {
                name: t.name.slice(0, 64),
                invocations: numOrZero(t.invocations),
                failures: numOrZero(t.failures),
              },
            ];
          })
          .slice(0, 20)
      : [],
    errors: Array.isArray(r.errors)
      ? (r.errors as unknown[])
          .flatMap((x) => {
            if (!x || typeof x !== "object") return [];
            const e = x as Record<string, unknown>;
            if (typeof e.summary !== "string" || typeof e.atMs !== "number")
              return [];
            return [
              { source: "log", summary: e.summary.slice(0, 200), atMs: e.atMs },
            ];
          })
          .slice(0, 10)
      : [],
    active: numOrZero(r.active),
    notes: Array.isArray(r.notes)
      ? (r.notes as unknown[])
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.slice(0, 300))
      : [],
  };
}

/** Format a metric value for display (null → Unavailable). */
export function formatMetricValue(m: DashboardMetricValue): string {
  if (m.value === null) return "Unavailable";
  if (m.unit === "ms") {
    if (m.value < 1000) return `${Math.round(m.value)}ms`;
    if (m.value < 60_000) return `${(m.value / 1000).toFixed(1)}s`;
    return `${Math.round(m.value / 60_000)}m`;
  }
  return m.value >= 1000 ? m.value.toLocaleString("en-US") : String(m.value);
}

/** Display metadata for metric availability tones. */
export function metricAvailabilityTone(
  m: DashboardMetricValue,
): "live" | "muted" {
  return m.value === null ? "muted" : "live";
}

// ============================================================================
// Self-healing labels (re-exported from @codepilot/shared for the webview)
// ============================================================================

export {
  healingPhaseLabel,
  healingNextActionLabel,
  describeValidationFailure,
} from "@codepilot/shared";

// ============================================================================
// Conversation continuity (M12 v5 UX)
// ----------------------------------------------------------------------------
// View model + strict validator for the host's `continuity/state` payload.
// Malformed payloads return null and the UI keeps its previous state — a
// hostile or stale message can never corrupt the continuity display.
// Only safe metadata survives: ids, turn numbers, bounded title previews,
// statuses, timestamps, and boolean flags. No tool I/O, no credentials.
// ============================================================================

export interface ContinuityTurnView {
  taskId: string;
  turn: number;
  title: string;
  status: string;
  createdAtMs: number;
  updatedAtMs: number;
  compacted: boolean;
  trimmed: boolean;
}

export interface ContinuityStateView {
  active: boolean;
  chainLength: number;
  currentTaskId: string | null;
  turns: ContinuityTurnView[];
  compacted: boolean;
  truncated: boolean;
}

const CONTINUITY_MAX_TURNS = 64;
const CONTINUITY_MAX_TITLE = 120;

/** Validate a `continuity/state` payload; null when malformed. */
export function validateContinuityState(payload: unknown): ContinuityStateView | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.active !== "boolean") return null;
  if (
    typeof p.chainLength !== "number" ||
    !Number.isInteger(p.chainLength) ||
    p.chainLength < 0 ||
    p.chainLength > CONTINUITY_MAX_TURNS
  ) {
    return null;
  }
  if (p.currentTaskId !== null && typeof p.currentTaskId !== "string") return null;
  if (typeof p.currentTaskId === "string" && p.currentTaskId.length > 200) return null;
  if (typeof p.compacted !== "boolean" || typeof p.truncated !== "boolean") return null;
  if (!Array.isArray(p.turns) || p.turns.length > CONTINUITY_MAX_TURNS) return null;
  const turns: ContinuityTurnView[] = [];
  for (const item of p.turns) {
    if (!item || typeof item !== "object") return null;
    const r = item as Record<string, unknown>;
    if (typeof r.taskId !== "string" || r.taskId.length === 0 || r.taskId.length > 200) {
      return null;
    }
    if (typeof r.turn !== "number" || !Number.isInteger(r.turn) || r.turn < 1) return null;
    if (typeof r.title !== "string") return null;
    if (typeof r.status !== "string") return null;
    if (typeof r.createdAtMs !== "number" || typeof r.updatedAtMs !== "number") return null;
    if (typeof r.compacted !== "boolean" || typeof r.trimmed !== "boolean") return null;
    turns.push({
      taskId: r.taskId,
      turn: r.turn,
      title: r.title.slice(0, CONTINUITY_MAX_TITLE),
      status: r.status.slice(0, 32),
      createdAtMs: r.createdAtMs,
      updatedAtMs: r.updatedAtMs,
      compacted: r.compacted,
      trimmed: r.trimmed,
    });
  }
  // Internal consistency: the host always sends matching counts.
  if (turns.length !== p.chainLength) return null;
  return {
    active: p.active,
    chainLength: p.chainLength,
    currentTaskId: p.currentTaskId,
    turns,
    compacted: p.compacted,
    truncated: p.truncated,
  };
}

// ============================================================================
// Live terminal output (production terminal streaming)
// ----------------------------------------------------------------------------
// Pure boundary for `terminal/output` host messages: strict validation plus
// bounded appends into tool-event view state. App.tsx reduces through these
// helpers (single implementation, unit-tested here) so a hostile or stale
// message can never corrupt the transcript or explode rendering memory.
// ============================================================================

/** One validated live terminal chunk from the host. */
export interface TerminalOutputView {
  toolCallId: string;
  toolName: string;
  stream: "stdout" | "stderr";
  data: string;
  seq: number;
  /** Present when the chunk belongs to an M7 tracked session. */
  sessionId?: string;
}

/** Display cap for one tool's accumulated live output (chars). */
export const MAX_TERMINAL_LIVE_BUFFER = 100_000;

/** Validate a `terminal/output` payload; null when malformed. */
export function validateTerminalOutput(payload: unknown): TerminalOutputView | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.toolCallId !== "string" || p.toolCallId.length === 0 || p.toolCallId.length > 200) {
    return null;
  }
  if (typeof p.toolName !== "string" || p.toolName.length > 120) return null;
  if (p.stream !== "stdout" && p.stream !== "stderr") return null;
  if (typeof p.data !== "string" || p.data.length === 0) return null;
  if (typeof p.seq !== "number" || !Number.isInteger(p.seq) || p.seq < 1) return null;
  // M7 tracked sessions carry an explicit sessionId (validated when present;
  // agent chunks simply omit it).
  if (
    p.sessionId !== undefined &&
    (typeof p.sessionId !== "string" || p.sessionId.length === 0 || p.sessionId.length > 200)
  ) {
    return null;
  }
  return {
    toolCallId: p.toolCallId,
    toolName: p.toolName,
    stream: p.stream,
    // Bound per-chunk data at the boundary (pipe chunks are small, but a
    // compromised host must not be able to push megabytes per event).
    data: p.data.slice(0, 65_536),
    seq: p.seq,
    ...(typeof p.sessionId === "string" ? { sessionId: p.sessionId } : {}),
  };
}

export interface TerminalAppendState {
  output: string;
  outputTruncated: boolean;
  lastSeq: number;
}

/**
 * Append one validated chunk to a tool's live buffer. Out-of-order and
 * duplicate chunks (stale retries, redelivery) are dropped by sequence —
 * the buffer only ever grows with newer data. Returns the new state.
 */
export function appendTerminalOutput(
  prev: TerminalAppendState,
  chunk: TerminalOutputView,
  maxChars: number = MAX_TERMINAL_LIVE_BUFFER,
): TerminalAppendState {
  if (chunk.seq <= prev.lastSeq) return prev;
  const next = prev.output + chunk.data;
  if (next.length <= maxChars) {
    return { output: next, outputTruncated: prev.outputTruncated, lastSeq: chunk.seq };
  }
  // Deterministic truncation: keep a head window plus the newest tail so a
  // capped display still shows how output started and how it ended.
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  const kept = next.slice(0, head) + "\n…[live output truncated]…\n" + next.slice(-tail);
  return { output: kept, outputTruncated: true, lastSeq: chunk.seq };
}

/** Display cap for a completed command's expandable output detail. */
export const MAX_TERMINAL_DETAIL_CHARS = 20_000;

/** Display cap for one M7 tracked session's live output (chars). */
export const MAX_SESSION_LIVE_BUFFER = 60_000;

/**
 * Validate a `terminal/history_result` payload; null when malformed. Every
 * record is bounded at the boundary — a compromised host must not be able
 * to push unbounded history into WebView memory.
 */
export function validateTerminalHistory(
  payload: unknown,
  maxRecords: number = 100,
): TerminalHistoryViewLite[] {
  if (!payload || typeof payload !== "object") return [];
  const rows = (payload as { history?: unknown }).history;
  if (!Array.isArray(rows)) return [];
  const out: TerminalHistoryViewLite[] = [];
  for (const row of rows.slice(-maxRecords)) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.sessionId !== "string" || r.sessionId.length === 0) continue;
    if (typeof r.command !== "string" || r.command.length > 500) continue;
    if (typeof r.status !== "string" || r.status.length > 40) continue;
    out.push({
      sessionId: r.sessionId,
      command: r.command.slice(0, 500),
      args: Array.isArray(r.args)
        ? r.args.filter((a): a is string => typeof a === "string").slice(0, 32)
        : [],
      startedAt: typeof r.startedAt === "number" ? r.startedAt : 0,
      durationMs: typeof r.durationMs === "number" ? r.durationMs : 0,
      status: r.status,
      exitCode: typeof r.exitCode === "number" ? r.exitCode : null,
      timedOut: r.timedOut === true,
      cancelled: r.cancelled === true,
      stdoutTail:
        typeof r.stdoutTail === "string" ? r.stdoutTail.slice(0, 8_192) : "",
      stderrTail:
        typeof r.stderrTail === "string" ? r.stderrTail.slice(0, 8_192) : "",
      outputTruncated: r.outputTruncated === true,
    });
  }
  return out;
}

/** Boundary-safe history record for the WebView (subset, bounded). */
export interface TerminalHistoryViewLite {
  sessionId: string;
  command: string;
  args: string[];
  startedAt: number;
  durationMs: number;
  status: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  stdoutTail: string;
  stderrTail: string;
  outputTruncated: boolean;
}

/** Tool names that render terminal output UI. Mirrors ToolCard matching. */
export function isTerminalToolName(name: string): boolean {
  return (
    name === "execute_command" ||
    name === "run_command" ||
    name === "run_commands" ||
    name === "bash" ||
    name === "terminal"
  );
}

/**
 * Bounded detail text for a completed command tool event. Non-string
 * outputs are JSON-rendered (bounded); everything else yields no detail so
 * non-terminal tools keep their current display exactly.
 */
export function terminalCompletionDetail(
  toolName: string,
  output: unknown,
): { detail?: string } {
  if (!isTerminalToolName(toolName)) return {};
  let text: string;
  if (typeof output === "string") {
    text = output;
  } else if (output === null || output === undefined) {
    return {};
  } else {
    try {
      text = JSON.stringify(output, null, 2) ?? String(output);
    } catch {
      text = String(output);
    }
  }
  if (text.length === 0) return {};
  return {
    detail:
      text.length <= MAX_TERMINAL_DETAIL_CHARS
        ? text
        : `${text.slice(0, MAX_TERMINAL_DETAIL_CHARS)}\n…[output truncated]…`,
  };
}

// ============================================================================
// Skills activation & UX
// ----------------------------------------------------------------------------
// Strict boundary for `skills/*` host messages. Only safe metadata survives:
// ids, names, descriptions, sources, versions, enabled flags, bounded
// previews. Full instructions never enter the WebView; activation is an
// explicit host-side toggle and the model receives skill instructions only
// through the host prompt path (active skills, bounded, M4-gated tools).
// ============================================================================

export interface SkillView {
  id: string;
  name: string;
  description: string;
  source: string;
  version?: string;
  enabled: boolean;
  filePath: string;
  tags: string[];
  appliesTo: string[];
  allowedTools?: string[];
  instructionPreview: string;
  instructionChars: number;
}

export interface SkillsStateView {
  skills: SkillView[];
  activeSkillNames: string[];
  skipped: Array<{ path: string; reason: string }>;
  activeSkillsInContext: string[];
}

const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SKILLS_MAX_ROWS = 100;

function asBoundedStr(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function asStrArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.slice(0, 120))
    .slice(0, 20);
}

/** Validate one skill row; null when unusable (never renders fake rows). */
export function normalizeSkillView(item: unknown): SkillView | null {
  if (!item || typeof item !== "object") return null;
  const t = item as Record<string, unknown>;
  const name = asBoundedStr(t.name, 128);
  if (!SKILL_NAME_PATTERN.test(name)) return null;
  return {
    id: asBoundedStr(t.id ?? name, 128) || name,
    name,
    description: asBoundedStr(t.description, 500),
    source: asBoundedStr(t.source, 32) || "project",
    version:
      typeof t.version === "string" ? t.version.slice(0, 32) : undefined,
    enabled: t.enabled === true,
    filePath: asBoundedStr(t.filePath, 260),
    tags: asStrArray(t.tags),
    appliesTo: asStrArray(t.appliesTo),
    allowedTools: Array.isArray(t.allowedTools)
      ? asStrArray(t.allowedTools)
      : undefined,
    instructionPreview: asBoundedStr(t.instructionPreview, 300),
    instructionChars:
      typeof t.instructionChars === "number" && t.instructionChars >= 0
        ? Math.floor(t.instructionChars)
        : 0,
  };
}

/** Validate a `skills/list_result` / `skills/state` payload; null when malformed. */
export function validateSkillsState(payload: unknown): SkillsStateView | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.skills)) return null;
  if (!Array.isArray(p.activeSkillNames)) return null;
  const skills: SkillView[] = [];
  for (const item of (p.skills as unknown[]).slice(0, SKILLS_MAX_ROWS)) {
    const v = normalizeSkillView(item);
    if (v) skills.push(v);
  }
  const activeSkillNames = (p.activeSkillNames as unknown[])
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.slice(0, 128))
    .slice(0, SKILLS_MAX_ROWS);
  const skipped: Array<{ path: string; reason: string }> = [];
  if (Array.isArray(p.skipped)) {
    for (const item of (p.skipped as unknown[]).slice(0, SKILLS_MAX_ROWS)) {
      if (item && typeof item === "object") {
        const m = item as Record<string, unknown>;
        if (typeof m.reason === "string") {
          skipped.push({
            path: typeof m.path === "string" ? m.path.slice(0, 260) : "",
            reason: m.reason.slice(0, 500),
          });
        }
      }
    }
  }
  const activeSkillsInContext = Array.isArray(p.activeSkillsInContext)
    ? (p.activeSkillsInContext as unknown[])
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.slice(0, 128))
        .slice(0, SKILLS_MAX_ROWS)
    : activeSkillNames;
  return { skills, activeSkillNames, skipped, activeSkillsInContext };
}

/** Validate an outbound skill action before it is posted to the host. */
export function validateSkillAction(
  action: string,
  payload: unknown,
): { ok: boolean; error?: string } {
  const validActions = new Set([
    "skills/list",
    "skills/get",
    "skills/activate",
    "skills/deactivate",
    "skills/state",
  ]);
  if (!validActions.has(action))
    return { ok: false, error: `unknown skill action: ${action}` };
  if (action === "skills/list" || action === "skills/state") return { ok: true };
  const p = (payload ?? {}) as Record<string, unknown>;
  if (!SKILL_NAME_PATTERN.test(String(p.name ?? ""))) {
    return { ok: false, error: "invalid skill name" };
  }
  return { ok: true };
}

/** Validate a `skills/result` / `skills/error` payload; null when malformed. */
export function validateSkillResult(
  payload: unknown,
): { success: boolean; action: string; error?: string; skill?: SkillView } | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.success !== "boolean") return null;
  if (typeof p.action !== "string") return null;
  const out: {
    success: boolean;
    action: string;
    error?: string;
    skill?: SkillView;
  } = { success: p.success, action: p.action.slice(0, 32) };
  if (typeof p.error === "string") out.error = p.error.slice(0, 500);
  if (p.skill !== undefined) {
    const v = normalizeSkillView(p.skill);
    if (v) out.skill = v;
  }
  return out;
}
