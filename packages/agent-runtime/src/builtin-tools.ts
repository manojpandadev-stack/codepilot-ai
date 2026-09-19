/**
 * @codepilot/agent-runtime — CodePilot-owned model-facing builtin tools.
 *
 * The tool SET mirrors the names the CodePilot product has always offered
 * the model (read_files, search_codebase, fetch_web_content, web_search,
 * ask_question, skills, editor, apply_patch, run_commands, plus the
 * host-override `bash` seam). Descriptions and schemas are CodePilot's own
 * wording, written to match the input shapes CodePilot's staging and
 * execution layers consume (notably the classic editor grammar in
 * write-tools.ts and the ChangeSet staging contract).
 *
 * Security model (read carefully — unchanged from the previous architecture):
 * - These tools NEVER approve, gate, or validate permissions. Every call
 *   passes the host `beforeTool` hook (M4) BEFORE dispatch reaches any
 *   `execute` below. An unapproved call never arrives here.
 * - Filesystem access is contained to the workspace root
 *   (`resolveWorkspacePath` — no traversal, no absolute escape).
 * - Reads are bounded (2000 lines / ~47k chars per file, binary rejected).
 * - Writes apply directly ONLY when no host executor override is installed
 *   (legacy/headless path); the VS Code host overrides editor/apply_patch
 *   to stage ChangeSets instead — the override seam takes precedence here.
 * - Network tools go through allow-listed, SSRF-guarded fetch only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolContext } from "@codepilot/llm";
import {
  CommandExecutionService,
} from "@codepilot/tool-engine";
import { fetchUrlContent } from "@codepilot/context-engine";
import {
  applyEditorOperation,
  parseApplyPatchInput,
  resolveWorkspacePath,
  MAX_PROPOSED_FILE_BYTES,
} from "./write-tools.js";

// ============================================================================
// Shared bounds + helpers (documented in tool descriptions where visible)
// ============================================================================

/** Max lines returned per file read (matches the documented tool contract). */
export const BUILTIN_READ_MAX_LINES = 2000;
/** Max chars returned per file read (~47k, matches the documented contract). */
export const BUILTIN_READ_MAX_CHARS = 47_000;
/** Max matches returned per search call. */
export const BUILTIN_SEARCH_MAX_MATCHES = 100;
/** Max files scanned per search call. */
export const BUILTIN_SEARCH_MAX_FILES = 2000;
/** Files larger than this are skipped by search. */
export const BUILTIN_SEARCH_MAX_FILE_BYTES = 500_000;
/** Bounded tool-result text for the model. */
export const BUILTIN_RESULT_MAX_CHARS = 48_000;

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "build",
  "dist",
  "__pycache__",
  ".gradle",
  ".idea",
  ".vscode",
  "vendor",
  ".next",
  "coverage",
  "out",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boundText(text: string, max = BUILTIN_RESULT_MAX_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... [truncated, ${text.length} chars total]`;
}

function readFileSafe(absolutePath: string): string | undefined {
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) return undefined;
    if (stat.size > MAX_PROPOSED_FILE_BYTES) return undefined;
    const buffer = fs.readFileSync(absolutePath);
    if (buffer.includes(0)) return undefined; // binary
    return buffer.toString("utf8");
  } catch {
    return undefined;
  }
}

interface ReadRequest {
  path: string;
  startLine?: number;
  endLine?: number;
}

function normalizeReadRequests(input: unknown): ReadRequest[] | { error: string } {
  const rec = asRecord(input);
  const rawList = Array.isArray(rec.files)
    ? (rec.files as unknown[])
    : rec.path !== undefined || rec.filePath !== undefined
      ? [rec]
      : [];
  if (rawList.length === 0) {
    return { error: "read_files requires { path } or { files: [{ path }] }" };
  }
  const out: ReadRequest[] = [];
  for (const raw of rawList.slice(0, 10)) {
    const r = asRecord(raw);
    const p =
      asString(r.path) ?? asString(r.filePath) ?? asString(r.file_path);
    if (!p) return { error: "read_files entry is missing its file path" };
    const start =
      typeof r.start_line === "number"
        ? r.start_line
        : typeof r.startLine === "number"
          ? r.startLine
          : undefined;
    const end =
      typeof r.end_line === "number"
        ? r.end_line
        : typeof r.endLine === "number"
          ? r.endLine
          : undefined;
    out.push({ path: p, startLine: start, endLine: end });
  }
  return out;
}

function sliceLines(
  content: string,
  startLine?: number,
  endLine?: number,
): string {
  const lines = content.split("\n");
  const from = Math.max(1, startLine ?? 1) - 1;
  const to =
    endLine !== undefined && endLine >= from + 1
      ? Math.min(lines.length, endLine)
      : lines.length;
  return lines.slice(from, to).join("\n").slice(0, BUILTIN_READ_MAX_CHARS);
}

// ============================================================================
// Tool implementations (each takes its workspace root + optional overrides)
// ============================================================================

export interface BuiltinToolOverrides {
  /** Host executor for `editor` (ChangeSet staging in VS Code). */
  editor?: (input: unknown, cwd: string, context: Record<string, unknown>) => Promise<string>;
  /** Host executor for `apply_patch` (ChangeSet staging in VS Code). */
  applyPatch?: (input: unknown, cwd: string, context: Record<string, unknown>) => Promise<string>;
  /** Host executor for `bash` (streaming terminal in VS Code). */
  bash?: (input: unknown, cwd: string, context: Record<string, unknown>) => Promise<string>;
}

export interface BuiltinToolOptions {
  cwd: string;
  overrides?: BuiltinToolOverrides;
  /** Shared command service for run_commands/bash defaults. */
  commandService?: CommandExecutionService;
  /**
   * Streaming terminal runner (the M7 streaming shell executor). When
   * provided, `run_commands` executes every command through it so live
   * stdout/stderr chunks reach the UI WHILE each command runs — the same
   * single streaming path the native `bash` tool uses (never a second
   * engine). The runner owns event fan-out; run_commands only sequences
   * commands and maps the outcome. Omitted in headless contexts, which
   * keep the completion-oriented collection path below.
   */
  streamingCommandRunner?: (input: {
    command: string;
    signal?: AbortSignal;
    toolCallId?: string;
  }) => Promise<string>;
}

function toolContext(
  toolCallId: string,
  sessionId: string,
): Record<string, unknown> {
  return { toolCallId, sessionId };
}

function readFilesTool(cwd: string): AgentTool {
  return {
    name: "read_files",
    description:
      "Read text file content from the workspace. Each read returns at most " +
      "2000 lines / ~47k characters; longer files report page hints — " +
      "re-read with start_line/end_line. Binary files are rejected. " +
      "Paths are workspace-relative; absolute paths and `..` are rejected.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          description: "Files to read.",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Workspace-relative file path." },
              start_line: { type: "number", description: "1-based first line (optional)." },
              end_line: { type: "number", description: "1-based last line, inclusive (optional)." },
            },
            required: ["path"],
          },
        },
      },
    },
    execute: async (input: unknown) => {
      const requests = normalizeReadRequests(input);
      if (!Array.isArray(requests)) throw new Error(requests.error);
      const results: Array<Record<string, unknown>> = [];
      for (const req of requests) {
        const resolved = resolveWorkspacePath(req.path, cwd);
        if (!resolved.ok) {
          results.push({ query: req.path, error: resolved.error });
          continue;
        }
        const content = readFileSafe(resolved.absolutePath);
        if (content === undefined) {
          results.push({
            query: req.path,
            error: `cannot read ${resolved.relativePath} (missing, binary, or oversized)`,
          });
          continue;
        }
        const lines = content.split("\n").length;
        results.push({
          query: req.path,
          path: resolved.relativePath,
          totalLines: lines,
          content: sliceLines(content, req.startLine, req.endLine),
        });
      }
      return results;
    },
  };
}

function searchCodebaseTool(cwd: string): AgentTool {
  return {
    name: "search_codebase",
    description:
      "Search workspace file contents with regex patterns. Ignores " +
      "dependency/build directories and files over ~500KB. Returns at most " +
      "100 matches with file, line, and text.",
    inputSchema: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          description: "Regex patterns to search for.",
          items: { type: "string" },
        },
        query: {
          type: "string",
          description: "Single regex pattern (alternative to queries).",
        },
      },
    },
    execute: async (input: unknown) => {
      const rec = asRecord(input);
      const queries = Array.isArray(rec.queries)
        ? (rec.queries as unknown[]).filter(
            (q): q is string => typeof q === "string" && q.length > 0,
          )
        : typeof rec.query === "string" && rec.query.length > 0
          ? [rec.query]
          : [];
      if (queries.length === 0) {
        throw new Error("search_codebase requires { query } or { queries: [...] }");
      }
      const compiled: RegExp[] = [];
      for (const q of queries.slice(0, 10)) {
        try {
          compiled.push(new RegExp(q));
        } catch {
          throw new Error(`search_codebase: invalid regex ${JSON.stringify(q.slice(0, 120))}`);
        }
      }
      const files: string[] = [];
      const scan = (dir: string, depth: number): void => {
        if (depth > 8 || files.length >= BUILTIN_SEARCH_MAX_FILES) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (files.length >= BUILTIN_SEARCH_MAX_FILES) return;
          if (IGNORED_DIRS.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) scan(full, depth + 1);
          else if (entry.isFile()) files.push(full);
        }
      };
      scan(cwd, 0);
      const results: Array<Record<string, unknown>> = [];
      for (const [qi, rx] of compiled.entries()) {
        const query = queries[qi]!;
        let matches = 0;
        for (const file of files) {
          if (results.length >= BUILTIN_SEARCH_MAX_MATCHES) break;
          let stat: fs.Stats;
          try {
            stat = fs.statSync(file);
          } catch {
            continue;
          }
          if (!stat.isFile() || stat.size > BUILTIN_SEARCH_MAX_FILE_BYTES) continue;
          let content: string;
          try {
            const buffer = fs.readFileSync(file);
            if (buffer.includes(0)) continue;
            content = buffer.toString("utf8");
          } catch {
            continue;
          }
          const rel = path.relative(cwd, file).replace(/\\/g, "/");
          const lines = content.split("\n");
          for (let ln = 0; ln < lines.length; ln += 1) {
            if (results.length >= BUILTIN_SEARCH_MAX_MATCHES) break;
            const text = lines[ln] ?? "";
            let matched = false;
            try {
              matched = rx.test(text);
            } catch {
              continue;
            }
            if (matched) {
              matches += 1;
              results.push({
                query,
                path: rel,
                line: ln + 1,
                text: text.slice(0, 500),
              });
            }
          }
        }
        if (matches === 0) results.push({ query, matches: 0 });
      }
      return results;
    },
  };
}

function fetchWebContentTool(): AgentTool {
  return {
    name: "fetch_web_content",
    description:
      "Fetch a public HTTP/HTTPS URL and return readable text (scripts and " +
      "markup stripped, bounded). Private/internal/hostile URLs are blocked. " +
      "Only HTTP/HTTPS URLs are allowed.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to fetch." },
      },
      required: ["url"],
    },
    execute: async (input: unknown) => {
      const url = asString(asRecord(input).url);
      if (!url) throw new Error("fetch_web_content requires { url }");
      const items = await fetchUrlContent(url, {
        timeoutMs: 15_000,
        maxChars: 30_000,
      });
      return items.map((item) => item.content).join("\n\n");
    },
  };
}

const WEB_SEARCH_ALLOWLIST = ["api.duckduckgo.com"];

function webSearchTool(): AgentTool {
  return {
    name: "web_search",
    description:
      "Search the public web for a query. Best-effort: returns instant-answer " +
      "results when available, otherwise states that no results were found. " +
      "Only the allow-listed search endpoint is contacted.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
      },
      required: ["query"],
    },
    execute: async (input: unknown) => {
      const query = asString(asRecord(input).query);
      if (!query) throw new Error("web_search requires { query }");
      // Reuses the audited fetch pipeline (SSRF guard + domain allow-list).
      const items = await fetchUrlContent(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
        {
          timeoutMs: 15_000,
          maxChars: 30_000,
          allowedDomains: [...WEB_SEARCH_ALLOWLIST],
        },
      );
      const text = items.map((item) => item.content).join("\n\n");
      if (text.startsWith("Error")) {
        return `Web search unavailable: ${text.slice(0, 300)}`;
      }
      let body: {
        AbstractText?: unknown;
        AbstractURL?: unknown;
        RelatedTopics?: unknown;
      };
      try {
        // The JSON payload rides inside the returned content block.
        const jsonStart = text.indexOf("{");
        body = (
          jsonStart >= 0 ? JSON.parse(text.slice(jsonStart)) : {}
        ) as typeof body;
        const lines: string[] = [];
        if (typeof body.AbstractText === "string" && body.AbstractText.trim()) {
          lines.push(`Summary: ${body.AbstractText.trim().slice(0, 2000)}`);
          if (typeof body.AbstractURL === "string" && body.AbstractURL) {
            lines.push(`Source: ${body.AbstractURL}`);
          }
        }
        if (Array.isArray(body.RelatedTopics)) {
          let count = 0;
          for (const topic of body.RelatedTopics) {
            if (count >= 5) break;
            const t = topic as { Text?: unknown; FirstURL?: unknown };
            if (t && typeof t.Text === "string" && t.Text.trim()) {
              lines.push(
                `- ${t.Text.trim().slice(0, 300)}${typeof t.FirstURL === "string" && t.FirstURL ? ` (${t.FirstURL})` : ""}`,
              );
              count += 1;
            }
          }
        }
        return lines.length > 0
          ? lines.join("\n")
          : `No instant results for ${JSON.stringify(query.slice(0, 120))}.`;
      } catch {
        return `Web search returned an unreadable response for ${JSON.stringify(query.slice(0, 120))}.`;
      }
    },
  };
}

function askQuestionTool(): AgentTool {
  return {
    name: "ask_question",
    description:
      "Ask the user one clarifying question with 2-5 options. In " +
      "non-interactive runs there is no one to answer: acknowledge the " +
      "question and proceed with best judgment instead of stalling.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The clarifying question." },
        options: {
          type: "array",
          description: "2-5 answer options.",
          items: { type: "string" },
        },
      },
      required: ["question"],
    },
    execute: async (input: unknown) => {
      const rec = asRecord(input);
      const question = asString(rec.question);
      if (!question) throw new Error("ask_question requires { question }");
      const options = Array.isArray(rec.options)
        ? (rec.options as unknown[]).filter((o): o is string => typeof o === "string").slice(0, 5)
        : [];
      return JSON.stringify({
        acknowledged: true,
        question: question.slice(0, 1000),
        options,
        note: "No interactive user is available in this run. Proceed with best judgment.",
      });
    },
  };
}

function skillsTool(): AgentTool {
  return {
    name: "skills",
    description:
      "Skills available to this session are already injected into the " +
      "session instructions as an Active skills block. There are no " +
      "executable skill actions — continue with the task using the " +
      "instructions provided.",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Skill name (informational)." },
      },
    },
    execute: async (input: unknown) => {
      const skill = asString(asRecord(input).skill) ?? "";
      return (
        "Skills are provided as session instructions (see the Active skills " +
        "block); there are no executable skill actions in this session." +
        (skill ? ` Referenced skill: ${skill.slice(0, 128)}.` : "")
      );
    },
  };
}

function editorTool(
  cwd: string,
  overrides: BuiltinToolOverrides,
): AgentTool {
  return {
    name: "editor",
    description:
      "Edit a workspace file with classic operations (str_replace, insert, " +
      "replace_all, delete, create). Paths are workspace-relative; absolute " +
      "paths and `..` are rejected. Single `operations` array or top-level " +
      "op fields; all operations must target the same file.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Workspace-relative file path." },
        op: {
          type: "string",
          description: "Operation: str_replace, insert, replace_all, delete, create.",
        },
        old_string: { type: "string", description: "Text to match (not needed for create)." },
        new_string: { type: "string", description: "Replacement/inserted text." },
        operations: {
          type: "array",
          description: "Multiple operations against the same file.",
          items: { type: "object" },
        },
      },
      required: ["file_path"],
    },
    execute: async (input: unknown, ctx?: AgentToolContext) => {
      if (overrides.editor) {
        return overrides.editor(input, cwd, toolContext(
          typeof ctx?.toolCallId === "string" ? ctx.toolCallId : "editor",
          typeof ctx?.sessionId === "string" ? ctx.sessionId : "",
        ));
      }
      // Legacy/headless default: apply directly (M4 still gates via beforeTool).
      const rec = asRecord(input);
      const filePath = asString(rec.file_path) ?? asString(rec.filePath) ?? "";
      const resolved = resolveWorkspacePath(filePath, cwd);
      if (!resolved.ok) throw new Error(resolved.error);
      const original = readFileSafe(resolved.absolutePath);
      const rawOps =
        Array.isArray(rec.operations) && (rec.operations as unknown[]).length > 0
          ? (rec.operations as Record<string, unknown>[])
          : [rec];
      let content = original;
      const summaries: string[] = [];
      for (const rawOp of rawOps) {
        const res = applyEditorOperation(content, asRecord(rawOp));
        if (!res.ok) throw new Error(res.error);
        content = res.content;
        summaries.push(res.summary);
      }
      if (content === undefined) throw new Error("editor produced no file content");
      fs.mkdirSync(path.dirname(resolved.absolutePath), { recursive: true });
      fs.writeFileSync(resolved.absolutePath, content, "utf8");
      return `Edited ${resolved.relativePath}: ${summaries.join("; ")}`;
    },
  };
}

function applyPatchTool(
  cwd: string,
  overrides: BuiltinToolOverrides,
): AgentTool {
  return {
    name: "apply_patch",
    description:
      "Apply a unified diff to workspace files. Paths in the patch are " +
      "workspace-relative; hunks that do not apply cleanly fail the whole " +
      "call. Use `editor` for single edits instead.",
    inputSchema: {
      type: "object",
      properties: {
        patch: { type: "string", description: "Unified diff text." },
      },
      required: ["patch"],
    },
    execute: async (input: unknown, ctx?: AgentToolContext) => {
      if (overrides.applyPatch) {
        return overrides.applyPatch(input, cwd, toolContext(
          typeof ctx?.toolCallId === "string" ? ctx.toolCallId : "apply_patch",
          typeof ctx?.sessionId === "string" ? ctx.sessionId : "",
        ));
      }
      const parsed = await parseApplyPatchInput(asRecord(input), cwd);
      if (!parsed.ok) throw new Error(parsed.error);
      for (const proposal of parsed.proposals) {
        const resolved = resolveWorkspacePath(proposal.relativePath, cwd);
        if (!resolved.ok) throw new Error(resolved.error);
        if (proposal.proposedContent === "") {
          try {
            fs.rmSync(resolved.absolutePath, { force: true });
          } catch (err) {
            throw new Error(
              `apply_patch delete failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          continue;
        }
        fs.mkdirSync(path.dirname(resolved.absolutePath), { recursive: true });
        fs.writeFileSync(resolved.absolutePath, proposal.proposedContent, "utf8");
      }
      return `Applied patch to ${parsed.proposals.length} file(s): ${parsed.proposals
        .map((p) => p.relativePath)
        .join(", ")}`;
    },
  };
}

