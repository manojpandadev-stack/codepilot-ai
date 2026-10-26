/**
 * @codepilot/agent-runtime — ChangeSet staging tools (the single boundary)
 *
 * ONE implementation of the staged-write boundary, shared by the main-agent
 * runtime (`CodePilotRuntime`) and every child-agent role toolset built by the
 * orchestrator. There is no second write path:
 *
 *   tool call → M4 gate (approval) → stageWriteProposal()
 *              → parse the edit IN MEMORY (never touches the filesystem)
 *              → onWriteProposal(toolName, proposals)  [host ChangeSet]
 *              → model is told the ChangeSet id; the file is unchanged
 *              → user approves in the Changes tab
 *              → ChangeSetManager.acceptChange → M5 FileMutationService
 *
 * Guarantees enforced here:
 *  - No tool in this module writes to the filesystem. Ever.
 *  - A host with no `onWriteProposal` bridge gets NO write tools at all
 *    (fail closed), never a direct-write fallback.
 *  - `MUTATING_TOOL_NAMES` is the single mode/tool-contract list used by both
 *    the main-agent runtime and child agents, so ASK/PLAN can never advertise
 *    a mutating tool on either path.
 */

import { existsSync, readFileSync } from "node:fs";
import type { AgentTool } from "./native/types.js";
import {
  MAX_PROPOSED_FILE_BYTES,
  parseApplyPatchInput,
  parseDeleteFileInput,
  parseEditorInput,
  formatStagedResult,
  type WriteProposal,
} from "./write-tools.js";

/** Write tools that stage a ChangeSet proposal instead of touching disk. */
export const STAGED_WRITE_TOOL_NAMES = [
  "editor",
  "apply_patch",
  "delete_file",
] as const;

export type StagedWriteToolName = (typeof STAGED_WRITE_TOOL_NAMES)[number];

/**
 * Host staging bridge. Registers the in-memory proposal as a pending
 * ChangeSet and returns its id. It MUST NOT write to the filesystem.
 */
export type WriteProposalSink = (
  toolName: string,
  proposals: WriteProposal[],
) => Promise<{ changeSetId: string }>;

/**
 * Tools that can never run in ASK/PLAN mode. Model-contract filter ONLY — the
 * M4 gate still evaluates every call in every mode; this list changes what the
 * MODEL sees, never authorization.
 */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "run_commands",
  "write_file",
  "editor",
  "apply_patch",
  "delete_file",
  // SECURITY (live-verified escape): agent-initiated tracked terminal tools
  // were injected as extra tools in EVERY mode, so a model in ask/plan could
  // emit terminal_session_start/exec and run real commands. They are mutating
  // execution tools exactly like bash/run_commands.
  "terminal_session_start",
  "terminal_session_exec",
]);

/** Bounded original-content reader shared by every staged write parser. */
export function readOriginalSafe(absolutePath: string): string | undefined {
  try {
    if (!existsSync(absolutePath)) return undefined;
    const buffer = readFileSync(absolutePath);
    if (buffer.length > MAX_PROPOSED_FILE_BYTES) return undefined;
    if (buffer.includes(0)) return undefined;
    return buffer.toString("utf8");
  } catch {
    return undefined;
  }
}

/**
 * Parse a write-tool input into staged proposals and hand them to the host's
 * ChangeSet manager. Returns the model-facing "staged, nothing changed"
 * message. Throws (no mutation) when the input is invalid or the host bridge
 * rejects the proposal.
 */
export async function stageWriteProposal(params: {
  toolName: StagedWriteToolName;
  input: Record<string, unknown>;
  workspaceRoot: string;
  onWriteProposal: WriteProposalSink;
  /** Called with the staged relative paths after a successful registration. */
  onStaged?: (relativePaths: string[]) => void;
}): Promise<string> {
  const { toolName, input, workspaceRoot, onWriteProposal, onStaged } = params;
  if (typeof onWriteProposal !== "function") {
    // Fail closed: no staging bridge means no authorized way to propose an
    // edit, so the write must not happen in any form.
    throw new Error("ChangeSet staging is not configured for this session");
  }
  const result =
    toolName === "editor"
      ? parseEditorInput(input, workspaceRoot, readOriginalSafe)
      : toolName === "delete_file"
        ? parseDeleteFileInput(input, workspaceRoot, readOriginalSafe)
        : await parseApplyPatchInput(input, workspaceRoot);
  if (!result.ok) {
    throw new Error(`${toolName} staging failed: ${result.error}`);
  }
  const { changeSetId } = await onWriteProposal(toolName, result.proposals);
  if (typeof changeSetId !== "string" || changeSetId.length === 0) {
    // An unstaged "success" would tell the model the edit is queued for review
    // when nothing can ever be reviewed or applied. Fail closed instead.
    throw new Error(
      `${toolName} staging produced no ChangeSet id — proposal was not registered`,
    );
  }
  onStaged?.(result.proposals.map((p) => p.relativePath));
  return formatStagedResult(toolName, changeSetId, result.proposals);
}

const WRITE_TOOL_DESCRIPTIONS: Record<StagedWriteToolName, string> = {
  editor:
    "Edit file ranges in the workspace. The edit is staged as a pending ChangeSet for user approval — no file is modified until approved.",
  delete_file:
    "Permanently delete a workspace file. The deletion is staged as a pending ChangeSet for user approval — no file is modified until approved.",
  apply_patch:
    "Apply a Codex-style patch (*** Begin Patch format) to workspace files. Changes are staged as a pending ChangeSet for user approval — no file is modified until approved.",
};

function schemaFor(toolName: StagedWriteToolName): Record<string, unknown> {
  if (toolName === "editor") {
    return {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Workspace-relative file path",
        },
        operation: {
          type: "string",
          enum: ["str_replace", "replace_all", "insert", "delete", "create"],
          description:
            "str_replace (default): swap old_string→new_string (first occurrence); replace_all: every occurrence; insert: new_string immediately before old_string; delete: remove old_string; create: new file whose content is new_string",
        },
        old_string: {
          type: "string",
          description: "Text to replace (replace operation)",
        },
        new_string: { type: "string", description: "Replacement text" },
      },
      required: ["file_path", "operation"],
    };
  }
  if (toolName === "delete_file") {
    return {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path to delete",
        },
      },
      required: ["path"],
    };
  }
  return {
    type: "object",
    properties: {
      patch: {
        type: "string",
        description: "Patch beginning with '*** Begin Patch'",
      },
    },
    required: ["patch"],
  };
}

/**
 * Build the ChangeSet-staged write tools for one workspace. Callers MUST pass
 * a host bridge; a host without one gets an empty list (fail closed).
 */
export function createStagedWriteTools(options: {
  workspaceRoot: string;
  onWriteProposal?: WriteProposalSink;
  /** Called after each successful staging (runtime records changed paths). */
  onStaged?: (relativePaths: string[]) => void;
}): AgentTool[] {
  if (typeof options.onWriteProposal !== "function") return [];
  const workspaceRoot = options.workspaceRoot;
  const onWriteProposal = options.onWriteProposal;
  return STAGED_WRITE_TOOL_NAMES.map((toolName) => ({
    name: toolName,
    description: WRITE_TOOL_DESCRIPTIONS[toolName],
    inputSchema: schemaFor(toolName),
    timeoutMs: 30_000,
    execute: async (input: unknown) =>
      stageWriteProposal({
        toolName,
        input: (input ?? {}) as Record<string, unknown>,
        workspaceRoot,
        onWriteProposal,
        ...(options.onStaged ? { onStaged: options.onStaged } : {}),
      }),
  }));
}
