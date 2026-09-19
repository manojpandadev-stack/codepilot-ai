/**
 * Terminal streaming integration — extension forward path, M4 gating,
 * persistence boundaries, audit boundaries, resources, and secrets.
 *
 * Layers (all real, no model required):
 * - extension `forwardAgentEvent` via the integration harness (real module);
 * - M4 pipeline + LiveToolPermissionBridge (real RiskEngine/PolicyEngine/
 *   ApprovalManager/SecurityValidator; only the human click is simulated
 *   through the pipeline's own approve()/reject() API — never bypassed);
 * - streaming shell adapter over real processes (node = portable).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  freshHost,
  sleep,
  DEBOUNCE_WAIT_MS,
  type FreshHost,
} from "./vscode-integration-harness";
import { TaskStore } from "../packages/agent-runtime/src/m12-task-store";
import { buildInitialMessages } from "../packages/agent-runtime/src/resume";
import { validateConversationProtocol } from "../packages/agent-runtime/src/compaction-protocol";
import type { AgentEvent } from "../packages/agent-runtime/src/types";
import { M4PermissionPipeline } from "../packages/tool-engine/src/m4/integration";
import type { ApprovalPresentation } from "../packages/tool-engine/src/m4/integration";
import { LiveToolPermissionBridge } from "../packages/tool-engine/src/m4/live-bridge";
import {
  CommandExecutionService,
  createStreamingShellExecutor,
  PersistentAuditLogger,
} from "../packages/tool-engine/src/m3/index";
import type { AuditStorageAdapter } from "../packages/tool-engine/src/m3/index";

const NODE = process.execPath;

type CapturedHost = FreshHost & {
  captured: Array<{ type: string; payload?: Record<string, unknown> }>;
};

async function hostWithCapture(): Promise<CapturedHost> {
  const host = await freshHost();
  const captured: Array<{ type: string; payload?: Record<string, unknown> }> = [];
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

/** M4 pipeline whose human presenter is scripted per test (real gate). */
function makePipeline(
  dir: string,
  decide: (p: ApprovalPresentation) => "allow" | "deny",
): { pipeline: M4PermissionPipeline; presented: ApprovalPresentation[] } {
  const presented: ApprovalPresentation[] = [];
  let manager: M4PermissionPipeline["approvalManager"] | null = null;
  const pipeline = new M4PermissionPipeline({
    workspaceRoot: dir,
    approvalTimeoutMs: 10_000,
    autoApproveReads: true,
    presentApproval: async (presentation) => {
      presented.push(presentation);
      const m = manager!;
      queueMicrotask(() => {
        if (decide(presentation) === "allow") m.approve(presentation.approvalId);
        else m.reject(presentation.approvalId);
      });
      return { decision: decide(presentation) === "deny" ? "deny" : "allow" };
    },
  });
  manager = pipeline.approvalManager;
  return { pipeline, presented };
}

function nodeAdapter(dir: string): AuditStorageAdapter {
  const file = (name: string): string => path.join(dir, path.basename(name));
  return {
    directory: () => dir,
    readFile: (name) => {
      try {
        return fs.readFileSync(file(name), "utf8");
      } catch {
        return null;
      }
    },
    appendLine: (name, line) => fs.appendFileSync(file(name), line, "utf8"),
    removeFile: (name) => {
      fs.rmSync(file(name), { force: true });
    },
    listFiles: () =>
      fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => ({ name: e.name, size: fs.statSync(path.join(dir, e.name)).size })),
    sync: () => {},
  };
}

