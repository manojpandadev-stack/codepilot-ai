/**
 * @codepilot/tool-engine — M4 live-tool bridge
 *
 * The native live agent loop surfaces tool executions through a
 * single `requestApproval` hook. This bridge makes that hook an M4 pipeline
 * evaluation: risk classification → policy → approval (when required) →
 * security validation — the same pipeline M3's executor uses. No live tool
 * may execute without an M4 decision; the bridge denies closed on any error.
 *
 * Tool-name → tool-id mapping covers the builtin tools exposed to the live
 * agent (`editor`, `apply_patch`, `bash`, `read_file`, `web_fetch`, …).
 * Unknown tools map to a HIGH-risk write action by default (deny-biased),
 * so a new live tool cannot silently bypass permission evaluation.
 */

import { M4PermissionPipeline, toolIdToAction } from "./integration.js";
import type { PipelineDecision } from "./integration.js";
import { ToolAuditLogger } from "../m3/audit-logger.js";
import type { ToolAuditSink } from "../m3/audit-logger.js";
import type { PermissionDecision } from "./permission-types.js";

/** Cap for any string that reaches the audit trail. */
const SAFE_TARGET_MAX = 128;

/** Final path segment only — drops directories so no absolute path leaks. */
function basenameOnly(value: string): string {
  const parts = value.split(/[\\/]/).filter((s) => s.length > 0);
  return parts.length > 0 ? parts[parts.length - 1]! : value;
}

/**
 * Derive an audit-SAFE target descriptor from raw tool input: a command NAME,
 * a hostname, or a filename — never a full command line, full path, or raw
 * input. Command arguments are deliberately dropped because they routinely
 * carry credentials (`--token=…`, `-H "Authorization: …"`). Unrecognized
 * shapes return undefined: honest absence beats a leaky guess.
 */
function safeTargetFor(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;

  const command = str(record.command) ?? str(record.cmd);
  if (command) {
    const name = command.trim().split(/\s+/)[0];
    return name ? name.slice(0, SAFE_TARGET_MAX) : undefined;
  }

  const url = str(record.url);
  if (url) {
    try {
      return new URL(url).hostname.slice(0, SAFE_TARGET_MAX);
    } catch {
      return undefined;
    }
  }

  const pathLike =
    str(record.path) ??
    str(record.file_path) ??
    str(record.filePath) ??
    str(record.target);
  if (pathLike) return basenameOnly(pathLike).slice(0, SAFE_TARGET_MAX);

  return undefined;
}

/** Live agent builtin tool name → M3 tool id used by the M4 action map. */
const LIVE_TOOL_ID_MAP: Record<string, string> = {
  editor: "apply_file_changes",
  apply_patch: "apply_file_changes",
  write_file: "apply_file_changes",
  bash: "execute_command",
  run_commands: "execute_command",
  run_command: "execute_command",
  terminal: "execute_command",
  web_fetch: "use_web",
  fetch_url: "use_web",
  read_file: "read_file",
  list_files: "list_directory",
  list_directory: "list_directory",
  search_files: "search_files",
  search_text: "search_text",
  glob_files: "search_files",
  grep_files: "search_text",
  // --- Browser automation (@codepilot/browser-engine) ---------------------
  // Explicit mappings so browser tool calls map to their browser_* M3 ids —
  // without these, unmapped tools fall to the HIGH-risk write path
  // (deny-biased but still wrong action/risk/reason shown to the user).
  browser_navigate: "browser_navigate",
  browser_back: "browser_back",
  browser_forward: "browser_forward",
  browser_reload: "browser_reload",
  browser_click: "browser_click",
  browser_type: "browser_type",
  browser_press: "browser_press",
  browser_scroll: "browser_scroll",
  browser_wait: "browser_wait",
  browser_extract: "browser_extract",
  browser_screenshot: "browser_screenshot",
  browser_close: "browser_close",
  // --- Agent-initiated tracked terminal sessions (M7) ----------------------
  // Every agent session operation maps to execute_command so each COMMAND is
  // independently risk-classified (high → ASK by default). A sessionId can
  // never become an authorization bypass: the exec tool still evaluates the
  // command through the full M4 pipeline per call.
  terminal_session_start: "execute_command",
  terminal_session_exec: "execute_command",
  terminal_session_status: "read_file",
  terminal_session_stop: "kill_process",
  terminal_session_close: "kill_process",
};

