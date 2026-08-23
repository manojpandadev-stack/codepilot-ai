/**
 * @codepilot/shared
 *
 * Common types, constants, and utilities for the CodePilot AI platform.
 * Defines CodePilot-specific types and re-exports what we need from Cline SDK.
 */

// ============================================================================
// CodePilot-specific types
// ============================================================================

/**
 * Privacy modes for the application.
 */
export type PrivacyMode = "local" | "hybrid" | "cloud";

/**
 * Extended agent modes beyond the Cline defaults.
 */
export type CodePilotAgentMode = "ask" | "plan" | "act" | "review" | "auto";

/**
 * Task statuses for the task DAG.
 */
export type TaskStatus =
  | "pending"
  | "running"
  | "waiting"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Task types in the multi-agent orchestration.
 */
export type TaskType =
  | "analyze"
  | "plan"
  | "implement"
  | "test"
  | "review"
  | "security"
  | "document"
  | "fix";

/**
 * Agent roles in the multi-agent team.
 */
export type AgentRole =
  | "orchestrator"
  | "architect"
  | "coder"
  | "tester"
  | "reviewer"
  | "security"
  | "documenter";

/**
 * A task in the task DAG.
 */
export interface TaskDAGNode {
  id: string;
  parentTaskId: string | null;
  type: TaskType;
  agent: AgentRole;
  description: string;
  dependencies: string[];
  status: TaskStatus;
  priority: number;
  files: string[];
  result: string | null;
  errors: string[];
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

/**
 * Tool categories for governance.
 */
export type ToolCategory =
  "read" | "write" | "execute" | "network" | "git" | "mcp" | "system";

/**
 * Tool permission levels.
 */
export type ToolPermission = "auto" | "approval" | "blocked";

/**
 * A tool permission policy entry.
 */
export interface ToolPermissionPolicy {
  toolName: string;
  category: ToolCategory;
  permission: ToolPermission;
  description?: string;
}

/**
 * File change tracking.
 */
export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  diff?: string;
}

/**
 * Checkpoint metadata.
 */
export interface CheckpointInfo {
  id: string;
  gitCommitHash: string | null;
  files: string[];
  timestamp: number;
  taskId: string | null;
  description: string;
}

/**
 * Provider configuration for a model provider.
 */
export interface ProviderConfig {
  id: string;
  name: string;
  type: "local" | "cloud";
  baseUrl?: string;
  apiKeyRequired: boolean;
  models: ModelInfo[];
  connected: boolean;
}

/**
 * Model information.
 */
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  capabilities: string[];
}

/**
 * Detailed model capability metadata.
 */
export interface ModelCapability {
  model: string;
  provider: string;
  toolCalling: boolean;
  streaming: boolean;
  reasoning: boolean;
  vision: boolean;
  contextWindow: number;
  recommendedFor: string[];
  estimatedMemoryMB?: number;
  codingCapability: "excellent" | "good" | "fair" | "poor";
}

/**
 * Session metadata.
 */
export interface SessionInfo {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  mode: CodePilotAgentMode;
  model: string;
  provider: string;
  privacyMode: PrivacyMode;
  fileChanges: number;
  tokensUsed: number;
}

/**
 * Agent run metrics for observability.
 */
export interface AgentRunMetrics {
  durationMs: number;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  toolCalls: Record<string, number>;
  filesChanged: string[];
  testsRun: number;
  testsPassed: number;
  testsFailed: number;
}

/**
 * WebSocket message types for webview communication.
 */
