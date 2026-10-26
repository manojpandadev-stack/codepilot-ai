/**
 * Multi-agent orchestrator for CodePilot AI.
 * Routes tasks to specialized agents based on complexity.
 * Implements real Task DAG with dependency-aware parallel execution.
 */

import { CodePilotAgent } from "./agent.js";
import type {
  AgentEvent,
  AgentEventListener,
  CodePilotAgentConfig,
} from "./types.js";
import type {
  ToolPermissionLevel,
  PermissionDecisionType,
  ToolExecutorOptions,
  ExecuteOptions,
  ToolResult,
  ToolEventListener,
  M4PermissionPipeline,
} from "@codepilot/tool-engine";
import { FileConflictError } from "./m14-file-locks.js";
import type { AgentTool } from "./native/types.js";
import { createCodePilotBuiltinTools } from "./builtin-tools.js";
import {
  MUTATING_TOOL_NAMES,
  STAGED_WRITE_TOOL_NAMES,
  createStagedWriteTools,
  type StagedWriteToolName,
  type WriteProposalSink,
} from "./staged-write-tools.js";
import type {
  ValidationResult,
  RepairApplier,
  RepairAttempt,
} from "./self-healing.js";
import {
  CancellationSource,
  CancellationToken,
  TimeoutManager,
  withTimeout,
} from "./cancellation.js";
import {
  MAX_AUTO_REPAIR_ATTEMPTS,
  MAX_SAME_SIGNATURE_REPEATS,
} from "./m13-command-repair.js";
import {
  ToolExecutionService,
  ToolPermissionManager,
  ToolRegistry,
  ToolAuditLogger,
  toolError,
} from "@codepilot/tool-engine";
import {
  TaskStore,
  redactForPersistence,
  PersistedTask,
} from "./m12-task-store.js";
import { FileLockRegistry } from "./m14-file-locks.js";

// ============================================================================
// Task Types
// ============================================================================

export type AgentRole =
  | "orchestrator"
  | "architect"
  | "coder"
  | "tester"
  | "security"
  | "reviewer"
  | "documentation";

export type TaskStatus =
  | "pending"
  | "running"
  | "waiting"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "retrying"
  | "uncertain";

export interface TaskNode {
  id: string;
  agentRole: AgentRole;
  description: string;
  dependencies: string[];
  status: TaskStatus;
  priority: number;
  result?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  retryCount: number;
  maxRetries: number;
  timeoutMs: number;
  /**
   * A non-empty, stable hash of the last executed command text for this
   * task. Empty until the task has run at least once. Used by executeTask's
   * retry guard to detect a re-run of the exact same command: if the command
   * is unchanged and the task is non-idempotent, a retry is unsafe, so the
   * same error is surfaced as outcome-unknown instead of re-executing the
   * mutation.
   */
  lastCommandHash?: string;
  /**
   * Optional tasks may fail without failing the orchestration: their
   * failure yields PARTIAL instead of FAILED. Default false (required).
   */
  optional?: boolean;
}

/**
 * Deterministic content hash used by the orchestrator's retry/idempotency
 * guard (executeTask) to detect whether a task is being re-run with the
 * exact same command text. Stable across runs; suitable for quick keying.
 * Stronger guarantees (full args/memory snapshot) require a derived hash
 * supplied by the caller if needed.
 */
export function computeTaskHash(commandText: string): string {
  let hash = 0;
  for (let i = 0; i < commandText.length; i++) {
    hash = (hash << 5) - hash + commandText.charCodeAt(i);
    hash |= 0;
  }
  return `cmd-${(hash >>> 0).toString(16)}`;
}

/**
 * Report a non-idempotent task failure as outcome-unknown: the command text
 * is unchanged from the last attempt, so the prior run's disk state is
 * uncertain and the command must not be silently re-executed. Requires
 * reconciliation before any retry.
 */
export function recordOutcomeAsUncertain(
  task: TaskNode,
  error: string,
  dag: TaskDAG,
): void {
  const commandText = task.description ?? "";
  const runHash = task.lastCommandHash ?? computeTaskHash(commandText);
  task.error = `${error} (outcome unknown: last run with hash ${runHash} may have executed)`;
  task.status = "uncertain";
  task.retryCount = task.maxRetries;
  dag.markFailed(task.id, task.error!);
}

/**
 * Orchestration outcome — the single value the host uses to report status.
 * A failed orchestration is never reported as completed.
 */
export type OrchestrationOutcome =
  "COMPLETED" | "FAILED" | "PARTIAL" | "CANCELLED" | "BLOCKED";

export interface OrchestrationSummary {
  outcome: OrchestrationOutcome;
  /** Required tasks that failed (empty unless FAILED). */
  failedRequired: string[];
  /** Optional tasks that failed (empty unless PARTIAL). */
  failedOptional: string[];
  /** Tasks left blocked by a failed dependency. */
  blocked: string[];
  /** True when the run was aborted by the user. */
  cancelled: boolean;
}

/**
 * Derive the orchestration outcome from DAG state. Pure and deterministic:
 * user cancellation wins, then required failures, then optional-only
 * failures, then unresolvable remainder, else completed.
 */
export function deriveOrchestrationOutcome(
  dag: TaskDAG,
  cancelled: boolean,
): OrchestrationSummary {
  const tasks = dag.getAllTasks();
  const failedRequired: string[] = [];
  const failedOptional: string[] = [];
  const blocked: string[] = [];
  let incomplete = false;
  for (const t of tasks) {
    if (t.status === "failed") {
      if (t.optional) failedOptional.push(t.id);
      else failedRequired.push(t.id);
    } else if (t.status === "blocked") {
      blocked.push(t.id);
    } else if (
      t.status === "pending" ||
      t.status === "waiting" ||
      t.status === "running" ||
      t.status === "retrying"
    ) {
      incomplete = true;
    }
  }
  failedRequired.sort((a, b) => a.localeCompare(b));
  failedOptional.sort((a, b) => a.localeCompare(b));
  blocked.sort((a, b) => a.localeCompare(b));
  // A blocked REQUIRED task means required work did not happen.
  const blockedRequired = blocked.filter((id) => {
    const t = dag.getTask(id);
    return t && !t.optional;
  });
  if (cancelled) {
    return {
      outcome: "CANCELLED",
      failedRequired,
      failedOptional,
      blocked,
      cancelled: true,
    };
  }
  if (failedRequired.length > 0 || blockedRequired.length > 0) {
    return {
      outcome: "FAILED",
      failedRequired,
      failedOptional,
      blocked,
      cancelled: false,
    };
  }
  if (failedOptional.length > 0 || blocked.length > 0) {
    return {
      outcome: "PARTIAL",
      failedRequired,
      failedOptional,
      blocked,
      cancelled: false,
    };
  }
  if (incomplete) {
    return {
      outcome: "BLOCKED",
      failedRequired,
      failedOptional,
      blocked,
      cancelled: false,
    };
  }
  return {
    outcome: "COMPLETED",
    failedRequired: [],
    failedOptional: [],
    blocked: [],
    cancelled: false,
  };
}

/**
 * Structured context passed between agents.
 * Each downstream agent receives only the relevant upstream data.
 */
export interface AgentTaskContext {
  taskId: string;
  agentRole: AgentRole;
  repositorySummary: string;
  changedFiles: string[];
  previousResults: Array<{ role: AgentRole; result: string; success: boolean }>;
  testResults?: { passed: number; failed: number; output: string };
  securityFindings?: Array<{
    severity: string;
    finding: string;
    file?: string;
  }>;
  gitDiff?: string;
}

export interface OrchestratorEvent {
  type:
    | "task_started"
    | "task_completed"
    | "task_failed"
    | "orchestration_completed"
    | "orchestration_failed";
  taskId?: string;
  agentRole?: AgentRole;
  result?: string;
  error?: string;
  timestamp: number;
}

export interface OrchestratorConfig {
  /** Maximum retries per task (default: 1) */
  maxRetries?: number;
  /** Per-task timeout in ms (default: 300000 = 5 minutes) */
  taskTimeoutMs?: number;
  /** Maximum concurrent tasks (default: 2 for parallel safety) */
  maxConcurrency?: number;
}

// ============================================================================
// Agent Role Prompts
// ============================================================================

const ROLE_SYSTEM_PROMPTS: Record<AgentRole, string> = {
  orchestrator: [
    "You are the Orchestrator agent. Analyze the user request and determine which specialized agents are needed.",
    "Return a JSON task plan with: { tasks: [{ agentRole, description, dependencies }] }",
    "Roles: architect (analyze repo), coder (implement changes), tester (run tests), security (security review), reviewer (code review), documentation (update docs)",
    "Simple tasks (explain, review, plan): use 1-2 agents.",
    "Complex tasks (implement, refactor, fix): use architect → coder → tester → reviewer.",
  ].join("\n"),

  architect: [
    "You are the Architect agent. Analyze the repository structure, dependencies, and architecture.",
    "Identify: technology stack, modules, entry points, patterns, and impact areas.",
    "Return a structured analysis with specific file paths and recommendations.",
  ].join("\n"),

  coder: [
    "You are the Coder agent. Implement the requested changes following project conventions.",
    "Read relevant files, understand existing patterns, make minimal coherent changes.",
    "Always explain what you changed and why.",
  ].join("\n"),

  tester: [
    "You are the Testing agent. Run tests and analyze results.",
    "Run the project's test suite. If tests fail, analyze the failure output.",
    "Report: tests run, passed, failed, and any issues found.",
  ].join("\n"),

  security: [
    "You are the Security agent. Review changes for security vulnerabilities.",
    "Check: hardcoded secrets, unsafe endpoints, injection, unsafe dependencies, configuration issues.",
    "Report findings with severity: CRITICAL, HIGH, MEDIUM, LOW, INFO.",
  ].join("\n"),

  reviewer: [
    "You are the Code Review agent. Review all changes for quality.",
    "Check: bugs, maintainability, architecture, performance, code smells.",
    "Report findings with severity and suggested fixes.",
  ].join("\n"),

  documentation: [
    "You are the Documentation agent. Update documentation to reflect changes.",
    "Update README, API docs, architecture docs as needed.",
  ].join("\n"),
};

