/**
 * P0-2.1 production-wiring regression tests.
 *
 * TASK A — H2 credential boundary. The redaction FLAG lives in the loop
 * (agent-loop.ts), but the CLASSIFICATION lives in the host callers:
 *   - CodePilotRuntime.startSession  → sessions.run config
 *   - CodePilotAgent.execute         → runAgentLoop options
 *   - NativeSessionManager.run       → forwards the flag verbatim
 * These tests prove the full production paths, not just the loop:
 *   - a remote provider receives REDACTED tool output on the next request
 *   - a local provider keeps the verbatim behavior (unchanged)
 *   - an explicit host override wins in either direction
 *   - UI events stay verbatim (redaction is wire-only)
 *
 * TASK B — Phase 7 output-budget limits. Explicit host config → curated
 * model catalogue → absent (the loop's documented default cap). Real model
 * limits must reach provider.stream({maxTokens}) through both production
 * callers, output must stay bounded, and an exhausted context must fail
 * closed WITHOUT a provider request.
 *
 * Synthetic markers only (sk-fake-…, hunter2-fake-…) — never real secrets.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodePilotRuntime, resolveModelLimits } from "./runtime.js";
import { CodePilotAgent } from "./agent.js";
import { NativeSessionManager } from "./native/engine/session.js";
import { buildChildAgentConfig } from "./orchestrator.js";
import type { NativeSessionConfig } from "./native/engine/session.js";
import type { AgentTool } from "./native/types.js";
import type {
  AgentEvent,
  CodePilotAgentConfig,
  CodePilotRuntimeOptions,
} from "./types.js";

const SECRET_OUTPUT =
  "db_url=postgres://bob@db.internal:5432/app\n" +
  "db password = hunter2-fake-pw\n" +
  "api_key = sk-fake-secret-12345678\nuser=bob";

function readerTool(): AgentTool {
  return {
    name: "reader",
    description: "returns config",
    inputSchema: {},
    execute: async () => SECRET_OUTPUT,
  } as AgentTool;
}

const approveAll = async () => ({ approved: true as const });

afterEach(() => {
  vi.unstubAllGlobals();
});

// ============================================================================
// Fetch stubs — every request body is captured on the wire
// ============================================================================

function sseBody(...chunks: unknown[]): Response {
  const lines = chunks.map((c) => `data: ${JSON.stringify(c)}`);
  return new Response([...lines, "data: [DONE]", ""].join("\n"), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function ollamaLine(line: unknown): string {
  return JSON.stringify(line);
}

/** OpenAI-compatible SSE stub: turn 1 → tool call, turn 2 → final answer. */
function stubOpenAiChat(): { chatBodies: Array<Record<string, unknown>> } {
  const chatBodies: Array<Record<string, unknown>> = [];
  let calls = 0;
  const fetchImpl = vi.fn(async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    if (!url.includes("/chat/completions")) {
      return new Response("{}", { status: 200 });
    }
    chatBodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
    calls += 1;
    if (calls === 1) {
      return sseBody(
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    function: { name: "reader", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      );
    }
    return sseBody({
      choices: [{ delta: { content: "done" }, finish_reason: "stop" }],
    });
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchImpl);
  return { chatBodies };
}

/** Ollama NDJSON stub: turn 1 → tool call, turn 2 → final answer. */
function stubOllamaChat(): { chatBodies: Array<Record<string, unknown>> } {
  const chatBodies: Array<Record<string, unknown>> = [];
  let calls = 0;
  const fetchImpl = vi.fn(async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    if (url.includes("/api/tags")) {
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }
    chatBodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
    calls += 1;
    const lines =
      calls === 1
        ? [
            ollamaLine({
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{ function: { name: "reader", arguments: {} } }],
              },
              done: false,
            }),
            ollamaLine({
              message: { role: "assistant", content: "" },
              done: true,
              prompt_eval_count: 3,
              eval_count: 3,
            }),
          ]
        : [
            ollamaLine({
              message: { role: "assistant", content: "done" },
              done: false,
            }),
            ollamaLine({
              message: { role: "assistant", content: "" },
              done: true,
              prompt_eval_count: 3,
              eval_count: 3,
            }),
          ];
    return new Response(lines.join("\n") + "\n", { status: 200 });
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchImpl);
  return { chatBodies };
}

function toolMessage(body: Record<string, unknown>):
  | {
      content: string;
    }
  | undefined {
  const messages = body.messages as
    Array<{ role?: string; content?: unknown }> | undefined;
  const tool = messages?.find((m) => m.role === "tool");
  const content = tool?.content;
  return typeof content === "string" ? { content } : undefined;
}