export type WebviewMessageType =
  | "chat/send"
  | "chat/response"
  | "chat/stream_delta"
  | "agent/start"
  | "agent/stop"
  | "agent/status"
  | "agent/event"
  | "tool/request_approval"
  | "tool/approval_result"
  | "tool/started"
  | "tool/completed"
  | "file/changed"
  | "model/list"
  | "model/select"
  | "provider/list"
  | "provider/configure"
  | "settings/get"
  | "settings/set"
  | "settings/error"
  | "session/list"
  | "session/list_result"
  | "session/open"
  | "session/delete"
  | "session/resume"
  | "session/rename"
  | "task/retry"
  | "diff/create"
  | "diff/created"
  | "diff/result"
  | "diff/status"
  | "diff/accept"
  | "diff/reject"
  | "diff/accept_all"
  | "diff/reject_all"
  | "diff/rollback"
  | "agent/approval_needed"
  | "agent/approval_resolved"
  | "agent/file_changed"
  | "mcp/approval_required"
  | "mcp/approval_response"
  | "mcp/tools/list"
  | "mcp/tools/list_result"
  | "mcp/servers/list"
  | "mcp/servers/list_result"
  | "checkpoint/create"
  | "checkpoint/restore"
  | "checkpoint/compare"
  | "git/status"
  | "git/diff"
  | "context/search"
  | "memory/get"
  | "memory/set"
  | "session/deleted"
  | "session/renamed"
  | "rules/reload"
  | "rules/list"
  | "tools/list"
  | "tools/list_result"
  | "agent/heal"
  | "healing/started"
  | "healing/progress"
  | "healing/succeeded"
  | "healing/failed"
  | "healing/exhausted"
  | "recovery/classified"
  | "recovery/attempt"
  | "recovery/succeeded"
  | "recovery/exhausted"
  | "error"
  | "state/update"
  | "context/filePicker"
  | "context/folderPicker"
  | "context/problems"
  | "context/selection"
  | "context/result";

/**
 * A message between the extension host and the webview.
 */
export interface WebviewMessage<T = unknown> {
  type: WebviewMessageType;
  id: string;
  payload: T;
  timestamp: number;
}

/**
 * Tool event for streaming to the UI.
 */
export interface ToolEvent {
  toolCallId: string;
  toolName: string;
  status: "started" | "completed" | "failed";
  input?: unknown;
  output?: unknown;
  error?: string;
  durationMs?: number;
}

/**
 * Terminal command execution result.
 */
export interface TerminalResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  command: string;
}

// ============================================================================
// Constants
// ============================================================================

export const EXTENSION_ID = "codepilot.codepilot-ai";
export const EXTENSION_NAME = "CodePilot AI";
export const WEBVIEW_ID = "codepilot.chat";

export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";
export const OLLAMA_API_TAGS = "/api/tags";
export const OLLAMA_API_CHAT = "/api/chat";

export const MAX_CONTEXT_TOKENS_DEFAULT = 128_000;
export const DEFAULT_MAX_ITERATIONS = 50;
export const DEFAULT_TEMPERATURE = 0.7;

export const DEFAULT_TOOL_POLICIES: Record<string, ToolPermission> = {
  // --- Read tools (auto-approve) ---
  read_files: "auto",
  read_file: "auto",
  search: "auto",
  search_codebase: "auto",
  grep: "auto",
  git_diff: "auto",
  git_status: "auto",
  git_log: "auto",
  git_show: "auto",
  list_directory: "auto",
  list_files: "auto",
  ask_question: "auto",
  skills: "auto",
  // --- Write tools (require approval / ChangeSet) ---
  write_file: "approval",
  create_file: "approval",
  editor: "approval",
  apply_patch: "approval",
  delete_file: "approval",
  rename_file: "approval",
  move_file: "approval",
  // --- Execute tools (require approval) ---
  bash: "approval",
  run_commands: "approval",
  terminal: "approval",
  // --- Network tools (require approval) ---
  web_fetch: "approval",
  fetch: "approval",
  fetch_web_content: "approval",
  web_search: "approval",
  // --- Git mutation tools (require approval) ---
  git_commit: "approval",
  git_push: "approval",
  git_pull: "approval",
  git_checkout: "approval",
  git_merge: "approval",
  git_rebase: "approval",
  git_reset: "approval",
  git_stash: "approval",
};

/**
 * Registered `codepilot.*` configuration keys (must match
 * apps/vscode-extension/package.json → contributes.configuration.properties).
 * The `settings/set` handler rejects any key not in this list so we never
 * write an unregistered configuration key into VS Code settings.
 */
