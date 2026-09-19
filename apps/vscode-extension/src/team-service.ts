/**
 * M14 — TeamService: extension-host backend for the Team (multi-agent) UI.
 *
 * The SINGLE source of truth for team state. The WebView never holds
 * authoritative state: every create/start/cancel/retry/remove request flows
 * WebView → validated extension handler → here → MultiAgentOrchestrator
 * (existing M14 engine — never replaced, never duplicated) → CodePilotAgent
 * → beforeTool → M4 → ToolExecutionService → side effect.
 *
 * Security properties (never weaken):
 * - Agent execution uses ONLY the injected base config, which the extension
 *   wires to the SAME M4 live bridge as single-agent turns (see
 *   buildTeamAgentConfig). There is no second permission universe.
 * - File locks are REAL: a per-run FileLockRegistry. Concurrent tasks that
 *   claim the same file are refused at creation; holds are acquired when a
 *   task starts and released on completion/failure/cancellation/dispose.
 *   The frontend can never override locks (it only renders snapshots).
 * - Team file declarations must be workspace-relative (no absolute paths,
 *   no `..`). Tool inputs and secrets are never included in views;
 *   persistence goes through M12 TaskStore (which redacts secrets).
 * - Mutations validate team/run/task identity; stale runIds (replays) and
 *   cross-task access are rejected.
 */

import { TaskDAG } from "@codepilot/agent-runtime";
import type {
  AgentEventListener,
  AgentRole,
  CodePilotAgentConfig,
  TaskNode,
  TaskStatus,
} from "@codepilot/agent-runtime";
import { FileLockRegistry } from "@codepilot/agent-runtime";
import { TaskStore } from "@codepilot/agent-runtime";

// ============================================================================
// Roles (M14 engine roles with UI-friendly labels)
// ============================================================================

export const TEAM_ROLES = [
  "architect",
  "coder",
  "tester",
  "security",
  "reviewer",
  "documentation",
] as const;

export type TeamRole = (typeof TEAM_ROLES)[number];

export const TEAM_ROLE_LABELS: Record<TeamRole, string> = {
  architect: "Planner",
  coder: "Implementer",
  tester: "Tester",
  security: "Security",
  reviewer: "Reviewer",
  documentation: "Docs",
};

function isTeamRole(value: unknown): value is TeamRole {
  return (
    typeof value === "string" &&
    (TEAM_ROLES as readonly string[]).includes(value)
  );
}

// ============================================================================
// View types (wire format — mirrors the WebView contract)
// ============================================================================

export type TeamStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type TeamMode = "plan" | "act" | "review";

export interface TeamTaskView {
  taskId: string;
  role: AgentRole;
  roleLabel: string;
  description: string;
  dependencies: string[];
  dependents: string[];
  /** DAG depth (0 = roots). Drives the tree/level rendering. */
  level: number;
  status: TaskStatus;
  retryCount: number;
  maxRetries: number;
  startedAtMs?: number;
  completedAtMs?: number;
  /** Declared files + files parsed from the completed result. */
  files: string[];
  /** Lock conflict holder, when acquisition failed. */
  conflictWith?: string;
  error?: string;
  /** Bounded result excerpt (never tool inputs, never secrets). */
  resultExcerpt?: string;
}

export interface TeamLockView {
  file: string;
  holderTaskId: string;
  holderRole: string;
  acquiredAtMs: number;
}

export interface TeamView {
  teamId: string;
  /** M12 TaskStore record id (persistence identity). */
  taskId: string;
  objective: string;
  mode: TeamMode;
  status: TeamStatus;
  roles: TeamRole[];
  maxConcurrency: number;
  tasks: TeamTaskView[];
  locks: TeamLockView[];
  runId?: string;
  runCount: number;
  createdAtMs: number;
  updatedAtMs: number;
  completedCount: number;
  failedCount: number;
  error?: string;
}

export type TeamEventType =
  | "team/created"
  | "team/started"
  | "team/task_updated"
  | "team/completed"
  | "team/failed"
  | "team/cancelled"
  | "team/removed";

export interface TeamEvent {
  type: TeamEventType;
  teamId: string;
  runId?: string;
  taskId?: string;
  status?: TeamStatus;
  message?: string;
}

export type TeamEventListener = (event: TeamEvent) => void;

// ============================================================================
// Orchestrator port (satisfied structurally by MultiAgentOrchestrator)
// ============================================================================

export interface TeamOrchestratorPort {
  execute(
    description: string,
    mode: "plan" | "act" | "review",
    opts?: { roles?: AgentRole[] },
  ): Promise<{
    results: Array<{
      role: string;
      task: string;
      result: string;
      success: boolean;
    }>;
    finalResult: string;
    dag: TaskDAG;
  }>;
  cancel(): void;
  dispose(): void;
  subscribe(listener: AgentEventListener): () => void;
  getDAG(): TaskDAG | null;
  listenerCount(): number;
}

// ============================================================================
// M4-gated base config builder (pure — unit-tested)
// ============================================================================

export interface TeamApprovalBridge {
  evaluateLiveTool(request: {
    toolCallId: string;
    toolName: string;
    input: unknown;
  }): Promise<{ approved: boolean; reason?: string }>;
}

