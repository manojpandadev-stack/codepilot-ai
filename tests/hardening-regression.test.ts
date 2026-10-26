/**
 * Production-hardening regressions (post live-cloud-acceptance pass).
 *
 * Covers three hardening items WITHOUT touching the working cloud path:
 *
 * 1. APPROVAL / CHANGESET INTEGRITY
 *    - A staged ChangeSet is never marked applied (or accepted) by a file
 *      mutation that another approved tool performed. Acceptance stays an
 *      explicit user action; accepting after an external mutation yields an
 *      honest conflict, never a silent overwrite or a fabricated "applied".
 *    - The mechanism that actually mutated the workspace is recorded:
 *      the M4 audit trail carries tool id / action / approval / status per
 *      call (safe descriptors only), while the persisted task record carries
 *      the full (redacted, bounded) command in its tool_use block.
 *
 * 3. PROVIDER-AWARE REQUEST LOGGING
 *    - REQUEST_RECEIVED reports the ACTIVE provider's endpoint. An OpenRouter
 *      request must never log the Ollama base URL (the old defect), and an
 *      Ollama request keeps identifying its local endpoint. No keys, no
 *      headers, no bodies.
 *
 * 4. TOOL-FAILURE OBSERVABILITY
 *    - A failed tool surfaces an actionable reason (webview status card and
 *      persisted is_error tool_result), is never reported as a success, and
 *      a later successful retry is a separate, distinguishable event pair.
 *      There is no host-side auto-retry: retries belong to the model/runtime.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { ChangeSetManager } from "../packages/changeset-engine/src/index.js";
import { LiveToolPermissionBridge } from "../packages/tool-engine/src/m4/live-bridge.js";
import { M4PermissionPipeline } from "../packages/tool-engine/src/m4/integration.js";
import {
  freshHost,
  sleep,
  DEBOUNCE_WAIT_MS,
} from "./vscode-integration-harness";
import { TaskStore } from "../packages/agent-runtime/src/m12-task-store";
import type { AgentEvent } from "../packages/agent-runtime/src/types";

// ============================================================================
// Shared helpers
// ============================================================================

type CapturedHost = Awaited<ReturnType<typeof freshHost>> & {
  captured: Array<{ type: string; payload?: Record<string, unknown> }>;
};

async function hostWithCapture(): Promise<CapturedHost> {
  const host = await freshHost();
  const captured: Array<{ type: string; payload?: Record<string, unknown> }> =
    [];
  host.ext.__setWebviewSinkForIntegrationTest((m) => {
    captured.push(m as { type: string; payload?: Record<string, unknown> });
  });
  return Object.assign(host, { captured });
}

async function teardown(host: CapturedHost): Promise<void> {
  host.ext.__clearWebviewSinkForIntegrationTest();
  await host.ext.deactivate().catch(() => {});
  host.cleanup();
}

/** REQUEST_RECEIVED lines logged by this host's output channel. */
function requestReceivedLines(host: CapturedHost): string[] {
  const lines = host.vscodeStub.outputChannelLines as Array<{
    channel: string;
    text: string;
  }>;
  return lines.filter((l) => l.text.includes("REQUEST_RECEIVED")).map((l) => l.text);
}

async function sendChat(
  host: CapturedHost,
  text: string,
): Promise<void> {
  await host.seams.handleMessage({
    type: "chat/send",
    id: `hardening-${Date.now()}`,
    payload: { text, mode: "act" },
    timestamp: Date.now(),
  } as never);
}

/** Loose block shape for assertions (the real union is deliberately rich). */
type LooseBlock = {
  type: string;
  id?: string;
  tool_use_id?: string;
  name?: string;
  input?: string;
  content?: string;
  is_error?: boolean;
};

function runBlocks(
  task: Awaited<ReturnType<TaskStore["get"]>>,
): LooseBlock[] {
  const run = (task?.conversation ?? []).find((e) =>
    String(e.key ?? "").startsWith("run-"),
  );
  expect(run).toBeDefined();
  return ((run!.blocks ?? []) as unknown) as LooseBlock[];
}

// ============================================================================
// Item 1 — ChangeSet integrity + mutation-mechanism attribution
// ============================================================================

