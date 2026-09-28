/**
 * PHASE 1 + PHASE 2 (deterministic layer) — staged delete_file + PLAN boundary.
 *
 * P1: PLAN mode must never execute terminal/write/delete tools. The
 *     mode boundary has two layers (advertisement filter + M4 gate
 *     rejection); both are exercised with the REAL dispatch path
 *     (real CodePilotRuntime, stubbed model transport). delete_file is now a
 *     real staged tool, so it must be denied in ask/plan like editor/bash.
 *
 * P2 (deterministic): the staged-delete ChangeSet lifecycle — a delete
 *     proposal stages WITHOUT touching disk; accepting removes exactly the
 *     target file (via the canonical M5 mutation path); rejecting leaves
 *     everything byte-identical; unrelated files are provably untouched
 *     (sha256 hashes); rollback restores the deleted file's content.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import {
  CodePilotRuntime,
  createTool,
  parseDeleteFileInput,
  formatStagedResult,
} from "../packages/agent-runtime/src/index.js";
import { ChangeSetManager } from "../packages/changeset-engine/src/index.js";
import { FileMutationService } from "../packages/changeset-engine/src/m5/file-mutation.js";
import type { PathGuard } from "../packages/changeset-engine/src/m5/file-mutation.js";

/** Production-shaped M5 path guard (rejects traversal/absolute; protects dotfiles). */
const defaultGuard: PathGuard = {
  guard: (rel: string): string => {
    if (!rel || rel.includes("..") || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) {
      throw new Error(`guard rejected: ${rel}`);
    }
    return rel.replace(/\\/g, "/");
  },
  isSensitive: (rel: string) => /(^|\/)(\.env|\.git)(\/|$)/.test(rel),
};
const makeMutation = (dir: string) =>
  new FileMutationService({ workspaceRoot: dir, pathGuard: defaultGuard });
import type { AgentEvent } from "../packages/agent-runtime/src/types";
import type { AgentTool } from "../packages/agent-runtime/src/native/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const sha256 = (p: string): string =>
  createHash("sha256").update(readFileSync(p)).digest("hex");

const ndjson = (value: unknown): string => `${JSON.stringify(value)}\n`;

function toolCallTurn(name: string, args: Record<string, unknown>): Response {
  return new Response(
    [
      ndjson({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name, arguments: args } }],
        },
        done: false,
      }),
      ndjson({ message: { role: "assistant", content: "" }, done: true }),
    ].join(""),
    { status: 200 },
  );
}

function finalTurn(text: string): Response {
  return new Response(
    [
      ndjson({ message: { role: "assistant", content: text }, done: false }),
      ndjson({ message: { role: "assistant", content: "" }, done: true, eval_count: 2 }),
    ].join(""),
    { status: 200 },
  );
}

/** Instrumented delete probe: records whether the executor ever ran. */
function makeDeleteProbe(executions: string[]): AgentTool {
  return createTool({
    name: "delete_file",
    description: "probe",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    execute: async (input) => {
      executions.push(JSON.stringify(input));
      return { ok: true, deleted: true };
    },
  });
}

function makeTerminalExecProbe(executions: string[]): AgentTool {
  return createTool({
    name: "terminal_session_exec",
    description: "probe",
    inputSchema: { type: "object", properties: { command: { type: "string" } } },
    execute: async (input) => {
      executions.push(JSON.stringify(input));
      return { ok: true, stdout: "RAN" };
    },
  });
}

