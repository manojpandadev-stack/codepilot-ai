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
  | "retrying";

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
   */
  async execute(
    description: string,
    mode: "plan" | "act" | "review" = "act",
  ): Promise<{
    results: Array<{
      role: AgentRole;
      task: string;
      result: string;
      success: boolean;
    }>;
    finalResult: string;
    dag: TaskDAG;
  }> {
    this.abortController = new AbortController();
    this.activeAgents.clear();

    // Classify the task
    const roles = TaskDAG.classifyTask(description);
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

          this.currentDAG.markFailed(task.id, error);
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

    // Build final result from last completed agent
    const completedResults = results.filter((r) => r.success);
    const lastResult = completedResults[completedResults.length - 1];
    const finalResult =
      lastResult?.result ?? "Orchestration completed with failures";

    const hasFailure = this.currentDAG!.hasFailures();
    if (hasFailure) {
      this.emit({
        type: "error",
        error: "Orchestration completed with failures",
        recoverable: true,
      });
    } else {
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
    }

    return { results, finalResult, dag: this.currentDAG };
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

    // Create and initialize agent
    const agent = new CodePilotAgent({
      ...this.baseConfig,
      agentMode: mode === "plan" ? "ask" : mode,
      maxIterations: 15,
      systemPrompt: ROLE_SYSTEM_PROMPTS[task.agentRole],
    });
    this.activeAgents.set(task.id, agent);

    try {
      await agent.initialize();

      // Execute with timeout
      const resultText = await this.executeWithTimeout(
        () => agent.run(prompt).then((r) => r.text),
        task.timeoutMs || this.config.taskTimeoutMs,
        task.id,
      );

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

      // Check retry
      if (task.retryCount < task.maxRetries) {
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

      this.currentDAG!.markFailed(task.id, error);
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
