/**
 * Simple Acceptance Test
 * 
 * Verifies the core workflow:
 *   1. Agent reads a file
 *   2. Agent creates a new file via tool call
 *   3. Agent reports results
 * 
 * Run: node --experimental-strip-types --experimental-transform-types tests/simple-acceptance.ts
 */

import { ClineCore, createBuiltinTools } from "@cline/core";
import * as fs from "node:fs/promises";
import * as path from "node:path";

async function main() {
  console.log("=== Simple Acceptance Test ===\n");

  const ws = path.resolve("test-simple-accept");
  await fs.mkdir(path.join(ws, "src"), { recursive: true });
  await fs.writeFile(path.join(ws, "src/App.java"), "package app;\npublic class App {\n    public static void main(String[] args) {\n        System.out.println(\"Hello\");\n    }\n}\n");
  console.log("Created workspace with App.java");

  const tools = createBuiltinTools({ cwd: ws, enableBash: true, enableWebFetch: false });
  const cline = await ClineCore.create({ clientName: "codepilot-simple", backendMode: "local" });

  try {
    console.log("\nStarting agent session with qwen3:8b...");
    const startTime = Date.now();

    const result = await cline.start({
      config: {
        providerId: "ollama", modelId: "qwen3:8b", baseUrl: "http://localhost:11434",
        mode: "act", cwd: ws, workspaceRoot: ws,
        enableTools: true, enableSpawnAgent: false, enableAgentTeams: false, thinking: false,
        systemPrompt: `You are CodePilot AI. Use tools to complete tasks. Working directory: ${ws}. Always use absolute file paths.`,
      },
      localRuntime: { extraTools: tools },
      source: "codepilot-simple",
      prompt: `Read the file ${path.join(ws, "src/App.java")} and then create a new file ${path.join(ws, "src/Utils.java")} with a utility class.`,
      interactive: true,
    } as any);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nSession completed in ${elapsed}s`);
    console.log(`Session ID: ${result.sessionId}`);

    if (result.result) {
      const res = result.result as any;
      console.log(`Output: ${(res.outputText ?? "N/A").slice(0, 300)}`);
      console.log(`Usage: ${JSON.stringify(res.usage ?? {})}`);
    }

    // Check messages
    const messages = await cline.readMessages(result.sessionId);
    console.log(`Total messages: ${messages.length}`);

    let toolCallCount = 0;
    let toolResultCount = 0;
    for (const msg of messages) {
      for (const part of msg.content) {
        if (part.type === "tool-use") toolCallCount++;
        if (part.type === "tool-result") toolResultCount++;
      }
    }
    console.log(`Tool calls: ${toolCallCount}, Tool results: ${toolResultCount}`);

    // Verify file operations
    const appContent = await fs.readFile(path.join(ws, "src/App.java"), "utf-8").catch(() => null);
    const utilsContent = await fs.readFile(path.join(ws, "src/Utils.java"), "utf-8").catch(() => null);

    console.log("\n=== RESULTS ===");
    console.log(`App.java exists: ${appContent !== null ? "✓" : "✗"}`);
    console.log(`Utils.java created: ${utilsContent !== null ? "✓" : "✗"}`);
    if (utilsContent) {
      console.log(`Utils.java content: ${utilsContent.slice(0, 200)}`);
    }

    const allPassed = appContent !== null && utilsContent !== null && toolCallCount > 0;
    console.log(`\nOverall: ${allPassed ? "✓ ACCEPTANCE TEST PASSED" : "✗ ACCEPTANCE TEST FAILED"}`);

  } finally {
    await cline.dispose();
    await fs.rm(ws, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(console.error);