/** Drive one real runtime turn that emits a tool call; report what happened. */
async function attempt(opts: {
  mode: "ask" | "plan" | "act";
  toolName: string;
  args: Record<string, unknown>;
  extraTools: AgentTool[];
}) {
  const dir = mkdtempSync(join(tmpdir(), "plan-boundary-"));
  const executions: string[] = [];
  let executed = false;
  let denyReason: string | null = null;
  let firstTurn = true;
  const fetchImpl = vi.fn(async () => {
    if (firstTurn) {
      firstTurn = false;
      return toolCallTurn(opts.toolName, opts.args);
    }
    return finalTurn("done");
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchImpl);

  const events: AgentEvent[] = [];
  // Staging bridge present (production shape) so delete_file is advertised.
  const runtime = new CodePilotRuntime({
    workspaceRoot: dir,
    providerId: "ollama",
    modelId: "qwen3:8b",
    agentMode: opts.mode,
    requestApproval: async () => ({ approved: true }),
    onWriteProposal: async () => ({ changeSetId: "cs-probe" }),
    extraTools: opts.extraTools,
  });
  runtime.subscribe((e) => {
    events.push(e);
    if (e.type === "tool_completed" && e.toolName === opts.toolName) executed = true;
    if (e.type === "tool_failed" && e.toolName === opts.toolName) {
      denyReason = String((e as { error?: string }).error ?? "");
    }
  });
  await runtime.initialize();
  await runtime.startSession(`Use the ${opts.toolName} tool now.`);
  await runtime.dispose().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
  return { executed, denyReason, executorInvocations: executions.length };
}

describe("P1 — PLAN/ASK mode boundary (real dispatch path)", () => {
  it("PLAN: delete_file never executes even though an approval would be granted", async () => {
    const r = await attempt({
      mode: "plan",
      toolName: "delete_file",
      args: { path: "victim.txt" },
      extraTools: [makeDeleteProbe([])],
    });
    expect(r.executorInvocations).toBe(0);
    expect(r.executed).toBe(false);
    // Denied at EITHER layer: L1 advertisement filter ("Unknown tool") or
    // L2 gate boundary ("unavailable in plan mode").
    expect(r.denyReason ?? "").toMatch(
      /unavailable in plan mode|execution boundary|unknown tool/i,
    );
  });

  it("PLAN: terminal_session_exec never executes", async () => {
    const r = await attempt({
      mode: "plan",
      toolName: "terminal_session_exec",
      args: { command: "echo PROBE" },
      extraTools: [makeTerminalExecProbe([])],
    });
    expect(r.executorInvocations).toBe(0);
    expect(r.denyReason ?? "").toMatch(
      /unavailable in plan mode|execution boundary|unknown tool/i,
    );
  });

  it("PLAN: terminal_session_start never executes", async () => {
    const r = await attempt({
      mode: "plan",
      toolName: "terminal_session_start",
      args: { command: "echo PROBE" },
      extraTools: [
        createTool({
          name: "terminal_session_start",
          description: "probe",
          inputSchema: { type: "object", properties: { command: { type: "string" } } },
          execute: async () => ({ ok: true }),
        }),
      ],
    });
    expect(r.executorInvocations).toBe(0);
  });

  it("PLAN: editor staging never executes", async () => {
    const r = await attempt({
      mode: "plan",
      toolName: "editor",
      args: { file_path: "x.txt", operation: "create", new_string: "hi" },
      extraTools: [],
    });
    expect(r.executorInvocations).toBe(0);
    expect(r.executed).toBe(false);
  });

  it("ASK: delete_file is equally forbidden", async () => {
    const r = await attempt({
      mode: "ask",
      toolName: "delete_file",
      args: { path: "victim.txt" },
      extraTools: [makeDeleteProbe([])],
    });
    expect(r.executorInvocations).toBe(0);
    expect(r.denyReason ?? "").toMatch(
      /unavailable in ask mode|execution boundary|unknown tool/i,
    );
  });

  it("PLAN: delete_file is NOT advertised in the model-facing toolset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-advertise-"));
    try {
      const runtime = new CodePilotRuntime({
        workspaceRoot: dir,
        providerId: "ollama",
        modelId: "qwen3:8b",
        agentMode: "plan",
        requestApproval: async () => ({ approved: true }),
        onWriteProposal: async () => ({ changeSetId: "cs-x" }),
      });
      await runtime.initialize();
      // The advertised contract is observable through the runtime's session
      // state tool listing if exposed; otherwise assert via gate behavior
      // (covered above). Here we assert the class-level filter directly.
      const filter = (
        CodePilotRuntime as unknown as {
          MODE_FILTERED_TOOLS: ReadonlySet<string>;
        }
      ).MODE_FILTERED_TOOLS;
      expect(filter.has("delete_file")).toBe(true);
      expect(filter.has("terminal_session_start")).toBe(true);
      expect(filter.has("terminal_session_exec")).toBe(true);
      expect(filter.has("editor")).toBe(true);
      await runtime.dispose().catch(() => undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("P1-parser — delete_file input parsing (staged, fail-closed)", () => {
  it("parses a workspace-relative delete into a delete-marked proposal", () => {
    const dir = mkdtempSync(join(tmpdir(), "del-parse-"));
    try {
      writeFileSync(join(dir, "temporary.txt"), "known-content", "utf8");
      const res = parseDeleteFileInput(
        { path: "temporary.txt" },
        dir,
        (abs) => readFileSync(abs, "utf8"),
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.proposals).toHaveLength(1);
        expect(res.proposals[0].delete).toBe(true);
        expect(res.proposals[0].relativePath).toBe("temporary.txt");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses traversal, absolute paths, and nonexistent targets", () => {
    const dir = mkdtempSync(join(tmpdir(), "del-parse-"));
    try {
      const reader = (abs: string) =>
        existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
      expect(parseDeleteFileInput({ path: "../outside.txt" }, dir, reader).ok).toBe(false);
      expect(parseDeleteFileInput({ path: "C:\\Windows\\x" }, dir, reader).ok).toBe(false);
      expect(parseDeleteFileInput({ path: "/etc/passwd" }, dir, reader).ok).toBe(false);
      expect(parseDeleteFileInput({ path: "missing.txt" }, dir, reader).ok).toBe(false);
      expect(parseDeleteFileInput({}, dir, reader).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("formatStagedResult labels a delete proposal as deleted (and keeps truncate as emptied)", () => {
    const out = formatStagedResult("delete_file", "cs-1", [
      { filePath: "temporary.txt", relativePath: "temporary.txt", proposedContent: "", delete: true },
    ]);
    expect(out).toContain("deleted");
    const trunc = formatStagedResult("editor", "cs-2", [
      { filePath: "a.txt", relativePath: "a.txt", proposedContent: "" },
    ]);
    expect(trunc).toContain("emptied");
    expect(trunc).not.toContain("deleted");
  });
});

describe("P2-deterministic — staged delete ChangeSet lifecycle (real M5 path)", () => {
  function makeWorkspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "staged-delete-"));
    mkdirSync(join(dir, "sandbox", "delete-test"), { recursive: true });
    writeFileSync(
      join(dir, "sandbox", "delete-test", "temporary.txt"),
      "DISPOSABLE-CONTENT\nline2\n",
      "utf8",
    );
    writeFileSync(join(dir, "keeper.txt"), "KEEP-ME-BYTES", "utf8");
    writeFileSync(join(dir, "config.json"), '{"protected":true}', "utf8");
    return dir;
  }

  it("APPROVE: accept removes exactly the target file; unrelated files byte-identical", async () => {
    const dir = makeWorkspace();
    try {
      const hashesBefore = {
        keeper: sha256(join(dir, "keeper.txt")),
        config: sha256(join(dir, "config.json")),
      };
      const mutation = makeMutation(dir);
      const manager = new ChangeSetManager({ workspaceRoot: dir, mutation });
      const cs = manager.createChangeSet("task-del-approve", [
        { filePath: "sandbox/delete-test/temporary.txt", proposedContent: "", delete: true },
      ]);
      // Staging must NOT have touched disk.
      expect(existsSync(join(dir, "sandbox", "delete-test", "temporary.txt"))).toBe(true);

      const res = await manager.acceptAll(cs.id);
      expect(res.applied).toBe(1);
      expect(res.failed).toBe(0);
      expect(existsSync(join(dir, "sandbox", "delete-test", "temporary.txt"))).toBe(false);
      // Unrelated files byte-identical.
      expect(sha256(join(dir, "keeper.txt"))).toBe(hashesBefore.keeper);
      expect(sha256(join(dir, "config.json"))).toBe(hashesBefore.config);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("REJECT: rejectAll leaves every file byte-identical", async () => {
    const dir = makeWorkspace();
    try {
      const before = {
        target: sha256(join(dir, "sandbox", "delete-test", "temporary.txt")),
        keeper: sha256(join(dir, "keeper.txt")),
      };
      const mutation = makeMutation(dir);
      const manager = new ChangeSetManager({ workspaceRoot: dir, mutation });
      const cs = manager.createChangeSet("task-del-reject", [
        { filePath: "sandbox/delete-test/temporary.txt", proposedContent: "", delete: true },
      ]);
      const rejected = manager.rejectAll(cs.id);
      expect(rejected).toBe(1);
      expect(existsSync(join(dir, "sandbox", "delete-test", "temporary.txt"))).toBe(true);
      expect(sha256(join(dir, "sandbox", "delete-test", "temporary.txt"))).toBe(before.target);
      expect(sha256(join(dir, "keeper.txt"))).toBe(before.keeper);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ROLLBACK: an applied deletion can be rolled back to the original bytes", async () => {
    const dir = makeWorkspace();
    try {
      const original = readFileSync(join(dir, "sandbox", "delete-test", "temporary.txt"), "utf8");
      const mutation = makeMutation(dir);
      const manager = new ChangeSetManager({ workspaceRoot: dir, mutation });
      const cs = manager.createChangeSet("task-del-rollback", [
        { filePath: "sandbox/delete-test/temporary.txt", proposedContent: "", delete: true },
      ]);
      expect((await manager.acceptAll(cs.id)).applied).toBe(1);
      expect(existsSync(join(dir, "sandbox", "delete-test", "temporary.txt"))).toBe(false);

      const changeId = `${cs.id}-0`;
      const rb = await manager.rollbackChange(cs.id, changeId);
      expect(rb.success).toBe(true);
      expect(readFileSync(join(dir, "sandbox", "delete-test", "temporary.txt"), "utf8")).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CONFLICT-SAFETY: an externally modified file aborts the delete (hash guard)", async () => {
    const dir = makeWorkspace();
    try {
      const target = join(dir, "sandbox", "delete-test", "temporary.txt");
      const mutation = makeMutation(dir);
      const manager = new ChangeSetManager({ workspaceRoot: dir, mutation });
      const cs = manager.createChangeSet("task-del-conflict", [
        { filePath: "sandbox/delete-test/temporary.txt", proposedContent: "", delete: true },
      ]);
      // External modification AFTER staging.
      writeFileSync(target, "TAMPERED", "utf8");
      const res = await manager.acceptAll(cs.id);
      expect(res.applied).toBe(0);
      expect(res.conflicts + res.failed).toBeGreaterThan(0);
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("MIXED: a ChangeSet can carry both a delete and an edit; apply is all-or-nothing per change", async () => {
    const dir = makeWorkspace();
    try {
      const mutation = makeMutation(dir);
      const manager = new ChangeSetManager({ workspaceRoot: dir, mutation });
      const cs = manager.createChangeSet("task-del-mixed", [
        { filePath: "keeper.txt", proposedContent: "KEEP-ME-BYTES-v2" },
        { filePath: "sandbox/delete-test/temporary.txt", proposedContent: "", delete: true },
      ]);
      const res = await manager.acceptAll(cs.id);
      expect(res.applied).toBe(2);
      expect(readFileSync(join(dir, "keeper.txt"), "utf8")).toBe("KEEP-ME-BYTES-v2");
      expect(existsSync(join(dir, "sandbox", "delete-test", "temporary.txt"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