function runCommandsTool(
  cwd: string,
  service: CommandExecutionService,
  options?: { streamingCommandRunner?: BuiltinToolOptions["streamingCommandRunner"] },
): AgentTool {
  return {
    name: "run_commands",
    description:
      "Run non-interactive shell commands from the workspace root. " +
      "PowerShell syntax on Windows, bash syntax on POSIX. Commands must " +
      "complete on their own (no interactivity, no pagers). Output is " +
      "bounded; filter with grep/head/tail for specifics. " +
      "Accepts { command } or { commands: [...] } (run sequentially).",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Single shell command." },
        commands: {
          type: "array",
          description: "Multiple commands, run sequentially.",
          items: { type: "string" },
        },
      },
    },
    execute: async (input: unknown, ctx?: AgentToolContext) => {
      const rec = asRecord(input);
      const commands = Array.isArray(rec.commands)
        ? (rec.commands as unknown[]).filter(
            (c): c is string => typeof c === "string" && c.length > 0,
          )
        : typeof rec.command === "string" && rec.command.length > 0
          ? [rec.command]
          : [];
      if (commands.length === 0) {
        throw new Error("run_commands requires { command } or { commands: [...] }");
      }
      const signal =
        ctx?.signal instanceof AbortSignal ? ctx.signal : undefined;
      // Streaming path (VS Code runtime): every command runs through the
      // M7 streaming shell executor, so stdout/stderr stream live under
      // this tool call instead of appearing only at completion. Output,
      // exit-code, timeout and cancellation semantics are unchanged.
      if (options?.streamingCommandRunner) {
        const outputs: string[] = [];
        for (const command of commands.slice(0, 20)) {
          const output = await options.streamingCommandRunner({
            command,
            ...(signal ? { signal } : {}),
            ...(ctx?.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
          });
          outputs.push(`$ ${command}\n${boundText(output, 8000)}`);
        }
        return boundText(outputs.join("\n\n"));
      }
      // Headless default: completion-oriented collection (no UI fan-out).
      const outputs: string[] = [];
      for (const command of commands.slice(0, 20)) {
        const output = await service.run(
          { command, args: [], cwd, timeoutMs: 120_000 },
          {
            ...(signal ? { signal } : {}),
            executionId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          },
        );
        const combined =
          output.stdout +
          (output.stderr.length > 0 ? `\n[stderr]\n${output.stderr}` : "");
        if (output.cancelled) throw new Error("Command cancelled");
        if (output.timedOut) {
          throw new Error(`Command timed out: ${command.slice(0, 200)}`);
        }
        if (output.exitCode !== 0 && output.exitCode !== null) {
          throw new Error(
            `[Command exited with code ${output.exitCode}]\n${boundText(combined, 8000)}`,
          );
        }
        outputs.push(`$ ${command}\n${boundText(combined, 8000)}`);
      }
      return boundText(outputs.join("\n\n"));
    },
  };
}