export interface TeamAgentConfigDeps {
  workspaceRoot: string;
  providerId: string;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  privacyMode?: CodePilotAgentConfig["privacyMode"];
  maxIterations?: number;
  temperature?: number;
  /** M4 live bridge. Null/absent → deny-closed (fail safe). */
  bridge?: TeamApprovalBridge | null;
  getSessionId?: () => string | undefined;
}

/**
 * Build the CodePilotAgentConfig for every role agent of a team run.
 * Uses the SAME M4 enforcement as single-agent turns: beforeTool consults
 * the live bridge; without a bridge every tool is denied. No bypass exists
 * for terminal/file-delete/MCP/plugin/browser tools — all flow through here.
 */
export function buildTeamAgentConfig(
  deps: TeamAgentConfigDeps,
): CodePilotAgentConfig {
  const bridge = deps.bridge ?? null;
  const getSessionId = deps.getSessionId;
  return {
    workspaceRoot: deps.workspaceRoot,
    providerId: deps.providerId,
    modelId: deps.modelId,
    apiKey: deps.apiKey,
    baseUrl: deps.baseUrl,
    privacyMode: deps.privacyMode ?? "local",
    agentMode: "act",
    maxIterations: deps.maxIterations ?? 50,
    temperature: deps.temperature,
    requestApproval: async ({ toolCallId, toolName, input }) => {
      if (!bridge) {
        return {
          approved: false,
          reason: "Permission pipeline unavailable — team tool execution blocked for safety",
        };
      }
      const decision = await bridge.evaluateLiveTool({
        toolCallId,
        toolName,
        input,
        ...(getSessionId?.() ? { sessionId: getSessionId() } : {}),
      } as { toolCallId: string; toolName: string; input: unknown });
      return {
        approved: decision.approved,
        reason: decision.reason ?? `[M4-team] ${toolName}`,
      };
    },
  };
}

// ============================================================================
// Validation
// ============================================================================

const TEAM_ID_PATTERN = /^team-[0-9]+-[a-z0-9]+$/;
const RUN_ID_PATTERN = /^run-[0-9]+-[a-z0-9]+$/;

export function isValidTeamId(id: unknown): id is string {
  return typeof id === "string" && TEAM_ID_PATTERN.test(id);
}

export function isValidRunId(id: unknown): id is string {
  return typeof id === "string" && RUN_ID_PATTERN.test(id);
}

function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .trim()
    .slice(0, max);
}

/** Workspace-relative file validation (never absolute, never escaping). */
export function validateTeamFiles(
  files: unknown,
): { ok: true; files: string[] } | { ok: false; error: string } {
  if (!Array.isArray(files)) return { ok: false, error: "files must be an array" };
  if (files.length > 20) return { ok: false, error: "at most 20 files per entry" };
  const out: string[] = [];
  for (const f of files) {
    if (typeof f !== "string") return { ok: false, error: "file paths must be strings" };
    const norm = f.replace(/\\/g, "/").trim();
    if (!norm || norm.length > 500) return { ok: false, error: `invalid file path: '${f}'` };
    if (norm.startsWith("/") || /^[a-zA-Z]:\//.test(norm)) {
      return { ok: false, error: `absolute paths are not allowed: '${f}'` };
    }
    if (norm.split("/").includes("..")) {
      return { ok: false, error: `path escape is not allowed: '${f}'` };
    }
    const lowered = norm.replace(/^\/+/, "").toLowerCase();
    if (!out.includes(lowered)) out.push(lowered);
  }
  return { ok: true, files: out };
}

// ============================================================================
// TeamService
// ============================================================================

export interface TeamServiceDeps {
  taskStore: TaskStore;
  createOrchestrator: (
    baseConfig: CodePilotAgentConfig,
    opts: { maxConcurrency: number; taskTimeoutMs: number },
  ) => TeamOrchestratorPort;
  /** Resolved per run (credentials + M4 bridge are fresh each time). */
  buildBaseConfig: () => Promise<CodePilotAgentConfig>;
  taskTimeoutMs?: number;
}

interface ActiveRun {
  runId: string;
  orchestrator: TeamOrchestratorPort;
  unsubscribe: () => void;
  locks: FileLockRegistry;
  /** Declared files per M14 task id for this run. */
  declaredFiles: Map<string, string[]>;
  /** Tasks currently holding locks (taskId → files + acquisition time). */
  heldLocks: Map<string, { files: string[]; atMs: number }>;
  /** Lock conflicts observed (taskId → holderTaskId). */
  conflicts: Map<string, string>;
  settled: boolean;
  mode: TeamMode;
}

interface StoredTeamState {
  kind: "team";
  teamId: string;
  objective: string;
  mode: TeamMode;
  roles: TeamRole[];
  maxConcurrency: number;
  status: TeamStatus;
  runCount: number;
  createdAtMs: number;
  filesByRole?: Partial<Record<TeamRole, string[]>>;
  lastError?: string;
}