export const ALLOWED_SETTINGS_KEYS: readonly string[] = [
  // Core
  "provider",
  "model",
  "privacyMode",
  "agentMode",
  "maxIterations",
  // Ollama
  "localAI.ollama.baseUrl",
  "localAI.ollama.model",
  "localAI.ollama.contextLength",
  "localAI.ollama.temperature",
  "localAI.ollama.numPredict",
  "localAI.ollama.keepAlive",
  // Auto-approval (individual + composite object from the webview)
  "autoApproval",
  "autoApproval.read",
  "autoApproval.write",
  "autoApproval.terminal",
  "autoApproval.git",
  // Telemetry
  "telemetry.enabled",
];

/**
 * True when a `settings/set` key is a registered CodePilot configuration key.
 * Also accepts the fully-qualified `codepilot.<key>` form.
 */
export function isAllowedSettingKey(key: string): boolean {
  const normalized = key.startsWith("codepilot.")
    ? key.slice("codepilot.".length)
    : key;
  return ALLOWED_SETTINGS_KEYS.includes(normalized);
}

export const BLOCKED_COMMANDS = [
  "rm -rf /",
  "rm -rf /*",
  "mkfs",
  "dd if=/dev/zero",
  "> /dev/sda",
  "format",
  ":(){:|:&};:",
];

export const IGNORED_INDEX_PATHS = [
  ".git",
  "node_modules",
  "target",
  "build",
  "dist",
  ".env",
  ".env.local",
  "__pycache__",
  ".DS_Store",
  "*.pyc",
  "vendor",
  ".gradle",
  ".idea",
  ".vscode",
];

export const SUPPORTED_LANGUAGES = [
  "java",
  "typescript",
  "javascript",
  "python",
  "sql",
  "json",
  "yaml",
  "markdown",
  "xml",
  "html",
  "css",
  "rust",
  "go",
  "c",
];

// ============================================================================
// Auto-Approval Settings
// ============================================================================

export interface AutoApprovalSettings {
  /** Auto-approve read-only tools (read_file, list_files, search, git_status, etc.) */
  readFiles: boolean;
  /** Auto-approve file edit/write tools (write_file, edit_file, apply_patch) */
  editFiles: boolean;
  /** Auto-approve terminal command execution */
  executeCommands: boolean;
  /** Auto-approve web fetch */
  webFetch: boolean;
  /** Auto-approve MCP server tool calls */
  mcpServers: boolean;
  /** Auto-approve browser automation */
  browser: boolean;
  /** Maximum consecutive auto-approvals before requiring manual approval */
  maxAutoApprovals: number;
}

export const DEFAULT_AUTO_APPROVAL: AutoApprovalSettings = {
  readFiles: true,
  editFiles: false,
  executeCommands: false,
  webFetch: false,
  mcpServers: false,
  browser: false,
  maxAutoApprovals: 10,
};

/** Convert AutoApprovalSettings to tool permission map for PolicyEngine. */
export function autoApprovalToToolPermissions(
  settings: AutoApprovalSettings,
): Record<string, ToolPermission> {
  const result: Record<string, ToolPermission> = {};

  // Read tools
  const readTools = [
    "read_files",
    "search",
    "list_directory",
    "git_status",
    "git_diff",
    "git_log",
    "git_show",
  ];
  for (const tool of readTools) {
    result[tool] = settings.readFiles ? "auto" : "approval";
  }

  // Write/edit tools
  const editTools = ["write_file", "apply_patch", "editor", "delete_file"];
  for (const tool of editTools) {
    result[tool] = settings.editFiles ? "auto" : "approval";
  }

  // Execute tools
  const execTools = ["bash", "run_commands"];
  for (const tool of execTools) {
    result[tool] = settings.executeCommands ? "auto" : "approval";
  }

  // Web tools
  const webTools = ["web_fetch", "web_search"];
  for (const tool of webTools) {
    result[tool] = settings.webFetch ? "auto" : "approval";
  }

  return result;
}

