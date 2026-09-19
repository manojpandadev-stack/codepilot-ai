import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { DiffViewer, type FileChange } from "./DiffViewer";
import { ChatView } from "./chat/ChatView";
import { ContinuityBar } from "./chat/ContinuityBar";
import { Composer } from "./chat/Composer";
import { ProviderSelector } from "./ProviderSelector";
import { ToolCard } from "./chat/ToolCards";
import {
  AppHeader,
  SideNav,
  StatusBar,
  type NavItem,
  type TabId,
} from "./shell/Shell";
import { ExecutionStatus, HealingOutcome } from "./shell/ExecutionStatus";
import {
  Badge,
  Button,
  Card,
  ConfirmCard,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Select,
  SectionHeader,
  StatusDot,
  Textarea,
  Toggle,
  formatCount,
} from "./lib/ui";
import {
  IconChanges,
  IconChat,
  IconMetrics,
  IconPlugins,
  IconPlus,
  IconRefresh,
  IconSchedule,
  IconSettings,
  IconShield,
  IconTeam,
  IconTerminal,
  IconTools,
  IconHistory,
} from "./lib/icons";
import type {
  Message,
  ToolEvent,
  Settings,
  AutoApproval,
  M4ApprovalRequest,
  TerminalSessionView,
  MetricRow,
  DiffCreatedPayload,
} from "./types";
import {
  applyDiffResult,
  parseSlashCommand,
  SLASH_COMMANDS,
  normalizeModelList,
  normalizeToolList,
  normalizePluginList,
  normalizePluginDetails,
  validatePluginAction,
  pluginTrustMeta,
  selectInstalledPlugins,
  selectAvailablePlugins,
  filterPlugins,
  normalizeTeamList,
  normalizeTeamDetails,
  validateTeamAction,
  teamStatusMeta,
  groupTasksByLevel,
  teamRoleLabel,
  normalizeScheduleList,
  normalizeScheduleDetails,
  validateScheduleAction,
  describeScheduleFrequency,
  scheduleStatusMeta,
  nextRunLabel,
  normalizeDashboard,
  normalizeDiagnosticSummary,
  validateMetricsAction,
  buildDashboardFilterPayload,
  formatMetricValue,
  normalizeTaskHistoryList,
  normalizeTaskDetails,
  validateHistoryAction,
  normalizeRunCompare,
  normalizeCheckpointCompare,
  buildHistoryFilterPayload,
  historyStatusMeta,
  compareVerdictMeta,
  formatTaskDuration,
  connectionSummary,
  privacyClaim,
  normalizeCatalogProviders,
  normalizeProviderStatuses,
  createEmptyComposerContext,
  addFileEntriesToContext,
  addFolderEntriesToContext,
  addUrlToContext,
  setProblemsInContext,
  setSelectionInContext,
  removeContextEntry,
  buildChatSendPayload,
  buildRetryPayload,
  createRequestId,
  validateContinuityState,
  validateTerminalOutput,
  appendTerminalOutput,
  terminalCompletionDetail,
  validateTerminalHistory,
  validateSkillsState,
  validateSkillAction,
  validateSkillResult,
  MAX_SESSION_LIVE_BUFFER,
  type ContinuityStateView,
  type SkillView,
  reduceHealingState,
  type HealingStatusState,
  type DiffResultKind,
  type ModelInfoLite,
  type CatalogProviderLite,
  type ProviderStatusLite,
  type ProviderHealthLite,
  type ProviderUsageLite,
  type ToolRegistryEntry,
  type PluginView,
  type PluginDisplayTrust,
  type PluginManifestProblem,
  type TeamView,
  type TeamTaskView,
  type ScheduleView,
  type ScheduleDetailsView,
  type ScheduleRunView,
  type ScheduleMetrics,
  type DashboardView,
  type DashboardFilter,
  type DiagnosticSummary,
  type TaskSummary,
  type TaskDetails,
  type TaskHistoryFilter,
  type CompareRow,
  type CheckpointCompareView,
} from "./lib/messages.js";
import type { ComposerContext } from "@codepilot/shared";

// ============================================================================
// Types
// ============================================================================

// ============================================================================
// VS Code API Bridge
// ============================================================================

