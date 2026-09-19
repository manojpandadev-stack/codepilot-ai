/**
 * M3 integration: the complete path — ToolRegistry + ToolExecutionService +
 * built-in tools, exercised the way the agent runtime will use them:
 *
 *   MODEL → tool_call → Registry → validate → permission → execute → result
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { ToolRegistry } from "./registry.js";
import { ToolPermissionManager } from "./permission-manager.js";
import { ToolAuditLogger } from "./audit-logger.js";
import { ToolExecutionService } from "./executor.js";
import { createBuiltinTools } from "./tools/index.js";
import { tempWorkspace } from "./testing-helpers.js";

function buildToolchain(root: string) {
  const registry = new ToolRegistry();
  const permissions = new ToolPermissionManager();
  const audit = new ToolAuditLogger();
  for (const tool of createBuiltinTools({ workspaceRoot: root })) {
    registry.register(tool);
  }
  const service = new ToolExecutionService(registry, permissions, audit);
  const events: Array<{ type: string; toolId?: string; executionId?: string }> =
    [];
  service.subscribe((e) =>
    events.push({ type: e.type, toolId: e.toolId, executionId: e.executionId }),
  );
  const approve = async () => ({ approved: true, scope: "once" as const });
  const run = (
    toolId: string,
    input: unknown,
    overrides: Record<string, unknown> = {},
  ) =>
    service.execute(toolId, input, {
      sessionId: "sess-int",
      taskId: "task-int",
      eventId: "evt-int",
      cwd: root,
      requestApproval: approve,
      ...overrides,
    });
  return { registry, permissions, audit, service, events, run };
}

describe("M3 integration — agent tool loop", () => {
  it("registers the full built-in tool set with unique ids", async () => {
    const ws = tempWorkspace();
    try {
      const registry = new ToolRegistry();
      for (const tool of createBuiltinTools({ workspaceRoot: ws.root })) {
        registry.register(tool);
      }
      const ids = registry.list().map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of [
        "read_file",
        "write_file",
        "edit_file",
        "search_files",
        "search_text",
        "list_directory",
        "create_directory",
        "delete_file",
        "move_file",
        "execute_command",
        "terminal_output",
        "kill_process",
        "git_status",
        "git_diff",
        "ask_user",
      ]) {
        expect(ids).toContain(id);
      }
    } finally {
      ws.cleanup();
    }
  });

  it("runs a read tool through the full pipeline with exactly-once events", async () => {
    const ws = tempWorkspace({ "note.txt": "agent note" });
    try {
      const h = buildToolchain(ws.root);
      const result = await h.run("read_file", { path: "note.txt" });
      expect(result.status).toBe("completed");
      expect((result.output as { content: string }).content).toBe("agent note");

      const types = h.events.map((e) => e.type);
      expect(types.filter((t) => t === "tool.requested")).toHaveLength(1);
      expect(types.filter((t) => t === "tool.completed")).toHaveLength(1);
      expect(h.audit.size()).toBe(1);
    } finally {
      ws.cleanup();
    }
  });

  it("writes → edits → reads back, honoring approval and correlation", async () => {
    const ws = tempWorkspace();
    try {
      const h = buildToolchain(ws.root);
      const write = await h.run("write_file", {
        path: "src/app.ts",
        content: "const x = 1;\n",
      });
      expect(write.status).toBe("completed");

      const edit = await h.run("edit_file", {
        path: "src/app.ts",
        search: "1",
        replace: "42",
      });
      expect(edit.status).toBe("completed");

      const read = await h.run("read_file", { path: "src/app.ts" });
      expect((read.output as { content: string }).content).toBe(
        "const x = 42;\n",
      );
      expect(h.audit.size()).toBe(3);
    } finally {
      ws.cleanup();
    }
  });

  it("validates model-generated input before execution", async () => {
    const ws = tempWorkspace({ "a.txt": "hello" });
    try {
      const h = buildToolchain(ws.root);
      // A model hallucinating a required field must be rejected pre-execution.
      const bad = await h.run("write_file", { content: "no path given" });
      expect(bad.status).toBe("failed");
      expect(bad.error?.code).toBe("VALIDATION");

      // Unknown tool ids fail with NOT_FOUND.
      const unknown = await h.run("made_up_tool", {});
      expect(unknown.error?.code).toBe("NOT_FOUND");
    } finally {
      ws.cleanup();
    }
  });

  it("routes execute_command through tool + command approval and records output", async () => {
    const ws = tempWorkspace();
    try {
      const h = buildToolchain(ws.root);
      const result = await h.run("execute_command", {
        command: process.execPath,
        args: ["-e", "process.stdout.write('m3-ok')"],
      });
      expect(result.status).toBe("completed");
      expect((result.output as { stdout: string }).stdout).toContain("m3-ok");

      const term = await h.run("terminal_output", {});
      expect((term.output as { count: number }).count).toBe(1);
    } finally {
      ws.cleanup();
    }
  });

  it("denies privileged tools when approval is declined", async () => {
    const ws = tempWorkspace({ "secret.txt": "x" });
    try {
      const h = buildToolchain(ws.root);
      const result = await h.run(
        "delete_file",
        { path: "secret.txt" },
        {
          requestApproval: async () => ({
            approved: false,
            reason: "leave it",
          }),
        },
      );
      expect(result.status).toBe("denied");
      expect(fs.existsSync(path.join(ws.root, "secret.txt"))).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it("surfaces structured ToolErrors from built-in tools", async () => {
    const ws = tempWorkspace();
    try {
      const h = buildToolchain(ws.root);
      const result = await h.run("read_file", { path: "../escape.txt" });
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("PATH_SECURITY");
      expect(result.error?.executionId).toBe(result.executionId);
      expect(result.error?.category).toBe("PATH_SECURITY");
    } finally {
      ws.cleanup();
    }
  });

  it("built-in tools never create duplicate payloads or lose correlation", async () => {
    const ws = tempWorkspace({ "x.txt": "hi" });
    try {
      const h = buildToolchain(ws.root);
      await h.run("read_file", { path: "x.txt" });
      const requested = h.events.filter((e) => e.type === "tool.requested");
      expect(requested).toHaveLength(1);
      expect(requested[0]!.toolId).toBe("read_file");
      expect(requested[0]!.executionId).toBeTruthy();
      const completed = h.events.find((e) => e.type === "tool.completed")!;
      expect(completed?.executionId).toBe(requested[0]!.executionId);
    } finally {
      ws.cleanup();
    }
  });
});
