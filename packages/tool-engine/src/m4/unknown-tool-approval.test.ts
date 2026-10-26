/**
 * P0-1 regression — unknown tool ids must FAIL CLOSED.
 *
 * `toolIdToAction()` previously fell through to `read_file` for any tool id
 * not present in TOOL_ID_ACTION_MAP, and `read_file` is auto-approved by
 * default. Any unmapped id (typo, newly registered tool, hostile id) would
 * therefore execute with NO permission decision — the exact bypass class
 * the map's own comments warn about for network, browser, and M5 tools.
 *
 * These tests pin the fix through the real M4PermissionPipeline
 * (RiskEngine → PermissionPolicyEngine → ApprovalManager →
 * SecurityValidator):
 *
 *   - mapped read tools still auto-approve and never prompt;
 *   - unknown ids never classify as an auto-approved action;
 *   - an unknown id cannot execute without an explicit approval;
 *   - approving the prompt (the legitimate path) lets it through.
 */
import { describe, expect, it, vi } from "vitest";
import { M4PermissionPipeline, toolIdToAction } from "./integration.js";
import type {
  ApprovalPresentation,
  UserApprovalChoice,
} from "./integration.js";

const WORKSPACE = "/workspace";

/** Actions the policy engine auto-approves by default (never a safe default for unknowns). */
const AUTO_APPROVED_ACTIONS = new Set([
  "read_file",
  "list_directory",
  "search_files",
  "search_text",
  "ask_user",
  "web_fetch",
  "git_operation",
]);

/** Mapped read tools that must keep their exact classification. */
const EXPECTED_READ_ACTIONS: Record<string, string> = {
  read_file: "read_file",
  list_directory: "list_directory",
  search_files: "search_files",
  search_text: "search_text",
  create_checkpoint: "read_file",
  list_checkpoints: "read_file",
  get_diff: "read_file",
};

/** Unknown ids: fresh names, empty string, and inherited-object keys. */
const UNKNOWN_IDS = [
  "brand_new_tool_xyz",
  "run_something_totally_new",
  "",
  "constructor",
  "toString",
  "__proto__",
  "hasOwnProperty",
];

describe("toolIdToAction — fail-closed default (P0-1)", () => {
  it("keeps explicit mappings for known read tools", () => {
    for (const [id, expected] of Object.entries(EXPECTED_READ_ACTIONS)) {
      expect(toolIdToAction(id), id).toBe(expected);
    }
  });

  it("keeps explicit mappings for known non-read tools", () => {
    expect(toolIdToAction("write_file")).toBe("write_file");
    expect(toolIdToAction("execute_command")).toBe("execute_command");
    expect(toolIdToAction("delete_file")).toBe("delete_file");
    expect(toolIdToAction("apply_file_changes")).toBe("write_file");
    expect(toolIdToAction("mcp_tool")).toBe("mcp_tool");
    expect(toolIdToAction("bash")).toBe("execute_command");
  });

  it("never classifies an unknown tool id as an auto-approved action", () => {
    for (const id of UNKNOWN_IDS) {
      const action = toolIdToAction(id);
      expect(
        AUTO_APPROVED_ACTIONS.has(action),
        `unknown id ${JSON.stringify(id)} mapped to auto-approved action ${action}`,
      ).toBe(false);
    }
  });

  it("returns a declared PermissionAction (not an inherited Object member)", () => {
    // Before the fix, `toolIdToAction("constructor")` returned the Object
    // constructor function through the prototype chain — a non-action that
    // skipped the map's own lookup entirely.
    for (const id of UNKNOWN_IDS) {
      expect(typeof toolIdToAction(id), id).toBe("string");
    }
  });
});

