import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChangeSetManager, generateDiff } from "./index.js";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("ChangeSetManager", () => {
  let testDir: string;
  let manager: ChangeSetManager;

  beforeEach(() => {
    testDir = join(tmpdir(), `changeset-test-${Date.now()}`);
    mkdirSync(join(testDir, "src"), { recursive: true });
    writeFileSync(
      join(testDir, "src/App.java"),
      'package com.demo;\npublic class App {\n    public String greet() { return "Hello"; }\n}',
    );
    manager = new ChangeSetManager({ workspaceRoot: testDir });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("creates a ChangeSet with pending changes", () => {
    const cs = manager.createChangeSet("task-1", [
      {
        filePath: "src/App.java",
        proposedContent:
          'package com.demo;\npublic class App {\n    public String greet() { return "Hi"; }\n}',
      },
    ]);

    expect(cs.id).toBeDefined();
    expect(cs.taskId).toBe("task-1");
    expect(cs.changes).toHaveLength(1);
    expect(cs.changes[0].status).toBe("pending");
    expect(cs.changes[0].originalContent).toContain("Hello");
    expect(cs.changes[0].proposedContent).toContain("Hi");
    expect(cs.changes[0].diff).toBeDefined();
    expect(cs.status).toBe("pending");
  });

  it("accepts a change and writes file to disk", () => {
    const cs = manager.createChangeSet("task-1", [
      {
        filePath: "src/App.java",
        proposedContent:
          'package com.demo;\npublic class App {\n    public String greet() { return "Hi"; }\n}',
      },
    ]);

    const result = manager.acceptChange(cs.id, cs.changes[0].id);
    expect(result.success).toBe(true);

    const content = readFileSync(join(testDir, "src/App.java"), "utf8");
    expect(content).toContain("Hi");
    expect(cs.changes[0].status).toBe("applied");
    expect(cs.status).toBe("fully_applied");
  });

  it("rejects a change and leaves file untouched", () => {
    const cs = manager.createChangeSet("task-1", [
      { filePath: "src/App.java", proposedContent: "MODIFIED CONTENT" },
    ]);

    const result = manager.rejectChange(cs.id, cs.changes[0].id);
    expect(result).toBe(true);

    const content = readFileSync(join(testDir, "src/App.java"), "utf8");
    expect(content).toContain("Hello");
    expect(cs.changes[0].status).toBe("rejected");
  });

  it("detects external file conflicts", () => {
    const cs = manager.createChangeSet("task-1", [
      { filePath: "src/App.java", proposedContent: "MODIFIED" },
    ]);

    // Externally modify the file
    writeFileSync(join(testDir, "src/App.java"), "EXTERNAL CHANGE");

    const result = manager.acceptChange(cs.id, cs.changes[0].id);
    expect(result.success).toBe(false);
    expect(cs.changes[0].status).toBe("conflict");
    expect(cs.changes[0].conflictInfo).toBeDefined();
    expect(cs.changes[0].conflictInfo?.reason).toContain("modified externally");
  });

  it("rollback restores original content", () => {
    const cs = manager.createChangeSet("task-1", [
      {
        filePath: "src/App.java",
        proposedContent:
          'package com.demo;\npublic class App {\n    public String greet() { return "Rollback"; }\n}',
      },
    ]);

    manager.acceptChange(cs.id, cs.changes[0].id);
    expect(readFileSync(join(testDir, "src/App.java"), "utf8")).toContain(
      "Rollback",
    );

    const rb = manager.rollbackChange(cs.id, cs.changes[0].id);
    expect(rb.success).toBe(true);
    expect(readFileSync(join(testDir, "src/App.java"), "utf8")).toContain(
      "Hello",
    );
    expect(cs.changes[0].status).toBe("rolled_back");
  });

  it("acceptAll applies all pending changes", () => {
    mkdirSync(join(testDir, "src/sub"), { recursive: true });
    writeFileSync(
      join(testDir, "src/sub/B.java"),
      "package com.demo;\nclass B {}\n",
    );

    const cs = manager.createChangeSet("task-1", [
      { filePath: "src/App.java", proposedContent: "CHANGE 1" },
      { filePath: "src/sub/B.java", proposedContent: "CHANGE 2" },
    ]);

    const result = manager.acceptAll(cs.id);
    expect(result.applied).toBe(2);
    expect(readFileSync(join(testDir, "src/App.java"), "utf8")).toBe(
      "CHANGE 1",
    );
    expect(readFileSync(join(testDir, "src/sub/B.java"), "utf8")).toBe(
      "CHANGE 2",
    );
  });

  it("rejectAll rejects all pending changes", () => {
    const cs = manager.createChangeSet("task-1", [
      { filePath: "src/App.java", proposedContent: "CHANGE 1" },
    ]);

    const count = manager.rejectAll(cs.id);
    expect(count).toBe(1);
    expect(cs.changes[0].status).toBe("rejected");
  });

  it("creates new files that don't exist", () => {
    const cs = manager.createChangeSet("task-1", [
      {
        filePath: "src/NewService.java",
        proposedContent: "package com.demo;\npublic class NewService {}",
      },
    ]);

    expect(existsSync(join(testDir, "src/NewService.java"))).toBe(false);

    const result = manager.acceptChange(cs.id, cs.changes[0].id);
    expect(result.success).toBe(true);
    expect(existsSync(join(testDir, "src/NewService.java"))).toBe(true);
    expect(readFileSync(join(testDir, "src/NewService.java"), "utf8")).toBe(
      "package com.demo;\npublic class NewService {}",
    );
  });

  it("rejects a new file without creating it", () => {
    const filePath = "src/Rejected.java";
    const cs = manager.createChangeSet("task-1", [
      { filePath, proposedContent: "MUST NOT EXIST" },
    ]);

    expect(manager.rejectChange(cs.id, cs.changes[0].id)).toBe(true);
    expect(existsSync(join(testDir, filePath))).toBe(false);
  });

  it("reports filesystem apply failures as failed", () => {
    const cs = manager.createChangeSet("task-1", [
      { filePath: "src\u0000Invalid.java", proposedContent: "INVALID PATH" },
    ]);

    const result = manager.acceptChange(cs.id, cs.changes[0].id);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(cs.changes[0].status).toBe("failed");
    expect(cs.status).toBe("failed");
  });

  it("blocks paths outside the workspace", () => {
    expect(() =>
      manager.createChangeSet("task-1", [
        { filePath: "../outside.txt", proposedContent: "MUST NOT WRITE" },
      ]),
    ).toThrow("Path escapes workspace boundary");
  });

  it("returns error for unknown ChangeSet", () => {
    const result = manager.acceptChange("nonexistent", "change-1");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("rejectAll leaves all files untouched", () => {
    mkdirSync(join(testDir, "src/sub"), { recursive: true });
    writeFileSync(join(testDir, "src/sub/B.java"), "KEEP THIS");

    const cs = manager.createChangeSet("task-1", [
      { filePath: "src/App.java", proposedContent: "CHANGE 1" },
      { filePath: "src/sub/B.java", proposedContent: "CHANGE 2" },
    ]);

    const count = manager.rejectAll(cs.id);
    expect(count).toBe(2);
    expect(readFileSync(join(testDir, "src/App.java"), "utf8")).toContain(
      "Hello",
    );
    expect(readFileSync(join(testDir, "src/sub/B.java"), "utf8")).toBe(
      "KEEP THIS",
    );
  });

  it("conflict detection prevents overwrite of externally modified file", () => {
    const cs = manager.createChangeSet("task-1", [
      { filePath: "src/App.java", proposedContent: "AGENT CHANGE" },
    ]);

    // File changed externally between proposal and accept
    writeFileSync(join(testDir, "src/App.java"), "USER'S UNRELATED CHANGE");

    const result = manager.acceptChange(cs.id, cs.changes[0].id);
    expect(result.success).toBe(false);
    expect(cs.changes[0].status).toBe("conflict");
    expect(cs.changes[0].conflictInfo?.reason).toContain("modified externally");

    // File must be untouched
    expect(readFileSync(join(testDir, "src/App.java"), "utf8")).toBe(
      "USER'S UNRELATED CHANGE",
    );
  });

  it("partial accept/reject across a ChangeSet", () => {
    mkdirSync(join(testDir, "src/sub"), { recursive: true });
    writeFileSync(join(testDir, "src/sub/B.java"), "ORIGINAL B\n");

    const cs = manager.createChangeSet("task-1", [
      { filePath: "src/App.java", proposedContent: "ACCEPTED" },
      { filePath: "src/sub/B.java", proposedContent: "REJECTED" },
    ]);

    manager.acceptChange(cs.id, cs.changes[0].id);
    manager.rejectChange(cs.id, cs.changes[1].id);

    expect(cs.changes[0].status).toBe("applied");
    expect(cs.changes[1].status).toBe("rejected");
    expect(cs.status).toBe("partially_applied");
    expect(readFileSync(join(testDir, "src/App.java"), "utf8")).toBe(
      "ACCEPTED",
    );
    expect(readFileSync(join(testDir, "src/sub/B.java"), "utf8")).toBe(
      "ORIGINAL B\n",
    );
  });
});

describe("generateDiff", () => {
  it("generates a unified diff", () => {
    const diff = generateDiff(
      "line1\nline2\nline3",
      "line1\nMODIFIED\nline3",
      "test.java",
    );
    expect(diff).toContain("-line2");
    expect(diff).toContain("+MODIFIED");
    expect(diff).toContain(" line1");
  });
});