declare function acquireVsCodeApi(): {
  postMessage: (msg: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
};

const vscode =
  typeof acquireVsCodeApi !== "undefined" ? acquireVsCodeApi() : null;

function sendMessage(type: string, payload: unknown) {
  vscode?.postMessage({
    type,
    id: `wv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    payload,
    timestamp: Date.now(),
  });
}

/**
 * Best-effort diff/result classification when the originating action kind
 * was not recorded (e.g. after a webview reload). The host payload shape
 * disambiguates batch operations; single-change results default to "accept"
 * (the non-destructive guess — a misread reject would only leave a stale
 * rollback row, never hide an applied file).
 */
function inferKind(payload: {
  changeId?: string;
  rejected?: number;
  applied?: number;
}): DiffResultKind {
  if (payload.changeId) return "accept";
  if (payload.rejected !== undefined && payload.applied === undefined)
    return "reject_all";
  return "accept_all";
}

// ============================================================================
// M15 Plugin Management UI (presentational — all state is backend-owned)
// ============================================================================

const TRUST_BADGE_CLASS: Record<string, string> = {
  green: "bg-green-900 text-green-200 border-green-700",
  blue: "bg-blue-900 text-blue-200 border-blue-700",
  yellow: "bg-yellow-900 text-yellow-200 border-yellow-700",
  orange: "bg-orange-900 text-orange-200 border-orange-700",
  red: "bg-red-900 text-red-200 border-red-700",
};

function TrustBadge({ trust }: { trust: PluginDisplayTrust }) {
  const meta = pluginTrustMeta(trust);
  return (
    <span
      className={`text-[9px] px-1.5 py-0.5 rounded border font-semibold ${TRUST_BADGE_CLASS[meta.tone] ?? TRUST_BADGE_CLASS.yellow}`}
    >
      {meta.label}
    </span>
  );
}

function PluginSection({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: ReactNode;
}) {
  const items = Array.isArray(children) ? children : [children];
  return (
    <div>
      <div className="text-[11px] font-semibold text-vscode-desc mb-1">
        {title}
      </div>
      {items.length === 0 || (items.length === 1 && !items[0]) ? (
        <p className="text-[10px] text-vscode-desc">{empty}</p>
      ) : (
        <div className="space-y-1">{children}</div>
      )}
    </div>
  );
}

function PluginRow({
  plugin,
  selected,
  onInspect,
  onToggle,
  onUninstall,
  onInstall,
  onEnableUntrusted,
}: {
  plugin: PluginView;
  selected: boolean;
  onInspect: () => void;
  onToggle?: () => void;
  onUninstall?: () => void;
  onInstall?: () => void;
  onEnableUntrusted?: () => void;
}) {
  return (
    <div
      className={`px-2 py-1.5 rounded border text-[11px] ${
        selected
          ? "bg-vscode-input-bg border-vscode-text-link"
          : "bg-vscode-editor-bg border-vscode-border"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={onInspect}
          className="font-mono text-vscode-fg hover:underline truncate text-left"
          title={plugin.description || plugin.id}
        >
          {plugin.name || plugin.id}{" "}
          <span className="text-vscode-desc">v{plugin.version}</span>
        </button>
        <span className="flex items-center gap-1 flex-shrink-0">
          <TrustBadge trust={plugin.displayTrust} />
          {plugin.enabled && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-vscode-btn text-vscode-btn-fg font-semibold">
              ON
            </span>
          )}
        </span>
      </div>
      <div className="text-vscode-desc text-[10px] mt-0.5 truncate">
        {plugin.description || "No description."}
      </div>
      <div className="flex gap-2 mt-1">
        <button
          onClick={onInspect}
          className="text-[10px] text-vscode-btn-fg hover:underline"
        >
          Inspect
        </button>
        {plugin.installed &&
          onToggle &&
          plugin.displayTrust !== "untrusted" && (
            <button
              onClick={onToggle}
              className="text-[10px] text-vscode-btn-fg hover:underline"
            >
              {plugin.enabled ? "Disable" : "Enable"}
            </button>
          )}
        {plugin.installed &&
          plugin.displayTrust === "untrusted" &&
          onEnableUntrusted && (
            <button
              onClick={onEnableUntrusted}
              className="text-[10px] text-orange-300 hover:underline"
            >
              Review & enable
            </button>
          )}
        {!plugin.installed && onInstall && (
          <button
            onClick={onInstall}
            className="text-[10px] text-vscode-btn-fg hover:underline"
          >
            {plugin.displayTrust === "untrusted"
              ? "Review & install"
              : "Install"}
          </button>
        )}
        {plugin.installed && onUninstall && (
          <button
            onClick={onUninstall}
            className="text-[10px] text-red-400 hover:underline"
          >
            Uninstall
          </button>
        )}
      </div>
    </div>
  );
}

function PluginDetailsView({
  plugin,
  invokeTool,
  setInvokeTool,
  invokeArgs,
  setInvokeArgs,
  invokeOutput,
  onInvoke,
  onClose,
  onToggle,
  onUninstall,
  onEnableUntrusted,
  onInstallUntrusted,
  onInstall,
}: {
  plugin: PluginView;
  invokeTool: string;
  setInvokeTool: (v: string) => void;
  invokeArgs: string;
  setInvokeArgs: (v: string) => void;
  invokeOutput: string | null;
  onInvoke: () => void;
  onClose: () => void;
  onToggle: (p: PluginView) => void;
  onUninstall: (p: PluginView) => void;
  onEnableUntrusted: (p: PluginView) => void;
  onInstallUntrusted: (p: PluginView) => void;
  onInstall: (p: PluginView) => void;
}) {
  return (
    <div className="rounded border border-vscode-text-link bg-vscode-editor-bg px-3 py-2">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-[12px] font-semibold text-vscode-fg">
          {plugin.name || plugin.id}{" "}
          <span className="font-mono text-vscode-desc">v{plugin.version}</span>
        </span>
        <span className="flex items-center gap-1">
          <TrustBadge trust={plugin.displayTrust} />
          <button
            aria-label="Close plugin details"
            onClick={onClose}
            className="text-vscode-desc hover:text-vscode-fg text-[11px]"
          >
            ✕
          </button>
        </span>
      </div>
      {plugin.description && (
        <p className="text-[11px] text-vscode-fg mb-2">{plugin.description}</p>
      )}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] mb-2">
        <dt className="text-vscode-desc">Author</dt>
        <dd className="text-vscode-fg truncate">
          {plugin.author || "unknown"}
        </dd>
        <dt className="text-vscode-desc">API version</dt>
        <dd className="text-vscode-fg font-mono">{plugin.apiVersion}</dd>
        <dt className="text-vscode-desc">Trust tier</dt>
        <dd className="text-vscode-fg">{plugin.trustLevel}</dd>
        <dt className="text-vscode-desc">State</dt>
        <dd className="text-vscode-fg">
          {plugin.installed
            ? plugin.enabled
              ? "installed · enabled"
              : "installed · disabled"
            : "discovered · not installed"}
        </dd>
        <dt className="text-vscode-desc">Verification</dt>
        <dd className="text-vscode-fg">
          {plugin.verified ? "manifest valid, API compatible" : "not verified"}
        </dd>
      </dl>

      <div className="text-[10px] font-semibold text-vscode-desc mb-0.5">
        Capabilities ({plugin.capabilities.length})
      </div>
      {plugin.capabilities.length === 0 ? (
        <p className="text-[10px] text-vscode-desc mb-2">
          No capabilities requested.
        </p>
      ) : (
        <div className="space-y-0.5 mb-2">
          {plugin.capabilities.map((c) => (
            <div
              key={c.capability}
              className="flex items-center justify-between text-[10px] font-mono"
            >
              <span className="text-vscode-fg">
                {c.capability}
                {c.sensitive && (
                  <span className="text-orange-300"> ⚠ broad</span>
                )}
              </span>
              <span className="text-vscode-desc">
                {c.permissionLevel}
                {c.requiresApproval ? " · approval" : " · auto"}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="text-[10px] font-semibold text-vscode-desc mb-0.5">
        Tools exposed ({plugin.tools.length})
      </div>
      {plugin.tools.length === 0 ? (
        <p className="text-[10px] text-vscode-desc mb-2">No tools.</p>
      ) : (
        <div className="space-y-0.5 mb-2">
          {plugin.tools.map((t) => (
            <div key={t.registryId} className="text-[10px] font-mono">
              <span className="text-vscode-fg">{t.registryId}</span>{" "}
              <span className="text-vscode-desc">
                {t.registered ? "· registered" : "· not registered"} ·{" "}
                {t.permissionLevel}
                {t.requiresApproval ? " · approval" : ""}
              </span>
              {t.description && (
                <div className="text-vscode-desc">{t.description}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {plugin.warnings.length > 0 && (
        <div className="mb-1.5">
          {plugin.warnings.map((w, i) => (
            <div key={i} className="text-[10px] text-orange-300">
              ⚠ {w}
            </div>
          ))}
        </div>
      )}
      {plugin.errors.length > 0 && (
        <div className="mb-1.5">
          {plugin.errors.map((e, i) => (
            <div key={i} className="text-[10px] text-red-300">
              ✕ {e}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2 mt-2">
        {!plugin.installed && plugin.displayTrust !== "untrusted" && (
          <button
            onClick={() => onInstall(plugin)}
            className="text-[11px] px-3 py-1 rounded bg-vscode-btn text-vscode-btn-fg hover:bg-vscode-btn-hover"
          >
            Install
          </button>
        )}
        {!plugin.installed && plugin.displayTrust === "untrusted" && (
          <button
            onClick={() => onInstallUntrusted(plugin)}
            className="text-[11px] px-3 py-1 rounded bg-orange-800 text-orange-100 hover:bg-orange-700"
          >
            Review & install
          </button>
        )}
        {plugin.installed && plugin.displayTrust !== "untrusted" && (
          <button
            onClick={() => onToggle(plugin)}
            className="text-[11px] px-3 py-1 rounded bg-vscode-btn text-vscode-btn-fg hover:bg-vscode-btn-hover"
          >
            {plugin.enabled ? "Disable" : "Enable"}
          </button>
        )}
        {plugin.installed && plugin.displayTrust === "untrusted" && (
          <button
            onClick={() => onEnableUntrusted(plugin)}
            className="text-[11px] px-3 py-1 rounded bg-orange-800 text-orange-100 hover:bg-orange-700"
          >
            Review & enable
          </button>
        )}
        {plugin.installed && (
          <button
            onClick={() => onUninstall(plugin)}
            className="text-[11px] px-3 py-1 rounded border border-red-800 text-red-400 hover:bg-red-900"
          >
            Uninstall
          </button>
        )}
      </div>

      {plugin.enabled && plugin.tools.some((t) => t.registered) && (
        <div className="mt-2 pt-2 border-t border-vscode-border">
          <div className="text-[10px] font-semibold text-vscode-desc mb-1">
            Execute tool (M4 approval applies)
          </div>
          <div className="flex gap-1.5 mb-1.5">
            <select
              aria-label="Plugin tool to execute"
              value={invokeTool}
              onChange={(e) => setInvokeTool(e.target.value)}
              className="text-[10px] px-1.5 py-1 rounded bg-vscode-input-bg border border-vscode-input-border text-vscode-fg max-w-[45%]"
            >
              <option value="">select tool…</option>
              {plugin.tools
                .filter((t) => t.registered)
                .map((t) => (
                  <option key={t.registryId} value={t.name}>
                    {t.name}
                  </option>
                ))}
            </select>
            <input
              aria-label="Tool arguments as JSON"
              value={invokeArgs}
              onChange={(e) => setInvokeArgs(e.target.value)}
              placeholder='args JSON, e.g. {"path":"src/a.ts"}'
              spellCheck={false}
              className="flex-1 text-[10px] font-mono px-1.5 py-1 rounded bg-vscode-input-bg border border-vscode-input-border text-vscode-fg"
            />
            <button
              onClick={onInvoke}
              disabled={!invokeTool}
              className="text-[10px] px-2 py-1 rounded bg-vscode-btn text-vscode-btn-fg hover:bg-vscode-btn-hover disabled:opacity-50"
            >
              Run
            </button>
          </div>
          {invokeOutput && (
            <pre className="text-[10px] font-mono text-vscode-fg bg-vscode-input-bg rounded p-1.5 overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap break-words">
              {invokeOutput}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// M14 Team (multi-agent) UI (presentational — all state is backend-owned)
// ============================================================================

const TEAM_ROLE_OPTIONS = [
  "architect",
  "coder",
  "tester",
  "security",
  "reviewer",
  "documentation",
] as const;

function TeamStatusBadge({ status }: { status: string }) {
  const meta = teamStatusMeta(status);
  return (
    <span
      className={`text-[9px] px-1.5 py-0.5 rounded border font-semibold ${TRUST_BADGE_CLASS[meta.tone] ?? TRUST_BADGE_CLASS.yellow}`}
    >
      {meta.label}
    </span>
  );
}

function TeamRow({
  team,
  selected,
  onInspect,
  onStart,
  onCancel,
  onRetry,
  onRemove,
}: {
  team: TeamView;
  selected: boolean;
  onInspect: () => void;
  onStart: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const canStart = team.status === "idle" || team.status === "interrupted";
  const canCancel = team.status === "running";
  const canRetry = team.status === "failed" || team.status === "cancelled";
  const canRemove = team.status !== "running";
  return (
    <div
      className={`px-2 py-1.5 rounded border text-[11px] ${
        selected
          ? "bg-vscode-input-bg border-vscode-text-link"
          : "bg-vscode-editor-bg border-vscode-border"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={onInspect}
          className="text-vscode-fg hover:underline truncate text-left"
          title={team.objective}
        >
          {team.objective.length > 80
            ? `${team.objective.slice(0, 77)}…`
            : team.objective}
        </button>
        <span className="flex items-center gap-1 flex-shrink-0">
          <TeamStatusBadge status={team.status} />
        </span>
      </div>
      <div className="text-vscode-desc text-[10px] mt-0.5">
        {team.roles.map((r) => teamRoleLabel(r)).join(" → ")} ·{" "}
        {team.completedCount}✓
        {team.failedCount > 0 ? ` · ${team.failedCount}✗` : ""} · run #
        {team.runCount}
      </div>
      <div className="flex flex-wrap gap-2 mt-1">
        <button
          onClick={onInspect}
          className="text-[10px] text-vscode-btn-fg hover:underline"
        >
          Inspect
        </button>
        {canStart && (
          <button
            onClick={onStart}
            className="text-[10px] text-vscode-btn-fg hover:underline"
          >
            Start
          </button>
        )}
        {canCancel && (
          <button
            onClick={onCancel}
            className="text-[10px] text-orange-300 hover:underline"
          >
            Cancel
          </button>
        )}
        {canRetry && (
          <button
            onClick={onRetry}
            className="text-[10px] text-vscode-btn-fg hover:underline"
          >
            Retry
          </button>
        )}
        {canRemove && (
          <button
            onClick={onRemove}
            className="text-[10px] text-red-400 hover:underline"
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

function TeamTaskRow({
  task,
  expanded,
  onToggle,
}: {
  task: TeamTaskView;
  expanded: boolean;
  onToggle: () => void;
}) {
  const duration =
    task.startedAtMs !== undefined
      ? `${((task.completedAtMs ?? Date.now()) - task.startedAtMs) / 1000}s`
      : null;
  return (
    <div className="rounded bg-vscode-input-bg border border-vscode-border px-2 py-1">
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={onToggle}
          className="text-[11px] text-vscode-fg hover:underline truncate text-left"
          aria-expanded={expanded}
        >
          <span className="font-mono text-vscode-desc">{task.taskId}</span> ·{" "}
          {task.roleLabel}
        </button>
        <span className="flex items-center gap-1 flex-shrink-0">
          <TeamStatusBadge status={task.status} />
        </span>
      </div>
      <div className="text-[10px] text-vscode-desc mt-0.5">
        {task.dependencies.length > 0
          ? `needs ${task.dependencies.join(", ")} · `
          : ""}
        {task.retryCount > 0
          ? `retries ${task.retryCount}/${task.maxRetries} · `
          : ""}
        {duration ? `⏱ ${duration}` : ""}
        {task.conflictWith ? ` · ⚠ locked by ${task.conflictWith}` : ""}
      </div>
      {expanded && (
        <div className="mt-1 pt-1 border-t border-vscode-border text-[10px] space-y-0.5">
          <div className="text-vscode-fg">{task.description}</div>
          {task.files.length > 0 && (
            <div className="font-mono text-vscode-desc break-words">
              files: {task.files.join(", ")}
            </div>
          )}
          {task.dependents.length > 0 && (
            <div className="text-vscode-desc">
              unblocks: {task.dependents.join(", ")}
            </div>
          )}
          {task.startedAtMs !== undefined && (
            <div className="text-vscode-desc">
              {new Date(task.startedAtMs).toLocaleTimeString()}
              {task.completedAtMs !== undefined
                ? ` → ${new Date(task.completedAtMs).toLocaleTimeString()}`
                : " → …"}
            </div>
          )}
          {task.error && <div className="text-red-300">✕ {task.error}</div>}
          {task.resultExcerpt && (
            <div className="text-vscode-fg break-words">
              ✓ {task.resultExcerpt}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TeamDetailsView({
  team,
  expandedTaskId,
  setExpandedTaskId,
  onClose,
  onStart,
  onCancel,
  onRetry,
  onRemove,
}: {
  team: TeamView;
  expandedTaskId: string | null;
  setExpandedTaskId: (v: string | null) => void;
  onClose: () => void;
  onStart: (t: TeamView) => void;
  onCancel: (t: TeamView) => void;
  onRetry: (t: TeamView) => void;
  onRemove: (t: TeamView) => void;
}) {
  const levels = groupTasksByLevel(team.tasks);
  const anyRunning = team.tasks.some((t) => t.status === "running");
  const canStart = team.status === "idle" || team.status === "interrupted";
  const canCancel = team.status === "running";
  const canRetry = team.status === "failed" || team.status === "cancelled";
  const canRemove = team.status !== "running";
  return (
    <div className="rounded border border-vscode-text-link bg-vscode-editor-bg px-3 py-2">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-[12px] font-semibold text-vscode-fg">
          Team detail
        </span>
        <span className="flex items-center gap-1">
          <TeamStatusBadge status={team.status} />
          <button
            aria-label="Close team details"
            onClick={onClose}
            className="text-vscode-desc hover:text-vscode-fg text-[11px]"
          >
            ✕
          </button>
        </span>
      </div>
      <p className="text-[11px] text-vscode-fg mb-1 break-words">
        {team.objective}
      </p>
      <div className="text-[10px] text-vscode-desc mb-2">
        mode {team.mode} · concurrency {team.maxConcurrency} · run #
        {team.runCount}
        {team.runId ? ` · ${team.runId}` : ""} · task record{" "}
        <span className="font-mono">{team.taskId || "—"}</span>
        {team.status === "running" && !anyRunning ? " · planning…" : ""}
      </div>
      {team.error && (
        <div className="text-[10px] text-red-300 mb-1.5">✕ {team.error}</div>
      )}

      <div className="text-[10px] font-semibold text-vscode-desc mb-0.5">
        Dependency graph ({team.tasks.length} agents)
      </div>
      {team.tasks.length === 0 ? (
        <p className="text-[10px] text-vscode-desc mb-2">No agents yet.</p>
      ) : (
        <div className="space-y-1.5 mb-2">
          {levels.map((levelTasks, level) => (
            <div key={level}>
              {level > 0 && (
                <div className="text-center text-vscode-desc text-[10px]">
                  ↓
                </div>
              )}
              <div className="text-[9px] text-vscode-desc mb-0.5">
                {level === 0
                  ? "roots (run first)"
                  : `level ${level}${levelTasks.length > 1 ? " — parallel" : ""}`}
              </div>
              <div className="space-y-1">
                {levelTasks.map((t) => (
                  <TeamTaskRow
                    key={t.taskId}
                    task={t}
                    expanded={expandedTaskId === t.taskId}
                    onToggle={() =>
                      setExpandedTaskId(
                        expandedTaskId === t.taskId ? null : t.taskId,
                      )
                    }
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="text-[10px] font-semibold text-vscode-desc mb-0.5">
        File locks ({team.locks.length})
      </div>
      {team.locks.length === 0 ? (
        <p className="text-[10px] text-vscode-desc mb-2">
          No files currently locked.
        </p>
      ) : (
        <div className="space-y-0.5 mb-2 font-mono text-[10px]">
          {team.locks.map((l) => (
            <div
              key={`${l.file}-${l.holderTaskId}`}
              className="flex justify-between gap-2"
            >
              <span className="text-vscode-fg truncate">🔒 {l.file}</span>
              <span className="text-vscode-desc flex-shrink-0">
                {l.holderRole} ({l.holderTaskId})
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2 mt-1">
        {canStart && (
          <button
            onClick={() => onStart(team)}
            className="text-[11px] px-3 py-1 rounded bg-vscode-btn text-vscode-btn-fg hover:bg-vscode-btn-hover"
          >
            Start
          </button>
        )}
        {canCancel && (
          <button
            onClick={() => onCancel(team)}
            className="text-[11px] px-3 py-1 rounded bg-orange-800 text-orange-100 hover:bg-orange-700"
          >
            Cancel run
          </button>
        )}
        {canRetry && (
          <button
            onClick={() => onRetry(team)}
            className="text-[11px] px-3 py-1 rounded bg-vscode-btn text-vscode-btn-fg hover:bg-vscode-btn-hover"
          >
            Retry failed
          </button>
        )}
        {canRemove && (
          <button
            onClick={() => onRemove(team)}
            className="text-[11px] px-3 py-1 rounded border border-red-800 text-red-400 hover:bg-red-900"
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// M17 Scheduler UI (presentational — all state is backend-owned)
// ============================================================================

function ScheduleStatusBadge({ status }: { status: string }) {
  const meta = scheduleStatusMeta(status);
  return (
    <span
      className={`text-[9px] px-1.5 py-0.5 rounded border font-semibold ${TRUST_BADGE_CLASS[meta.tone] ?? TRUST_BADGE_CLASS.yellow}`}
    >
      {meta.label}
    </span>
  );
}

function ScheduleRow({
  schedule,
  selected,
  onInspect,
  onToggle,
  onRunNow,
  onRemove,
}: {
  schedule: ScheduleView;
  selected: boolean;
  onInspect: () => void;
  onToggle: () => void;
  onRunNow: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className={`px-2 py-1.5 rounded border text-[11px] ${
        selected
          ? "bg-vscode-input-bg border-vscode-text-link"
          : "bg-vscode-editor-bg border-vscode-border"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={onInspect}
          className="text-vscode-fg hover:underline truncate text-left"
          title={schedule.prompt}
        >
          {schedule.name}
        </button>
        <span className="flex items-center gap-1 flex-shrink-0">
          <ScheduleStatusBadge
            status={schedule.enabled ? "enabled" : "disabled"}
          />
          {schedule.liveStatus !== "idle" && (
            <ScheduleStatusBadge status={schedule.liveStatus} />
          )}
        </span>
      </div>
      <div className="text-vscode-desc text-[10px] mt-0.5 truncate">
        {describeScheduleFrequency(schedule)} · next:{" "}
        {nextRunLabel(schedule.nextRunAtMs)}
        {schedule.lastRunStatus ? ` · last: ${schedule.lastRunStatus}` : ""}
        {schedule.runCount > 0 ? ` · ${schedule.runCount} runs` : ""}
      </div>
      <div className="flex flex-wrap gap-2 mt-1">
        <button
          onClick={onInspect}
          className="text-[10px] text-vscode-btn-fg hover:underline"
        >
          Inspect
        </button>
        <button
          onClick={onToggle}
          className="text-[10px] text-vscode-btn-fg hover:underline"
        >
          {schedule.enabled ? "Disable" : "Enable"}
        </button>
        {schedule.enabled && (
          <button
            onClick={onRunNow}
            className="text-[10px] text-vscode-btn-fg hover:underline"
          >
            Run now
          </button>
        )}
        <button
          onClick={onRemove}
          className="text-[10px] text-red-400 hover:underline"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function ScheduleDetailsView({
  details,
  onClose,
  onToggle,
  onRunNow,
  onRemove,
  onEdit,
}: {
  details: ScheduleDetailsView;
  onClose: () => void;
  onToggle: (s: ScheduleView) => void;
  onRunNow: (s: ScheduleView) => void;
  onRemove: (s: ScheduleView) => void;
  onEdit: (s: ScheduleView) => void;
}) {
  const { schedule, history } = details;
  return (
    <div className="rounded border border-vscode-text-link bg-vscode-editor-bg px-3 py-2">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-[12px] font-semibold text-vscode-fg">
          {schedule.name}
        </span>
        <span className="flex items-center gap-1">
          <ScheduleStatusBadge
            status={schedule.enabled ? "enabled" : "disabled"}
          />
          {schedule.liveStatus !== "idle" && (
            <ScheduleStatusBadge status={schedule.liveStatus} />
          )}
          <button
            aria-label="Close schedule details"
            onClick={onClose}
            className="text-vscode-desc hover:text-vscode-fg text-[11px]"
          >
            ✕
          </button>
        </span>
      </div>
      <p className="text-[11px] text-vscode-fg mb-1 break-words">
        {schedule.prompt}
      </p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] mb-2">
        <dt className="text-vscode-desc">Schedule</dt>
        <dd className="text-vscode-fg font-mono">
          {describeScheduleFrequency(schedule)}
        </dd>
        <dt className="text-vscode-desc">Next run</dt>
        <dd className="text-vscode-fg">
          {schedule.nextRunAtMs
            ? new Date(schedule.nextRunAtMs).toLocaleString()
            : "—"}
        </dd>
        <dt className="text-vscode-desc">Last run</dt>
        <dd className="text-vscode-fg">
          {schedule.lastRunAtMs
            ? new Date(schedule.lastRunAtMs).toLocaleString()
            : "—"}
          {schedule.lastRunStatus ? ` (${schedule.lastRunStatus})` : ""}
        </dd>
        <dt className="text-vscode-desc">Retries</dt>
        <dd className="text-vscode-fg">max {schedule.maxRetries}</dd>
        <dt className="text-vscode-desc">Missed runs</dt>
        <dd className="text-vscode-fg">{schedule.missedRunPolicy}</dd>
        <dt className="text-vscode-desc">Runs</dt>
        <dd className="text-vscode-fg">
          {schedule.runCount} total · {schedule.successCount}✓ ·{" "}
          {schedule.failedCount}✗
        </dd>
      </dl>

      <div className="text-[10px] font-semibold text-vscode-desc mb-0.5">
        Execution history ({history.length})
      </div>
      {history.length === 0 ? (
        <p className="text-[10px] text-vscode-desc mb-2">
          No executions recorded yet.
        </p>
      ) : (
        <div className="space-y-0.5 mb-2 max-h-48 overflow-y-auto">
          {history.map((r, i) => (
            <div
              key={`${r.startedAtMs}-${i}`}
              className="text-[10px] rounded bg-vscode-input-bg border border-vscode-border px-1.5 py-1"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-vscode-desc">
                  {new Date(r.startedAtMs).toLocaleString()}
                  {r.durationMs !== undefined
                    ? ` · ${(r.durationMs / 1000).toFixed(1)}s`
                    : ""}
                  {r.attempt > 1 ? ` · attempt ${r.attempt}` : ""}
                </span>
                <ScheduleStatusBadge status={r.status} />
              </div>
              {r.error && (
                <div className="text-red-300 break-words">✕ {r.error}</div>
              )}
              {r.outputExcerpt && (
                <div className="text-vscode-fg break-words">
                  ✓ {r.outputExcerpt}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2 mt-1">
        <button
          onClick={() => onEdit(schedule)}
          className="text-[11px] px-3 py-1 rounded bg-vscode-btn text-vscode-btn-fg hover:bg-vscode-btn-hover"
        >
          Edit
        </button>
        <button
          onClick={() => onToggle(schedule)}
          className="text-[11px] px-3 py-1 rounded bg-vscode-btn text-vscode-btn-fg hover:bg-vscode-btn-hover"
        >
          {schedule.enabled ? "Disable" : "Enable"}
        </button>
        {schedule.enabled && (
          <button
            onClick={() => onRunNow(schedule)}
            className="text-[11px] px-3 py-1 rounded bg-vscode-btn text-vscode-btn-fg hover:bg-vscode-btn-hover"
          >
            Run now
          </button>
        )}
        <button
          onClick={() => onRemove(schedule)}
          className="text-[11px] px-3 py-1 rounded border border-red-800 text-red-400 hover:bg-red-900"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// M12/M5 Task history UI (presentational — all state is backend-owned)
// ============================================================================

function HistoryStatusBadge({ status }: { status: string }) {
  const meta = historyStatusMeta(status);
  return (
    <span
      className={`text-[9px] px-1.5 py-0.5 rounded border font-semibold ${TRUST_BADGE_CLASS[meta.tone] ?? TRUST_BADGE_CLASS.yellow}`}
    >
      {meta.label}
    </span>
  );
}

function VerdictBadge({ verdict }: { verdict: string }) {
  const meta = compareVerdictMeta(verdict);
  return (
    <span
      className={`text-[9px] px-1.5 py-0.5 rounded border font-semibold ${TRUST_BADGE_CLASS[meta.tone] ?? TRUST_BADGE_CLASS.yellow}`}
    >
      {meta.label}
    </span>
  );
}

function HistorySection({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="rounded border border-vscode-border bg-vscode-editor-bg">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-2 py-1 text-[11px] font-semibold text-vscode-fg hover:bg-vscode-input-bg"
      >
        <span>
          {open ? "▾" : "▸"} {title}
        </span>
      </button>
      {open && <div className="px-2 pb-2">{children}</div>}
    </div>
  );
}

function TaskHistoryRow({
  task,
  selected,
  compareChecked,
  onCompareToggle,
  onInspect,
  onResume,
  onRestart,
  onDiscard,
}: {
  task: TaskSummary;
  selected: boolean;
  compareChecked: boolean;
  onCompareToggle: () => void;
  onInspect: () => void;
  onResume: () => void;
  onRestart: () => void;
  onDiscard: () => void;
}) {
  const terminal =
    task.status === "completed" ||
    task.status === "failed" ||
    task.status === "cancelled" ||
    task.status === "interrupted" ||
    task.status === "archived";
  return (
    <div
      className={`px-2 py-1.5 rounded border text-[11px] ${
        selected
          ? "bg-vscode-input-bg border-vscode-text-link"
          : "bg-vscode-editor-bg border-vscode-border"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={onInspect}
          className="text-vscode-fg hover:underline truncate text-left"
          title={task.promptExcerpt || task.title}
        >
          {task.title.length > 70 ? `${task.title.slice(0, 67)}…` : task.title}
        </button>
        <span className="flex items-center gap-1 flex-shrink-0">
          <HistoryStatusBadge status={task.status} />
        </span>
      </div>
      <div className="text-vscode-desc text-[10px] mt-0.5">
        {new Date(task.createdAtMs).toLocaleString()}
        {task.durationMs !== undefined
          ? ` · ${formatTaskDuration(task.durationMs)}`
          : ""}
        {task.toolCallCount > 0 ? ` · 🔧${task.toolCallCount}` : ""}
        {task.filesChangedCount > 0 ? ` · 📝${task.filesChangedCount}` : ""}
        {task.checkpointCount > 0 ? ` · 💾${task.checkpointCount}` : ""}
        {task.hasErrors ? " · ⚠ errors" : ""}
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-1">
        <button
          onClick={onInspect}
          className="text-[10px] text-vscode-btn-fg hover:underline"
        >
          Inspect
        </button>
        {(task.status === "interrupted" ||
          task.status === "running" ||
          task.status === "failed") && (
          <button
            onClick={onResume}
            className="text-[10px] text-vscode-btn-fg hover:underline"
          >
            Resume
          </button>
        )}
        {terminal && (
          <button
            onClick={onRestart}
            className="text-[10px] text-vscode-btn-fg hover:underline"
          >
            Restart
          </button>
        )}
        {terminal && (
          <button
            onClick={onDiscard}
            className="text-[10px] text-red-400 hover:underline"
          >
            Discard
          </button>
        )}
        <label className="flex items-center gap-1 text-[10px] text-vscode-desc ml-auto">
          <input
            type="checkbox"
            checked={compareChecked}
            onChange={onCompareToggle}
            aria-label={`Select ${task.id} for comparison`}
          />
          compare
        </label>
      </div>
    </div>
  );
}

function HistoryDetailsView({
  details,
  sections,
  onToggleSection,
  onClose,
  onResume,
  onRestart,
  onDiscard,
  onRestore,
  compareSelect,
  runCompare,
  cpCompareSelect,
  onCpCompareToggle,
  onCpCompare,
  cpCompare,
}: {
  details: TaskDetails;
  sections: Record<string, boolean>;
  onToggleSection: (s: string) => void;
  onClose: () => void;
  onResume: () => void;
  onRestart: () => void;
  onDiscard: () => void;
  onRestore: (checkpointId: string) => void;
  compareSelect: string[];
  runCompare: { aTaskId: string; bTaskId: string; rows: CompareRow[] } | null;
  cpCompareSelect: string[];
  onCpCompareToggle: (checkpointId: string) => void;
  onCpCompare: () => void;
  cpCompare: CheckpointCompareView | null;
}) {
  const fileGroups: Array<{
    label: string;
    entries: TaskDetails["files"]["created"];
  }> = [
    {
      label: `Created (${details.files.created.length})`,
      entries: details.files.created,
    },
    {
      label: `Modified (${details.files.modified.length})`,
      entries: details.files.modified,
    },
    {
      label: `Deleted (${details.files.deleted.length})`,
      entries: details.files.deleted,
    },
    {
      label: `Renamed/moved (${details.files.renamed.length})`,
      entries: details.files.renamed,
    },
  ];
  const canResume =
    details.status === "interrupted" ||
    details.status === "running" ||
    details.status === "failed";
  const terminal = details.status !== "running";
  return (
    <div className="rounded border border-vscode-text-link bg-vscode-editor-bg px-3 py-2 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-semibold text-vscode-fg truncate">
          {details.title}
        </span>
        <span className="flex items-center gap-1 flex-shrink-0">
          <HistoryStatusBadge status={details.status} />
          <button
            aria-label="Close task details"
            onClick={onClose}
            className="text-vscode-desc hover:text-vscode-fg text-[11px]"
          >
            ✕
          </button>
        </span>
      </div>

      {details.interruption && (
        <div className="rounded border border-orange-800 bg-orange-950 px-2 py-1.5 text-[10px]">
          <div className="font-semibold text-orange-300 mb-0.5">
            ⏸ Interrupted{" "}
            {new Date(details.interruption.interruptedAtMs).toLocaleString()} —
            last phase: {details.interruption.lastPhase}
          </div>
          <div className="text-orange-200/90">
            {details.interruption.pendingSummary}
          </div>
          {details.interruption.error && (
            <div className="text-red-300 mt-0.5">
              ✕ {details.interruption.error}
            </div>
          )}
          <div className="text-orange-200/70 mt-0.5">
            {details.interruption.filesChanged.length > 0
              ? `Changed: ${details.interruption.filesChanged.slice(0, 5).join(", ")}${details.interruption.filesChanged.length > 5 ? "…" : ""} · `
              : ""}
            {details.interruption.checkpointsAvailable} checkpoint(s) available
          </div>
        </div>
      )}

      <HistorySection
        title="SUMMARY"
        open={sections.summary ?? true}
        onToggle={() => onToggleSection("summary")}
      >
        <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
          <dt className="text-vscode-desc">Task ID</dt>
          <dd className="text-vscode-fg font-mono truncate">{details.id}</dd>
          <dt className="text-vscode-desc">Session</dt>
          <dd className="text-vscode-fg font-mono truncate">
            {details.sessionId ?? "—"}
          </dd>
          <dt className="text-vscode-desc">Provider / model</dt>
          <dd className="text-vscode-fg truncate">
            {details.provider ?? "—"} / {details.model ?? "—"}
          </dd>
          <dt className="text-vscode-desc">Mode</dt>
          <dd className="text-vscode-fg">{details.mode ?? "—"}</dd>
          <dt className="text-vscode-desc">Created / updated</dt>
          <dd className="text-vscode-fg">
            {new Date(details.createdAtMs).toLocaleString()}
          </dd>
          <dt className="text-vscode-desc">Duration</dt>
          <dd className="text-vscode-fg">
            {formatTaskDuration(details.durationMs)}
          </dd>
          <dt className="text-vscode-desc">Prompt</dt>
          <dd className="text-vscode-fg break-words">
            {details.promptExcerpt || "—"}
          </dd>
          {details.resultExcerpt && (
            <>
              <dt className="text-vscode-desc">Final result</dt>
              <dd className="text-vscode-fg break-words">
                {details.resultExcerpt}
              </dd>
            </>
          )}
        </dl>
      </HistorySection>

      <HistorySection
        title={`TIMELINE (${details.timeline.length})`}
        open={sections.timeline ?? true}
        onToggle={() => onToggleSection("timeline")}
      >
        {details.timeline.length === 0 ? (
          <p className="text-[10px] text-vscode-desc">No timeline events.</p>
        ) : (
          <div className="space-y-0.5 max-h-56 overflow-y-auto">
            {details.timeline.map((e, i) => (
              <div key={i} className="flex gap-2 text-[10px]">
                <span className="text-vscode-desc flex-shrink-0 font-mono">
                  {new Date(e.timestampMs).toLocaleTimeString()}
                </span>
                <span className="text-vscode-btn-fg flex-shrink-0 w-20 truncate">
                  {e.phase}
                </span>
                <span className="text-vscode-fg break-words">{e.summary}</span>
              </div>
            ))}
          </div>
        )}
      </HistorySection>

      <HistorySection
        title={`FILES (+${details.files.totalAdditions}/-${details.files.totalDeletions})`}
        open={sections.files ?? false}
        onToggle={() => onToggleSection("files")}
      >
        {fileGroups.every((g) => g.entries.length === 0) ? (
          <p className="text-[10px] text-vscode-desc">
            No file changes recorded.
          </p>
        ) : (
          fileGroups.map(
            (g) =>
              g.entries.length > 0 && (
                <div key={g.label} className="mb-1">
                  <div className="text-[10px] font-semibold text-vscode-desc">
                    {g.label}
                  </div>
                  {g.entries.map((f) => (
                    <div key={f.path} className="text-[10px] font-mono mt-0.5">
                      <span className="text-vscode-fg break-words">
                        {f.path}
                      </span>{" "}
                      <span className="text-vscode-desc">
                        {f.binary
                          ? "binary"
                          : `+${f.additions}/-${f.deletions}`}{" "}
                        · {f.status}
                      </span>
                      {f.diffExcerpt && !f.binary && (
                        <pre className="text-[9px] bg-vscode-input-bg rounded p-1 mt-0.5 overflow-x-auto max-h-28 overflow-y-auto whitespace-pre-wrap break-words">
                          {f.diffExcerpt}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              ),
          )
        )}
      </HistorySection>

      <HistorySection
        title={`CHECKPOINTS (${details.checkpoints.length})`}
        open={sections.checkpoints ?? false}
        onToggle={() => onToggleSection("checkpoints")}
      >
        {details.checkpoints.length === 0 ? (
          <p className="text-[10px] text-vscode-desc">
            No checkpoints for this task.
          </p>
        ) : (
          <div className="space-y-1">
            {details.checkpoints.map((cp) => (
              <div
                key={cp.checkpointId}
                className="rounded bg-vscode-input-bg border border-vscode-border px-1.5 py-1 text-[10px]"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-vscode-fg truncate">
                    {new Date(cp.timestamp).toLocaleString()} —{" "}
                    {cp.description || cp.checkpointId}
                  </span>
                  <span className="text-vscode-desc flex-shrink-0">
                    {cp.fileCount} files · {cp.status}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 mt-0.5">
                  <label className="flex items-center gap-1 text-vscode-desc">
                    <input
                      type="checkbox"
                      checked={cpCompareSelect.includes(cp.checkpointId)}
                      onChange={() => onCpCompareToggle(cp.checkpointId)}
                      aria-label={`Select checkpoint ${cp.checkpointId} for comparison`}
                    />
                    compare
                  </label>
                  <button
                    onClick={() => onRestore(cp.checkpointId)}
                    className="text-vscode-btn-fg hover:underline"
                  >
                    Restore
                  </button>
                </div>
              </div>
            ))}
            {cpCompareSelect.length === 2 && (
              <button
                onClick={onCpCompare}
                className="text-[10px] px-2 py-0.5 rounded bg-vscode-btn text-vscode-btn-fg hover:bg-vscode-btn-hover"
              >
                Compare selected checkpoints
              </button>
            )}
            {cpCompareSelect.length > 2 && (
              <p className="text-[10px] text-orange-300">
                Select exactly two checkpoints to compare.
              </p>
            )}
          </div>
        )}
        {cpCompare && (
          <div className="mt-1.5 rounded border border-vscode-border p-1.5 text-[10px]">
            <div className="font-semibold text-vscode-fg mb-0.5">
              Compare: {cpCompare.aId.slice(0, 12)}… →{" "}
              {cpCompare.bId.slice(0, 12)}…
              {cpCompare.truncated ? " (truncated)" : ""}
            </div>
            <div className="text-vscode-desc">
              +{cpCompare.added.length} added · −{cpCompare.removed.length}{" "}
              removed · ~{cpCompare.modified.length} modified ·{" "}
              {cpCompare.renamed.length} renamed · {cpCompare.unchanged}{" "}
              unchanged
            </div>
            {cpCompare.renamed.length > 0 && (
              <div className="text-vscode-fg mt-0.5">
                {cpCompare.renamed.map((r) => (
                  <div key={`${r.from}→${r.to}`}>
                    ⇄ {r.from} → {r.to}
                  </div>
                ))}
              </div>
            )}
            {cpCompare.diffs.slice(0, 6).map((d) => (
              <div key={d.path} className="mt-1">
                <div className="font-mono text-vscode-fg break-words">
                  {d.path} ({d.operation}
                  {d.binary ? ", binary" : `, +${d.additions}/-${d.deletions}`})
                </div>
                {d.unifiedDiff && (
                  <pre className="font-mono bg-vscode-input-bg rounded p-1 mt-0.5 overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap break-words">
                    {d.unifiedDiff}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </HistorySection>

      <HistorySection
        title={`RUN COMPARE ${runCompare ? `(${runCompare.aTaskId.slice(0, 8)}… vs ${runCompare.bTaskId.slice(0, 8)}…)` : ""}`}
        open={sections.runs ?? false}
        onToggle={() => onToggleSection("runs")}
      >
        <p className="text-[10px] text-vscode-desc mb-1">
          Tick “compare” on two tasks in the list, then compare. Quality
          verdicts are never invented — unmeasurable outcomes report UNKNOWN.
        </p>
        {runCompare ? (
          <div className="space-y-0.5">
            {runCompare.rows.map((r) => (
              <div
                key={r.metric}
                className="flex items-center justify-between gap-2 text-[10px]"
              >
                <span className="text-vscode-desc w-20 flex-shrink-0">
                  {r.metric}
                </span>
                <span className="text-vscode-fg truncate" title={r.a}>
                  {r.a}
                </span>
                <span className="text-vscode-desc">↔</span>
                <span className="text-vscode-fg truncate" title={r.b}>
                  {r.b}
                </span>
                <VerdictBadge verdict={r.verdict} />
              </div>
            ))}
            {runCompare.rows.some((r) => r.note) && (
              <div className="text-[9px] text-vscode-desc mt-1">
                {runCompare.rows
                  .filter((r) => r.note)
                  .map((r) => (
                    <div key={r.metric}>
                      * {r.metric}: {r.note}
                    </div>
                  ))}
              </div>
            )}
          </div>
        ) : (
          <p className="text-[10px] text-vscode-desc">
            {compareSelect.length === 0
              ? "No tasks selected."
              : compareSelect.length === 1
                ? "Select one more task."
                : "Ready — press Compare selected below the list."}
          </p>
        )}
      </HistorySection>

      <HistorySection
        title={`TOOLS (${details.tools.length})`}
        open={sections.tools ?? false}
        onToggle={() => onToggleSection("tools")}
      >
        {details.tools.length === 0 ? (
          <p className="text-[10px] text-vscode-desc">
            No per-tool data recorded for this task.
          </p>
        ) : (
          <div className="space-y-0.5 font-mono text-[10px]">
            {details.tools.map((t) => (
              <div key={t.name} className="flex justify-between gap-2">
                <span className="text-vscode-fg truncate">
                  {t.name} ×{t.count}
                </span>
                <span className="text-vscode-desc flex-shrink-0">
                  {(t.totalDurationMs / 1000).toFixed(1)}s
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="text-[9px] text-vscode-desc mt-1">
          {details.approvalsNote}
        </p>
      </HistorySection>

      <HistorySection
        title={`ERRORS (${details.errors.length})`}
        open={sections.errors ?? false}
        onToggle={() => onToggleSection("errors")}
      >
        {details.errors.length === 0 ? (
          <p className="text-[10px] text-vscode-desc">No errors recorded.</p>
        ) : (
          details.errors.map((e, i) => (
            <div key={i} className="text-[10px] text-red-300 break-words">
              ✕ {e}
            </div>
          ))
        )}
      </HistorySection>

      <HistorySection
        title="METRICS"
        open={sections.metrics ?? false}
        onToggle={() => onToggleSection("metrics")}
      >
        <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
          <dt className="text-vscode-desc">Tool calls</dt>
          <dd className="text-vscode-fg">{details.metrics.toolCallCount}</dd>
          <dt className="text-vscode-desc">Retries</dt>
          <dd className="text-vscode-fg">{details.metrics.retryCount}</dd>
          <dt className="text-vscode-desc">Files changed</dt>
          <dd className="text-vscode-fg">
            {details.metrics.filesChangedCount}
          </dd>
          <dt className="text-vscode-desc">Checkpoints</dt>
          <dd className="text-vscode-fg">{details.metrics.checkpointCount}</dd>
          <dt className="text-vscode-desc">Messages</dt>
          <dd className="text-vscode-fg">{details.metrics.messageCount}</dd>
        </dl>
      </HistorySection>

      <div className="flex flex-wrap gap-2">
        {canResume && (
          <button
            onClick={onResume}
            className="text-[11px] px-3 py-1 rounded bg-vscode-btn text-vscode-btn-fg hover:bg-vscode-btn-hover"
          >
            Resume
          </button>
        )}
        {terminal && (
          <button
            onClick={onRestart}
            className="text-[11px] px-3 py-1 rounded bg-vscode-btn text-vscode-btn-fg hover:bg-vscode-btn-hover"
          >
            Restart
          </button>
        )}
        {terminal && (
          <button
            onClick={onDiscard}
            className="text-[11px] px-3 py-1 rounded border border-red-800 text-red-400 hover:bg-red-900"
          >
            Discard
          </button>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// M18 Metrics dashboard UI (presentational — all state is backend-owned)
// ============================================================================

function MetricCard({
  metric,
}: {
  metric: import("./lib/messages.js").DashboardMetricValue;
}) {
  const muted = metric.value === null;
  return (
    <div
      className={`px-2 py-1.5 rounded border ${
        muted
          ? "bg-vscode-editor-bg border-vscode-border opacity-70"
          : "bg-vscode-input-bg border-vscode-border"
      }`}
      title={
        muted
          ? (metric.unavailableReason ?? "unavailable")
          : `${metric.scope === "session" ? "Session total" : "In range"}`
      }
    >
      <div className="text-[9px] text-vscode-desc truncate">{metric.label}</div>
      <div
        className={`text-[14px] font-semibold ${muted ? "text-vscode-desc" : "text-vscode-fg"}`}
      >
        {formatMetricValue(metric)}
      </div>
      {muted && metric.unavailableReason && (
        <div className="text-[8px] text-vscode-desc truncate">
          {metric.unavailableReason}
        </div>
      )}
    </div>
  );
}

function DashboardSection({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="rounded border border-vscode-border bg-vscode-editor-bg">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-2 py-1 text-[11px] font-semibold text-vscode-fg hover:bg-vscode-input-bg"
      >
        <span>
          {open ? "▾" : "▸"} {title}
        </span>
      </button>
      {open && <div className="px-2 pb-2">{children}</div>}
    </div>
  );
}

// ============================================================================
// App
// ============================================================================

export function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [input, setInput] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [settings, setSettings] = useState<Settings>({
    provider: "ollama",
    model: "qwen3:8b",
    privacyMode: "local",
    agentMode: "act",
    temperature: 0.7,
    baseUrl: "http://localhost:11434",
  });
  // Mirrors `settings` for the long-lived message listener (stale closures
  // cannot read fresh state from useCallback closures there).
  const settingsRef = useRef(settings);
  const [autoApproval, setAutoApproval] = useState<AutoApproval>({
    readFiles: true,
    editFiles: false,
    executeCommands: false,
    webFetch: false,
    mcpServers: false,
    browser: false,
    maxAutoApprovals: 10,
  });
  const [currentTab, setCurrentTab] = useState<TabId>("chat");
  // Sidebar collapse (icon-only navigation on narrow panels).
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [sessions, setSessions] = useState<
    Array<{ id: string; title?: string; updatedAt?: number }>
  >([]);
  const [checkpoints, setCheckpoints] = useState<
    Array<{
      id: string;
      taskId: string;
      description?: string;
      timestamp: number;
      fileCount: number;
    }>
  >([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [toolRegistry, setToolRegistry] = useState<ToolRegistryEntry[]>([]);
  const [lastPrompt, setLastPrompt] = useState("");
  // Composer context: structured attachments separate from user text.
  const [composerContext, setComposerContext] = useState<ComposerContext>(
    createEmptyComposerContext(),
  );
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [usage, setUsage] = useState<{
    inputTokens: number;
    outputTokens: number;
    totalCost?: number;
  } | null>(null);
  const [fileChanges, setFileChanges] = useState<FileChange[]>([]);
  const [pendingApproval, setPendingApproval] = useState(false);
  const [mcpApprovals, setMcpApprovals] = useState<
    Array<{
      requestId: string;
      serverName: string;
      toolName: string;
      arguments: Record<string, unknown>;
      riskLevel: string;
    }>
  >([]);
  // M4 approval cards (tool/request_approval from the live permission path).
  const [m4Approvals, setM4Approvals] = useState<M4ApprovalRequest[]>([]);
  // M7 terminal sessions shown in the Terminal activity section.
  const [terminalHistory, setTerminalHistory] = useState<
    ReturnType<typeof validateTerminalHistory>
  >([]);
  const [terminalSessions, setTerminalSessions] = useState<
    TerminalSessionView[]
  >([]);
  // M18 metrics snapshot (shown in the settings tab debug section).
  const [metricsRows, setMetricsRows] = useState<MetricRow[]>([]);
  // MCP server configs (from mcp/servers/list_result).
  const [mcpServers, setMcpServers] = useState<
    Array<{
      name: string;
      transport: string;
      enabled: boolean;
      status?: string;
      toolCount: number;
      lastError?: string;
    }>
  >([]);
  // New-MCP-server form state (settings tab).
  const [mcpForm, setMcpForm] = useState<{
    name: string;
    transport: "stdio" | "sse" | "streamable-http";
    command: string;
    args: string;
    url: string;
  }>({ name: "", transport: "stdio", command: "", args: "", url: "" });
  // M17 schedules (backend-authoritative; event-driven updates, no polling).
  const [schedules, setSchedules] = useState<ScheduleView[]>([]);
  const [scheduleHistory, setScheduleHistory] = useState<ScheduleRunView[]>([]);
  const [scheduleMetrics, setScheduleMetrics] = useState<ScheduleMetrics>({
    total: 0,
    success: 0,
    failed: 0,
    running: 0,
    queued: 0,
  });
  const [schedulesLoading, setSchedulesLoading] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(
    null,
  );
  const [scheduleDetails, setScheduleDetails] =
    useState<ScheduleDetailsView | null>(null);
  const [scheduleForm, setScheduleForm] = useState<{
    name: string;
    prompt: string;
    kind: "interval" | "daily" | "once";
    everyMinutes: string;
    dailyAt: string;
    timezone: string;
    atIso: string;
    maxRetries: string;
    enabled: boolean;
  }>({
    name: "",
    prompt: "",
    kind: "interval",
    everyMinutes: "60",
    dailyAt: "09:00",
    timezone: "",
    atIso: "",
    maxRetries: "0",
    enabled: true,
  });
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(
    null,
  );
  const [scheduleConfirm, setScheduleConfirm] = useState<{
    action: "remove" | "run-now";
    schedule: ScheduleView;
  } | null>(null);
  // M18 dashboard (backend-aggregated; event-driven refresh, no polling).
  const [dashboard, setDashboard] = useState<DashboardView | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [dashboardFilter, setDashboardFilter] = useState<DashboardFilter>({
    range: "all",
    status: "all",
    provider: "",
    model: "",
    mode: "all",
  });
  const [exported, setExported] = useState<DiagnosticSummary | null>(null);
  const [copied, setCopied] = useState(false);
  const [metricsSections, setMetricsSections] = useState<
    Record<string, boolean>
  >({
    overview: true,
    performance: true,
  });
  // Task history (backend-authoritative M12/M5 views; event-driven refresh).
  const [taskHistory, setTaskHistory] = useState<TaskSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyFilter, setHistoryFilter] = useState<TaskHistoryFilter>({
    query: "",
    status: "all",
    provider: "",
    model: "",
    mode: "all",
    flag: "all",
  });
  const [selectedHistoryTaskId, setSelectedHistoryTaskId] = useState<
    string | null
  >(null);
  const [historyDetails, setHistoryDetails] = useState<TaskDetails | null>(
    null,
  );
  const [historySections, setHistorySections] = useState<
    Record<string, boolean>
  >({
    summary: true,
    timeline: true,
  });
  const [compareSelect, setCompareSelect] = useState<string[]>([]);
  const [runCompare, setRunCompare] = useState<{
    aTaskId: string;
    bTaskId: string;
    rows: CompareRow[];
  } | null>(null);
  const [cpCompareSelect, setCpCompareSelect] = useState<string[]>([]);
  const [cpCompare, setCpCompare] = useState<CheckpointCompareView | null>(
    null,
  );
  const [historyConfirm, setHistoryConfirm] = useState<{
    action: "discard" | "restore" | "restart";
    taskId: string;
    checkpointId?: string;
    title: string;
  } | null>(null);
  // M15 plugins (full management tab; backend is the source of truth).
  const [plugins, setPlugins] = useState<PluginView[]>([]);
  const [pluginProblems, setPluginProblems] = useState<PluginManifestProblem[]>(
    [],
  );
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [pluginError, setPluginError] = useState<string | null>(null);
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  const [pluginDetails, setPluginDetails] = useState<PluginView | null>(null);
  const [pluginQuery, setPluginQuery] = useState("");
  const [pluginTrustFilter, setPluginTrustFilter] = useState<
    "all" | PluginDisplayTrust
  >("all");
  const [pluginConfirm, setPluginConfirm] = useState<{
    action: "uninstall" | "enable-untrusted" | "install-untrusted";
    plugin: PluginView;
  } | null>(null);
  const [invokeTool, setInvokeTool] = useState<string>("");
  const [invokeArgs, setInvokeArgs] = useState<string>("{}");
  const [invokeOutput, setInvokeOutput] = useState<string | null>(null);
  // Skills activation & UX (backend-authoritative; active-only injection).
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [activeSkillNames, setActiveSkillNames] = useState<string[]>([]);
  const [skillsSkipped, setSkillsSkipped] = useState<
    Array<{ path: string; reason: string }>
  >([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [skillNotice, setSkillNotice] = useState<string | null>(null);
  const [skillQuery, setSkillQuery] = useState("");
  const [selectedSkillName, setSelectedSkillName] = useState<string | null>(
    null,
  );
  // M14 teams (backend-authoritative; event-driven updates, no polling).
  const [teams, setTeams] = useState<TeamView[]>([]);
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [teamDetails, setTeamDetails] = useState<TeamView | null>(null);
  const [selectedTeamTaskId, setSelectedTeamTaskId] = useState<string | null>(
    null,
  );
  const [teamForm, setTeamForm] = useState<{
    objective: string;
    roles: string[];
    maxConcurrency: number;
  }>({ objective: "", roles: [], maxConcurrency: 2 });
  const [teamConfirm, setTeamConfirm] = useState<{
    action: "cancel" | "remove" | "retry";
    team: TeamView;
  } | null>(null);
  const [streamingText, setStreamingText] = useState("");
  // Mirrors streamingText for use inside the (long-lived) message listener —
  // reading state inside the handler sees a stale closure and can DROP the
  // final delta when "completed" arrives in the same tick as the last chunk.
  const streamingTextRef = useRef("");
  // Mirrors the selected plugin id for refresh-after-mutation inside the
  // (long-lived) message listener.
  const selectedPluginRef = useRef<string | null>(null);
  // Mirrors the selected team id for refresh-after-mutation inside the
  // (long-lived) message listener.
  const selectedTeamRef = useRef<string | null>(null);
  // Mirrors the selected schedule id for refresh-after-mutation inside the
  // (long-lived) message listener.
  const selectedScheduleRef = useRef<string | null>(null);
  // Mirrors the selected history task id for refresh-after-mutation inside
  // the (long-lived) message listener.
  const selectedHistoryTaskRef = useRef<string | null>(null);
  // Mirrors the history filter for refresh-after-mutation inside the
  // (long-lived) message listener.
  const historyFilterRef = useRef<TaskHistoryFilter>({
    query: "",
    status: "all",
    provider: "",
    model: "",
    mode: "all",
    flag: "all",
  });
  // Mirrors the dashboard filter for refresh-after-mutation inside the
  // (long-lived) message listener.
  const dashboardFilterRef = useRef<DashboardFilter>({
    range: "all",
    status: "all",
    provider: "",
    model: "",
    mode: "all",
  });
  // Request-ID of the current chat turn; events for other turns are ignored.
  const activeRequestIdRef = useRef<string | null>(null);
  const [healingState, setHealingState] = useState<HealingStatusState | null>(
    null,
  );
  const [models, setModels] = useState<ModelInfoLite[]>([]);
  // Provider catalogue state (authoritative list comes from the host).
  // NOTE: the legacy 4-entry `provider/list` state was removed — `catalog`
  // (from provider/catalog, derived from @codepilot/model-gateway) is the
  // single provider list the UI renders.
  const [catalog, setCatalog] = useState<CatalogProviderLite[]>([]);
  const [catalogStatuses, setCatalogStatuses] = useState<
    Record<string, ProviderStatusLite>
  >({});
  const [providerFavorites, setProviderFavorites] = useState<string[]>([]);

  const [providerHealth, setProviderHealth] =
    useState<ProviderHealthLite | null>(null);
  const [providerUsage, setProviderUsage] = useState<ProviderUsageLite | null>(
    null,
  );
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [openProviderId, setOpenProviderId] = useState<string>("");
  const [statusMessage, setStatusMessage] = useState<string>("");
  // M12 v5 continuity: validated host snapshot of the active turn chain.
  // Null until the first `continuity/state` arrives; malformed snapshots
  // never replace the previous state (fail-safe display).
  const [continuity, setContinuity] = useState<ContinuityStateView | null>(null);
  const lastDiffActionRef = useRef<{ kind: DiffResultKind } | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  // Mirrors selectedTaskId for use inside the (long-lived) message listener
  const selectedTaskIdRef = useRef<string | null>(null);
  // Mirrors fileChanges for use inside the (long-lived) message listener
  const fileChangesRef = useRef<FileChange[]>([]);
  useEffect(() => {
    fileChangesRef.current = fileChanges;
  }, [fileChanges]);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  useEffect(() => {
    selectedTaskIdRef.current = selectedTaskId;
  }, [selectedTaskId]);
  useEffect(() => {
    selectedPluginRef.current = selectedPluginId;
  }, [selectedPluginId]);
  useEffect(() => {
    selectedTeamRef.current = selectedTeamId;
  }, [selectedTeamId]);
  useEffect(() => {
    selectedScheduleRef.current = selectedScheduleId;
  }, [selectedScheduleId]);
  useEffect(() => {
    selectedHistoryTaskRef.current = selectedHistoryTaskId;
  }, [selectedHistoryTaskId]);
  useEffect(() => {
    historyFilterRef.current = historyFilter;
  }, [historyFilter]);
  useEffect(() => {
    dashboardFilterRef.current = dashboardFilter;
  }, [dashboardFilter]);

  /** Record which diff/* action we sent so diff/result can be reduced correctly. */
  const sendDiffAction = useCallback(
    (kind: DiffResultKind, type: string, payload: unknown) => {
      lastDiffActionRef.current = { kind };
      sendMessage(type, payload);
    },
    [],
  );

  /** Append one streamed delta to the in-progress assistant text (ref + state). */
  const appendStreamingText = useCallback((text: string) => {
    streamingTextRef.current += text;
    setStreamingText(streamingTextRef.current);
  }, []);

  /**
   * Promote the accumulated stream into ONE assistant message.
   * Multiple deltas must update a single message — never create one message
   * per delta. Falls back to the host-provided final result when no deltas
   * were observed (non-streaming completions).
   */
  const promoteStreamingToMessage = useCallback((fallbackResult?: string) => {
    const content =
      streamingTextRef.current.trim().length > 0
        ? streamingTextRef.current
        : (fallbackResult ?? "").trim();
    streamingTextRef.current = "";
    setStreamingText("");
    if (content.length > 0) {
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content,
          timestamp: Date.now(),
        },
      ]);
    }
  }, []);

  /** True when an event belongs to an older/aborted request and must be dropped. */
  const isStaleEvent = useCallback((payloadRequestId: unknown): boolean => {
    return (
      typeof payloadRequestId === "string" &&
      activeRequestIdRef.current !== null &&
      payloadRequestId !== activeRequestIdRef.current
    );
  }, []);

  // Listen for messages from extension host
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      switch (msg.type) {
        case "chat/stream_delta":
          if (isStaleEvent(msg.payload?.requestId)) break;
          appendStreamingText(msg.payload.text ?? "");
          break;
        case "tool/started":
          if (isStaleEvent(msg.payload?.requestId)) break;
          setToolEvents((prev) => [
            ...prev,
            {
              id: msg.payload.toolCallId,
              name: msg.payload.toolName,
              status: "started",
            },
          ]);
          break;
        case "tool/completed":
          if (isStaleEvent(msg.payload?.requestId)) break;
          setToolEvents((prev) =>
            prev.map((e) =>
              e.id === msg.payload.toolCallId
                ? {
                    ...e,
                    status: "completed" as const,
                    durationMs: msg.payload.durationMs,
                    // Command tools: surface the bounded final output as the
                    // expandable detail (today nothing sets it, so terminal
                    // output was invisible after completion).
                    ...terminalCompletionDetail(
                      e.name,
                      msg.payload.output,
                    ),
                  }
                : e,
            ),
          );
          break;
        case "terminal/output": {
          if (isStaleEvent(msg.payload?.requestId)) break;
          const chunk = validateTerminalOutput(msg.payload);
          if (!chunk) break;
          // M7 tracked-session chunks carry a sessionId — route them into
          // that session's live buffer (never into a tool card).
          if (chunk.sessionId) {
            const sid = chunk.sessionId;
            setTerminalSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sid) return s;
                const lastSeq = s.liveSeq ?? 0;
                if (chunk.seq <= lastSeq) return s;
                const next = (s.liveOutput ?? "") + chunk.data;
                if (next.length <= MAX_SESSION_LIVE_BUFFER) {
                  return { ...s, liveOutput: next, liveSeq: chunk.seq };
                }
                const head = Math.floor(MAX_SESSION_LIVE_BUFFER * 0.7);
                const tail = MAX_SESSION_LIVE_BUFFER - head;
                return {
                  ...s,
                  liveOutput:
                    next.slice(0, head) +
                    "\n…[live output truncated]…\n" +
                    next.slice(-tail),
                  liveSeq: chunk.seq,
                  liveTruncated: true,
                };
              }),
            );
            break;
          }
          setToolEvents((prev) =>
            prev.map((e) => {
              if (e.id !== chunk.toolCallId) return e;
              const next = appendTerminalOutput(
                {
                  output: e.output ?? "",
                  outputTruncated: e.outputTruncated ?? false,
                  lastSeq: e.outputSeq ?? 0,
                },
                chunk,
              );
              return {
                ...e,
                output: next.output,
                outputTruncated: next.outputTruncated,
                outputSeq: next.lastSeq,
              };
            }),
          );
          break;
        }
        case "agent/status":
          if (isStaleEvent(msg.payload?.requestId)) break;
          setStatusMessage(
            msg.payload.status === "running"
              ? (msg.payload.message ?? "Agent running…")
              : msg.payload.status === "completed"
                ? `Completed${msg.payload.usage ? ` · ${msg.payload.usage.inputTokens}→${msg.payload.usage.outputTokens} tok` : ""}`
                : "Idle",
          );
          if (msg.payload.status === "completed") {
            // ONE assistant message per turn: promote accumulated deltas,
            // falling back to the host's final result for non-streamed runs.
            promoteStreamingToMessage(
              typeof msg.payload.result === "string"
                ? msg.payload.result
                : undefined,
            );
            setIsRunning(false);
            if (msg.payload.usage) {
              setUsage(msg.payload.usage);
            }
          } else if (msg.payload.status === "idle") {
            // Stopped/failed turns: drop any partial stream, release the UI.
            promoteStreamingToMessage(undefined);
            setIsRunning(false);
          }
          break;
        // NOTE: legacy "provider/list" (4 hard-coded providers) is retired —
        // the authoritative catalogue arrives via "provider/catalog".
        case "provider/catalog": {
          const p = msg.payload as {
            providers?: unknown;
            statuses?: unknown;
            favorites?: unknown;
            recent?: unknown;
            error?: unknown;
          };
          setCatalog(normalizeCatalogProviders(p.providers));
          const statusList = normalizeProviderStatuses(p.statuses);
          const statusMap: Record<string, ProviderStatusLite> = {};
          for (const s of statusList) statusMap[s.providerId] = s;
          setCatalogStatuses(statusMap);
          if (Array.isArray(p.favorites))
            setProviderFavorites(p.favorites as string[]);
          setCatalogError(typeof p.error === "string" ? p.error : null);
          break;
        }
        case "provider/status": {
          const p = msg.payload as {
            status?: {
              providerId: string;
              credentialConfigured: boolean;
              baseUrl?: string;
              fields?: Record<string, string>;
            };
            error?: string;
          };
          if (p.error) {
            setCatalogError(p.error);
          } else if (p.status) {
            setCatalogStatuses((prev) => ({
              ...prev,
              [p.status!.providerId]: p.status!,
            }));
            setCatalogError(null);
          }
          break;
        }
        case "provider/health":
          setProviderHealth(msg.payload as ProviderHealthLite);
          break;
        case "provider/usage":
          setProviderUsage(msg.payload as ProviderUsageLite);
          break;
        case "provider/favorites": {
          const p = msg.payload as { favorites?: string[] };
          if (Array.isArray(p.favorites)) setProviderFavorites(p.favorites);
          break;
        }
        case "provider/models": {
          // Provider-tagged model response. Stale-guard: only accept the
          // payload that matches the provider the user currently selected.
          const pm = msg.payload as {
            providerId?: unknown;
            models?: unknown;
          };
          if (
            typeof pm?.providerId === "string" &&
            settingsRef.current.provider === pm.providerId
          ) {
            const incoming = normalizeModelList(pm.models);
            setModels(incoming);
            // Model validation on provider switch: if the persisted model is
            // not offered by the new provider, fall back to its default.
            const current = settingsRef.current.model;
            const offered =
              incoming.length > 0 && incoming.some((m) => m.id === current);
            const catalogDefault = catalog.find(
              (c) => c.id === pm.providerId,
            )?.defaultModelId;
            if (incoming.length > 0 && !offered) {
              const fallback =
                incoming.find((m) => m.id === catalogDefault)?.id ??
                incoming[0]!.id;
              setSettings((s) => ({ ...s, model: fallback }));
              sendMessage("settings/set", { key: "model", value: fallback });
            }
          }
          break;
        }
        case "model/list":
          setModels(normalizeModelList(msg.payload));
          break;
        case "tools/list_result":
          setToolRegistry(normalizeToolList(msg.payload));
          break;
        case "healing/started":
          // Single healing status object — every event updates it in place,
          // never appends duplicate status messages.
          setHealingState((prev) =>
            reduceHealingState(prev, {
              kind: "started",
              attempt: msg.payload.attempt ?? 1,
              maxAttempts: msg.payload.maxAttempts ?? 3,
              exitCode: msg.payload.exitCode,
              command: msg.payload.command,
              stderrExcerpt: msg.payload.stderrExcerpt,
            }),
          );
          break;
        case "healing/progress": {
          const phase =
            typeof msg.payload.type === "string"
              ? msg.payload.type
              : "diagnosis_started";
          const detail = msg.payload.diagnosis ?? msg.payload.repairDescription;
          setHealingState((prev) =>
            reduceHealingState(
              prev ?? {
                active: true,
                attempt: msg.payload.attempt ?? 1,
                maxAttempts: msg.payload.maxAttempts ?? 3,
                phase,
                message: "",
                success: false,
              },
              {
                kind: "progress",
                phase,
                attempt: msg.payload.attempt ?? prev?.attempt ?? 1,
                message: detail,
              },
            ),
          );
          break;
        }
        case "healing/succeeded":
          setHealingState((prev) =>
            reduceHealingState(prev, {
              kind: "succeeded",
              attempt: msg.payload.attempt ?? prev?.attempt ?? 1,
              durationMs: msg.payload.durationMs,
            }),
          );
          break;
        case "healing/exhausted":
          setHealingState((prev) =>
            reduceHealingState(prev, {
              kind: "exhausted",
              maxAttempts: msg.payload.maxAttempts ?? prev?.maxAttempts ?? 3,
            }),
          );
          break;
        case "context/result": {
          // Structured context from the host (file picker / folder picker /
          // problems diagnostics / selection). Becomes a chip — NEVER text in
          // the composer input and never a chat message.
          const result =
            msg.payload as import("@codepilot/shared").ContextResultPayload;
          if (!result || typeof result !== "object") break;
          if (result.error) {
            setStatusMessage(`Context unavailable: ${result.error}`);
            break;
          }
          setComposerContext((prev) => {
            let next = prev;
            if (
              result.kind === "filePicker" &&
              Array.isArray(result.files) &&
              result.files.length > 0
            ) {
              next = addFileEntriesToContext(next, result.files);
            }
            if (
              result.kind === "folderPicker" &&
              Array.isArray(result.folders) &&
              result.folders.length > 0
            ) {
              next = addFolderEntriesToContext(next, result.folders);
            }
            if (result.kind === "problems") {
              next = setProblemsInContext(next, result.diagnostics ?? null);
              const n = result.diagnostics?.items.length ?? 0;
              if (n === 0)
                setStatusMessage("No problems detected in this workspace.");
            }
            if (result.kind === "selection" && result.selection) {
              next = setSelectionInContext(next, result.selection);
            }
            return next;
          });
          break;
        }
        case "error":
          if (isStaleEvent(msg.payload?.requestId)) break;
          setMessages((prev) => [
            ...prev,
            {
              id: `err-${Date.now()}`,
              role: "system",
              content: `Error: ${msg.payload.message}`,
              timestamp: Date.now(),
            },
          ]);
          // Failed turns must never leave "Agent running…" stuck on screen.
          streamingTextRef.current = "";
          setStreamingText("");
          setIsRunning(false);
          break;
        case "settings/get":
          if (msg.payload) setSettings((prev) => ({ ...prev, ...msg.payload }));
          break;
        case "settings/error":
          setStatusMessage(
            msg.payload?.error ?? "Setting could not be applied.",
          );
          setMessages((prev) => [
            ...prev,
            {
              id: `settings-err-${Date.now()}`,
              role: "system",
              content: `Settings: ${msg.payload?.error ?? "unknown error"}`,
              timestamp: Date.now(),
            },
          ]);
          break;
        case "session/list":
          if (Array.isArray(msg.payload)) {
            setSessions(msg.payload);
          }
          break;
        case "continuity/state": {
          // Strictly validated; malformed snapshots keep previous state.
          const next = validateContinuityState(msg.payload);
          if (next) setContinuity(next);
          break;
        }
        case "continuity/result": {
          // Reset acknowledgement — the authoritative bar state arrives via
          // the host's `continuity/state` push; surface failures only.
          const ok = (msg.payload as { success?: unknown } | null)?.success;
          if (ok === false) {
            setStatusMessage("Could not reset the conversation.");
          }
          break;
        }
        case "agent/file_changed":
          setFileChanges((prev) => {
            const existing = prev.find((c) => c.path === msg.payload.path);
            if (existing) {
              return prev.map((c) =>
                c.path === msg.payload.path ? { ...c, ...msg.payload } : c,
              );
            }
            return [...prev, msg.payload as FileChange];
          });
          break;
        case "agent/approval_needed":
          setPendingApproval(true);
          setFileChanges(msg.payload.changes ?? []);
          break;
        case "diff/created": {
          const payload = msg.payload as DiffCreatedPayload;
          setFileChanges(
            payload.changes.map((change) => ({
              path: change.filePath,
              changeSetId: payload.changeSetId,
              changeId: change.id,
              status: change.isNew ? "added" : "modified",
              diff: change.diff,
            })),
          );
          setPendingApproval(true);
          break;
        }
        case "diff/result": {
          const payload =
            msg.payload as import("./lib/messages.js").DiffResultPayload;
          const kind = lastDiffActionRef.current?.kind;
          const reduced = applyDiffResult(
            fileChangesRef.current,
            kind ?? inferKind(payload),
            payload,
          );
          setFileChanges(reduced.changes);
          setPendingApproval(reduced.pendingApproval);
          if (reduced.error) {
            setMessages((prev) => [
              ...prev,
              {
                id: `diff-error-${Date.now()}`,
                role: "system",
                content: `Change could not be applied: ${reduced.error}`,
                timestamp: Date.now(),
              },
            ]);
          }
          break;
        }
        case "agent/approval_resolved":
          setPendingApproval(false);
          if (msg.payload.accepted) {
            setFileChanges([]);
          }
          break;
        case "mcp/approval_required":
          if (msg.payload.status === "cancelled") {
            // Approval was cancelled — remove from pending list
            setMcpApprovals((prev) =>
              prev.filter((a) => a.requestId !== msg.payload.requestId),
            );
          } else {
            setMcpApprovals((prev) => {
              if (prev.some((a) => a.requestId === msg.payload.requestId))
                return prev;
              return [
                ...prev,
                {
                  requestId: msg.payload.requestId,
                  serverName: msg.payload.serverName,
                  toolName: msg.payload.toolName,
                  arguments: msg.payload.arguments,
                  riskLevel: msg.payload.riskLevel,
                },
              ];
            });
          }
          break;
        case "checkpoint/list": {
          const cp = msg.payload as {
            checkpoints?: Array<{
              id: string;
              taskId: string;
              description?: string;
              timestamp: number;
              fileCount: number;
            }>;
          };
          if (cp.checkpoints) setCheckpoints(cp.checkpoints);
          break;
        }
        case "checkpoint/created": {
          // M11 — host auto-checkpoints after each accepted change. Add to
          // the visible list when viewing the same task.
          const created = msg.payload as {
            id: string;
            taskId: string;
            description?: string;
            timestamp: number;
            fileCount: number;
          };
          setCheckpoints((prev) =>
            prev.some((c) => c.id === created.id)
              ? prev
              : [...prev, created].sort((a, b) => a.timestamp - b.timestamp),
          );
          break;
        }
        case "checkpoint/restore": {
          setStatusMessage(
            `Checkpoint restore: ${msg.payload?.success ? "success" : (msg.payload?.error ?? "failed")}`,
          );
          // Refresh checkpoint list after restore. selectedTaskIdRef mirrors
          // the state so this long-lived listener never reads a stale value.
          if (selectedTaskIdRef.current) {
            sendMessage("checkpoint/list", {
              taskId: selectedTaskIdRef.current,
            });
          }
          break;
        }
        // M4 — live tool approval. The host surfaces one card per pending
        // request; the user's Allow/Deny resolves the SAME ApprovalManager
        // request (tool/approval_result). Malformed/foreign ids are ignored.
        case "tool/request_approval": {
          const p = msg.payload as Partial<M4ApprovalRequest> | undefined;
          if (
            !p ||
            typeof p.approvalId !== "string" ||
            p.approvalId.length === 0 ||
            typeof p.toolId !== "string"
          ) {
            break; // malformed — never render an unverifiable card
          }
          setM4Approvals((prev) =>
            prev.some((a) => a.approvalId === p.approvalId)
              ? prev
              : [...prev, p as M4ApprovalRequest],
          );
          break;
        }
        case "tool/approval_resolved": {
          const r = msg.payload as
            | { approvalId?: string; status?: string; reason?: string }
            | undefined;
          if (typeof r?.approvalId !== "string") break;
          setM4Approvals((prev) => {
            if (!prev.some((a) => a.approvalId === r.approvalId)) return prev;
            const card = prev.find((a) => a.approvalId === r.approvalId);
            if (card && r.status && r.status !== "approved") {
              setStatusMessage(
                `Tool '${card.toolId}' ${r.status}: ${r.reason ?? ""}`.trim(),
              );
            }
            return prev.filter((a) => a.approvalId !== r.approvalId);
          });
          break;
        }
        // M7 — terminal session lifecycle.
        case "terminal/result": {
          const tr = msg.payload as {
            success?: boolean;
            session?: TerminalSessionView;
            error?: string;
            /** Streaming lifecycle event (started/exit/cancelled/timeout). */
            event?: string;
            sessionId?: string;
            exitCode?: number | null;
          };
          if (tr.success && tr.session) {
            setTerminalSessions((prev) => {
              const rest = prev.filter((s) => s.id !== tr.session!.id);
              return [tr.session!, ...rest].slice(0, 20);
            });
          } else if (tr.sessionId && tr.event) {
            // Streaming lifecycle update for an existing session — merges
            // status/exit info without a terminal/status round-trip.
            setTerminalSessions((prev) =>
              prev.map((s) => {
                if (s.id !== tr.sessionId) return s;
                const status =
                  tr.event === "terminal.exit"
                    ? tr.exitCode === 0
                      ? "exited"
                      : "exited"
                    : tr.event === "terminal.cancelled"
                      ? "killed"
                      : tr.event === "terminal.timeout"
                        ? "timedOut"
                        : tr.event === "terminal.error"
                          ? "error"
                          : s.status;
                return {
                  ...s,
                  status,
                  exitCode:
                    tr.event === "terminal.exit"
                      ? (tr.exitCode ?? s.exitCode)
                      : s.exitCode,
                };
              }),
            );
          } else if (tr.error) {
            setStatusMessage(`Terminal: ${tr.error}`);
          }
          break;
        }
        case "terminal/status_result": {
          const ts = msg.payload as { sessions?: TerminalSessionView[] };
          if (Array.isArray(ts.sessions)) {
            // Merge snapshot status but PRESERVE accumulated live output —
            // snapshots carry redacted retained buffers, the live stream is
            // the streaming path's state.
            setTerminalSessions((prev) =>
              ts.sessions!.map((next) => {
                const existing = prev.find((s) => s.id === next.id);
                return existing
                  ? {
                      ...next,
                      liveOutput: existing.liveOutput,
                      liveSeq: existing.liveSeq,
                      liveTruncated: existing.liveTruncated,
                    }
                  : next;
              }),
            );
          }
          break;
        }
        case "terminal/history_result": {
          setTerminalHistory(validateTerminalHistory(msg.payload));
          break;
        }
        // M8 — MCP server management.
        case "mcp/servers/list_result": {
          const sl = msg.payload as {
            servers?: Array<{
              name: string;
              transport: string;
              enabled: boolean;
              status?: string;
              toolCount: number;
              lastError?: string;
            }>;
          };
          if (Array.isArray(sl.servers)) setMcpServers(sl.servers);
          break;
        }
        case "mcp/config_result": {
          setStatusMessage(
            `MCP: ${msg.payload?.success ? (msg.payload.message ?? "ok") : (msg.payload?.error ?? "failed")}`,
          );
          sendMessage("mcp/servers/list", {});
          sendMessage("tools/list", {});
          break;
        }
        // M17 — scheduler (backend-authoritative; malformed rows dropped).
        case "schedule/list_result": {
          const normalized = normalizeScheduleList(msg.payload);
          setSchedules(normalized.schedules);
          setScheduleHistory(normalized.history);
          setScheduleMetrics(normalized.metrics);
          setSchedulesLoading(false);
          setScheduleError(null);
          break;
        }
        case "schedule/details_result": {
          const details = normalizeScheduleDetails(msg.payload);
          if (details) {
            setScheduleDetails(details);
            setSelectedScheduleId(details.schedule.id);
            setSchedules((prev) =>
              prev.some((s) => s.id === details.schedule.id)
                ? prev.map((s) =>
                    s.id === details.schedule.id ? details.schedule : s,
                  )
                : prev,
            );
          }
          break;
        }
        case "schedule/result": {
          const ok = msg.payload?.success === true;
          if (ok) {
            setScheduleError(null);
            if (
              msg.payload?.action === "create" &&
              typeof msg.payload?.scheduleId === "string"
            ) {
              setSelectedScheduleId(msg.payload.scheduleId);
            }
          } else {
            const err = msg.payload?.error ?? "failed";
            setScheduleError(err);
            setStatusMessage(`Schedule: ${err}`);
          }
          // Every mutation re-syncs from the backend; refresh details too.
          setSchedulesLoading(true);
          sendMessage("schedule/list", {});
          if (selectedScheduleRef.current) {
            sendMessage("schedule/details", {
              scheduleId: selectedScheduleRef.current,
            });
          }
          break;
        }
        case "schedule/started":
        case "schedule/run_updated":
        case "schedule/completed":
        case "schedule/failed": {
          // Event-driven live updates — no polling. Re-sync the single
          // authoritative snapshot (list + selected details).
          setSchedulesLoading(true);
          sendMessage("schedule/list", {});
          if (selectedScheduleRef.current) {
            sendMessage("schedule/details", {
              scheduleId: selectedScheduleRef.current,
            });
          }
          break;
        }
        // M12/M5 — task history (backend-authoritative; malformed rows dropped).
        case "history/list_result": {
          setTaskHistory(normalizeTaskHistoryList(msg.payload));
          setHistoryLoading(false);
          setHistoryError(null);
          break;
        }
        case "history/details_result": {
          const details = normalizeTaskDetails(msg.payload);
          if (details) {
            setHistoryDetails(details);
            setSelectedHistoryTaskId(details.id);
            setTaskHistory((prev) =>
              prev.some((t) => t.id === details.id)
                ? prev.map((t) => (t.id === details.id ? details : t))
                : prev,
            );
          }
          break;
        }
        case "history/compare_result": {
          const compared = normalizeRunCompare(msg.payload);
          if (compared) setRunCompare(compared);
          break;
        }
        case "history/checkpoint-compare_result": {
          const compared = normalizeCheckpointCompare(msg.payload);
          if (compared) setCpCompare(compared);
          break;
        }
        case "history/result": {
          const ok = msg.payload?.success === true;
          if (ok) {
            setHistoryError(null);
          } else {
            const err = msg.payload?.error ?? "failed";
            setHistoryError(err);
            setStatusMessage(`History: ${err}`);
          }
          // Every mutation re-syncs from the backend; refresh details too.
          setHistoryLoading(true);
          sendMessage(
            "history/list",
            buildHistoryFilterPayload(historyFilterRef.current),
          );
          if (selectedHistoryTaskRef.current) {
            sendMessage("history/details", {
              taskId: selectedHistoryTaskRef.current,
            });
          }
          break;
        }
        // M15 — plugins (backend-authoritative; malformed rows dropped).
        case "plugins/list_result": {
          const normalized = normalizePluginList(msg.payload);
          setPlugins(normalized.plugins);
          setPluginProblems(normalized.malformed);
          setPluginsLoading(false);
          setPluginError(null);
          break;
        }
        case "plugins/details_result": {
          const details = normalizePluginDetails(msg.payload);
          if (details) {
            setPluginDetails(details);
            setSelectedPluginId(details.id);
            // Keep the row in sync with the authoritative details.
            setPlugins((prev) =>
              prev.some((p) => p.id === details.id)
                ? prev.map((p) => (p.id === details.id ? details : p))
                : prev,
            );
          }
          break;
        }
        case "plugins/result": {
          const ok = msg.payload?.success === true;
          const action =
            typeof msg.payload?.action === "string" ? msg.payload.action : "";
          if (ok) {
            setStatusMessage(`Plugin: ${msg.payload?.message ?? "ok"}`);
            setPluginError(null);
          } else {
            const err = msg.payload?.error ?? "failed";
            setPluginError(err);
            setStatusMessage(`Plugin: ${err}`);
          }
          if (action === "invoke" && msg.payload?.output !== undefined) {
            try {
              setInvokeOutput(
                JSON.stringify(msg.payload.output, null, 2).slice(0, 2000),
              );
            } catch {
              setInvokeOutput(String(msg.payload.output).slice(0, 2000));
            }
          }
          // Every mutation re-syncs from the backend; refresh details too.
          setPluginsLoading(true);
          sendMessage("plugins/list", {});
          if (selectedPluginRef.current) {
            sendMessage("plugins/details", { id: selectedPluginRef.current });
          }
          break;
        }
        // Skills (backend-authoritative; malformed rows dropped).
        case "skills/list_result":
        case "skills/state": {
          const normalized = validateSkillsState(msg.payload);
          if (normalized) {
            setSkills(normalized.skills);
            setActiveSkillNames(normalized.activeSkillNames);
            setSkillsSkipped(
              normalized.skipped.map((s) => ({
                path: s.path,
                reason: s.reason,
              })),
            );
            setSkillsLoading(false);
            setSkillError(null);
          }
          break;
        }
        case "skills/get_result": {
          const res = validateSkillResult(msg.payload);
          if (res?.success && res.skill) {
            setSelectedSkillName(res.skill.name);
            setSkillNotice(`Skill '${res.skill.name}' loaded.`);
            setSkillError(null);
          }
          break;
        }
        case "skills/result": {
          const res = validateSkillResult(msg.payload);
          if (res?.success) {
            setSkillNotice(
              res.action === "activate"
                ? `Skill activated — its instructions now join the next prompt (M4 still gates tools).`
                : `Skill deactivated — excluded from the next prompt.`,
            );
            setSkillError(null);
          } else if (res) {
            setSkillError(res.error ?? "skill update failed");
          }
          // Every mutation re-syncs from the backend (authoritative state).
          setSkillsLoading(true);
          sendMessage("skills/list", {});
          break;
        }
        case "skills/error": {
          const res = validateSkillResult(msg.payload);
          const err = res?.error ?? "skill request failed";
          setSkillError(err);
          setStatusMessage(`Skills: ${err}`);
          setSkillsLoading(false);
          break;
        }
        // M14 — teams (backend-authoritative, event-driven; malformed rows dropped).
        case "team/list_result": {
          setTeams(normalizeTeamList(msg.payload));
          setTeamsLoading(false);
          setTeamError(null);
          break;
        }
        case "team/details_result": {
          const details = normalizeTeamDetails(msg.payload);
          if (details) {
            setTeamDetails(details);
            setSelectedTeamId(details.teamId);
            setTeams((prev) =>
              prev.some((t) => t.teamId === details.teamId)
                ? prev.map((t) => (t.teamId === details.teamId ? details : t))
                : prev,
            );
          }
          break;
        }
        case "team/result": {
          const ok = msg.payload?.success === true;
          if (ok) {
            setTeamError(null);
            if (
              msg.payload?.action === "create" &&
              typeof msg.payload?.teamId === "string"
            ) {
              setSelectedTeamId(msg.payload.teamId);
              setSelectedTeamTaskId(null);
            }
          } else {
            const err = msg.payload?.error ?? "failed";
            setTeamError(err);
            setStatusMessage(`Team: ${err}`);
          }
          // Every mutation re-syncs from the backend; refresh details too.
          setTeamsLoading(true);
          sendMessage("team/list", {});
          if (selectedTeamRef.current) {
            sendMessage("team/details", { teamId: selectedTeamRef.current });
          }
          break;
        }
        case "team/started":
        case "team/task_updated":
        case "team/completed":
        case "team/failed":
        case "team/cancelled": {
          // Event-driven live updates — no polling. Re-sync the single
          // authoritative snapshot (list + selected details).
          setTeamsLoading(true);
          sendMessage("team/list", {});
          if (selectedTeamRef.current) {
            sendMessage("team/details", { teamId: selectedTeamRef.current });
          }
          if (msg.payload?.message) {
            setStatusMessage(`Team: ${msg.payload.message}`);
          }
          break;
        }
        // M18 — local metrics reader.
        case "metrics/result": {
          if (
            msg.payload &&
            typeof msg.payload === "object" &&
            (msg.payload as { success?: unknown }).success === false
          ) {
            const err = (msg.payload as { error?: unknown }).error;
            setDashboardError(
              typeof err === "string" ? err : "metrics request failed",
            );
            break;
          }
          const mr = msg.payload as {
            counters?: Array<{
              name: string;
              labels: Record<string, string>;
              value: number;
            }>;
          };
          if (Array.isArray(mr.counters)) setMetricsRows(mr.counters);
          break;
        }
        case "metrics/dashboard_result": {
          const view = normalizeDashboard(msg.payload);
          if (view) {
            setDashboard(view);
            setDashboardLoading(false);
            setDashboardError(null);
          }
          break;
        }
        case "metrics/export_result": {
          const summary = normalizeDiagnosticSummary(msg.payload);
          if (summary) setExported(summary);
          break;
        }
      }
    };
    window.addEventListener("message", handler);
    // One-time bootstrap: the listener is mounted ONCE (stable deps) so these
    // requests fire a single time per webview session — not on every stream
    // delta. selectedTaskIdRef keeps checkpoint bootstrapping correct.
    sendMessage("settings/get", {});
    sendMessage("provider/list", {});
    sendMessage("provider/catalog", {});
    sendMessage("model/list", {});
    sendMessage("tools/list", {});
    sendMessage("session/list", {});
    sendMessage("checkpoint/list", {
      taskId: selectedTaskIdRef.current ?? undefined,
    });
    sendMessage("mcp/servers/list", {});
    sendMessage("schedule/list", {});
    sendMessage("plugins/list", {});
    sendMessage("team/list", {});
    sendMessage("history/list", {});
    sendMessage("metrics/get", {});
    sendMessage("continuity/get", {});
    return () => window.removeEventListener("message", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handler reads state through refs by design
  }, []);

  // Auto-scroll
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText, toolEvents]);

  // ---- M15 plugin actions (validated before posting; backend decides) ----
  const refreshPlugins = useCallback(() => {
    setPluginsLoading(true);
    setPluginError(null);
    sendMessage("plugins/list", {});
  }, []);

  // ---- M14 team actions (validated before posting; backend decides) ----
  const refreshTeams = useCallback(() => {
    setTeamsLoading(true);
    setTeamError(null);
    sendMessage("team/list", {});
  }, []);

  const sendTeamAction = useCallback((action: string, payload: unknown) => {
    const check = validateTeamAction(action, payload);
    if (!check.ok) {
      setTeamError(check.error ?? "invalid team action");
      return;
    }
    setTeamError(null);
    sendMessage(action, payload);
  }, []);

  const selectTeam = useCallback(
    (teamId: string) => {
      setSelectedTeamId(teamId);
      setTeamDetails(null);
      setSelectedTeamTaskId(null);
      sendTeamAction("team/details", { teamId });
    },
    [sendTeamAction],
  );

  const createTeamFromForm = useCallback(() => {
    const objective = teamForm.objective.trim();
    sendTeamAction("team/create", {
      objective,
      roles: teamForm.roles.length > 0 ? teamForm.roles : undefined,
      maxConcurrency: teamForm.maxConcurrency,
    });
  }, [teamForm, sendTeamAction]);

  const confirmTeamAction = useCallback(() => {
    if (!teamConfirm) return;
    const { action, team } = teamConfirm;
    setTeamConfirm(null);
    if (action === "cancel") {
      sendTeamAction("team/cancel", { teamId: team.teamId, runId: team.runId });
    } else if (action === "remove") {
      sendTeamAction("team/remove", { teamId: team.teamId });
      if (selectedTeamId === team.teamId) {
        setSelectedTeamId(null);
        setTeamDetails(null);
      }
    } else {
      sendTeamAction("team/retry", { teamId: team.teamId });
    }
  }, [teamConfirm, selectedTeamId, sendTeamAction]);

  const sendPluginAction = useCallback((action: string, payload: unknown) => {
    const check = validatePluginAction(action, payload);
    if (!check.ok) {
      setPluginError(check.error ?? "invalid plugin action");
      return;
    }
    setPluginError(null);
    sendMessage(action, payload);
  }, []);

  // ---- Skills actions (validated before posting; backend decides) ----
  const refreshSkills = useCallback(() => {
    setSkillsLoading(true);
    setSkillError(null);
    sendMessage("skills/list", {});
  }, []);

  const sendSkillAction = useCallback((action: string, payload: unknown) => {
    const check = validateSkillAction(action, payload);
    if (!check.ok) {
      setSkillError(check.error ?? "invalid skill action");
      return;
    }
    setSkillError(null);
    sendMessage(action, payload);
  }, []);

  const selectPlugin = useCallback(
    (id: string) => {
      setSelectedPluginId(id);
      setPluginDetails(null);
      setInvokeOutput(null);
      setInvokeArgs("{}");
      sendPluginAction("plugins/details", { id });
    },
    [sendPluginAction],
  );

  const confirmPluginAction = useCallback(() => {
    if (!pluginConfirm) return;
    const { action, plugin } = pluginConfirm;
    setPluginConfirm(null);
    if (action === "uninstall") {
      sendPluginAction("plugins/uninstall", { id: plugin.id });
      if (selectedPluginId === plugin.id) {
        setSelectedPluginId(null);
        setPluginDetails(null);
      }
    } else if (action === "install-untrusted") {
      sendPluginAction("plugins/install", {
        id: plugin.id,
        confirmUntrusted: true,
      });
    } else {
      sendPluginAction("plugins/activate", {
        id: plugin.id,
        confirmUntrusted: true,
      });
    }
  }, [pluginConfirm, selectedPluginId, sendPluginAction]);

  const invokeSelectedTool = useCallback(() => {
    if (!selectedPluginId || !invokeTool) return;
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(invokeArgs || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setPluginError("args must be a JSON object");
        return;
      }
      args = parsed as Record<string, unknown>;
    } catch {
      setPluginError("args must be valid JSON");
      return;
    }
    setInvokeOutput(null);
    sendPluginAction("plugins/invoke", {
      id: selectedPluginId,
      tool: invokeTool,
      args,
    });
  }, [selectedPluginId, invokeTool, invokeArgs, sendPluginAction]);

  const handleSend = useCallback(() => {
    const raw = input.trim();
    if (!raw || isRunning) return;
    setInput("");

    // Slash commands (Phase 14 + Feature Group 3): real behavior only.
    const { command, prompt, instruction } = parseSlashCommand(raw);
    const def = SLASH_COMMANDS.find((c) => c.command === command);
    if (command === "clear") {
      setMessages([]);
      setToolEvents([]);
      setStreamingText("");
      setFileChanges([]);
      setPendingApproval(false);
      setStatusMessage("Cleared.");
      return;
    }
    if (command === "help") {
      const lines = SLASH_COMMANDS.map(
        (c) => `  /${c.command}${c.mode ? " <task>" : ""} — ${c.description}`,
      );
      setMessages((prev) => [
        ...prev,
        {
          id: `help-${Date.now()}`,
          role: "system",
          content: ["Available commands:", ...lines].join("\n"),
          timestamp: Date.now(),
        },
      ]);
      return;
    }
    if (def?.mode) {
      setSettings((prev) => ({ ...prev, agentMode: def.mode! }));
      sendMessage("settings/set", { key: "agentMode", value: def.mode });
      // Mode-only invocation (no task): report the switch, don't call the agent.
      if (!prompt && !def.instruction) {
        setMessages((prev) => [
          ...prev,
          {
            id: `mode-${Date.now()}`,
            role: "system",
            content: `Mode switched to ${def.mode}.`,
            timestamp: Date.now(),
          },
        ]);
        return;
      }
      // Fall through: send the task in the newly selected mode.
    }

    const finalPrompt = instruction ? `${instruction}${prompt}` : prompt;

    const userMsg: Message = {
      id: `user-${Date.now()}`,
      role: "user",
      content: finalPrompt,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setToolEvents([]);
    streamingTextRef.current = "";
    setStreamingText("");
    setIsRunning(true);
    setLastPrompt(finalPrompt);
    // Request-ID correlation: one unique ID per chat turn. The host adopts it
    // and stamps every streamed event, so stale turns cannot interfere.
    const requestId = createRequestId();
    activeRequestIdRef.current = requestId;
    // Context travels as structured metadata — the visible user message
    // contains ONLY what the user typed. Sent exactly once per submission.
    const resolvedMode = def?.mode ?? settings.agentMode;
    sendMessage(
      "chat/send",
      buildChatSendPayload(
        finalPrompt,
        resolvedMode,
        composerContext,
        requestId,
      ),
    );
    setComposerContext(createEmptyComposerContext());
  }, [input, isRunning, settings.agentMode, composerContext]);

  const handleMCPApproval = useCallback(
    (requestId: string, decision: "approve" | "reject") => {
      sendMessage("mcp/approval_response", { requestId, decision });
      setMcpApprovals((prev) => prev.filter((a) => a.requestId !== requestId));
    },
    [],
  );

  // M4 — resolve a live-tool approval. The decision goes back to the SAME
  // ApprovalManager request the pipeline is blocked on (single-use: stale or
  // duplicate answers are rejected host-side).
  const handleM4Approval = useCallback(
    (
      approvalId: string,
      decision: "allow" | "deny",
      scope?: "once" | "session" | "task",
    ) => {
      sendMessage("tool/approval_result", { approvalId, decision, scope });
      // Optimistically retire the card; tool/approval_resolved reconciles
      // (e.g. on timeout the host retires it too).
      setM4Approvals((prev) => prev.filter((a) => a.approvalId !== approvalId));
    },
    [],
  );

  // M7 — start a tracked terminal session (M4-gated host-side).
  const handleTerminalStart = useCallback(() => {
    const command = window.prompt("Command to run in a tracked session:");
    if (!command || !command.trim()) return;
    sendMessage("terminal/start", { command: command.trim() });
  }, []);
  const handleTerminalRefresh = useCallback(() => {
    // Status (snapshots) + history are separate reads; output itself is
    // event-streamed, never polled.
    sendMessage("terminal/status", {});
    sendMessage("terminal/history", {});
  }, []);
  const handleTerminalStop = useCallback((id: string, kill: boolean) => {
    sendMessage(kill ? "terminal/kill" : "terminal/stop", { sessionId: id });
    setTimeout(() => sendMessage("terminal/status", {}), 500);
  }, []);

  // M17 — scheduler actions (validated before posting; backend decides).
  const refreshSchedules = useCallback(() => {
    setSchedulesLoading(true);
    setScheduleError(null);
    sendMessage("schedule/list", {});
  }, []);

  const sendScheduleAction = useCallback((action: string, payload: unknown) => {
    const check = validateScheduleAction(action, payload);
    if (!check.ok) {
      setScheduleError(check.error ?? "invalid schedule action");
      return;
    }
    setScheduleError(null);
    sendMessage(action, payload);
  }, []);

  const selectSchedule = useCallback(
    (scheduleId: string) => {
      setSelectedScheduleId(scheduleId);
      setScheduleDetails(null);
      sendScheduleAction("schedule/details", { scheduleId });
    },
    [sendScheduleAction],
  );

  const submitScheduleForm = useCallback(() => {
    const base = {
      name: scheduleForm.name.trim(),
      prompt: scheduleForm.prompt.trim(),
      maxRetries:
        scheduleForm.maxRetries.trim() === ""
          ? 0
          : Number(scheduleForm.maxRetries),
      enabled: scheduleForm.enabled,
    };
    if (editingScheduleId) {
      const patch: Record<string, unknown> = {};
      if (base.name) patch.name = base.name;
      if (base.prompt) patch.prompt = base.prompt;
      patch.maxRetries = base.maxRetries;
      patch.enabled = base.enabled;
      if (scheduleForm.kind === "interval") {
        patch.kind = "recurring";
        patch.everyMinutes = Number(scheduleForm.everyMinutes);
      } else if (scheduleForm.kind === "daily") {
        patch.kind = "recurring";
        patch.dailyAt = scheduleForm.dailyAt.trim();
        if (scheduleForm.timezone.trim())
          patch.timezone = scheduleForm.timezone.trim();
      } else {
        patch.kind = "once";
        patch.atIso = scheduleForm.atIso.trim();
      }
      sendScheduleAction("schedule/update", {
        id: editingScheduleId,
        ...patch,
      });
      setEditingScheduleId(null);
      return;
    }
    if (scheduleForm.kind === "interval") {
      sendScheduleAction("schedule/create", {
        ...base,
        kind: "recurring",
        everyMinutes: Number(scheduleForm.everyMinutes),
      });
    } else if (scheduleForm.kind === "daily") {
      sendScheduleAction("schedule/create", {
        ...base,
        kind: "recurring",
        dailyAt: scheduleForm.dailyAt.trim(),
        ...(scheduleForm.timezone.trim()
          ? { timezone: scheduleForm.timezone.trim() }
          : {}),
      });
    } else {
      sendScheduleAction("schedule/create", {
        ...base,
        kind: "once",
        atIso: scheduleForm.atIso.trim(),
      });
    }
  }, [scheduleForm, editingScheduleId, sendScheduleAction]);

  const startEditingSchedule = useCallback((s: ScheduleView) => {
    setEditingScheduleId(s.id);
    setScheduleForm({
      name: s.name,
      prompt: s.prompt,
      kind: s.kind === "once" ? "once" : s.dailyAt ? "daily" : "interval",
      everyMinutes: String(s.everyMinutes ?? 60),
      dailyAt: s.dailyAt ?? "09:00",
      timezone: s.timezone ?? "",
      atIso: s.atIso ?? "",
      maxRetries: String(s.maxRetries ?? 0),
      enabled: s.enabled,
    });
  }, []);

  const confirmScheduleAction = useCallback(() => {
    if (!scheduleConfirm) return;
    const { action, schedule } = scheduleConfirm;
    setScheduleConfirm(null);
    if (action === "remove") {
      sendScheduleAction("schedule/remove", { scheduleId: schedule.id });
      if (selectedScheduleId === schedule.id) {
        setSelectedScheduleId(null);
        setScheduleDetails(null);
      }
    } else {
      sendScheduleAction("schedule/run-now", { scheduleId: schedule.id });
    }
  }, [scheduleConfirm, selectedScheduleId, sendScheduleAction]);

  // ---- M18 metrics actions (validated before posting; backend decides) ----
  const refreshDashboard = useCallback(() => {
    setDashboardLoading(true);
    setDashboardError(null);
    sendMessage(
      "metrics/dashboard",
      buildDashboardFilterPayload(dashboardFilterRef.current),
    );
  }, []);

  const sendMetricsAction = useCallback((action: string, payload: unknown) => {
    const check = validateMetricsAction(action, payload);
    if (!check.ok) {
      setDashboardError(check.error ?? "invalid metrics action");
      return;
    }
    setDashboardError(null);
    sendMessage(action, payload);
  }, []);

  const applyDashboardFilter = useCallback(
    (patch: Partial<DashboardFilter>) => {
      setDashboardFilter((prev) => {
        const next = { ...prev, ...patch };
        dashboardFilterRef.current = next;
        setDashboardLoading(true);
        setDashboardError(null);
        sendMessage("metrics/dashboard", buildDashboardFilterPayload(next));
        return next;
      });
    },
    [],
  );

  const copyDiagnostic = useCallback(() => {
    if (!exported) {
      sendMetricsAction("metrics/export", {});
      return;
    }
    const text = JSON.stringify(exported, null, 2);
    try {
      const nav = navigator as Navigator & {
        clipboard?: { writeText: (t: string) => Promise<void> };
      };
      if (nav.clipboard) {
        void nav.clipboard.writeText(text).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      } else {
        setCopied(false);
      }
    } catch {
      setCopied(false);
    }
  }, [exported, sendMetricsAction]);

  // ---- M12/M5 history actions (validated before posting; backend decides) ----
  const refreshHistory = useCallback(() => {
    setHistoryLoading(true);
    setHistoryError(null);
    sendMessage(
      "history/list",
      buildHistoryFilterPayload(historyFilterRef.current),
    );
  }, []);

  const sendHistoryAction = useCallback((action: string, payload: unknown) => {
    const check = validateHistoryAction(action, payload);
    if (!check.ok) {
      setHistoryError(check.error ?? "invalid history action");
      return;
    }
    setHistoryError(null);
    sendMessage(action, payload);
  }, []);

  const selectHistoryTask = useCallback(
    (taskId: string) => {
      setSelectedHistoryTaskId(taskId);
      setHistoryDetails(null);
      setRunCompare(null);
      setCpCompareSelect([]);
      setCpCompare(null);
      sendHistoryAction("history/details", { taskId });
    },
    [sendHistoryAction],
  );

  const applyHistoryFilter = useCallback(
    (patch: Partial<TaskHistoryFilter>) => {
      setHistoryFilter((prev) => {
        const next = { ...prev, ...patch };
        historyFilterRef.current = next;
        setHistoryLoading(true);
        setHistoryError(null);
        sendMessage("history/list", buildHistoryFilterPayload(next));
        return next;
      });
    },
    [],
  );

  const confirmHistoryAction = useCallback(() => {
    if (!historyConfirm) return;
    const { action, taskId, checkpointId } = historyConfirm;
    setHistoryConfirm(null);
    if (action === "discard") {
      sendHistoryAction("history/discard", { taskId });
      if (selectedHistoryTaskId === taskId) {
        setSelectedHistoryTaskId(null);
        setHistoryDetails(null);
      }
    } else if (action === "restart") {
      sendHistoryAction("history/restart", { taskId });
    } else if (action === "restore" && checkpointId) {
      // Reuses the existing M4-gated checkpoint/restore path (with task
      // ownership enforced server-side) — no second restore implementation.
      sendMessage("checkpoint/restore", { checkpointId, taskId });
    }
  }, [historyConfirm, selectedHistoryTaskId, sendHistoryAction]);

  const toggleHistorySection = useCallback((section: string) => {
    setHistorySections((prev) => ({ ...prev, [section]: !prev[section] }));
  }, []);
  const toggleMetricsSection = useCallback((section: string) => {
    setMetricsSections((prev) => ({ ...prev, [section]: !prev[section] }));
  }, []);

  // @ mention menu — opened by typing "@"; selecting an entry must never
  // leave the literal "@" keyword in the submitted user text.
  const closeMentionMenuAndStripKeyword = useCallback(() => {
    setMentionMenuOpen(false);
    setInput((prev) => prev.replace(/@\S*$/, "").replace(/\s+$/, ""));
  }, []);
  const handleInputChanged = useCallback((value: string) => {
    setInput(value);
    // Open the @ menu when "@" is the last thing typed.
    setMentionMenuOpen(/@\S*$/.test(value.slice(-40)));
    // Open the / menu while typing a slash command (before the first space).
    const tail = value.slice(-40);
    const slashMatch = tail.match(/^\/(\w*)$/);
    setSlashMenuOpen(slashMatch !== null);
  }, []);

  const handleAttachFile = useCallback(() => {
    setMentionMenuOpen(false);
    // REAL file picker flow: webview asks the extension host, host opens
    // vscode.window.showOpenDialog. Cancel must be a silent no-op.
    sendMessage("context/filePicker", {});
  }, []);

  const handleAttachFolder = useCallback(() => {
    setMentionMenuOpen(false);
    // REAL folder picker flow via vscode.window.showOpenDialog (openFolder).
    sendMessage("context/folderPicker", {});
  }, []);

  const handleAttachUrl = useCallback(() => {
    setMentionMenuOpen(false);
    const url = window.prompt(
      "Enter URL to attach as context:\nExample: https://docs.example.com/api",
    );
    if (url && url.trim()) {
      // Stored as structured metadata + chip; never appended to composer text.
      setComposerContext((prev) => addUrlToContext(prev, url.trim()));
    }
  }, []);

  const handleAttachProblems = useCallback(() => {
    setMentionMenuOpen(false);
    // REAL problems flow: ask the extension host for live diagnostics.
    // Result arrives as context/result and becomes a chip — never "@problem" text.
    setStatusMessage("Collecting VS Code Problems…");
    sendMessage("context/problems", { scope: "workspace" });
  }, []);

  const handleAttachSelection = useCallback(() => {
    setMentionMenuOpen(false);
    // Structured active-editor selection context from the host.
    sendMessage("context/selection", {});
  }, []);

  const handleStop = useCallback(() => {
    sendMessage("agent/stop", {});
    // RUNNING → STOPPED: release the UI immediately and invalidate the current
    // request ID so late events from the aborted turn are ignored.
    streamingTextRef.current = "";
    setStreamingText("");
    activeRequestIdRef.current = null;
    setIsRunning(false);
  }, []);

  // M12 v5 continuity — start a new conversation. The host clears ONLY the
  // active session chain (history, audit, checkpoints, artifacts, resume
  // all preserved); the local transcript clears so the display matches the
  // fresh model context. Guarded while a turn runs (button disabled there).
  const handleNewConversation = useCallback(() => {
    sendMessage("continuity/reset", {});
    streamingTextRef.current = "";
    setStreamingText("");
    setMessages([]);
    setToolEvents([]);
    setFileChanges([]);
    setPendingApproval(false);
    setStatusMessage("New conversation started.");
  }, []);

  const handleAutoApprovalChange = useCallback(
    (key: keyof AutoApproval, value: boolean | number) => {
      setAutoApproval((prev) => {
        const next = { ...prev, [key]: value };
        sendMessage("settings/set", { key: "autoApproval", value: next });
        return next;
      });
    },
    [],
  );

  // ==========================================================================
  // Provider catalogue actions (credentials live host-side in SecretStorage)
  // ==========================================================================

  const handleProviderSave = useCallback(
    (input: {
      providerId: string;
      baseUrl?: string;
      fields?: Record<string, string>;
      apiKey?: string;
      clearApiKey?: boolean;
    }) => {
      sendMessage("provider/configure", input);
    },
    [],
  );

  const handleProviderTest = useCallback((providerId: string) => {
    setProviderHealth(null);
    sendMessage("provider/test", { providerId });
  }, []);

  const handleProviderUsage = useCallback((providerId: string) => {
    sendMessage("provider/usage", { providerId });
  }, []);

  const handleProviderFavorite = useCallback((providerId: string) => {
    // Optimistic toggle; host echoes the authoritative list.
    setProviderFavorites((prev) =>
      prev.includes(providerId)
        ? prev.filter((id) => id !== providerId)
        : [...prev, providerId],
    );
    sendMessage("provider/favorite", { providerId });
  }, []);

  const handleUseProvider = useCallback((providerId: string) => {
    setSettings((s) => ({ ...s, provider: providerId }));
    // Clear the model list immediately: the old provider's models must never
    // linger under the new provider (prevents stale model selection).
    setModels([]);
    // Ask the host for the new provider's models; the response handler is
    // provider-tagged so a slow earlier response cannot overwrite a newer one.
    sendMessage("provider/models", { providerId });
    // Single atomic host-side switch: provider + validated default model +
    // credential + baseUrl are patched onto the runtime together.
    sendMessage("settings/set", { key: "provider", value: providerId });
    // Header health re-probe for the newly selected provider only.
    sendMessage("provider/test", { providerId });
  }, []);

  const handleAcceptFile = useCallback(
    (path: string) => {
      const change = fileChanges.find((item) => item.path === path);
      if (!change?.changeSetId || !change.changeId) return;
      sendDiffAction("accept", "diff/accept", {
        changeSetId: change.changeSetId,
        changeId: change.changeId,
      });
    },
    [fileChanges, sendDiffAction],
  );

  const handleRejectFile = useCallback(
    (path: string) => {
      const change = fileChanges.find((item) => item.path === path);
      if (!change?.changeSetId || !change.changeId) return;
      sendDiffAction("reject", "diff/reject", {
        changeSetId: change.changeSetId,
        changeId: change.changeId,
      });
    },
    [fileChanges, sendDiffAction],
  );

  const handleRollbackFile = useCallback(
    (path: string) => {
      const change = fileChanges.find((item) => item.path === path);
      if (!change?.changeSetId || !change.changeId) return;
      sendDiffAction("rollback", "diff/rollback", {
        changeSetId: change.changeSetId,
        changeId: change.changeId,
      });
    },
    [fileChanges, sendDiffAction],
  );

  const handleAcceptAll = useCallback(() => {
    const changeSetId = fileChanges[0]?.changeSetId;
    if (
      !changeSetId ||
      fileChanges.some((change) => change.changeSetId !== changeSetId)
    )
      return;
    sendDiffAction("accept_all", "diff/accept_all", { changeSetId });
  }, [fileChanges, sendDiffAction]);

  const handleRejectAll = useCallback(() => {
    const changeSetId = fileChanges[0]?.changeSetId;
    if (
      !changeSetId ||
      fileChanges.some((change) => change.changeSetId !== changeSetId)
    )
      return;
    sendDiffAction("reject_all", "diff/reject_all", { changeSetId });
  }, [fileChanges, sendDiffAction]);

  const handleSelectTaskForCheckpoints = useCallback((taskId: string) => {
    setSelectedTaskId((prev) => (prev === taskId ? null : taskId));
    if (taskId) {
      sendMessage("checkpoint/list", { taskId });
    } else {
      setCheckpoints([]);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Navigation model with REAL, live badges (no fake counts)
  // ---------------------------------------------------------------------------
  const navItems: NavItem[] = useMemo(
    () => [
      { id: "chat", label: "Chat", icon: (p) => <IconChat {...p} /> },
      {
        id: "tools",
        label: "Tools",
        icon: (p) => <IconTools {...p} />,
        badge:
          toolEvents.length > 0
            ? { count: toolEvents.length, tone: "info" }
            : undefined,
      },
      {
        id: "changes",
        label: "Changes",
        icon: (p) => <IconChanges {...p} />,
        badge:
          fileChanges.filter(
            (c) =>
              c.status === "added" ||
              c.status === "modified" ||
              c.status === "deleted",
          ).length > 0
            ? {
                count: fileChanges.filter(
                  (c) =>
                    c.status === "added" ||
                    c.status === "modified" ||
                    c.status === "deleted",
                ).length,
                tone: "warning",
              }
            : undefined,
      },
      {
        id: "plugins",
        label: "Plugins",
        icon: (p) => <IconPlugins {...p} />,
        badge:
          plugins.filter((p) => p.installed).length > 0
            ? { count: plugins.filter((p) => p.installed).length }
            : undefined,
      },
      {
        id: "skills",
        label: "Skills",
        icon: (p) => <IconTools {...p} />,
        badge:
          activeSkillNames.length > 0
            ? { count: activeSkillNames.length, tone: "info" }
            : undefined,
      },
      {
        id: "team",
        label: "Team",
        icon: (p) => <IconTeam {...p} />,
        badge:
          teams.filter((t) => t.status === "running").length > 0
            ? {
                count: teams.filter((t) => t.status === "running").length,
                tone: "info",
              }
            : undefined,
      },
      {
        id: "schedules",
        label: "Schedules",
        icon: (p) => <IconSchedule {...p} />,
        badge:
          schedules.filter((s) => s.enabled).length > 0
            ? { count: schedules.filter((s) => s.enabled).length }
            : undefined,
      },
      { id: "history", label: "History", icon: (p) => <IconHistory {...p} /> },
      { id: "metrics", label: "Metrics", icon: (p) => <IconMetrics {...p} /> },
      {
        id: "settings",
        label: "Settings",
        icon: (p) => <IconSettings {...p} />,
      },
    ],
    [toolEvents, fileChanges, plugins, activeSkillNames, teams, schedules],
  );

  // Header status reflects ONLY the selected provider's own health — never
  // whichever provider happens to be reachable (old first-connected bug).
  const selectedProviderId = settings.provider;
  const selectedCatalog = catalog.find((c) => c.id === selectedProviderId);
  const selectedHealth =
    providerHealth?.providerId === selectedProviderId
      ? providerHealth
      : undefined;
  const selectedCredential =
    catalogStatuses[selectedProviderId]?.credentialConfigured;
  const connection = connectionSummary({
    selectedProviderId,
    catalog: selectedCatalog,
    health: selectedHealth,
    credentialConfigured: selectedCredential,
    modelCount: models.length,
  });
  const privacyText = privacyClaim(
    settings.privacyMode,
    selectedCatalog?.category,
  );

  return (
    <div className="flex flex-col h-screen bg-vscode-bg overflow-hidden">
      <AppHeader
        connected={connection.connected}
        connectionTitle={connection.label}
        model={settings.model}
        provider={settings.provider}
        privacyMode={settings.privacyMode}
        privacyTitle={privacyText}
        isRunning={isRunning}
        onOpenSettings={() => setCurrentTab("settings")}
        settingsActive={currentTab === "settings"}
      />

      <div className="flex flex-1 overflow-hidden min-h-0">
        <SideNav
          items={navItems}
          activeTab={currentTab}
          onSelect={(tab) => {
            setCurrentTab(tab);
            if (tab === "plugins") refreshPlugins();
            if (tab === "skills") refreshSkills();
            if (tab === "team") refreshTeams();
            if (tab === "schedules") refreshSchedules();
            if (tab === "metrics") refreshDashboard();
          }}
          collapsed={navCollapsed}
          onToggleCollapsed={() => setNavCollapsed((c) => !c)}
        />

        <main className="flex-1 overflow-hidden min-w-0 flex flex-col">
          {/* TAB: CHAT */}
          {currentTab === "chat" && (
            <ChatView
              messages={messages}
              streamingText={streamingText}
              toolEvents={toolEvents}
              m4Approvals={m4Approvals}
              mcpApprovals={mcpApprovals}
              onM4Decision={handleM4Approval}
              onMcpDecision={handleMCPApproval}
              onPickSuggestion={(command) => {
                setInput(command);
              }}
              composer={
                <Composer
                  input={input}
                  onInputChange={handleInputChanged}
                  onSend={() => {
                    setMentionMenuOpen(false);
                    setSlashMenuOpen(false);
                    handleSend();
                  }}
                  onStop={handleStop}
                  onRetry={
                    lastPrompt
                      ? () => {
                          setToolEvents([]);
                          setStreamingText("");
                          setIsRunning(true);
                          sendMessage(
                            "task/retry",
                            buildRetryPayload(lastPrompt),
                          );
                        }
                      : null
                  }
                  onHeal={
                    !isRunning
                      ? () => {
                          sendMessage("agent/heal", {
                            exitCode: 1,
                            stderr: "Agent requested self-healing",
                            diagnostics: [],
                            validateCommand: "echo validation",
                          });
                          setIsRunning(true);
                        }
                      : undefined
                  }
                  isRunning={isRunning}
                  mentionMenuOpen={mentionMenuOpen}
                  slashMenuOpen={slashMenuOpen}
                  onCloseMenus={() => {
                    setMentionMenuOpen(false);
                    setSlashMenuOpen(false);
                  }}
                  onAttachFile={handleAttachFile}
                  onAttachFolder={handleAttachFolder}
                  onAttachUrl={handleAttachUrl}
                  onAttachProblems={handleAttachProblems}
                  onAttachSelection={handleAttachSelection}
                  onPickMention={(attach) => {
                    closeMentionMenuAndStripKeyword();
                    attach();
                  }}
                  onPickSlash={(command) => {
                    setSlashMenuOpen(false);
                    setInput(command);
                  }}
                  composerContext={composerContext}
                  onRemoveContext={(id) =>
                    setComposerContext((prev) => removeContextEntry(prev, id))
                  }
                  settings={settings}
                  models={models}
                  modelsLoading={false}
                  onModeChange={(mode) => {
                    setSettings((s) => ({ ...s, agentMode: mode }));
                    sendMessage("settings/set", {
                      key: "agentMode",
                      value: mode,
                    });
                  }}
                  onModelChange={(model) => {
                    setSettings((s) => ({ ...s, model }));
                    sendMessage("settings/set", { key: "model", value: model });
                  }}
                  onRefreshModels={() => sendMessage("model/list", {})}
                  usage={usage}
                  autoApproval={autoApproval}
                />
              }
              executionStatus={
                <ExecutionStatus
                  isRunning={isRunning}
                  statusMessage={statusMessage}
                  toolEvents={toolEvents}
                  healing={healingState}
                  requestId={activeRequestIdRef.current}
                />
              }
              healingOutcome={
                healingState && !healingState.active ? (
                  <HealingOutcome healing={healingState} />
                ) : null
              }
              continuityBar={
                <>
                  <ContinuityBar
                    state={continuity}
                    isRunning={isRunning}
                    onReset={handleNewConversation}
                  />
                  {activeSkillNames.length > 0 && (
                    <div
                      title="Skills whose instructions join the next prompt (context only — M4 still gates every tool)"
                      className="px-3 py-1 text-[10px] text-vscode-desc truncate"
                    >
                      Active skills: {activeSkillNames.join(", ")}
                    </div>
                  )}
                </>
              }
            />
          )}

          {/* TAB: TOOLS */}
          {currentTab === "tools" && (
            <div className="p-3 overflow-y-auto h-full space-y-4">
              <div>
                <SectionHeader
                  title="Registered tools"
                  count={toolRegistry.length}
                  actions={
                    <Button
                      size="xs"
                      onClick={() => sendMessage("tools/list", {})}
                      aria-label="Refresh tool registry"
                    >
                      <IconRefresh size={10} /> Refresh
                    </Button>
                  }
                />
                <div className="mt-2 space-y-1">
                  {toolRegistry.length === 0 ? (
                    <EmptyState
                      title="Registry unavailable"
                      hint="The runtime has not started yet, so no tools are registered."
                    />
                  ) : (
                    toolRegistry.map((tool) => (
                      <div
                        key={`${tool.source}:${tool.name}`}
                        title={tool.description || tool.name}
                        className="rounded-md border border-vscode-border bg-vscode-panel/60 px-2.5 py-1.5"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[11px] text-vscode-fg font-medium truncate">
                            {tool.name}
                          </span>
                          {tool.callableName != null &&
                            tool.callableName !== tool.name && (
                              <span
                                className="font-mono text-[10px] text-vscode-desc truncate"
                                title={`Resolved by the model as ${tool.callableName}`}
                              >
                                → {tool.callableName}
                              </span>
                            )}
                          <Badge
                            tone={
                              tool.permission === "auto"
                                ? "success"
                                : tool.permission === "blocked"
                                  ? "danger"
                                  : "warning"
                            }
                          >
                            {tool.permission === "auto"
                              ? "auto"
                              : tool.permission}
                          </Badge>
                          {tool.source === "mcp" && (
                            <Badge tone="info">
                              MCP{tool.serverName ? `: ${tool.serverName}` : ""}
                            </Badge>
                          )}
                        </div>
                        {tool.description && (
                          <div className="text-[10px] text-vscode-desc mt-0.5">
                            {tool.description}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div>
                <SectionHeader
                  title="Session activity"
                  count={toolEvents.length}
                />
                <div className="mt-2">
                  {toolEvents.length === 0 ? (
                    <EmptyState
                      title="No tool activity yet"
                      hint="Tool executions from chat turns appear here."
                    />
                  ) : (
                    <div className="space-y-1">
                      {toolEvents.map((evt) => (
                        <ToolCard key={evt.id} event={evt} />
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div>
                <SectionHeader
                  title="Terminal sessions"
                  count={terminalSessions.length}
                  actions={
                    <span className="flex gap-1">
                      <Button
                        size="xs"
                        variant="primary"
                        onClick={handleTerminalStart}
                      >
                        <IconPlus size={10} /> New
                      </Button>
                      <Button size="xs" onClick={handleTerminalRefresh}>
                        <IconRefresh size={10} />
                      </Button>
                    </span>
                  }
                />
                <div className="mt-2 space-y-1">
                  {terminalSessions.length === 0 ? (
                    <EmptyState
                      title="No tracked sessions"
                      hint="Started sessions run through the M4 permission gate and stream output here."
                    />
                  ) : (
                    terminalSessions.map((s) => (
                      <div
                        key={s.id}
                        className="rounded-md border border-vscode-border bg-vscode-panel/60 px-2.5 py-1.5 text-[10px]"
                      >
                        <div className="flex items-center gap-2">
                          <IconTerminal
                            size={12}
                            className="text-vscode-desc flex-shrink-0"
                          />
                          <span
                            className="font-mono text-vscode-fg truncate"
                            title={s.command ?? s.id}
                          >
                            {s.command ?? s.id.slice(0, 12)}
                          </span>
                          {s.status === "running" && (
                            <span
                              className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-vscode-info-fg"
                              aria-label="running"
                            />
                          )}
                          <Badge
                            tone={
                              s.status === "running"
                                ? "info"
                                : s.exitCode === 0
                                  ? "success"
                                  : s.exitCode != null
                                    ? "danger"
                                    : "muted"
                            }
                          >
                            {s.status}
                            {s.exitCode !== null && s.exitCode !== undefined
                              ? ` exit ${s.exitCode}`
                              : ""}
                          </Badge>
                          <span className="ml-auto font-mono text-vscode-desc flex-shrink-0">
                            {(s.durationMs / 1000).toFixed(1)}s
                          </span>
                          {s.status === "running" && (
                            <>
                              <Button
                                size="xs"
                                onClick={() => handleTerminalStop(s.id, false)}
                              >
                                Stop
                              </Button>
                              <Button
                                size="xs"
                                variant="danger"
                                onClick={() => handleTerminalStop(s.id, true)}
                              >
                                Kill
                              </Button>
                            </>
                          )}
                        </div>
                        {/* Live streamed output (stdout+stderr, stream labels) —
                            event-fed, bounded display buffer. Rendered as text. */}
                        {s.liveOutput && (
                          <pre
                            className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-all rounded bg-vscode-bg/80 p-1 font-mono text-[9px] leading-relaxed text-vscode-fg"
                            aria-live="polite"
                          >
                            {s.liveOutput.slice(-MAX_SESSION_LIVE_BUFFER)}
                            {s.liveTruncated && (
                              <span className="text-vscode-desc">
                                {"\n…[live output truncated]…"}
                              </span>
                            )}
                          </pre>
                        )}
                        {s.stderr && !s.liveOutput && (
                          <div className="text-vscode-error-fg mt-0.5 truncate font-mono">
                            {s.stderr.slice(0, 120)}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>

                {/* M7 — per-command history (bounded, host-provided). */}
                {terminalHistory.length > 0 && (
                  <div className="mt-2">
                    <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-vscode-desc">
                      Command history
                    </div>
                    <div className="space-y-1">
                      {terminalHistory
                        .slice(-20)
                        .reverse()
                        .map((h) => (
                          <details
                            key={h.sessionId}
                            className="rounded-md border border-vscode-border bg-vscode-panel/40 px-2.5 py-1.5 text-[10px]"
                          >
                            <summary className="flex cursor-pointer items-center gap-2">
                              <span
                                className={`font-mono ${h.status === "exited" && h.exitCode === 0 ? "text-vscode-fg" : "text-vscode-error-fg"} truncate`}
                              >
                                {h.command}
                              </span>
                              <Badge
                                tone={
                                  h.cancelled
                                    ? "muted"
                                    : h.timedOut
                                      ? "danger"
                                      : h.exitCode === 0
                                        ? "success"
                                        : h.exitCode != null
                                          ? "danger"
                                          : "muted"
                                }
                              >
                                {h.cancelled
                                  ? "cancelled"
                                  : h.timedOut
                                    ? "timeout"
                                    : h.status}
                                {h.exitCode !== null && h.exitCode !== 0
                                  ? ` exit ${h.exitCode}`
                                  : ""}
                              </Badge>
                              <span className="ml-auto font-mono text-vscode-desc flex-shrink-0">
                                {(h.durationMs / 1000).toFixed(1)}s
                              </span>
                            </summary>
                            <div className="mt-1">
                              {h.outputTruncated && (
                                <div className="text-vscode-desc mb-0.5">
                                  …[output truncated — showing tail]…
                                </div>
                              )}
                              {h.stdoutTail && (
                                <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap break-all rounded bg-vscode-bg/80 p-1 font-mono text-[9px] text-vscode-fg">
                                  {h.stdoutTail}
                                </pre>
                              )}
                              {h.stderrTail && (
                                <pre className="mt-0.5 max-h-16 overflow-y-auto whitespace-pre-wrap break-all rounded bg-vscode-bg/80 p-1 font-mono text-[9px] text-vscode-error-fg">
                                  {h.stderrTail}
                                </pre>
                              )}
                            </div>
                          </details>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB: CHANGES */}
          {currentTab === "changes" && (
            <DiffViewer
              changes={fileChanges}
              onAccept={handleAcceptFile}
              onReject={handleRejectFile}
              onAcceptAll={handleAcceptAll}
              onRejectAll={handleRejectAll}
              onRollback={handleRollbackFile}
              pendingApproval={pendingApproval}
            />
          )}

          {/* TAB: HISTORY */}
          {currentTab === "history" && (
            <div className="p-3 space-y-3 overflow-y-auto h-full">
              <SectionHeader
                title="Task history"
                count={taskHistory.length}
                actions={
                  <Button size="xs" onClick={refreshHistory}>
                    <IconRefresh size={10} /> Refresh
                  </Button>
                }
              />

              {historyError && (
                <ErrorBanner
                  message={historyError}
                  onDismiss={() => setHistoryError(null)}
                />
              )}

              <div className="flex flex-wrap items-end gap-1.5">
                <span className="flex-1 min-w-[120px]">
                  <Field label="Search" htmlFor="hist-q">
                    <Input
                      id="hist-q"
                      value={historyFilter.query}
                      onChange={(e) =>
                        applyHistoryFilter({ query: e.target.value })
                      }
                      placeholder="title, prompt, id…"
                      className="w-full"
                    />
                  </Field>
                </span>
                <Field label="Status" htmlFor="hist-status">
                  <Select
                    id="hist-status"
                    value={historyFilter.status}
                    onChange={(e) =>
                      applyHistoryFilter({ status: e.target.value })
                    }
                  >
                    {[
                      "all",
                      "running",
                      "completed",
                      "failed",
                      "cancelled",
                      "interrupted",
                      "archived",
                    ].map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Filter" htmlFor="hist-flag">
                  <Select
                    id="hist-flag"
                    value={historyFilter.flag}
                    onChange={(e) =>
                      applyHistoryFilter({
                        flag: e.target.value as TaskHistoryFilter["flag"],
                      })
                    }
                  >
                    <option value="all">all</option>
                    <option value="failed">failed</option>
                    <option value="interrupted">interrupted</option>
                    <option value="completed">completed</option>
                    <option value="has-checkpoints">has checkpoint</option>
                    <option value="has-files">has file changes</option>
                  </Select>
                </Field>
                <Field label="Mode" htmlFor="hist-mode">
                  <Select
                    id="hist-mode"
                    value={historyFilter.mode}
                    onChange={(e) =>
                      applyHistoryFilter({ mode: e.target.value })
                    }
                  >
                    {["all", "act", "plan", "ask", "review", "auto"].map(
                      (s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ),
                    )}
                  </Select>
                </Field>
              </div>

              {historyLoading && taskHistory.length === 0 ? (
                <EmptyState title="Loading tasks…" />
              ) : taskHistory.length === 0 ? (
                <EmptyState
                  title="No tasks match"
                  hint="Start a chat turn to create your first task."
                />
              ) : (
                <div className="space-y-1.5">
                  {taskHistory.map((t) => (
                    <TaskHistoryRow
                      key={t.id}
                      task={t}
                      selected={selectedHistoryTaskId === t.id}
                      compareChecked={compareSelect.includes(t.id)}
                      onCompareToggle={() =>
                        setCompareSelect((prev) =>
                          prev.includes(t.id)
                            ? prev.filter((x) => x !== t.id)
                            : [...prev.slice(-1), t.id],
                        )
                      }
                      onInspect={() => selectHistoryTask(t.id)}
                      onResume={() =>
                        sendHistoryAction("history/resume", { taskId: t.id })
                      }
                      onRestart={() =>
                        setHistoryConfirm({
                          action: "restart",
                          taskId: t.id,
                          title: t.title,
                        })
                      }
                      onDiscard={() =>
                        setHistoryConfirm({
                          action: "discard",
                          taskId: t.id,
                          title: t.title,
                        })
                      }
                    />
                  ))}
                </div>
              )}

              {compareSelect.length === 2 && (
                <Button
                  variant="primary"
                  onClick={() =>
                    sendHistoryAction("history/compare", {
                      aTaskId: compareSelect[0],
                      bTaskId: compareSelect[1],
                    })
                  }
                >
                  Compare selected runs
                </Button>
              )}
              {compareSelect.length > 2 && (
                <p className="text-[10px] text-vscode-warning-fg">
                  Select exactly two tasks to compare.
                </p>
              )}

              {(historyDetails ??
                taskHistory.find((t) => t.id === selectedHistoryTaskId) ??
                null) && (
                <HistoryDetailsView
                  details={
                    historyDetails ??
                    ({
                      ...taskHistory.find(
                        (t) => t.id === selectedHistoryTaskId,
                      )!,
                      timeline: [],
                      files: {
                        created: [],
                        modified: [],
                        deleted: [],
                        renamed: [],
                        totalAdditions: 0,
                        totalDeletions: 0,
                      },
                      checkpoints: [],
                      messages: [],
                      tools: [],
                      approvalsNote: "",
                      errors: [],
                      metrics: {
                        toolCallCount: 0,
                        retryCount: 0,
                        filesChangedCount: 0,
                        checkpointCount: 0,
                        messageCount: 0,
                      },
                    } as TaskDetails)
                  }
                  sections={historySections}
                  onToggleSection={toggleHistorySection}
                  onClose={() => {
                    setSelectedHistoryTaskId(null);
                    setHistoryDetails(null);
                    setRunCompare(null);
                    setCpCompareSelect([]);
                    setCpCompare(null);
                  }}
                  onResume={() =>
                    sendHistoryAction("history/resume", {
                      taskId: selectedHistoryTaskId!,
                    })
                  }
                  onRestart={() => {
                    const t = taskHistory.find(
                      (x) => x.id === selectedHistoryTaskId,
                    );
                    if (t)
                      setHistoryConfirm({
                        action: "restart",
                        taskId: t.id,
                        title: t.title,
                      });
                  }}
                  onDiscard={() => {
                    const t = taskHistory.find(
                      (x) => x.id === selectedHistoryTaskId,
                    );
                    if (t)
                      setHistoryConfirm({
                        action: "discard",
                        taskId: t.id,
                        title: t.title,
                      });
                  }}
                  onRestore={(checkpointId) => {
                    if (selectedHistoryTaskId) {
                      setHistoryConfirm({
                        action: "restore",
                        taskId: selectedHistoryTaskId,
                        checkpointId,
                        title: checkpointId,
                      });
                    }
                  }}
                  compareSelect={compareSelect}
                  runCompare={runCompare}
                  cpCompareSelect={cpCompareSelect}
                  onCpCompareToggle={(cpId) =>
                    setCpCompareSelect((prev) =>
                      prev.includes(cpId)
                        ? prev.filter((x) => x !== cpId)
                        : [...prev.slice(-1), cpId],
                    )
                  }
                  onCpCompare={() => {
                    if (cpCompareSelect.length === 2) {
                      sendHistoryAction("history/checkpoint-compare", {
                        aCheckpointId: cpCompareSelect[0],
                        bCheckpointId: cpCompareSelect[1],
                      });
                    }
                  }}
                  cpCompare={cpCompare}
                />
              )}

              {historyConfirm && (
                <ConfirmCard
                  title={
                    historyConfirm.action === "discard"
                      ? `Discard task '${historyConfirm.title.slice(0, 60)}'?`
                      : historyConfirm.action === "restart"
                        ? `Restart task '${historyConfirm.title.slice(0, 60)}' as a new run?`
                        : `Restore checkpoint '${(historyConfirm.checkpointId ?? "").slice(0, 24)}…'?`
                  }
                  detail={
                    historyConfirm.action === "discard"
                      ? "The persisted task record and its history are deleted permanently. Workspace files are untouched."
                      : historyConfirm.action === "restart"
                        ? "A fresh task starts from the original prompt. Completed work is not copied; every operation still requires approval."
                        : "Workspace files are overwritten with checkpoint state through the M4-gated restore path. Files changed externally may conflict instead of restoring."
                  }
                  confirmLabel={
                    historyConfirm.action === "discard"
                      ? "Discard"
                      : historyConfirm.action === "restart"
                        ? "Restart"
                        : "Restore"
                  }
                  onConfirm={confirmHistoryAction}
                  onCancel={() => setHistoryConfirm(null)}
                />
              )}

              <div className="pt-1 border-t border-vscode-border">
                <SectionHeader
                  title="Sessions"
                  count={sessions.length}
                  actions={
                    <Button
                      size="xs"
                      onClick={() => sendMessage("session/list", {})}
                    >
                      <IconRefresh size={10} /> Refresh
                    </Button>
                  }
                />
                {sessions.length === 0 ? (
                  <p className="text-[10px] text-vscode-desc mt-2">
                    No sessions.
                  </p>
                ) : (
                  <div className="space-y-2 mt-2">
                    {sessions.map((s) => (
                      <div
                        key={s.id}
                        className="rounded-md border border-vscode-border bg-vscode-panel/60 px-3 py-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] text-vscode-fg font-mono truncate">
                            {s.title ?? s.id.slice(0, 8)}
                          </span>
                          <span className="text-[10px] text-vscode-desc flex-shrink-0">
                            {s.updatedAt
                              ? new Date(s.updatedAt).toLocaleString()
                              : ""}
                          </span>
                        </div>
                        <div className="flex gap-1.5 mt-1.5">
                          <Button
                            size="xs"
                            variant="primary"
                            onClick={() =>
                              sendMessage("session/resume", { sessionId: s.id })
                            }
                          >
                            Resume
                          </Button>
                          <Button
                            size="xs"
                            variant="danger"
                            onClick={() =>
                              sendMessage("session/delete", { sessionId: s.id })
                            }
                          >
                            Delete
                          </Button>
                          <Button
                            size="xs"
                            onClick={() => handleSelectTaskForCheckpoints(s.id)}
                          >
                            Checkpoints
                          </Button>
                        </div>
                        {selectedTaskId === s.id && (
                          <div className="mt-2 pl-2 border-l-2 border-vscode-border space-y-1">
                            {checkpoints.length === 0 ? (
                              <div className="text-[10px] text-vscode-desc py-1">
                                No checkpoints for this task.
                              </div>
                            ) : (
                              checkpoints.map((cp) => (
                                <div
                                  key={cp.id}
                                  className="flex items-center justify-between gap-2 text-[10px] px-1.5 py-1 rounded bg-vscode-input-bg"
                                >
                                  <span className="truncate">
                                    {cp.timestamp
                                      ? new Date(cp.timestamp).toLocaleString()
                                      : ""}
                                    {(cp.description || "").length > 0
                                      ? ` — ${cp.description}`
                                      : ""}
                                  </span>
                                  <span className="text-vscode-desc flex-shrink-0">
                                    {cp.fileCount} files
                                  </span>
                                  <Button
                                    size="xs"
                                    onClick={() =>
                                      sendMessage("checkpoint/restore", {
                                        checkpointId: cp.id,
                                      })
                                    }
                                    aria-label={`Restore checkpoint from ${cp.timestamp ? new Date(cp.timestamp).toLocaleString() : cp.id}`}
                                  >
                                    Restore
                                  </Button>
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB: PLUGINS */}
          {currentTab === "plugins" && (
            <div className="p-3 space-y-3 overflow-y-auto h-full">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label="Search plugins"
                  value={pluginQuery}
                  onChange={(e) => setPluginQuery(e.target.value)}
                  placeholder="Search plugins…"
                  className="flex-1 min-w-[140px]"
                />
                <Select
                  aria-label="Filter by trust"
                  value={pluginTrustFilter}
                  onChange={(e) =>
                    setPluginTrustFilter(
                      e.target.value as "all" | PluginDisplayTrust,
                    )
                  }
                >
                  <option value="all">all trust levels</option>
                  <option value="trusted">trusted</option>
                  <option value="verified">verified</option>
                  <option value="community">community</option>
                  <option value="untrusted">untrusted</option>
                  <option value="blocked">blocked</option>
                </Select>
                <Button size="sm" onClick={refreshPlugins}>
                  <IconRefresh size={11} /> Refresh
                </Button>
              </div>

              {pluginError && (
                <ErrorBanner
                  message={pluginError}
                  onDismiss={() => setPluginError(null)}
                />
              )}

              {pluginsLoading && plugins.length === 0 ? (
                <EmptyState title="Loading plugins…" />
              ) : (
                <>
                  {pluginProblems.length > 0 && (
                    <div className="rounded-md border border-vscode-warning-fg/40 bg-vscode-warning-fg/5 px-2.5 py-1.5">
                      <div className="text-[11px] font-semibold text-vscode-warning-fg mb-1">
                        {pluginProblems.length} manifest problem
                        {pluginProblems.length === 1 ? "" : "s"} — fix the file,
                        then Refresh
                      </div>
                      {pluginProblems.map((m, i) => (
                        <div
                          key={i}
                          className="text-[10px] text-vscode-warning-fg/80 font-mono break-words"
                        >
                          {m.error}
                        </div>
                      ))}
                    </div>
                  )}

                  <PluginSection
                    title={`Installed (${selectInstalledPlugins(plugins).length})`}
                    empty="No plugins installed yet. Install one from Available below."
                  >
                    {filterPlugins(
                      selectInstalledPlugins(plugins),
                      pluginQuery,
                      pluginTrustFilter,
                    ).map((p) => (
                      <PluginRow
                        key={p.id}
                        plugin={p}
                        selected={selectedPluginId === p.id}
                        onInspect={() => selectPlugin(p.id)}
                        onToggle={() =>
                          sendPluginAction(
                            p.enabled
                              ? "plugins/deactivate"
                              : "plugins/activate",
                            { id: p.id },
                          )
                        }
                        onUninstall={() =>
                          setPluginConfirm({ action: "uninstall", plugin: p })
                        }
                        onEnableUntrusted={() =>
                          setPluginConfirm({
                            action: "enable-untrusted",
                            plugin: p,
                          })
                        }
                      />
                    ))}
                  </PluginSection>

                  <PluginSection
                    title={`Available (${selectAvailablePlugins(plugins).length})`}
                    empty="Nothing new discovered. Drop a folder with codepilot.plugin.json into .codepilot/plugins/ and Refresh."
                  >
                    {filterPlugins(
                      selectAvailablePlugins(plugins),
                      pluginQuery,
                      pluginTrustFilter,
                    ).map((p) => (
                      <PluginRow
                        key={p.id}
                        plugin={p}
                        selected={selectedPluginId === p.id}
                        onInspect={() => selectPlugin(p.id)}
                        onInstall={() =>
                          p.displayTrust === "untrusted"
                            ? setPluginConfirm({
                                action: "install-untrusted",
                                plugin: p,
                              })
                            : sendPluginAction("plugins/install", { id: p.id })
                        }
                      />
                    ))}
                  </PluginSection>

                  {(pluginDetails ??
                    plugins.find((p) => p.id === selectedPluginId) ??
                    null) && (
                    <PluginDetailsView
                      plugin={
                        (pluginDetails ??
                          plugins.find((p) => p.id === selectedPluginId))!
                      }
                      invokeTool={invokeTool}
                      setInvokeTool={setInvokeTool}
                      invokeArgs={invokeArgs}
                      setInvokeArgs={setInvokeArgs}
                      invokeOutput={invokeOutput}
                      onInvoke={invokeSelectedTool}
                      onClose={() => {
                        setSelectedPluginId(null);
                        setPluginDetails(null);
                        setInvokeOutput(null);
                      }}
                      onToggle={(p) =>
                        sendPluginAction(
                          p.enabled ? "plugins/deactivate" : "plugins/activate",
                          { id: p.id },
                        )
                      }
                      onUninstall={(p) =>
                        setPluginConfirm({ action: "uninstall", plugin: p })
                      }
                      onEnableUntrusted={(p) =>
                        setPluginConfirm({
                          action: "enable-untrusted",
                          plugin: p,
                        })
                      }
                      onInstallUntrusted={(p) =>
                        setPluginConfirm({
                          action: "install-untrusted",
                          plugin: p,
                        })
                      }
                      onInstall={(p) =>
                        sendPluginAction("plugins/install", { id: p.id })
                      }
                    />
                  )}
                </>
              )}

              {pluginConfirm && (
                <ConfirmCard
                  title={
                    pluginConfirm.action === "uninstall"
                      ? `Uninstall '${pluginConfirm.plugin.id}'?`
                      : `Trust '${pluginConfirm.plugin.id}'?`
                  }
                  detail={
                    pluginConfirm.action === "uninstall"
                      ? "This removes the plugin and unregisters its tools. This cannot be undone except by reinstalling."
                      : "This is an UNTRUSTED community plugin. It stays capability-restricted and every tool call still requires M4 approval — but only continue if you trust the source."
                  }
                  confirmLabel={
                    pluginConfirm.action === "uninstall"
                      ? "Uninstall"
                      : "Trust & continue"
                  }
                  onConfirm={confirmPluginAction}
                  onCancel={() => setPluginConfirm(null)}
                />
              )}
            </div>
          )}

          {/* TAB: SKILLS */}
          {currentTab === "skills" && (
            <div className="p-3 space-y-3 overflow-y-auto h-full">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label="Search skills"
                  value={skillQuery}
                  onChange={(e) => setSkillQuery(e.target.value)}
                  placeholder="Search skills…"
                  className="flex-1 min-w-[140px]"
                />
                <Button size="sm" onClick={refreshSkills}>
                  <IconRefresh size={11} /> Refresh
                </Button>
              </div>

              <div className="text-[10px] text-vscode-desc">
                Only ACTIVE skills join the next prompt (bounded context). Skills
                are repository content — they cannot bypass M4, disable
                approval, or execute code.
              </div>

              {skillError && (
                <ErrorBanner
                  message={skillError}
                  onDismiss={() => setSkillError(null)}
                />
              )}
              {skillNotice && (
                <div className="rounded-md border border-vscode-text-link/40 bg-vscode-text-link/5 px-2.5 py-1.5 text-[11px] text-vscode-fg flex items-center justify-between gap-2">
                  <span>{skillNotice}</span>
                  <button
                    aria-label="Dismiss notice"
                    className="text-vscode-desc hover:text-vscode-fg"
                    onClick={() => setSkillNotice(null)}
                  >
                    ✕
                  </button>
                </div>
              )}

              {skillsLoading && skills.length === 0 ? (
                <EmptyState title="Loading skills…" />
              ) : skills.length === 0 ? (
                <EmptyState title="No skills discovered" />
              ) : (
                <div className="space-y-2">
                  {skills
                    .filter((s) => {
                      const q = skillQuery.trim().toLowerCase();
                      if (!q) return true;
                      return (
                        s.name.toLowerCase().includes(q) ||
                        s.description.toLowerCase().includes(q) ||
                        s.tags.some((t) => t.toLowerCase().includes(q))
                      );
                    })
                    .map((s) => (
                      <div
                        key={s.id}
                        className={`rounded-md border px-2.5 py-2 ${
                          selectedSkillName === s.name
                            ? "border-vscode-text-link"
                            : "border-vscode-border"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-[12px] font-semibold font-mono truncate flex-1">
                            {s.name}
                          </span>
                          <span
                            title={s.enabled ? "Active — in next prompt" : "Inactive"}
                            className={`text-[9px] font-semibold px-1.5 py-0.5 rounded border ${
                              s.enabled
                                ? "bg-green-900 text-green-200 border-green-700"
                                : "text-vscode-desc border-vscode-border"
                            }`}
                          >
                            {s.enabled ? "ACTIVE" : "INACTIVE"}
                          </span>
                          <Button
                            size="xs"
                            onClick={() =>
                              sendSkillAction(
                                s.enabled
                                  ? "skills/deactivate"
                                  : "skills/activate",
                                { name: s.name },
                              )
                            }
                          >
                            {s.enabled ? "Deactivate" : "Activate"}
                          </Button>
                          <Button
                            size="xs"
                            onClick={() => {
                              setSelectedSkillName(s.name);
                              sendSkillAction("skills/get", { name: s.name });
                            }}
                          >
                            Inspect
                          </Button>
                        </div>
                        {s.description && (
                          <div className="text-[11px] text-vscode-fg/90 mt-1 break-words">
                            {s.description}
                          </div>
                        )}
                        <div className="text-[10px] text-vscode-desc mt-1 font-mono truncate">
                          {s.source}
                          {s.version ? ` · v${s.version}` : ""} · {s.filePath}
                          {s.appliesTo.length > 0
                            ? ` · applies: ${s.appliesTo.join(", ")}`
                            : ""}
                          {s.tags.length > 0
                            ? ` · tags: ${s.tags.join(", ")}`
                            : ""}
                        </div>
                        {s.instructionPreview && (
                          <div className="text-[10px] text-vscode-desc mt-1 break-words">
                            {s.instructionPreview}
                            {s.instructionChars > s.instructionPreview.length
                              ? ` … (${s.instructionChars} chars total)`
                              : ""}
                          </div>
                        )}
                      </div>
                    ))}
                </div>
              )}

              {skillsSkipped.length > 0 && (
                <div className="rounded-md border border-vscode-warning-fg/40 bg-vscode-warning-fg/5 px-2.5 py-1.5">
                  <div className="text-[11px] font-semibold text-vscode-warning-fg mb-1">
                    {skillsSkipped.length} file
                    {skillsSkipped.length === 1 ? "" : "s"} skipped by validation
                    — fix the file, then Refresh
                  </div>
                  {skillsSkipped.map((m, i) => (
                    <div
                      key={i}
                      className="text-[10px] text-vscode-warning-fg/80 font-mono break-words"
                    >
                      {m.path}: {m.reason}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB: TEAM */}
          {currentTab === "team" && (
            <div className="p-3 space-y-3 overflow-y-auto h-full">
              <SectionHeader
                title="Multi-agent teams"
                count={teams.length}
                actions={
                  <Button size="xs" onClick={refreshTeams}>
                    <IconRefresh size={10} /> Refresh
                  </Button>
                }
              />

              {teamError && (
                <ErrorBanner
                  message={teamError}
                  onDismiss={() => setTeamError(null)}
                />
              )}

              <Card className="px-3 py-2">
                <div className="text-[11px] font-semibold text-vscode-fg mb-1.5">
                  New team
                </div>
                <Field label="Main objective" htmlFor="team-objective">
                  <Textarea
                    id="team-objective"
                    value={teamForm.objective}
                    onChange={(e) =>
                      setTeamForm((prev) => ({
                        ...prev,
                        objective: e.target.value,
                      }))
                    }
                    placeholder="e.g. Implement caching for the API layer with tests"
                    rows={2}
                    className="w-full"
                  />
                </Field>
                <div className="text-[10px] text-vscode-desc mb-1 mt-1.5">
                  Roles (empty = auto-classify from objective)
                </div>
                <div className="flex flex-wrap gap-1.5 mb-1.5">
                  {TEAM_ROLE_OPTIONS.map((role) => (
                    <label
                      key={role}
                      className="flex items-center gap-1 text-[10px] text-vscode-fg"
                    >
                      <input
                        type="checkbox"
                        checked={teamForm.roles.includes(role)}
                        onChange={(e) =>
                          setTeamForm((prev) => ({
                            ...prev,
                            roles: e.target.checked
                              ? [...prev.roles, role]
                              : prev.roles.filter((r) => r !== role),
                          }))
                        }
                      />
                      {teamRoleLabel(role)}
                    </label>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <Field label="Parallel agents" htmlFor="team-concurrency">
                    <Select
                      id="team-concurrency"
                      value={teamForm.maxConcurrency}
                      onChange={(e) =>
                        setTeamForm((prev) => ({
                          ...prev,
                          maxConcurrency: Number(e.target.value),
                        }))
                      }
                    >
                      {[1, 2, 3, 4].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <span className="flex-1" />
                  <Button
                    variant="primary"
                    onClick={createTeamFromForm}
                    disabled={!teamForm.objective.trim()}
                    className="self-end"
                  >
                    Create team
                  </Button>
                </div>
              </Card>

              {teamsLoading && teams.length === 0 ? (
                <EmptyState title="Loading teams…" />
              ) : teams.length === 0 ? (
                <EmptyState
                  title="No teams yet"
                  hint="Describe an objective above to assemble a planner → coder → tester → reviewer pipeline."
                />
              ) : (
                <div className="space-y-1.5">
                  {teams.map((t) => (
                    <TeamRow
                      key={t.teamId}
                      team={t}
                      selected={selectedTeamId === t.teamId}
                      onInspect={() => selectTeam(t.teamId)}
                      onStart={() =>
                        sendTeamAction("team/start", { teamId: t.teamId })
                      }
                      onCancel={() =>
                        setTeamConfirm({ action: "cancel", team: t })
                      }
                      onRetry={() =>
                        setTeamConfirm({ action: "retry", team: t })
                      }
                      onRemove={() =>
                        setTeamConfirm({ action: "remove", team: t })
                      }
                    />
                  ))}
                </div>
              )}

              {(teamDetails ??
                teams.find((t) => t.teamId === selectedTeamId) ??
                null) && (
                <TeamDetailsView
                  team={
                    (teamDetails ??
                      teams.find((t) => t.teamId === selectedTeamId))!
                  }
                  expandedTaskId={selectedTeamTaskId}
                  setExpandedTaskId={setSelectedTeamTaskId}
                  onClose={() => {
                    setSelectedTeamId(null);
                    setTeamDetails(null);
                    setSelectedTeamTaskId(null);
                  }}
                  onStart={(t) =>
                    sendTeamAction("team/start", { teamId: t.teamId })
                  }
                  onCancel={(t) =>
                    setTeamConfirm({ action: "cancel", team: t })
                  }
                  onRetry={(t) => setTeamConfirm({ action: "retry", team: t })}
                  onRemove={(t) =>
                    setTeamConfirm({ action: "remove", team: t })
                  }
                />
              )}

              {teamConfirm && (
                <ConfirmCard
                  title={
                    teamConfirm.action === "cancel"
                      ? "Cancel the running team?"
                      : teamConfirm.action === "retry"
                        ? "Retry the failed team?"
                        : "Remove this team?"
                  }
                  detail={
                    teamConfirm.action === "cancel"
                      ? "Running agents are aborted, queued agents are dropped, and file locks are released. Completed work is preserved."
                      : teamConfirm.action === "retry"
                        ? "A new run starts from the failure. Completed work is summarized into the new run — it is not blindly repeated, and every operation still requires approval."
                        : "The team record and its history are deleted permanently."
                  }
                  confirmLabel={
                    teamConfirm.action === "cancel"
                      ? "Cancel run"
                      : teamConfirm.action === "retry"
                        ? "Retry"
                        : "Remove"
                  }
                  onConfirm={confirmTeamAction}
                  onCancel={() => setTeamConfirm(null)}
                />
              )}
            </div>
          )}

          {/* TAB: SCHEDULES */}
          {currentTab === "schedules" && (
            <div className="p-3 space-y-3 overflow-y-auto h-full">
              <SectionHeader
                title="Scheduled tasks"
                count={schedules.length}
                actions={
                  <Button size="xs" onClick={refreshSchedules}>
                    <IconRefresh size={10} /> Refresh
                  </Button>
                }
              />

              {scheduleError && (
                <ErrorBanner
                  message={scheduleError}
                  onDismiss={() => setScheduleError(null)}
                />
              )}

              <Card className="px-3 py-2">
                <div className="text-[11px] font-semibold text-vscode-fg mb-1.5">
                  {editingScheduleId ? "Edit schedule" : "New schedule"}
                </div>
                <div className="space-y-1.5">
                  <Field label="Name" htmlFor="sched-name">
                    <Input
                      id="sched-name"
                      value={scheduleForm.name}
                      onChange={(e) =>
                        setScheduleForm((prev) => ({
                          ...prev,
                          name: e.target.value,
                        }))
                      }
                      placeholder="e.g. Nightly test run"
                      className="w-full"
                    />
                  </Field>
                  <Field
                    label="Prompt (runs through the live runtime, M4-gated)"
                    htmlFor="sched-prompt"
                  >
                    <Textarea
                      id="sched-prompt"
                      value={scheduleForm.prompt}
                      onChange={(e) =>
                        setScheduleForm((prev) => ({
                          ...prev,
                          prompt: e.target.value,
                        }))
                      }
                      placeholder="e.g. Run the test suite and summarize failures"
                      rows={2}
                      className="w-full"
                    />
                  </Field>
                  <div className="flex flex-wrap items-end gap-2">
                    <Field label="Repeats" htmlFor="sched-kind">
                      <Select
                        id="sched-kind"
                        value={scheduleForm.kind}
                        onChange={(e) =>
                          setScheduleForm((prev) => ({
                            ...prev,
                            kind: e.target.value as
                              "interval" | "daily" | "once",
                          }))
                        }
                      >
                        <option value="interval">every N minutes</option>
                        <option value="daily">daily at time</option>
                        <option value="once">once at date/time</option>
                      </Select>
                    </Field>
                    {scheduleForm.kind === "interval" && (
                      <Field label="Minutes (≥ 1)" htmlFor="sched-every">
                        <Input
                          id="sched-every"
                          value={scheduleForm.everyMinutes}
                          onChange={(e) =>
                            setScheduleForm((prev) => ({
                              ...prev,
                              everyMinutes: e.target.value,
                            }))
                          }
                          inputMode="numeric"
                          className="w-20"
                        />
                      </Field>
                    )}
                    {scheduleForm.kind === "daily" && (
                      <>
                        <Field label="Time (HH:MM)" htmlFor="sched-daily">
                          <Input
                            id="sched-daily"
                            value={scheduleForm.dailyAt}
                            onChange={(e) =>
                              setScheduleForm((prev) => ({
                                ...prev,
                                dailyAt: e.target.value,
                              }))
                            }
                            placeholder="09:00"
                            className="w-20"
                          />
                        </Field>
                        <Field
                          label="Timezone (IANA, optional)"
                          htmlFor="sched-tz"
                        >
                          <Input
                            id="sched-tz"
                            value={scheduleForm.timezone}
                            onChange={(e) =>
                              setScheduleForm((prev) => ({
                                ...prev,
                                timezone: e.target.value,
                              }))
                            }
                            placeholder="America/New_York"
                            className="w-36"
                          />
                        </Field>
                      </>
                    )}
                    {scheduleForm.kind === "once" && (
                      <Field
                        label="Date/time (ISO, future)"
                        htmlFor="sched-once"
                      >
                        <Input
                          id="sched-once"
                          value={scheduleForm.atIso}
                          onChange={(e) =>
                            setScheduleForm((prev) => ({
                              ...prev,
                              atIso: e.target.value,
                            }))
                          }
                          placeholder="2026-09-20T09:00:00"
                          className="w-44"
                        />
                      </Field>
                    )}
                    <Field label="Retries (0–5)" htmlFor="sched-retries">
                      <Input
                        id="sched-retries"
                        value={scheduleForm.maxRetries}
                        onChange={(e) =>
                          setScheduleForm((prev) => ({
                            ...prev,
                            maxRetries: e.target.value,
                          }))
                        }
                        inputMode="numeric"
                        className="w-14"
                      />
                    </Field>
                    <label className="flex items-center gap-1 text-[10px] text-vscode-fg pb-1">
                      <input
                        type="checkbox"
                        checked={scheduleForm.enabled}
                        onChange={(e) =>
                          setScheduleForm((prev) => ({
                            ...prev,
                            enabled: e.target.checked,
                          }))
                        }
                      />
                      Enabled
                    </label>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="primary"
                      onClick={submitScheduleForm}
                      disabled={
                        !scheduleForm.name.trim() || !scheduleForm.prompt.trim()
                      }
                    >
                      {editingScheduleId ? "Save changes" : "Create schedule"}
                    </Button>
                    {editingScheduleId && (
                      <Button
                        onClick={() => {
                          setEditingScheduleId(null);
                          setScheduleForm({
                            name: "",
                            prompt: "",
                            kind: "interval",
                            everyMinutes: "60",
                            dailyAt: "09:00",
                            timezone: "",
                            atIso: "",
                            maxRetries: "0",
                            enabled: true,
                          });
                        }}
                      >
                        Cancel edit
                      </Button>
                    )}
                  </div>
                </div>
              </Card>

              {schedulesLoading && schedules.length === 0 ? (
                <EmptyState title="Loading schedules…" />
              ) : schedules.length === 0 ? (
                <EmptyState
                  title="No schedules yet"
                  hint="Create one above — it persists across restarts."
                />
              ) : (
                <div className="space-y-1.5">
                  {schedules.map((s) => (
                    <ScheduleRow
                      key={s.id}
                      schedule={s}
                      selected={selectedScheduleId === s.id}
                      onInspect={() => selectSchedule(s.id)}
                      onToggle={() =>
                        sendScheduleAction("schedule/toggle", {
                          id: s.id,
                          enabled: !s.enabled,
                        })
                      }
                      onRunNow={() =>
                        setScheduleConfirm({ action: "run-now", schedule: s })
                      }
                      onRemove={() =>
                        setScheduleConfirm({ action: "remove", schedule: s })
                      }
                    />
                  ))}
                </div>
              )}

              {(scheduleDetails ??
                schedules.find((s) => s.id === selectedScheduleId) ??
                null) && (
                <ScheduleDetailsView
                  details={
                    scheduleDetails ?? {
                      schedule: schedules.find(
                        (s) => s.id === selectedScheduleId,
                      )!,
                      history: scheduleHistory.filter(
                        (h) => h.scheduleId === selectedScheduleId,
                      ),
                    }
                  }
                  onClose={() => {
                    setSelectedScheduleId(null);
                    setScheduleDetails(null);
                  }}
                  onToggle={(s) =>
                    sendScheduleAction("schedule/toggle", {
                      id: s.id,
                      enabled: !s.enabled,
                    })
                  }
                  onRunNow={(s) =>
                    setScheduleConfirm({ action: "run-now", schedule: s })
                  }
                  onRemove={(s) =>
                    setScheduleConfirm({ action: "remove", schedule: s })
                  }
                  onEdit={(s) => {
                    startEditingSchedule(s);
                    setSelectedScheduleId(s.id);
                  }}
                />
              )}

              {scheduleConfirm && (
                <ConfirmCard
                  title={
                    scheduleConfirm.action === "remove"
                      ? `Delete schedule '${scheduleConfirm.schedule.name}'?`
                      : `Run '${scheduleConfirm.schedule.name}' now?`
                  }
                  detail={
                    scheduleConfirm.action === "remove"
                      ? "The schedule and its configuration are deleted permanently. Already-recorded history entries remain until they age out."
                      : "The prompt executes immediately through the live runtime with the same M4 approvals as scheduled runs."
                  }
                  confirmLabel={
                    scheduleConfirm.action === "remove" ? "Delete" : "Run now"
                  }
                  onConfirm={confirmScheduleAction}
                  onCancel={() => setScheduleConfirm(null)}
                />
              )}

              <div className="text-[10px] text-vscode-desc">
                {scheduleMetrics.total} runs recorded ·{" "}
                {scheduleMetrics.success}✓ · {scheduleMetrics.failed}✗
                {scheduleMetrics.running + scheduleMetrics.queued > 0
                  ? ` · ${scheduleMetrics.running + scheduleMetrics.queued} active`
                  : ""}
              </div>
            </div>
          )}

          {/* TAB: METRICS */}
          {currentTab === "metrics" && (
            <div className="p-3 space-y-3 overflow-y-auto h-full">
              <SectionHeader
                title="Observability"
                actions={
                  <span className="flex gap-1.5">
                    <Button
                      size="xs"
                      onClick={() => sendMetricsAction("metrics/export", {})}
                    >
                      Inspect summary
                    </Button>
                    <Button size="xs" onClick={refreshDashboard}>
                      <IconRefresh size={10} /> Refresh
                    </Button>
                  </span>
                }
              />

              {dashboardError && (
                <ErrorBanner
                  message={dashboardError}
                  onDismiss={() => setDashboardError(null)}
                />
              )}

              <div className="flex flex-wrap items-end gap-1.5">
                <Field label="Range" htmlFor="met-range">
                  <Select
                    id="met-range"
                    value={dashboardFilter.range}
                    onChange={(e) =>
                      applyDashboardFilter({
                        range: e.target.value as DashboardFilter["range"],
                      })
                    }
                  >
                    <option value="today">today</option>
                    <option value="7d">7 days</option>
                    <option value="30d">30 days</option>
                    <option value="all">all available</option>
                  </Select>
                </Field>
                <Field label="Status" htmlFor="met-status">
                  <Select
                    id="met-status"
                    value={dashboardFilter.status}
                    onChange={(e) =>
                      applyDashboardFilter({ status: e.target.value })
                    }
                  >
                    {[
                      "all",
                      "running",
                      "completed",
                      "failed",
                      "cancelled",
                      "interrupted",
                      "archived",
                    ].map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Provider" htmlFor="met-provider">
                  <Input
                    id="met-provider"
                    value={dashboardFilter.provider}
                    onChange={(e) =>
                      applyDashboardFilter({ provider: e.target.value })
                    }
                    placeholder="any"
                    className="w-24"
                  />
                </Field>
                <Field label="Model" htmlFor="met-model">
                  <Input
                    id="met-model"
                    value={dashboardFilter.model}
                    onChange={(e) =>
                      applyDashboardFilter({ model: e.target.value })
                    }
                    placeholder="any"
                    className="w-24"
                  />
                </Field>
                <Field label="Mode" htmlFor="met-mode">
                  <Select
                    id="met-mode"
                    value={dashboardFilter.mode}
                    onChange={(e) =>
                      applyDashboardFilter({ mode: e.target.value })
                    }
                  >
                    {["all", "act", "plan", "ask", "review", "auto"].map(
                      (s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ),
                    )}
                  </Select>
                </Field>
              </div>

              {dashboardLoading && !dashboard ? (
                <EmptyState title="Loading metrics…" />
              ) : !dashboard ? (
                <EmptyState
                  title="No metrics yet"
                  hint="Run a task, then refresh."
                />
              ) : (
                <>
                  <div className="text-[9px] text-vscode-desc">
                    {dashboard.rangeNote}
                  </div>

                  <DashboardSection
                    title="OVERVIEW"
                    open={metricsSections.overview ?? true}
                    onToggle={() => toggleMetricsSection("overview")}
                  >
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5">
                      {dashboard.overview.map((m) => (
                        <MetricCard key={m.key} metric={m} />
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-1.5 mt-1.5">
                      <MetricCard metric={dashboard.tokens.input} />
                      <MetricCard metric={dashboard.tokens.output} />
                    </div>
                  </DashboardSection>

                  <DashboardSection
                    title="PERFORMANCE"
                    open={metricsSections.performance ?? true}
                    onToggle={() => toggleMetricsSection("performance")}
                  >
                    <div className="text-[10px] text-vscode-desc mb-1">
                      Tasks: {dashboard.performance.taskDurations.count} runs
                      {dashboard.performance.taskDurations.avgMs !== null
                        ? ` · avg ${formatMetricValue({ key: "a", label: "a", value: dashboard.performance.taskDurations.avgMs, unit: "ms", scope: "range" })}`
                        : " · no completed durations"}
                      {dashboard.performance.taskDurations.minMs !== null
                        ? ` · min ${dashboard.performance.taskDurations.minMs}ms`
                        : ""}
                      {dashboard.performance.taskDurations.maxMs !== null
                        ? ` · max ${dashboard.performance.taskDurations.maxMs}ms`
                        : ""}
                    </div>
                    <div className="grid grid-cols-2 gap-1.5 mb-1.5">
                      <MetricCard metric={dashboard.performance.modelLatency} />
                      <MetricCard
                        metric={dashboard.performance.contextLatency}
                      />
                      <MetricCard
                        metric={dashboard.performance.terminalDuration}
                      />
                      <MetricCard metric={dashboard.performance.mcpDuration} />
                    </div>
                    {dashboard.performance.toolLatency.length === 0 ? (
                      <p className="text-[10px] text-vscode-desc">
                        No tool latency recorded.
                      </p>
                    ) : (
                      <div className="space-y-0.5 max-h-44 overflow-y-auto">
                        {dashboard.performance.toolLatency
                          .slice(0, 10)
                          .map((t) => (
                            <div
                              key={t.name}
                              className="flex justify-between gap-2 text-[10px] font-mono"
                            >
                              <span className="text-vscode-fg truncate">
                                {t.name} ×{t.samples}
                              </span>
                              <span className="text-vscode-desc flex-shrink-0">
                                avg {t.avgMs !== null ? `${t.avgMs}ms` : "—"}
                                {t.p95Ms !== null ? ` · p95 ${t.p95Ms}ms` : ""}
                                {t.maxMs !== null ? ` · max ${t.maxMs}ms` : ""}
                              </span>
                            </div>
                          ))}
                      </div>
                    )}
                  </DashboardSection>

                  <DashboardSection
                    title={`TOOLS (${dashboard.tools.length})`}
                    open={metricsSections.tools ?? false}
                    onToggle={() => toggleMetricsSection("tools")}
                  >
                    {dashboard.tools.length === 0 ? (
                      <p className="text-[10px] text-vscode-desc">
                        No tool invocations recorded.
                      </p>
                    ) : (
                      <div className="space-y-0.5 max-h-56 overflow-y-auto">
                        {dashboard.tools.map((t) => (
                          <div key={t.name} className="text-[10px]">
                            <div className="flex justify-between gap-2 font-mono">
                              <span className="text-vscode-fg truncate">
                                {t.name}
                              </span>
                              <span className="text-vscode-desc flex-shrink-0">
                                {t.invocations}× · {t.failures}✗ · {t.category}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </DashboardSection>

                  <DashboardSection
                    title={`PROVIDERS (${dashboard.providers.length})`}
                    open={metricsSections.providers ?? false}
                    onToggle={() => toggleMetricsSection("providers")}
                  >
                    {dashboard.providers.length === 0 ? (
                      <p className="text-[10px] text-vscode-desc">
                        No provider usage recorded. Provider tokens are session
                        totals, not per-provider.
                      </p>
                    ) : (
                      dashboard.providers.map((p) => (
                        <div key={p.provider} className="mb-1">
                          <div className="text-[10px] text-vscode-fg font-semibold">
                            {p.provider} · {p.tasks} task
                            {p.tasks === 1 ? "" : "s"}
                          </div>
                          {p.models.map((m) => (
                            <div
                              key={m.model}
                              className="flex justify-between text-[10px] font-mono pl-2"
                            >
                              <span className="text-vscode-desc truncate">
                                {m.model}
                              </span>
                              <span className="text-vscode-desc">
                                {m.tasks}×
                              </span>
                            </div>
                          ))}
                        </div>
                      ))
                    )}
                  </DashboardSection>

                  <DashboardSection
                    title={`ERRORS (${dashboard.errors.categories.length})`}
                    open={metricsSections.errors ?? false}
                    onToggle={() => toggleMetricsSection("errors")}
                  >
                    {dashboard.errors.categories.length === 0 ? (
                      <p className="text-[10px] text-vscode-desc">
                        No errors recorded.
                      </p>
                    ) : (
                      <>
                        <div className="flex flex-wrap gap-1 mb-1">
                          {dashboard.errors.categories.map((c) => (
                            <Badge key={c.category} tone="danger">
                              {c.category}: {c.count}
                              {c.taskCount > 0 ? ` (${c.taskCount} tasks)` : ""}
                            </Badge>
                          ))}
                        </div>
                        <div className="space-y-0.5 max-h-36 overflow-y-auto">
                          {dashboard.errors.recent.map((e, i) => (
                            <div
                              key={i}
                              className="text-[10px] text-vscode-desc break-words"
                            >
                              [{new Date(e.atMs).toLocaleTimeString()}]{" "}
                              {e.summary}
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </DashboardSection>

                  <DashboardSection
                    title={`ACTIVE TASKS (${dashboard.active.length})`}
                    open={metricsSections.active ?? false}
                    onToggle={() => toggleMetricsSection("active")}
                  >
                    {dashboard.active.length === 0 ? (
                      <p className="text-[10px] text-vscode-desc">
                        Nothing running right now.
                      </p>
                    ) : (
                      <div className="space-y-0.5">
                        {dashboard.active.map((a, i) => (
                          <div
                            key={`${a.kind}-${a.id}-${i}`}
                            className="flex justify-between gap-2 text-[10px]"
                          >
                            <span className="text-vscode-fg truncate">
                              [{a.kind}] {a.label || a.id.slice(0, 12)}
                            </span>
                            <span className="text-vscode-desc flex-shrink-0">
                              {a.status}
                              {a.detail ? ` · ${a.detail}` : ""}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </DashboardSection>

                  <DashboardSection
                    title="INSPECT"
                    open={metricsSections.inspect ?? false}
                    onToggle={() => toggleMetricsSection("inspect")}
                  >
                    <p className="text-[10px] text-vscode-desc mb-1">
                      Sanitized diagnostic bundle — counts, tool names and
                      redacted error summaries only. No prompts, arguments, file
                      contents or credentials.
                    </p>
                    {!exported ? (
                      <Button
                        size="xs"
                        variant="primary"
                        onClick={() => sendMetricsAction("metrics/export", {})}
                      >
                        Build diagnostic summary
                      </Button>
                    ) : (
                      <>
                        <pre className="text-[9px] font-mono bg-vscode-input-bg rounded p-1.5 overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap break-words mb-1">
                          {JSON.stringify(exported, null, 2).slice(0, 4000)}
                        </pre>
                        <Button
                          size="xs"
                          variant="primary"
                          onClick={copyDiagnostic}
                        >
                          {copied ? "Copied ✓" : "Copy diagnostic summary"}
                        </Button>
                      </>
                    )}
                  </DashboardSection>
                </>
              )}
            </div>
          )}

          {/* TAB: SETTINGS */}
          {currentTab === "settings" && (
            <div className="p-3 space-y-4 overflow-y-auto h-full max-w-[860px]">
              {/* MODEL */}
              <section>
                <SectionHeader title="Model" />
                <Card className="mt-1.5 px-3 py-2.5 space-y-2.5">
                  {catalogError && (
                    <p
                      role="alert"
                      className="text-[10px] text-vscode-error-fg"
                    >
                      Provider catalogue: {catalogError}
                    </p>
                  )}
                  <ProviderSelector
                    providers={catalog}
                    statuses={catalogStatuses}
                    favorites={providerFavorites}
                    selectedId={openProviderId}
                    activeProviderId={settings.provider}
                    health={providerHealth ?? undefined}
                    usage={providerUsage ?? undefined}
                    onOpen={(id) => {
                      setOpenProviderId(id);
                      if (!providerUsage || providerUsage.providerId !== id) {
                        handleProviderUsage(id);
                      }
                    }}
                    onToggleFavorite={handleProviderFavorite}
                    onSave={handleProviderSave}
                    onTest={handleProviderTest}
                    onFetchUsage={handleProviderUsage}
                    onUseProvider={handleUseProvider}
                  />
                  <Field label="Privacy mode" htmlFor="set-privacy">
                    <Select
                      id="set-privacy"
                      value={settings.privacyMode}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          privacyMode: e.target.value,
                        }))
                      }
                      className="w-full"
                    >
                      <option value="local">
                        Local Only — no data leaves machine
                      </option>
                      <option value="hybrid">
                        Hybrid — cloud only for selected tasks
                      </option>
                      <option value="cloud">Cloud — uses API providers</option>
                    </Select>
                  </Field>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <Field label="Temperature" htmlFor="set-temp">
                      <Input
                        id="set-temp"
                        type="number"
                        min="0"
                        max="2"
                        step="0.1"
                        value={settings.temperature}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            temperature: parseFloat(e.target.value),
                          }))
                        }
                        className="w-full"
                      />
                    </Field>
                    <Field label="Base URL (Ollama)" htmlFor="set-baseurl">
                      <Input
                        id="set-baseurl"
                        type="text"
                        value={settings.baseUrl}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            baseUrl: e.target.value,
                          }))
                        }
                        className="w-full font-mono"
                      />
                    </Field>
                  </div>
                </Card>
              </section>

              {/* SECURITY */}
              <section>
                <SectionHeader title="Security" />
                <Card className="mt-1.5 px-3 py-2.5 space-y-2.5">
                  <div className="flex items-center gap-1.5 text-[10px] text-vscode-success-fg">
                    <IconShield size={11} /> Workspace and sensitive files are
                    protected by the SecurityValidator on every operation.
                  </div>
                  <div className="space-y-2">
                    {(
                      [
                        [
                          "readFiles",
                          "Read files",
                          "Auto-approve read_file, list_files, search",
                        ],
                        [
                          "editFiles",
                          "Edit files",
                          "Auto-approve write_file, edit_file, apply_patch",
                        ],
                        [
                          "executeCommands",
                          "Execute commands",
                          "Auto-approve bash/terminal",
                        ],
                        ["webFetch", "Web fetch", "Auto-approve web_fetch"],
                        [
                          "mcpServers",
                          "MCP servers",
                          "Auto-approve MCP tool calls",
                        ],
                        [
                          "browser",
                          "Browser",
                          "Auto-approve browser automation",
                        ],
                      ] as const
                    ).map(([key, label, desc]) => (
                      <Toggle
                        key={key}
                        checked={autoApproval[key]}
                        onChange={(v) => handleAutoApprovalChange(key, v)}
                        label={label}
                        hint={desc}
                      />
                    ))}
                  </div>
                  <Field
                    label="Max consecutive auto-approvals"
                    htmlFor="set-maxauto"
                  >
                    <Input
                      id="set-maxauto"
                      type="number"
                      min={1}
                      max={100}
                      value={autoApproval.maxAutoApprovals}
                      onChange={(e) =>
                        handleAutoApprovalChange(
                          "maxAutoApprovals",
                          parseInt(e.target.value) || 10,
                        )
                      }
                      className="w-20"
                    />
                  </Field>
                  <p className="text-[9px] text-vscode-desc">
                    Auto-approval never overrides hard security boundaries;
                    critical-risk operations always require explicit approval.
                  </p>
                </Card>
              </section>

              {/* WORKSPACE */}
              <section>
                <SectionHeader title="Workspace" />
                <Card className="mt-1.5 px-3 py-2.5 space-y-1.5">
                  <div className="text-[11px] font-semibold text-vscode-desc">
                    Project Rules (.clinerules/)
                  </div>
                  <div className="text-[11px] text-vscode-desc space-y-1">
                    <p>
                      Rules are loaded from{" "}
                      <code className="text-vscode-text-link">
                        .clinerules/
                      </code>{" "}
                      in your workspace root. Supports nested rules (e.g.{" "}
                      <code className="text-vscode-text-link">
                        .clinerules/backend/spring.md
                      </code>
                      ). Global rules from{" "}
                      <code className="text-vscode-text-link">
                        ~/.clinerules/
                      </code>{" "}
                      are merged (project overrides global).
                    </p>
                    <p className="text-[10px]">
                      Rules influence agent instructions. They cannot bypass
                      PolicyEngine or security controls.
                    </p>
                  </div>
                  <Button
                    size="xs"
                    onClick={() => sendMessage("rules/reload", {})}
                  >
                    <IconRefresh size={10} /> Reload rules
                  </Button>
                </Card>
              </section>

              {/* ADVANCED — MCP */}
              <section>
                <SectionHeader
                  title="Advanced · MCP servers"
                  count={mcpServers.length}
                />
                <Card className="mt-1.5 px-3 py-2.5 space-y-2">
                  {mcpServers.length > 0 && (
                    <div className="space-y-1">
                      {mcpServers.map((s) => (
                        <div
                          key={s.name}
                          className="rounded border border-vscode-border bg-vscode-input-bg px-2 py-1.5 text-[10px]"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-vscode-fg font-medium">
                              {s.name}
                            </span>
                            <Badge tone={s.enabled ? "info" : "muted"}>
                              {s.transport}
                            </Badge>
                            <StatusDot
                              tone={
                                s.status === "connected"
                                  ? "success"
                                  : s.lastError
                                    ? "danger"
                                    : "muted"
                              }
                              label={`${s.status ?? "unknown"} · ${s.toolCount} tools`}
                            />
                            <span className="flex-1" />
                            <Button
                              size="xs"
                              onClick={() =>
                                sendMessage("mcp/server/toggle", {
                                  name: s.name,
                                  enabled: !s.enabled,
                                })
                              }
                            >
                              {s.enabled ? "Disable" : "Enable"}
                            </Button>
                            <Button
                              size="xs"
                              onClick={() =>
                                sendMessage("mcp/server/reconnect", {
                                  name: s.name,
                                })
                              }
                            >
                              Reconnect
                            </Button>
                            <Button
                              size="xs"
                              variant="danger"
                              onClick={() =>
                                sendMessage("mcp/server/remove", {
                                  name: s.name,
                                })
                              }
                            >
                              Remove
                            </Button>
                          </div>
                          {s.lastError && (
                            <div className="text-vscode-error-fg mt-0.5 truncate">
                              {s.lastError}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                      <Field label="Name" htmlFor="mcp-name">
                        <Input
                          id="mcp-name"
                          value={mcpForm.name}
                          onChange={(e) =>
                            setMcpForm((f) => ({ ...f, name: e.target.value }))
                          }
                          className="w-full"
                        />
                      </Field>
                      <Field label="Transport" htmlFor="mcp-transport">
                        <Select
                          id="mcp-transport"
                          value={mcpForm.transport}
                          onChange={(e) =>
                            setMcpForm((f) => ({
                              ...f,
                              transport: e.target
                                .value as typeof mcpForm.transport,
                            }))
                          }
                          className="w-full"
                        >
                          <option value="stdio">stdio</option>
                          <option value="sse">SSE</option>
                          <option value="streamable-http">
                            Streamable HTTP
                          </option>
                        </Select>
                      </Field>
                    </div>
                    {mcpForm.transport === "stdio" ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                        <Field label="Command" htmlFor="mcp-cmd">
                          <Input
                            id="mcp-cmd"
                            placeholder="node server.js"
                            value={mcpForm.command}
                            onChange={(e) =>
                              setMcpForm((f) => ({
                                ...f,
                                command: e.target.value,
                              }))
                            }
                            className="w-full font-mono"
                          />
                        </Field>
                        <Field
                          label="Args (space separated)"
                          htmlFor="mcp-args"
                        >
                          <Input
                            id="mcp-args"
                            value={mcpForm.args}
                            onChange={(e) =>
                              setMcpForm((f) => ({
                                ...f,
                                args: e.target.value,
                              }))
                            }
                            className="w-full font-mono"
                          />
                        </Field>
                      </div>
                    ) : (
                      <Field label="URL" htmlFor="mcp-url">
                        <Input
                          id="mcp-url"
                          placeholder="https://server-url/mcp"
                          value={mcpForm.url}
                          onChange={(e) =>
                            setMcpForm((f) => ({ ...f, url: e.target.value }))
                          }
                          className="w-full font-mono"
                        />
                      </Field>
                    )}
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => {
                        const trimmed = mcpForm.name.trim();
                        if (!trimmed) return;
                        const base = {
                          name: trimmed,
                          transport: mcpForm.transport,
                          enabled: true,
                        };
                        if (mcpForm.transport === "stdio") {
                          const parts = mcpForm.command.trim().split(/\s+/);
                          sendMessage("mcp/server/add", {
                            ...base,
                            command: parts[0],
                            args: parts.slice(1),
                          });
                        } else {
                          sendMessage("mcp/server/add", {
                            ...base,
                            url: mcpForm.url.trim(),
                          });
                        }
                        setMcpForm({
                          name: "",
                          transport: "stdio",
                          command: "",
                          args: "",
                          url: "",
                        });
                      }}
                    >
                      <IconPlus size={10} /> Add server
                    </Button>
                  </div>
                </Card>
              </section>

              {/* ADVANCED — Scheduler + Plugins cross-links */}
              <section>
                <SectionHeader title="Advanced · Scheduled tasks & plugins" />
                <Card className="mt-1.5 px-3 py-2.5 space-y-2.5">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[11px] font-semibold text-vscode-desc">
                        Scheduled tasks (
                        {schedules.filter((s) => s.enabled).length} enabled)
                      </span>
                      <Button
                        size="xs"
                        onClick={() => {
                          setCurrentTab("schedules");
                          refreshSchedules();
                        }}
                      >
                        Manage schedules
                      </Button>
                    </div>
                    <p className="text-[10px] text-vscode-desc">
                      Creation, editing, history and manual runs happen in the
                      Schedules tab. Scheduled prompts run through the same M4
                      permission pipeline as interactive tasks.
                    </p>
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[11px] font-semibold text-vscode-desc">
                        Plugins ({plugins.filter((p) => p.installed).length}{" "}
                        installed
                        {pluginProblems.length > 0
                          ? ` · ${pluginProblems.length} manifest issue${pluginProblems.length === 1 ? "" : "s"}`
                          : ""}
                        )
                      </span>
                      <Button
                        size="xs"
                        onClick={() => {
                          setCurrentTab("plugins");
                          refreshPlugins();
                        }}
                      >
                        Manage plugins
                      </Button>
                    </div>
                    <p className="text-[10px] text-vscode-desc">
                      Discovery, trust review, activation and removal happen in
                      the Plugins tab. Community plugins are
                      capability-restricted and never auto-activated.
                    </p>
                  </div>
                </Card>
              </section>

              {/* ADVANCED — Metrics reader */}
              <section>
                <SectionHeader
                  title="Advanced · Local metrics (this session)"
                  actions={
                    <Button
                      size="xs"
                      onClick={() => sendMessage("metrics/get", {})}
                    >
                      <IconRefresh size={10} /> Refresh
                    </Button>
                  }
                />
                <Card className="mt-1.5 px-3 py-2.5">
                  {metricsRows.length === 0 ? (
                    <p className="text-[10px] text-vscode-desc">
                      No metrics recorded yet.
                    </p>
                  ) : (
                    <div className="space-y-0.5 font-mono text-[10px]">
                      {metricsRows.slice(0, 30).map((m, i) => (
                        <div
                          key={`${m.name}-${i}`}
                          className="flex justify-between gap-2"
                        >
                          <span className="text-vscode-fg truncate">
                            {m.name}
                            {Object.keys(m.labels).length > 0
                              ? ` {${Object.entries(m.labels)
                                  .map(([k, v]) => `${k}=${v}`)
                                  .join(",")}}`
                              : ""}
                          </span>
                          <span className="text-vscode-desc flex-shrink-0">
                            {m.value}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </section>
            </div>
          )}
        </main>
      </div>

      <StatusBar
        left={
          <>
            <StatusDot
              tone={isRunning ? "info" : "success"}
              label={isRunning ? "Agent running" : "Ready"}
              pulse={isRunning}
            />
            {healingState?.active && (
              <Badge tone="warning">
                Self-healing {healingState.attempt}/{healingState.maxAttempts}
              </Badge>
            )}
            {usage && (
              <span
                className="hidden sm:flex items-center gap-1.5"
                title={`${(usage.inputTokens + usage.outputTokens).toLocaleString()} tokens`}
              >
                <span className="w-16 h-1 bg-vscode-border rounded-full overflow-hidden">
                  <span
                    className="block h-full bg-vscode-text-link"
                    style={{
                      width: `${Math.min(((usage.inputTokens + usage.outputTokens) / 128000) * 100, 100)}%`,
                    }}
                  />
                </span>
                <span className="font-mono">
                  {formatCount(usage.inputTokens + usage.outputTokens)} tok
                  {usage.totalCost != null && usage.totalCost > 0
                    ? ` · $${usage.totalCost.toFixed(4)}`
                    : ""}
                </span>
              </span>
            )}
          </>
        }
        right={
          <span className="font-mono truncate max-w-[240px]">
            {settings.provider} / {settings.model || "—"}
          </span>
        }
      />
    </div>
  );
}
