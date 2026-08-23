/**
 * Empirical probe: runs the REAL @cline/core against local Ollama (qwen3:8b)
 * to verify the actual event contract between ClineCore and CodePilotRuntime.
 *
 * Run: pnpm exec tsx scripts/probe-cline-ollama.ts
 */
import { ClineCore } from "@cline/core";

async function main(): Promise<void> {
  console.log("[PROBE] Creating ClineCore...");
  const cline = await ClineCore.create({ clientName: "codepilot-probe", backendMode: "local" });
  console.log("[PROBE] ClineCore created.");

  let eventCount = 0;
  const seenTypes = new Set<string>();
  cline.subscribe((event: Record<string, unknown>) => {
    eventCount += 1;
    const type = String(event.type);
    seenTypes.add(type);
    const payload = JSON.stringify(event.payload ?? {}).slice(0, 300);
    if (type === "agent_event") {
      const inner = (event.payload as { event?: { type?: string } })?.event;
      console.log(`[EVENT ${eventCount}] agent_event inner=${inner?.type} payload=${payload}`);
    } else {
      console.log(`[EVENT ${eventCount}] ${type} payload=${payload}`);
    }
  });
  console.log("[PROBE] Subscribed BEFORE start(). Calling start()...");

  const t0 = Date.now();
  const result = await cline.start({
    config: {
      providerId: "ollama",
      modelId: "qwen3:8b",
      baseUrl: "http://127.0.0.1:11434",
      mode: "zen",
      systemPrompt: "You are CodePilot AI, an expert software engineering assistant.",
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      enableTools: true,
      enableSpawnAgent: false,
      enableAgentTeams: false,
      thinking: false,
      maxIterations: 3,
      temperature: 0.7,
    },
    source: "codepilot" as never,
    prompt: "Hello. Respond with exactly:\nCodePilot AI is working.",
    interactive: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  const elapsedMs = Date.now() - t0;
  console.log(`[PROBE] start() resolved after ${elapsedMs}ms`);
  console.log(`[PROBE] result keys: ${Object.keys(result).join(", ")}`);
  const res = (result as { result?: unknown }).result;
  console.log(`[PROBE] result.result present: ${res !== undefined}`);
  if (res && typeof res === "object") {
    console.log(`[PROBE] result.result: ${JSON.stringify(res).slice(0, 400)}`);
  }

  // Give trailing events a moment to flush
  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log("[PROBE] DONE.");
  console.log(`[PROBE] total events received: ${eventCount}`);
  console.log(`[PROBE] top-level event types: ${[...seenTypes].join(", ")}`);
  await cline.dispose();
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error("[PROBE] FATAL:", err);
    process.exit(1);
  }
);
