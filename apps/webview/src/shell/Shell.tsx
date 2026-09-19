// ============================================================================
// App shell — header, sidebar navigation, status bar
// ============================================================================

import { type ReactNode } from "react";
import { IconSettings, CodePilotMark } from "../lib/icons";
import { Badge, StatusDot, type Tone } from "../lib/ui";

// ---------------------------------------------------------------------------
// Navigation model
// ---------------------------------------------------------------------------

export type TabId =
  | "chat"
  | "tools"
  | "changes"
  | "plugins"
  | "skills"
  | "team"
  | "schedules"
  | "history"
  | "metrics"
  | "settings";

export interface NavBadge {
  count?: number;
  tone?: Tone;
  /** Small free-text marker (e.g. "!"); prefer count. */
  text?: string;
}

export interface NavItem {
  id: TabId;
  label: string;
  icon: (p: { size?: number }) => ReactNode;
  badge?: NavBadge;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export function AppHeader({
  connected,
  connectionTitle,
  model,
  provider,
  privacyMode,
  privacyTitle,
  isRunning,
  onOpenSettings,
  settingsActive,
}: {
  connected: boolean;
  connectionTitle: string;
  model: string;
  provider: string;
  privacyMode: string;
  privacyTitle: string;
  isRunning: boolean;
  onOpenSettings: () => void;
  settingsActive: boolean;
}) {
  const privacyTone: Tone =
    privacyMode === "local"
      ? "success"
      : privacyMode === "cloud"
        ? "warning"
        : "info";
  const privacyLabel =
    privacyMode === "local"
      ? "Local"
      : privacyMode === "cloud"
        ? "Cloud"
        : "Hybrid";

  return (
    <header className="flex items-center gap-2 px-3 h-10 border-b border-vscode-border flex-shrink-0 bg-vscode-bg">
      <CodePilotMark size={18} />
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="text-[13px] font-semibold text-vscode-fg tracking-tight whitespace-nowrap">
          CodePilot AI
        </span>
        <span className="text-[9px] text-vscode-desc hidden sm:inline">
          v0.1.0
        </span>
      </div>

      <div className="flex-1" />

      {/* Model chip */}
      <span
        title={`Provider: ${provider} · Model: ${model || "not set"}`}
        className="hidden md:inline-flex items-center gap-1.5 text-[11px] font-mono text-vscode-fg rounded border border-vscode-border px-2 py-0.5 max-w-[220px]"
      >
        <span className="text-vscode-desc">model</span>
        <span className="truncate">{model || "—"}</span>
      </span>

      {/* Privacy status */}
      <span title={privacyTitle}>
        <Badge tone={privacyTone}>
          {privacyMode === "local" ? "✓" : "⚠"} {privacyLabel}
        </Badge>
      </span>

      {/* Connection status */}
      <span title={connectionTitle}>
        <StatusDot
          tone={connected ? "success" : "danger"}
          label={connected ? "Connected" : "Offline"}
          pulse={isRunning}
        />
      </span>

      {isRunning && (
        <span title="Agent is running">
          <Badge tone="info">⚡ Running</Badge>
        </span>
      )}

      <button
        onClick={onOpenSettings}
        aria-label="Open settings"
        title="Settings"
        aria-current={settingsActive ? "page" : undefined}
        className={`rounded p-1 transition-colors hover:bg-vscode-list-hover ${
          settingsActive
            ? "text-vscode-text-link"
            : "text-vscode-desc hover:text-vscode-fg"
        }`}
      >
        <IconSettings size={15} />
      </button>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Sidebar navigation
// ---------------------------------------------------------------------------

export function SideNav({
  items,
  activeTab,
  onSelect,
  collapsed,
  onToggleCollapsed,
}: {
  items: NavItem[];
  activeTab: TabId;
  onSelect: (tab: TabId) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  return (
    <nav
      aria-label="CodePilot sections"
      className={`flex flex-col border-r border-vscode-border bg-vscode-bg flex-shrink-0 transition-[width] ${
        collapsed ? "w-11" : "w-[148px]"
      }`}
    >
      <ul className="flex-1 overflow-y-auto py-1.5 px-1 space-y-0.5">
        {items.map((item) => {
          const active = activeTab === item.id;
          const badge = item.badge;
          return (
            <li key={item.id}>
              <button
                onClick={() => onSelect(item.id)}
                aria-current={active ? "page" : undefined}
                title={collapsed ? item.label : undefined}
                className={`w-full flex items-center gap-2 rounded px-2 py-1.5 text-[12px] transition-colors ${
                  active
                    ? "bg-vscode-list-active text-vscode-list-active-fg font-medium"
                    : "text-vscode-fg/85 hover:bg-vscode-list-hover hover:text-vscode-fg"
                } ${collapsed ? "justify-center" : ""}`}
              >
                <span className="flex-shrink-0 flex items-center justify-center w-4">
                  {item.icon({ size: 15 })}
                </span>
                {!collapsed && (
                  <span className="truncate flex-1 text-left">
                    {item.label}
                  </span>
                )}
                {!collapsed && badge && (
                  <span className="flex-shrink-0">
                    {badge.count !== undefined && badge.count > 0 ? (
                      <span
                        className={`inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full text-[9px] font-semibold ${
                          badge.tone === "warning" || badge.tone === "danger"
                            ? "bg-vscode-badge-bg text-vscode-badge-fg"
                            : "bg-vscode-badge-bg text-vscode-badge-fg"
                        }`}
                      >
                        {badge.count > 99 ? "99+" : badge.count}
                      </span>
                    ) : badge.text ? (
                      <span className="text-[9px] font-semibold text-vscode-warning-fg">
                        {badge.text}
                      </span>
                    ) : null}
                  </span>
                )}
                {/* Collapsed: numeric badge as a dot marker */}
                {collapsed && badge?.count !== undefined && badge.count > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute ml-4 -mt-3 w-1.5 h-1.5 rounded-full bg-vscode-text-link"
                  />
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="px-1 pb-1.5">
        <button
          onClick={onToggleCollapsed}
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
          title={collapsed ? "Expand navigation" : "Collapse navigation"}
          className="w-full flex items-center justify-center rounded px-2 py-1 text-vscode-desc hover:text-vscode-fg hover:bg-vscode-list-hover text-[10px]"
        >
          {collapsed ? "»" : "«"}
        </button>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

export function StatusBar({
  left,
  right,
}: {
  left: ReactNode;
  right: ReactNode;
}) {
  return (
    <footer className="flex items-center justify-between gap-3 px-3 h-7 border-t border-vscode-border text-[10px] text-vscode-desc flex-shrink-0 bg-vscode-bg">
      <div className="flex items-center gap-3 min-w-0">{left}</div>
      <div className="flex items-center gap-3 flex-shrink-0">{right}</div>
    </footer>
  );
}