// ============================================================================
// Task Status
// ============================================================================

export interface TaskSession {
  id: string;
  title: string;
  workspace: string;
  status: TaskStatus;
  mode: string;
  model: string;
  provider: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  toolCallCount: number;
  filesChanged: string[];
}

// ============================================================================
// Project Rules
// ============================================================================

export interface ProjectRule {
  id: string;
  pattern: string; // glob pattern for file paths
  content: string;
  source: "project" | "global" | "path-specific";
  enabled: boolean;
  filePath: string;
}

// ============================================================================
// Self-Healing
// ============================================================================

/** Healing event types for structured self-healing progress. */
export type HealingEventType =
  | "validation_started"
  | "validation_passed"
  | "validation_failed"
  | "diagnosis_started"
  | "diagnosis_completed"
  | "repair_started"
  | "repair_completed"
  | "repair_failed"
  | "healing_exhausted"
  | "healing_succeeded";

/** A healing event emitted during the self-healing cycle. */
export interface HealingEvent {
  type: HealingEventType;
  attempt: number;
  maxAttempts: number;
  timestamp: number;
  data?: Record<string, unknown>;
}

/** Validation result for the self-healing loop. */
export interface ValidationResult {
  passed: boolean;
  command?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  diagnostics?: string[];
  durationMs?: number;
}

/** A single repair attempt record. */
export interface RepairAttempt {
  attemptNumber: number;
  timestamp: number;
  diagnosis: string;
  repairDescription: string;
  filesChanged: string[];
  validation: ValidationResult;
  success: boolean;
  error?: string;
}

/** Complete healing result. */
export interface HealingResult {
  healed: boolean;
  attempts: number;
  maxAttempts: number;
  repairHistory: RepairAttempt[];
  originalFailure: ValidationResult;
  finalValidation: ValidationResult;
  durationMs: number;
  cancelled: boolean;
}

/** Configuration for self-healing. */
export interface SelfHealingConfig {
  maxAttempts?: number;
  attemptTimeoutMs?: number;
  requireApproval?: boolean;
  workspaceRoot: string;
  isPlanMode?: boolean;
}

/** Webview message types for self-healing progress. */
export type SelfHealingWebviewType =
  | "healing/started"
  | "healing/progress"
  | "healing/succeeded"
  | "healing/failed"
  | "healing/exhausted";
// ============================================================================
// Composer Context Architecture
// ============================================================================
//
// Context attachments (files, folders, diagnostics, selection, URLs) are
// STRUCTURED METADATA sent alongside the user's message — never injected into
// the visible user text. The webview renders them as removable chips; the
// extension host resolves them into agent-ready context blocks.

/** A file attached as context (metadata only — content resolved host-side). */
export interface FileContext {
  id: string;
  /** Workspace-relative POSIX-style path, e.g. "src/main.ts". */
  relativePath: string;
  name: string;
  sizeBytes?: number;
  /** Binary files are reported as metadata, never inlined into prompts. */
  isBinary?: boolean;
}

/** A folder attached as context. */
export interface FolderContext {
  id: string;
  relativePath: string;
  name: string;
}

/** A URL attached as context (fetched host-side with SSRF protection). */
export interface UrlContext {
  id: string;
  url: string;
}

export type DiagnosticSeverityLabel =
  "Error" | "Warning" | "Information" | "Hint";

/** One normalized VS Code diagnostic (plain serializable shape). */
export interface DiagnosticContextItem {
  file: string;
  line: number;
  column: number;
  severity: DiagnosticSeverityLabel;
  message: string;
  source?: string;
  code?: string | number;
}

/** Workspace or active-file diagnostics snapshot. */
export interface DiagnosticsContextPayload {
  scope: "workspace" | "activeFile";
  items: DiagnosticContextItem[];
}

/** Selected code in the active editor. */
export interface SelectionContextPayload {
  filePath: string;
  startLine: number;
  endLine: number;
}

