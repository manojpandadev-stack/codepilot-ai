import { WorkspaceBoundary } from "../workspace-boundary.js";
import {
  CommandExecutionService,
  CommandExecutionPolicy,
} from "../command-execution.js";
import type { ToolDefinition } from "../types.js";
import { createFilesystemTools } from "./filesystem.js";
import { createSearchTools } from "./search.js";
import { createDirectoryTools } from "./directory.js";
import { createGitTools } from "./git.js";
import { createAskUserTool } from "./interaction.js";
import { createCommandTools, TerminalStore } from "./command.js";

/**
 * Options for building the CodePilot built-in tool set.
 * A single shared CommandExecutionService and TerminalStore back all command
 * and git tools so their state (recent output, running processes) is coherent.
 */
export interface BuiltinToolsConfig {
  /** Workspace root — all filesystem/command access is bounded to it. */
  workspaceRoot: string;
  /** Command allow/deny/approval policy (defaults to a safe reading set). */
  commandPolicy?: CommandExecutionPolicy;
  /** Number of recent terminal records to retain (default 100). */
  commandHistoryLimit?: number;
}

/**
 * Build the complete M3 built-in tool set. Every tool is a ToolDefinition and
 * flows through ToolRegistry + ToolExecutionService on execution.
 */
export function createBuiltinTools(
  config: BuiltinToolsConfig,
): ToolDefinition[] {
  const boundary = new WorkspaceBoundary(config.workspaceRoot);
  const service = new CommandExecutionService();
  const policy = config.commandPolicy ?? new CommandExecutionPolicy();
  const store = new TerminalStore(config.commandHistoryLimit ?? 100);
  return [
    ...createFilesystemTools(boundary),
    ...createSearchTools(boundary),
    ...createDirectoryTools(boundary),
    ...createGitTools(boundary, service),
    createAskUserTool(),
    ...createCommandTools(boundary, service, policy, store),
  ] as ToolDefinition[];
}

export { TerminalStore } from "./command.js";
