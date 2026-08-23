import { describe, it, expect } from "vitest";
import { TaskDAG } from "./orchestrator.js";
import type { TaskNode } from "./orchestrator.js";

function makeTask(overrides: Partial<TaskNode> & { id: string; agentRole: TaskNode["agentRole"] }): TaskNode {
  return {
    description: `Test task ${overrides.id}`,
    dependencies: [],
    status: "pending",
    priority: 1,
    retryCount: 0,
    maxRetries: 1,
    timeoutMs: 300_000,
    ...overrides,
  };
}

// ============================================================================
// TaskDAG — Dependency Ordering
// ============================================================================

describe("TaskDAG", () => {
  describe("getReadyTasks", () => {
    it("returns all tasks with no dependencies", () => {
      const dag = new TaskDAG();
      dag.addTask(makeTask({ id: "a", agentRole: "architect" }));
      dag.addTask(makeTask({ id: "b", agentRole: "tester" }));

      const ready = dag.getReadyTasks();
      expect(ready).toHaveLength(2);
      expect(ready.map((t) => t.id).sort()).toEqual(["a", "b"]);
    });

    it("returns only tasks whose dependencies are completed", () => {
      const dag = new TaskDAG();
      dag.addTask(makeTask({ id: "a", agentRole: "architect" }));
      dag.addTask(makeTask({ id: "b", agentRole: "coder", dependencies: ["a"] }));
      dag.addTask(makeTask({ id: "c", agentRole: "reviewer", dependencies: ["b"] }));

      // Initially only "a" is ready
      expect(dag.getReadyTasks()).toHaveLength(1);
      expect(dag.getReadyTasks()[0]!.id).toBe("a");

      // After completing "a", "b" becomes ready
      dag.markCompleted("a", "done");
      const ready2 = dag.getReadyTasks();
      expect(ready2).toHaveLength(1);
      expect(ready2[0]!.id).toBe("b");

      // After completing "b", "c" becomes ready
      dag.markCompleted("b", "done");
      const ready3 = dag.getReadyTasks();
      expect(ready3).toHaveLength(1);
      expect(ready3[0]!.id).toBe("c");
    });

    it("does not return running tasks", () => {
      const dag = new TaskDAG();
      dag.addTask(makeTask({ id: "a", agentRole: "architect" }));

      dag.markRunning("a");
      expect(dag.getReadyTasks()).toHaveLength(0);
    });

    it("does not return blocked tasks", () => {
      const dag = new TaskDAG();
      dag.addTask(makeTask({ id: "a", agentRole: "architect" }));
      dag.addTask(makeTask({ id: "b", agentRole: "coder", dependencies: ["a"] }));

      dag.markFailed("a", "error");
      const ready = dag.getReadyTasks();
      expect(ready).toHaveLength(0);
    });
  });

  describe("parallel execution — tester + security", () => {
    it("tester and security become ready at the same time after coder completes", () => {
      const dag = TaskDAG.buildFromRoles(["architect", "coder", "tester", "security", "reviewer"], "test task");

      // Initially only architect is ready
      expect(dag.getReadyTasks()).toHaveLength(1);
      expect(dag.getReadyTasks()[0]!.agentRole).toBe("architect");

      // Complete architect
      dag.markCompleted("task-1", "arch result");

      // Now coder is ready
      expect(dag.getReadyTasks()).toHaveLength(1);
      expect(dag.getReadyTasks()[0]!.agentRole).toBe("coder");

      // Complete coder
      dag.markCompleted("task-2", "code changes");

      // Now BOTH tester and security should be ready (parallel)
      const ready = dag.getReadyTasks();
      expect(ready).toHaveLength(2);
      const roles = ready.map((t) => t.agentRole).sort();
      expect(roles).toEqual(["security", "tester"]);
    });

    it("reviewer waits for BOTH tester and security", () => {
      const dag = TaskDAG.buildFromRoles(["architect", "coder", "tester", "security", "reviewer"], "test task");

      // Complete architect, coder
      dag.markCompleted("task-1", "done");
      dag.markCompleted("task-2", "done");

      // Mark tester completed but not security
      dag.markCompleted("task-3", "tests passed");

      // Reviewer should NOT be ready yet (security not done)
      const ready = dag.getReadyTasks();
      expect(ready).toHaveLength(1);
      expect(ready[0]!.agentRole).toBe("security");

      // Now complete security
      dag.markCompleted("task-4", "no issues");

      // NOW reviewer should be ready
      const ready2 = dag.getReadyTasks();
      expect(ready2).toHaveLength(1);
      expect(ready2[0]!.agentRole).toBe("reviewer");
    });
  });

  describe("failure propagation", () => {
    it("blocks all downstream tasks when a task fails", () => {
      const dag = TaskDAG.buildFromRoles(["architect", "coder", "tester", "security", "reviewer"], "test");

      // Fail architect
      dag.markFailed("task-1", "architect crashed");

      const blocked = dag.propagateFailure("task-1");

      // All 4 downstream tasks should be blocked
      expect(blocked.length).toBe(4);
      expect(dag.getTask("task-2")?.status).toBe("blocked");
      expect(dag.getTask("task-3")?.status).toBe("blocked");
      expect(dag.getTask("task-4")?.status).toBe("blocked");
      expect(dag.getTask("task-5")?.status).toBe("blocked");
    });

    it("only blocks tasks that depend on the failed task", () => {
      const dag = new TaskDAG();
      dag.addTask(makeTask({ id: "a", agentRole: "architect" }));
      dag.addTask(makeTask({ id: "b", agentRole: "coder", dependencies: ["a"] }));
      dag.addTask(makeTask({ id: "c", agentRole: "tester" })); // no dependency on a

      dag.markFailed("a", "crash");
      const blocked = dag.propagateFailure("a");

      expect(blocked).toContain("b");
      expect(blocked).not.toContain("c");
      expect(dag.getTask("c")?.status).toBe("pending");
    });
  });

  describe("isComplete", () => {
    it("is complete when all tasks are resolved", () => {
      const dag = new TaskDAG();
      dag.addTask(makeTask({ id: "a", agentRole: "architect" }));
      dag.addTask(makeTask({ id: "b", agentRole: "coder" }));

      expect(dag.isComplete()).toBe(false);

      dag.markCompleted("a", "done");
      expect(dag.isComplete()).toBe(false);

      dag.markCompleted("b", "done");
      expect(dag.isComplete()).toBe(true);
    });

    it("is complete even with failed/blocked tasks", () => {
      const dag = new TaskDAG();
      dag.addTask(makeTask({ id: "a", agentRole: "architect" }));
      dag.addTask(makeTask({ id: "b", agentRole: "coder" }));

      dag.markCompleted("a", "done");
      dag.markFailed("b", "error");
      expect(dag.isComplete()).toBe(true);
    });
  });

  describe("validate", () => {
    it("returns errors for missing dependencies", () => {
      const dag = new TaskDAG();
      dag.addTask(makeTask({ id: "a", agentRole: "coder", dependencies: ["nonexistent"] }));

      const errors = dag.validate();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("non-existent");
    });

    it("returns empty for valid DAG", () => {
      const dag = TaskDAG.buildFromRoles(["architect", "coder", "tester", "security", "reviewer"], "test");
      const errors = dag.validate();
      expect(errors).toHaveLength(0);
    });
  });

  describe("buildFromRoles — complex DAG structure", () => {
    it("creates correct dependency edges for complex workflow", () => {
      const dag = TaskDAG.buildFromRoles(["architect", "coder", "tester", "security", "reviewer"], "test");

      const tasks = dag.getAllTasks();
      expect(tasks).toHaveLength(5);

      // Architect has no dependencies
      const architect = tasks.find((t) => t.agentRole === "architect");
      expect(architect?.dependencies).toEqual([]);

      // Coder depends on architect
      const coder = tasks.find((t) => t.agentRole === "coder");
      expect(coder?.dependencies).toContain(architect?.id);

      // Tester depends on coder
      const tester = tasks.find((t) => t.agentRole === "tester");
      expect(tester?.dependencies).toEqual([coder?.id]);

      // Security depends on coder
      const security = tasks.find((t) => t.agentRole === "security");
      expect(security?.dependencies).toEqual([coder?.id]);

      // Reviewer depends on BOTH tester AND security
      const reviewer = tasks.find((t) => t.agentRole === "reviewer");
      expect(reviewer?.dependencies).toContain(tester?.id);
      expect(reviewer?.dependencies).toContain(security?.id);
    });
  });

  describe("simple linear DAG", () => {
    it("creates linear chain for simple tasks", () => {
      const dag = TaskDAG.buildFromRoles(["architect"], "explain architecture");
      const tasks = dag.getAllTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.agentRole).toBe("architect");
      expect(tasks[0]!.dependencies).toEqual([]);
    });
  });
});
