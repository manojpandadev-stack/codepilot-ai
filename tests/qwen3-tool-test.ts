/**
 * qwen3 Tool Calling Test with ClineCore
 * 
 * Run: node --experimental-strip-types --experimental-transform-types tests/qwen3-tool-test.ts
 */

import { ClineCore, createBuiltinTools } from "@cline/core";

async function main() {
  console.log("=== qwen3 Tool Calling Test ===\n");

  const fs = await import("node:fs/promises");
  const testFile = "test-qwen3-file.txt";
  await fs.writeFile(testFile, "Hello from qwen3 test!\nLine 2: Tool calling works.\n");
  console.log(`Created: ${testFile}`);

  const tools = createBuiltinTools({
    cwd: process.cwd(),
    enableBash: true,
    enableWebFetch: false,
  });
  console.log(`Tools: ${tools.map(t => t.name).join(", ")}\n`);

  const cline = await ClineCore.create({
    clientName: "codepilot-qwen3-test",
    backendMode: "local",
  });

  try {
    console.log("Starting session with qwen3:8b...");
    const result = await cline.start({
      config: {
        providerId: "ollama",
        modelId: "qwen3:8b",
        baseUrl: "http://localhost:11434",
        mode: "act",
        cwd: process.cwd(),
        workspaceRoot: process.cwd(),
        enableTools: true,
        enableSpawnAgent: false,
        enableAgentTeams: false,
        thinking: false,
        systemPrompt: "You are CodePilot AI. Use tools to help with tasks.",
      },
      localRuntime: {
        extraTools: tools,
      },
      source: "codepilot-qwen3-test",
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
          const tr = part as any;
          const out = typeof tr.content === "string" ? tr.content.slice(0, 300) : JSON.stringify(tr.content).slice(0, 300);
          console.log(`    tool-result: ${out}`);
        }
      }
    }
  } finally {
    await cline.dispose();
    await fs.unlink(testFile).catch(() => {});
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