function newTeamId(): string {
  return `team-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function newRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const CHANGED_FILE_PATTERN = /(?:Modified|Changed|Created|Updated)\s+([^\s]+\.\w+)/gi;

export class TeamService {
  private readonly taskStore: TaskStore;
  private readonly createOrchestrator: TeamServiceDeps["createOrchestrator"];
  private readonly buildBaseConfig: TeamServiceDeps["buildBaseConfig"];
  private readonly taskTimeoutMs: number;
  private readonly listeners = new Set<TeamEventListener>();
  private readonly runs = new Map<string, ActiveRun>();
  /** Last settled DAG per team (post-run inspection after the run slot closes). */
  private readonly lastDag = new Map<string, TaskDAG>();
  private disposed = false;

  constructor(deps: TeamServiceDeps) {
    this.taskStore = deps.taskStore;
    this.createOrchestrator = deps.createOrchestrator;
    this.buildBaseConfig = deps.buildBaseConfig;
    this.taskTimeoutMs = deps.taskTimeoutMs ?? 5 * 60_000;
  }

  subscribe(listener: TeamEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Number of active listeners (lifecycle introspection for tests). */
  listenerCount(): number {
    return this.listeners.size;
  }

  /** Number of active runs (lifecycle introspection for tests). */
  activeRunCount(): number {
    return this.runs.size;
  }

  // ---- Create ---------------------------------------------------------------

  async createTeam(
    objective: unknown,
    options?: {
      roles?: unknown;
      maxConcurrency?: unknown;
      filesByRole?: unknown;
      mode?: unknown;
    },
  ): Promise<{ ok: true; team: TeamView } | { ok: false; errors: string[] }> {
    if (this.disposed) return { ok: false, errors: ["service disposed"] };
    const rawObjective = typeof objective === "string" ? objective : "";
    if (!rawObjective.trim()) return { ok: false, errors: ["objective is required"] };
    if (rawObjective.trim().length > 2000) {
      return { ok: false, errors: ["objective must be at most 2000 characters"] };
    }
    const cleanObjective = clean(objective, 2000);
    if (!cleanObjective) return { ok: false, errors: ["objective is required"] };

    // Roles: explicit selection or M14 classification (production default).
    let roles: TeamRole[];
    if (options?.roles === undefined) {
      roles = TaskDAG.classifyTask(cleanObjective).filter((r): r is TeamRole =>
        isTeamRole(r),
      );
      if (roles.length === 0) roles = ["coder"];
    } else {
      if (!Array.isArray(options.roles) || options.roles.length === 0) {
        return { ok: false, errors: ["roles must be a non-empty array"] };
      }
      if (options.roles.length > 6) {
        return { ok: false, errors: ["at most 6 roles per team"] };
      }
      const seen = new Set<string>();
      roles = [];
      for (const r of options.roles) {
        if (!isTeamRole(r)) {
          return { ok: false, errors: [`unknown role: ${String(r)}`] };
        }
        if (seen.has(r)) return { ok: false, errors: [`duplicate role: ${r}`] };
        seen.add(r);
        roles.push(r);
      }
    }

    let maxConcurrency = 2;
    if (options?.maxConcurrency !== undefined) {
      if (
        typeof options.maxConcurrency !== "number" ||
        !Number.isInteger(options.maxConcurrency) ||
        options.maxConcurrency < 1 ||
        options.maxConcurrency > 4
      ) {
        return { ok: false, errors: ["maxConcurrency must be an integer 1-4"] };
      }
      maxConcurrency = options.maxConcurrency;
    }

    let mode: TeamMode = "act";
    if (options?.mode !== undefined) {
      if (options.mode !== "plan" && options.mode !== "act" && options.mode !== "review") {
        return { ok: false, errors: ["mode must be plan | act | review"] };
      }
      mode = options.mode;
    }

    // Optional per-role file declarations (workspace-relative only).
    const filesByRole: Partial<Record<TeamRole, string[]>> = {};
    if (options?.filesByRole !== undefined) {
      if (!options.filesByRole || typeof options.filesByRole !== "object" || Array.isArray(options.filesByRole)) {
        return { ok: false, errors: ["filesByRole must be an object"] };
      }
      for (const [role, files] of Object.entries(options.filesByRole)) {
        if (!isTeamRole(role)) return { ok: false, errors: [`unknown role in filesByRole: ${role}`] };
        if (!roles.includes(role)) {
          return { ok: false, errors: [`files declared for unselected role: ${role}`] };
        }
        const validated = validateTeamFiles(files);
        if (!validated.ok) return { ok: false, errors: [validated.error] };
        if (validated.files.length > 0) filesByRole[role] = validated.files;
      }
    }

    // Build the REAL M14 DAG preview (validates structure, no execution).
    const dag = TaskDAG.buildFromRoles(roles, cleanObjective);
    const dagErrors = dag.validate();
    if (dagErrors.length > 0) {
      return { ok: false, errors: dagErrors };
    }

    // Map declared files onto DAG tasks; refuse concurrent claims up front.
    const declared = this.mapFilesToTasks(dag, filesByRole);
    const conflict = findParallelConflict(dag, declared);
    if (conflict) {
      return {
        ok: false,
        errors: [
          `file conflict: tasks '${conflict.a}' and '${conflict.b}' may run in parallel and both claim '${conflict.file}'`,
        ],
      };
    }

    const teamId = newTeamId();
    const now = Date.now();
    const stored: StoredTeamState = {
      kind: "team",
      teamId,
      objective: cleanObjective,
      mode,
      roles,
      maxConcurrency,
      status: "idle",
      runCount: 0,
      createdAtMs: now,
      ...(Object.keys(filesByRole).length > 0 ? { filesByRole } : {}),
    };
    let record;
    try {
      record = await this.taskStore.create(`[team] ${cleanObjective.slice(0, 120)}`);
    } catch (err) {
      return { ok: false, errors: [`persistence unavailable: ${err instanceof Error ? err.message : String(err)}`] };
    }
    this.rememberRecord(teamId, record.id);
    await this.taskStore.update(record.id, {
      // No "idle" in the M12 vocabulary: idle teams are parked, never
      // phantom-running, so they are stored as archived until first start.
      status: "archived",
      agentState: stored as unknown as Record<string, unknown>,
    });

    const team: TeamView = {
      teamId,
      taskId: record.id,
      objective: cleanObjective,
      mode,
      status: "idle",
      roles,
      maxConcurrency,
      tasks: snapshotTasks(dag, declared, new Map()),
      locks: [],
      runCount: 0,
      createdAtMs: now,
      updatedAtMs: now,
      completedCount: 0,
      failedCount: 0,
    };
    this.emit({ type: "team/created", teamId, message: `Team created (${roles.length} roles)` });
    return { ok: true, team };
  }

  // ---- Start ------------------------------------------------------------------

  async startTeam(
    teamId: unknown,
    options?: { mode?: unknown },
  ): Promise<{ ok: true; team: TeamView } | { ok: false; errors: string[] }> {
    if (this.disposed) return { ok: false, errors: ["service disposed"] };
    if (!isValidTeamId(teamId)) return { ok: false, errors: ["invalid team id"] };
    const stored = await this.readTeamState(teamId);
    if (!stored) return { ok: false, errors: [`unknown team: ${teamId}`] };
    if (stored.status === "running" || this.runs.has(teamId)) {
      return { ok: false, errors: ["team is already running"] };
    }

    let mode: TeamMode = stored.mode;
    if (options?.mode !== undefined) {
      if (options.mode !== "plan" && options.mode !== "act" && options.mode !== "review") {
        return { ok: false, errors: ["mode must be plan | act | review"] };
      }
      mode = options.mode;
    }

    const dag = TaskDAG.buildFromRoles(stored.roles, stored.objective);
    const declared = this.mapFilesToTasks(dag, stored.filesByRole ?? {});
    const runId = newRunId();
    const orchestrator = this.createOrchestrator(await this.buildBaseConfig(), {
      maxConcurrency: stored.maxConcurrency,
      taskTimeoutMs: this.taskTimeoutMs,
    });
    const run: ActiveRun = {
      runId,
      orchestrator,
      unsubscribe: () => undefined,
      locks: new FileLockRegistry(),
      declaredFiles: declared,
      heldLocks: new Map(),
      conflicts: new Map(),
      settled: false,
      mode,
    };
    run.unsubscribe = orchestrator.subscribe(() => {
      void this.onOrchestratorEvent(teamId, run);
    });
    this.runs.set(teamId, run);
    stored.status = "running";
    stored.runCount += 1;
    stored.mode = mode;
    await this.persistTeamState(teamId, stored);

    this.emit({ type: "team/started", teamId, runId, message: "Team run started" });
    void this.runInBackground(teamId, run, stored, stored.objective);
    const view = await this.getTeam(teamId);
    if (!view) return { ok: false, errors: ["team vanished during start"] };
    return { ok: true, team: view };
  }

  // ---- Cancel -----------------------------------------------------------------

  async cancelTeam(
    teamId: unknown,
    options?: { runId?: unknown },
  ): Promise<{ ok: true; team: TeamView } | { ok: false; errors: string[] }> {
    if (this.disposed) return { ok: false, errors: ["service disposed"] };
    if (!isValidTeamId(teamId)) return { ok: false, errors: ["invalid team id"] };
    if (options?.runId !== undefined && !isValidRunId(options.runId)) {
      return { ok: false, errors: ["invalid run id"] };
    }
    const stored = await this.readTeamState(teamId);
    if (!stored) return { ok: false, errors: [`unknown team: ${teamId}`] };
    const run = this.runs.get(teamId);
    if (!run || stored.status !== "running") {
      if (options?.runId !== undefined) {
        return { ok: false, errors: ["stale run id: no matching active run (replayed command rejected)"] };
      }
      return { ok: false, errors: ["team is not running"] };
    }
    if (options?.runId !== undefined && options.runId !== run.runId) {
      return { ok: false, errors: ["stale run id: no matching active run (replayed command rejected)"] };
    }
    // Settle locally FIRST so the background runInBackground returns early
    // and cancellation stays authoritative (no failed-after-cancelled flip).
    run.settled = true;
    try {
      run.orchestrator.cancel();
    } catch {
      // best effort — still settle locally
    }
    try {
      run.unsubscribe();
    } catch {
      // best effort
    }
    this.releaseAllRunLocks(teamId, run);
    stored.status = "cancelled";
    stored.lastError = undefined;
    await this.persistTeamState(teamId, stored);
    await this.appendTeamMessage(teamId, "system", `Run ${run.runId} cancelled.`);
    this.emit({ type: "team/cancelled", teamId, runId: run.runId, status: "cancelled" });
    // Keep the DAG for post-cancel inspection; drop the run slot.
    const cancelledDag = run.orchestrator.getDAG();
    if (cancelledDag) this.lastDag.set(teamId, cancelledDag);
    this.runs.delete(teamId);
    const view = await this.getTeam(teamId);
    if (!view) return { ok: false, errors: ["team vanished during cancel"] };
    return { ok: true, team: view };
  }

  // ---- Retry ------------------------------------------------------------------

  async retryTeam(
    teamId: unknown,
  ): Promise<{ ok: true; team: TeamView } | { ok: false; errors: string[] }> {
    if (this.disposed) return { ok: false, errors: ["service disposed"] };
    if (!isValidTeamId(teamId)) return { ok: false, errors: ["invalid team id"] };
    const stored = await this.readTeamState(teamId);
    if (!stored) return { ok: false, errors: [`unknown team: ${teamId}`] };
    if (this.runs.has(teamId)) {
      return { ok: false, errors: ["team is already running"] };
    }
    if (stored.status === "idle") {
      return { ok: false, errors: ["team has never run — start it instead"] };
    }
    if (stored.status === "completed") {
      return { ok: false, errors: ["team already completed — nothing to retry"] };
    }
    // failed / cancelled / interrupted (stored-running without a live run)
    // may all retry.
    // New run that continues from the failure WITHOUT blindly repeating
    // completed work: completed task summaries travel in the objective, and
    // every side effect remains M4-gated.
    const prior = await this.summarizePriorRun(teamId);
    const continued = [
      stored.objective,
      "",
      "Previous attempt did not finish cleanly. Completed work (do NOT redo it):",
      prior.completed.length > 0 ? prior.completed.join(" | ") : "(none)",
      `Failed/blocked: ${prior.failed.length > 0 ? prior.failed.join(" | ") : "(none)"}`,
      "Continue from the failure; every file/command operation still requires approval.",
    ].join("\n");

    const dag = TaskDAG.buildFromRoles(stored.roles, continued);
    const declared = this.mapFilesToTasks(dag, stored.filesByRole ?? {});
    const runId = newRunId();
    const orchestrator = this.createOrchestrator(await this.buildBaseConfig(), {
      maxConcurrency: stored.maxConcurrency,
      taskTimeoutMs: this.taskTimeoutMs,
    });
    const run: ActiveRun = {
      runId,
      orchestrator,
      unsubscribe: () => undefined,
      locks: new FileLockRegistry(),
      declaredFiles: declared,
      heldLocks: new Map(),
      conflicts: new Map(),
      settled: false,
      mode: stored.mode,
    };
    run.unsubscribe = orchestrator.subscribe(() => {
      void this.onOrchestratorEvent(teamId, run);
    });
    this.runs.set(teamId, run);
    stored.status = "running";
    stored.runCount += 1;
    stored.lastError = undefined;
    await this.persistTeamState(teamId, stored);
    await this.appendTeamMessage(teamId, "system", `Retry run ${run.runId} started (run #${stored.runCount}).`);
    this.emit({ type: "team/started", teamId, runId, message: "Team retry started" });
    void this.runInBackground(teamId, run, stored, continued);
    const view = await this.getTeam(teamId);
    if (!view) return { ok: false, errors: ["team vanished during retry"] };
    return { ok: true, team: view };
  }

  // ---- Remove -----------------------------------------------------------------

  async removeTeam(
    teamId: unknown,
  ): Promise<{ ok: true } | { ok: false; errors: string[] }> {
    if (this.disposed) return { ok: false, errors: ["service disposed"] };
    if (!isValidTeamId(teamId)) return { ok: false, errors: ["invalid team id"] };
    const stored = await this.readTeamState(teamId);
    if (!stored) return { ok: false, errors: [`unknown team: ${teamId}`] };
    // A live run owns the team; a stored "running" without one is an
    // interrupted team and may be started fresh.
    if (this.runs.has(teamId)) {
      return { ok: false, errors: ["team is already running"] };
    }
    const recordId = this.taskRecordId(teamId);
    if (!recordId) return { ok: false, errors: [`unknown team: ${teamId}`] };
    this.lastDag.delete(teamId);
    await this.taskStore.delete(recordId);
    this.forgetRecord(teamId);
    this.emit({ type: "team/removed", teamId });
    return { ok: true };
  }

  // ---- Read ---------------------------------------------------------------------

  async getTeam(teamId: string): Promise<TeamView | null> {
    const stored = await this.readTeamState(teamId);
    if (!stored) return null;
    return this.buildView(teamId, stored);
  }

  async listTeams(): Promise<TeamView[]> {
    const records = await this.taskStore.list();
    const views: TeamView[] = [];
    for (const record of records) {
      const state = record.agentState as StoredTeamState | undefined;
      if (!state || state.kind !== "team" || typeof state.teamId !== "string") continue;
      views.push(await this.buildView(state.teamId, state, record.updatedAtMs));
    }
    return views.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  /** Locks currently held by a team's active run (empty when idle). */
  runLocks(teamId: string): Array<{ file: string; holderTaskId: string }> {
    const run = this.runs.get(teamId);
    if (!run) return [];
    const out: Array<{ file: string; holderTaskId: string }> = [];
    for (const [taskId, hold] of run.heldLocks) {
      for (const file of hold.files) out.push({ file, holderTaskId: taskId });
    }
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [teamId, run] of [...this.runs]) {
      try {
        run.orchestrator.cancel();
      } catch {
        // best effort
      }
      this.releaseAllRunLocks(teamId, run);
      try {
        run.unsubscribe();
      } catch {
        // best effort
      }
      try {
        run.orchestrator.dispose();
      } catch {
        // best effort
      }
    }
    this.runs.clear();
    this.lastDag.clear();
    this.listeners.clear();
  }

  // ---- Private ------------------------------------------------------------------

  private emit(event: TeamEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // never break the pipeline
      }
    }
  }

  private async runInBackground(
    teamId: string,
    run: ActiveRun,
    stored: StoredTeamState,
    objective: string,
  ): Promise<void> {
    let outcome: { finalResult: string } | null = null;
    let failed: Error | null = null;
    try {
      // Role selection is real: the engine builds this run's DAG from the
      // team's roles instead of re-classifying the text.
      outcome = await run.orchestrator.execute(objective, run.mode, {
        roles: [...stored.roles],
      });
    } catch (err) {
      failed = err instanceof Error ? err : new Error(String(err));
    }
    if (run.settled) return; // cancelled path already settled
    run.settled = true;
    this.releaseAllRunLocks(teamId, run);

    const dag = run.orchestrator.getDAG();
    if (dag) this.lastDag.set(teamId, dag);
    const tasks = dag?.getAllTasks() ?? [];
    const failedTasks = tasks.filter((t) => t.status === "failed" || t.status === "blocked");
    const cancelledTasks = tasks.filter((t) => t.status === "cancelled");
    if (!failed && failedTasks.length === 0 && cancelledTasks.length === 0) {
      stored.status = "completed";
      stored.lastError = undefined;
      await this.appendTeamMessage(teamId, "assistant", excerpt(outcome?.finalResult ?? "done", 2000));
      this.emit({ type: "team/completed", teamId, runId: run.runId, status: "completed" });
    } else if (cancelledTasks.length > 0 && failedTasks.length === 0 && !failed) {
      stored.status = "cancelled";
      this.emit({ type: "team/cancelled", teamId, runId: run.runId, status: "cancelled" });
    } else {
      stored.status = "failed";
      const reason = failed?.message ?? `${failedTasks.length} task(s) failed`;
      stored.lastError = reason.slice(0, 500);
      await this.appendTeamMessage(teamId, "system", `Run failed: ${stored.lastError}`);
      this.emit({ type: "team/failed", teamId, runId: run.runId, status: "failed", message: stored.lastError });
    }
    await this.persistTeamState(teamId, stored);
    try {
      run.unsubscribe();
    } catch {
      // best effort
    }
    // Keep the orchestrator for post-run inspection until retry/remove/dispose.
    this.runs.delete(teamId);
    // Persist completed-agent information for recovery (no secrets: excerpts only).
    try {
      const touched = tasks.flatMap((t) => parseChangedFiles(t.result ?? ""));
      if (touched.length > 0) {
        const recordId = this.taskRecordId(teamId);
        if (recordId) await this.taskStore.update(recordId, { touchedFiles: [...new Set(touched)].slice(0, 100) });
      }
    } catch {
      // best effort
    }
  }

  private async onOrchestratorEvent(teamId: string, run: ActiveRun): Promise<void> {
    if (run.settled) return;
    const dag = run.orchestrator.getDAG();
    if (!dag) return;
    // Acquire holds for newly-running tasks; release terminal ones.
    for (const task of dag.getAllTasks()) {
      const declared = run.declaredFiles.get(task.id) ?? [];
      if (task.status === "running" && declared.length > 0 && !run.heldLocks.has(task.id)) {
        try {
          const locked = run.locks.acquire(task.id, declared);
          run.heldLocks.set(task.id, { files: locked, atMs: Date.now() });
        } catch {
          const holder = this.findHolder(run, declared);
          run.conflicts.set(task.id, holder ?? "unknown");
        }
      }
      if (
        (task.status === "completed" ||
          task.status === "failed" ||
          task.status === "cancelled" ||
          task.status === "blocked") &&
        run.heldLocks.has(task.id)
      ) {
        run.locks.release(task.id);
        run.heldLocks.delete(task.id);
        // Terminal progress worth persisting (bounded: one write per event).
        await this.appendTeamMessage(
          teamId,
          task.status === "completed" ? "assistant" : "system",
          `[${task.agentRole}/${task.id}] ${task.status}${task.error ? `: ${task.error.slice(0, 300)}` : ""}`,
        );
      }
    }
    const view = await this.getTeam(teamId);
    if (view) {
      this.emit({
        type: "team/task_updated",
        teamId,
        runId: run.runId,
        status: view.status,
        message: `${view.completedCount} completed, ${view.failedCount} failed`,
      });
    }
  }

  private findHolder(run: ActiveRun, files: string[]): string | undefined {
    for (const f of files) {
      const holder = run.locks.holder(f);
      if (holder) return holder;
    }
    return undefined;
  }

  private releaseAllRunLocks(_teamId: string, run: ActiveRun): void {
    for (const taskId of [...run.heldLocks.keys()]) {
      try {
        run.locks.release(taskId);
      } catch {
        // best effort
      }
    }
    run.heldLocks.clear();
  }

  private mapFilesToTasks(
    dag: TaskDAG,
    filesByRole: Partial<Record<TeamRole, string[]>>,
  ): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const task of dag.getAllTasks()) {
      const files = (filesByRole as Record<string, string[]>)[task.agentRole] ?? [];
      if (files.length > 0) out.set(task.id, [...files]);
    }
    return out;
  }

  private async readTeamState(teamId: string): Promise<StoredTeamState | null> {
    const recordId = this.taskRecordId(teamId);
    if (!recordId) {
      // Fall back to scanning (record id is stored in the id map below).
      const found = await this.findRecordByTeamId(teamId);
      if (!found) return null;
      this.rememberRecord(teamId, found.id);
      const state = found.agentState as StoredTeamState | undefined;
      return state?.kind === "team" ? state : null;
    }
    const record = await this.taskStore.get(recordId);
    if (!record) {
      this.forgetRecord(teamId);
      const found = await this.findRecordByTeamId(teamId);
      if (!found) return null;
      this.rememberRecord(teamId, found.id);
      const state = found.agentState as StoredTeamState | undefined;
      return state?.kind === "team" ? state : null;
    }
    const state = record.agentState as StoredTeamState | undefined;
    return state?.kind === "team" ? state : null;
  }

  private readonly recordIds = new Map<string, string>();

  private taskRecordId(teamId: string): string | undefined {
    return this.recordIds.get(teamId);
  }

  private rememberRecord(teamId: string, recordId: string): void {
    this.recordIds.set(teamId, recordId);
  }

  private forgetRecord(teamId: string): void {
    this.recordIds.delete(teamId);
  }

  private async findRecordByTeamId(teamId: string) {
    const records = await this.taskStore.list();
    for (const record of records) {
      const state = record.agentState as StoredTeamState | undefined;
      if (state?.kind === "team" && state.teamId === teamId) return record;
    }
    return null;
  }

  private async persistTeamState(teamId: string, stored: StoredTeamState): Promise<void> {
    const recordId = this.taskRecordId(teamId);
    if (!recordId) return;
    // M12 has no "idle": parked teams are stored as archived (never
    // phantom-running); the authoritative team status lives in agentState.
    const recordStatus =
      stored.status === "running"
        ? "running"
        : stored.status === "completed"
          ? "completed"
          : stored.status === "failed"
            ? "failed"
            : stored.status === "cancelled"
              ? "cancelled"
              : stored.status === "interrupted"
                ? "interrupted"
                : "archived";
    try {
      await this.taskStore.update(recordId, {
        status: recordStatus,
        agentState: stored as unknown as Record<string, unknown>,
      });
    } catch {
      // best-effort persistence — never break the live run
    }
  }

  private async appendTeamMessage(
    teamId: string,
    role: "user" | "assistant" | "tool" | "system",
    content: string,
  ): Promise<void> {
    const recordId = this.taskRecordId(teamId);
    if (!recordId) return;
    try {
      await this.taskStore.appendMessage(recordId, role, content.slice(0, 4000));
    } catch {
      // best effort
    }
  }

  private async summarizePriorRun(
    teamId: string,
  ): Promise<{ completed: string[]; failed: string[] }> {
    const view = await this.getTeam(teamId);
    const completed: string[] = [];
    const failed: string[] = [];
    for (const t of view?.tasks ?? []) {
      const label = `${t.roleLabel} (${t.taskId}): ${(t.resultExcerpt ?? t.description).slice(0, 200)}`;
      if (t.status === "completed") completed.push(label);
      else if (t.status === "failed" || t.status === "blocked") failed.push(label);
    }
    return { completed, failed };
  }

  private async buildView(
    teamId: string,
    stored: StoredTeamState,
    updatedAtMs?: number,
  ): Promise<TeamView> {
    const run = this.runs.get(teamId);
    // Live DAG → last settled DAG → fresh preview (in that order).
    const dag =
      run?.orchestrator.getDAG() ??
      this.lastDag.get(teamId) ??
      TaskDAG.buildFromRoles(stored.roles, stored.objective);
    const declared = run?.declaredFiles ?? this.mapFilesToTasks(dag, stored.filesByRole ?? {});
    const tasks = snapshotTasks(dag, declared, run?.conflicts ?? new Map());
    const locks: TeamLockView[] = [];
    if (run) {
      for (const [taskId, hold] of run.heldLocks) {
        const task = dag.getTask(taskId);
        for (const file of hold.files) {
          locks.push({
            file,
            holderTaskId: taskId,
            holderRole: task ? roleLabel(task.agentRole) : taskId,
            acquiredAtMs: hold.atMs,
          });
        }
      }
    }
    // A store-running team with no live run died with the host → interrupted,
    // but only when it actually started before (runCount > 0). Idle stays idle.
    let status = stored.status;
    if (status === "running" && !run) {
      status = stored.runCount > 0 ? "interrupted" : "idle";
    }
    const completedCount = tasks.filter((t) => t.status === "completed").length;
    const failedCount = tasks.filter((t) => t.status === "failed" || t.status === "blocked").length;
    return {
      teamId,
      taskId: this.taskRecordId(teamId) ?? "",
      objective: stored.objective,
      mode: stored.mode,
      status,
      roles: stored.roles,
      maxConcurrency: stored.maxConcurrency,
      tasks,
      locks,
      ...(run ? { runId: run.runId } : {}),
      runCount: stored.runCount,
      createdAtMs: stored.createdAtMs,
      updatedAtMs: updatedAtMs ?? Date.now(),
      completedCount,
      failedCount,
      ...(stored.lastError ? { error: stored.lastError } : {}),
    };
  }
}