describe("M4PermissionPipeline — unknown ids cannot bypass approval", () => {
  /** Production-like config: reads auto-approved, everything else ASKs. */
  function createPipeline(options: {
    presentApproval: (
      request: ApprovalPresentation,
    ) => Promise<UserApprovalChoice>;
    approvalTimeoutMs?: number;
  }) {
    return new M4PermissionPipeline({
      workspaceRoot: WORKSPACE,
      approvalTimeoutMs: options.approvalTimeoutMs ?? 2_000,
      autoApproveReads: true,
      presentApproval: options.presentApproval,
    });
  }

  it("mapped read tools still auto-approve without a prompt", async () => {
    const presentApproval = vi.fn(
      async (_request: ApprovalPresentation): Promise<UserApprovalChoice> => ({
        decision: "allow",
      }),
    );
    const pipeline = createPipeline({ presentApproval });
    const result = await pipeline.evaluate({
      toolId: "read_file",
      executionId: "exec-read",
      input: { path: "src/foo.ts" },
      cwd: WORKSPACE,
    });
    expect(result.approved).toBe(true);
    expect(result.decision).toBe("allow");
    expect(presentApproval).not.toHaveBeenCalled();
    expect(pipeline.approvalManager.pendingCount()).toBe(0);
    pipeline.dispose();
  });

  it("an unknown tool id presents an approval and cannot execute when nobody approves", async () => {
    const presentApproval = vi.fn(
      async (_request: ApprovalPresentation): Promise<UserApprovalChoice> => ({
        decision: "allow",
      }),
    );
    const pipeline = createPipeline({
      presentApproval,
      approvalTimeoutMs: 100,
    });
    const result = await pipeline.evaluate({
      toolId: "brand_new_tool_xyz",
      executionId: "exec-unknown",
      input: { path: "src/foo.ts" },
      cwd: WORKSPACE,
    });
    // The prompt MUST have been raised — no silent auto-approval…
    expect(presentApproval).toHaveBeenCalledTimes(1);
    expect(presentApproval.mock.calls[0]![0].toolId).toBe("brand_new_tool_xyz");
    // …and with no approval granted the execution is blocked (approval
    // expired → deny). approved:false is what the caller checks before
    // invoking the tool, so the tool never runs.
    expect(result.approved).toBe(false);
    expect(result.decision).toBe("deny");
    pipeline.dispose();
  });

  it("an unknown tool id stays blocked while approval is pending", async () => {
    const presentApproval = vi.fn(
      async (_request: ApprovalPresentation): Promise<UserApprovalChoice> => ({
        decision: "allow",
      }),
    );
    const pipeline = createPipeline({ presentApproval });
    let resolved = false;
    const promise = pipeline
      .evaluate({
        toolId: "run_something_totally_new",
        executionId: "exec-pending",
        input: { path: "src/foo.ts" },
        cwd: WORKSPACE,
      })
      .then((r) => {
        resolved = true;
        return r;
      });

    // While the approval is pending there is no allow decision to act on.
    expect(presentApproval).toHaveBeenCalledTimes(1);
    expect(resolved).toBe(false);
    expect(
      pipeline.approvalManager
        .listPending()
        .some((p) => p.toolId === "run_something_totally_new"),
    ).toBe(true);

    // Explicit approval is the legitimate gate — after it, execution is allowed.
    const pending = pipeline.approvalManager.listPending();
    pipeline.approvalManager.approve(
      pending[0]!.approvalId,
      "single_execution",
      "User approved unknown tool",
    );
    const result = await promise;
    expect(resolved).toBe(true);
    expect(result.approved).toBe(true);
    expect(result.decision).toBe("allow");
    pipeline.dispose();
  });

  it("rejection of an unknown tool id denies execution", async () => {
    const presentApproval = vi.fn(
      async (_request: ApprovalPresentation): Promise<UserApprovalChoice> => ({
        decision: "deny",
      }),
    );
    const pipeline = createPipeline({ presentApproval });
    const promise = pipeline.evaluate({
      toolId: "brand_new_tool_xyz",
      executionId: "exec-deny",
      input: { path: "src/foo.ts" },
      cwd: WORKSPACE,
    });
    const pending = pipeline.approvalManager.listPending();
    expect(pending.length).toBe(1);
    pipeline.approvalManager.reject(
      pending[0]!.approvalId,
      "single_execution",
      "User rejected unknown tool",
    );
    const result = await promise;
    expect(result.approved).toBe(false);
    expect(result.decision).toBe("deny");
    pipeline.dispose();
  });

  it("auto-approve for reads does not leak to unknown ids", async () => {
    // Regression: the old default routed unknown ids into exactly this
    // auto-approved read path, so `autoApproveReads: true` silently waved
    // them through with decision "allow".
    const presentApproval = vi.fn(
      async (_request: ApprovalPresentation): Promise<UserApprovalChoice> => ({
        decision: "allow",
      }),
    );
    const pipeline = createPipeline({
      presentApproval,
      approvalTimeoutMs: 100,
    });
    const result = await pipeline.evaluate({
      toolId: "not_in_the_map_at_all",
      executionId: "exec-leak",
      input: { query: "anything" },
      cwd: WORKSPACE,
    });
    expect(result.decision).not.toBe("allow");
    expect(result.approved).toBe(false);
    expect(presentApproval).toHaveBeenCalled();
    pipeline.dispose();
  });
});