// ============================================================================
// TASK B · resolveModelLimits — pure classification of model metadata
// ============================================================================

describe("resolveModelLimits (explicit → catalogue → absent)", () => {
  it("explicit config wins over the catalogue", () => {
    expect(
      resolveModelLimits("openai-native", "gpt-4o", {
        modelContextWindow: 4096,
        maxOutputTokens: 512,
      }),
    ).toEqual({ contextWindow: 4096, maxOutputTokens: 512 });
  });

  it("falls back to the curated catalogue when no explicit config exists", () => {
    expect(resolveModelLimits("openai-native", "gpt-4o")).toEqual({
      contextWindow: 128000,
      maxOutputTokens: 16384,
    });
    // Legacy id → canonical catalogue entry; models without a curated
    // max-output entry contribute ONLY their window.
    expect(resolveModelLimits("google", "gemini-2.5-flash")).toEqual({
      contextWindow: 1048576,
    });
    expect(resolveModelLimits("ollama", "qwen3:8b")).toEqual({
      contextWindow: 32768,
    });
  });

  it("treats invalid or missing metadata as absent — limits are never invented", () => {
    // Invalid explicit values are ignored and the catalogue still applies.
    expect(
      resolveModelLimits("openai-native", "gpt-4o", {
        modelContextWindow: 0,
        maxOutputTokens: -1,
      }),
    ).toEqual({ contextWindow: 128000, maxOutputTokens: 16384 });
    // Unknown model / unknown provider → nothing is fabricated.
    expect(resolveModelLimits("openai-native", "not-a-real-model")).toEqual({});
    expect(resolveModelLimits("unknown-provider", "some-model")).toEqual({});
  });
});

// ============================================================================
// TASK A · NativeSessionManager — forwards the classification verbatim
// ============================================================================

function sessionConfig(
  overrides: Partial<NativeSessionConfig> = {},
): NativeSessionConfig {
  return {
    providerId: "openai-native",
    modelId: "gpt-4o",
    apiKey: "sk-test-key",
    tools: [readerTool()],
    gate: async () => ({ approved: true }),
    maxIterations: 4,
    ...overrides,
  };
}

async function runSession(config: NativeSessionConfig, prompt: string) {
  const { chatBodies } = stubOpenAiChat();
  const mgr = new NativeSessionManager(
    [{ providerId: "openai-native", apiKey: "sk-test-key" }],
    // fetchImpl seam: the provider hits the stubbed global fetch above.
    undefined,
  );
  mgr.create("s1", config);
  const result = await mgr.run("s1", config, prompt, () => {});
  return { result, chatBodies };
}

describe("A · NativeSessionManager redaction/limit forwarding", () => {
  it("redactToolResults:true scrubs secret spans from the NEXT wire request", async () => {
    const { result, chatBodies } = await runSession(
      sessionConfig({ redactToolResults: true }),
      "read the config",
    );
    expect(result.reason).toBe("complete");
    expect(chatBodies).toHaveLength(2);
    const wire = JSON.stringify(chatBodies[1]);
    expect(wire).toContain("[REDACTED]");
    expect(wire).not.toContain("sk-fake-secret-12345678");
    expect(wire).not.toContain("hunter2-fake-pw");
    // Non-secret context survives span-preserving redaction.
    expect(wire).toContain("user=bob");
  });

  it("unset preserves the local verbatim behavior end to end", async () => {
    const { result, chatBodies } = await runSession(
      sessionConfig(),
      "read the config",
    );
    expect(result.reason).toBe("complete");
    const wire = JSON.stringify(chatBodies[1]);
    expect(wire).toContain("sk-fake-secret-12345678");
    expect(wire).toContain("hunter2-fake-pw");
  });

  it("configured model limits reach the provider stream request", async () => {
    const { result, chatBodies } = await runSession(
      sessionConfig({ modelContextWindow: 131072, maxOutputTokens: 2048 }),
      "hi",
    );
    expect(result.reason).toBe("complete");
    expect(chatBodies[0]?.model).toBe("gpt-4o");
    expect(chatBodies[0]?.max_tokens).toBe(2048);
    expect(chatBodies[1]?.max_tokens).toBe(2048);
  });

  it("no model metadata → the documented default cap (8192), never the window", async () => {
    const { result, chatBodies } = await runSession(sessionConfig(), "hi");
    expect(result.reason).toBe("complete");
    expect(chatBodies[0]?.max_tokens).toBe(8192);
  });

  it("exhausted context fails closed WITHOUT any provider request", async () => {
    const { result, chatBodies } = await runSession(
      sessionConfig({ modelContextWindow: 8192 }),
      "x".repeat(200 * 1024),
    );
    expect(result.reason).toBe("error");
    expect(result.error).toMatch(/Context limit reached/);
    expect(chatBodies).toHaveLength(0);
  });
});

