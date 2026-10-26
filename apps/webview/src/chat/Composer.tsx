// ============================================================================
// Composer — professional prompt input for the chat view
// ============================================================================

import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  IconBolt,
  IconFile,
  IconFolder,
  IconLink,
  IconPlus,
  IconRefresh,
  IconSend,
  IconShield,
  IconStop,
  IconTerminal,
  IconWarning,
  IconX,
} from "../lib/icons";
import { Button, Select } from "../lib/ui";
import {
  contextToChips,
  filterSlashCommands,
  shouldSendOnKeydown,
  type ComposerChip,
  type SlashCommandDef,
} from "../lib/messages.js";
import type { ComposerContext } from "@codepilot/shared";
import type { AutoApproval, Settings } from "../types";

const MODE_OPTIONS: Array<{ value: string; label: string; title: string }> = [
  { value: "ask", label: "Ask", title: "Ask mode — read-only Q&A" },
  {
    value: "plan",
    label: "Plan",
    title: "Plan mode — analyze without modifying files",
  },
  {
    value: "act",
    label: "Act",
    title: "Act mode — implement with ChangeSet approval",
  },
  {
    value: "review",
    label: "Review",
    title: "Review mode — analyze bugs/security/perf",
  },
  {
    value: "auto",
    label: "Auto",
    title: "Auto mode — decide and act under policy",
  },
];

function Chip({
  chip,
  onRemove,
}: {
  chip: ComposerChip;
  onRemove: () => void;
}) {
  const icon =
    chip.kind === "file" ? (
      <IconFile size={10} />
    ) : chip.kind === "folder" ? (
      <IconFolder size={10} />
    ) : chip.kind === "url" ? (
      <IconLink size={10} />
    ) : chip.kind === "problems" ? (
      <IconWarning size={10} />
    ) : chip.kind === "image" ? (
      <IconFile size={10} />
    ) : (
      <IconFile size={10} />
    );
  const thumbnail =
    chip.kind === "image" && chip.preview ? (
      <img
        src={chip.preview}
        alt={chip.label}
        className="w-5 h-5 rounded object-cover flex-shrink-0"
      />
    ) : null;
  return (
    <span
      title={chip.ref ?? chip.label}
      className="inline-flex items-center gap-1 pl-1.5 pr-0.5 py-0.5 rounded-full border border-vscode-border bg-vscode-panel text-[10px] text-vscode-fg max-w-[220px]"
    >
      <span className="text-vscode-text-link flex-shrink-0">{icon}</span>
      {thumbnail}
      <span className="truncate">{chip.label.replace(/^[^\w]+\s*/, "")}</span>
      <button
        onClick={onRemove}
        aria-label={`Remove context ${chip.label}`}
        title={`Remove ${chip.label}`}
        className="rounded-full p-px text-vscode-desc hover:text-vscode-fg hover:bg-vscode-list-hover flex-shrink-0"
      >
        <IconX size={9} />
      </button>
    </span>
  );
}

export interface ComposerProps {
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  /** Phase 2: pause = stop + the task persists as PAUSED (resumable). */
  onPause?: () => void;
  onRetry: (() => void) | null;
  isRunning: boolean;
  // menus
  slashMenuOpen: boolean;
  onCloseMenus: () => void;
  onAttachFile: () => void;
  onAttachFolder: () => void;
  onAttachUrl: () => void;
  onAttachProblems: () => void;
  onAttachSelection: () => void;
  onAttachDiff: (scope: "working" | "staged") => void;
  onAttachTerminal: () => void;
  /** Delivers validated-in-browser image payloads (host re-validates). */
  onImagesSelected: (
    images: Array<{ name?: string; mime?: string; dataUrl: string }>,
  ) => void;
  onPickSlash: (command: string) => void;
  // context
  composerContext: ComposerContext;
  onRemoveContext: (id: string) => void;
  // settings
  settings: Settings;
  models: Array<{
    id: string;
    name: string;
    contextWindow?: number;
    /** Catalogue tool-calling tri-state (true/false/unknown). */
    toolCalling?: "true" | "false" | "unknown";
  }>;
  modelsLoading: boolean;
  onModeChange: (mode: string) => void;
  onModelChange: (model: string) => void;
  onRefreshModels: () => void;
  // usage
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalCost?: number;
  } | null;
  autoApproval: AutoApproval;
  onHeal?: () => void;
  connected?: boolean;
}