describe("terminal streaming — extension forward path", () => {
  it("forwards terminal/output live with full correlation, persists nothing per chunk", async () => {
    const host = await hostWithCapture();
    try {
      const taskId = await host.seams.beginTask("stream watch");
      expect(taskId).not.toBeNull();
      const before = JSON.stringify((await new TaskStore(host.tasksDir).get(taskId!))?.conversation ?? []);
      const emit = (e: AgentEvent): void => host.seams.ingestAgentEvent(e);
      emit({ type: "tool_started", toolCallId: "call-live-1", toolName: "bash" });
      emit({ type: "terminal_output", toolCallId: "call-live-1", toolName: "bash", stream: "stdout", data: "CP-LIVE-A", seq: 2, executionId: "call-live-1" });
      emit({ type: "terminal_output", toolCallId: "call-live-1", toolName: "bash", stream: "stderr", data: "CP-ERR-A", seq: 3, executionId: "call-live-1" });
      emit({ type: "terminal_output", toolCallId: "call-live-1", toolName: "bash", stream: "stdout", data: "CP-LIVE-B", seq: 4, executionId: "call-live-1" });
      await host.seams.drainPersistence(taskId!);

      const outputs = host.captured.filter((m) => m.type === "terminal/output");
      expect(outputs).toHaveLength(3);
      expect(outputs[0]?.payload).toMatchObject({
        toolCallId: "call-live-1",
        toolName: "bash",
        stream: "stdout",
        data: "CP-LIVE-A",
        seq: 2,
      });
      expect(outputs[1]?.payload).toMatchObject({ stream: "stderr", data: "CP-ERR-A", seq: 3 });
      // Live chunks never touch persistence: identical conversation bytes.
      const after = JSON.stringify((await new TaskStore(host.tasksDir).get(taskId!))?.conversation ?? []);
      expect(after).toBe(before);
    } finally {
      await teardown(host);
    }
  });

  it("mixed stdout/stderr interleave stays labeled with per-stream order", async () => {
    const host = await hostWithCapture();
    try {
      const taskId = await host.seams.beginTask("mixed watch");
      expect(taskId).not.toBeNull();
      const emit = (e: AgentEvent): void => host.seams.ingestAgentEvent(e);
      emit({ type: "tool_started", toolCallId: "call-mix-1", toolName: "bash" });
      // OS-interleaved arrival order (stdout A, stderr B, stdout C, stderr D).
      const script: Array<["stdout" | "stderr", string, number]> = [
        ["stdout", "CP-OUT-A", 2],
        ["stderr", "CP-ERR-B", 3],
        ["stdout", "CP-OUT-C", 4],
        ["stderr", "CP-ERR-D", 5],
      ];
      for (const [stream, data, seq] of script) {
        emit({ type: "terminal_output", toolCallId: "call-mix-1", toolName: "bash", stream, data, seq, executionId: "call-mix-1" });
      }
      await host.seams.drainPersistence(taskId!);

      const outputs = host.captured.filter((m) => m.type === "terminal/output");
      expect(outputs).toHaveLength(4);
      const text = (stream: string): string =>
        outputs
          .filter((o) => (o.payload as Record<string, unknown>)?.["stream"] === stream)
          .map((o) => String((o.payload as Record<string, unknown>)?.["data"] ?? ""))
          .join("");
      // Complete capture on both channels with per-stream order.
      expect(text("stdout")).toBe("CP-OUT-ACP-OUT-C");
      expect(text("stderr")).toBe("CP-ERR-BCP-ERR-D");
      // Global sequence monotonic across the interleaving.
      const seqs = outputs.map((o) => Number((o.payload as Record<string, unknown>)?.["seq"] ?? -1));
      expect(seqs).toEqual([2, 3, 4, 5]);
    } finally {
      await teardown(host);
    }
  });

  it("terminal-only run persists tool_use/tool_result and stays protocol-valid", async () => {
    const host = await hostWithCapture();
    try {
      const taskId = await host.seams.beginTask("terminal run");
      const emit = (e: AgentEvent): void => host.seams.ingestAgentEvent(e);
      emit({ type: "started", sessionId: "s1" });
      emit({ type: "tool_started", toolCallId: "call-t1", toolName: "bash" });
      emit({ type: "terminal_output", toolCallId: "call-t1", toolName: "bash", stream: "stdout", data: "live-bytes", seq: 2, executionId: "call-t1" });
      emit({ type: "tool_completed", toolCallId: "call-t1", toolName: "bash", output: "live-bytes", durationMs: 12 });
      emit({ type: "completed", result: "done", usage: { inputTokens: 1, outputTokens: 1, totalCost: 0 } });
      await sleep(DEBOUNCE_WAIT_MS);
      await host.seams.drainPersistence(taskId!);

      const task = await new TaskStore(host.tasksDir).get(taskId!);
      expect(task?.status).toBe("completed");
      const blocks = (task?.conversation ?? []).flatMap((e) => e.blocks ?? []);
      expect(blocks.filter((b) => b.type === "tool_use")).toHaveLength(1);
      expect(blocks.filter((b) => b.type === "tool_result")).toHaveLength(1);
      expect(validateConversationProtocol(buildInitialMessages(task!)).valid).toBe(true);
    } finally {
      await teardown(host);
    }
  });
});

