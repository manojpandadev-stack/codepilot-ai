/**
 * M16 — CodePilot CLI / headless mode (apps/cli entry point).
 *
 * Delegates to the existing @codepilot/agent-runtime CliRunner + TaskStore.
 * No second agent implementation. All permissions still flow through M4.
 */
import {
  CliRunner,
  parseCliCommand,
  cliHelpText,
  CLI_VERSION,
  CodePilotRuntime,
  TaskStore,
} from "@codepilot/agent-runtime";
import {
  BUILTIN_PROVIDER_DEFAULTS,
  getProviderCatalog,
  type CatalogProvider,
} from "@codepilot/model-gateway";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function taskStore(): TaskStore {
  const dir = path.join(
    process.env.XDG_DATA_HOME ??
      path.join(process.env.HOME ?? "", ".local", "share"),
    "codepilot",
    "tasks",
  );
  return new TaskStore(dir);
}

function taskStoreDir(): string {
  return path.join(
    process.env.XDG_DATA_HOME ??
      path.join(process.env.HOME ?? "", ".local", "share"),
    "codepilot",
    "tasks",
  );
}

function workspaceRoot(): string {
  return (
    process.env.CODEPILOT_WORKSPACE ??
    process.env.VSCODE_WORKSPACE_FOLDER_0 ??
    process.cwd()
  );
}

async function cmdRun(
  parsed: ReturnType<typeof parseCliCommand>,
  runner: CliRunner,
): Promise<number> {
  const prompt = parsed.args.join(" ");
  const timeoutMs = parsed.flags.timeout
    ? parseInt(parsed.flags.timeout as string, 10)
    : 0;
  const store = parsed.command === "task" ? taskStore() : undefined;
  const outputMode = parsed.flags.json ? "json" : "stream";
  const result = await runner.run(prompt, {
    timeoutMs,
    output: outputMode as "json" | "stream",
    store,
    collectEvents: true,
    onStreamEvent: (ev) => {
      if (outputMode === "json") {
        console.log(JSON.stringify({ type: ev.type, message: ev.message }));
      } else if (ev.type !== "status" || ev.message) {
        process.stdout.write((ev.message ?? "") + "\n");
      }
    },
  });
  if (parsed.flags.json) {
    console.log(
      JSON.stringify({
        exitCode: result.exitCode,
        output: result.output,
        sessionId: result.sessionId,
        taskId: result.taskId,
        durationMs: result.durationMs,
        error: result.error,
      }),
    );
  }
  return result.exitCode as 0 | 1 | 2 | 3 | 4 | 5;
}

/**
 * The runtime-configuration provider layer (BUILTIN_PROVIDER_DEFAULTS) uses two
 * ids that differ from the SDK catalogue ids. This is the complete mapping.
 */
const CATALOG_ID_SYNONYMS: Record<string, string> = {
  openai: "openai-native",
  google: "gemini",
};

function catalogEntryFor(id: string): CatalogProvider | undefined {
  const catalog = getProviderCatalog();
  const direct = catalog.find((p) => p.id === id);
  if (direct) return direct;
  const synonym = CATALOG_ID_SYNONYMS[id];
  return synonym ? catalog.find((p) => p.id === synonym) : undefined;
}

function displayNameOf(id: string, fallbackName: string): string {
  return catalogEntryFor(id)?.displayName ?? fallbackName;
}

async function cmdProviders(): Promise<number> {
  console.log("Built-in providers (first-class runtime configuration):");
  console.log("Provider\tName\t\tDefault Model");
  console.log("--------\t----\t\t-------------");
  let matched = 0;
  for (const [id, def] of Object.entries(BUILTIN_PROVIDER_DEFAULTS)) {
    const entry = catalogEntryFor(id);
    if (entry) matched += 1;
    const name = displayNameOf(id, def.name);
    const model =
      def.defaultModelId || entry?.defaultModelId || "(runtime discovery)";
    console.log(`${id}\t${name}\t\t${model}`);
  }
  const total = getProviderCatalog().length;
  console.log(
    `\n+ ${total - matched} additional providers from the SDK catalogue ` +
      `(any id routable by the runtime; see the VS Code provider selector) ` +
      `and any OpenAI-compatible endpoint via 'openai-compatible'.`,
  );
  console.log("\nUse 'codepilot run' to execute with the configured provider.");
  return 0;
}

async function cmdModels(): Promise<number> {
  console.log(
    "Default model per built-in provider (from the authoritative catalogue):",
  );
  for (const [id, def] of Object.entries(BUILTIN_PROVIDER_DEFAULTS)) {
    const entry = catalogEntryFor(id);
    const model =
      def.defaultModelId ||
      entry?.defaultModelId ||
      (entry?.models[0]?.id
        ? `${entry.models[0].id} (first catalogue entry)`
        : "(runtime discovery)");
    const count =
      entry && entry.models.length > 0
        ? ` (${entry.models.length} in catalogue)`
        : "";
    console.log(`${displayNameOf(id, def.name)}\t${model}${count}`);
  }
  console.log(
    "\nFull per-provider model lists: see the VS Code provider selector,\n" +
      "or query the provider's /models endpoint (live discovery for\n" +
      "OpenAI-compatible and local providers).",
  );
  return 0;
}