export function Composer(props: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const chips = contextToChips(props.composerContext);
  const slashPrefix = (props.input.match(/\/(\w*)$/) ?? [])[1] ?? "";
  const slashItems: SlashCommandDef[] = props.slashMenuOpen
    ? filterSlashCommands(slashPrefix).slice(0, 8)
    : [];
  const tokenCount =
    props.usage !== null
      ? props.usage.inputTokens + props.usage.outputTokens
      : 0;
  const contextPct = Math.min(Math.round((tokenCount / 128000) * 100), 100);

  useEffect(() => {
    if (!addMenuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!addMenuRef.current?.contains(event.target as Node)) {
        setAddMenuOpen(false);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setAddMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [addMenuOpen]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape" && addMenuOpen) {
      e.preventDefault();
      setAddMenuOpen(false);
      return;
    }
    if (shouldSendOnKeydown(e.key, e.shiftKey)) {
      e.preventDefault();
      if (props.isRunning) return;
      props.onCloseMenus();
      props.onSend();
    }
  };

  const readFilesAsDataUrls = (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (list.length === 0) return;
    const results: Array<{ name?: string; mime?: string; dataUrl: string }> =
      [];
    let pending = list.length;
    const done = () => {
      pending -= 1;
      if (pending === 0 && results.length > 0) {
        props.onImagesSelected(results);
      }
    };
    for (const file of list) {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          results.push({
            name: file.name,
            mime: file.type || undefined,
            dataUrl: reader.result,
          });
        }
        done();
      };
      reader.onerror = done;
      reader.readAsDataURL(file);
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length > 0) {
      e.preventDefault();
      readFilesAsDataUrls(files);
    }
  };

  const handleDrop = (e: DragEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length > 0) {
      e.preventDefault();
      readFilesAsDataUrls(files);
    }
  };

  return (
    <div className="border-t border-vscode-border bg-vscode-bg flex-shrink-0">
      {/* Context chips */}
      {chips.length > 0 && (
        <div
          className="flex flex-wrap gap-1 px-3 pt-2"
          data-testid="context-chips"
        >
          {chips.map((chip) => (
            <Chip
              key={chip.id}
              chip={chip}
              onRemove={() => props.onRemoveContext(chip.id)}
            />
          ))}
        </div>
      )}

      {/* Slash menu */}
      {props.slashMenuOpen && slashItems.length > 0 && (
        <div
          className="mx-3 mt-2 rounded-md border border-vscode-border bg-vscode-elevated overflow-hidden shadow-sm"
          data-testid="slash-menu"
          role="listbox"
          aria-label="Slash commands"
        >
          {slashItems.map((c) => (
            <button
              key={c.command}
              role="option"
              aria-selected={false}
              className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-vscode-list-hover flex items-baseline gap-2"
              onClick={() => props.onPickSlash(`/${c.command} `)}
              title={c.description}
            >
              <span className="font-mono text-vscode-text-link font-medium">
                /{c.command}
              </span>
              <span className="text-vscode-desc truncate">{c.description}</span>
            </button>
          ))}
        </div>
      )}

      {/* Input row */}
      <div className="px-3 py-2">
        <div className="rounded-lg border border-vscode-input-border bg-vscode-input-bg focus-within:border-vscode-focus-border transition-colors">
          <textarea
            ref={textareaRef}
            value={props.input}
            onChange={(e) => props.onInputChange(e.target.value)}
            onBlur={props.onCloseMenus}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onDrop={handleDrop}
            disabled={props.isRunning}
            placeholder={
              props.isRunning
                ? "CodePilot is working… (Stop to cancel)"
                : "Ask CodePilot anything…"
            }
            aria-label="Chat message"
            rows={2}
            className={`w-full text-[13px] px-3 py-2 bg-transparent text-vscode-input-fg placeholder:text-vscode-input-placeholder resize-none focus:outline-none ${
              props.isRunning ? "opacity-60 cursor-not-allowed" : ""
            }`}
          />
          <input
            ref={imageInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            className="hidden"
            aria-label="Attach images"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                readFilesAsDataUrls(e.target.files);
              }
              e.target.value = "";
            }}
          />
          <div className="flex items-center gap-1.5 px-2 pb-1.5 min-w-0">
            <div className="relative flex-shrink-0" ref={addMenuRef}>
              <button
                type="button"
                aria-label="Add files and context"
                aria-expanded={addMenuOpen}
                aria-haspopup="menu"
                aria-controls="composer-add-menu"
                title="Add files, images, and context"
                onClick={() => setAddMenuOpen((open) => !open)}
                className={`inline-flex h-7 w-7 items-center justify-center rounded border border-vscode-input-border transition-colors ${
                  addMenuOpen
                    ? "bg-vscode-list-hover text-vscode-fg"
                    : "text-vscode-desc hover:text-vscode-fg hover:bg-vscode-list-hover"
                }`}
              >
                <IconPlus size={14} />
              </button>
              {addMenuOpen && (
                <div
                  id="composer-add-menu"
                  role="menu"
                  aria-label="Add to message"
                  className="absolute bottom-full left-0 z-50 mb-2 max-h-80 w-64 overflow-y-auto rounded-md border border-vscode-border bg-vscode-elevated p-1 shadow-lg"
                >
                  <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-vscode-desc">
                    Add to message
                  </div>
                  {(
                    [
                      [
                        "Files…",
                        <IconFile size={13} key="files" />,
                        props.onAttachFile,
                      ],
                      [
                        "Folder…",
                        <IconFolder size={13} key="folder" />,
                        props.onAttachFolder,
                      ],
                      [
                        "Image…",
                        <IconFile size={13} key="image" />,
                        () => imageInputRef.current?.click(),
                      ],
                      [
                        "Web link…",
                        <IconLink size={13} key="url" />,
                        props.onAttachUrl,
                      ],
                      [
                        "VS Code Problems",
                        <IconWarning size={13} key="problems" />,
                        props.onAttachProblems,
                      ],
                      [
                        "Editor selection",
                        <IconFile size={13} key="selection" />,
                        props.onAttachSelection,
                      ],
                      [
                        "Working tree diff",
                        <IconFile size={13} key="working-diff" />,
                        () => props.onAttachDiff("working"),
                      ],
                      [
                        "Staged diff",
                        <IconFile size={13} key="staged-diff" />,
                        () => props.onAttachDiff("staged"),
                      ],
                      [
                        "Terminal output",
                        <IconTerminal size={13} key="terminal" />,
                        props.onAttachTerminal,
                      ],
                    ] as Array<[string, ReactNode, () => void]>
                  ).map(([label, icon, action]) => (
                    <button
                      key={label}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setAddMenuOpen(false);
                        action();
                      }}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-vscode-fg hover:bg-vscode-list-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focus-border"
                    >
                      <span className="text-vscode-text-link">{icon}</span>
                      {label}
                    </button>
                  ))}
                  <div className="my-1 border-t border-vscode-border" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAddMenuOpen(false);
                      props.onRefreshModels();
                    }}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-vscode-fg hover:bg-vscode-list-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focus-border"
                  >
                    <IconRefresh size={13} /> Refresh models
                  </button>
                  {props.onRetry && !props.isRunning && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setAddMenuOpen(false);
                        props.onRetry?.();
                      }}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-vscode-fg hover:bg-vscode-list-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focus-border"
                    >
                      <IconRefresh size={13} /> Retry last response
                    </button>
                  )}
                  {props.onHeal && !props.isRunning && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setAddMenuOpen(false);
                        props.onHeal?.();
                      }}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-vscode-warning-fg hover:bg-vscode-list-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focus-border"
                    >
                      <IconShield size={13} /> Recover from last failure
                    </button>
                  )}
                  {props.usage && (
                    <div className="px-2 py-1.5 text-[10px] text-vscode-desc">
                      Session: {tokenCount.toLocaleString()} tokens
                      {props.usage.totalCost
                        ? ` · $${props.usage.totalCost.toFixed(4)}`
                        : ""}{" "}
                      ({contextPct}% context)
                    </div>
                  )}
                </div>
              )}
            </div>

            <Select
              aria-label="Agent mode"
              title={
                MODE_OPTIONS.find(
                  (mode) => mode.value === props.settings.agentMode,
                )?.title
              }
              value={props.settings.agentMode}
              onChange={(e) => props.onModeChange(e.target.value)}
              className="max-w-[92px] flex-shrink-0"
            >
              {MODE_OPTIONS.map((mode) => (
                <option key={mode.value} value={mode.value} title={mode.title}>
                  {mode.label}
                </option>
              ))}
            </Select>

            <Select
              aria-label="Model"
              title={
                props.models.length > 0
                  ? `${props.models.length} models available`
                  : props.modelsLoading
                    ? "Scanning models…"
                    : "No models detected"
              }
              value={
                props.models.some(
                  (model) => model.id === props.settings.model,
                ) || props.settings.model
                  ? props.settings.model
                  : ""
              }
              onChange={(e) => props.onModelChange(e.target.value)}
              className="min-w-0 max-w-[180px] flex-1"
            >
              {props.models.length === 0 ? (
                <>
                  <option value="">
                    {props.modelsLoading ? "Scanning…" : "No models"}
                  </option>
                  <option value="qwen3:8b">qwen3:8b</option>
                </>
              ) : (
                props.models.map((model) => (
                  <option
                    key={model.id}
                    value={model.id}
                    title={
                      model.toolCalling === "true"
                        ? "Tool calling supported"
                        : model.toolCalling === "false"
                          ? "Tool calling not supported"
                          : "Tool calling support unknown"
                    }
                  >
                    {model.name}
                  </option>
                ))
              )}
            </Select>

            {props.settings.provider === "gemini" && props.connected && (
              <span
                data-testid="gemini-connection-indicator"
                className="inline-flex items-center gap-1 text-[11px] font-medium text-vscode-testing-run bg-vscode-badge-bg/10 border border-vscode-testing-run/30 rounded px-1.5 py-0.5 whitespace-nowrap"
                title="Gemini Connected"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-vscode-testing-run inline-block" />
                Gemini ✓ Connected
              </span>
            )}

            <span className="flex-1" />

            {props.isRunning ? (
              <>
                {props.onPause && (
                  <Button
                    variant="secondary"
                    onClick={props.onPause}
                    aria-label="Pause the running agent (resumable)"
                    title="Pause (resumable)"
                    className="flex-shrink-0"
                  >
                    Pause
                  </Button>
                )}
                <Button
                  variant="danger"
                  onClick={props.onStop}
                  aria-label="Stop the running agent"
                  title="Stop"
                  className="flex-shrink-0"
                >
                  <IconStop size={11} /> Stop
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                onClick={props.onSend}
                disabled={!props.input.trim()}
                aria-label="Send message"
                title="Send (Enter)"
                className="h-7 w-7 flex-shrink-0 px-0"
              >
                <IconSend size={13} />
              </Button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 px-1 pt-1 text-[9px] text-vscode-desc/70">
          <span>
            <IconBolt size={9} className="inline mr-0.5 -mt-px" />
            {props.settings.provider}
          </span>
          <span>·</span>
          <span>Enter to send · Shift+Enter for newline</span>
          {props.autoApproval.executeCommands && (
            <>
              <span>·</span>
              <span className="text-vscode-warning-fg">
                command auto-approval on
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