/**
 * Everything the composer has attached for the NEXT message.
 * Sent once per submission as metadata; never rendered as user text.
 */
export interface ComposerContext {
  files: FileContext[];
  folders: FolderContext[];
  urls: UrlContext[];
  diagnostics?: DiagnosticsContextPayload | null;
  selection?: SelectionContextPayload | null;
}

/** Payload returned by the host for any context/* request. */
/** Payload returned by the host for any context/* request. */
export interface ContextResultPayload {
  kind: "filePicker" | "folderPicker" | "problems" | "selection";
  files?: FileContext[];
  folders?: FolderContext[];
  diagnostics?: DiagnosticsContextPayload | null;
  selection?: SelectionContextPayload | null;
  error?: string;
}

/** chat/send payload: visible text + separate structured context. */
export interface ContextResultPayload {
  kind: "filePicker" | "folderPicker" | "problems" | "selection";
  files?: FileContext[];
  folders?: FolderContext[];
  diagnostics?: DiagnosticsContextPayload | null;
  selection?: SelectionContextPayload | null;
  error?: string;
}
/** chat/send payload: visible text + separate structured context. */
export interface ChatSendPayload {
  text: string;
  mode?: CodePilotAgentMode;
  context?: Partial<ComposerContext>;
}

// New message types for the composer context workflow.
export type ContextWebviewMessageType =
  | "context/filePicker"
  | "context/folderPicker"
  | "context/problems"
  | "context/selection"
  | "context/result";

// ============================================================================
// Pure context helpers (unit-tested, no vscode dependency)
// ============================================================================

const BINARY_FILE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".svgz",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".rar",
  ".7z",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".o",
  ".a",
  ".jar",
  ".class",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".avi",
  ".mov",
  ".wav",
  ".flac",
  ".db",
  ".sqlite",
  ".sqlite3",
  ".pyc",
]);

/** True when a filename looks like a binary asset that must not be inlined. */
export function isLikelyBinaryFile(fileName: string): boolean {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return false;
  return BINARY_FILE_EXTENSIONS.has(fileName.slice(dot).toLowerCase());
}

/**
 * Convert an absolute fsPath to a workspace-relative path.
 * Returns null when the path is outside the workspace root (rejected —
 * workspace boundaries are enforced, not silently escaped).
 */
export function toRelativeWorkspacePath(
  rootFsPath: string,
  fsPath: string,
): string | null {
  const normRoot = rootFsPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const normPath = fsPath.replace(/\\/g, "/");
  if (!normPath.startsWith(normRoot + "/") && normPath !== normRoot)
    return null;
  return normPath.slice(normRoot.length + 1) || "";
}

/**
 * Map a raw vscode.DiagnosticSeverity numeric value to a label.
 * VS Code enum: Error=0, Warning=1, Information=2, Hint=8.
 */
export function mapVsCodeSeverity(severity: number): DiagnosticSeverityLabel {
  switch (severity) {
    case 0:
      return "Error";
    case 1:
      return "Warning";
    case 2:
      return "Information";
    case 8:
      return "Hint";
    default:
      return "Information";
  }
}

/** Raw diagnostic shape coming from the extension host before normalization. */
export interface RawDiagnosticInput {
  file: string;
  line: number;
  column: number;
  severity: number;
  message: string;
  source?: string;
  code?: string | number;
}