describe("item 1: ChangeSet integrity and mutation mechanism", () => {
  it("a bash-mediated file mutation never marks the staged ChangeSet applied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-harden-cs-"));
    const ws = join(dir, "ws");
    mkdirSync(join(ws, "src"), { recursive: true });
    const file = join(ws, "src", "calc.js");
    const original = "function add(a, b) {\n  return 1;\n}\n";
    writeFileSync(file, original);

    const manager = new ChangeSetManager({ allowDirectWrite: true,  workspaceRoot: ws });
    const cs = manager.createChangeSet("task-live-1", [
      {
        filePath: "src/calc.js",
        proposedContent: "function add(a, b) {\n  return a + b;\n}\n",
      },
    ]);
    expect(cs.status).toBe("pending");
    expect(cs.changes[0]!.status).toBe("pending");

    // The real live scenario: the user approves a bash command whose
    // node-based rewrite mutates the SAME file. No ChangeSet accept happens.
    const bashWritten = "function add(a, b) {\n  return a + b; // via bash\n}\n";
    writeFileSync(file, bashWritten);

    // The staged ChangeSet must still be pending — no implicit acceptance.
    const stored = manager.getChangeSet(cs.id)!;
    expect(stored.changes[0]!.status).toBe("pending");
    expect(stored.status).toBe("pending");

    // Accepting now is an explicit user action — and the engine honestly
    // reports the external mutation as a conflict instead of overwriting
    // the user-approved content or fabricating an applied status.
    const result = await manager.acceptChange(cs.id, cs.changes[0]!.id);
    expect(result.success).toBe(false);
    const after = manager.getChangeSet(cs.id)!;
    expect(after.changes[0]!.status).toBe("conflict");
    expect(after.status).not.toBe("fully_applied");
    // The bash-written content survives untouched.
    expect(readFileSync(file, "utf8")).toBe(bashWritten);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the M4 audit trail records the bash mechanism (tool, action, approval, status)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-harden-bridge-"));
    let manager: M4PermissionPipeline["approvalManager"] | null = null;
    const pipeline = new M4PermissionPipeline({
      workspaceRoot: dir,
      approvalTimeoutMs: 5_000,
      autoApproveReads: true,
      presentApproval: async (presentation) => {
        // Resolve like the real host does: through the ApprovalManager, i.e.
        // an explicit user approval — the presentation return value alone
        // never grants anything.
        manager!.approve(presentation.approvalId, "single_execution", "test");
        return new Promise(() => {});
      },
    });
    manager = pipeline.approvalManager;
    const bridge = new LiveToolPermissionBridge(pipeline);

    const fullCommand =
      'node -e "require(\'fs\').writeFileSync(\'calc.js\', \'function add(a,b){return a+b}\\n\')"';
    const result = await bridge.evaluateLiveTool({
      toolName: "bash",
      input: { command: fullCommand },
      sessionId: "sess-harden",
      taskId: "task-harden",
    });
    expect(result.approved).toBe(true);

    const entry = bridge.auditLog().slice(-1)[0]!;
    // Mechanism attribution: the mutation path was the bash tool.
    expect(entry.toolId).toBe("execute_command");
    expect(entry.action).toBe("execute_command");
    expect(entry.approved).toBe(true);
    expect(entry.status).toBe("completed");
    expect(entry.permissionDecision).toBe("allow");
    // The audit trail stores a SAFE descriptor (command name), never the
    // full command line — credentials in arguments must not reach the sink.
    expect(entry.safeTarget).toBe("node");

    // The approval card DID show the full command (nothing destructive
    // hidden — see integration.test.ts for the truncation regressions).
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the persisted task record carries the full approved command and its result", async () => {
    const host = await hostWithCapture();
    try {
      const taskId = await host.seams.beginTask("bash rewrite record");
      expect(taskId).not.toBeNull();
      const fullCommand =
        'node -e "require(\'fs\').writeFileSync(\'calc.js\', \'function add(a,b){return a+b}\\n\')"';
      const emit = (e: AgentEvent): void => host.seams.ingestAgentEvent(e);
      emit({
        type: "tool_requested",
        toolCallId: "call-bash-1",
        toolName: "bash",
        input: { command: fullCommand },
      });
      emit({
        type: "tool_started",
        toolCallId: "call-bash-1",
        toolName: "bash",
      });
      emit({
        type: "tool_completed",
        toolCallId: "call-bash-1",
        toolName: "bash",
        output: "ok",
        durationMs: 5,
      });
      emit({
        type: "completed",
        result: "rewrote calc.js via approved bash",
        usage: { inputTokens: 10, outputTokens: 20, totalCost: 0 },
      });
      await sleep(DEBOUNCE_WAIT_MS);
      await host.seams.drainPersistence(taskId!);

      const task = await new TaskStore(host.tasksDir).get(taskId!);
      const blocks = runBlocks(task);
      const use = blocks.find(
        (b) => b.type === "tool_use" && b.id === "call-bash-1",
      );
      expect(use).toBeDefined();
      expect(use!.name).toBe("bash");
      // Full command (redacted on write) is in the task record — the
      // mutation mechanism is reconstructable from history.
      const parsedInput = JSON.parse(use!.input ?? "{}") as {
        command?: string;
      };
      expect(parsedInput.command).toBe(fullCommand);
      const resultBlock = blocks.find(
        (b) => b.type === "tool_result" && b.tool_use_id === "call-bash-1",
      );
      expect(resultBlock).toBeDefined();
      expect(resultBlock!.is_error).toBeUndefined();
    } finally {
      await teardown(host);
    }
  });
});

