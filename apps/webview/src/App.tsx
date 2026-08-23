import { useState, useEffect, useRef, useCallback } from "react";
import { DiffViewer, type FileChange } from "./DiffViewer";
import {
  applyDiffResult,
  parseSlashCommand,
  SLASH_COMMANDS,
  filterSlashCommands,
  normalizeModelList,
  normalizeProviderList,
  normalizeToolList,
  createEmptyComposerContext,
  addFileEntriesToContext,
  addFolderEntriesToContext,
  addUrlToContext,
  setProblemsInContext,
  setSelectionInContext,
  removeContextEntry,
  contextToChips,
  buildChatSendPayload,
  buildRetryPayload,
  createRequestId,
  reduceHealingState,
  healingPhaseLabel,
  healingNextActionLabel,
  type HealingStatusState,
  type DiffResultKind,
  type ModelInfoLite,
  type ProviderInfo,
  type ToolRegistryEntry,
} from "./lib/messages.js";
import type { ComposerContext } from "@codepilot/shared";

// ============================================================================
// Types
// ============================================================================

interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: number;
  toolName?: string;
  status?: "running" | "completed" | "error";
}

interface ToolEvent {
  id: string;
  name: string;
  status: "started" | "completed" | "error";
  detail?: string;
  durationMs?: number;
}

interface Settings {
  provider: string;
  model: string;
  privacyMode: string;
  agentMode: string;
  temperature: number;
  baseUrl: string;
}

interface AutoApproval {
  readFiles: boolean;
  editFiles: boolean;
  executeCommands: boolean;
  webFetch: boolean;
  mcpServers: boolean;
  browser: boolean;
  maxAutoApprovals: number;
}

interface DiffCreatedPayload {
  changeSetId: string;
  changes: Array<{
    id: string;
    filePath: string;
    diff: string;
    status: string;
    isNew: boolean;
  }>;
}

// ============================================================================
// VS Code API Bridge
// ============================================================================