async function cmdTaskList(): Promise<number> {
  const store = taskStore();
  const tasks = await store.list();
  if (tasks.length === 0) {
    console.log("No tasks recorded.");
    return 0;
  }
  console.log("ID\tStatus\t\tTitle");
  console.log("--\t------\t\t-----");
  for (const t of tasks.slice(-20)) {
    const p =
      (t.title ?? "").length > 40
        ? (t.title ?? "").slice(0, 40) + "..."
        : (t.title ?? "");
    console.log(`${t.id}\t${t.status}\t${p}`);
  }
  return 0;
}

async function cmdTaskShow(taskId: string): Promise<number> {
  const store = taskStore();
  const task = await store.get(taskId);
  if (!task) {
    console.error(`Task not found: ${taskId}`);
    return 1;
  }
  console.log(JSON.stringify(task, null, 2));
  return 0;
}

async function cmdSessions(): Promise<number> {
  // Alias for task list
  return cmdTaskList();
}

async function cmdConfig(): Promise<number> {
  console.log("CodePilot CLI Configuration (env):");
  console.log(
    `  CODEPILOT_WORKSPACE = ${process.env.CODEPILOT_WORKSPACE ?? "(not set, uses cwd)"}`,
  );
  console.log(
    `  CODEPILOT_OLLAMA_URL = ${process.env.CODEPILOT_OLLAMA_URL ?? "http://localhost:11434"}`,
  );
  console.log(`  HOME = ${process.env.HOME ?? "(not set)"}`);
  console.log(`  Task store: ${taskStoreDir()}`);
  return 0;
}

function cmdVersion(): number {
  console.log(`codepilot-ai v${CLI_VERSION}`);
  return 0;
}

async function dispatch(argv: string[], runner: CliRunner): Promise<number> {
  const parsed = parseCliCommand(argv);
  if (parsed.exitCode !== null) {
    if (parsed.errorMessage) console.error(parsed.errorMessage);
    return parsed.exitCode;
  }
  switch (parsed.command) {
    case "run":
      return cmdRun(parsed, runner);
    case "task":
      // Subcommands: task list | task show <id> | task resume <id> | task <prompt>
      if (parsed.args.length === 0 || parsed.args[0] === "list")
        return cmdTaskList();
      if (parsed.args[0] === "show") return cmdTaskShow(parsed.args[1] ?? "");
      if (parsed.args[0] === "resume") {
        const store = taskStore();
        const result = await runner.resume(parsed.args[1] ?? "", {
          store,
          collectEvents: true,
          output: "stream",
          onStreamEvent: (ev) => {
            if (ev.message) process.stdout.write(ev.message + "\n");
          },
        });
        return result.exitCode as 0 | 1 | 2 | 3 | 4 | 5;
      }
      // task <prompt> — run with persistence
      return cmdRun(parsed, runner);
    case "resume": {
      const store = taskStore();
      const result = await runner.resume(parsed.args[0] ?? "", {
        store,
        collectEvents: true,
        output: "stream",
        onStreamEvent: (ev) => {
          if (ev.message) process.stdout.write(ev.message + "\n");
        },
      });
      return result.exitCode as 0 | 1 | 2 | 3 | 4 | 5;
    }
    case "models":
      return cmdModels();
    case "providers":
      return cmdProviders();
    case "sessions":
      return cmdSessions();
    case "config":
      return cmdConfig();
    case "version":
    case "--version":
    case "-v":
      return cmdVersion();
    case "help":
    case "--help":
    case "-h":
    default:
      console.log(cliHelpText());
      return 0;
  }
}

export async function runCli(argv: string[]): Promise<number> {
  const ws = workspaceRoot();
  const runtime = new CodePilotRuntime({
    workspaceRoot: ws,
    providerId: "ollama",
    modelId: "",
    apiKey: undefined,
    baseUrl: "",
    privacyMode: "local",
    agentMode: "act",
    maxIterations: 50,
    temperature: 0.7,
    onWriteProposal: async () => ({ changeSetId: "" }),
    requestApproval: async () => ({
      approved: false,
      reason: "CLI headless — approvals not available in non-interactive mode",
    }),
  });
  try {
    await runtime.initialize();
    return await dispatch(argv, new CliRunner(runtime));
  } finally {
    runtime.dispose();
  }
}

// When executed directly (not imported). Compares real paths because
// `new URL(import.meta.url).pathname` never matches on Windows (leading slash).
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