function bashTool(
  cwd: string,
  overrides: BuiltinToolOverrides,
  service: CommandExecutionService,
): AgentTool {
  return {
    name: "bash",
    description:
      "Run a single non-interactive shell command from the workspace root " +
      "(PowerShell syntax on Windows, bash on POSIX). Same execution path " +
      "as run_commands; prefer run_commands for multiple commands.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run." },
      },
      required: ["command"],
    },
    execute: async (input: unknown, ctx?: AgentToolContext) => {
      if (overrides.bash) {
        return overrides.bash(input, cwd, toolContext(
          typeof ctx?.toolCallId === "string" ? ctx.toolCallId : "bash",
          typeof ctx?.sessionId === "string" ? ctx.sessionId : "",
        ));
      }
      const command = asString(asRecord(input).command);
      if (!command) throw new Error("bash requires { command }");
      return runCommandsTool(cwd, service).execute({ command }, ctx);
    },
  };
}

export interface CodePilotBuiltinOptions {
  cwd: string;
  /** Enable the direct `bash` tool (legacy/headless contract). */
  enableBash?: boolean;
  /** Offer web tools (disable for local-only privacy). */
  enableWebFetch?: boolean;
  /** Host executor overrides (VS Code staging/streaming). */
  overrides?: BuiltinToolOverrides;
  /** Shared command service (created when omitted). */
  commandService?: CommandExecutionService;
  /** Streaming terminal runner for `run_commands` (see BuiltinToolOptions). */
  streamingCommandRunner?: BuiltinToolOptions["streamingCommandRunner"];
}

