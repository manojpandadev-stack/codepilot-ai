/**
 * Empirical probe #2: exercises a TOOL CALL through real @cline/core + Ollama
 * to capture the exact event vocabulary for tool execution.
 *
 * Run: pnpm exec tsx scripts/probe-cline-tools.ts
 */
import { ClineCore } from "@cline/core";

async function main(): Promise<void> {
  console.log("[PROBE] Creating ClineCore...");
  const cline = await ClineCore.create({ clientName: "codepilot-probe", backendMode: "local" });

  cline.subscribe((event: Record<string, unknown>) => {
    const type = String(event.type);
    if (type === "chunk") return; // noisy duplicates of agent_event
    const payload = JSON.stringify(event.payload ?? {}).slice(0, 400);
    if (type === "agent_event") {
      const inner = (event.payload as { event?: { type?: string } })?.event;
      console.log(`[EVENT] agent_event inner=${inner?.type} payload=${payload}`);
    } else {
      console.log(`[EVENT] ${type} payload=${payload}`);
    }
  });

  console.log("[PROBE] Starting tool-call session...");
  const result = await cline.start({
    config: {
      providerId: "ollama",
      modelId: "qwen3:8b",
      baseUrl: "http://127.0.0.1:11434",
      mode: "zen",
      systemPrompt: "You are CodePilot AI. Use the available tools to answer.",
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      enableTools: true,
      enableSpawnAgent: false,
      enableAgentTeams: false,
      thinking: false,
      maxIterations: 5,
      temperature: 0.2,
    },
    source: "codepilot" as never,
    prompt: "Read package.json in the working directory and tell me the exact value of the \"name\" field. Use the read file tool.",
    interactive: true,
  } as unknown as Parameters<typeof cline.start>[0]);

  const res = (result as { result?: { text?: string } }).result;
  console.log(`[PROBE] FINAL TEXT: ${res?.text ?? "(none)"}`);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await cline.dispose();
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error("[PROBE] FATAL:", err);
    process.exit(1);
  }
);
