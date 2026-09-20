/**
 * M2 runtime integration tests: agent-runtime ↔ @codepilot/model-gateway.
 *
 * Verifies:
 *   - discoverOllamaModels() delegates to the model-gateway provider system
 *     and returns the runtime's ModelCapability shape;
 *   - when Ollama is unavailable it returns a provider-unavailable state ([])
 *     instead of crashing;
 *   - the canonical CodePilot flow (LOCAL → Ollama → qwen3:8b → Act mode →
 *     streaming → tool execution → completion) driven by a model resolved
 *     through the provider registry delivers exactly-once stream deltas,
 *     tool events and completions across three consecutive messages.
 *
 * The model layer is stubbed Ollama NDJSON (no network, no model); the
 * registry resolution, agent loop, tool dispatch, and event fan-out are
 * all genuine.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodePilotRuntime, discoverOllamaModels } from "./runtime.js";
import type { ModelCapability } from "./runtime.js";
import { OllamaProvider, ProviderRegistry } from "@codepilot/model-gateway";
import { stubOllamaFetch, type StubTurn } from "./ollama-fetch-stub.js";

const OLLAMA_URL = "http://localhost:11434";

function tagsResponse(): Response {
  return new Response(
    JSON.stringify({
      models: [
        {
          name: "qwen3:8b",
          model: "qwen3:8b",
          size: 5_200_000_000,
          details: { parameter_size: "8B", context_length: 32768 },
        },
        { name: "llama3.2:3b", model: "llama3.2:3b", size: 2_000_000_000 },
      ],
    }),
    { status: 200 },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeRuntime(modelId: string): CodePilotRuntime {
  return new CodePilotRuntime({
    workspaceRoot: process.cwd(),
    providerId: "ollama",
    modelId,
    agentMode: "act",
    // Tests play the permission pipeline: the gate path itself is covered
    // by M4 suites; here tools must reach execution.
    requestApproval: async () => ({ approved: true }),
  });
}

describe("discoverOllamaModels — M2 provider integration", () => {
  it("discovers models through @codepilot/model-gateway and maps capabilities", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tagsResponse()) as unknown as typeof fetch,
    );

    const models = await discoverOllamaModels(OLLAMA_URL);
    expect(models.map((m) => m.model).sort()).toEqual([
      "llama3.2:3b",
      "qwen3:8b",
    ]);

    const qwen = models.find((m) => m.model === "qwen3:8b");
    expect(qwen).toBeDefined();
    expect(qwen?.provider).toBe("ollama");
    expect(qwen?.toolCalling).toBe(true);
    expect(qwen?.streaming).toBe(true);
    expect(qwen?.reasoning).toBe(true);
    expect(qwen?.contextWindow).toBe(32768);
  });

  it("returns a provider-unavailable state ([]) instead of crashing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
      }) as unknown as typeof fetch,
    );
    const models = await discoverOllamaModels(OLLAMA_URL);
    expect(models).toEqual([]);
  });

  it("maps unknown capability values conservatively (never unknown coding)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              models: [{ name: "custom-model-x", model: "custom-model-x" }],
            }),
            { status: 200 },
          ),
      ) as unknown as typeof fetch,
    );
    const models = await discoverOllamaModels(OLLAMA_URL);
    const mapped: ModelCapability | undefined = models[0];
    expect(["good", "fair", "poor", "excellent"]).toContain(
      mapped?.codingCapability,
    );
    expect(mapped?.toolCalling).toBe(false);
  });
});

describe("CodePilotRuntime — canonical flow over a provider-resolved model", () => {
  it("runs 3 consecutive messages with exactly-once streaming and tools", async () => {
    // 1. Resolve the model through the M2 provider system.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tagsResponse()) as unknown as typeof fetch,
    );
    const registry = new ProviderRegistry();
    registry.register(
      new OllamaProvider({
        id: "ollama",
        name: "Ollama (Local)",
        type: "ollama",
        baseUrl: OLLAMA_URL,
        enabled: true,
      }),
    );
    const resolved = await registry.resolve("ollama", "qwen3:8b");
    expect(resolved?.model.capabilities.streaming).toBe(true);
    expect(resolved?.model.capabilities.tools).toBe(true);

    // 2. Run the canonical workflow with that model. Each session consumes
    // two scripted turns (deltas + a real read_files call, then a closing
    // text turn) through the genuine agent loop and tool dispatch.
    const sessionScript = (): StubTurn[] => [
      {
        texts: ["CodePilot is ", "an AI coding agent."],
        toolCalls: [{ name: "read_files", args: { path: "package.json" } }],
      },
      { texts: ["Done."] },
    ];
    const script: StubTurn[] = [
      ...sessionScript(),
      ...sessionScript(),
      ...sessionScript(),
    ];
    const stub = stubOllamaFetch(script);
    void stub;
    const runtime = makeRuntime(resolved!.model.id);
    const deltas: string[] = [];
    const toolStarts: string[] = [];
    const toolCompletes: string[] = [];
    let completed = 0;
    runtime.subscribe((event) => {
      if (event.type === "text_delta") deltas.push(event.text);
      if (event.type === "tool_started") toolStarts.push(event.toolCallId);
      if (event.type === "tool_completed") toolCompletes.push(event.toolCallId);
      if (event.type === "completed") completed += 1;
    });

    try {
      await runtime.initialize();
      await runtime.startSession("Hello");
      await runtime.startSession("Explain what CodePilot is.");
      await runtime.startSession(
        "Read package.json and tell me the project name.",
      );

      // Exactly-once: no duplicated chunks, no duplicated messages. Each
      // session streams its two scripted deltas plus one closing "Done.".
      expect(deltas).toEqual([
        "CodePilot is ",
        "an AI coding agent.",
        "Done.",
        "CodePilot is ",
        "an AI coding agent.",
        "Done.",
        "CodePilot is ",
        "an AI coding agent.",
        "Done.",
      ]);
      // Three real read_files executions, started and completed in pairs
      // with stable, unique synthesized call ids.
      expect(toolStarts).toHaveLength(3);
      expect(toolCompletes).toEqual(toolStarts);
      expect(new Set(toolStarts).size).toBe(3);
      expect(completed).toBe(3);
      expect(runtime.listenerCount()).toBe(1);
      // Tool-offering proof: the first Ollama request body offers the full
      // native model-facing set (including bash) as callable functions.
      const firstChat = stub.requests.find((r) => r.url.includes("/api/chat"));
      const offered = (
        (firstChat?.body as { tools?: Array<{ function?: { name?: string } }> })
          ?.tools ?? []
      )
        .map((t) => t.function?.name)
        .filter((n): n is string => typeof n === "string");
      for (const name of [
        "read_files",
        "search_codebase",
        "editor",
        "apply_patch",
        "run_commands",
        "bash",
        "skills",
        "ask_question",
      ]) {
        expect(
          offered,
          `native tool ${name} not offered to the model`,
        ).toContain(name);
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("resolves a DiscoveredModel into a runnable configuration contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tagsResponse()) as unknown as typeof fetch,
    );
    const registry = new ProviderRegistry();
    registry.register(
      new OllamaProvider({
        id: "ollama",
        name: "Ollama (Local)",
        type: "ollama",
        baseUrl: OLLAMA_URL,
        enabled: true,
      }),
    );
    const model = (await registry.resolve("ollama", "qwen3:8b"))?.model ?? null;
    expect(model?.id).toBe("qwen3:8b");
    expect(model?.capabilities.reasoning).toBe(true);
    expect(model?.capabilities.contextWindow).toBe(32768);
    registry.dispose();
  });
});
