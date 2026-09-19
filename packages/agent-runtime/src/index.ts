/**
 * @codepilot/agent-runtime
 *
 * CodePilot-owned agent runtime: native agent engine, CodePilot LLM layer,
 * lifecycle management, tool wiring, event streaming, and session management.
 */

// ---- Core agent implementations ----
export { CodePilotAgent } from "./agent.js";
export type { AgentTool, AgentUsage, AgentMessage } from "./native/types.js";
export { createTool } from "./native/types.js";
export {
  CodePilotRuntime,
  discoverOllamaModels,
  checkOllamaHealth,
  toNativeProviderId,
  isRemoteProvider,
} from "./runtime.js";
export type { ModelCapability } from "./runtime.js";

// ---- Write-tool staging helpers ----
export {
  resolveWorkspacePath,
  applyEditorOperation,
  parseEditorInput,
  parseApplyPatchInput,
  formatStagedResult,
  MAX_PROPOSED_FILE_BYTES,
} from "./write-tools.js";
export type {
  WriteProposal,
  ParseResult,
  EditorOperationResult,
  ResolvedPathResult,
} from "./write-tools.js";

// ---- Factory ----
export { createCodePilotRuntime } from "./factory.js";

// ---- Model-facing builtin tools (native callable set) ----
export {
  createCodePilotBuiltinTools,
  createBuiltinTools,
  CODEPILOT_MODEL_TOOL_NAMES,
} from "./builtin-tools.js";

// ---- Multi-agent orchestrator ----
export { MultiAgentOrchestrator, TaskDAG } from "./orchestrator.js";
export type {
  AgentRole,
  TaskStatus,
  TaskNode,
  OrchestratorEvent,
} from "./orchestrator.js";

// ---- Self-healing ----
export {
  SelfHealingEngine,
  healingEventToAgentEvent,
  createCommandValidator,
  classifyError,
  RecoveryManager,
} from "./self-healing.js";
export type {
  HealingEvent,
  HealingEventType,
  HealingEventListener,
  HealingResult,
  RepairAttempt,
  ValidationResult,
  SelfHealingConfig,
  ValidationRunner,
  RepairDiagnoser,
  RepairApplier,
  ErrorCategory,
  ErrorClassification,
  RecoveryManagerConfig,
  RecoveryRecord,
} from "./self-healing.js";

// ---- Self-healing M10: loop guard ----
export {
  FailureMemory,
  failureSignature,
  healWithLoopGuard,
} from "./m10-loop-guard.js";
export type {
  FailureRecord,
  LoopGuardResult,
  LoopGuardOptions,
} from "./m10-loop-guard.js";

// ---- Task persistence M12 ----
export { TaskStore, redactForPersistence } from "./m12-task-store.js";
export type {
  PersistedTask,
  PersistedTaskStatus,
  TaskStoreOptions,
  PersistedToolCall,
  PersistedConversationMessage,
} from "./m12-task-store.js";
// ---- Per-task persistence serialization (M12 v4) ----
export { TaskPersistenceQueue } from "./task-persistence-queue.js";
export type { TaskPersistenceOutcome } from "./task-persistence-queue.js";
// ---- Run conversation capture (M12 v4, pure) ----
export {
  createRunCapture,
  appendCaptureText,
  recordCaptureToolUse,
  recordCaptureToolResult,
  composeRunBlocks,
  isCaptureEmpty,
  CaptureFlushScheduler,
  DEFAULT_MAX_CAPTURED_TEXT,
  DEFAULT_MAX_CAPTURED_INPUT,
  DEFAULT_MAX_CAPTURED_RESULT,
} from "./conversation-capture.js";
export type {
  CapturedBlocks,
  CapturedToolResult,
  RunCaptureState,
} from "./conversation-capture.js";

// ---- Verbatim resume (M12 v2) ----
export {
  buildInitialMessages,
  classifyResumeFidelity,
  planProviderRestore,
  selectContinuationMessages,
  selectContinuationChain,
  trimTrailingIncompleteToolExchange,
  MAX_TURN_CHAIN_TASKS,
} from "./resume.js";
export type {
  ResumeWireMessage,
  ResumeFidelity,
  ResumeFidelityInfo,
  ResumeProviderPlan,
  ContinuationSelectOptions,
  ContinuationChainOptions,
  WireBlock,
} from "./resume.js";

// ---- Context compaction (M12 v3) ----
export {
  CompactionEngine,
  PrivacyViolationError,
} from "./compaction-engine.js";
export type {
  CompactionOutcome,
  CompactionEngineOptions,
} from "./compaction-engine.js";
export {
  summarizeConversation,
  validateSummaryOutput,
  buildSummaryPrompt,
  assertSummarizerPrivacyAllowed,
} from "./compaction-summarizer.js";
export type { SummarizerConfig, SummarizeResult } from "./compaction-summarizer.js";
export {
  estimateConversationTokens,
  estimateEntryTokens,
  evaluateCompactionNeed,
  classifyContextPressure,
  resolveContextWindowTokens,
  CHARS_PER_TOKEN,
  FALLBACK_CONTEXT_WINDOW_TOKENS,
} from "./compaction-tokens.js";
export type { ContextPressure, CompactionZone } from "./compaction-tokens.js";
export { validateConversationProtocol, safeCompactionBoundary } from "./compaction-protocol.js";
export type { ProtocolIssue, ProtocolValidationResult } from "./compaction-protocol.js";
export type {
  CompactionSummary,
  CompactionArtifact,
  CompactionMode,
} from "./compaction-types.js";

// ---- Multi-agent file locks M14 ----
export { FileLockRegistry, FileConflictError } from "./m14-file-locks.js";

// ---- CLI / headless M16 ----
export {
  CliRunner,
  parseCliCommand,
  cliHelpText,
  CLI_VERSION,
} from "./m16-cli-headless.js";
export type {
  CliExitCode,
  CliRunResult,
  CliRunnerOptions,
  ParsedCliCommand,
} from "./m16-cli-headless.js";

// ---- Scheduler M17 ----
export { TaskScheduler, nextRunAt } from "./m17-scheduler.js";
export type {
  ScheduleDefinition,
  ScheduleKind,
  MissedRunPolicy,
  ScheduleRunRecord,
  ScheduleRunner,
  RunStatus,
  SchedulerOptions,
} from "./m17-scheduler.js";

// ---- M1: State machine ----
export {
  AgentStateMachine,
  InvalidStateTransitionError,
  isTerminalState,
  isCancellableState,
  stateMachineStateToRuntimeStatus,
} from "./state-machine.js";
export type {
  AgentState,
  StateTransitionEvent,
  StateTransitionListener,
} from "./state-machine.js";

// ---- M1: Cancellation & retry ----
export {
  CancellationSource,
  CancellationError,
  TimeoutManager,
  withTimeout,
  withRetry,
  isTransientError,
} from "./cancellation.js";
export type {
  CancellationToken,
  CancellationListener,
  RetryPolicyOptions,
  RetryAttempt,
  RetryObserver,
} from "./cancellation.js";

// ---- Shared types ----
export type {
  CodePilotAgentConfig,
  CodePilotRuntimeOptions,
  AgentEvent,
  AgentEventListener,
  AgentRuntimeState,
  EventCorrelation,
  RuntimeError,
  RuntimeErrorCode,
  RuntimeErrorCategory,
  RunMetrics,
} from "./types.js";