// ============================================================================
// DAG helpers (pure)
// ============================================================================

/** True when `from` reaches `to` following dependency edges. */
function reaches(dag: TaskDAG, from: string, to: string): boolean {
  const seen = new Set<string>([from]);
  const stack = [from];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === to) return true;
    const task = dag.getTask(current);
    for (const dep of task?.dependencies ?? []) {
      if (!seen.has(dep)) {
        seen.add(dep);
        stack.push(dep);
      }
    }
  }
  return false;
}

/** Two tasks may run in parallel when neither depends on the other. */
function mayRunInParallel(dag: TaskDAG, a: string, b: string): boolean {
  return !reaches(dag, a, b) && !reaches(dag, b, a);
}

function findParallelConflict(
  dag: TaskDAG,
  declared: Map<string, string[]>,
): { a: string; b: string; file: string } | null {
  const ids = [...declared.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i]!;
      const b = ids[j]!;
      if (!mayRunInParallel(dag, a, b)) continue;
      const filesA = declared.get(a) ?? [];
      for (const file of declared.get(b) ?? []) {
        if (filesA.includes(file)) return { a, b, file };
      }
    }
  }
  return null;
}

/** Depth of a task (roots = 0) for tree rendering. */
export function taskLevel(dag: TaskDAG, taskId: string): number {
  const task = dag.getTask(taskId);
  if (!task || task.dependencies.length === 0) return 0;
  let depth = 0;
  for (const dep of task.dependencies) {
    depth = Math.max(depth, taskLevel(dag, dep) + 1);
  }
  return depth;
}

