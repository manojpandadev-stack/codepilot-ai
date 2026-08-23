/**
 * Context Features Full E2E Test
 *
 * Creates a real temporary workspace with:
 * - Source files (Java backend, TypeScript frontend)
 * - .clinerules with path-specific rules
 * - Tests @file, @folder, @url, @problems, rules loading
 * - Security tests (workspace escape, SSRF, path traversal)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveFile, resolveFolder, fetchUrlContent, loadProjectRules, loadGlobalRules, loadAllRules, rulesToContextItems } from "../packages/context-engine/src/index.js";

const TMP_DIR = path.join(process.cwd(), ".ctx-e2e-temp");

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    failed++;
    console.error(`  ✗ FAIL: ${message}`);
    throw new Error(message);
  }
  passed++;
}

function assertContains(text: string, substring: string, message: string): void {
  if (!text.includes(substring)) {
    failed++;
    console.error(`  ✗ FAIL: ${message} — "${substring}" not found in text`);
    throw new Error(message);
  }
  passed++;
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    failed++;
    console.error(`  ✗ FAIL: ${message} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    throw new Error(message);
  }
  passed++;
}

// ============================================================================
// Setup temporary workspace
// ============================================================================

async function setupWorkspace(): Promise<void> {
  await fs.rm(TMP_DIR, { recursive: true, force: true });
  await fs.mkdir(TMP_DIR, { recursive: true });

  const srcDir = path.join(TMP_DIR, "src");
  const backendDir = path.join(srcDir, "backend");
  const frontendDir = path.join(srcDir, "frontend");

  await fs.mkdir(backendDir, { recursive: true });
  await fs.mkdir(frontendDir, { recursive: true });

  await fs.writeFile(
    path.join(backendDir, "OrderService.java"),
    `package com.example;\n\n@Service\npublic class OrderService {\n  private final OrderRepository repo;\n  \n  public Order createOrder(OrderRequest req) {\n    Order order = new Order(req.getProductId(), req.getQuantity());\n    return repo.save(order);\n  }\n}\n`
  );

  await fs.writeFile(
    path.join(backendDir, "OrderRepository.java"),
    `package com.example;\n\n@Repository\npublic interface OrderRepository extends JpaRepository<Order, Long> {\n  List<Order> findByCustomerId(Long customerId);\n}\n`
  );

  await fs.writeFile(
    path.join(frontendDir, "api.ts"),
    `export const API_BASE = "http://localhost:8080";\n\nexport async function fetchOrders() {\n  const res = await fetch(\`\${API_BASE}/api/orders\`);\n  return res.json();\n}\n`
  );

  // .clinerules
  const rulesDir = path.join(TMP_DIR, ".clinerules");
  await fs.mkdir(rulesDir, { recursive: true });
  await fs.writeFile(path.join(rulesDir, "coding-style.md"), "# Coding Style\nUse TypeScript strict mode. Follow Google Java Style for Java.\n");

  await fs.mkdir(path.join(rulesDir, "backend"), { recursive: true });
  await fs.writeFile(path.join(rulesDir, "backend", "spring.md"), "# Spring Boot Rules\nUse Java 21. Prefer constructor injection.\n");

  await fs.mkdir(path.join(rulesDir, "frontend"), { recursive: true });
  await fs.writeFile(path.join(rulesDir, "frontend", "angular.md"), "# Angular Rules\nUse Angular 17+. Prefer standalone components.\n");

  // node_modules + dist (should be excluded)
  await fs.mkdir(path.join(TMP_DIR, "node_modules"), { recursive: true });
  await fs.writeFile(path.join(TMP_DIR, "node_modules", "debug.js"), "module.exports = {};\n");
  await fs.mkdir(path.join(TMP_DIR, "dist"), { recursive: true });
  await fs.writeFile(path.join(TMP_DIR, "dist", "bundle.js"), "// bundle\n");

  console.log("  Workspace created ✓\n");
}

// ============================================================================
// Tests
// ============================================================================

async function runTests(): Promise<void> {
  console.log("=== Context Features Full E2E Test ===\n");
  await setupWorkspace();

  try {
    // @file
    console.log("Test 1: @file — read OrderService.java...");
    const os = await resolveFile("src/backend/OrderService.java", TMP_DIR);
    assert(os.length > 0, "Should resolve file");
    assertContains(os[0]!.content, "OrderService", "Should contain class name");
    assertEqual(os[0]!.source, "current_file", "Source should be current_file");

    console.log("Test 2: @file — read api.ts...");
    const api = await resolveFile("src/frontend/api.ts", TMP_DIR);
    assert(api.length > 0, "Should resolve file");
    assertContains(api[0]!.content, "API_BASE", "Should contain variable");

    console.log("Test 3: @file — outside workspace BLOCK...");
    const outside = await resolveFile("../../etc/passwd", TMP_DIR);
    assert(outside[0]!.content.includes("Error"), "Should block outside file");

    console.log("Test 4: @file — nonexistent file...");
    const missing = await resolveFile("nonexistent.ts", TMP_DIR);
    assert(missing[0]!.content.includes("Error"), "Should return error");

    // @folder
    console.log("Test 5: @folder — src/backend...");
    const backend = await resolveFolder("src/backend", TMP_DIR, { maxFiles: 10, maxTokens: 10000 });
    assert(backend.length > 0, "Should resolve folder");
    assertContains(backend[0]!.content, "Folder:", "First item should be listing");
    assertContains(backend[0]!.content, "OrderService.java", "Should include file");

    console.log("Test 6: @folder — excludes node_modules/dist...");
    const all = await resolveFolder("src", TMP_DIR, { maxFiles: 50, maxTokens: 50000 });
    const allContent = all.map((i) => i.content).join("\n");
    assert(!allContent.includes("node_modules"), "Should exclude node_modules");
    assert(!allContent.includes("bundle.js"), "Should exclude dist");

    console.log("Test 7: @folder — workspace boundary...");
    const outsideFolder = await resolveFolder("../../etc", TMP_DIR);
    assert(outsideFolder[0]!.content.includes("Error"), "Should block outside folder");

    console.log("Test 8: @folder — extension filter...");
    const javaOnly = await resolveFolder("src", TMP_DIR, { maxFiles: 10, maxTokens: 10000, includeExtensions: [".java"] });
    const jContent = javaOnly.map((i) => i.content).join("\n");
    assert(jContent.includes("OrderService"), "Should contain Java files");
    assert(!jContent.includes("api.ts"), "Should NOT contain .ts files");

    // @url
    console.log("Test 9: @url — fetch example.com...");
    const url = await fetchUrlContent("https://example.com", { timeoutMs: 10000, maxChars: 5000 });
    assert(url.length > 0, "Should fetch content");
    assertContains(url[0]!.content, "URL:", "Should include URL header");

    console.log("Test 10: @url — SSRF block localhost...");
    assertContains((await fetchUrlContent("http://localhost:8080/admin"))[0]!.content, "Error", "Should block localhost");

    console.log("Test 11: @url — SSRF block 127.0.0.1...");
    assertContains((await fetchUrlContent("http://127.0.0.1/secret"))[0]!.content, "Error", "Should block loopback");

    console.log("Test 12: @url — SSRF block 192.168.x...");
    assertContains((await fetchUrlContent("http://192.168.1.1/admin"))[0]!.content, "Error", "Should block private IP");

    console.log("Test 13: @url — SSRF block 10.x...");
    assertContains((await fetchUrlContent("http://10.0.0.1/internal"))[0]!.content, "Error", "Should block 10.x");

    console.log("Test 14: @url — SSRF block 172.16.x...");
    assertContains((await fetchUrlContent("http://172.16.0.1/internal"))[0]!.content, "Error", "Should block 172.16.x");

    console.log("Test 15: @url — SSRF block 0.0.0.0...");
    assertContains((await fetchUrlContent("http://0.0.0.0/admin"))[0]!.content, "Error", "Should block 0.0.0.0");

    console.log("Test 16: @url — SSRF block .local...");
    assertContains((await fetchUrlContent("http://myapp.local/admin"))[0]!.content, "Error", "Should block .local");

    console.log("Test 17: @url — block file://...");
    assertContains((await fetchUrlContent("file:///etc/passwd"))[0]!.content, "Error", "Should block file://");

    console.log("Test 18: @url — invalid URL...");
    assertContains((await fetchUrlContent("not-a-url"))[0]!.content, "Error", "Should return error");

    // Rules
    console.log("Test 19: .clinerules — load project rules...");
    const rules = await loadProjectRules(TMP_DIR);
    assertEqual(rules.length, 3, "Should load 3 rules");
    assert(rules.some((r) => r.content.includes("TypeScript strict")), "Should have coding-style rule");
    assert(rules.some((r) => r.content.includes("Java 21")), "Should have spring rule");
    assert(rules.some((r) => r.content.includes("standalone components")), "Should have angular rule");

    console.log("Test 20: .clinerules — rules have correct source...");
    assert(rules.every((r) => r.source === "project"), "All should be project rules");

    console.log("Test 21: .clinerules — rulesToContextItems...");
    const items = rulesToContextItems(rules);
    assertEqual(items.length, 3, "Should create 3 context items");
    assert(items.every((i) => i.source === "project_rules"), "Source should be project_rules");

    console.log("Test 22: .clinerules — nested rules discovered...");
    // Use forward-slash-normalized check for cross-platform
    const normalizedPaths = rules.map((r) => r.filePath.replace(/\\/g, "/"));
    assert(normalizedPaths.some((p) => p.includes("backend/spring.md")), "Should find backend/spring.md");
    assert(normalizedPaths.some((p) => p.includes("frontend/angular.md")), "Should find frontend/angular.md");

    console.log("Test 23: Global rules...");
    const globalRules = await loadGlobalRules();
    // May be 0 — just verify no crash

    console.log("Test 24: loadAllRules merges...");
    const allRules = await loadAllRules(TMP_DIR);
    assert(allRules.length >= 3, "Should have at least project rules");

    // Security
    console.log("Test 25: Security — path traversal...");
    assert((await resolveFolder("src/../../etc", TMP_DIR))[0]!.content.includes("Error"), "Should block traversal");

    console.log("Test 26: Security — file path traversal...");
    assert((await resolveFile("../../etc/passwd", TMP_DIR))[0]!.content.includes("Error"), "Should block file traversal");

    console.log("Test 27: Security — SSRF comprehensive...");
    for (const bad of ["http://localhost:3000", "http://[::1]", "http://0.0.0.0:22"]) {
      const r = await fetchUrlContent(bad);
      assertContains(r[0]!.content, "Error", `Should block ${bad}`);
    }

    console.log("\n=== ALL 27 TESTS PASSED ✓ ===");

  } finally {
    await fs.rm(TMP_DIR, { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error("\n❌ FAILED:", err.message);
  process.exit(1);
});
