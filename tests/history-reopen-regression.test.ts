/**
 * REGRESSION — history unavailable after extension-host reopen (live-verified).
 *
 * Live reproduction: after an extension-host restart with the workspace open,
 * `history/list` answered "backend unavailable (workspace not initialized)".
 * Root cause: getTaskHistoryService() was gated on `changeSetManager`, which
 * is only created inside ensureRuntime() — so history required an agent run.
 *
 * The fix makes the history service depend only on ACTIVATION (the extension
 * context / task store). This test proves the required lifecycle:
 *
 *   Host A: activate → workspace set → create + persist a task (scripted,
 *           NO model) → deactivate
 *   Host B: reopen against the SAME storage → workspace set →
 *           history/list WITHOUT ever calling ensureRuntime →
 *           the task is returned with intact metadata.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  freshHost,
  reopenHost,
  sleep,
  DEBOUNCE_WAIT_MS,
  type FreshHost,
} from "./vscode-integration-harness";

describe("history persistence across extension-host reopen (no runtime)", () => {
  let host: FreshHost;
  let captured: Array<{ type: string; payload?: Record<string, unknown> }>;
  let workspaceDir = "";

  const setWorkspace = (h: FreshHost) => {
    const folders = (
      h.vscodeStub as unknown as {
        workspace: { workspaceFolders: Array<{ uri: { fsPath: string } }> };
      }
    ).workspace;
    folders.workspaceFolders.length = 0;
    folders.workspaceFolders.push({ uri: { fsPath: workspaceDir } });
  };

  beforeEach(async () => {
    host = await freshHost();
    captured = [];
    host.ext.__setWebviewSinkForIntegrationTest((m) => {
      captured.push(m as { type: string; payload?: Record<string, unknown> });
    });
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-history-"));
    setWorkspace(host);
  });

  afterEach(async () => {
    host.ext.__clearWebviewSinkForIntegrationTest();
    await host.ext.deactivate().catch(() => {});
    host.cleanup();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  function send(type: string, payload: unknown) {
    return host.seams.handleMessage({
      type: type as never,
      id: `h-${Math.random().toString(36).slice(2)}`,
      payload,
      timestamp: Date.now(),
    });
  }

  const lastOf = (type: string) =>
    captured.filter((m) => m.type === type).at(-1);

  it("host A persists a task → host B lists it WITHOUT initializing the runtime", async () => {
    // ---- Host/session A: create + persist a task (scripted, no model) ----
    const taskId = await host.seams.beginTask(
      "History persistence probe PHOENIX-7.",
    );
    expect(taskId).not.toBeNull();
    host.seams.ingestAgentEvent({ type: "started", sessionId: "s-hist" });
    host.seams.ingestAgentEvent({
      type: "text_delta",
      text: "phoenix",
      accumulated: "phoenix",
    });
    host.seams.ingestAgentEvent({
      type: "completed",
      result: "phoenix",
      usage: { inputTokens: 2, outputTokens: 2, totalCost: 0 },
    });
    await sleep(DEBOUNCE_WAIT_MS);
    await host.seams.drainPersistence(taskId!);
    // The task really is on disk in host A's storage.
    const onDisk = fs.existsSync(path.join(host.storageDir, "tasks"));
    expect(onDisk).toBe(true);

    // ---- Runtime stays UNINITIALIZED in host A too (history must not ----
    // ---- depend on it); host A answers history/list successfully.    ----
    captured.length = 0;
    await send("history/list", {});
    const hostA = lastOf("history/list_result");
    expect(hostA).toBeDefined();
    expect(
      (hostA?.payload as { tasks?: Array<{ id: string }> }).tasks?.some(
        (t) => t.id === taskId,
      ),
    ).toBe(true);

    // ---- Host/session B: reopen the SAME storage, workspace open. ----
    host.ext.__clearWebviewSinkForIntegrationTest();
    await host.ext.deactivate().catch(() => {});
    const storageDir = host.storageDir;
    const reopened = await reopenHost(storageDir);
    const sink: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    reopened.ext.__setWebviewSinkForIntegrationTest((m) =>
      sink.push(m as { type: string; payload?: Record<string, unknown> }),
    );
    setWorkspace(reopened);
    try {
      // CRITICAL: no ensureRuntime() anywhere in host B.
      await reopened.seams.handleMessage({
        type: "history/list",
        id: "reopen-list",
        payload: {},
        timestamp: Date.now(),
      } as never);
      const result = sink
        .filter((m) => m.type === "history/list_result")
        .at(-1)?.payload as { tasks?: Array<{ id: string; title?: string }> };
      const error = sink
        .filter((m) => m.type === "history/result")
        .at(-1)?.payload as { success?: boolean; error?: string };

      // The fix: history works without the runtime — loud error is gone.
      expect(error?.error).toBeUndefined();
      expect(Array.isArray(result?.tasks)).toBe(true);
      const restored = result?.tasks?.find((t) => t.id === taskId);
      expect(restored).toBeDefined(); // previous task returned
      // Metadata intact.
      expect(String(restored?.title ?? "")).toContain("PHOENIX-7");
      console.log(
        "HISTORY-REOPEN EVIDENCE:",
        JSON.stringify({ taskId, restored: restored?.title }, null, 2),
      );
    } finally {
      reopened.ext.__clearWebviewSinkForIntegrationTest();
      await reopened.ext.deactivate().catch(() => {});
      reopened.cleanup();
      // `host` was already deactivated + cleaned in afterEach semantics; the
      // shared storage dir is removed by the reopened host's cleanup.
    }
  }, 30_000);
});
