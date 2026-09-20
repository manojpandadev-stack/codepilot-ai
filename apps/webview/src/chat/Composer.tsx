// ============================================================================
// Composer — professional prompt input for the chat view
// ============================================================================

import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useRef,
} from "react";
import {
  IconBolt,
  IconFile,
  IconFolder,
  IconLink,
  IconSend,
  IconShield,
  IconStop,
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
  onRetry: (() => void) | null;
  isRunning: boolean;
  // menus
  mentionMenuOpen: boolean;
  slashMenuOpen: boolean;
  onCloseMenus: () => void;
  onAttachFile: () => void;
  onAttachFolder: () => void;
  onAttachUrl: () => void;
  onAttachProblems: () => void;
  onAttachSelection: () => void;
  /** Delivers validated-in-browser image payloads (host re-validates). */
  onImagesSelected: (
    images: Array<{ name?: string; mime?: string; dataUrl: string }>,
  ) => void;
  /** Menu selections strip the "@" keyword, then run the attach handler. */
  onPickMention: (attach: () => void) => void;
  onPickSlash: (command: string) => void;
  // context
  composerContext: ComposerContext;
  onRemoveContext: (id: string) => void;
  // settings
  settings: Settings;
  models: Array<{ id: string; name: string; contextWindow?: number }>;
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
}

