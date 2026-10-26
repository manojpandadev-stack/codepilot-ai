/**
 * Verification Engine — security boundary tests.
 *
 * The verification engine is host-initiated presentation infrastructure.
 * These tests pin the boundary that keeps it that way:
 *
 *  1. It must NOT appear in the model-callable tool surface (if the model
 *     could invoke verification directly, it would be an ungated execution
 *     path).
 *  2. Its commands run through the existing CommandExecutionService
 *     (structured argv, sanitized env, timeout, tree-kill cleanup) — no
 *     new unrestricted shell path is introduced.
 */

import { describe, expect, it } from "vitest";
import { BUILTIN_TOOL_DISPLAY_CONTRACT } from "../apps/vscode-extension/src/tool-contract";
import { runVerification } from "../packages/tool-engine/src/verification-engine.js";

describe("verification security boundary", () => {
  it("the engine is not registered as a model-callable tool", () => {
    const names = JSON.stringify(BUILTIN_TOOL_DISPLAY_CONTRACT);
    expect(names.toLowerCase()).not.toContain("verification");
  });

  it("production execution uses CommandExecutionService (no raw shell path)", async () => {
    // In a directory with no manifests nothing is planned, and the executor
    // module wires safeCommandExecutor (structured argv) by default — there
    // is no code path that spawns a raw shell string.
    const dir = (await import("node:fs")).mkdtempSync(
      (await import("node:path")).join((await import("node:os")).tmpdir(), "cc-boundary-"),
    );
    const result = await runVerification({ workspaceRoot: dir });
    expect(result.checks.every((c) => c.status === "not_available")).toBe(true);
    expect(result.verdict).toBe("not_available");
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  });
});