// ============================================================================
// Task DAG
// ============================================================================

export class TaskDAG {
  private tasks: Map<string, TaskNode> = new Map();

  addTask(node: TaskNode): void {
    this.tasks.set(node.id, node);
  }

  getTask(id: string): TaskNode | undefined {
    return this.tasks.get(id);
  }

  getAllTasks(): TaskNode[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Get tasks that are ready to run: pending with ALL dependencies completed.
   * This is the core of dependency-aware execution.
   */
  getReadyTasks(): TaskNode[] {
    return Array.from(this.tasks.values()).filter((task) => {
      if (task.status !== "pending") return false;
      return task.dependencies.every((depId) => {
        const dep = this.tasks.get(depId);
        return dep?.status === "completed";
      });
    });
  }

  /**
   * Get tasks whose dependencies include a specific task.
   */
  getDependents(taskId: string): TaskNode[] {
    return Array.from(this.tasks.values()).filter((t) =>
      t.dependencies.includes(taskId),
    );
  }

  /**
   * Propagate failure: mark all downstream tasks that depend (directly or
   * transitively) on a failed task as "blocked".
   */
  propagateFailure(failedTaskId: string): string[] {
    const blocked: string[] = [];
    const queue = [failedTaskId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const dep of this.getDependents(current)) {
        if (dep.status === "pending" || dep.status === "waiting") {
          dep.status = "blocked";
          dep.error = `Blocked by failed dependency: ${current}`;
          dep.completedAt = Date.now();
          blocked.push(dep.id);
          queue.push(dep.id);
        }
      }
    }
    return blocked;
  }

  markRunning(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.status = "running";
      task.startedAt = Date.now();
    }
  }

  markCompleted(id: string, result: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.status = "completed";
      task.result = result;
      task.completedAt = Date.now();
    }
  }

  markFailed(id: string, error: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.status = "failed";
      task.error = error;
      task.completedAt = Date.now();
    }
  }

  markCancelled(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.status = "cancelled";
      task.completedAt = Date.now();
    }
  }

  markRetrying(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.status = "retrying";
      task.retryCount++;
    }
  }

  isComplete(): boolean {
    return Array.from(this.tasks.values()).every(
      (t) =>
        t.status === "completed" ||
        t.status === "failed" ||
        t.status === "cancelled" ||
        t.status === "blocked",
    );
  }

  hasFailures(): boolean {
    return Array.from(this.tasks.values()).some(
      (t) => t.status === "failed" || t.status === "blocked",
    );
  }

  /** Validate that all dependency IDs reference existing tasks */
  validate(): string[] {
    const errors: string[] = [];
    for (const task of this.tasks.values()) {
      for (const depId of task.dependencies) {
        if (!this.tasks.has(depId)) {
          errors.push(
            `Task "${task.id}" depends on non-existent task "${depId}"`,
          );
        }
      }
    }
    // Check for cycles using DFS
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const dfs = (id: string): boolean => {
      if (inStack.has(id)) return true; // cycle
      if (visited.has(id)) return false;
      visited.add(id);
      inStack.add(id);
      const task = this.tasks.get(id);
      if (task) {
        for (const depId of task.dependencies) {
          if (dfs(depId)) return true;
        }
      }
      inStack.delete(id);
      return false;
    };
    for (const task of this.tasks.values()) {
      if (dfs(task.id)) {
        errors.push(`Cycle detected involving task "${task.id}"`);
        break;
      }
    }
    return errors;
  }

  /** Determine agent role based on task description */
  static classifyTask(description: string): AgentRole[] {
    const lower = description.toLowerCase();

    if (
      lower.includes("implement") ||
      lower.includes("add") ||
      lower.includes("create") ||
      lower.includes("fix") ||
      lower.includes("refactor") ||
      lower.includes("modify") ||
      lower.includes("change") ||
      lower.includes("cache")
    ) {
      // Complex: architect → coder → tester + security (parallel) → reviewer
      return ["architect", "coder", "tester", "security", "reviewer"];
    } else if (
      lower.includes("review") ||
      lower.includes("analyze") ||
      lower.includes("explain") ||
      lower.includes("understand")
    ) {
      return ["architect"];
    } else if (lower.includes("plan")) {
      return ["architect"];
    } else if (lower.includes("test")) {
      return ["tester"];
    } else if (lower.includes("security")) {
      return ["security"];
    } else {
      return ["coder"];
    }
  }

  /**
   * Build a DAG from a list of roles with proper dependency edges.
   * For complex workflows (architect, coder, tester, security, reviewer):
   *   architect → coder → tester (parallel with security) → reviewer
   * For simple workflows: linear chain.
   */
  static buildFromRoles(roles: AgentRole[], baseDescription: string): TaskDAG {
    const dag = new TaskDAG();
    let idx = 0;

    // Detect complex workflow: has both tester+security
    const hasTester = roles.includes("tester");
    const hasSecurity = roles.includes("security");
    const hasReviewer = roles.includes("reviewer");

    if (hasTester && hasSecurity && hasReviewer) {
      // Complex DAG with parallel branches
      const taskIds: Record<string, string> = {};

      // Linear prefix: architect → coder
      const prefixRoles = roles.filter(
        (r) => r !== "tester" && r !== "security" && r !== "reviewer",
      );
      let prevId: string | null = null;
      for (const role of prefixRoles) {
        const id = `task-${++idx}`;
        taskIds[role] = id;
        dag.addTask({
          id,
          agentRole: role,
          description: `[${role}] ${baseDescription}`,
          dependencies: prevId ? [prevId] : [],
          status: "pending",
          priority: idx,
          retryCount: 0,
          maxRetries: 1,
          timeoutMs: 300_000,
        });
        prevId = id;
      }

      // Parallel branches: tester + security (both depend on last prefix task)
      const coderId = prevId!;
      for (const role of ["tester", "security"] as const) {
        const id = `task-${++idx}`;
        taskIds[role] = id;
        dag.addTask({
          id,
          agentRole: role,
          description: `[${role}] ${baseDescription}`,
          dependencies: [coderId],
          status: "pending",
          priority: idx,
          retryCount: 0,
          maxRetries: 1,
          timeoutMs: 300_000,
        });
      }

      // Reviewer: depends on BOTH tester and security
      const id = `task-${++idx}`;
      taskIds["reviewer"] = id;
      dag.addTask({
        id,
        agentRole: "reviewer",
        description: `[reviewer] ${baseDescription}`,
        dependencies: [taskIds["tester"]!, taskIds["security"]!],
        status: "pending",
        priority: idx,
        retryCount: 0,
        maxRetries: 1,
        timeoutMs: 300_000,
      });
    } else {
      // Simple linear chain
      let prevId: string | null = null;
      for (const role of roles) {
        const id = `task-${++idx}`;
        dag.addTask({
          id,
          agentRole: role,
          description: `[${role}] ${baseDescription}`,
          dependencies: prevId ? [prevId] : [],
          status: "pending",
          priority: idx,
          retryCount: 0,
          maxRetries: 1,
          timeoutMs: 300_000,
        });
        prevId = id;
      }
    }

    return dag;
  }
}

// ============================================================================
// Orchestrator
// ============================================================================

export class MultiAgentOrchestrator {
  private listeners = new Set<AgentEventListener>();
  private currentDAG: TaskDAG | null = null;
  private abortController: AbortController | null = null;
  private activeAgents: Map<string, CodePilotAgent> = new Map();
  private config: Required<OrchestratorConfig>;

  constructor(
    private readonly baseConfig: Omit<CodePilotAgentConfig, "agentMode">,
    orchestratorConfig?: OrchestratorConfig,
  ) {
    this.config = {
      maxRetries: orchestratorConfig?.maxRetries ?? 1,
      taskTimeoutMs: orchestratorConfig?.taskTimeoutMs ?? 300_000,
      maxConcurrency: orchestratorConfig?.maxConcurrency ?? 2,
    };
  }