// ============================================================================
// TASK A · CodePilotAgent — classification happens in execute()
// ============================================================================

function agentConfig(
  overrides: Partial<CodePilotAgentConfig> = {},
): CodePilotAgentConfig {
  return {
    workspaceRoot: process.cwd(),
    providerId: "openai-native",
    modelId: "gpt-4o",
    apiKey: "sk-test-key",
    privacyMode: "cloud",
    agentMode: "act",
    requestApproval: approveAll,
    extraTools: [readerTool()],
    ...overrides,
  };
}

async function runAgent(
  config: CodePilotAgentConfig,
  prompt = "read the config",
) {
  const { chatBodies } =
    config.providerId === "ollama" ? stubOllamaChat() : stubOpenAiChat();
  const agent = new CodePilotAgent(config);
  await agent.initialize();
  const result = await agent.run(prompt);
  await agent.dispose?.();
  return { result, chatBodies };
}

describe("A · CodePilotAgent redaction (default classification)", () => {
  it("remote provider → redacted tool output on the next request (no explicit flag)", async () => {
    const { result, chatBodies } = await runAgent(agentConfig());
    expect(result.reason).toBe("complete");
    expect(chatBodies).toHaveLength(2);
    const wire = JSON.stringify(chatBodies[1]);
    expect(wire).toContain("[REDACTED]");
    expect(wire).not.toContain("sk-fake-secret-12345678");
    expect(wire).not.toContain("hunter2-fake-pw");
    expect(wire).toContain("user=bob");
  });

  it("remote provider → catalogue model limits reach the wire on this path too", async () => {
    const { chatBodies } = await runAgent(agentConfig());
    expect(chatBodies[0]?.max_tokens).toBe(16384); // gpt-4o catalogue
  });

  it("an explicit redactToolResults:false host override wins", async () => {
    const { result, chatBodies } = await runAgent(
      agentConfig({ redactToolResults: false }),
    );
    expect(result.reason).toBe("complete");
    expect(JSON.stringify(chatBodies[1])).toContain("sk-fake-secret-12345678");
  });

  it("local loopback provider → verbatim output (local behavior preserved)", async () => {
    const { chatBodies } = await runAgent(
      agentConfig({
        providerId: "ollama",
        modelId: "qwen3:8b",
        apiKey: undefined,
        baseUrl: "http://localhost:11434",
        privacyMode: "local",
      }),
    );
    expect(chatBodies).toHaveLength(2);
    const tool = toolMessage(chatBodies[1]!);
    expect(tool?.content).toContain("sk-fake-secret-12345678");
  });
});

// ============================================================================
// TASK A + B · CodePilotRuntime — the production host path
// ============================================================================

async function runRuntime(
  overrides: Partial<CodePilotRuntimeOptions> = {},
  prompt = "read the config",
) {
  const options: CodePilotRuntimeOptions = {
    workspaceRoot: process.cwd(),
    providerId: "openai-native",
    modelId: "gpt-4o",
    apiKey: "sk-test-key",
    privacyMode: "cloud",
    agentMode: "act",
    requestApproval: approveAll,
    extraTools: [readerTool()],
    ...overrides,
  };
  const events: AgentEvent[] = [];
  const runtime = new CodePilotRuntime(options);
  runtime.subscribe((event) => events.push(event));
  await runtime.initialize();
  let error: unknown;
  try {
    await runtime.startSession(prompt);
  } catch (err) {
    error = err;
  }
  await runtime.dispose().catch(() => undefined);
  return { events, error };
}

