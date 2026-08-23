/**
 * Tool Execution Test
 * 
 * Tests the agent runtime with file-reading tools enabled.
 * Verifies the full agent loop: prompt → model → tool call → result.
 * 
 * Run with: node --experimental-strip-types --experimental-transform-types tests/tool-execution-test.ts
 */

import { ClineCore } from "@cline/core";

async function main() {
  console.log("=== CodePilot AI — Tool Execution Test ===\n");

  // Create a temp test file
  const testFile = "test-file-for-agent.txt";
  const fs = await import("node:fs/promises");
  await fs.writeFile(testFile, "Hello from the test file!\nLine 2: CodePilot rocks.\n");
  console.log(`Created test file: ${testFile}\n`);

  const cline = await ClineCore.create({
    clientName: "codepilot-tool-test",
    backendMode: "local",
  });
  console.log("✓ ClineCore initialized");

  try {
    const result = await cline.start({
      config: {
        providerId: "ollama",
        modelId: "qwen2.5-coder:7b",
        baseUrl: "http://localhost:11434",
        mode: "act",
        cwd: process.cwd(),
        workspaceRoot: process.cwd(),
        enableTools: true,
        enableSpawnAgent: false,
        enableAgentTeams: false,
        thinking: false,
        systemPrompt: "You are CodePilot AI. Use available tools to help with tasks.",
      },
      source: "codepilot-tool-test",
      prompt: `Read the file ${testFile} and tell me what's on line 2.`,
      interactive: true,
    } as any);

    console.log("\n✓ Session completed");
    console.log(`  Session ID: ${result.sessionId}`);

    if (result.result) {
      const res = result.result as any;
      console.log(`  Output: ${res.outputText ?? "N/A"}`);
      console.log(`  Usage: ${JSON.stringify(res.usage ?? {})}`);
    }

    // Read messages to see tool calls
    const messages = await cline.readMessages(result.sessionId);
    console.log(`  Total messages: ${messages.length}`);
    for (const msg of messages) {
      for (const part of msg.content) {
        if (part.type === "text" && part.text && msg.role === "assistant") {
          console.log(`  [assistant] ${part.text.slice(0, 300)}`);
        }
        if (part.type === "tool-use") {
          console.log(`  [tool-call] ${JSON.stringify(part).slice(0, 200)}`);
        }
        if (part.type === "tool-result") {
          console.log(`  [tool-result] ${JSON.stringify(part).slice(0, 200)}`);
        }
      }
    }

  } finally {
    // Cleanup
    await cline.dispose();
    await fs.unlink(testFile).catch(() => {});
    console.log("\n✓ Cleanup done");
  }

  console.log("\n=== ✓ Tool Execution Test Complete ===");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