  /**
   * Execute a task through the multi-agent pipeline.
   * Creates a Task DAG, assigns agents, and executes with real dependency awareness.
   *
   * When `opts.roles` is provided, the DAG is built from those roles instead
   * of classifying the description (used by the Team UI so role selection is
   * real). Omitting it preserves the legacy classify-from-text behavior.
   */
  async execute(
    description: string,
    mode: "plan" | "act" | "review" = "act",
    opts?: { roles?: AgentRole[] },
  ): Promise<{
    results: Array<{
      role: AgentRole;
      task: string;
      result: string;
      success: boolean;
    }>;
    finalResult: string;
    dag: TaskDAG;
    /** Explicit outcome — the host must report this, never assume success. */
    outcome: OrchestrationSummary;
  }> {
    this.abortController = new AbortController();
    this.activeAgents.clear();

    // Classify the task (or honor an explicit role selection)
    const roles =
      opts?.roles && opts.roles.length > 0
        ? [...opts.roles]
        : TaskDAG.classifyTask(description);
    this.currentDAG = TaskDAG.buildFromRoles(roles, description);

    // Validate DAG
    const validationErrors = this.currentDAG.validate();
    if (validationErrors.length > 0) {
      throw new Error(`Invalid DAG: ${validationErrors.join("; ")}`);
    }

    this.emit({
      type: "status",
      message: "Orchestration started",
      metadata: {
        agentRole: "orchestrator",
        taskId: "task-0",
        taskCount: this.currentDAG.getAllTasks().length,
      },
    });

    const results: Array<{
      role: AgentRole;
      task: string;
      result: string;
      success: boolean;
    }> = [];

    // ===== DAG-EXECUTION LOOP =====
    // Instead of linear iteration, use getReadyTasks() for dependency-aware execution.
    while (!this.currentDAG.isComplete()) {
      if (this.abortController.signal.aborted) {
        // Cancel all pending tasks
        for (const task of this.currentDAG.getAllTasks()) {
          if (task.status === "pending" || task.status === "waiting") {
            this.currentDAG.markCancelled(task.id);
          }
        }
        break;
      }

      const readyTasks = this.currentDAG.getReadyTasks();
      if (readyTasks.length === 0) {
        // Either all done or deadlock
        if (this.currentDAG.isComplete()) break;
        // Check for deadlock (running tasks still in progress)
        const running = this.currentDAG
          .getAllTasks()
          .filter((t) => t.status === "running");
        if (running.length === 0) {
          // True deadlock — shouldn't happen with valid DAGs
          break;
        }
        // Wait a bit and check again
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }

      // Limit concurrency
      const batch = readyTasks.slice(0, this.config.maxConcurrency);

      // Execute batch in parallel
      const batchResults = await Promise.allSettled(
        batch.map((task) => this.executeTask(task, mode, results)),
      );

      // Process results
      for (let i = 0; i < batch.length; i++) {
        const task = batch[i]!;
        const batchResult = batchResults[i];

        if (!batchResult) continue;

        if (batchResult.status === "rejected") {
          const error =
            batchResult.reason instanceof Error
              ? batchResult.reason.message
              : String(batchResult.reason);

          const currentTask = this.currentDAG.getTask(task.id);
          if (currentTask?.status === "retrying") {
            // Will be retried in next iteration
            continue;
          }

          // Phase 3: executeTask may already have recorded the failure as
          // outcome-unknown (retry-guard). Never overwrite that terminal
          // record with the raw thrown error — the uncertain suffix is the
          // evidence resume needs to avoid blind replay.
          const recorded = this.currentDAG.getTask(task.id);
          if (!recorded || recorded.status !== "failed" || !recorded.error) {
            this.currentDAG.markFailed(task.id, error);
          }
          const blocked = this.currentDAG.propagateFailure(task.id);
          results.push({
            role: task.agentRole,
            task: task.description,
            result: error,
            success: false,
          });

          this.emit({
            type: "error",
            error: `${task.agentRole} failed: ${error} (blocked ${blocked.length} downstream tasks)`,
            recoverable: true,
          });
        } else {
          // Success — result was already recorded in executeTask
          const currentTask = this.currentDAG.getTask(task.id);
          if (currentTask?.result) {
            results.push({
              role: task.agentRole,
              task: task.description,
              result: currentTask.result,
              success: true,
            });
          }
        }
      }
    }

    // Derive the explicit outcome FIRST — a failed run must never be
    // presented as completed. `cancelled` reflects user abort, not error.
    const cancelled = this.abortController?.signal.aborted ?? false;
    const outcome = deriveOrchestrationOutcome(this.currentDAG, cancelled);

    // Build final result from last completed agent
    const completedResults = results.filter((r) => r.success);
    const lastResult = completedResults[completedResults.length - 1];
    const finalResult =
      lastResult?.result ??
      (outcome.outcome === "COMPLETED"
        ? "Orchestration completed"
        : `Orchestration ${outcome.outcome.toLowerCase()}: ` +
          [
            outcome.failedRequired.length > 0
              ? `${outcome.failedRequired.length} required task(s) failed (${outcome.failedRequired.join(", ")})`
              : "",
            outcome.failedOptional.length > 0
              ? `${outcome.failedOptional.length} optional task(s) failed (${outcome.failedOptional.join(", ")})`
              : "",
            outcome.blocked.length > 0
              ? `${outcome.blocked.length} task(s) blocked`
              : "",
            outcome.outcome === "CANCELLED" ? "cancelled by user" : "",
            outcome.outcome === "BLOCKED" ? "unresolved tasks remain" : "",
          ]
            .filter(Boolean)
            .join("; "));

    // The explicit outcome travels in the return value (see
    // OrchestrationSummary) so the host can report it exactly; the event
    // stream keeps its existing completed/error contract for listeners.
    if (outcome.outcome === "COMPLETED") {
      this.emit({
        type: "completed",
        result: finalResult,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      });
    } else {
      this.emit({
        type: "error",
        error: finalResult,
        recoverable: outcome.outcome !== "CANCELLED",
      });
    }

    return { results, finalResult, dag: this.currentDAG, outcome };
  }

