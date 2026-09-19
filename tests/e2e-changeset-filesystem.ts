/**
 * Real filesystem E2E test for ChangeSet/Diff/Approval lifecycle.
 *
 * Tests:
 *  1. Reject leaves file unchanged
 *  2. Accept modifies file on disk
 *  3. Accept All modifies all files
 *  4. Reject All leaves all files unchanged
 *  5. External modification triggers conflict
 *  6. Rollback restores original content
 *  7. New file creation works
 *  8. Partial accept/reject preserves unmodified files
 */

import { ChangeSetManager, generateDiff } from "../packages/changeset-engine/src/index.js";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const testDir = join(tmpdir(), `e2e-changeset-${Date.now()}`);

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  ✗ FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

function setup() {
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(testDir, "src"), { recursive: true });
  writeFileSync(join(testDir, "src/App.java"), "package com.demo;\npublic class App {\n    public String greet() { return \"Hello\"; }\n}\n");
  writeFileSync(join(testDir, "src/Service.java"), "package com.demo;\npublic class Service {\n    public void run() { /* original */ }\n}\n");
}

function cleanup() {
  rmSync(testDir, { recursive: true, force: true });
}

async function runTests() {
  setup();
  const manager = new ChangeSetManager({ workspaceRoot: testDir });
  let passed = 0;
  let failed = 0;

  // ====================================================================
  // TEST 1: Reject leaves file unchanged
  // ====================================================================
  console.log("\n--- Test 1: Reject leaves file unchanged ---");
  {
    const cs = manager.createChangeSet("task-1", [
      { filePath: "src/App.java", proposedContent: "package com.demo;\npublic class App {\n    public String greet() { return \"Rejected\"; }\n}\n" },
    ]);
    const originalContent = readFileSync(join(testDir, "src/App.java"), "utf8");
    manager.rejectChange(cs.id, cs.changes[0].id);
    const afterContent = readFileSync(join(testDir, "src/App.java"), "utf8");
    assert(originalContent === afterContent, "File content is unchanged after reject");
    assert(cs.changes[0].status === "rejected", "Change status is rejected");
    passed++;
  }

  // ====================================================================
  // TEST 2: Accept modifies file on disk
  // ====================================================================
  console.log("\n--- Test 2: Accept modifies file on disk ---");
  {
    const cs = manager.createChangeSet("task-2", [
      { filePath: "src/App.java", proposedContent: "package com.demo;\npublic class App {\n    public String greet() { return \"Hi\"; }\n}\n" },
    ]);
    const result = await manager.acceptChange(cs.id, cs.changes[0].id);
    assert(result.success === true, "Accept returned success");
    const content = readFileSync(join(testDir, "src/App.java"), "utf8");
    assert(content.includes("Hi"), "File content was updated to 'Hi'");
    assert(!content.includes("Hello"), "Original 'Hello' is gone");
    assert(cs.changes[0].status === "applied", "Change status is applied");
    passed++;
  }

  // ====================================================================
  // TEST 3: Accept All modifies all files
  // ====================================================================
  console.log("\n--- Test 3: Accept All modifies all files ---");
  {
    // First reset App.java
    writeFileSync(join(testDir, "src/App.java"), "package com.demo;\npublic class App {\n    public String greet() { return \"Reset\"; }\n}\n");
    const cs = manager.createChangeSet("task-3", [
      { filePath: "src/App.java", proposedContent: "CHANGE_A" },
      { filePath: "src/Service.java", proposedContent: "CHANGE_B" },
    ]);
    const result = await manager.acceptAll(cs.id);
    assert(result.applied === 2, `All 2 changes applied (got ${result.applied})`);
    assert(readFileSync(join(testDir, "src/App.java"), "utf8") === "CHANGE_A", "App.java contains CHANGE_A");
    assert(readFileSync(join(testDir, "src/Service.java"), "utf8") === "CHANGE_B", "Service.java contains CHANGE_B");
    assert(cs.status === "fully_applied", "ChangeSet status is fully_applied");
    passed++;
  }

  // ====================================================================
  // TEST 4: Reject All leaves all files unchanged
  // ====================================================================
  console.log("\n--- Test 4: Reject All leaves all files unchanged ---");
  {
    const beforeApp = readFileSync(join(testDir, "src/App.java"), "utf8");
    const beforeService = readFileSync(join(testDir, "src/Service.java"), "utf8");
    const cs = manager.createChangeSet("task-4", [
      { filePath: "src/App.java", proposedContent: "SHOULD_NOT_APPEAR" },
      { filePath: "src/Service.java", proposedContent: "ALSO_NOT" },
    ]);
    const count = manager.rejectAll(cs.id);
    assert(count === 2, "Rejected 2 changes");
    assert(readFileSync(join(testDir, "src/App.java"), "utf8") === beforeApp, "App.java unchanged after rejectAll");
    assert(readFileSync(join(testDir, "src/Service.java"), "utf8") === beforeService, "Service.java unchanged after rejectAll");
    passed++;
  }

  // ====================================================================
  // TEST 5: External modification triggers conflict
  // ====================================================================
  console.log("\n--- Test 5: External modification triggers conflict ---");
  {
    const cs = manager.createChangeSet("task-5", [
      { filePath: "src/App.java", proposedContent: "AGENT_WANTS_THIS" },
    ]);
    // External modification between proposal and accept
    writeFileSync(join(testDir, "src/App.java"), "USER_MODIFIED_THIS_EXTERNALLY");
    const result = await manager.acceptChange(cs.id, cs.changes[0].id);
    assert(result.success === false, "Accept failed due to conflict");
    assert(cs.changes[0].status === "conflict", "Change status is conflict");
    assert(cs.changes[0].conflictInfo !== undefined, "Conflict info is present");
    assert(cs.changes[0].conflictInfo!.reason.includes("modified externally"), "Conflict reason mentions external modification");
    // File must contain the user's change, NOT the agent's
    assert(readFileSync(join(testDir, "src/App.java"), "utf8") === "USER_MODIFIED_THIS_EXTERNALLY", "File contains user's external change");
    passed++;
  }

  // ====================================================================
  // TEST 6: Rollback restores original content
  // ====================================================================
  console.log("\n--- Test 6: Rollback restores original content ---");
  {
    writeFileSync(join(testDir, "src/App.java"), "package com.demo;\npublic class App {\n    public String greet() { return \"BeforeRollback\"; }\n}\n");
    const cs = manager.createChangeSet("task-6", [
      { filePath: "src/App.java", proposedContent: "package com.demo;\npublic class App {\n    public String greet() { return \"AfterAccept\"; }\n}\n" },
    ]);
    await manager.acceptChange(cs.id, cs.changes[0].id);
    const afterAccept = readFileSync(join(testDir, "src/App.java"), "utf8");
    assert(afterAccept.includes("AfterAccept"), "File was modified after accept");

    const rb = await manager.rollbackChange(cs.id, cs.changes[0].id);
    assert(rb.success === true, "Rollback succeeded");
    const afterRollback = readFileSync(join(testDir, "src/App.java"), "utf8");
    assert(afterRollback.includes("BeforeRollback"), "File restored to original after rollback");
    assert(cs.changes[0].status === "rolled_back", "Change status is rolled_back");
    passed++;
  }

  // ====================================================================
  // TEST 7: New file creation works
  // ====================================================================
  console.log("\n--- Test 7: New file creation works ---");
  {
    const newPath = "src/NewService.java";
    assert(!existsSync(join(testDir, newPath)), "File does not exist before agent");
    const cs = manager.createChangeSet("task-7", [
      { filePath: newPath, proposedContent: "package com.demo;\npublic class NewService {}\n" },
    ]);
    const result = await manager.acceptChange(cs.id, cs.changes[0].id);
    assert(result.success === true, "Accept succeeded for new file");
    assert(existsSync(join(testDir, newPath)), "File now exists on disk");
    assert(readFileSync(join(testDir, newPath), "utf8").includes("NewService"), "File contains correct content");
    passed++;
  }

  // ====================================================================
  // TEST 8: Partial accept/reject preserves unmodified files
  // ====================================================================
  console.log("\n--- Test 8: Partial accept/reject ---");
  {
    writeFileSync(join(testDir, "src/App.java"), "KEEP_THIS_VALUE");
    writeFileSync(join(testDir, "src/Service.java"), "ALSO_KEEP");
    const cs = manager.createChangeSet("task-8", [
      { filePath: "src/App.java", proposedContent: "ACCEPT_THIS" },
      { filePath: "src/Service.java", proposedContent: "REJECT_THIS" },
    ]);
    await manager.acceptChange(cs.id, cs.changes[0].id);
    manager.rejectChange(cs.id, cs.changes[1].id);
    assert(readFileSync(join(testDir, "src/App.java"), "utf8") === "ACCEPT_THIS", "App.java was accepted");
    assert(readFileSync(join(testDir, "src/Service.java"), "utf8") === "ALSO_KEEP", "Service.java was rejected and untouched");
    assert(cs.status === "partially_applied", "ChangeSet status is partially_applied");
    passed++;
  }

  // ====================================================================
  // TEST 9: Diff generation produces meaningful output
  // ====================================================================
  console.log("\n--- Test 9: Diff generation ---");
  {
    const diff = generateDiff(
      "line1\nline2\nline3",
      "line1\nMODIFIED\nline3",
      "test.java"
    );
    assert(diff.includes("-line2"), "Diff shows removed line");
    assert(diff.includes("+MODIFIED"), "Diff shows added line");
    assert(diff.includes(" line1"), "Diff shows context line");
    passed++;
  }

  // ====================================================================
  // Summary
  // ====================================================================
  console.log(`\n========================================`);
  console.log(`ChangeSet E2E: ${passed} passed, ${failed} failed`);
  console.log(`========================================`);

  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