/**
 * Prefix the runtime uses for MCP tools exposed to the live agent
 * (`mcp__<server>__<tool>`). These map to the mcp_tool action so they can
 * never fall through to the auto-approved read path.
 */
export const MCP_TOOL_PREFIX = "mcp__";

/** True when the live tool name refers to an MCP-provided tool. */
export function isMcpToolName(toolName: string): boolean {
  return toolName.startsWith(MCP_TOOL_PREFIX);
}

/** Fallback for tools with no mapping — treated as a HIGH-risk write. */
const UNMAPPED_TOOL_ID = "apply_file_changes";

export interface LiveToolPermissionRequest {
  /** Tool name as exposed to the agent (e.g. "bash", "editor"). */
  toolName: string;
  /** Raw tool input (paths/commands are extracted by the pipeline). */
  input: unknown;
  sessionId?: string;
  taskId?: string;
}

export interface LiveToolPermissionResult {
  approved: boolean;
  decision: PermissionDecision | "error";
  reason: string;
  riskLevel: string;
  /** True when the tool name had no explicit mapping (deny-biased path). */
  unmappedTool: boolean;
}

export class LiveToolPermissionBridge {
  private readonly pipeline: M4PermissionPipeline;
  private readonly audit: ToolAuditSink;
  private seq = 0;

  constructor(pipeline: M4PermissionPipeline, audit?: ToolAuditSink) {
    this.pipeline = pipeline;
    this.audit = audit ?? new ToolAuditLogger();
  }

  /** Map a live tool name to the M3 tool id the M4 action map understands. */
  toolIdFor(toolName: string): { toolId: string; unmapped: boolean } {
    const mapped = LIVE_TOOL_ID_MAP[toolName];
    if (mapped) return { toolId: mapped, unmapped: false };
    if (isMcpToolName(toolName)) {
      return { toolId: "mcp_tool", unmapped: false };
    }
    return { toolId: UNMAPPED_TOOL_ID, unmapped: true };
  }

  /**
   * Evaluate a live tool request through the full M4 pipeline. Blocks while
   * an approval is pending; resolves with the final decision. Never throws —
   * evaluation failures deny the tool (fail closed).
   */
  async evaluateLiveTool(
    request: LiveToolPermissionRequest,
  ): Promise<LiveToolPermissionResult> {
    const startedAt = Date.now();
    const executionId = `live-${++this.seq}-${startedAt}`;
    const { toolId, unmapped } = this.toolIdFor(request.toolName);

    let decision: PipelineDecision;
    try {
      decision = await this.pipeline.evaluate({
        toolId,
        executionId,
        sessionId: request.sessionId,
        taskId: request.taskId,
        input: request.input,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.audit.record({
        executionId,
        toolId,
        sessionId: request.sessionId,
        taskId: request.taskId,
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        status: "denied",
        permissionDecision: `error: ${reason}`,
        retries: 0,
        action: toolIdToAction(toolId),
        risk: "HIGH",
        approved: false,
        safeTarget: safeTargetFor(request.input),
      });
      return {
        approved: false,
        decision: "error",
        reason: `permission evaluation failed: ${reason}`,
        riskLevel: "HIGH",
        unmappedTool: unmapped,
      };
    }

    this.audit.record({
      executionId,
      toolId,
      sessionId: request.sessionId,
      taskId: request.taskId,
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      status: decision.approved ? "completed" : "denied",
      permissionDecision: decision.decision,
      retries: 0,
      action: toolIdToAction(toolId),
      risk: decision.risk.level,
      approved: decision.approved,
      safeTarget: safeTargetFor(request.input),
    });

    return {
      approved: decision.approved,
      decision: decision.decision,
      reason: decision.reason,
      riskLevel: decision.risk.level,
      unmappedTool: unmapped,
    };
  }

  /** Audit trail of live permission decisions (redacted, bounded). */
  auditLog(limit = 100) {
    return this.audit.list(limit);
  }

  /**
   * The underlying M4 policy engine — the SINGLE authoritative authorization
   * surface. Host settings (auto-approve toggles) must flow into this engine;
   * keeping them in a second policy engine lets the two diverge.
   */
  get policyEngine() {
    return this.pipeline.policyEngine;
  }

  /** The underlying risk engine (used for safe-command classification). */
  get riskEngine() {
    return this.pipeline.riskEngine;
  }

  /** Underlying security validator (hard boundary enforcement). */
  get securityValidator() {
    return this.pipeline.securityValidator;
  }
}