  /**
   * Execute a single task with timeout, retry support, and structured context.
   */
  private async executeTask(
    task: TaskNode,
    mode: "plan" | "act" | "review",
    previousResults: Array<{
      role: AgentRole;
      task: string;
      result: string;
      success: boolean;
    }>,
  ): Promise<string> {
    // Build structured context
    const context = this.buildTaskContext(task, previousResults);

    // Build prompt with context
    const contextParts: string[] = [];
    if (context.previousResults.length > 0) {
      contextParts.push(
        "Previous agent results:\n" +
          context.previousResults
            .map(
              (r) =>
                `[${r.role}] ${r.success ? "✓" : "✗"}: ${r.result.substring(0, 500)}`,
            )
            .join("\n\n"),
      );
    }
    if (context.changedFiles.length > 0) {
      contextParts.push(`Changed files: ${context.changedFiles.join(", ")}`);
    }
    if (context.testResults) {
      contextParts.push(
        `Test results: ${context.testResults.passed} passed, ${context.testResults.failed} failed\n${context.testResults.output.substring(0, 500)}`,
      );
    }
    if (context.securityFindings && context.securityFindings.length > 0) {
      contextParts.push(
        "Security findings:\n" +
          context.securityFindings
            .map((f) => `  [${f.severity}] ${f.finding}`)
            .join("\n"),
      );
    }

    const prompt =
      contextParts.length > 0
        ? `${contextParts.join("\n\n")}\n\nCurrent task: ${task.description}`
        : task.description;

    // Mark running
    this.currentDAG!.markRunning(task.id);
    this.emit({
      type: "status",
      message: `Running ${task.agentRole} agent`,
      metadata: { taskId: task.id, agentRole: task.agentRole },
    });

    // Create and initialize agent with the role's production tool set.
    // Workspace root, privacy mode, and the host approval pipeline come
    // from the orchestrator's base config — never blanked or bypassed.
    const agent = new CodePilotAgent(
      buildChildAgentConfig(this.baseConfig, task.agentRole, mode),
    );
    this.activeAgents.set(task.id, agent);

    try {
      await agent.initialize();

      // Execute with timeout
      const outcome = await this.executeWithTimeout(
        () => agent.run(prompt),
        task.timeoutMs || this.config.taskTimeoutMs,
        task.id,
      );

      // F-02/F-03: only a genuine `complete` outcome may mark the task
      // completed. Cancellation settles as CANCELLED; a truncated provider
      // turn (incomplete) and transport failure settle as failed. Never
      // retry — the run is over.
      if (outcome.reason === "aborted") {
        this.currentDAG!.markCancelled(task.id);
        this.emit({
          type: "status",
          message: `${task.agentRole} cancelled`,
          metadata: { taskId: task.id, agentRole: task.agentRole },
        });
        this.activeAgents.get(task.id)?.abort();
        return outcome.text;
      }
      if (outcome.reason !== "complete") {
        this.currentDAG!.markFailed(
          task.id,
          outcome.error ?? `${task.agentRole} ended as ${outcome.reason}`,
        );
        throw new Error(
          outcome.error ?? `${task.agentRole} ended as ${outcome.reason}`,
        );
      }

      const resultText = outcome.text;
      this.currentDAG!.markCompleted(task.id, resultText);

      this.emit({
        type: "status",
        message: `${task.agentRole} completed`,
        metadata: {
          taskId: task.id,
          agentRole: task.agentRole,
          result: resultText.substring(0, 200),
        },
      });

      return resultText;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);

      // Check retry + idempotency guard
      // Non-idempotent tasks must never be silently re-executed. If a task
      // is being re-run (it has already failed once) with the exact same
      // command text, the prior run's disk state is uncertain, so we do not
      // re-execute: we report outcome-unknown and require reconciliation
      // before any retry.
      // Use the task's recorded command hash, deriving it from the command
      // text (task.description) when none was recorded yet. This keeps the
      // guard functional for tasks built by buildFromRoles, which do not
      // carry a hash, while still honoring an explicit hash when one exists.
      const commandText = task.description ?? "";
      const lastHash = task.lastCommandHash ?? computeTaskHash(commandText);
      const isSameCommand = lastHash === computeTaskHash(commandText);
      // A retry means the task has already failed once: a re-run with the
      // same command text would re-execute a possibly-mutated workspace, so
      // refuse to re-execute a non-idempotent command whose text is
      // unchanged and surface outcome-unknown instead.
      if (task.retryCount >= 1 && isSameCommand) {
        // Same non-idempotent command replayed: the prior run's disk state
        // is uncertain, so we do not re-execute. Report the failure as
        // outcome-unknown and require reconciliation before any retry.
        recordOutcomeAsUncertain(task, error, this.currentDAG!);
      } else if (task.retryCount < task.maxRetries) {
        this.currentDAG!.markRetrying(task.id);
        this.emit({
          type: "status",
          message: `Retrying ${task.agentRole} (attempt ${task.retryCount + 1}/${task.maxRetries})`,
          metadata: { taskId: task.id, agentRole: task.agentRole },
        });
        // Requeue: reset to pending for next iteration
        const t = this.currentDAG!.getTask(task.id);
        if (t) {
          t.status = "pending";
          t.startedAt = undefined;
        }
        return this.executeTask(task, mode, previousResults);
      }

      // If this failure was already reported as outcome-unknown by the
      // idempotency guard, do not re-mark-failed with the raw error.
      if (!task.error?.includes("outcome unknown")) {
        this.currentDAG!.markFailed(task.id, error);
      }

      const blocked = this.currentDAG!.propagateFailure(task.id);

      this.emit({
        type: "error",
        error: `${task.agentRole} failed: ${error} (blocked ${blocked.length} tasks)`,
        recoverable: true,
      });

      throw err;
    } finally {
      this.activeAgents.delete(task.id);
    }
  }

  /**
   * Build structured context for a task from upstream results.
   * Respects context limits.
   */

  private buildTaskContext(
    task: TaskNode,
    previousResults: Array<{
      role: AgentRole;
      task: string;
      result: string;
      success: boolean;
    }>,
  ): AgentTaskContext {
    // Only include results from completed tasks that this task depends on
    const relevantResults = previousResults.filter((r) => {
      const upstreamTask = this.currentDAG!.getAllTasks().find(
        (t) => t.agentRole === r.role && t.status === "completed",
      );
      return upstreamTask && task.dependencies.includes(upstreamTask.id);
    });

    // Extract test results from tester agent
    let testResults: AgentTaskContext["testResults"];
    const testerResult = relevantResults.find((r) => r.role === "tester");
    if (testerResult && testerResult.success) {
      const text = testerResult.result;
      const passedMatch = text.match(/(\d+)\s+passed/i);
      const failedMatch = text.match(/(\d+)\s+failed/i);
      testResults = {
        passed: passedMatch ? parseInt(passedMatch[1] ?? "0") : 0,
        failed: failedMatch ? parseInt(failedMatch[1] ?? "0") : 0,
        output: text.substring(0, 2000),
      };
    }

    // Extract security findings from security agent
    let securityFindings: AgentTaskContext["securityFindings"];
    const securityResult = relevantResults.find((r) => r.role === "security");
    if (securityResult && securityResult.success) {
      securityFindings = this.parseSecurityFindings(securityResult.result);
    }

    // Extract changed files from coder agent
    const changedFiles: string[] = [];
    const coderResult = relevantResults.find((r) => r.role === "coder");
    if (coderResult && coderResult.success) {
      const fileMatches = coderResult.result.match(
        /(?:Modified|Changed|Created|Updated)\s+([^\s]+\.\w+)/gi,
      );
      if (fileMatches) {
        for (const match of fileMatches) {
          const file = match
            .replace(/^(Modified|Changed|Created|Updated)\s+/i, "")
            .trim();
          if (file && !changedFiles.includes(file)) changedFiles.push(file);
        }
      }
    }

    return {
      taskId: task.id,
      agentRole: task.agentRole,
      repositorySummary: "",
      changedFiles,
      previousResults: relevantResults.map((r) => ({
        role: r.role,
        result: r.result.substring(0, 2000), // Context limit
        success: r.success,
      })),
      testResults,
      securityFindings,
    };
  }

  private parseSecurityFindings(
    text: string,
  ): Array<{ severity: string; finding: string; file?: string }> {
    const findings: Array<{
      severity: string;
      finding: string;
      file?: string;
    }> = [];
    const lines = text.split("\n");
    for (const line of lines) {
      const match = line.match(/\[(CRITICAL|HIGH|MEDIUM|LOW|INFO)\]\s*(.+)/i);
      if (match) {
        findings.push({
          severity: (match[1] ?? "INFO").toUpperCase(),
          finding: (match[2] ?? "").trim(),
        });
      }
    }
    return findings;
  }

  private async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    taskId: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const agent = this.activeAgents.get(taskId);
        if (agent) agent.abort();
        reject(new Error(`Task ${taskId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      fn()
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  /** Cancel the current orchestration */
  cancel(): void {
    this.abortController?.abort();
    // Abort all active agents
    for (const [taskId, agent] of this.activeAgents) {
      try {
        agent.abort();
      } catch {
        /* ignore */
      }
      this.currentDAG?.markCancelled(taskId);
    }
    this.activeAgents.clear();
  }

  private disposed = false;

  /**
   * Dispose the orchestrator: cancel in-flight work, drop listeners and
   * release the DAG reference so completed/cancelled sessions retain
   * nothing. Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.cancel();
    } catch {
      // best effort
    }
    this.listeners.clear();
    this.currentDAG = null;
    this.abortController = null;
  }

  /** Number of active listeners (lifecycle introspection for tests). */
  listenerCount(): number {
    return this.listeners.size;
  }

  /** Get the current task DAG */
  getDAG(): TaskDAG | null {
    return this.currentDAG;
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* don't break */
      }
    }
  }
}

// ============================================================================
// Structured Agent Task / Agent Result Contracts
// ============================================================================

/**
 * Result kind produced by a structured agent. Structured results carry only
 * typed, bounded fields so downstream agents and the Control Center can
 * consume them without parsing free text.
 */
export type AgentResultKind =
  | "plan"
  | "implementation"
  | "test_results"
  | "security_findings"
  | "review_finding"
  | "verification_verdict"
  | "completion"
  | "cancel";

/**
 * Type of review finding emitted by the Reviewer agent. Reviewer findings
 * drive the auto-fix loop: BLOCKER/HIGH findings are auto-fixed by the Fixer;
 * MEDIUM/LOW are reported but not auto-fixed.
 */
export type ReviewFindingSeverity = "BLOCKER" | "HIGH" | "MEDIUM" | "LOW";

export interface AgentResult {
  kind: AgentResultKind;
  summary: string;
  /** Structured fields that downstream agents and the Control Center rely on.
   *  Kept bounded so memory and context stays predictable.
   */
  data: Record<string, unknown>;
  /** Metadata for traceability (token counts, duration, correlation ids). */
  meta?: Record<string, unknown>;
  /** Evidence pointer for debugging (never the content itself). */
  evidenceRef?: string;
}

/**
 * Structured task input consumed by each specialized agent. Structured input
 * (no uncontrolled free text) so the DAG can thread only the data each
 * downstream agent needs.
 */
export interface AgentTask {
  id: string;
  agentRole: AgentRole;
  description: string;
  /** Direct deps that must complete first. The DAG schedules only tasks whose
   * deps are all completed (topological order); circular deps are rejected by
   * validate().
   */
  dependencies: string[];
  /** Context the agent receives (summary of upstream structured results). */
  context: AgentTaskContext;
  /** Optional overrides for bounded retries and timeouts. */
  options?: {
    maxRetries?: number;
    timeoutMs?: number;
    retryBackoffMs?: number;
  };
  status: TaskStatus;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  /** Structured output of the last successful run of this task. */
  result?: AgentResult;
}

/**
 * Conflict detection: two agents mutating the same file concurrently would
 * corrupt M5 changesets. Agents report the files they intend to mutate; the
 * orchestrator serializes overlapping writes with the M14 registry.
 */
export interface AgentUndoSet {
  /** File paths this agent will mutate during this task. */
  files: string[];
}

/**
 * Agent-role-specific permission profile. Maps each role to the minimal
 * tool permission levels it may exercise. The orchestrator never grants a
 * role more privilege than its policy allows.
 */
export interface RolePermissionProfile {
  readonly role: AgentRole;
  readonly toolLevels: ToolPermissionLevel[];
  /** Default permission decision when the role has no more specific rule. */
  readonly defaultDecision: PermissionDecisionType;
  readonly rationale: string;
}

export const ROLE_PERMISSION_PROFILES: RolePermissionProfile[] = [
  {
    role: "orchestrator",
    toolLevels: ["read", "write", "execute"],
    defaultDecision: "approve",
    rationale:
      "Coordinates, reads summaries, and approves final completion only.",
  },
  {
    role: "architect",
    toolLevels: ["read", "network"],
    defaultDecision: "deny",
    rationale:
      "Analyzes repo structure: read-only exploration with bounded search (search tools are read-level).",
  },
  {
    role: "coder",
    toolLevels: ["read", "write", "execute", "network"],
    defaultDecision: "approve",
    rationale:
      "Implements changes: reads, writes, and executes local tools up to bounded scope.",
  },
  {
    role: "tester",
    toolLevels: ["read", "execute"],
    defaultDecision: "deny",
    rationale:
      "Runs tests: read-only repository access plus bounded command execution.",
  },
  {
    role: "security",
    toolLevels: ["read"],
    defaultDecision: "deny",
    rationale:
      "Security review: reads changed files and runs read-only scans (no execution).",
  },
  {
    role: "reviewer",
    toolLevels: ["read"],
    defaultDecision: "deny",
    rationale: "Code review: read-only diff inspection.",
  },
  {
    role: "documentation",
    toolLevels: ["read", "write"],
    defaultDecision: "approve",
    rationale: "Documentation updates: reads and writes doc files only.",
  },
];

export function resolveRoleProfile(role: AgentRole): RolePermissionProfile {
  const match = ROLE_PERMISSION_PROFILES.find((p) => p.role === role);
  if (!match) {
    throw new Error(`No permission profile for role "${role}"`);
  }
  return match;
}

/**
 * Role tool allowlists over the ONE canonical registry
 * (`createCodePilotBuiltinTools`). No second tool system: child agents see a
 * filtered view of exactly the tools the single agent uses, and every
 * mutation still passes the host approval pipeline (deny-closed without it).
 *
 * - architect: read/search/context (no mutation)
 * - coder: read/edit/terminal under existing policies (mutations approved)
 * - tester: test/read/terminal (runs tests, never edits source)
 * - security: read-only scans
 * - reviewer: read/diff/test (read-only, never mutates)
 * - documentation: read + doc writes (approved like any write)
 * - orchestrator: read-only coordination
 */
const READ_ONLY_TOOLS: readonly string[] = [
  "read_files",
  "inspect_symbols",
  "search_codebase",
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "skills",
  "ask_question",
  "plan",
  "read_tool_output",
];

const WEB_TOOLS: readonly string[] = ["fetch_web_content", "web_search"];

const TERMINAL_TOOLS: readonly string[] = ["run_commands", "bash"];

const WRITE_TOOLS: readonly string[] = ["editor", "apply_patch"];

export const ROLE_TOOL_ALLOWLIST: Record<AgentRole, readonly string[]> = {
  orchestrator: READ_ONLY_TOOLS,
  architect: [...READ_ONLY_TOOLS, ...WEB_TOOLS],
  coder: [...READ_ONLY_TOOLS, ...WEB_TOOLS, ...WRITE_TOOLS, ...TERMINAL_TOOLS],
  tester: [...READ_ONLY_TOOLS, ...TERMINAL_TOOLS],
  security: READ_ONLY_TOOLS,
  reviewer: READ_ONLY_TOOLS,
  documentation: [...READ_ONLY_TOOLS, ...WRITE_TOOLS],
};

/** Tool names visible to a role (stable order, canonical registry subset). */
export function childAgentToolNames(role: AgentRole): string[] {
  return [...(ROLE_TOOL_ALLOWLIST[role] ?? READ_ONLY_TOOLS)];
}

/**
 * Build one role agent's tool set from the canonical registry, filtered to
 * the role allowlist. Mirrors CodePilotRuntime.buildNativeTools exactly:
 * web tools follow the same privacy rule (offered unless local-only mode),
 * and each owned (llm-flavored) tool is adapted to the native dispatcher
 * contract (required agentId, abort signal) the same way.
 */
export function buildChildAgentTools(
  role: AgentRole,
  cwd: string,
  privacyMode: CodePilotAgentConfig["privacyMode"],
  options?: {
    /**
     * Host ChangeSet staging bridge. When present the child's `editor` /
     * `apply_patch` are the SAME staged tools the main agent uses (proposal
     * only, no disk write). When absent the child gets NO write tool at all —
     * a missing ChangeSet bridge must never degrade into a direct write.
     */
    onWriteProposal?: WriteProposalSink;
    /** Effective agent mode — ASK/PLAN never advertise mutating tools. */
    agentMode?: CodePilotAgentConfig["agentMode"];
  },
): AgentTool[] {
  const allowed = new Set(childAgentToolNames(role));
  if (privacyMode === "local") {
    for (const web of WEB_TOOLS) allowed.delete(web);
  }
  // Model-contract parity with CodePilotRuntime: ASK/PLAN is read-only Q&A.
  // This is a visibility filter only — the M4 gate still evaluates every call.
  if (options?.agentMode === "ask" || options?.agentMode === "plan") {
    for (const mutating of MUTATING_TOOL_NAMES) allowed.delete(mutating);
  }
  const out: AgentTool[] = [];
  for (const owned of createCodePilotBuiltinTools({
    cwd,
    enableBash: allowed.has("bash"),
    enableWebFetch: WEB_TOOLS.some((w) => allowed.has(w)),
    privacyMode,
  })) {
    if (!allowed.has(owned.name)) continue;
    // The owned factory's editor/apply_patch are the un-staged direct-write
    // implementations. A child agent must never receive them — they are
    // replaced below by the ChangeSet-staged tools from the shared boundary.
    if (STAGED_WRITE_TOOL_NAMES.includes(owned.name as StagedWriteToolName)) {
      continue;
    }
    out.push({
      name: owned.name,
      description: owned.description ?? owned.name,
      inputSchema: owned.inputSchema ?? { type: "object" },
      ...(owned.timeoutMs !== undefined ? { timeoutMs: owned.timeoutMs } : {}),
      execute: async (input, context) => {
        // Same adaptation as the single-agent runtime: owned tools take an
        // all-optional context; the dispatcher provides agentId + signal.
        return await owned.execute(input, {
          sessionId: context.sessionId,
          agentId: context.agentId,
          toolCallId: context.toolCallId,
          signal: context.signal,
        });
      },
    });
  }
  // The SAME ChangeSet staging boundary the main agent uses. Empty list when
  // the host has no bridge, so the child simply cannot write.
  for (const staged of createStagedWriteTools({
    workspaceRoot: cwd,
    ...(options?.onWriteProposal
      ? { onWriteProposal: options.onWriteProposal }
      : {}),
  })) {
    if (!allowed.has(staged.name)) continue;
    out.push(staged);
  }
  return out;
}

/**
 * Build a child agent's full config from the orchestrator base config.
 * Provider identity, workspace root, privacy mode, and — critically — the
 * host approval pipeline are inherited unchanged, so a child agent's
 * mutations pass the SAME ToolGate → M4/M5 boundary as the normal agent.
 * Without a configured pipeline the agent's gate denies closed.
 */
export function buildChildAgentConfig(
  base: Omit<CodePilotAgentConfig, "agentMode">,
  role: AgentRole,
  mode: "plan" | "act" | "review",
): CodePilotAgentConfig {
  const agentMode: CodePilotAgentConfig["agentMode"] =
    mode === "plan" ? "ask" : mode;
  return {
    providerId: base.providerId,
    modelId: base.modelId,
    ...(base.apiKey !== undefined ? { apiKey: base.apiKey } : {}),
    ...(base.baseUrl !== undefined ? { baseUrl: base.baseUrl } : {}),
    workspaceRoot: base.workspaceRoot,
    privacyMode: base.privacyMode,
    agentMode,
    maxIterations: base.maxIterations ?? 15,
    ...(base.temperature !== undefined
      ? { temperature: base.temperature }
      : {}),
    systemPrompt: ROLE_SYSTEM_PROMPTS[role],
    extraTools: buildChildAgentTools(
      role,
      base.workspaceRoot,
      base.privacyMode,
      {
        agentMode,
        // The SAME ChangeSet bridge the main-agent runtime uses — inherited,
        // never blanked. Without it the child simply has no write tools.
        ...(base.onWriteProposal !== undefined
          ? { onWriteProposal: base.onWriteProposal }
          : {}),
      },
    ),
    ...(base.requestApproval !== undefined
      ? { requestApproval: base.requestApproval }
      : {}),
    ...(base.onWriteProposal !== undefined
      ? { onWriteProposal: base.onWriteProposal }
      : {}),
    // H2/Phase 7: the orchestrator child runs the SAME remote provider as
    // its base config — explicit host overrides for redaction and model
    // limits must travel with it. When absent the child still falls back
    // to the canonical classification (isRemoteProvider) and the curated
    // catalogue inside CodePilotAgent.execute(), so the default path is
    // unchanged.
    ...(base.redactToolResults !== undefined
      ? { redactToolResults: base.redactToolResults }
      : {}),
    ...(base.modelContextWindow !== undefined
      ? { modelContextWindow: base.modelContextWindow }
      : {}),
    ...(base.maxOutputTokens !== undefined
      ? { maxOutputTokens: base.maxOutputTokens }
      : {}),
  };
}

/**
 * Conflict detection registry (M14). The orchestrator uses this to serialize
 * overlapping file mutations across parallel agents. It is the single point
 * where the DAG says "do not run these two tasks at the same time".
 */
export class ConflictDetector {
  private readonly registry = new FileLockRegistry();
  private readonly ownerTaskId: string;

  constructor(ownerTaskId: string) {
    this.ownerTaskId = ownerTaskId;
  }

  /** The task this detector is coordinating; forwarded to acquire/release.
   */
  get taskOwner(): string {
    return this.ownerTaskId;
  }

  /** Acquire locks for all files a task will mutate, atomically. Throws
   * FileConflictError if another live task holds any of them.
   */
  acquire(files: readonly string[]): string[] {
    return this.registry.acquire(this.ownerTaskId, Files.make(files));
  }

  /** Try-acquire; returns locked files or null on conflict. */
  tryAcquire(files: readonly string[]): string[] | null {
    return this.registry.tryAcquire(this.ownerTaskId, Files.make(files));
  }

  /**
   * Acquire with bounded wait. Returns locked files or throws on timeout.
   * Preferred for writer agents where a retry is acceptable but never a
   * partial mutation.
   */
  async acquireWithWait(
    files: readonly string[],
    timeoutMs = 30_000,
  ): Promise<string[]> {
    return this.registry.acquireWithWait(
      this.ownerTaskId,
      Files.make(files),
      timeoutMs,
    );
  }

  /** Release all locks held by a task on completion/failure/cancellation. */
  release(): void {
    this.registry.release(this.ownerTaskId);
  }

  /** Release the specific files a task mutated." } */
  releaseFiles(files: readonly string[]): void {
    this.registry.releaseFiles(this.ownerTaskId, Files.make(files));
  }

  /** Which live task holds a file, or null. */
  holder(file: string): string | null {
    return this.registry.holder(file) ?? null;
  }

  /** Snapshot of the lock store for the UI (read-only view, never storage). */
  snapshot(): Array<{ file: string; holderTaskId: string | null }> {
    return [...this.registry.locksView.entries()].map(
      ([file, holderTaskId]) => ({
        file,
        holderTaskId,
      }),
    );
  }
}

/**
 * Small normalizer for paths so lock comparison is host-agnostic (M14 already
 * lowercases and replaces backslashes; this guarantees stable keys).
 */
const Files = {
  make(paths: readonly string[]): string[] {
    return [...new Set(paths.map((p) => p.replace(/\\/g, "/").toLowerCase()))];
  },
  unique(paths: readonly string[]): string[] {
    return [...new Set(paths)];
  },
};

/**
 * Deadlock detection for the bounded-parallel scheduler:
 * - Totally-ordered task ids (pending < running < waiting < blocked < completed
 *   < failed < cancelled < retrying) give a well-founded partial order.
 * - If any waiting task's full lock set is held by a task that is itself
 *   waiting on it, we have a cycle -> reject with a typed conflict.
 */
/**
 * Deadlock detection for the bounded-parallel scheduler.
 *
 * - Totally-ordered task ids (pending < running < waiting < blocked < completed
 *   < failed < cancelled < retrying) give a well-founded partial order.
 * - If a waiting task holds a lock held by another waiting task, we have a
 *   cycle -> reject with a typed conflict.
 *
 * `holderOf` resolves which live task holds a file (or null); the caller
 * supplies it so this pure function stays host-agnostic (M14's lock store is
 * private to the ConflictDetector).
 */
export function isDeadlock(
  dag: TaskDAG,
  waitingIds: readonly string[],
  locks: ReadonlyMap<string, string>,
): boolean {
  // Exactly-ordered task ids (pending < running < waiting < blocked < completed
  // < failed < cancelled < retrying) give a well-founded partial order, so a
  // wait-for cycle is a deadlock. A waiting task A waits on B when B holds a
  // file A needs (and B is itself waiting), and so on recursively. `locks` is
  // the ConflictDetector's current lock store (file -> holder task id).
  const waiting = new Set(waitingIds.map((i) => i.toLowerCase()));
  const visiting = new Set<string>();
  const stack: string[] = [];

  // Map a dependency id to the task that holds a lock on it (if any).
  const heldBy = (depId: string): string | null => {
    const h = locks.get(depId.toLowerCase());
    return h || null;
  };

  const visit = (taskId: string): boolean => {
    if (!waiting.has(taskId.toLowerCase())) return false;
    if (visiting.has(taskId)) return true; // cycle
    if (stack.includes(taskId)) return false;
    visiting.add(taskId);
    stack.push(taskId);

    // Explore the wait-for edges from this task.
    const deps = dag.getTask(taskId)?.dependencies ?? [];
    for (const depId of deps) {
      // A holds locks on the files its dependency targets; if that holder is
      // another waiting task, we wait on it.
      const holder = heldBy(depId);
      if (holder && holder !== taskId && waiting.has(holder)) {
        if (visit(holder)) return true;
      }
      // Follow the dependency task's own waiting (transitive).
      const nested = dag.getTask(depId)?.dependencies ?? [];
      for (const wdepId of nested) {
        if (waiting.has(wdepId.toLowerCase())) {
          if (visit(wdepId)) return true;
        }
      }
    }
    stack.pop();
    return false;
  };

  for (const id of waitingIds) {
    if (visit(id)) return true;
  }
  return false;
}

/**
 * Tester context-engine integration: selects the concrete test cases the
 * tester agent must execute by request from the context engine (M12/M8), rather
 * than re-running the whole suite. The tester agent's prompt + context carries
 * the generated case identifiers; the actual assertion run is delegated to the
 * context engine's executor. This keeps test selection and test execution in
 * their own engines.
 *
 * TESTER_CATEGORIES is the filter the context engine queries for. Each
 * category maps to a curated set of test requests (unit, integration, e2e,
 * regression). The tester agent consumes a compact list of case ids + names.
 */
export const TESTER_CATEGORIES = [
  "unit",
  "integration",
  "e2e",
  "regression",
] as const;

export type TestCategory = (typeof TESTER_CATEGORIES)[number];

/**
 * Failure classification for tester output. The tester agent reports a
 * machine-readable failure blob; classifyTesterFailure maps the class to a
 * bounded verdict the DAG and control center can act on.
 */
export interface TesterFailureClass {
  category:
    "flaky" | "assertion" | "environment" | "infrastructure" | "unknown";
  confidence: number;
  hints: string[];
}

export function classifyTesterFailure(
  output: string,
  failed: number,
  errors: string[],
): TesterFailureClass {
  const all = errors.concat(output.split(/\r?\n/));
  const flakySignals = [
    "previously passing",
    "intermittent",
    "flaky",
    "race condition",
    "timing",
    "non-deterministic",
  ];
  const assertionSignals = [
    "AssertionError",
    "expect(",
    "toEqual",
    "toThrow",
    "AssertionFailedError",
    "failing:",
  ];
  const environmentSignals = [
    "ENOTDIR",
    "ENOENT",
    "EPERM",
    "EACCES",
    "EADDRINUSE",
    "ECONNREFUSED",
    "connection",
    "port",
    "socket",
    "container",
    "docker",
  ];
  const infrastructureSignals = [
    "ci",
    "workflow",
    "runner",
    "github actions",
    "jenkins",
    "build server",
  ];

  let flaky = 0;
  let assertion = 0;
  let environment = 0;
  let infrastructure = 0;
  for (const line of all) {
    const lower = line.toLowerCase();
    for (const s of flakySignals) if (lower.includes(s)) flaky++;
    for (const s of assertionSignals) if (lower.includes(s)) assertion++;
    for (const s of environmentSignals) if (lower.includes(s)) environment++;
    for (const s of infrastructureSignals)
      if (lower.includes(s)) infrastructure++;
  }

  const total = flaky + assertion + environment + infrastructure;
  if (total === 0) {
    return {
      category: failed > 0 ? "assertion" : "unknown",
      confidence: 0.5,
      hints: ["no recognizable failure signal; defaulting based on count"],
    };
  }
  const votes: Record<TesterFailureClass["category"], number> = {
    flaky,
    assertion,
    environment,
    infrastructure,
    unknown: 0,
  };
  let best: TesterFailureClass["category"] = "unknown";
  let bestVotes = -1;
  for (const [category, count] of Object.entries(votes) as Array<
    [TesterFailureClass["category"], number]
  >) {
    // GTE keeps the original reduce's last-wins tie order.
    if (count >= bestVotes) {
      bestVotes = count;
      best = category;
    }
  }
  const confidence = total > 0 ? Math.min(1, votes[best] / total + 0.1) : 0.5;
  const category = best;

  const hints = [
    `category=${category} votes=${votes[category]}"`,
    `assert=${assertion} env=${environment} infra=${infrastructure} flaky=${flaky}`,
  ];

  return { category, confidence, hints };
}