describe("A · CodePilotRuntime redaction (default classification)", () => {
  it("remote provider → wire redacted while the UI tool_completed event stays verbatim", async () => {
    const { chatBodies } = stubOpenAiChat();
    const events: AgentEvent[] = [];
    const runtime = new CodePilotRuntime({
      workspaceRoot: process.cwd(),
      providerId: "openai-native",
      modelId: "gpt-4o",
      apiKey: "sk-test-key",
      privacyMode: "cloud",
      agentMode: "act",
      requestApproval: approveAll,
      extraTools: [readerTool()],
    });
    runtime.subscribe((event) => events.push(event));
    await runtime.initialize();
    await runtime.startSession("read the config");
    await runtime.dispose().catch(() => undefined);

    expect(chatBodies).toHaveLength(2);
    const wire = JSON.stringify(chatBodies[1]);
    expect(wire).toContain("[REDACTED]");
    expect(wire).not.toContain("sk-fake-secret-12345678");
    expect(wire).not.toContain("hunter2-fake-pw");
    expect(wire).toContain("user=bob");

    // UI presentation is NOT redacted — only the persisted wire content is.
    const completed = events.find(
      (e) => e.type === "tool_completed" && e.toolName === "reader",
    );
    expect(completed).toBeDefined();
    expect(
      completed?.type === "tool_completed" ? completed.output : undefined,
    ).toContain("sk-fake-secret-12345678");
  });

  it("local provider → verbatim output on the wire", async () => {
    const { chatBodies } = stubOllamaChat();
    const runtime = new CodePilotRuntime({
      workspaceRoot: process.cwd(),
      providerId: "ollama",
      modelId: "qwen3:8b",
      agentMode: "act",
      requestApproval: approveAll,
      extraTools: [readerTool()],
    });
    await runtime.initialize();
    await runtime.startSession("read the config");
    await runtime.dispose().catch(() => undefined);

    expect(chatBodies).toHaveLength(2);
    const tool = toolMessage(chatBodies[1]!);
    expect(tool?.content).toContain("sk-fake-secret-12345678");
    expect(tool?.content).toContain("hunter2-fake-pw");
  });

  it("explicit redactToolResults:true forces redaction even for a local provider", async () => {
    const { chatBodies } = stubOllamaChat();
    const runtime = new CodePilotRuntime({
      workspaceRoot: process.cwd(),
      providerId: "ollama",
      modelId: "qwen3:8b",
      agentMode: "act",
      redactToolResults: true,
      requestApproval: approveAll,
      extraTools: [readerTool()],
    });
    await runtime.initialize();
    await runtime.startSession("read the config");
    await runtime.dispose().catch(() => undefined);

    const wire = JSON.stringify(chatBodies[1]);
    expect(wire).toContain("[REDACTED]");
    expect(wire).not.toContain("sk-fake-secret-12345678");
  });
});

describe("B · CodePilotRuntime model limits reaching the wire", () => {
  it("curated catalogue limits reach the provider request (gpt-4o → 16384)", async () => {
    const { chatBodies } = stubOpenAiChat();
    const { error } = await runRuntime({});
    expect(error).toBeUndefined();
    expect(chatBodies.length).toBeGreaterThan(0);
    for (const body of chatBodies) {
      expect(body.max_tokens).toBe(16384);
      expect(body.model).toBe("gpt-4o");
    }
  });

  it("explicit config wins over the catalogue", async () => {
    const { chatBodies } = stubOpenAiChat();
    const { error } = await runRuntime({
      modelContextWindow: 65536,
      maxOutputTokens: 2048,
    });
    expect(error).toBeUndefined();
    expect(chatBodies[0]?.max_tokens).toBe(2048);
  });

  it("missing model metadata → documented default 8192 (never invented)", async () => {
    const { chatBodies } = stubOpenAiChat();
    const { error } = await runRuntime({ modelId: "my-custom-model" });
    expect(error).toBeUndefined();
    expect(chatBodies[0]?.max_tokens).toBe(8192);
  });

  it("exhausted context fails safely before any provider request", async () => {
    const { chatBodies } = stubOpenAiChat();
    const { error } = await runRuntime(
      { modelContextWindow: 8192 },
      "x".repeat(200 * 1024),
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Context limit reached/);
    expect(chatBodies).toHaveLength(0);
  });
});

// ============================================================================
// A/B · orchestrator child agents — explicit overrides must travel
// ============================================================================

describe("orchestrator child config inherits the H2/Phase 7 overrides", () => {
  const base = {
    providerId: "openai-native",
    modelId: "gpt-4o",
    apiKey: "sk-test-key",
    workspaceRoot: process.cwd(),
    privacyMode: "cloud" as const,
    requestApproval: approveAll,
  };

  it("forwards explicit redaction and model-limit overrides to the child agent", () => {
    const child = buildChildAgentConfig(
      {
        ...base,
        redactToolResults: true,
        modelContextWindow: 65_536,
        maxOutputTokens: 2_048,
      },
      "coder",
      "act",
    );
    expect(child.redactToolResults).toBe(true);
    expect(child.modelContextWindow).toBe(65_536);
    expect(child.maxOutputTokens).toBe(2_048);
  });

  it("omits unset overrides so the child keeps the canonical classification default", () => {
    const child = buildChildAgentConfig(base, "coder", "act");
    expect(child.redactToolResults).toBeUndefined();
    expect(child.modelContextWindow).toBeUndefined();
    expect(child.maxOutputTokens).toBeUndefined();
    // providerId/baseUrl travel — the classification input must not be lost.
    expect(child.providerId).toBe("openai-native");
    expect(child.baseUrl).toBeUndefined();
  });
});
