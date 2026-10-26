import type { PrivacyMode, CodePilotAgentMode } from "@codepilot/shared";
import type { AgentState } from "./state-machine.js";
import type { TaskPlan } from "./task-plan.js";
// CodePilot-owned contracts (native engine types)
export type { AgentTool, AgentUsage, AgentMessage } from "./native/types.js";
import type { AgentTool, AgentUsage, AgentMessage } from "./native/types.js";

/**
 * Configuration for the CodePilot agent runtime.
 */
export interface CodePilotAgentConfig {
  providerId: string;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  workspaceRoot: string;
  privacyMode: PrivacyMode;
  agentMode: CodePilotAgentMode;
  maxIterations?: number;
  temperature?: number;
  systemPrompt?: string;
  /**
   * H2 credential boundary: scrub secret-shaped spans from tool results
   * before they persist into the next provider request. Unset → the
   * canonical provider classification applies (isRemoteProvider): remote
   * providers are redacted, local providers pass output through verbatim.
   */
  redactToolResults?: boolean;
  /**
   * Selected model's context window (tokens). Bounds the per-request output
   * budget to the remaining context. Unset/invalid → the curated model
   * catalogue is consulted; if it has no entry either, the loop's
   * documented default output cap applies (the window is never used as an
   * output budget).
   */
  modelContextWindow?: number;
  /**
   * Selected model's declared per-request output-token limit. Unset/invalid
   * → catalogue lookup, then the loop's documented default; limits are
   * never invented.
   */
  maxOutputTokens?: number;
  toolPolicies?: Record<string, { enabled?: boolean; autoApprove?: boolean }>;
  extraTools?: AgentTool[];
  enableTools?: boolean;
  /**
   * Live-tool approval gate (M4): invoked via the runtime's beforeTool hook
   * for EVERY tool call. Returning approved:false blocks the tool — the model
   * receives the reason. No tool executes without an M4 decision when this is
   * configured; hook failures deny closed.
   */
  requestApproval?: (request: {
    toolCallId: string;
    toolName: string;
    input: unknown;
  }) => Promise<{ approved: boolean; reason?: string }>;
  /**
   * Same ChangeSet staging bridge, on the lightweight `CodePilotAgent` config
   * used by the multi-agent orchestrator's role agents. Inherited unchanged
   * from the orchestrator base config, so a child agent's edit creates the
   * same pending ChangeSet as the main agent's and is applied only after the
   * user approves it. When absent the child agent is built WITHOUT any write
   * tool (fail closed) — never with a direct-to-disk write.
   */
  onWriteProposal?: (
    toolName: string,
    proposals: Array<{
      filePath: string;
      relativePath: string;
      proposedContent: string;
      /** Staged deletion marker (delete_file). */
      delete?: boolean;
    }>,
  ) => Promise<{ changeSetId: string }>;
  /**
   * Persisted command-repair history (Phase 12, row 14). When set, bounded
   * command-failure repair attempts survive restarts. Omit for in-memory.
   */
  commandRepairPersistPath?: string;
}

/**
 * Options for creating a CodePilotRuntime.
 */
