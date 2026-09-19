/**
 * Tools-tab display contract (extension host, testable, no VS Code imports).
 *
 * The Tools tab shows one row per entry. `name` is the stable display/policy
 * label; `callableName` is the exact tool name the native dispatcher
 * resolves, or `null` when the row is policy-coverage-only and the
 * capability is reached through another callable tool (stated in the
 * description's resolution note). No row may name a tool that resolves
 * nowhere: every entry either names its callable tool or names the path
 * that honors it.
 *
 * M4 gating is untouched by this mapping — it only labels what the gate
 * already enforces. Callable names must stay within
 * CODEPILOT_MODEL_TOOL_NAMES (@codepilot/agent-runtime builtin-tools);
 * enforced by tests/tools-contract.test.ts.
 */

export interface ToolDisplayEntry {
  name: string;
  category: string;
  description: string;
  /**
   * Exact native callable tool name, or null when this row is
   * policy-coverage-only (the description then states the resolution path).
   */
  callableName: string | null;
}

export const BUILTIN_TOOL_DISPLAY_CONTRACT: readonly ToolDisplayEntry[] = [
  {
    name: "read_files",
    category: "read",
    description: "Read file contents from the workspace",
    callableName: "read_files",
  },
  {
    name: "search",
    category: "read",
    description: "Search file contents across the workspace",
    callableName: "search_codebase",
  },
  {
    name: "list_directory",
    category: "read",
    description:
      "List directory entries (policy coverage; executed via the bash tool: ls/dir, M4 approval)",
    callableName: null,
  },
  {
    name: "git_status",
    category: "git",
    description:
      "Show working-tree status (policy coverage; executed via the bash tool: git status, M4 approval)",
    callableName: null,
  },
  {
    name: "git_diff",
    category: "git",
    description:
      "Show unstaged/staged diffs (policy coverage; executed via the bash tool: git diff, M4 approval)",
    callableName: null,
  },
  {
    name: "git_log",
    category: "git",
    description:
      "Show commit history (policy coverage; executed via the bash tool: git log, M4 approval)",
    callableName: null,
  },
  {
    name: "git_show",
    category: "git",
    description:
      "Show a specific commit (policy coverage; executed via the bash tool: git show, M4 approval)",
    callableName: null,
  },
  {
    name: "write_file",
    category: "write",
    description: "Create or overwrite a file (via ChangeSet approval)",
    callableName: "editor",
  },
  {
    name: "apply_patch",
    category: "write",
    description: "Apply a patch to workspace files (via ChangeSet approval)",
    callableName: "apply_patch",
  },
  {
    name: "editor",
    category: "write",
    description: "Edit file ranges (via ChangeSet approval)",
    callableName: "editor",
  },
  {
    name: "delete_file",
    category: "write",
    description:
      "Delete a file (policy coverage; executed via the bash tool: rm/del, M4 approval)",
    callableName: null,
  },
  {
    name: "bash",
    category: "execute",
    description: "Run shell commands (validated by CommandValidator)",
    callableName: "bash",
  },
  {
    name: "run_commands",
    category: "execute",
    description: "Run project commands (validated by CommandValidator)",
    callableName: "run_commands",
  },
  {
    name: "web_fetch",
    category: "network",
    description: "Fetch content from a URL",
    callableName: "fetch_web_content",
  },
  {
    name: "web_search",
    category: "network",
    description: "Search the web",
    callableName: "web_search",
  },
  {
    name: "skills",
    category: "agent",
    description:
      "Session skill context (injected as instructions; informational tool)",
    callableName: "skills",
  },
  {
    name: "ask_question",
    category: "agent",
    description: "Ask the user a clarifying question with options",
    callableName: "ask_question",
  },
];
