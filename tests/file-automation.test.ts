/**
 * Phase 11 — file automation end-to-end in a TEMP workspace.
 *
 * Deterministic: the model is faked at the Ollama wire protocol, but the
 * runtime, builtin tools, file reads, M4 gate and ChangeSet staging are all
 * REAL. This proves the full file-automation chain:
 *
 *   A. READ  — a read_files tool call reads the REAL file from the temp
 *      workspace; the actual disk content physically reaches the model's
 *      next request (role:"tool"); the model's answer then completes the run.
 *
 *   B. EDIT  — an editor tool call is approved through the M4 gate (the
 *      approval card event fires), then stages a ChangeSet through the REAL
 *      ChangeSetManager via the same onWriteProposal seam the VS Code host
 *      wires. The staged result (NOT a file write) returns to the model;
 *      the file on disk is untouched until the ChangeSet is accepted.
 *
 *   C. EDIT-DENIED — a rejected M4 approval stages NOTHING and the file is
 *      untouched.
 *
 * No destructive operations, no production files, no phrase-based execution.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { CodePilotRuntime } from "../packages/agent-runtime/src/index.js";
import type { AgentEvent } from "../packages/agent-runtime/src/types";
import { ChangeSetManager } from "../packages/changeset-engine/src/index";

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

describe("Phase 11 — file automation (temp workspace, real tools)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "phase11-files-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  const makeRuntime = (
    approve: boolean,
    approvals: Array<{ toolName: string; input: unknown }>,
  ): CodePilotRuntime => {
    const runtime = new CodePilotRuntime({
      workspaceRoot: dir,
      providerId: "ollama",
      modelId: "qwen3:8b",
      agentMode: "act",
      requestApproval: async (req) => {
        approvals.push({ toolName: req.toolName, input: req.input });
        return { approved: approve, reason: approve ? undefined : "user denied" };
      },
    });
    return runtime;
  };

  const sinkOf = (runtime: CodePilotRuntime) => {
    const events: AgentEvent[] = [];
    runtime.subscribe((e) => events.push(e));
    return {
      events,
      byType: (t: string) => events.filter((e) => e.type === t),
    };
  };

  it("READ: real file content is read from disk and returned to the model", async () => {
    const content =
      "public class PlannerAgent {\n  // marker PLANNER_V1\n}\n";
    writeFileSync(join(dir, "PlannerAgent.java"), content, "utf8");

    // Turn 1: model asks for the file; Turn 2 (after a role:"tool" message
    // appears in the request): model answers from the returned content.
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_input: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      bodies.push(body);
      const sawToolResult = (body.messages as Array<Record<string, unknown>>).some(
        (m) => m.role === "tool",
      );
      return sawToolResult
        ? finalTurn("The first line is: public class PlannerAgent {")
        : toolCallTurn("read_files", { files: [{ path: "PlannerAgent.java" }] });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    const approvals: Array<{ toolName: string; input: unknown }> = [];
    const runtime = makeRuntime(true, approvals);
    const sink = sinkOf(runtime);
    await runtime.initialize();
    await runtime.startSession("Read PlannerAgent.java and tell me its first line.");
    await runtime.dispose().catch(() => undefined);

    // The read executed exactly once through the real builtin tool.
    const started = sink.byType("tool_started") as Array<{ toolName: string }>;
    expect(started.map((e) => e.toolName)).toContain("read_files");
    const completed = sink.byType("tool_completed") as Array<{
      toolName: string;
      output?: string;
    }>;
    const read = completed.find((e) => e.toolName === "read_files");
    expect(read).toBeDefined();
    expect(String(read?.output ?? "")).toContain("PLANNER_V1");
    expect(sink.byType("error")).toHaveLength(0);
    expect(sink.byType("completed")).toHaveLength(1);

    // The REAL disk content reached the model's second request (role:"tool").
    expect(bodies.length).toBe(2);
    const secondBody = bodies[1] as {
      messages: Array<{ role: string; content: string }>;
    };
    const toolMsg = secondBody.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain("PLANNER_V1");

    // EVERY call passes the gate — the runtime hands read_files to the host
    // hook too, and the host's policy-'auto' decision approves it there.
    expect(approvals.map((a) => a.toolName)).toContain("read_files");
  });

  it("EDIT: approval appears, then the edit stages as a ChangeSet (file untouched until accepted)", async () => {
    writeFileSync(join(dir, "notes.txt"), "hello\n", "utf8");
    const csm = new ChangeSetManager({ allowDirectWrite: true,  workspaceRoot: dir });
    const staged: Array<{
      toolName: string;
      relativePath: string;
      proposedContent: string;
      changeSetId: string;
    }> = [];

    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_input: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      bodies.push(body);
      const sawToolResult = (body.messages as Array<Record<string, unknown>>).some(
        (m) => m.role === "tool",
      );
      return sawToolResult
        ? finalTurn("Edit staged for approval.")
        : toolCallTurn("editor", {
            file_path: "notes.txt",
            operation: "str_replace",
            old_string: "hello",
            new_string: "hello world",
          });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    const approvals: Array<{ toolName: string; input: unknown }> = [];
    const runtime = new CodePilotRuntime({
      workspaceRoot: dir,
      providerId: "ollama",
      modelId: "qwen3:8b",
      agentMode: "act",
      requestApproval: async (req) => {
        approvals.push({ toolName: req.toolName, input: req.input });
        return { approved: true };
      },
      // The SAME staging seam the VS Code host wires (extension.ts ~2154):
      // proposals become a pending ChangeSet; nothing is written here.
      onWriteProposal: async (toolName, proposals) => {
        const cs = csm.createChangeSet(
          `tool:${toolName}:${Date.now()}`,
          proposals.map((p) => ({
            filePath: p.relativePath,
            proposedContent: p.proposedContent,
          })),
        );
        staged.push({
          toolName,
          relativePath: proposals[0]?.relativePath ?? "",
          proposedContent: proposals[0]?.proposedContent ?? "",
          changeSetId: cs.id,
        });
        return { changeSetId: cs.id };
      },
    });
    const sink = sinkOf(runtime);
    await runtime.initialize();
    await runtime.startSession("Make a harmless change to notes.txt.");
    await runtime.dispose().catch(() => undefined);

    // M4 approval appeared for the editor call and was approved.
    const required = sink.byType("agent.approval_required") as Array<{
      toolName: string;
    }>;
    expect(required.map((e) => e.toolName)).toContain("editor");
    expect(approvals.map((a) => a.toolName)).toContain("editor");

    // The tool result returned to the model is the STAGED notice — not a
    // write confirmation.
    const completed = sink.byType("tool_completed") as Array<{
      toolName: string;
      output?: string;
    }>;
    const edit = completed.find((e) => e.toolName === "editor");
    expect(edit).toBeDefined();
    expect(String(edit?.output ?? "")).toContain("staged");
    expect(String(edit?.output ?? "")).toContain("ChangeSet cs-");
    expect(String(edit?.output ?? "")).toContain("No file was modified");

    // Exactly one ChangeSet was staged with the merged proposed content.
    expect(staged).toHaveLength(1);
    expect(staged[0]!.relativePath).toBe("notes.txt");
    expect(staged[0]!.proposedContent).toBe("hello world\n");

    // The file on disk is UNTOUCHED before the ChangeSet is accepted.
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("hello\n");

    // Accepting the ChangeSet (the user's Changes-tab action) applies it.
    await csm.acceptAll(staged[0]!.changeSetId);
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("hello world\n");
    expect(sink.byType("error")).toHaveLength(0);
  });

  it("EDIT-DENIED: rejected M4 approval stages nothing and the file is untouched", async () => {
    writeFileSync(join(dir, "notes.txt"), "hello\n", "utf8");
    const csm = new ChangeSetManager({ allowDirectWrite: true,  workspaceRoot: dir });
    const staged: unknown[] = [];

    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_input: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      bodies.push(body);
      const sawToolResult = (body.messages as Array<Record<string, unknown>>).some(
        (m) => m.role === "tool",
      );
      return sawToolResult
        ? finalTurn("I could not edit the file.")
        : toolCallTurn("editor", {
            file_path: "notes.txt",
            operation: "str_replace",
            old_string: "hello",
            new_string: "hello world",
          });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    const runtime = new CodePilotRuntime({
      workspaceRoot: dir,
      providerId: "ollama",
      modelId: "qwen3:8b",
      agentMode: "act",
      requestApproval: async () => ({ approved: false, reason: "user denied" }),
      onWriteProposal: async (toolName, proposals) => {
        const cs = csm.createChangeSet(
          `tool:${toolName}:${Date.now()}`,
          proposals.map((p) => ({
            filePath: p.relativePath,
            proposedContent: p.proposedContent,
          })),
        );
        staged.push(cs.id);
        return { changeSetId: cs.id };
      },
    });
    const sink = sinkOf(runtime);
    await runtime.initialize();
    await runtime.startSession("Make a harmless change to notes.txt.");
    await runtime.dispose().catch(() => undefined);

    // The denial surfaced as a tool failure (tool_denied → tool_failed).
    const failed = sink.byType("tool_failed") as Array<{ toolName?: string }>;
    expect(failed.map((e) => e.toolName)).toContain("editor");
    // NOTHING was staged; the file is untouched.
    expect(staged).toHaveLength(0);
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("hello\n");
  });
});
