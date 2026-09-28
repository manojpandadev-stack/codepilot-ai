/**
 * M4 live-tool classification regression — read tools must not prompt.
 *
 * The plural agent-facing READ tools (read_files, search_codebase, skills,
 * ask_question, list_files, plan) were unmapped in LIVE_TOOL_ID_MAP and fell
 * through the UNMAPPED path to apply_file_changes (a write): every read
 * presented an approval card even though every policy layer classifies them
 * read/auto. This pins the fix through the REAL M4PermissionPipeline +
 * LiveToolPermissionBridge (RiskEngine → PermissionPolicyEngine →
 * ApprovalManager → SecurityValidator), one fresh pipeline per tool so no
 * session grant leaks between cases:
 *
 *   - reads/plan/list: mapped, auto-approved, NEVER prompted;
 *   - write (editor): still prompted (no weakening of the write boundary);
 *   - fetch_web_content / web_search: deliberately UNMAPPED and prompted —
 *     shared policy says "approval"; mapping them would auto-allow them.
 *
 * The input is metadata only (paths/queries): the tools' executors never run
 * inside evaluateLiveTool, so nothing is read, written, or fetched here.
 */
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { M4PermissionPipeline } from "../packages/tool-engine/src/m4/integration.js";
import type { ApprovalPresentation } from "../packages/tool-engine/src/m4/integration.js";
import { LiveToolPermissionBridge } from "../packages/tool-engine/src/m4/live-bridge.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m4-read-map-"));

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface EvalResult {
  approved: boolean;
  decision: string;
  unmapped: boolean;
  prompted: boolean;
}

/** One fresh pipeline per tool (mirrors production config: reads auto). */
async function evaluate(toolName: string): Promise<EvalResult> {
  let presentations = 0;
  let manager: M4PermissionPipeline["approvalManager"] | null = null;
  const pipeline = new M4PermissionPipeline({
    workspaceRoot: dir,
    approvalTimeoutMs: 2_000,
    autoApproveReads: true,
    presentApproval: async (presentation: ApprovalPresentation) => {
      presentations += 1;
      queueMicrotask(() => manager!.approve(presentation.approvalId));
      return { decision: "allow" as const };
    },
  });
  manager = pipeline.approvalManager;
  const bridge = new LiveToolPermissionBridge(pipeline);
  const result = await bridge.evaluateLiveTool({
    toolName,
    input: { path: "a.ts", files: [{ path: "a.ts" }], query: "x" },
  });
  return {
    approved: result.approved,
    decision: result.decision,
    unmapped: result.unmappedTool === true,
    prompted: presentations > 0,
  };
}

const READ_TOOLS = [
  "read_files",
  "inspect_symbols",
  "search_codebase",
  "skills",
  "ask_question",
  "list_files",
  "plan",
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "read_tool_output",
] as const;

describe("M4 mapping — agent-facing read tools never prompt", () => {
  for (const toolName of READ_TOOLS) {
    it(`${toolName} is mapped read, auto-approved, never prompted`, async () => {
      const r = await evaluate(toolName);
      expect(r.unmapped, `${toolName} fell to the UNMAPPED write path`).toBe(
        false,
      );
      expect(r.prompted, `${toolName} presented an approval card`).toBe(false);
      expect(r.decision).toBe("allow");
      expect(r.approved).toBe(true);
    });
  }

  it("terminal_session_status (mapped read) never prompts", async () => {
    const r = await evaluate("terminal_session_status");
    expect(r.unmapped).toBe(false);
    expect(r.prompted).toBe(false);
    expect(r.approved).toBe(true);
  });
});

describe("M4 mapping — boundaries are NOT weakened", () => {
  it("editor (write) still presents an approval card", async () => {
    const r = await evaluate("editor");
    expect(r.unmapped).toBe(false);
    expect(r.prompted).toBe(true);
  });

  it("fetch_web_content stays UNMAPPED (policy: approval, never auto-read)", async () => {
    const r = await evaluate("fetch_web_content");
    expect(r.unmapped).toBe(true);
    expect(r.prompted).toBe(true);
  });

  it("web_search stays UNMAPPED (policy: approval, never auto-read)", async () => {
    const r = await evaluate("web_search");
    expect(r.unmapped).toBe(true);
    expect(r.prompted).toBe(true);
  });
});