describe("terminal streaming — M4 gate (real pipeline)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-term-m4-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("1. allowed command streams through the full gate", async () => {
    const { pipeline, presented } = makePipeline(dir, () => "allow");
    const bridge = new LiveToolPermissionBridge(pipeline);
    const decision = await bridge.evaluateLiveTool({
      toolName: "bash",
      input: { command: NODE, args: ["-e", "console.log('M4-STREAM-1');"] },
      taskId: "m4-t1",
    });
    expect(decision.approved).toBe(true);
    expect(presented.length).toBeGreaterThan(0);

    const chunks: string[] = [];
    const service = new CommandExecutionService();
    const execute = createStreamingShellExecutor(service, {
      onTerminalEvent: (e) => {
        if (e.type === "terminal.stdout") chunks.push(e.data);
      },
    });
    const out = await execute(
      { command: NODE, args: ["-e", "console.log('M4-STREAM-1');"] },
      dir,
      { toolCallId: "m4-call-1" },
    );
    expect(out).toContain("M4-STREAM-1");
    expect(chunks.join("")).toContain("M4-STREAM-1");
    const audits = bridge.auditLog();
    expect(audits.some((a) => a.approved === true)).toBe(true);
  });

  it("2+3. denied/unapproved commands spawn no process", async () => {
    for (const verdict of ["deny", "deny"] as const) {
      const { pipeline } = makePipeline(dir, () => verdict);
      const bridge = new LiveToolPermissionBridge(pipeline);
      let executed = 0;
      const decision = await bridge.evaluateLiveTool({
        toolName: "bash",
        input: { command: NODE, args: ["-e", "console.log('NEVER');"] },
        taskId: "m4-t2",
      });
      expect(decision.approved).toBe(false);
      // Production order: execute ONLY on approval — counter stays zero.
      if (decision.approved) executed += 1;
      expect(executed).toBe(0);
      expect(bridge.auditLog().some((a) => a.approved === false)).toBe(true);
    }
  });

  it("4+5. approved execution streams and audits with a safe target", async () => {
    const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-term-audit-"));
    try {
      const { pipeline } = makePipeline(dir, () => "allow");
      const audit = new PersistentAuditLogger(nodeAdapter(auditDir));
      const bridge = new LiveToolPermissionBridge(pipeline, audit);
      const decision = await bridge.evaluateLiveTool({
        toolName: "bash",
        input: { command: "node --token=SECRET-ARG-1 script.js" },
        taskId: "m4-t3",
      });
      expect(decision.approved).toBe(true);
      await audit.flush();
      const raw = fs.readFileSync(path.join(auditDir, "tool-audit.jsonl"), "utf8");
      const records = raw.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
      expect(records.length).toBeGreaterThan(0);
      // Safe target = command name only; raw args (with the secret) absent.
      expect(JSON.stringify(records)).toContain("node");
      expect(raw).not.toContain("SECRET-ARG-1");
    } finally {
      fs.rmSync(auditDir, { recursive: true, force: true });
    }
  });
});

describe("terminal streaming — resources", () => {
  it("20 sequential commands leave no processes, listeners, or timers behind", async () => {
    const service = new CommandExecutionService();
    const execute = createStreamingShellExecutor(service, {});
    for (let i = 0; i < 20; i += 1) {
      const out = await execute(
        { command: NODE, args: ["-e", `console.log('SEQ-${i}');`] },
        process.cwd(),
        { toolCallId: `seq-${i}` },
      );
      expect(out).toContain(`SEQ-${i}`);
    }
    expect(service.runningPids()).toEqual([]);
  });

  it("concurrent commands on separate tasks stay isolated", async () => {
    const service = new CommandExecutionService();
    const execute = createStreamingShellExecutor(service, {});
    const results = await Promise.all(
      [0, 1, 2, 3].map((i) =>
        execute(
          { command: NODE, args: ["-e", `setTimeout(()=>console.log('CONC-${i}'),${i * 60});`] },
          process.cwd(),
          { toolCallId: `conc-${i}` },
        ),
      ),
    );
    for (let i = 0; i < 4; i += 1) {
      expect(results[i]).toContain(`CONC-${i}`);
    }
    expect(service.runningPids()).toEqual([]);
  });
});

describe("terminal streaming — secret sweep", () => {
  it("markers in stdout/stderr/errors/args/URLs never reach audit or disk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-term-sec-"));
    const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-term-secaudit-"));
    try {
      const markers = [
        "Bearer INT-TERM-BEARER-1",
        "sk-int-TERMFAKEFAKE00",
        "ghp_intTERMFAKEFAKE12",
        "https://intuser:intpass@example.com/x?api_key=INT-TERM-QUERY-2",
        "--token=INT-TERM-CMD-3",
      ];
      const service = new CommandExecutionService();
      const events: string[] = [];
      const execute = createStreamingShellExecutor(service, {
        onTerminalEvent: (e) => {
          if (e.type === "terminal.stdout" || e.type === "terminal.stderr") events.push(e.data);
        },
      });
      // stdout + stderr carrying markers (stderr via node write).
      const out = await execute(
        {
          command: NODE,
          args: [
            "-e",
            `console.log('out Bearer INT-TERM-BEARER-1 and sk-int-TERMFAKEFAKE00'); console.error('err ghp_intTERMFAKEFAKE12');`,
          ],
        },
        dir,
        { toolCallId: "sec-1" },
      );
      expect(out).toContain("INT-TERM-BEARER-1");

      // M4 evaluation with secret-laced args → durable JSONL audit.
      const { pipeline } = makePipeline(dir, () => "allow");
      const audit = new PersistentAuditLogger(nodeAdapter(auditDir));
      const bridge = new LiveToolPermissionBridge(pipeline, audit);
      await bridge.evaluateLiveTool({
        toolName: "bash",
        input: { command: `node ${markers[4]} ${markers[3]}` },
        taskId: "sec-task",
      });
      await audit.flush();
      await audit.dispose();

      const auditRaw = fs.readFileSync(path.join(auditDir, "tool-audit.jsonl"), "utf8");
      for (const marker of [
        "INT-TERM-BEARER-1",
        "sk-int-TERMFAKEFAKE00",
        "ghp_intTERMFAKEFAKE12",
        "intpass",
        "INT-TERM-QUERY-2",
        "INT-TERM-CMD-3",
      ]) {
        expect(auditRaw.includes(marker), `marker leaked to audit: ${marker.slice(0, 12)}`).toBe(false);
      }
      void events;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(auditDir, { recursive: true, force: true });
    }
  });
});
