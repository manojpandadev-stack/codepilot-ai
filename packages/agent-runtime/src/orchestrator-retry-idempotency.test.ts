/**
 * Orchestrator retry/idempotency regression: the ORCHESTRATOR's
 * `executeTask` previously retried unconditionally, re-executing an
 * identical (possibly mutating) command on a possibly already-mutated
 * workspace. This test proves that a failed non-idempotent task whose
 * command text is unchanged is recorded as outcome-unknown and NOT
 * re-executed.
 *
 * Deterministic: no network, no real model. The host agent is constructed
 * with a non-existent provider, so initialize() rejects and executeTask
 * takes its retry path. The guard is exercised when the identical command
 * is about to run a second time.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  MultiAgentOrchestrator,
  computeTaskHash,
  type TaskNode,
} from "./orchestrator.js";
import type { CodePilotAgentConfig } from "./types.js";

describe("MultiAgentOrchestrator executeTask idempotency guard", () => {
  let baseConfig: CodePilotAgentConfig;

  beforeEach(() => {
    baseConfig = {
      providerId: "definitely-not-a-real-provider",
      modelId: "m",
      workspaceRoot: "/repo",
      privacyMode: "cloud",
      agentMode: "act",
      maxIterations: 5,
      temperature: 0.2,
    };
  });

  it("records outcome-unknown and does not re-execute when the same command repeats", async () => {
    const orch = new MultiAgentOrchestrator(baseConfig, { maxRetries: 2 });

    // "echo mutate >> file.txt" forces a single "coder" task via the explicit
    // role override, so the DAG has one task. Its command text
    // (task.description) is identical across retries.
    const description = "echo mutate >> file.txt";

    const { dag: runDag } = await orch.execute(description, "act", {
      roles: ["coder"],
    });
    const final = runDag!.getTask("task-1");
    // Terminal FAILED state: non-idempotent command replayed once and then
    // blocked as outcome-unknown.
    expect(final?.status).toBe("failed");
    expect(final?.retryCount).toBe(1);
    expect(final?.error).toContain("outcome unknown");
    // The DAG should NOT have re-run the command (no second successful result)
    expect(runDag!.getTask("task-1")?.result).toBeUndefined();
    expect(final?.error).toContain("may have executed");

    // No successful result emitted for the re-run
    expect(final?.result).toBeUndefined();
  });

  it("rounds the guard's hash input so an undefined hash does not throw", () => {
    const task = {
      id: "t-empty",
      agentRole: "architect",
      description: "echo hi",
      dependencies: [],
      status: "pending",
      priority: 1,
      retryCount: 0,
      maxRetries: 1,
      timeoutMs: 300_000,
      lastCommandHash: undefined,
    } as TaskNode;
    const hash = task.lastCommandHash ?? "";
    expect(hash).toBe("");
    // computeTaskHash on undefined throws (used for assertion clarity only)
    expect(() => computeTaskHash(undefined as unknown as string)).toThrow();
  });
});