/**
 * Reviewer structured findings. Reviewer reports only typed findings so the
 * auto-fix loop (Fixer) and Control Center can act without parsing prose.
 */
export interface ReviewerFinding {
  severity: ReviewFindingSeverity;
  /** Short human-readable rule that fired. */
  rule: string;
  /** Affected file (bounded).
   */
  file?: string;
  /** Suggested fix (bounded, for auto-fix by the Fixer agent).
   */
  suggestedFix?: string;
  /** Evidence pointer (never the content itself).
   */
  evidenceRef?: string;
}

/**
 * Structured reviewer result. The reviewer agent emits this as data rather
 * than a single free-text blob.
 */
export interface ReviewerResult {
  findings: ReviewerFinding[];
  summary: string;
  meta?: Record<string, unknown>;
}

/**
 * Build the reviewer's finding from a structured review payload. The Reviewer
 * agent keeps its own prompt and produces the payload; this transforms it into
 * the bounded ActorResult for persistence and the Control Center.
 *
 * NOTE: the Reviewer agent itself is the system prompt owner; this factory is
 * a pure pass-through for tests and for the auto-fix loop.
 */
export function buildReviewerResult(payload: unknown): ReviewerResult {
  // The agent's structured output is unbounded text in practice, so we
  // defensively parse only a well-known JSON surface.
  const findings: ReviewerFinding[] = [];
  if (typeof payload === "object" && payload !== null) {
    const rec = payload as Record<string, unknown>;
    const arr = Array.isArray(rec.findings) ? (rec.findings as unknown[]) : [];
    for (const f of arr) {
      if (typeof f === "object" && f !== null) {
        const fr = f as Record<string, unknown>;
        const severity =
          typeof fr.severity === "string" &&
          ["BLOCKER", "HIGH", "MEDIUM", "LOW"].includes(fr.severity)
            ? (fr.severity as ReviewFindingSeverity)
            : "MEDIUM";
        findings.push({
          severity,
          rule: typeof fr.rule === "string" ? fr.rule : "",
          file: typeof fr.file === "string" ? fr.file : undefined,
          suggestedFix:
            typeof fr.suggestedFix === "string" ? fr.suggestedFix : undefined,
          evidenceRef:
            typeof fr.evidenceRef === "string" ? fr.evidenceRef : undefined,
        });
      }
    }
  }
  const summary =
    typeof payload === "object" &&
    payload !== null &&
    "summary" in (payload as Record<string, unknown>)
      ? String((payload as Record<string, unknown>).summary ?? "")
      : "";

  return { findings, summary };
}

