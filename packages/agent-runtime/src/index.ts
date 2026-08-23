/**
 * @codepilot/agent-runtime
 *
 * Core agent runtime integration wrapping ClineCore and the Cline AgentRuntime.
 * Provides CodePilot-specific lifecycle management, tool wiring, event streaming,
 * and session management.
 */

export { CodePilotAgent } from "./agent.js";
export { CodePilotRuntime, discoverOllamaModels } from "./runtime.js";
export type { ModelCapability } from "./runtime.js";
export { mapCoreEvent } from "./core-event-mapper.js";
export type { MappedCoreEvent, MappedUsage } from "./core-event-mapper.js";
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
export { createCodePilotRuntime } from "./factory.js";
export { MultiAgentOrchestrator, TaskDAG } from "./orchestrator.js";
export type {
  AgentRole,
  TaskStatus,
  TaskNode,
  OrchestratorEvent,
} from "./orchestrator.js";
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
export type {
  CodePilotAgentConfig,
  CodePilotRuntimeOptions,
  AgentEvent,
  AgentEventListener,
  AgentRuntimeState,
} from "./types.js";
