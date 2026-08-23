/**
 * Context Features E2E Test
 *
 * Tests @folder, @url, @file, @problems, and .clinerules loading.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveFile, resolveFolder, fetchUrlContent, loadProjectRules, loadGlobalRules, loadAllRules, rulesToContextItems } from "../packages/context-engine/src/index.js";

const WORKSPACE = path.resolve(process.cwd());

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

async function runTests(): Promise<void> {
  console.log("=== Context Features E2E Test ===\n");

  // --- Test 1: @file resolution ---
  console.log("Test 1: @file resolution...");
  const fileItems = await resolveFile("package.json", WORKSPACE);
  assert(fileItems.length > 0, "Should resolve package.json");
  assert(fileItems[0]!.content.includes("codepilot"), "Should contain project name");
  assert(fileItems[0]!.source === "current_file", "Source should be current_file");
  console.log("  ✓ Pass\n");

  // --- Test 2: @file outside workspace ---
  console.log("Test 2: @file outside workspace...");
  const outsideItems = await resolveFile("../../../etc/passwd", WORKSPACE);
  assert(outsideItems[0]!.content.includes("Error"), "Should return error for outside file");
  console.log("  ✓ Pass\n");

  // --- Test 3: @file nonexistent ---
  console.log("Test 3: @file nonexistent...");
  const missingItems = await resolveFile("nonexistent-file-xyz.txt", WORKSPACE);
  assert(missingItems[0]!.content.includes("Error"), "Should return error for missing file");
  console.log("  ✓ Pass\n");

  // --- Test 4: @folder resolution ---
  console.log("Test 4: @folder resolution...");
  const folderItems = await resolveFolder("packages/shared/src", WORKSPACE, { maxFiles: 5, maxTokens: 5000 });
  assert(folderItems.length > 0, "Should resolve shared/src folder");
  assert(folderItems[0]!.content.includes("Folder:"), "First item should be folder listing");
  assert(folderItems[0]!.metadata?.type === "folder_listing", "Should be folder listing");
  console.log(`  Found ${folderItems.length} items ✓\n`);

  // --- Test 5: @folder outside workspace ---
  console.log("Test 5: @folder outside workspace...");
  const outsideFolder = await resolveFolder("../../../etc", WORKSPACE);
  assert(outsideFolder[0]!.content.includes("Error"), "Should return error for outside folder");
  console.log("  ✓ Pass\n");

  // --- Test 6: @folder with extension filter ---
  console.log("Test 6: @folder with extension filter...");
  const tsOnly = await resolveFolder("packages/shared/src", WORKSPACE, {
    maxFiles: 10,
    maxTokens: 10000,
    includeExtensions: [".ts"],
  });
  assert(tsOnly.length > 0, "Should find .ts files");
  const hasNonTs = tsOnly.some((item) => item.metadata?.type === "file_content" && !String(item.metadata.path).endsWith(".ts"));
  assert(!hasNonTs, "Should only contain .ts files");
  console.log("  ✓ Pass\n");

  // --- Test 7: @url — valid public URL ---
  console.log("Test 7: @url — valid public URL...");
  const urlItems = await fetchUrlContent("https://example.com", { timeoutMs: 10000, maxChars: 5000 });
  assert(urlItems.length > 0, "Should fetch URL content");
  assert(urlItems[0]!.content.includes("URL:"), "Should include URL header");
  assert(urlItems[0]!.content.length > 100, "Should have substantial content");
  console.log("  ✓ Pass\n");

  // --- Test 8: @url — SSRF protection (localhost) ---
  console.log("Test 8: @url — SSRF protection (localhost)...");
  const ssrfItems = await fetchUrlContent("http://localhost:8080/secret");
  assert(ssrfItems[0]!.content.includes("Error"), "Should block localhost");
  assert(ssrfItems[0]!.content.includes("private"), "Should mention private/internal");
  console.log("  ✓ Pass\n");

  // --- Test 9: @url — SSRF protection (private IP) ---
  console.log("Test 9: @url — SSRF protection (private IP)...");
  const privateItems = await fetchUrlContent("http://192.168.1.1/admin");
  assert(privateItems[0]!.content.includes("Error"), "Should block private IP");
  console.log("  ✓ Pass\n");

  // --- Test 10: @url — invalid URL ---
  console.log("Test 10: @url — invalid URL...");
  const invalidItems = await fetchUrlContent("not-a-url");
  assert(invalidItems[0]!.content.includes("Error"), "Should return error for invalid URL");
  console.log("  ✓ Pass\n");

  // --- Test 11: @url — blocked protocol ---
  console.log("Test 11: @url — blocked protocol (file://)...");
  const fileItems2 = await fetchUrlContent("file:///etc/passwd");
  assert(fileItems2[0]!.content.includes("Error"), "Should block file:// protocol");
  console.log("  ✓ Pass\n");

  // --- Test 12: .clinerules loading ---
  console.log("Test 12: .clinerules loading...");
  // Create a temporary rules directory
  // Create a temp workspace with .clinerules inside it
  const tmpWorkspace = path.join(WORKSPACE, ".clinerules-test-ws");
  const tmpRulesDir = path.join(tmpWorkspace, ".clinerules");
  await fs.mkdir(tmpRulesDir, { recursive: true });
  await fs.writeFile(path.join(tmpRulesDir, "coding-style.md"), "# Coding Style\nUse TypeScript strict mode.\n");
  await fs.mkdir(path.join(tmpRulesDir, "backend"), { recursive: true });
  await fs.writeFile(path.join(tmpRulesDir, "backend", "java.md"), "# Java Rules\nUse Java 21.\n");

  const rules = await loadProjectRules(tmpWorkspace);
  assert(rules.length === 2, `Should load 2 rules, got ${rules.length}`);
  assert(rules.some((r) => r.content.includes("TypeScript")), "Should have coding-style rule");
  assert(rules.some((r) => r.content.includes("Java 21")), "Should have java rule");
  assert(rules.every((r) => r.source === "project"), "All should be project rules");

  // Test rulesToContextItems
  const contextItems = rulesToContextItems(rules);
  assert(contextItems.length === 2, "Should create 2 context items");
  assert(contextItems[0]!.source === "project_rules", "Source should be project_rules");

  // Cleanup
  await fs.rm(tmpWorkspace, { recursive: true, force: true });
  console.log("  ✓ Pass\n");

  // --- Test 13: Global rules loading ---
  console.log("Test 13: Global rules loading...");
  const globalRules = await loadGlobalRules();
  console.log(`  Found ${globalRules.length} global rules`);
  // Just verify it doesn't crash — global rules may or may not exist
  console.log("  ✓ Pass\n");

  // --- Test 14: Rules precedence (project overrides global) ---
  console.log("Test 14: Rules precedence...");
  // The loadAllRules function should merge global + project
  const allRules = await loadAllRules(WORKSPACE);
  console.log(`  Total rules: ${allRules.length}`);
  // Verify no duplicate patterns
  const patterns = allRules.map((r) => r.pattern);
  const uniquePatterns = new Set(patterns);
  assert(uniquePatterns.size === patterns.length, "No duplicate patterns after merge");
  console.log("  ✓ Pass\n");

  // --- Test 15: @url — HTTPS content type detection ---
  console.log("Test 15: @url — HTTPS content type detection...");
  const htmlItems = await fetchUrlContent("https://example.com", { timeoutMs: 10000 });
  assert(htmlItems.length > 0, "Should fetch HTML content");
  // example.com returns HTML, which should be converted to text
  assert(!htmlItems[0]!.content.includes("<html"), "HTML should be converted to text");
  console.log("  ✓ Pass\n");

  console.log("=== ALL 15 TESTS PASSED ✓ ===");
}

runTests().catch((err) => {
  console.error("\n❌ FAILED:", err.message);
  process.exit(1);
});