/**
 * Reviewer auto-fix gate: only BLOCKER and HIGH findings are auto-fixed by the
 * Fixer agent. MEDIUM/LOW are reported but never mutated automatically.
 */
export function isAutoFixableSeverity(sev: ReviewFindingSeverity): boolean {
  return sev === "BLOCKER" || sev === "HIGH";
}

/**
 * Fixer bounded-repair implementation. Reuses the existing SelfHealingEngine
 * ceilings (MAX_AUTO_REPAIR_ATTEMPTS, MAX_SAME_SIGNATURE_REPEATS) so the
 * orchestrator never repairs unboundedly. The Fixer is a bounded retry loop:
 * it re-runs the failing task once per attempt up to the self-healing ceiling,
 * and de-duplicates identical failure signatures to avoid an infinite loop.
 */
export class Fixer {
  /** Max auto-repair attempts (M13). */
  readonly maxAttempts: number;
  /** Bound on identical failure-signature repeats (M10 loop guard). */
  readonly maxSameSignatureRepeats: number;
  /** Coordinator for conflict serialization (M14). */
  readonly conflictDetector: ConflictDetector;

  constructor(
    maxAttempts: number = MAX_AUTO_REPAIR_ATTEMPTS,
    maxSameSignatureRepeats: number = MAX_SAME_SIGNATURE_REPEATS,
    conflictDetector: ConflictDetector = new ConflictDetector("__root__"),
  ) {
    this.maxAttempts = maxAttempts;
    this.maxSameSignatureRepeats = maxSameSignatureRepeats;
    this.conflictDetector = conflictDetector;
  }

