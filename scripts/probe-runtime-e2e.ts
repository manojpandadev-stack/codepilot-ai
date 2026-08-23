/**
 * End-to-end probe of the FIXED CodePilotRuntime pipeline:
 * CodePilotRuntime.initialize() → startSession() → mapped AgentEvents
 * (started / text_delta / tool events / completed) against live Ollama.
 *
 * Run: pnpm exec tsx scripts/probe-runtime-e2e.ts
 */
import { CodePilotRuntime } from "../packages/agent-runtime/dist/index.js";

async function main(): Promise<void> {
  const workspaceRoot = process.cwd();
  const runtime = new CodePilotRuntime({
    workspaceRoot,
    providerId: "ollama",
    modelId: "qwen3:8b",
    baseUrl: "http://127.0.0.1:11434",
    privacyMode: "local",
    agentMode: "act",
    maxIterations: 3,
    temperature: 0.2,
  });

  const seen: string[] = [];
  let deltas = 0;
  let completedText = "";
  let errored: string | null = null;

  runtime.subscribe((event) => {
    seen.push(event.type);
    switch (event.type) {
      case "text_delta":
        deltas += 1;
        if (deltas <= 3) console.log(`[DELTA] ${JSON.stringify(event.text)}`);
        break;
      case "completed":
        completedText = event.result;
        break;
      case "error":
        errored = event.error;
        break;
      default:
        break;
    }
  });

  await runtime.initialize();
  console.log("[PROBE] runtime initialized");
  const sessionId = await runtime.startSession(
    "Hello. Respond with exactly:\nCodePilot AI is working.",
    { agentMode: "ask" }
  );
  console.log(`[PROBE] sessionId=${sessionId}`);
  console.log(`[PROBE] event sequence: ${seen.join(" -> ")}`);
  console.log(`[PROBE] deltas=${deltas}`);
  console.log(`[PROBE] completedText=${JSON.stringify(completedText.slice(0, 200))}`);
  if (errored) console.log(`[PROBE] ERROR=${errored.slice(0, 300)}`);

  const ok = deltas > 0 && completedText.length > 0 && !errored;
  console.log(ok ? "[PROBE] RESULT: PASS" : "[PROBE] RESULT: FAIL");
  await runtime.dispose();
  if (!ok) process.exit(1);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error("[PROBE] FATAL:", err);
    process.exit(1);
  }
);