export interface CodePilotRuntimeOptions {
  workspaceRoot: string;
  providerId: string;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  privacyMode?: PrivacyMode;
  agentMode?: CodePilotAgentMode;
  toolPolicies?: Record<string, { enabled?: boolean; autoApprove?: boolean }>;
  extraTools?: AgentTool[];
  maxIterations?: number;
  temperature?: number;
  systemPrompt?: string;
  /**
   * H2 credential boundary override for the whole runtime. Unset → the
   * canonical provider classification (isRemoteProvider) decides per run:
   * remote providers are redacted, local providers pass tool output
   * through verbatim.
   */
  redactToolResults?: boolean;
  /**
   * Selected model's context window (tokens) — bounds the per-request
   * output budget. Unset → the curated model catalogue is consulted; if it
   * has no entry either, the loop's documented default cap applies.
   */
  modelContextWindow?: number;
  /**
   * Selected model's declared per-request output-token limit. Unset →
   * catalogue lookup, then the loop's documented default; never invented.
   */
  maxOutputTokens?: number;
  /**
   * Maximum number of transient-error retries before giving up.
   * Defaults to 2. Set to 0 to disable retry.
   */
  maxRetries?: number;
  /**
   * Ollama-only: inactivity window (ms) allowed before the FIRST stream
   * chunk. A local CPU prefill is legitimately silent for minutes before
   * generation starts (measured: >420s for a warm ~4k-token prompt on
   * qwen3:8b), so the steady-stream inactivity window must not apply to
   * that phase. Defaults to 900_000 (15m) when unset.
   */
  ollamaFirstTokenTimeoutMs?: number;
  /**
   * Ollama-only: model residency after a completed request (Go duration
   * string, e.g. "10m"). Pinning keeps the model warm so consecutive turns
   * avoid a full model reload (measured 21.9s cold vs 0.6s warm on
   * qwen3:8b/CPU). Defaults to "10m"; "0" restores server-default unload.
   */
  ollamaKeepAlive?: string;
  /**
   * Ollama-only: `num_ctx` context window (VS Code setting
   * `codepilot.localAI.ollama.contextLength`). Undefined → omit from the
   * Ollama request (server/model default applies).
   */
  ollamaContextLength?: number;
  /**
   * Ollama-only: `num_predict` max tokens (VS Code setting
   * `codepilot.localAI.ollama.numPredict`). Undefined → omit from the
   * Ollama request (server/model default applies).
   */
  ollamaNumPredict?: number;
  /**
   * Ollama-only: explicit `think` control for reasoning models (qwen3).
   * Three-state: undefined → server/model default (never blindly disabled);
   * true → request thinking; false → request no thinking. Real reasoning
   * spans are surfaced to the user as "Thinking…" status regardless.
   */
  ollamaThink?: boolean;
  /**
   * BUG 5 — production opt-in: use the node:http transport for local Ollama
   * chat instead of global fetch (undici). undici enforces a default 300s
   * HEADERS timeout that kills a legitimate slow CPU prefill (measured on
   * live qwen3:8b — see tests/ollama-perf-live.test.ts) before the provider's
   * 15-minute first-token inactivity window can apply. The node:http adapter
   * imposes NO transport timeouts. Tests embedding hosts leave this unset to
   * keep the global-fetch seam (vi.stubGlobal("fetch")).
   */
  ollamaUseNodeHttpTransport?: boolean;
  /**
   * Per-run timeout in milliseconds. Defaults to 0 (no timeout).
   * When a run exceeds this duration it is aborted and an error event emitted.
   */
  runTimeoutMs?: number;
  /**
   * Staging bridge: invoked when a write tool (`editor`/`apply_patch`) must
   * register its in-memory proposal as a pending ChangeSet. The host returns
   * the ChangeSet id. No file write happens here.
   */
  onWriteProposal?: (
    toolName: string,
    proposals: Array<{
      filePath: string;
      relativePath: string;
      proposedContent: string;
      /** Staged deletion marker (delete_file). */
      delete?: boolean;
    }>,
  ) => Promise<{ changeSetId: string }>;
  /**
   * Approval callback for tools that are neither auto-approved nor staged
   * (e.g. `run_commands`). The host decides (e.g. native VS Code prompt).
   */
  requestApproval?: (request: {
    toolCallId: string;
    toolName: string;
    input: unknown;
  }) =>
    | Promise<{ approved: boolean; reason?: string }>
    | { approved: boolean; reason?: string };
}

// ============================================================================
// Correlation metadata — attached to every M1.2 enriched event
// ============================================================================

