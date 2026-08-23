/**
 * Tool Execution Test v2
 * 
 * Tests agent with explicit builtin tools passed via localRuntime.extraTools
 * 
 * Run with: node --experimental-strip-types --experimental-transform-types tests/tool-execution-test-v2.ts
 */

import { ClineCore, createBuiltinTools } from "@cline/core";

async function main() {
  console.log("=== CodePilot AI — Tool Execution Test v2 ===\n");

  const fs = await import("node:fs/promises");
  const testFile = "test-file-for-agent.txt";
  await fs.writeFile(testFile, "Hello from the test file!\nLine 2: CodePilot rocks.\n");
  console.log(`Created test file: ${testFile}\n`);

  // Create builtin tools with executors
  const tools = createBuiltinTools({
    cwd: process.cwd(),
    enableBash: true,
    enableWebFetch: false,
  });
  console.log(`Created ${tools.length} builtin tools: ${tools.map(t => t.name).join(", ")}\n`);

  const cline = await ClineCore.create({
    clientName: "codepilot-tool-test-v2",
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
      localRuntime: {
        extraTools: tools,
      },
      source: "codepilot-tool-test-v2",
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

    // Read all messages to see tool calls and results
    const messages = await cline.readMessages(result.sessionId);
    console.log(`  Total messages: ${messages.length}`);
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      console.log(`\n  [msg ${i + 1}] role=${msg.role}`);
      for (const part of msg.content) {
        if (part.type === "text" && part.text) {
          console.log(`    text: ${part.text.slice(0, 500)}`);
        }
        if (part.type === "tool-use") {
          const toolUse = part as any;
          console.log(`    tool-call: ${toolUse.name}(${JSON.stringify(toolUse.input).slice(0, 200)})`);
        }
        if (part.type === "tool-result") {
          const toolResult = part as any;
          const outputStr = typeof toolResult.content === "string" 
            ? toolResult.content.slice(0, 300) 
            : JSON.stringify(toolResult.content).slice(0, 300);
          console.log(`    tool-result: ${outputStr}`);
        }
      }
    }

  } finally {
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