// ============================================================================
// Item 3 — provider-aware REQUEST_RECEIVED endpoint logging
// ============================================================================

describe("item 3: provider-aware REQUEST_RECEIVED logging", () => {
  it("an OpenAI request never logs the Ollama endpoint", async () => {
    const host = await hostWithCapture();
    const overrides = host.vscodeStub.configOverrides as Map<string, unknown>;
    const savedProvider = overrides.get("provider");
    const savedPrivacy = overrides.get("privacyMode");
    overrides.set("provider", "openai-native");
    // Local-only privacy: the runtime blocks the remote request BEFORE any
    // network I/O, so this regression is deterministic and offline. The
    // REQUEST_RECEIVED log line under test is emitted before all of that.
    overrides.set("privacyMode", "local");
    try {
      await sendChat(host, "hello openai");
      const lines = requestReceivedLines(host);
      expect(lines.length).toBeGreaterThan(0);
      const line = lines[lines.length - 1]!;
      expect(line).toContain("providerId=openai-native");
      // THE regression: the hardcoded Ollama base URL must be gone.
      expect(line).not.toContain("localhost:11434");
      expect(line).not.toContain("11434");
      // The active provider's own (safe, redacted) endpoint is reported.
      expect(line).toContain("https://api.openai.com/v1");
      // No secrets on the log line.
      expect(line.toLowerCase()).not.toContain("authorization");
    } finally {
      if (savedProvider === undefined) overrides.delete("provider");
      else overrides.set("provider", savedProvider);
      if (savedPrivacy === undefined) overrides.delete("privacyMode");
      else overrides.set("privacyMode", savedPrivacy);
      await teardown(host);
    }
  }, 20_000);

  it("an Ollama request still identifies the local Ollama endpoint", async () => {
    const host = await hostWithCapture();
    const overrides = host.vscodeStub.configOverrides as Map<string, unknown>;
    const savedProvider = overrides.get("provider");
    overrides.set("provider", "ollama");
    try {
      // Fire-and-forget: this offline host has no reachable Ollama server,
      // so awaiting the full session would only exercise connection-failure
      // retries. REQUEST_RECEIVED is emitted synchronously at handler entry,
      // which is the line under test.
      void sendChat(host, "hello ollama");
      const deadline = Date.now() + 10_000;
      let lines: string[] = [];
      while (Date.now() < deadline) {
        lines = requestReceivedLines(host);
        if (lines.length > 0) break;
        await sleep(50);
      }
      expect(lines.length).toBeGreaterThan(0);
      const line = lines[lines.length - 1]!;
      expect(line).toContain("providerId=ollama");
      expect(line).toContain("11434");
    } finally {
      if (savedProvider === undefined) overrides.delete("provider");
      else overrides.set("provider", savedProvider);
      await teardown(host);
    }
  }, 20_000);
});

// ============================================================================
// Item 4 — tool failure observability and event sequencing
// ============================================================================

