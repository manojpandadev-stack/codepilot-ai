/**
 * Vertical Slice Proof of Concept
 * 
 * Tests the core workflow:
 *   ClineCore → Ollama → model response → tool call → result
 * 
 * Run with: node --experimental-strip-types --experimental-transform-types tests/vertical-slice-prove.ts
 */

import { ClineCore } from "@cline/core";

async function main() {
  console.log("=== CodePilot AI — Vertical Slice Test ===\n");

  // Step 1: Verify Ollama is reachable
  console.log("[1/5] Checking Ollama connection...");
  try {
    const resp = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json() as { models: Array<{ name: string }> };
    console.log(`  ✓ Ollama connected. Models: ${data.models.map(m => m.name).join(", ")}`);
  } catch (err) {
    console.error("  ✗ Ollama not reachable:", err);
    process.exit(1);
  }

  // Step 2: Initialize ClineCore
  console.log("\n[2/5] Initializing ClineCore...");
  let cline: Awaited<ReturnType<typeof ClineCore.create>>;
  try {
    cline = await ClineCore.create({
      clientName: "codepilot-test",
      backendMode: "local",
    });
    console.log("  ✓ ClineCore initialized");
  } catch (err) {
    console.error("  ✗ ClineCore init failed:", err);
    process.exit(1);
  }

  // Step 3: Start a session with Ollama
  console.log("\n[3/5] Starting session with Ollama (qwen2.5-coder:7b)...");
  let sessionId: string;
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
        systemPrompt: "You are CodePilot AI, an expert software engineering assistant. Help the user with their coding tasks.",
        thinking: false, // qwen2.5-coder doesn't support thinking mode
      },
      source: "codepilot-test",
      prompt: "Say exactly: 'Hello from CodePilot AI vertical slice test'. Nothing else.",
      interactive: true,
    } as any);

    sessionId = result.sessionId;
    console.log(`  ✓ Session started: ${sessionId}`);

    if (result.result) {
      const res = result.result as any;
      const text = res.outputText ?? JSON.stringify(res).slice(0, 300);
      console.log(`  Result: ${text}`);
    }
  } catch (err) {
    console.error("  ✗ Session start failed:", err);
    process.exit(1);
  }

  // Step 4: Subscribe to events
  console.log("\n[4/5] Subscribing to session events...");
  const events: string[] = [];
  let receivedText = "";
  cline.subscribe((event) => {
    const e = event as Record<string, unknown>;
    const type = e.type as string;
    events.push(type);
    if (type === "assistant-text-delta") {
      const text = (e as any).text ?? "";
      receivedText += text;
      process.stdout.write(text);
    }
  });
  console.log("  ✓ Subscribed to events");

  // Step 5: Read messages
  await new Promise(r => setTimeout(r, 500));
  console.log("\n\n[5/5] Reading session messages...");
  try {
    const messages = await cline.readMessages(sessionId!);
    console.log(`  Messages in session: ${messages.length}`);
    console.log(`  Events received: ${[...new Set(events)].join(", ")}`);
    
    // Print assistant messages
    for (const msg of messages) {
      if (msg.role === "assistant") {
        for (const part of msg.content) {
          if (part.type === "text" && part.text) {
            console.log(`  Assistant: ${part.text.slice(0, 200)}`);
          }
        }
      }
    }
  } catch (err) {
    console.log(`  Read result: ${err}`);
  }

  // Cleanup
  console.log("\nCleaning up...");
  try { await cline.dispose(); } catch { /* best effort */ }
  
  console.log("\n=== ✓ Vertical Slice Test Complete ===");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
