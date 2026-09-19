/**
 * @codepilot/tool-engine — M3 test helpers (not shipped as tests)
 */

import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ApprovalDecision, ToolContext } from "./types.js";

export function makeSignal(overrides?: { aborted?: boolean }): AbortSignal {
  const controller = new AbortController();
  if (overrides?.aborted) controller.abort("pre-aborted for test");
  return controller.signal;
}

export interface MockCtxState {
  progresses: Array<{ message?: string; percent?: number }>;
}

/** Build a ToolContext for direct tool.execute() calls. */
export function makeCtx(
  overrides: Partial<ToolContext> & { cwd?: string } = {},
): { ctx: ToolContext; state: MockCtxState } {
  const state: MockCtxState = { progresses: [] };
  const signal = overrides.signal ?? makeSignal();
  const ctx: ToolContext = {
    executionId:
      overrides.executionId ?? `test-exec-${Date.now().toString(36)}`,
    eventId: overrides.eventId ?? "evt-1",
    sessionId: overrides.sessionId ?? "sess-1",
    taskId: overrides.taskId ?? "task-1",
    cwd: overrides.cwd ?? os.tmpdir(),
    signal,
    progress: (p) => {
      state.progresses.push(p);
    },
    requestApproval: overrides.requestApproval,
  };
  return { ctx, state };
}

/** Create a temp workspace with the given files (rel path → content). */
export function tempWorkspace(files: Record<string, string> = {}): {
  root: string;
  cleanup: () => void;
} {
  const root = path.join(
    os.tmpdir(),
    `codepilot-m3-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  );
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return {
    root,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

export function approvingApproval(
  approved = true,
  reason = "",
): (req: {
  toolId: string;
  executionId: string;
  summary: string;
}) => Promise<ApprovalDecision> {
  return async (_req) => ({ approved, scope: "once", reason });
}

/** Register a single tool into a fresh registry + executor trio. */
export function approveAll(): (req: {
  toolId: string;
  executionId: string;
  summary: string;
}) => Promise<ApprovalDecision> {
  return approvingApproval(true);
}