export function Composer(props: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
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

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (shouldSendOnKeydown(e.key, e.shiftKey)) {
      e.preventDefault();
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

      {/* Mention (@) menu */}
      {props.mentionMenuOpen && (
        <div
          className="mx-3 mt-2 rounded-md border border-vscode-border bg-vscode-elevated overflow-hidden shadow-sm"
          data-testid="mention-menu"
          role="listbox"
          aria-label="Attach context"
        >
          <div className="px-3 py-1 text-[9px] uppercase tracking-wide text-vscode-desc">
            Attach context
          </div>
          {(
            [
              ["Files…", props.onAttachFile, <IconFile size={11} key="f" />],
              [
                "Folder…",
                props.onAttachFolder,
                <IconFolder size={11} key="d" />,
              ],
              ["URL", props.onAttachUrl, <IconLink size={11} key="u" />],
              [
                "Problems",
                props.onAttachProblems,
                <IconWarning size={11} key="p" />,
              ],
              [
                "Selection",
                props.onAttachSelection,
                <IconFile size={11} key="s" />,
              ],
              [
                "Images…",
                () => imageInputRef.current?.click(),
                <IconFile size={11} key="i" />,
              ],
            ] as Array<[string, () => void, ReactNode]>
          ).map(([label, handler, icon]) => (
            <button
              key={label}
              role="option"
              aria-selected={false}
              className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-vscode-list-hover flex items-center gap-2"
              onClick={() => props.onPickMention(handler)}
            >
              <span className="text-vscode-text-link">{icon}</span>
              {label}
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
            placeholder="Describe what you want to do…  (/ for commands, @ for context)"
            aria-label="Chat message"
            rows={2}
            className="w-full text-[13px] px-3 py-2 bg-transparent text-vscode-input-fg placeholder:text-vscode-input-placeholder resize-none focus:outline-none"
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
          <div className="flex items-center gap-1.5 px-2 pb-1.5">
            {/* Attach */}
            <div
              className="flex gap-0.5"
              role="group"
              aria-label="Attach context"
            >
              <button
                onClick={props.onAttachFile}
                aria-label="Attach file(s)"
                title="Attach file(s) from workspace"
                className="rounded p-1 text-vscode-desc hover:text-vscode-fg hover:bg-vscode-list-hover"
              >
                <IconFile size={13} />
              </button>
              <button
                onClick={props.onAttachFolder}
                aria-label="Attach folder"
                title="Attach folder"
                className="rounded p-1 text-vscode-desc hover:text-vscode-fg hover:bg-vscode-list-hover"
              >
                <IconFolder size={13} />
              </button>
              <button
                onClick={props.onAttachUrl}
                aria-label="Attach URL"
                title="Attach URL"
                className="rounded p-1 text-vscode-desc hover:text-vscode-fg hover:bg-vscode-list-hover"
              >
                <IconLink size={13} />
              </button>
              <button
                onClick={props.onAttachProblems}
                aria-label="Attach problems"
                title="Attach VS Code Problems"
                className="rounded p-1 text-vscode-desc hover:text-vscode-fg hover:bg-vscode-list-hover"
              >
                <IconWarning size={13} />
              </button>
              <button
                onClick={() => imageInputRef.current?.click()}
                aria-label="Attach image(s)"
                title="Attach image(s) (png, jpeg, webp, gif)"
                className="rounded p-1 text-vscode-desc hover:text-vscode-fg hover:bg-vscode-list-hover"
              >
                <IconFile size={13} />
              </button>
            </div>

            <span className="w-px h-4 bg-vscode-border" />

            {/* Mode selector */}
            <div
              role="radiogroup"
              aria-label="Agent mode"
              className="flex rounded border border-vscode-input-border overflow-hidden"
            >
              {MODE_OPTIONS.map((m) => (
                <button
                  key={m.value}
                  role="radio"
                  aria-checked={props.settings.agentMode === m.value}
                  title={m.title}
                  onClick={() => props.onModeChange(m.value)}
                  className={`px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                    props.settings.agentMode === m.value
                      ? "bg-vscode-btn text-vscode-btn-fg"
                      : "text-vscode-desc hover:text-vscode-fg hover:bg-vscode-list-hover"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {/* Model selector */}
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
                props.models.some((m) => m.id === props.settings.model) ||
                props.settings.model
                  ? props.settings.model
                  : ""
              }
              onChange={(e) => props.onModelChange(e.target.value)}
              className="min-w-0 max-w-[160px] flex-shrink"
            >
              {props.models.length === 0 ? (
                <>
                  <option value="">
                    {props.modelsLoading ? "Scanning…" : "No models"}
                  </option>
                  <option value="qwen3:8b">qwen3:8b</option>
                </>
              ) : (
                props.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {m.contextWindow
                      ? ` · ${Math.round(m.contextWindow / 1024)}k`
                      : ""}
                  </option>
                ))
              )}
            </Select>
            <button
              onClick={props.onRefreshModels}
              aria-label="Refresh model list"
              title="Re-scan installed models"
              className="rounded p-1 text-vscode-desc hover:text-vscode-fg hover:bg-vscode-list-hover flex-shrink-0"
            >
              ⟳
            </button>

            <span className="flex-1" />

            {/* Token indicator (real usage only) */}
            {props.usage && (
              <span
                title={`${tokenCount.toLocaleString()} tokens this session${props.usage.totalCost ? ` · $${props.usage.totalCost.toFixed(4)}` : ""}`}
                className="hidden sm:flex items-center gap-1.5 flex-shrink-0"
              >
                <span className="w-12 h-1 rounded-full bg-vscode-border overflow-hidden">
                  <span
                    className="block h-full bg-vscode-text-link"
                    style={{ width: `${contextPct}%` }}
                  />
                </span>
                <span className="text-[9px] font-mono text-vscode-desc">
                  {contextPct}%
                </span>
              </span>
            )}

            {/* Stop / Send */}
            {props.isRunning ? (
              <Button
                variant="danger"
                onClick={props.onStop}
                aria-label="Stop the running agent"
                title="Stop"
                className="flex-shrink-0"
              >
                <IconStop size={11} /> Stop
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={props.onSend}
                disabled={!props.input.trim()}
                aria-label="Send message"
                title="Send (Enter)"
                className="flex-shrink-0"
              >
                <IconSend size={11} /> Send
              </Button>
            )}
            {props.onRetry && !props.isRunning && (
              <Button
                onClick={props.onRetry}
                aria-label="Retry last prompt"
                title="Retry last prompt"
                className="flex-shrink-0"
              >
                ↻
              </Button>
            )}
            {props.onHeal && !props.isRunning && (
              <Button
                variant="ghost"
                onClick={props.onHeal}
                aria-label="Trigger self-healing"
                title="Trigger self-healing for the last failure"
                className="flex-shrink-0 text-vscode-warning-fg hover:text-vscode-warning-fg"
              >
                <IconShield size={11} />
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