/** Normalize raw diagnostics into structured context items (dedup included). */
export function toDiagnosticItems(
  raw: RawDiagnosticInput[],
): DiagnosticContextItem[] {
  const seen = new Set<string>();
  const items: DiagnosticContextItem[] = [];
  for (const d of raw) {
    if (!d || typeof d.message !== "string" || !d.file) continue;
    const key = `${d.file}:${d.line}:${d.column}:${d.severity}:${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      file: d.file,
      line: d.line,
      column: d.column,
      severity: mapVsCodeSeverity(d.severity),
      message: d.message,
      source: typeof d.source === "string" ? d.source : undefined,
      code: d.code !== undefined ? d.code : undefined,
    });
  }
  return items;
}

/** One human-readable diagnostic line, e.g. `src/a.ts:12:5 [ERROR] Cannot find name 'x' (ts)`. */
export function formatDiagnosticLine(item: DiagnosticContextItem): string {
  const sev =
    item.severity === "Error"
      ? "ERROR"
      : item.severity === "Warning"
        ? "WARN"
        : item.severity === "Hint"
          ? "HINT"
          : "INFO";
  const src = item.source ? ` (${item.source})` : "";
  return `${item.file}:${item.line}:${item.column} [${sev}] ${item.message}${src}`;
}

/**
 * Format a diagnostics snapshot as an agent-ready context block.
 * Zero diagnostics produce an explicit clean-state block (never an error).
 */
export function formatDiagnosticsForAgent(
  diagnostics: DiagnosticsContextPayload,
): string {
  const scope = diagnostics.scope === "workspace" ? "workspace" : "active file";
  if (diagnostics.items.length === 0) {
    return `VS Code Problems (${scope}): no problems detected. The workspace currently has zero errors, warnings, information messages, or hints.`;
  }
  // Errors first, then warnings; cap to keep prompts bounded.
  const order: Record<DiagnosticSeverityLabel, number> = {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3,
  };
  const sorted = [...diagnostics.items].sort(
    (a, b) => order[a.severity] - order[b.severity],
  );
  const MAX_DIAGNOSTICS = 200;
  const capped = sorted.slice(0, MAX_DIAGNOSTICS);
  const header = `VS Code Problems (${scope}) — ${diagnostics.items.length} total:`;
  const lines = capped.map(formatDiagnosticLine);
  const truncNote =
    sorted.length > MAX_DIAGNOSTICS
      ? `\n... and ${sorted.length - MAX_DIAGNOSTICS} more (truncated)`
      : "";
  return `${header}\n${lines.join("\n")}${truncNote}`;
}

// ============================================================================
// Self-healing UI labels (pure, unit-tested)
// ============================================================================

/** Human-readable label for a HealingEventType / healing phase id. */
export function healingPhaseLabel(phase: string): string {
  switch (phase) {
    case "validation_started":
      return "Running validation";
    case "validation_passed":
      return "Validation passed";
    case "validation_failed":
      return "Validation failed";
    case "diagnosis_started":
      return "Diagnosis started";
    case "diagnosis_completed":
      return "Diagnosis completed";
    case "repair_started":
      return "Repairing";
    case "repair_completed":
      return "Repair completed";
    case "repair_failed":
      return "Repair failed";
    case "healing_succeeded":
      return "Healed";
    case "healing_exhausted":
      return "Attempts exhausted";
    default:
      return phase;
  }
}

/** The concrete next action shown under a healing phase. */
export function healingNextActionLabel(phase: string): string {
  switch (phase) {
    case "validation_started":
      return "Validating changes…";
    case "validation_passed":
      return "All checks green.";
    case "validation_failed":
      return "Analyzing failure…";
    case "diagnosis_started":
      return "Analyzing failure…";
    case "diagnosis_completed":
      return "Preparing repair…";
    case "repair_started":
      return "Applying fix…";
    case "repair_completed":
      return "Re-running validation…";
    case "repair_failed":
      return "Analyzing repair failure…";
    default:
      return "";
  }
}

/** A one-line description of a validation failure for display in chat/UI. */
export function describeValidationFailure(input: {
  exitCode?: number;
  command?: string;
  stderr?: string;
  stdout?: string;
}): string {
  const cmd = input.command ? `\nCommand: ${input.command}` : "";
  const code = input.exitCode !== undefined ? ` (exit ${input.exitCode})` : "";
  const errText = (input.stderr ?? "").trim();
  const outText = (input.stdout ?? "").trim();
  const detail = errText || outText;
  const excerpt = detail
    ? `\nFailure:\n${detail.split("\n").slice(0, 10).join("\n").slice(0, 1000)}`
    : "";
  return `Validation failed${code}.${cmd}${excerpt}`;
}
