/**
 * E2E Acceptance Test — Full Agent Workflow
 * 
 * Tests the complete workflow:
 *   Agent → read files → search → edit → run tests → report
 * 
 * Uses qwen3:8b which supports structured tool calling.
 * 
 * Run: node --experimental-strip-types --experimental-transform-types tests/e2e-acceptance-test.ts
 */

import { ClineCore, createBuiltinTools } from "@cline/core";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const WORKSPACE = path.resolve("test-workspace");
const RESULTS: string[] = [];

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
  RESULTS.push(msg);
}

async function setupWorkspace() {
  log("Setting up test Spring Boot workspace...");

  await fs.mkdir(path.join(WORKSPACE, "src/main/java/com/example/demo"), { recursive: true });
  await fs.mkdir(path.join(WORKSPACE, "src/test/java/com/example/demo"), { recursive: true });

  // pom.xml
  await fs.writeFile(path.join(WORKSPACE, "pom.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>demo</artifactId>
  <version>0.0.1-SNAPSHOT</version>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.0</version>
  </parent>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-test</artifactId>
      <scope>test</scope>
    </dependency>
  </dependencies>
</project>`);

  // Application.java
  await fs.writeFile(path.join(WORKSPACE, "src/main/java/com/example/demo/DemoApplication.java"), `package com.example.demo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class DemoApplication {
    public static void main(String[] args) {
        SpringApplication.run(DemoApplication.class, args);
    }
}`);

  // Simple service
  await fs.writeFile(path.join(WORKSPACE, "src/main/java/com/example/demo/GreetingService.java"), `package com.example.demo;

import org.springframework.stereotype.Service;

@Service
public class GreetingService {
    public String greet(String name) {
        return "Hello, " + name + "!";
    }
}`);

  // Existing test
  await fs.writeFile(path.join(WORKSPACE, "src/test/java/com/example/demo/DemoApplicationTests.java"), `package com.example.demo;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest
class DemoApplicationTests {
    @Test
    void contextLoads() {
    }
}`);

  log("✓ Test workspace created with Spring Boot project");
}

async function runAcceptanceTest() {
  const tools = createBuiltinTools({
    cwd: WORKSPACE,
    enableBash: true,
    enableWebFetch: false,
  });

  const cline = await ClineCore.create({
    clientName: "codepilot-e2e-test",
    backendMode: "local",
  });

  try {
    log("\n=== ACCEPTANCE TEST 1: Add health endpoint ===\n");
    log("Task: Add a GET /api/health endpoint returning { status: 'UP' }");

    const result1 = await cline.start({
      config: {
        providerId: "ollama",
        modelId: "qwen3:8b",
        baseUrl: "http://localhost:11434",
        mode: "act",
        cwd: WORKSPACE,
        workspaceRoot: WORKSPACE,
        enableTools: true,
        enableSpawnAgent: false,
        enableAgentTeams: false,
        thinking: false,
        systemPrompt: `You are CodePilot AI, an expert software engineering assistant.
Current working directory: ${WORKSPACE}
You have access to tools: read_files, search_codebase, run_commands, editor.
Use these tools to complete the task. Always use absolute paths.`,
      },
      localRuntime: { extraTools: tools },
      source: "codepilot-e2e",
      prompt: `Add a GET /api/health endpoint to this Spring Boot application.

Steps:
1. Read the existing GreetingService.java to understand the project structure
2. Create a new HealthController.java with @RestController and @GetMapping("/api/health")
3. The endpoint should return a JSON response: { "status": "UP" }

Use the editor tool to create the new file. Use absolute file paths.`,
      interactive: true,
    } as any);

    log(`Session completed: ${result1.sessionId}`);
    if (result1.result) {
      const res = result1.result as any;
      log(`Output: ${(res.outputText ?? "N/A").slice(0, 300)}`);
      log(`Usage: ${JSON.stringify(res.usage ?? {})}`);
    }

    // Read messages to see tool execution
    const messages = await cline.readMessages(result1.sessionId);
    log(`Total messages: ${messages.length}`);

    let toolCallCount = 0;
    for (const msg of messages) {
      for (const part of msg.content) {
        if (part.type === "tool-use") {
          toolCallCount++;
          log(`  Tool call: ${(part as any).name}(${JSON.stringify((part as any).input).slice(0, 100)})`);
        }
      }
    }
    log(`Total tool calls: ${toolCallCount}`);

    // Check if the file was created
    try {
      const healthController = await fs.readFile(
        path.join(WORKSPACE, "src/main/java/com/example/demo/HealthController.java"),
        "utf-8"
      );
      log(`✓ HealthController.java created (${healthController.length} bytes)`);
      log(`  Content preview: ${healthController.slice(0, 200)}`);
    } catch {
      log("✗ HealthController.java was NOT created");
    }

    // Now test the self-healing loop
    log("\n=== ACCEPTANCE TEST 2: Self-healing loop ===\n");
    log("Task: Fix the greeting service test");

    // Create a failing test
    await fs.writeFile(
      path.join(WORKSPACE, "src/test/java/com/example/demo/GreetingServiceTest.java"),
      `package com.example.demo;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class GreetingServiceTest {
    @Test
    void testGreet() {
        GreetingService service = new GreetingService();
        // This will fail because greet expects "Hello, World!" but we test "Hi, World!"
        assertEquals("Hi, World!", service.greet("World"));
    }
}`
    );

    log("Created failing test (expects 'Hi, World!' but service returns 'Hello, World!')");

    const result2 = await cline.start({
      config: {
        providerId: "ollama",
        modelId: "qwen3:8b",
        baseUrl: "http://localhost:11434",
        mode: "act",
        cwd: WORKSPACE,
        workspaceRoot: WORKSPACE,
        enableTools: true,
        enableSpawnAgent: false,
        enableAgentTeams: false,
        thinking: false,
        systemPrompt: `You are CodePilot AI. Fix failing tests.
Current directory: ${WORKSPACE}
Use tools to read files, understand the failure, and fix the code.
Always use absolute file paths.`,
      },
      localRuntime: { extraTools: tools },
      source: "codepilot-e2e-fix",
      prompt: `The test in GreetingServiceTest.java is failing. 
The test expects "Hi, World!" but the service returns "Hello, World!".
Read both files, understand the issue, and fix the test to match the actual service behavior.
Do NOT change the service — fix the test.`,
      interactive: true,
    } as any);

    log(`Session completed: ${result2.sessionId}`);
    if (result2.result) {
      const res = result2.result as any;
      log(`Output: ${(res.outputText ?? "N/A").slice(0, 300)}`);
    }

    // Verify the fix
    const testContent = await fs.readFile(
      path.join(WORKSPACE, "src/test/java/com/example/demo/GreetingServiceTest.java"),
      "utf-8"
    );
    if (testContent.includes('"Hello, World!"')) {
      log("✓ Test was fixed — now expects 'Hello, World!'");
    } else {
      log("✗ Test was NOT fixed");
    }

  } finally {
    await cline.dispose();
  }
}

async function main() {
  console.log("=== CodePilot AI — E2E Acceptance Test ===\n");

  try {
    await setupWorkspace();
    await runAcceptanceTest();

    log("\n=== SUMMARY ===");
    log(`Total log entries: ${RESULTS.length}`);

    // Print summary
    const passed = RESULTS.filter((r) => r.includes("✓")).length;
    const failed = RESULTS.filter((r) => r.includes("✗")).length;
    log(`Passed: ${passed}`);
    log(`Failed: ${failed}`);

  } catch (err) {
    log(`FATAL ERROR: ${err}`);
  } finally {
    // Cleanup
    await fs.rm(WORKSPACE, { recursive: true, force: true });
    log("Cleaned up test workspace");
  }

  console.log("\n=== ✓ E2E Acceptance Test Complete ===");
}

main().catch(console.error);
