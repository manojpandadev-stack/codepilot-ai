/**
 * qwen3 Tool Calling Test v2 - with absolute paths and detailed tracing
 * 
 * Run: node --experimental-strip-types --experimental-transform-types tests/qwen3-tool-test-v2.ts
 */

import { ClineCore, createBuiltinTools } from "@cline/core";
import * as path from "node:path";

async function main() {
  console.log("=== qwen3 Tool Calling Test v2 ===\n");

  const fs = await import("node:fs/promises");
  const testFile = path.resolve("test-qwen3-file.txt");
  await fs.writeFile(testFile, "Hello from qwen3 test!\nLine 2: Tool calling works.\n");
  console.log(`Created: ${testFile}`);

  const tools = createBuiltinTools({
    cwd: process.cwd(),
    enableBash: true,
    enableWebFetch: false,
  });
  console.log(`Tools: ${tools.map(t => t.name).join(", ")}\n`);

  const cline = await ClineCore.create({
    clientName: "codepilot-qwen3-v2",
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
        systemPrompt: `You are CodePilot AI. Use tools to help with tasks.
The current working directory is: ${process.cwd()}
Always use absolute file paths or paths relative to the working directory.`,
      },
      localRuntime: {
        extraTools: tools,
      },
      source: "codepilot-qwen3-v2",
      prompt: `Use the read_files tool to read this file: ${testFile}`,
      interactive: true,
    } as any);

    console.log("\n✓ Session completed");
    if (result.result) {
      const res = result.result as any;
      console.log(`  Output: ${res.outputText ?? "N/A"}`);
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
          console.log(`    tool-call: ${(part as any).name}(${JSON.stringify((part as any).input).slice(0, 200)})`);
        }
        if (part.type === "tool-result") {
          const out = typeof (part as any).content === "string" 
            ? (part as any).content.slice(0, 300) 
            : JSON.stringify((part as any).content).slice(0, 300);
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
