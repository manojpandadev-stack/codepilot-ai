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

/** Derive the header connection line from provider state + models. */
export function connectionSummary(
  providers: ProviderInfo[],
  modelCount: number,
): { connected: boolean; label: string } {
  const active = providers.find((p) => p.connected);
  if (active) {
    return {
      connected: true,
      label:
        active.name +
        (modelCount > 0
          ? ` · ${modelCount} model${modelCount !== 1 ? "s" : ""}`
          : ""),
    };
  }
  const ollama = providers.find((p) => p.id === "ollama");
  if (ollama && !ollama.connected) {
    return {
      connected: false,
      label: "Ollama unavailable — start Ollama and refresh",
    };
  }
  return { connected: false, label: "No provider connected" };
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
    });
  }
  return result;
}

// ============================================================================
// Self-healing labels (re-exported from @codepilot/shared for the webview)
// ============================================================================

export {
  healingPhaseLabel,
  healingNextActionLabel,
  describeValidationFailure,
} from "@codepilot/shared";