  /**
   * Run the fixer. `attempt` is the orchestrator's current attempt number;
   * `onRepair` applies the suggested fix and returns a result. Bounded by the
   * self-healing ceilings and cancellation.
   */
  async run(
    task: AgentTask,
    validate: () => Promise<ValidationResult>,
    diagnose: (
      failure: ValidationResult | Record<string, unknown>,
      attemptNumber: number,
      previousAttempts: RepairAttempt[],
    ) => Promise<{
      diagnosis: string;
      repairDescription: string;
      filesChanged: string[];
    }>,
    applyRepair: RepairApplier,
  ): Promise<FixerResult> {
    const attempt = task.options?.maxRetries ?? this.maxAttempts;

    const diagnosis = await withTimeout(
      () => diagnose(task.result?.data ?? {}, attempt, []),
      { timeoutMs: task.options?.timeoutMs ?? this.maxAttempts * 30_000 },
    );

    const repair = await withTimeout(
      () =>
        applyRepair(
          diagnosis.diagnosis,
          diagnosis.repairDescription,
          diagnosis.filesChanged,
        ),
      { timeoutMs: task.options?.timeoutMs ?? this.maxAttempts * 30_000 },
    );

    if (!repair.success) {
      return {
        succeeded: false,
        attempt,
        error: repair.error ?? "repair failed",
      };
    }

    const validation = await withTimeout(validate, {
      timeoutMs: task.options?.timeoutMs ?? this.maxAttempts * 30_000,
    });

    if (validation.passed) {
      return {
        succeeded: true,
        attempt,
        validation,
      };
    }

    return {
      succeeded: false,
      attempt,
      validation,
      error: `validation still failing after repair: ${JSON.stringify(validation)}`,
    };
  }
}

/**
 * Outcome of a bounded fixer run.
 */
export interface FixerResult {
  succeeded: boolean;
  attempt: number;
  validation?: ValidationResult;
  error?: string;
}

/**
 * Cancellation propagation: the orchestrator cancels the whole DAG when the
 * top-level `cancel()` is called. Each task owns a CancellationToken sourced
 * from the shared cancellation source, so cancelling the orchestrator cancels
 * every active agent and any in-flight tool execution via the M3 executor.
 */
export class TaskCancellationCoordinator {
  private readonly source = new CancellationSource();
  private readonly timers = new Map<string, TimeoutManager>();

  get token(): CancellationToken {
    return this.source.token;
  }

  /** Attach a child cancellation source for a task; returns its token.
   */
  attachTaskSource(taskId: string): CancellationToken {
    const source = new CancellationSource();
    // Surface to the top-level token for observability.
    source.token.onCancelled(() => {
      this.source.cancel(`task ${taskId} cancelled`);
    });
    return source.token;
  }

  /**
   * Start a timeout; returns the timer so it can be disposed on completion.
   */
  startTimer(
    taskId: string,
    timeoutMs: number,
    reason: string,
  ): TimeoutManager {
    // Do not override an already-cancelled token.
    if (this.source.isCancelled) {
      const t = new TimeoutManager(this.source, 0);
      t.dispose();
      return t;
    }
    const timer = new TimeoutManager(this.source, timeoutMs, reason);
    this.timers.set(taskId, timer);
    return timer;
  }

  cancelTask(taskId: string): boolean {
    if (this.source.isCancelled) return false;
    const timer = this.timers.get(taskId);
    if (timer) {
      timer.dispose();
      this.timers.delete(taskId);
    }
    this.source.cancel(`task ${taskId} cancelled`);
    return true;
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      timer.dispose();
    }
    this.timers.clear();
    this.source.dispose();
  }
}

/**
 * Orchestrator timeline entry for the Control Center visualization.
 */
export interface OrchestratorTimelineEntry {
  taskId: string;
  agentRole: AgentRole;
  status: TaskStatus;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  error?: string;
  resultSummary?: string;
}

/**
 * Observable orchestrator that streams timeline entries to subscribers (the
 * Control Center webview) and coordinates cancellation across the whole DAG.
 *
 * This class wraps the existing MultiAgentOrchestrator (still in the same
 * file) and adds timeline + cancellation surface. A single orchestrator
 * instance holds one wrapper; the wrapped MultiAgentOrchestrator stays the
 * execution engine, unchanged.
 */
export class ObservableMultiAgentOrchestrator {
  private readonly wrapped: MultiAgentOrchestrator;
  private readonly timeline: OrchestratorTimelineEntry[] = [];
  private readonly listeners = new Set<
    (entry: OrchestratorTimelineEntry) => void
  >();
  private readonly cancellation = new TaskCancellationCoordinator();
  private disposed = false;

  constructor(orch: MultiAgentOrchestrator) {
    this.wrapped = orch;
  }

  /** Return the underlying MultiAgentOrchestrator (execution engine). */
  get wrappedOrchestrator(): MultiAgentOrchestrator {
    return this.wrapped;
  }

  /** Start a task with an explicit correlation id for tracing. */
  async executeWithCorrelation(
    description: string,
    mode: "plan" | "act" | "review" = "act",
    opts?: { roles?: AgentRole[]; correlationId?: string },
  ): Promise<{
    results: Array<{
      role: AgentRole;
      task: string;
      result: string;
      success: boolean;
    }>;
    finalResult: string;
    dag: TaskDAG;
    outcome: OrchestrationSummary;
  }> {
    if (this.disposed) {
      throw new Error("Orchestrator disposed");
    }
    const correlationId = opts?.correlationId ?? `corr-${Date.now()}`;
    const result = await this.wrapped.execute(description, mode, opts);

    // Build timeline from the DAG statuses — the entry reflects the real
    // outcome, never a blanket "completed".
    const timelineStatus =
      result.outcome.outcome === "COMPLETED"
        ? "completed"
        : result.outcome.outcome === "CANCELLED"
          ? "cancelled"
          : "failed";
    this.pushTimeline({
      taskId: correlationId,
      agentRole: "orchestrator",
      status: timelineStatus,
      startedAt: Date.now(),
      completedAt: Date.now(),
      error:
        result.outcome.outcome === "COMPLETED" ? undefined : result.finalResult,
      resultSummary: result.finalResult.substring(0, 200),
    });

    return result;
  }