/**
 * Build the CodePilot model-facing builtin tool set.
 *
 * Mirrors the legacy `createBuiltinTools({ cwd, enableBash, enableWebFetch })`
 * contract: read + search always on, web tools gated by `enableWebFetch`,
 * `bash` gated by `enableBash`. Host executor overrides take precedence
 * over every default implementation.
 */
export function createCodePilotBuiltinTools(
  options: CodePilotBuiltinOptions,
): AgentTool[] {
  const service = options.commandService ?? new CommandExecutionService();
  const overrides = options.overrides ?? {};
  const tools: AgentTool[] = [
    readFilesTool(options.cwd),
    searchCodebaseTool(options.cwd),
    skillsTool(),
    askQuestionTool(),
    editorTool(options.cwd, overrides),
    applyPatchTool(options.cwd, overrides),
    runCommandsTool(options.cwd, service, {
      ...(options.streamingCommandRunner
        ? { streamingCommandRunner: options.streamingCommandRunner }
        : {}),
    }),
  ];
  if (options.enableBash !== false) {
    tools.push(bashTool(options.cwd, overrides, service));
  }
  if (options.enableWebFetch === true) {
    tools.push(fetchWebContentTool(), webSearchTool());
  }
  return tools;
}

/**
 * Legacy-compatible factory shape (`createBuiltinTools({ cwd, enableBash,
 * enableWebFetch })`) for the headless agent path.
 */
export function createBuiltinTools(options: {
  cwd: string;
  enableBash?: boolean;
  enableWebFetch?: boolean;
}): AgentTool[] {
  return createCodePilotBuiltinTools({
    cwd: options.cwd,
    enableBash: options.enableBash,
    enableWebFetch: options.enableWebFetch,
  });
}

/**
 * Every tool name the native model-facing set can offer (all-enabled
 * factory output plus the native `bash`/staged-write names, which are the
 * same tools). Single source of truth for UI display contracts and
 * contract tests — the Tools tab must never show a builtin name outside
 * this set unless it maps to one (see tool-contract.ts in the host).
 */
export const CODEPILOT_MODEL_TOOL_NAMES: readonly string[] = [
  "read_files",
  "search_codebase",
  "skills",
  "ask_question",
  "editor",
  "apply_patch",
  "run_commands",
  "bash",
  "fetch_web_content",
  "web_search",
];
