// ============================================================================
// CodePilot design system — UI primitives
// Buttons, badges, status dots, cards, inputs — all themed via VS Code
// variables, keyboard-accessible, no color-only status signaling.
// ============================================================================

import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

// ---------------------------------------------------------------------------
// Tones (status colors + text labels; never color-only)
// ---------------------------------------------------------------------------

export type Tone =
  "neutral" | "success" | "warning" | "danger" | "info" | "muted";

export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-vscode-fg",
  success: "text-vscode-success-fg",
  warning: "text-vscode-warning-fg",
  danger: "text-vscode-error-fg",
  info: "text-vscode-text-link",
  muted: "text-vscode-desc",
};

export const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-vscode-desc",
  success: "bg-vscode-success-fg",
  warning: "bg-vscode-warning-fg",
  danger: "bg-vscode-error-fg",
  info: "bg-vscode-text-link",
  muted: "bg-vscode-desc",
};

export const TONE_BADGE: Record<Tone, string> = {
  neutral: "bg-vscode-badge-bg text-vscode-badge-fg",
  success:
    "border border-vscode-success-fg/40 text-vscode-success-fg bg-vscode-success-fg/10",
  warning:
    "border border-vscode-warning-fg/40 text-vscode-warning-fg bg-vscode-warning-fg/10",
  danger:
    "border border-vscode-error-fg/40 text-vscode-error-fg bg-vscode-error-fg/10",
  info: "border border-vscode-text-link/40 text-vscode-text-link bg-vscode-text-link/10",
  muted: "border border-vscode-border text-vscode-desc",
};

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded font-medium transition-colors " +
  "focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focus-border " +
  "disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap";

const BUTTON_SIZES = {
  xs: "text-[10px] px-1.5 py-0.5",
  sm: "text-[11px] px-2 py-1",
  md: "text-xs px-3 py-1.5",
} as const;

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-vscode-btn text-vscode-btn-fg hover:bg-vscode-btn-hover",
  secondary:
    "border border-vscode-input-border bg-transparent text-vscode-fg hover:bg-vscode-list-hover",
  ghost:
    "bg-transparent text-vscode-desc hover:text-vscode-fg hover:bg-vscode-list-hover border border-transparent",
  danger:
    "border border-vscode-error-fg/50 text-vscode-error-fg hover:bg-vscode-error-fg/10 bg-transparent",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: keyof typeof BUTTON_SIZES;
}

export function Button({
  variant = "secondary",
  size = "sm",
  className = "",
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`${BUTTON_BASE} ${BUTTON_SIZES[size]} ${BUTTON_VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------------------
// Badge / StatusDot
// ---------------------------------------------------------------------------

export function Badge({
  tone = "neutral",
  children,
  title,
  className = "",
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${TONE_BADGE[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/**
 * Status indicator: colored dot + mandatory text label. aria-hidden on the
 * dot so screen readers read the label, not the decoration.
 */
export function StatusDot({
  tone = "neutral",
  label,
  pulse = false,
  className = "",
}: {
  tone?: Tone;
  label: string;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] ${TONE_TEXT[tone]} ${className}`}
    >
      <span
        aria-hidden="true"
        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${TONE_DOT[tone]} ${pulse ? "cp-pulse" : ""}`}
      />
      <span className="truncate">{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Card / SectionHeader / EmptyState
// ---------------------------------------------------------------------------

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-md border border-vscode-border bg-vscode-panel/60 ${className}`}
    >
      {children}
    </div>
  );
}

export function SectionHeader({
  title,
  count,
  actions,
  className = "",
}: {
  title: string;
  count?: number;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-center justify-between gap-2 ${className}`}>
      <div className="flex items-center gap-2 min-w-0">
        <h2 className="cp-section-title truncate">
          {title}
          {count !== undefined ? ` (${count})` : ""}
        </h2>
      </div>
      {actions && (
        <div className="flex items-center gap-1.5 flex-shrink-0">{actions}</div>
      )}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
  className = "",
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center text-center py-10 px-6 ${className}`}
    >
      {icon && <div className="text-vscode-desc mb-2">{icon}</div>}
      <div className="text-[13px] text-vscode-fg font-medium">{title}</div>
      {hint && (
        <div className="mt-1 text-[11px] text-vscode-desc max-w-[320px]">
          {hint}
        </div>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

const FIELD_BASE =
  "rounded border border-vscode-input-border bg-vscode-input-bg text-vscode-input-fg " +
  "placeholder:text-vscode-input-placeholder focus:outline-none focus:border-vscode-focus-border";

export function Input({
  className = "",
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`${FIELD_BASE} text-[11px] px-2 py-1 ${className}`}
      {...rest}
    />
  );
}

export function Select({
  className = "",
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`${FIELD_BASE} text-[11px] px-1.5 py-1 ${className}`}
      {...rest}
    />
  );
}

export function Textarea({
  className = "",
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`${FIELD_BASE} text-xs px-2 py-1.5 ${className}`}
      {...rest}
    />
  );
}

export function Field({
  label,
  htmlFor,
  children,
  hint,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <label
        htmlFor={htmlFor}
        className="block text-[10px] text-vscode-desc mb-0.5"
      >
        {label}
      </label>
      {children}
      {hint && <div className="mt-0.5 text-[9px] text-vscode-desc">{hint}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toggle switch (accessible checkbox styled as a switch)
// ---------------------------------------------------------------------------

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-start gap-2.5 ${disabled ? "opacity-50" : "cursor-pointer"}`}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 w-7 h-4 rounded-full flex-shrink-0 transition-colors border ${
          checked
            ? "bg-vscode-btn border-vscode-btn"
            : "bg-transparent border-vscode-input-border"
        } focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focus-border`}
      >
        <span
          aria-hidden="true"
          className={`absolute top-px left-px w-3 h-3 rounded-full transition-transform ${
            checked ? "translate-x-3 bg-vscode-btn-fg" : "bg-vscode-desc"
          }`}
        />
      </button>
      <span className="min-w-0">
        <span className="block text-[11px] text-vscode-fg leading-tight">
          {label}
        </span>
        {hint && (
          <span className="block text-[10px] text-vscode-desc leading-tight mt-px">
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Inline confirmation card (destructive-action guard, reused by tabs)
// ---------------------------------------------------------------------------

export function ConfirmCard({
  title,
  detail,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  detail: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-label={title}
      className="rounded-md border border-vscode-error-fg/40 bg-vscode-error-fg/5 px-3 py-2 cp-fade-up"
    >
      <div className="text-[11px] font-semibold text-vscode-error-fg mb-1">
        {title}
      </div>
      <p className="text-[10px] text-vscode-desc mb-2">{detail}</p>
      <div className="flex gap-2">
        <Button variant="danger" onClick={onConfirm}>
          {confirmLabel}
        </Button>
        <Button onClick={onCancel}>Keep</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dismissible error banner
// ---------------------------------------------------------------------------

export function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-2 rounded-md border border-vscode-error-fg/40 bg-vscode-error-fg/5 px-2.5 py-1.5 text-[11px] text-vscode-error-fg cp-fade-up"
    >
      <span className="min-w-0 break-words">{message}</span>
      <button
        aria-label="Dismiss error"
        onClick={onDismiss}
        className="flex-shrink-0 text-vscode-error-fg/70 hover:text-vscode-error-fg"
      >
        ✕
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

/** Compact duration label: 840ms → "0.8s", 62000ms → "1m 2s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

/** Compact count: 1842 → "1.8k". */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