function snapshotTasks(
  dag: TaskDAG,
  declared: Map<string, string[]>,
  conflicts: Map<string, string>,
): TeamTaskView[] {
  return dag.getAllTasks().map((t) => {
    const resultFiles = t.result ? parseChangedFiles(t.result) : [];
    const files = [...new Set([...(declared.get(t.id) ?? []), ...resultFiles])].slice(0, 50);
    return {
      taskId: t.id,
      role: t.agentRole,
      roleLabel: roleLabel(t.agentRole),
      description: t.description.slice(0, 500),
      dependencies: [...t.dependencies],
      dependents: dag.getDependents(t.id).map((d) => d.id),
      level: taskLevel(dag, t.id),
      status: t.status,
      retryCount: t.retryCount,
      maxRetries: t.maxRetries,
      ...(t.startedAt !== undefined ? { startedAtMs: t.startedAt } : {}),
      ...(t.completedAt !== undefined ? { completedAtMs: t.completedAt } : {}),
      files,
      ...(conflicts.get(t.id) ? { conflictWith: conflicts.get(t.id) } : {}),
      ...(t.error ? { error: t.error.slice(0, 500) } : {}),
      ...(t.result ? { resultExcerpt: excerpt(t.result, 300) } : {}),
    };
  });
}

function parseChangedFiles(result: string): string[] {
  const out: string[] = [];
  CHANGED_FILE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CHANGED_FILE_PATTERN.exec(result)) !== null) {
    const file = (match[1] ?? "").replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
    if (file && !out.includes(file)) out.push(file);
    if (out.length >= 20) break;
  }
  return out;
}

function excerpt(value: string, max: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

export function roleLabel(role: string): string {
  const labels: Record<string, string> = {
    orchestrator: "Orchestrator",
    architect: "Planner",
    coder: "Implementer",
    tester: "Tester",
    security: "Security",
    reviewer: "Reviewer",
    documentation: "Docs",
  };
  return labels[role] ?? role;
}

export type { AgentRole, CodePilotAgentConfig, TaskNode, TaskStatus };