/**
 * Correlation identifiers attached to every enriched agent event.
 * All fields are optional so that legacy code that doesn't set them compiles,
 * while new code can rely on them being populated by CodePilotRuntime.
 */
export interface EventCorrelation {
  /** Monotonically-increasing event sequence number within one run. */
  eventId?: string;
  /** Native session identifier for this run. */
  sessionId?: string;
  /** CodePilot task identifier (stable across retries). */
  taskId?: string;
  /**
   * Run identifier for tracing (equals the task id: one task per run in
   * the native engine; exposed explicitly so dashboards need no aliasing).
   */
  runId?: string;
  /** Stable agent identity (single agent per runtime: "codepilot-agent"). */
  agentId?: string;
  /** Unix timestamp (ms) when the event was emitted. */
  timestamp?: number;
  /** Agent state at the moment the event was emitted. */
  agentState?: AgentState;
}

// ============================================================================
// Normalized runtime error model
// ============================================================================

export type RuntimeErrorCode =
  | "PROVIDER_UNAVAILABLE"
  | "NETWORK_TIMEOUT"
  | "MODEL_NOT_FOUND"
  | "TOOL_FAILED"
  | "TOOL_TIMEOUT"
  | "WORKSPACE_VIOLATION"
  | "PERMISSION_DENIED"
  | "APPROVAL_DENIED"
  | "INVALID_ARGUMENTS"
  | "CONTEXT_OVERFLOW"
  | "MAX_ITERATIONS"
  | "RUN_TIMEOUT"
  | "CANCELLED"
  | "UNKNOWN";

export type RuntimeErrorCategory =
  | "transient" // Safe to retry
  | "permanent" // Do not retry
  | "security" // Never retry; escalate
  | "user_action_required"; // Approval or user input needed

/**
 * Normalized error emitted by CodePilotRuntime.
 * Consumers receive structured, actionable information instead of raw stack
 * traces. Detailed `cause` is available for diagnostics/logging only.
 */
export interface RuntimeError {
  code: RuntimeErrorCode;
  category: RuntimeErrorCategory;
  /** Short human-readable message safe to surface in the UI. */
  message: string;
  /** Extended technical detail for logs — never shown raw to the user. */
  technicalDetail?: string;
  recoverable: boolean;
  retryable: boolean;
  cancelled: boolean;
  timedOut: boolean;
  /** Original `Error` or raw message for structured logging. */
  cause?: unknown;
  /** Correlation identifiers for tracing. */
  correlation?: EventCorrelation;
}

// ============================================================================
// Agent events — M1.2 enriched union
//
// BACKWARD COMPATIBILITY GUARANTEE:
//   Every member of the existing AgentEvent union is preserved verbatim.
//   New members are added at the end. The EventCorrelation mixin is
//   intersected onto each member via the AgentEventBase alias so callers that
//   destructure { type, ... } continue to work — the new fields are optional.
// ============================================================================

/** Optional correlation metadata mixed into every event. */
type WithCorrelation = EventCorrelation;

/**
 * Stable, machine-readable causes for an `error` event. Hosts branch on this
 * instead of matching error text. Extend deliberately: a new value is a
 * product-visible behaviour change for every consumer of the event stream.
 */
export type AgentErrorCode = "privacy-blocked" | "provider-unsupported";

