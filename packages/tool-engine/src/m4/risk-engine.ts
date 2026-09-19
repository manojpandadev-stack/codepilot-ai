/**
 * @codepilot/tool-engine — M4 RiskEngine
 *
 * Centralized risk evaluator. Risk is computed purely from the declared
 * PermissionAction and the action-specific metadata; it is intentionally
 * decoupled from any user-configured policy so risk always reflects the
 * intrinsic severity of the operation.
 *
 * Risk levels:
 *   low       read_file, list_directory, search_files, search_text, ask_user
 *   medium    write_file, edit_file, create_directory, git_operation, web_fetch
 *   high      delete_file, move_file, execute_command, network_request,
 *             mcp_tool, mcp_resource, kill_process
 *   critical  environment_access, destructive shell, recursive delete,
 *             operations that attempt to leave the workspace
 */

import type {
  PermissionAction,
  RiskAssessment,
  RiskLevel,
} from "./permission-types.js";

// ============================================================================
// Base risk per action
// ============================================================================

const BASE_RISK: Record<PermissionAction, RiskLevel> = {
  read_file: "low",
  list_directory: "low",
  search_files: "low",
  search_text: "low",
  ask_user: "low",

  write_file: "medium",
  edit_file: "medium",
  create_directory: "medium",
  git_operation: "medium",
  web_fetch: "medium",

  delete_file: "high",
  move_file: "high",
  execute_command: "high",
  network_request: "high",
  mcp_tool: "high",
  mcp_resource: "high",
  kill_process: "high",

  environment_access: "critical",
};

const BASE_REASONS: Record<PermissionAction, string> = {
  read_file: "Read-only access to workspace file",
  list_directory: "List workspace directory entries",
  search_files: "Search workspace file names",
  search_text: "Search workspace file contents",
  ask_user: "Prompt the user for input",
  write_file: "Create or overwrite a workspace file",
  edit_file: "Modify an existing workspace file",
  create_directory: "Create a directory inside the workspace",
  git_operation: "Run a git operation that may mutate history",
  web_fetch: "Fetch an external network resource",
  delete_file: "Permanently delete a workspace file",
  move_file: "Move or rename a workspace file",
  execute_command: "Execute an external process",
  network_request: "Make a network request to an external host",
  mcp_tool: "Execute a tool provided by an MCP server",
  mcp_resource: "Read a resource provided by an MCP server",
  kill_process: "Terminate a running process",
  environment_access:
    "Access environment variables (potential secret exposure)",
};

// ============================================================================
// Command risk heuristics
// ============================================================================

const CRITICAL_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+(-[rfRF]+\s+)+\//i,
  /\brm\s+.*\s+\//i,
  /\bdel\s+\/s\b/i,
  /\bformat\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bdiskpart\b/i,
  /\bchmod\s+-R\s+777\b/i,
  /\bsudo\b/i,
  /\bpowershell.*-enc/i,
  /\bpowershell.*FromBase64String/i,
  /\bcurl\s+.*\|\s*sh\b/i,
  /\bwget\s+.*\|\s*sh\b/i,
  /curl\s+.*\|\s*bash/i,
  /\|\s*bash\b/i,
];

const HIGH_COMMAND_PATTERNS: RegExp[] = [
  /\brm\b/i,
  /\bdel\b/i,
  /\bremove-item\b/i,
  /\berase\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+push\s+--force\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-fd\b/i,
  /\bnpm\s+(uninstall|remove)\b/i,
  /\byarn\s+remove\b/i,
  /\bpnpm\s+remove\b/i,
  /\b(pip|pip3)\s+uninstall\b/i,
  /\breg\s+(add|delete)\b/i,
  /\bnet\s+(user|localgroup)\b/i,
];

// ============================================================================
// RiskEngine
// ============================================================================

export class RiskEngine {
  /**
   * Assess the risk of an action + metadata pair.
   *
   * The result is deterministic: same inputs always produce the same
   * RiskAssessment. Policies can override the *decision* but never the
   * intrinsic risk of the operation.
   */
  assess(
    action: PermissionAction,
    metadata?: Record<string, unknown>,
  ): RiskAssessment {
    const baseLevel = BASE_RISK[action] ?? "medium";
    const reasons: string[] = [BASE_REASONS[action] ?? `Perform ${action}`];
    let level = baseLevel;
    let destructive = false;

    if (action === "execute_command") {
      const command =
        typeof metadata?.command === "string" ? metadata.command : "";
      const chained =
        typeof metadata?.chained === "boolean" && metadata.chained;

      for (const pattern of CRITICAL_COMMAND_PATTERNS) {
        if (pattern.test(command)) {
          level = "critical";
          reasons.push(`Command matches critical pattern: ${pattern.source}`);
          destructive = true;
          break;
        }
      }

      if (level !== "critical") {
        for (const pattern of HIGH_COMMAND_PATTERNS) {
          if (pattern.test(command)) {
            if (level !== "high") {
              level = "high";
            }
            reasons.push(
              `Command matches high-risk pattern: ${pattern.source}`,
            );
            destructive = true;
            break;
          }
        }
      }

      if (chained) {
        reasons.push("Command contains shell chaining");
        if (level === "low" || level === "medium") {
          level = "high";
        }
      }

      const commandSub = /\$\(.*\)|`.*`|\beval\b|\bexec\b/i.test(command);
      if (commandSub) {
        reasons.push("Command contains command substitution");
        if (level !== "critical") {
          level = "high";
        }
      }
    }

    if (action === "delete_file") {
      const recursive =
        typeof metadata?.recursive === "boolean" && metadata.recursive;
      if (recursive) {
        destructive = true;
        reasons.push("Recursive delete — will remove the directory tree");
        if (level !== "critical") {
          level = "high";
        }
      }
    }

    if (action === "move_file" || action === "delete_file") {
      const outside =
        typeof metadata?.outsideWorkspace === "boolean" &&
        metadata.outsideWorkspace;
      if (outside) {
        destructive = true;
        level = "critical";
        reasons.push("Operation targets a path outside the workspace");
      }
    }

    return { level, reasons, destructive };
  }
}
