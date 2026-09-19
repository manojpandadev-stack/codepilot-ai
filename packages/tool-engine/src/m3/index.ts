/**
 * @codepilot/tool-engine — M3 production tool system (barrel)
 *
 * Strongly-typed contract, central registry, permission manager, audit
 * logging, controlled command execution, workspace boundary security, the
 * execution service (lifecycle/retry/timeout/cancellation), and the built-in
 * tool set.
 */

// ---- Contract ----
export type {
  ToolCategory,
  ToolPermissionLevel,
  ToolPermission,
  ToolSchema,
  ToolSchemaProperty,
  ToolProgress,
  ToolErrorCode,
  ToolError,
  ApprovalRequest,
  ApprovalDecision,
  ToolContext,
  ToolDefinition,
} from "./types.js";
export { toolError, isAbortLike } from "./types.js";

// ---- Lifecycle ----
export type {
  ToolExecutionStatus,
  ToolCorrelation,
  ToolExecution,
  ToolResult,
  ToolEvent,
  ToolEventListener,
} from "./lifecycle.js";
export { TERMINAL_STATUSES, isTerminal } from "./lifecycle.js";

// ---- Workspace boundary ----
export { WorkspaceBoundary } from "./workspace-boundary.js";
export type { PathResolution } from "./workspace-boundary.js";

// ---- Registry ----
export { ToolRegistry, validateAgainstSchema } from "./registry.js";
export type { RegistryEntry, ToolListFilter } from "./registry.js";

// ---- Permissions ----
export { ToolPermissionManager } from "./permission-manager.js";
export type {
  PermissionDecision,
  PermissionDecisionType,
  ToolPermissionRule,
  ToolPermissionManagerOptions,
} from "./permission-manager.js";

// ---- Audit ----
export { ToolAuditLogger, PersistentAuditLogger, redactSecrets } from "./audit-logger.js";
export type {
  ToolAuditEntry,
  ToolAuditSink,
  ToolAuditLoggerOptions,
  AuditStorageAdapter,
  PersistentAuditLoggerOptions,
} from "./audit-logger.js";

// ---- Typed terminal stream contract (shared event core) ----
export type {
  TerminalStreamChannel,
  TerminalStreamEvent,
  TerminalStreamCorrelation,
  TerminalStreamEventWithCorrelation,
  TerminalStreamSink,
  TerminalRetentionResult,
  TerminalTruncation,
} from "./terminal-stream.js";
export {
  TerminalSequence,
  TerminalRetentionBuffer,
  Utf8StreamDecoder,
  TRUNCATION_MARKER,
} from "./terminal-stream.js";

// ---- Command execution ----
export {
  CommandExecutionPolicy,
  CommandExecutionService,
  DANGEROUS_COMMANDS,
} from "./command-execution.js";
export type {
  CommandPolicyDecision,
  CommandExecutionPolicyConfig,
  CommandRequest,
  CommandOutput,
  CommandStreamListener,
} from "./command-execution.js";

// ---- Streaming shell executor (agent `bash` tool implementation) ----
export {
  createStreamingShellExecutor,
  combineShellOutput,
  truncateStreamingOutput,
  shellArgvForCommand,
  STREAMING_SHELL_MAX_OUTPUT_CHARS,
} from "./streaming-shell.js";
export type {
  StreamingShellContext,
  StreamingShellArgv,
  StreamingShellHooks,
} from "./streaming-shell.js";

// ---- Execution service ----
export { ToolExecutionService } from "./executor.js";
export type { ToolExecutorOptions, ExecuteOptions } from "./executor.js";

// ---- Built-in tools ----
export { createBuiltinTools, TerminalStore } from "./tools/index.js";
export type { BuiltinToolsConfig } from "./tools/index.js";
export {
  createFilesystemTools,
  createReadFileTool,
  createWriteFileTool,
  createEditFileTool,
  createDeleteFileTool,
  createMoveFileTool,
  atomicWrite,
  readCapped,
} from "./tools/filesystem.js";
export {
  createSearchTools,
  createSearchFilesTool,
  createSearchTextTool,
  globToRegex,
} from "./tools/search.js";
export {
  createDirectoryTools,
  createListDirectoryTool,
  createCreateDirectoryTool,
} from "./tools/directory.js";
export {
  createGitTools,
  createGitStatusTool,
  createGitDiffTool,
} from "./tools/git.js";
export { createAskUserTool } from "./tools/interaction.js";
export type { AskUserInput } from "./tools/interaction.js";
export {
  createCommandTools,
  createExecuteCommandTool,
  createTerminalOutputTool,
  createKillProcessTool,
  DEFAULT_COMMAND_TIMEOUT_MS,
} from "./tools/command.js";
export type { ExecuteCommandInput, TerminalRecord } from "./tools/command.js";