describe("item 4: tool failure observability", () => {
  it("failed edit surfaces an actionable reason, persists is_error, and is never reported as success", async () => {
    const host = await hostWithCapture();
    try {
      const taskId = await host.seams.beginTask("opaque edit failure");
      expect(taskId).not.toBeNull();
      const emit = (e: AgentEvent): void => host.seams.ingestAgentEvent(e);
      const failedError =
        "ENOENT: no such file or directory, open 'src/calc.js'";
      emit({
        type: "tool_requested",
        toolCallId: "call-edit-1",
        toolName: "editor",
        input: { file_path: "src/calc.js", old_string: "1", new_string: "2" },
      });
      emit({
        type: "tool_started",
        toolCallId: "call-edit-1",
        toolName: "editor",
      });
      emit({
        type: "tool_failed",
        toolCallId: "call-edit-1",
        toolName: "editor",
        error: failedError,
      });
      emit({
        type: "completed",
        result: "attempted the edit",
        usage: { inputTokens: 10, outputTokens: 20, totalCost: 0 },
      });
      await sleep(DEBOUNCE_WAIT_MS);
      await host.seams.drainPersistence(taskId!);

      // The webview card carries the actionable provider error text.
      const failedCards = host.captured.filter((m) => m.type === "agent/status");
      const failureMessage = failedCards
        .map((m) => String(m.payload?.message ?? ""))
        .find((t) => t.includes("editor"));
      expect(failureMessage).toContain("Tool editor failed:");
      expect(failureMessage).toContain("ENOENT");

      // No success card exists for the failed tool call.
      const completedCards = host.captured.filter(
        (m) =>
          m.type === "tool/completed" &&
          m.payload?.toolCallId === "call-edit-1",
      );
      expect(completedCards).toHaveLength(0);

      // The persisted record keeps the failure honest (is_error) and the
      // reason survives redaction/bounds.
      const task = await new TaskStore(host.tasksDir).get(taskId!);
      const resultBlock = runBlocks(task).find(
        (b) => b.type === "tool_result" && b.tool_use_id === "call-edit-1",
      );
      expect(resultBlock).toBeDefined();
      expect(resultBlock!.is_error).toBe(true);
      expect(resultBlock!.content).toContain("ENOENT");
    } finally {
      await teardown(host);
    }
  });

  it("a retried edit is a distinguishable second tool pair, not a rewritten failure", async () => {
    const host = await hostWithCapture();
    try {
      const taskId = await host.seams.beginTask("edit retry sequencing");
      expect(taskId).not.toBeNull();
      const emit = (e: AgentEvent): void => host.seams.ingestAgentEvent(e);
      // First attempt: approved, started, FAILED (the live scenario).
      emit({
        type: "tool_requested",
        toolCallId: "call-edit-1",
        toolName: "editor",
        input: { file_path: "src/calc.js", old_string: "1", new_string: "2" },
      });
      emit({
        type: "tool_started",
        toolCallId: "call-edit-1",
        toolName: "editor",
      });
      emit({
        type: "tool_failed",
        toolCallId: "call-edit-1",
        toolName: "editor",
        error: "patch context mismatch",
      });
      // Retry: a NEW call id — its own requested→started→completed sequence.
      emit({
        type: "tool_requested",
        toolCallId: "call-edit-2",
        toolName: "editor",
        input: { file_path: "src/calc.js", old_string: "1", new_string: "2" },
      });
      emit({
        type: "tool_started",
        toolCallId: "call-edit-2",
        toolName: "editor",
      });
      emit({
        type: "tool_completed",
        toolCallId: "call-edit-2",
        toolName: "editor",
        output: "applied",
        durationMs: 4,
      });
      emit({
        type: "completed",
        result: "edit applied on retry",
        usage: { inputTokens: 10, outputTokens: 20, totalCost: 0 },
      });
      await sleep(DEBOUNCE_WAIT_MS);
      await host.seams.drainPersistence(taskId!);

      // Both attempts persist as separate, correctly-paired records.
      const task = await new TaskStore(host.tasksDir).get(taskId!);
      const blocks = runBlocks(task);
      const fail = blocks.find(
        (b) => b.type === "tool_result" && b.tool_use_id === "call-edit-1",
      );
      const ok = blocks.find(
        (b) => b.type === "tool_result" && b.tool_use_id === "call-edit-2",
      );
      expect(fail?.is_error).toBe(true);
      expect(ok).toBeDefined();
      expect(ok!.is_error).toBeUndefined();

      // Webview saw exactly one failure card and one success card, with the
      // distinct toolCallIds — the retry never masks the original failure.
      const statuses = host.captured.filter((m) => m.type === "tool/started");
      expect(statuses.map((m) => m.payload?.toolCallId)).toEqual([
        "call-edit-1",
        "call-edit-2",
      ]);
      const completions = host.captured.filter(
        (m) => m.type === "tool/completed",
      );
      expect(completions.map((m) => m.payload?.toolCallId)).toEqual([
        "call-edit-2",
      ]);
    } finally {
      await teardown(host);
    }
  });
});