declare function acquireVsCodeApi(): {
  postMessage: (msg: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
};

const vscode = typeof acquireVsCodeApi !== "undefined" ? acquireVsCodeApi() : null;

function sendMessage(type: string, payload: unknown) {
  vscode?.postMessage({ type, id: `wv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, payload, timestamp: Date.now() });
}

/**
 * Best-effort diff/result classification when the originating action kind
 * was not recorded (e.g. after a webview reload). The host payload shape
 * disambiguates batch operations; single-change results default to "accept"
 * (the non-destructive guess — a misread reject would only leave a stale
 * rollback row, never hide an applied file).
 */
function inferKind(payload: { changeId?: string; rejected?: number; applied?: number }): DiffResultKind {
  if (payload.changeId) return "accept";
  if (payload.rejected !== undefined && payload.applied === undefined) return "reject_all";
  return "accept_all";
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
    provider: "ollama", model: "qwen3:8b", privacyMode: "local",
    agentMode: "act", temperature: 0.7, baseUrl: "http://localhost:11434",
  });
  const [autoApproval, setAutoApproval] = useState<AutoApproval>({
    readFiles: true, editFiles: false, executeCommands: false,
    webFetch: false, mcpServers: false, browser: false,
    maxAutoApprovals: 10,
  });
  const [currentTab, setCurrentTab] = useState<"chat" | "tools" | "changes" | "history" | "settings">("chat");
  const [sessions, setSessions] = useState<Array<{ id: string; title?: string; updatedAt?: number }>>([]);
  const [toolRegistry, setToolRegistry] = useState<ToolRegistryEntry[]>([]);
  const [lastPrompt, setLastPrompt] = useState("");
  // Composer context: structured attachments separate from user text.
  const [composerContext, setComposerContext] = useState<ComposerContext>(createEmptyComposerContext());
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [usage, setUsage] = useState<{ inputTokens: number; outputTokens: number; totalCost?: number } | null>(null);
  const [fileChanges, setFileChanges] = useState<FileChange[]>([]);
  const [pendingApproval, setPendingApproval] = useState(false);
  const [mcpApprovals, setMcpApprovals] = useState<Array<{
    requestId: string;
    serverName: string;
    toolName: string;
    arguments: Record<string, unknown>;
    riskLevel: string;
  }>>([]);
  const [streamingText, setStreamingText] = useState("");
  // Mirrors streamingText for use inside the (long-lived) message listener —
  // reading state inside the handler sees a stale closure and can DROP the
  // final delta when "completed" arrives in the same tick as the last chunk.
  const streamingTextRef = useRef("");
  // Request-ID of the current chat turn; events for other turns are ignored.
  const activeRequestIdRef = useRef<string | null>(null);
  const [healingState, setHealingState] = useState<HealingStatusState | null>(null);
  const [models, setModels] = useState<ModelInfoLite[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const lastDiffActionRef = useRef<{ kind: DiffResultKind } | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  // Mirrors fileChanges for use inside the (long-lived) message listener
  const fileChangesRef = useRef<FileChange[]>([]);
  useEffect(() => {
    fileChangesRef.current = fileChanges;
  }, [fileChanges]);

  /** Record which diff/* action we sent so diff/result can be reduced correctly. */
  const sendDiffAction = useCallback((kind: DiffResultKind, type: string, payload: unknown) => {
    lastDiffActionRef.current = { kind };
    sendMessage(type, payload);
  }, []);

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
    const content = streamingTextRef.current.trim().length > 0
      ? streamingTextRef.current
      : (fallbackResult ?? "").trim();
    streamingTextRef.current = "";
    setStreamingText("");
    if (content.length > 0) {
      setMessages((prev) => [...prev, {
        id: `assistant-${Date.now()}`, role: "assistant",
        content, timestamp: Date.now(),
      }]);
    }
  }, []);

  /** True when an event belongs to an older/aborted request and must be dropped. */
  const isStaleEvent = useCallback((payloadRequestId: unknown): boolean => {
    return typeof payloadRequestId === "string"
      && activeRequestIdRef.current !== null
      && payloadRequestId !== activeRequestIdRef.current;
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
          setToolEvents((prev) => [...prev, {
            id: msg.payload.toolCallId, name: msg.payload.toolName,
            status: "started",
          }]);
          break;
        case "tool/completed":
          if (isStaleEvent(msg.payload?.requestId)) break;
          setToolEvents((prev) => prev.map((e) =>
            e.id === msg.payload.toolCallId ? { ...e, status: "completed" as const, durationMs: msg.payload.durationMs } : e
          ));
          break;
        case "agent/status":
          if (isStaleEvent(msg.payload?.requestId)) break;
          setStatusMessage(
            msg.payload.status === "running"
              ? msg.payload.message ?? "Agent running…"
              : msg.payload.status === "completed"
              ? `Completed${msg.payload.usage ? ` · ${msg.payload.usage.inputTokens}→${msg.payload.usage.outputTokens} tok` : ""}`
              : "Idle"
          );
          if (msg.payload.status === "completed") {
            // ONE assistant message per turn: promote accumulated deltas,
            // falling back to the host's final result for non-streamed runs.
            promoteStreamingToMessage(
              typeof msg.payload.result === "string" ? msg.payload.result : undefined
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
        case "provider/list":
          setProviders(normalizeProviderList(msg.payload));
          break;
        case "model/list":
          setModels(normalizeModelList(msg.payload));
          break;
        case "tools/list_result":
          setToolRegistry(normalizeToolList(msg.payload));
          break;
        case "healing/started":
          // Single healing status object — every event updates it in place,
          // never appends duplicate status messages.
          setHealingState((prev) => reduceHealingState(prev, {
            kind: "started",
            attempt: msg.payload.attempt ?? 1,
            maxAttempts: msg.payload.maxAttempts ?? 3,
            exitCode: msg.payload.exitCode,
            command: msg.payload.command,
            stderrExcerpt: msg.payload.stderrExcerpt,
          }));
          break;
        case "healing/progress": {
          const phase = typeof msg.payload.type === "string" ? msg.payload.type : "diagnosis_started";
          const detail = msg.payload.diagnosis ?? msg.payload.repairDescription;
          setHealingState((prev) => reduceHealingState(prev ?? {
            active: true, attempt: msg.payload.attempt ?? 1, maxAttempts: msg.payload.maxAttempts ?? 3,
            phase, message: "", success: false,
          }, { kind: "progress", phase, attempt: msg.payload.attempt ?? prev?.attempt ?? 1, message: detail }));
          break;
        }
        case "healing/succeeded":
          setHealingState((prev) => reduceHealingState(prev, {
            kind: "succeeded", attempt: msg.payload.attempt ?? prev?.attempt ?? 1, durationMs: msg.payload.durationMs,
          }));
          break;
        case "healing/exhausted":
          setHealingState((prev) => reduceHealingState(prev, {
            kind: "exhausted", maxAttempts: msg.payload.maxAttempts ?? prev?.maxAttempts ?? 3,
          }));
          break;
        case "context/result": {
          // Structured context from the host (file picker / folder picker /
          // problems diagnostics / selection). Becomes a chip — NEVER text in
          // the composer input and never a chat message.
          const result = msg.payload as import("@codepilot/shared").ContextResultPayload;
          if (!result || typeof result !== "object") break;
          if (result.error) {
            setStatusMessage(`Context unavailable: ${result.error}`);
            break;
          }
          setComposerContext((prev) => {
            let next = prev;
            if (result.kind === "filePicker" && Array.isArray(result.files) && result.files.length > 0) {
              next = addFileEntriesToContext(next, result.files);
            }
            if (result.kind === "folderPicker" && Array.isArray(result.folders) && result.folders.length > 0) {
              next = addFolderEntriesToContext(next, result.folders);
            }
            if (result.kind === "problems") {
              next = setProblemsInContext(next, result.diagnostics ?? null);
              const n = result.diagnostics?.items.length ?? 0;
              if (n === 0) setStatusMessage("No problems detected in this workspace.");
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
          setMessages((prev) => [...prev, {
            id: `err-${Date.now()}`, role: "system",
            content: `Error: ${msg.payload.message}`, timestamp: Date.now(),
          }]);
          // Failed turns must never leave "Agent running…" stuck on screen.
          streamingTextRef.current = "";
          setStreamingText("");
          setIsRunning(false);
          break;
        case "settings/get":
          if (msg.payload) setSettings((prev) => ({ ...prev, ...msg.payload }));
          break;
        case "settings/error":
          setStatusMessage(msg.payload?.error ?? "Setting could not be applied.");
          setMessages((prev) => [...prev, {
            id: `settings-err-${Date.now()}`, role: "system",
            content: `Settings: ${msg.payload?.error ?? "unknown error"}`,
            timestamp: Date.now(),
          }]);
          break;
        case "session/list":
          if (Array.isArray(msg.payload)) {
            setSessions(msg.payload);
          }
          break;
        case "agent/file_changed":
          setFileChanges((prev) => {
            const existing = prev.find((c) => c.path === msg.payload.path);
            if (existing) {
              return prev.map((c) =>
                c.path === msg.payload.path ? { ...c, ...msg.payload } : c
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
          setFileChanges(payload.changes.map((change) => ({
            path: change.filePath,
            changeSetId: payload.changeSetId,
            changeId: change.id,
            status: change.isNew ? "added" : "modified",
            diff: change.diff,
          })));
          setPendingApproval(true);
          break;
        }
        case "diff/result": {
          const payload = msg.payload as import("./lib/messages.js").DiffResultPayload;
          const kind = lastDiffActionRef.current?.kind;
          const reduced = applyDiffResult(fileChangesRef.current, kind ?? inferKind(payload), payload);
          setFileChanges(reduced.changes);
          setPendingApproval(reduced.pendingApproval);
          if (reduced.error) {
            setMessages((prev) => [...prev, {
              id: `diff-error-${Date.now()}`,
              role: "system",
              content: `Change could not be applied: ${reduced.error}`,
              timestamp: Date.now(),
            }]);
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
            setMcpApprovals((prev) => prev.filter((a) => a.requestId !== msg.payload.requestId));
          } else {
            setMcpApprovals((prev) => {
              if (prev.some((a) => a.requestId === msg.payload.requestId)) return prev;
              return [...prev, {
                requestId: msg.payload.requestId,
                serverName: msg.payload.serverName,
                toolName: msg.payload.toolName,
                arguments: msg.payload.arguments,
                riskLevel: msg.payload.riskLevel,
              }];
            });
          }
          break;
      }
    };
    window.addEventListener("message", handler);
    sendMessage("settings/get", {});
    sendMessage("provider/list", {});
    sendMessage("model/list", {});
    sendMessage("tools/list", {});
    sendMessage("session/list", {});
    return () => window.removeEventListener("message", handler);
  }, [streamingText]);

  // Auto-scroll
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText, toolEvents]);

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
      const lines = SLASH_COMMANDS.map((c) => `  /${c.command}${c.mode ? " <task>" : ""} — ${c.description}`);
      setMessages((prev) => [...prev, {
        id: `help-${Date.now()}`, role: "system",
        content: ["Available commands:", ...lines].join("\n"),
        timestamp: Date.now(),
      }]);
      return;
    }
    if (def?.mode) {
      setSettings((prev) => ({ ...prev, agentMode: def.mode! }));
      sendMessage("settings/set", { key: "agentMode", value: def.mode });
      // Mode-only invocation (no task): report the switch, don't call the agent.
      if (!prompt && !def.instruction) {
        setMessages((prev) => [...prev, {
          id: `mode-${Date.now()}`, role: "system",
          content: `Mode switched to ${def.mode}.`,
          timestamp: Date.now(),
        }]);
        return;
      }
      // Fall through: send the task in the newly selected mode.
    }

    const finalPrompt = instruction ? `${instruction}${prompt}` : prompt;

    const userMsg: Message = {
      id: `user-${Date.now()}`, role: "user",
      content: finalPrompt, timestamp: Date.now(),
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
    sendMessage("chat/send", buildChatSendPayload(finalPrompt, resolvedMode, composerContext, requestId));
    setComposerContext(createEmptyComposerContext());
  }, [input, isRunning, settings.agentMode, composerContext]);

  const handleMCPApproval = useCallback((requestId: string, decision: "approve" | "reject") => {
    sendMessage("mcp/approval_response", { requestId, decision });
    setMcpApprovals((prev) => prev.filter((a) => a.requestId !== requestId));
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
    const url = window.prompt("Enter URL to attach as context:\nExample: https://docs.example.com/api");
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

  const handleAutoApprovalChange = useCallback((key: keyof AutoApproval, value: boolean | number) => {
    setAutoApproval((prev) => {
      const next = { ...prev, [key]: value };
      sendMessage("settings/set", { key: "autoApproval", value: next });
      return next;
    });
  }, []);

  const handleAcceptFile = useCallback((path: string) => {
    const change = fileChanges.find((item) => item.path === path);
    if (!change?.changeSetId || !change.changeId) return;
    sendDiffAction("accept", "diff/accept", { changeSetId: change.changeSetId, changeId: change.changeId });
  }, [fileChanges, sendDiffAction]);

  const handleRejectFile = useCallback((path: string) => {
    const change = fileChanges.find((item) => item.path === path);
    if (!change?.changeSetId || !change.changeId) return;
    sendDiffAction("reject", "diff/reject", { changeSetId: change.changeSetId, changeId: change.changeId });
  }, [fileChanges, sendDiffAction]);

  const handleRollbackFile = useCallback((path: string) => {
    const change = fileChanges.find((item) => item.path === path);
    if (!change?.changeSetId || !change.changeId) return;
    sendDiffAction("rollback", "diff/rollback", { changeSetId: change.changeSetId, changeId: change.changeId });
  }, [fileChanges, sendDiffAction]);

  const handleAcceptAll = useCallback(() => {
    const changeSetId = fileChanges[0]?.changeSetId;
    if (!changeSetId || fileChanges.some((change) => change.changeSetId !== changeSetId)) return;
    sendDiffAction("accept_all", "diff/accept_all", { changeSetId });
  }, [fileChanges, sendDiffAction]);

  const handleRejectAll = useCallback(() => {
    const changeSetId = fileChanges[0]?.changeSetId;
    if (!changeSetId || fileChanges.some((change) => change.changeSetId !== changeSetId)) return;
    sendDiffAction("reject_all", "diff/reject_all", { changeSetId });
  }, [fileChanges, sendDiffAction]);

  const ollamaConnected = providers.find((p) => p.id === "ollama")?.connected ?? false;

  return (
    <div className="flex flex-col h-screen bg-vscode-bg">
      {/* Header */}
      <header className="flex items-center justify-between px-3 py-2 border-b border-vscode-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-vscode-fg">🤖 CodePilot AI</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-vscode-badge-bg text-vscode-badge-fg">v0.1.0</span>
        </div>
        <div className="flex items-center gap-2">
          <span
            title={ollamaConnected
              ? `Ollama connected at ${settings.baseUrl}`
              : `Ollama unavailable at ${settings.baseUrl} — start Ollama and refresh`}
            aria-label={ollamaConnected ? "Ollama connected" : "Ollama unavailable"}
            className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold ${
              ollamaConnected ? "bg-green-900 text-green-300" : "bg-red-900 text-red-300"
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${ollamaConnected ? "bg-green-400" : "bg-red-400"}`} />
            {ollamaConnected ? "LOCAL" : "OFFLINE"}
          </span>
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${
            settings.privacyMode === "local" ? "bg-green-900 text-green-300" :
            settings.privacyMode === "cloud" ? "bg-orange-900 text-orange-300" :
            "bg-yellow-900 text-yellow-300"
          }`}>
            {settings.privacyMode === "local" ? "LOCAL ONLY" : settings.privacyMode.toUpperCase()}
          </span>
          <button
            onClick={() => setCurrentTab("settings")}
            aria-label="Open CodePilot settings"
            title="Settings"
            className={`text-[11px] px-1.5 py-0.5 rounded border ${
              currentTab === "settings"
                ? "border-vscode-text-link text-vscode-text-link"
                : "border-vscode-input-border text-vscode-desc hover:text-vscode-fg"
            }`}
          >
            ⚙
          </button>
        </div>
      </header>

      {/* Controls */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-vscode-border flex-shrink-0">
        <select
          value={settings.agentMode}
          onChange={(e) => {
            const mode = e.target.value as Settings["agentMode"];
            setSettings((s) => ({ ...s, agentMode: mode }));
            // Persist + apply immediately in the runtime PolicyEngine
            sendMessage("settings/set", { key: "agentMode", value: mode });
          }}
          aria-label="Agent mode"
          title="Agent mode — Plan is read-only, Act applies approved changes"
          className="text-[11px] px-2 py-1 rounded border border-vscode-input-border bg-vscode-input-bg text-vscode-input-fg"
        >
          <option value="ask">💬 Ask</option>
          <option value="plan">📋 Plan</option>
          <option value="act">⚡ Act</option>
          <option value="review">🔍 Review</option>
          <option value="auto">🤖 Auto</option>
        </select>
        <select
          value={models.some((m) => m.id === settings.model) || settings.model ? settings.model : ""}
          onChange={(e) => {
            const model = e.target.value;
            setSettings((s) => ({ ...s, model }));
            // Switch the live runtime model
            sendMessage("settings/set", { key: "model", value: model });
          }}
          aria-label="Model"
          title={models.length > 0 ? `${models.length} Ollama models available` : "No Ollama models detected"}
          className="text-[11px] px-2 py-1 rounded border border-vscode-input-border bg-vscode-input-bg text-vscode-input-fg flex-1 min-w-0"
        >
          {models.length === 0 ? (
            <>
              <option value="">
                {ollamaConnected ? "Ollama: no models pulled" : "Ollama unavailable"}
              </option>
              <option value="qwen3:8b">qwen3:8b</option>
            </>
          ) : (
            models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}{m.contextWindow ? ` · ${Math.round(m.contextWindow / 1024)}k` : ""}
              </option>
            ))
          )}
        </select>
        <button
          onClick={() => sendMessage("model/list", {})}
          aria-label="Refresh model list"
          title="Re-scan installed Ollama models"
          className="text-[11px] px-2 py-1 rounded border border-vscode-input-border text-vscode-desc hover:text-vscode-fg"
        >
          ⟳
        </button>
        <button
          onClick={handleStop}
          disabled={!isRunning}
          aria-label={isRunning ? "Stop the running agent" : "Stop (agent idle)"}
          className={`text-[11px] px-2 py-1 rounded border border-vscode-input-border ${
            isRunning ? "bg-red-900 text-red-300 cursor-pointer" : "opacity-40 cursor-not-allowed text-vscode-desc"
          }`}
        >
          ⏹ Stop
        </button>
      </div>

      {/* Status strip */}
      {(isRunning || healingState?.active || statusMessage) && (
        <div
          role="status"
          aria-live="polite"
          className={`flex items-center gap-2 px-3 py-1 text-[10px] flex-shrink-0 border-b border-vscode-border ${
            healingState?.active ? "bg-yellow-950 text-yellow-300" : "text-vscode-desc"
          }`}
        >
          {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />}
          <span className="truncate">
            {healingState?.active ? (
              <>
                🛠 Self-healing — {healingPhaseLabel(healingState.phase)}
                {healingNextActionLabel(healingState.phase) && ` · ${healingNextActionLabel(healingState.phase)}`}
                {` (Attempt ${healingState.attempt}/${healingState.maxAttempts})`}
                {healingState.failureDetail ? ` — ${healingState.failureDetail}` : ""}
              </>
            ) : healingState && !healingState.active ? (
              <>
                🛠 Self-healing — {healingState.message}
                {healingState.failureDetail ? ` (${healingState.failureDetail})` : ""}
              </>
            ) : (
              statusMessage || (isRunning ? "Agent running…" : "")
            )}
          </span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-vscode-border flex-shrink-0">
        {(["chat", "tools", "changes", "history", "settings"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setCurrentTab(tab)}
            className={`text-[11px] px-3 py-1.5 border-b-2 transition-colors ${
              currentTab === tab
                ? "border-vscode-text-link text-vscode-text-link"
                : "border-transparent text-vscode-desc hover:text-vscode-fg"
            }`}
          >
            {tab === "chat" ? "💬 Chat" : tab === "tools" ? `🔧 Tools (${toolEvents.length})` : tab === "changes" ? `📝 Changes (${fileChanges.length})` : tab === "history" ? "📋 History" : "⚙️ Settings"}
          </button>
        ))}
      </div>

      {/* MCP Approval Dialog */}
      {mcpApprovals.length > 0 && (
        <div className="border-b border-orange-600 bg-orange-950">
          {mcpApprovals.map((approval) => (
            <div key={approval.requestId} className="px-3 py-2">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[11px] font-bold text-orange-300">⚠️ MCP Tool Request</span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded font-semibold ${
                  approval.riskLevel === "high" ? "bg-red-800 text-red-200" :
                  approval.riskLevel === "medium" ? "bg-orange-800 text-orange-200" :
                  "bg-yellow-800 text-yellow-200"
                }`}>{approval.riskLevel.toUpperCase()}</span>
              </div>
              <div className="text-[11px] text-orange-100 space-y-0.5 mb-2">
                <div>Server: <span className="font-mono text-orange-200">{approval.serverName}</span></div>
                <div>Tool: <span className="font-mono text-orange-200">{approval.toolName}</span></div>
                {Object.keys(approval.arguments).length > 0 && (
                  <div>Args: <span className="font-mono text-orange-200">{JSON.stringify(approval.arguments)}</span></div>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleMCPApproval(approval.requestId, "approve")}
                  className="text-[11px] px-3 py-1 rounded font-medium bg-green-800 text-green-200 hover:bg-green-700"
                >
                  ✓ Approve
                </button>
                <button
                  onClick={() => handleMCPApproval(approval.requestId, "reject")}
                  className="text-[11px] px-3 py-1 rounded font-medium bg-red-800 text-red-200 hover:bg-red-700"
                >
                  ✗ Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {currentTab === "chat" && (
          <div className="flex flex-col h-full">
            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
              {messages.length === 0 && (
                <div className="text-center text-vscode-desc text-sm py-8">
                  Welcome to CodePilot AI! Enter a coding task to get started.
                </div>
              )}
              {messages.map((msg) => (
                <div key={msg.id} className={`text-sm ${msg.role === "user" ? "text-vscode-fg" : ""}`}>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-vscode-desc mb-1">
                    {msg.role === "user" ? "You" : msg.role === "assistant" ? "CodePilot" : "System"}
                  </div>
                  <div className={`px-3 py-2 rounded-lg whitespace-pre-wrap ${
                    msg.role === "user"
                      ? "bg-vscode-editor-bg border border-vscode-border"
                      : msg.role === "system"
                      ? "bg-red-950 border border-red-800 text-red-300"
                      : "bg-vscode-quote-bg"
                  }`}>
                    {msg.content}
                  </div>
                </div>
              ))}
              {/* Streaming text */}
              {streamingText && (
                <div className="text-sm">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-vscode-desc mb-1">CodePilot</div>
                  <div className="px-3 py-2 rounded-lg bg-vscode-quote-bg whitespace-pre-wrap">{streamingText}</div>
                </div>
              )}
              {/* Tool events inline */}
              {toolEvents.length > 0 && (
                <div className="space-y-1">
                  {toolEvents.map((evt) => (
                    <div key={evt.id} className="flex items-center gap-2 text-[11px] px-3 py-1 rounded bg-vscode-editor-bg border-l-2 border-vscode-text-link">
                      <span className={`w-2 h-2 rounded-full ${
                        evt.status === "started" ? "bg-yellow-400 animate-pulse" :
                        evt.status === "completed" ? "bg-green-400" : "bg-red-400"
                      }`} />
                      <span className="font-mono text-vscode-text-link font-semibold">{evt.name}</span>
                      <span className="text-vscode-desc">
                        {evt.status === "started" ? "running..." : evt.status === "completed" ? "done" : "failed"}
                      </span>
                      {evt.durationMs != null && <span className="text-vscode-desc">{evt.durationMs}ms</span>}
                    </div>
                  ))}
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Input */}
            <div className="px-3 py-2 border-t border-vscode-border flex-shrink-0">
              {/* Context chips — structured attachments, removable, never user text */}
              {contextToChips(composerContext).length > 0 && (
                <div className="flex flex-wrap gap-1 mb-2" data-testid="context-chips">
                  {contextToChips(composerContext).map((chip) => (
                    <span
                      key={chip.id}
                      title={chip.ref ?? chip.label}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-vscode-btn border border-vscode-input-border text-vscode-fg"
                    >
                      {chip.label}
                      <button
                        onClick={() => setComposerContext((prev) => removeContextEntry(prev, chip.id))}
                        className="ml-0.5 text-vscode-desc hover:text-vscode-fg"
                        title={`Remove ${chip.label}`}
                        aria-label={`Remove context ${chip.label}`}
                      >×</button>
                    </span>
                  ))}
                </div>
              )}
              {/* / slash command menu — real commands only, autocomplete on "/" */}
              {slashMenuOpen && (
                <div className="mb-2 rounded-lg border border-vscode-input-border bg-vscode-editor-bg overflow-hidden" data-testid="slash-menu">
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-vscode-desc">Commands</div>
                  {filterSlashCommands(((input.match(/\/(\w*)$/) ?? [])[1] ?? "")).map((c) => (
                    <button
                      key={c.command}
                      className="w-full text-left px-3 py-1.5 text-xs hover:bg-vscode-btn-hover"
                      onClick={() => { setSlashMenuOpen(false); setInput(`/${c.command} `); }}
                      title={c.description}
                    >
                      <span className="text-vscode-fg font-medium">/{c.command}</span>
                      <span className="ml-2 text-vscode-desc">{c.description}</span>
                    </button>
                  ))}
                </div>
              )}
              {/* @ mention menu — selecting an entry strips the "@" keyword
                  from the input so it is never submitted as user text */}
              {mentionMenuOpen && (
                <div className="mb-2 rounded-lg border border-vscode-input-border bg-vscode-editor-bg overflow-hidden" data-testid="mention-menu">
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-vscode-desc">Attach context</div>
                  <button className="w-full text-left px-3 py-1.5 text-xs hover:bg-vscode-btn-hover" onClick={() => { closeMentionMenuAndStripKeyword(); handleAttachFile(); }}>📄 Files…</button>
                  <button className="w-full text-left px-3 py-1.5 text-xs hover:bg-vscode-btn-hover" onClick={() => { closeMentionMenuAndStripKeyword(); handleAttachProblems(); }}>⚠️ Problems</button>
                  <button className="w-full text-left px-3 py-1.5 text-xs hover:bg-vscode-btn-hover" onClick={() => { closeMentionMenuAndStripKeyword(); handleAttachSelection(); }}>📝 Selection</button>
                  <button className="w-full text-left px-3 py-1.5 text-xs hover:bg-vscode-btn-hover" onClick={() => { closeMentionMenuAndStripKeyword(); handleAttachFolder(); }}>📁 Folder…</button>
                  <button className="w-full text-left px-3 py-1.5 text-xs hover:bg-vscode-btn-hover" onClick={closeMentionMenuAndStripKeyword}>✕ Cancel</button>
                </div>
              )}
              <div className="flex gap-2 items-end">
                <div className="flex gap-0.5">
                  <button onClick={handleAttachFile} className="px-1.5 py-2 rounded-lg text-[11px] text-vscode-desc border border-vscode-input-border hover:bg-vscode-btn-hover hover:text-vscode-fg" title="Attach file(s) from workspace">📄</button>
                  <button onClick={handleAttachFolder} className="px-1.5 py-2 rounded-lg text-[11px] text-vscode-desc border border-vscode-input-border hover:bg-vscode-btn-hover hover:text-vscode-fg" title="Attach folder">📁</button>
                  <button onClick={handleAttachUrl} className="px-1.5 py-2 rounded-lg text-[11px] text-vscode-desc border border-vscode-input-border hover:bg-vscode-btn-hover hover:text-vscode-fg" title="Attach URL">🔗</button>
                  <button onClick={handleAttachProblems} className="px-1.5 py-2 rounded-lg text-[11px] text-vscode-desc border border-vscode-input-border hover:bg-vscode-btn-hover hover:text-vscode-fg" title="Attach VS Code Problems">⚠️</button>
                </div>
                <textarea
                  value={input}
                  onChange={(e) => handleInputChanged(e.target.value)}
                  onBlur={() => { setMentionMenuOpen(false); setSlashMenuOpen(false); }}
                  onKeyDown={(e) => {
                    // Enter sends exactly once; Shift+Enter inserts a newline.
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      setMentionMenuOpen(false);
                      setSlashMenuOpen(false);
                      handleSend();
                    }
                  }}
                  placeholder="Describe what you want to do…  (/plan, /act, /clear, /help)"
                  aria-label="Chat message"
                  rows={2}
                  className="flex-1 text-sm px-3 py-2 rounded-lg border border-vscode-input-border bg-vscode-input-bg text-vscode-input-fg resize-none focus:outline-none focus:border-vscode-focus-border"
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || isRunning}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-vscode-btn-fg bg-vscode-btn hover:bg-vscode-btn-hover disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Send
                </button>
                {lastPrompt && !isRunning && (
                  <button
                    onClick={() => {
                      // Retry re-sends the original prompt only. It must NOT
                      // duplicate the user message or re-attach stale context.
                      setToolEvents([]);
                      setStreamingText("");
                      setIsRunning(true);
                      sendMessage("task/retry", buildRetryPayload(lastPrompt));
                    }}
                    className="px-3 py-2 rounded-lg text-sm font-medium text-vscode-btn-fg border border-vscode-input-border hover:bg-vscode-btn-hover"
                  >
                    ↻ Retry
                  </button>
                )}
                {!isRunning && (
                  <button
                    onClick={() => {
                      sendMessage("agent/heal", {
                        exitCode: 1,
                        stderr: "Agent requested self-healing",
                        diagnostics: [],
                        validateCommand: "echo validation",
                      });
                      setIsRunning(true);
                    }}
                    className="px-3 py-2 rounded-lg text-sm font-medium text-yellow-400 border border-yellow-600 hover:bg-yellow-900/30"
                  >
                    🔧 Heal
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {currentTab === "tools" && (
          <div className="p-3 overflow-y-auto h-full">
            {/* Real tool registry from the PolicyEngine + MCP manager */}
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold text-vscode-desc">
                Registered Tools ({toolRegistry.length})
              </span>
              <button
                onClick={() => sendMessage("tools/list", {})}
                aria-label="Refresh tool registry"
                className="text-[10px] px-2 py-0.5 rounded border border-vscode-input-border text-vscode-desc hover:text-vscode-fg"
              >
                Refresh
              </button>
            </div>
            <div className="space-y-1 mb-4">
              {toolRegistry.length === 0 ? (
                <div className="text-center text-vscode-desc text-xs py-2">
                  Registry unavailable (runtime not started).
                </div>
              ) : (
                toolRegistry.map((tool) => (
                  <div
                    key={`${tool.source}:${tool.name}`}
                    className="px-2 py-1.5 rounded bg-vscode-editor-bg border border-vscode-border"
                    title={tool.description || tool.name}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-vscode-fg font-semibold">{tool.name}</span>
                      <span
                        className={`text-[9px] px-1.5 py-0.5 rounded font-semibold ${
                          tool.permission === "auto" ? "bg-green-900 text-green-300"
                          : tool.permission === "blocked" ? "bg-red-900 text-red-300"
                          : "bg-yellow-900 text-yellow-300"
                        }`}
                      >
                        {tool.permission === "auto" ? "auto-approved" : tool.permission}
                      </span>
                      {tool.source === "mcp" && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-900 text-purple-300">
                          MCP{tool.serverName ? `: ${tool.serverName}` : ""}
                        </span>
                      )}
                    </div>
                    {tool.description && (
                      <div className="text-[10px] text-vscode-desc mt-0.5">{tool.description}</div>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Session activity */}
            <div className="text-[11px] font-semibold text-vscode-desc mb-2">Session Activity</div>
            {toolEvents.length === 0 ? (
              <div className="text-center text-vscode-desc text-sm py-2">No tool activity yet.</div>
            ) : (
              <div className="space-y-2">
                {toolEvents.map((evt) => (
                  <div key={evt.id} className="px-3 py-2 rounded bg-vscode-editor-bg border border-vscode-border">
                    <div className="flex items-center gap-2 text-sm">
                      <span className={`w-2 h-2 rounded-full ${
                        evt.status === "started" ? "bg-yellow-400" :
                        evt.status === "completed" ? "bg-green-400" : "bg-red-400"
                      }`} />
                      <span className="font-mono text-vscode-text-link">{evt.name}</span>
                      <span className="text-vscode-desc text-[11px]">
                        {evt.status} {evt.durationMs != null && `(${evt.durationMs}ms)`}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

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

        {currentTab === "history" && (
          <div className="p-3 overflow-y-auto h-full">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-semibold text-vscode-desc">Task History</span>
              <button
                onClick={() => sendMessage("session/list", {})}
                className="text-[10px] px-2 py-0.5 rounded border border-vscode-input-border text-vscode-desc hover:text-vscode-fg"
              >
                Refresh
              </button>
            </div>
            {sessions.length === 0 ? (
              <div className="text-center text-vscode-desc text-sm py-8">No task history yet.</div>
            ) : (
              <div className="space-y-2">
                {sessions.map((s) => (
                  <div key={s.id} className="px-3 py-2 rounded bg-vscode-editor-bg border border-vscode-border">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-vscode-fg font-mono">{s.title ?? s.id.slice(0, 8)}</span>
                      <span className="text-[10px] text-vscode-desc">
                        {s.updatedAt ? new Date(s.updatedAt).toLocaleString() : ""}
                      </span>
                    </div>
                    <div className="flex gap-2 mt-1">
                      <button
                        onClick={() => sendMessage("session/resume", { sessionId: s.id })}
                        className="text-[10px] px-2 py-0.5 rounded bg-vscode-btn text-vscode-btn-fg hover:bg-vscode-btn-hover"
                      >
                        Resume
                      </button>
                      <button
                        onClick={() => sendMessage("session/delete", { sessionId: s.id })}
                        className="text-[10px] px-2 py-0.5 rounded border border-red-800 text-red-400 hover:bg-red-900"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {currentTab === "settings" && (
          <div className="p-3 space-y-4 overflow-y-auto h-full">
            <div>
              <label className="block text-[11px] font-semibold text-vscode-desc mb-1">Provider</label>
              <select value={settings.provider} onChange={(e) => setSettings((s) => ({ ...s, provider: e.target.value }))}
                className="w-full text-sm px-2 py-1 rounded border border-vscode-input-border bg-vscode-input-bg text-vscode-input-fg">
                <option value="ollama">Ollama (Local)</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="google">Google Gemini</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-vscode-desc mb-1">Privacy Mode</label>
              <select value={settings.privacyMode} onChange={(e) => setSettings((s) => ({ ...s, privacyMode: e.target.value }))}
                className="w-full text-sm px-2 py-1 rounded border border-vscode-input-border bg-vscode-input-bg text-vscode-input-fg">
                <option value="local">Local Only — no data leaves machine</option>
                <option value="hybrid">Hybrid — cloud only for selected tasks</option>
                <option value="cloud">Cloud — uses API providers</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-vscode-desc mb-1">Temperature</label>
              <input type="number" min="0" max="2" step="0.1" value={settings.temperature}
                onChange={(e) => setSettings((s) => ({ ...s, temperature: parseFloat(e.target.value) }))}
                className="w-full text-sm px-2 py-1 rounded border border-vscode-input-border bg-vscode-input-bg text-vscode-input-fg" />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-vscode-desc mb-1">Base URL (Ollama)</label>
              <input type="text" value={settings.baseUrl}
                onChange={(e) => setSettings((s) => ({ ...s, baseUrl: e.target.value }))}
                className="w-full text-sm px-2 py-1 rounded border border-vscode-input-border bg-vscode-input-bg text-vscode-input-fg font-mono" />
            </div>

            {/* Auto-Approval Settings */}
            <div>
              <label className="block text-[11px] font-semibold text-vscode-desc mb-2">Auto-Approval</label>
              <div className="space-y-1.5">
                {([
                  ["readFiles", "Read files", "Auto-approve read_file, list_files, search"],
                  ["editFiles", "Edit files", "Auto-approve write_file, edit_file, apply_patch"],
                  ["executeCommands", "Execute commands", "Auto-approve bash/terminal"],
                  ["webFetch", "Web fetch", "Auto-approve web_fetch"],
                  ["mcpServers", "MCP servers", "Auto-approve MCP tool calls"],
                  ["browser", "Browser", "Auto-approve browser automation"],
                ] as const).map(([key, label, desc]) => (
                  <label key={key} className="flex items-start gap-2 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={autoApproval[key]}
                      onChange={(e) => handleAutoApprovalChange(key, e.target.checked)}
                      className="mt-0.5 accent-vscode-text-link"
                    />
                    <div>
                      <span className="text-[11px] text-vscode-fg group-hover:text-vscode-text-link">{label}</span>
                      <span className="text-[10px] text-vscode-desc ml-1">— {desc}</span>
                    </div>
                  </label>
                ))}
              </div>
              <div className="mt-2">
                <label className="text-[11px] text-vscode-desc">Max consecutive auto-approvals:</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={autoApproval.maxAutoApprovals}
                  onChange={(e) => handleAutoApprovalChange("maxAutoApprovals", parseInt(e.target.value) || 10)}
                  className="ml-2 w-16 text-[11px] px-1 py-0.5 rounded border border-vscode-input-border bg-vscode-input-bg text-vscode-input-fg"
                />
              </div>
            </div>

            {/* Rules */}
            <div>
              <label className="block text-[11px] font-semibold text-vscode-desc mb-2">Project Rules (.clinerules/)</label>
              <div className="text-[11px] text-vscode-desc space-y-1">
                <p>Rules are loaded from <code className="text-vscode-text-link">.clinerules/</code> in your workspace root.</p>
                <p>Supports nested rules (e.g. <code>.clinerules/backend/spring.md</code>).</p>
                <p>Global rules from <code>~/.clinerules/</code> are merged (project overrides global).</p>
                <p className="mt-2 text-[10px] text-vscode-desc">Rules influence agent instructions. They cannot bypass PolicyEngine or security controls.</p>
              </div>
              <button
                onClick={() => sendMessage("rules/reload", {})}
                className="mt-2 text-[10px] px-2 py-0.5 rounded border border-vscode-input-border text-vscode-desc hover:text-vscode-fg"
              >
                Reload Rules
              </button>
            </div>
          </div>
        )}
      </div>

      {/* NOTE: healing status is rendered by the single status component near
          the top of the chat (see reduceHealingState usage). The legacy
          duplicate progress bar was removed so every healing event updates
          exactly ONE status element with human-readable labels. */}

      {/* Status bar */}
      {/* Self-healing progress bar */}
      {healingState && healingState.active && (
        <div className="px-3 py-2 bg-vscode-editor-bg border-t border-vscode-border">
          <div className="flex items-center justify-between text-[10px] text-vscode-desc mb-1">
            <span>🔧 Self-healing: {healingState.phase}</span>
            <span>Attempt {healingState.attempt}/{healingState.maxAttempts}</span>
          </div>
          <div className="w-full h-1.5 bg-vscode-editor-bg rounded-full overflow-hidden">
            <div
              className="h-full bg-yellow-500 rounded-full transition-all"
              style={{ width: `${(healingState.attempt / healingState.maxAttempts) * 100}%` }}
            />
          </div>
          <div className="text-[10px] text-vscode-desc mt-1 truncate">{healingState.message}</div>
        </div>
      )}
      {healingState && !healingState.active && (
        <div className={`px-3 py-1 text-[10px] ${healingState.success ? "text-green-500" : "text-red-500"}`}>
          {healingState.success ? "✅" : "❌"} {healingState.message}
        </div>
      )}

      {/* Status bar */}
      <div className="flex items-center justify-between px-3 py-1 border-t border-vscode-border text-[10px] text-vscode-desc flex-shrink-0">
        <div className="flex items-center gap-2">
          <span>{isRunning ? "Agent running..." : "Ready"}</span>
          {usage && (
            <div className="flex items-center gap-1">
              <div className="w-16 h-1.5 bg-vscode-editor-bg rounded-full overflow-hidden">
                <div className="h-full bg-vscode-text-link rounded-full transition-all" style={{ width: `${Math.min(((usage.inputTokens + usage.outputTokens) / 128000) * 100, 100)}%` }} />
              </div>
              <span>{Math.round(((usage.inputTokens + usage.outputTokens) / 128000) * 100)}%</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          {usage && (
            <span className="text-vscode-desc">
              {(usage.inputTokens + usage.outputTokens).toLocaleString()} tokens
              {usage.totalCost != null && usage.totalCost > 0 && ` · $${usage.totalCost.toFixed(4)}`}
            </span>
          )}
          <span>{settings.provider} / {settings.model}</span>
        </div>
      </div>
    </div>
  );
}