  /** Agenda: add a timeline entry and notify subscribers. */
  private pushTimeline(entry: OrchestratorTimelineEntry): void {
    this.timeline.push(entry);
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        /* don't break */
      }
    }
  }

  /** Subscribe to timeline entries for the Control Center. */
  subscribeTimeline(
    listener: (entry: OrchestratorTimelineEntry) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Snapshot of the timeline for the Control Center panel. */
  snapshotTimeline(): OrchestratorTimelineEntry[] {
    return [...this.timeline];
  }

  /** Current cancellation status adapted from the coordinator. */
  isCancelled(): boolean {
    return this.cancellation.token.isCancelled;
  }

  /** Cancel the entire orchestration graph. */
  cancel(): void {
    this.cancellation.cancelTask("__root__");
    this.wrapped.cancel();
  }

  /** Dispose: cancel, drop listeners, release the wrapped engine. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.cancel();
    } catch {
      // best effort
    }
    this.cancellation.dispose();
    this.listeners.clear();
  }

  /** Number of active timeline listeners (lifecycle introspection for tests). */
  listenerCount(): number {
    return this.listeners.size;
  }
}

/**
 * Per-task persistence: serializes the AgentTask + AgentResult of a completed
 * task into the existing TaskStore (M12) so a cancelled/in-progress session can
 * resume or inspect what the DAG produced. Bounded serialization uses the
 * task-store redaction so no secrets or unbounded content survive.
 */
export class TaskPersistence {
  constructor(private readonly store: TaskStore) {}

  /**
   * Persist a completed agent task into the task store. The TaskStore creates
   * a title + modelConfig record; we supply a bounded title and an empty
   * modelConfig here so the orchestrator task is stored without unbounded
   * content. Returns the new task id or null on error.
   */
  async persistTask(
    task: AgentTask,
    result: AgentResult,
  ): Promise<string | null> {
    if (!this.store) return null;
    try {
      const title = `${task.agentRole}: ${task.description.substring(0, 200)}`;
      const modelConfig = redactForPersistence({
        role: task.agentRole,
        resultKind: result.kind,
        resultSummary: result.summary,
        resultEvidenceRef: result.evidenceRef,
      });
      const stored = await this.store.create(title, modelConfig);
      return stored?.id ?? null;
    } catch {
      return null;
    }
  }

  /** Load the persisted record for a task id. */
  getPersistedTask(taskId: string): Promise<PersistedTask | null> {
    if (!this.store) return Promise.resolve(null);
    return this.store.get(taskId) ?? null;
  }

  /** List persisted tasks, newest first. */
  async listTasks(): Promise<PersistedTask[]> {
    if (!this.store) return [];
    return (await this.store.list()).reverse();
  }
}

/**
 * M4-gated tool execution adapter for agents. Each specialized agent
 * (coder / tester / security / reviewer) may perform tool actions. The
 * adapter wraps a ToolExecutionService with the role-specific Permission
 * Policy so agents never escalate beyond their RolePermissionProfile.
 *
 * This intentionally routes tool calls through the M4 pipeline: policy
 * evaluation, optional user approval (via ApprovalManager), workspace/command
 * boundaries, and secret redaction. It never bypasses M4.
 */
export class RoleScopedToolExecutor {
  private readonly service: ToolExecutionService;
  private readonly manager: ToolPermissionManager;
  private readonly pipeline?: M4PermissionPipeline;
  private readonly role: AgentRole;
  private readonly registry: ToolRegistry;

  constructor(
    registry: ToolRegistry,
    audit: ToolAuditLogger,
    role: AgentRole,
    options: ToolExecutorOptions = {},
    pipeline?: M4PermissionPipeline,
  ) {
    this.role = role;
    this.registry = registry;
    const profile = resolveRoleProfile(role);

    // ToolPermissionManager holds its own rules keyed by toolId; the executor
    // also keeps the registry for tool resolution. Only pass the role's
    // allowed levels as levelPolicies so the manager never grants more than
    // the profile permits.
    this.manager = new ToolPermissionManager({
      defaultDecision: profile.defaultDecision,
      levelPolicies: profile.toolLevels.reduce(
        (acc, level) => {
          acc[level] = level === "read" ? "allow" : "approve";
          return acc;
        },
        {} as Partial<Record<ToolPermissionLevel, PermissionDecisionType>>,
      ),
    });

    this.service = new ToolExecutionService(
      registry,
      this.manager,
      audit,
      options,
      pipeline,
    );
    this.pipeline = pipeline;
  }

  get executionService(): ToolExecutionService {
    return this.service;
  }

  get permissionManager(): ToolPermissionManager {
    return this.manager;
  }

  get permissionPipeline(): M4PermissionPipeline | undefined {
    return this.pipeline;
  }

  /** Subscribe to tool events (for the Control Center). */
  subscribe(listener: ToolEventListener): () => void {
    return this.service.subscribe(listener);
  }

  listenerCount(): number {
    return this.service.listenerCount();
  }

  /** Execute a tool for this agent, honoring M4 policy + the role profile. */
  async execute(
    toolId: string,
    input: unknown,
    options: ExecuteOptions = {},
  ): Promise<ToolResult> {
    const executionId = `tool-exec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const denied = (reason: string): ToolResult => ({
      executionId,
      toolId,
      status: "denied",
      error: toolError("PERMISSION_DENIED", reason, executionId, {
        recoverable: false,
      }),
      startedAt: Date.now(),
      completedAt: Date.now(),
      durationMs: 0,
      retriesUsed: 0,
    });
    // Fail closed on unknown tools: no level can be established, so no
    // policy can authorize the call.
    const registered = this.registry.get(toolId);
    if (!registered) {
      return denied(
        `Role ${this.role} is not permitted to execute unknown tool '${toolId}'`,
      );
    }
    const decision = this.manager.decide(
      toolId,
      registered.permission.level,
      executionId,
      options.taskId,
    );
    if (decision.type === "deny") {
      return denied(
        `Role ${this.role} is not permitted to execute ${toolId}: ${decision.reason}`,
      );
    }
    // M4 pipeline performs policy + approval + boundaries before the executor.
    if (this.pipeline) {
      const m4Decision = await this.pipeline.evaluate({
        toolId,
        executionId: `task-${Date.now()}`,
        sessionId: options.sessionId,
        taskId: options.taskId,
        input,
        cwd: options.cwd,
      });
      if (!m4Decision.approved) {
        return denied(
          `M4 pipeline denied execution of ${toolId}: ${m4Decision.reason ?? "denied"}`,
        );
      }
    }
    return this.service.execute(toolId, input, options);
  }

  /** Cancel an in-flight execution by execution id. */
  cancel(executionId: string, reason = "Cancelled by orchestrator"): boolean {
    return this.service.cancel(executionId, reason);
  }
}

/**
 * Rebalanced scheduler: distributes bounded-parallel DAG tasks across a
 * configurable number of worker slots, respecting the per-role permission
 * profile and the conflict (lock) detector. This is the M7/N scheduler that
 * keeps the DAG's topological order while honoring the concurrency bound.
 */
export class RebalanceScheduler {
  private readonly dag: TaskDAG;
  private readonly slots: number;
  private readonly conflict: ConflictDetector;
  private readonly roleProfiles: Map<AgentRole, RolePermissionProfile>;

  /** The conflict detector this scheduler serializes against.
   */
  get conflictDetector(): ConflictDetector {
    return this.conflict;
  }

  constructor(
    dag: TaskDAG,
    options: {
      maxConcurrency?: number;
      conflict?: ConflictDetector;
    } = {},
  ) {
    this.dag = dag;
    this.slots = options.maxConcurrency ?? 2;
    this.conflict =
      options.conflict ?? new ConflictDetector("__orchestrator__");
    this.roleProfiles = new Map(
      ROLE_PERMISSION_PROFILES.map((p) => [p.role, p]),
    );
  }

  /**
   * Produce the next batch of runnable tasks under bounded concurrency.
   * Tasks are chosen in priority order among those whose dependencies are met.
   */
  nextBatch(): TaskNode[] {
    const ready = this.dag.getReadyTasks();
    if (ready.length === 0) return [];
    // Sort by priority then id for stable, deterministic ordering.
    ready.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    return ready.slice(0, this.slots);
  }

  /**
   * Check whether adding `task` to the currently-running set would create a
   * lock conflict or a deadlock. Returns null on success.
   */
  checkConflict(
    task: TaskNode,
    running: readonly TaskNode[],
  ): FileConflictError | null {
    if (task.dependencies.some((d) => running.some((r) => r.id === d))) {
      return new FileConflictError(
        task.id,
        task.dependencies,
        "dependency-not-finished",
      );
    }
    return null;
  }

  /**
   * List the permission profile for each role in the DAG, keyed by task id.
   * Used by the Control Center to show what each agent may touch.
   */
  taskProfiles(): Array<{
    taskId: string;
    role: AgentRole;
    profile: RolePermissionProfile;
  }> {
    return this.dag.getAllTasks().map((t) => ({
      taskId: t.id,
      role: t.agentRole,
      profile:
        this.roleProfiles.get(t.agentRole) ?? resolveRoleProfile(t.agentRole),
    }));
  }
}

/**
 * Correlation-aware task context builder. When a caller supplies a
 * correlation id, the orchestrator attaches it to every timeline entry,
 * agent usage, and tool execution id so the Control Center can trace one
 * request end-to-end across agents and the tool executor.
 */
export interface CorrelationContext {
  correlationId: string;
  traceParent?: string;
  traceState?: string;
}

export function useCorrelationId(
  corr: string | undefined,
  fallback: string,
): CorrelationContext {
  const correlationId = corr?.trim() ?? fallback;
  if (correlationId.length === 0) {
    throw new Error("correlationId must not be empty");
  }
  return { correlationId };
}