export type AgentEvent =
  // ---- Pre-existing events (verbatim — do not change field names) ----
  | ({ type: "started"; sessionId: string } & WithCorrelation)
  | ({ type: "thinking"; iteration: number } & WithCorrelation)
  | ({
      type: "text_delta";
      text: string;
      accumulated: string;
    } & WithCorrelation)
  | ({
      type: "reasoning_delta";
      text: string;
      accumulated: string;
    } & WithCorrelation)
  | ({
      type: "tool_requested";
      toolCallId: string;
      toolName: string;
      input: unknown;
    } & WithCorrelation)
  | ({
      type: "tool_approved";
      toolCallId: string;
      approved: boolean;
    } & WithCorrelation)
  | ({
      type: "tool_started";
      toolCallId: string;
      toolName: string;
    } & WithCorrelation)
  | ({
      type: "tool_completed";
      toolCallId: string;
      toolName: string;
      output: unknown;
      durationMs: number;
    } & WithCorrelation)
  | ({
      type: "tool_failed";
      toolCallId: string;
      toolName: string;
      error: string;
    } & WithCorrelation)
  | ({ type: "file_changed"; path: string; status: string } & WithCorrelation)
  | ({ type: "test_started"; command: string } & WithCorrelation)
  | ({
      type: "test_completed";
      passed: number;
      failed: number;
      duration: number;
    } & WithCorrelation)
  | ({
      type: "error";
      error: string;
      recoverable: boolean;
      /**
       * Machine-readable cause, set by the runtime when it KNOWS why the run
       * failed. Hosts must never infer this from the error text.
       *
       * "privacy-blocked" means the Local Only guard refused the run BEFORE any
       * request left the machine — materially different from a provider
       * failure, and it must reach the user as an actionable privacy card.
       */
      code?: AgentErrorCode;
      /** Provider the failure is attributed to (an id, never a credential). */
      providerId?: string;
    } & WithCorrelation)
  | ({ type: "completed"; result: string; usage: AgentUsage } & WithCorrelation)
  | ({ type: "cancelled" } & WithCorrelation)
  | ({
      type: "status";
      message: string;
      metadata?: Record<string, unknown>;
    } & WithCorrelation)
  | ({
      type: "healing_started";
      attempt: number;
      maxAttempts: number;
    } & WithCorrelation)
  | ({
      type: "healing_progress";
      attempt: number;
      maxAttempts: number;
      phase: string;
      message: string;
    } & WithCorrelation)
  | ({
      type: "healing_succeeded";
      attempt: number;
      durationMs: number;
    } & WithCorrelation)
  | ({
      type: "healing_failed";
      attempts: number;
      error: string;
    } & WithCorrelation)
  // ---- M1.2 new events ----
  | ({
      type: "agent.started";
      agentMode: string;
      providerId: string;
      modelId: string;
    } & WithCorrelation)
  | ({
      type: "agent.thinking";
      iteration: number;
    } & WithCorrelation)
  | ({
      type: "agent.plan_created";
      plan: string;
      stepsCount: number;
      /** Full structured plan (persisted by the host on the active task). */
      taskPlan: TaskPlan;
    } & WithCorrelation)
  | ({
      type: "agent.plan_updated";
      /** Full plan after the step transition (derived progress included). */
      taskPlan: TaskPlan;
    } & WithCorrelation)
  | ({
      type: "agent.tool_requested";
      toolCallId: string;
      toolName: string;
      input: unknown;
    } & WithCorrelation)
  | ({
      type: "agent.tool_started";
      toolCallId: string;
      toolName: string;
    } & WithCorrelation)
  | ({
      type: "agent.tool_progress";
      toolCallId: string;
      toolName: string;
      progressMessage: string;
    } & WithCorrelation)
  | ({
      type: "agent.tool_completed";
      toolCallId: string;
      toolName: string;
      durationMs: number;
    } & WithCorrelation)
  | ({
      type: "agent.approval_required";
      toolCallId: string;
      toolName: string;
      input: unknown;
      riskLevel: "low" | "medium" | "high";
    } & WithCorrelation)
  | ({
      type: "agent.validation_started";
      command: string;
    } & WithCorrelation)
  | ({
      type: "agent.validation_failed";
      command: string;
      exitCode: number;
      stderr: string;
    } & WithCorrelation)
  | ({
      type: "agent.healing_started";
      attempt: number;
      maxAttempts: number;
      reason: string;
    } & WithCorrelation)
  | ({
      type: "agent.healing_completed";
      attempt: number;
      success: boolean;
      durationMs: number;
    } & WithCorrelation)
  | ({
      type: "agent.completed";
      result: string;
      usage: AgentUsage;
      durationMs: number;
      /** Time to first model output token, when any output streamed. */
      timeToFirstTokenMs?: number;
    } & WithCorrelation)
  | ({
      type: "agent.failed";
      error: RuntimeError;
    } & WithCorrelation)
  | ({
      type: "agent.cancelled";
      reason: string;
    } & WithCorrelation)
  | ({
      type: "agent.retry";
      attempt: number;
      maxAttempts: number;
      reason: string;
      delayMs: number;
    } & WithCorrelation)
  | ({
      type: "agent.state_changed";
      from: AgentState;
      to: AgentState;
      reason?: string;
    } & WithCorrelation)
  // ---- Terminal streaming (production terminal milestone) ----
  // New members go last per the backward-compatibility guarantee above.
  | ({
      /**
       * One live stdout/stderr chunk from an agent-executed terminal
       * command. Emitted while the process runs — never persisted per
       * chunk (the final tool_completed carries the bounded result).
       * `seq` is monotonically increasing per terminal execution.
       */
      type: "terminal_output";
      /** Native tool-call id — correlates with tool_started/completed. */
      toolCallId: string;
      /** Live tool name as reported (fallback "terminal" when unknown). */
      toolName: string;
      stream: "stdout" | "stderr";
      /** Decoded text for this chunk (OS pipe-segmented, not capped). */
      data: string;
      /** Per-execution monotonic sequence (starts at 1 with started). */
      seq: number;
      /** Terminal execution id (equals toolCallId when known). */
      executionId: string;
    } & WithCorrelation);

export type AgentEventListener = (event: AgentEvent) => void;

// ============================================================================
// AgentRuntimeState — backward-compatible (status union unchanged)
// ============================================================================

/**
 * Internal state of the agent runtime.
 *
 * BACKWARD COMPATIBLE: `status` retains `"idle" | "running" | "aborted" | "failed"`.
 * New `agentState` field exposes the fine-grained state machine value.
 */
export interface AgentRuntimeState {
  /** Legacy coarse status — preserved for backward compatibility. */
  status: "idle" | "running" | "aborted" | "failed";
  /**
   * Fine-grained state machine state.
   * Added in M1 — undefined when state machine has not been initialized.
   */
  agentState?: AgentState;
  sessionId: string | null;
  /** Stable task identifier for the current run (set at session start). */
  taskId?: string;
  currentIteration: number;
  messages: AgentMessage[];
  usage: AgentUsage;
  filesChanged: string[];
  toolCallHistory: Array<{
    name: string;
    count: number;
    totalDurationMs: number;
  }>;
  lastError: string | null;
  /** Normalized last error when available. */
  lastRuntimeError?: RuntimeError;
  /** Metrics for the most recently completed run. */
  lastRunMetrics?: RunMetrics;
  /** Number of transient-error retries consumed in the current run. */
  retriesConsumed?: number;
}

// ============================================================================
// Run metrics (observability)
// ============================================================================

export interface RunMetrics {
  taskId: string;
  sessionId: string | null;
  /** Stable run identifier for tracing (equals taskId). */
  runId?: string;
  /** Stable agent identity. */
  agentId?: string;
  providerId?: string;
  modelId?: string;
  agentMode?: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  /** First model output (text or reasoning delta), when any streamed. */
  firstTokenAt?: number;
  /** Elapsed ms from run start to first model output. */
  timeToFirstTokenMs?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Provider-reported cost, when supplied. */
  totalCost?: number;
  toolCallCount: number;
  /** Tool calls that failed (executor error or gate denial). */
  toolFailures?: number;
  /** Highest loop iteration reached. */
  iterations?: number;
  filesChanged: number;
  retriesConsumed: number;
  cancelled: boolean;
  failed: boolean;
}
