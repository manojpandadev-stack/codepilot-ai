/**
 * GoogleLlmProvider regression tests — output-token budget.
 *
 * Root cause under test: the Gemini adapter did not forward `request.maxTokens`
 * into `generationConfig.maxOutputTokens`. Without an explicit bound, Gemini's
 * credit pre-check imputes the model's full context window as output and rejects
 * with "insufficient credits" even for tiny prompts.
 *
 * Every request must carry an explicit `maxOutputTokens` derived from the
 * agent loop's bounded budget (default 8192) — never the context window.
 */
import { describe, expect, it } from "vitest";
import { GoogleLlmProvider, toGeminiContents } from "./google.js";
import type { LlmRequest, LlmStreamEvent } from "./types.js";

function capturingProvider(
  bodyCaptured: Record<string, unknown>[],
  rawBodies?: string[],
) {
  return new GoogleLlmProvider({
    apiKey: "test-key",
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.body) {
        if (rawBodies) rawBodies.push(init.body as string);
        bodyCaptured.push(JSON.parse(init.body as string));
      }
      // Return a minimal valid SSE stream that the provider can parse to completion.
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ candidates: [{ content: { parts: [] } }] })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, statusText: "OK" });
    }) as typeof fetch,
  }) as unknown as {
    stream(request: LlmRequest): AsyncIterable<LlmStreamEvent>;
  };
}

function baseRequest(maxTokens?: number): LlmRequest {
  return {
    providerId: "google",
    modelId: "gemini-2.5-flash",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    temperature: 0.3,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

async function consumeStream(
  provider: unknown,
  request: LlmRequest,
): Promise<void> {
  const stream = (
    provider as { stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> }
  ).stream(request);
  for await (const _evt of stream) {
    // consume all events
  }
}

describe("GoogleLlmProvider — output-token budget", () => {
  it("forwards maxTokens as maxOutputTokens in generationConfig", async () => {
    const bodies: Record<string, unknown>[] = [];
    const provider = capturingProvider(bodies);
    await consumeStream(provider, baseRequest(8192));
    expect(bodies).toHaveLength(1);
    const genConfig = bodies[0]!.generationConfig as Record<string, unknown>;
    expect(genConfig.maxOutputTokens).toBe(8192);
    expect(genConfig.temperature).toBe(0.3);
  });

  it("omits maxOutputTokens when maxTokens is undefined", async () => {
    const bodies: Record<string, unknown>[] = [];
    const provider = capturingProvider(bodies);
    await consumeStream(provider, baseRequest());
    expect(bodies).toHaveLength(1);
    const genConfig = bodies[0]!.generationConfig as Record<string, unknown>;
    expect(genConfig.maxOutputTokens).toBeUndefined();
    expect(genConfig.temperature).toBe(0.3);
  });

  it("includes generationConfig when only maxTokens is set (no temperature)", async () => {
    const bodies: Record<string, unknown>[] = [];
    const provider = capturingProvider(bodies);
    const req = baseRequest(4096);
    delete req.temperature;
    await consumeStream(provider, req);
    expect(bodies).toHaveLength(1);
    const genConfig = bodies[0]!.generationConfig as Record<string, unknown>;
    expect(genConfig.maxOutputTokens).toBe(4096);
    expect(genConfig.temperature).toBeUndefined();
  });

  it("verifies the raw serialized HTTP request contains generationConfig.maxOutputTokens matching bounded maxTokens", async () => {
    const bodies: Record<string, unknown>[] = [];
    const rawBodies: string[] = [];
    const provider = capturingProvider(bodies, rawBodies);
    await consumeStream(provider, baseRequest(8192));
    expect(rawBodies).toHaveLength(1);
    const rawJson = rawBodies[0]!;
    expect(rawJson).toContain('"generationConfig"');
    expect(rawJson).toContain('"maxOutputTokens":8192');
    const parsed = JSON.parse(rawJson);
    expect(parsed.generationConfig.maxOutputTokens).toBe(8192);
  });

  it("settles request lifecycle on failure and allows a subsequent request to run successfully", async () => {
    let shouldFail = true;
    const provider = new GoogleLlmProvider({
      apiKey: "test-key",
      fetchImpl: async () => {
        if (shouldFail) {
          return new Response(
            JSON.stringify({ error: { message: "Gemini quota exceeded" } }),
            {
              status: 429,
              statusText: "Too Many Requests",
            },
          );
        }
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  candidates: [
                    { content: { parts: [{ text: "recovered text" }] } },
                  ],
                })}\n\n`,
              ),
            );
            controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, statusText: "OK" });
      },
    });

    // Turn 1: provider failure occurs (HTTP 429)
    await expect(async () => {
      for await (const _evt of provider.stream(baseRequest(2048))) {
        // consume
      }
    }).rejects.toThrow(/generateContent failed 429/);

    // Turn 2: provider recovers; subsequent request completes normally
    shouldFail = false;
    const events: LlmStreamEvent[] = [];
    for await (const evt of provider.stream(baseRequest(2048))) {
      events.push(evt);
    }

    const textDeltas = events.filter((e) => e.type === "text-delta");
    expect(textDeltas).toHaveLength(1);
    expect((textDeltas[0] as { type: "text-delta"; text: string }).text).toBe(
      "recovered text",
    );
    const finish = events.find((e) => e.type === "finish");
    expect(finish).toBeDefined();
    expect((finish as { type: "finish"; reason: string }).reason).toBe(
      "complete",
    );
  });
});

describe("toGeminiContents — tool calls & thoughtSignature", () => {
  it("preserves thoughtSignature in assistant tool_use blocks", () => {
    const contents = toGeminiContents([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_123",
            name: "read_file",
            input: { path: "src/index.ts" },
            thoughtSignature: "sig_gemini_thought_abc123",
          },
        ],
      },
    ]);

    expect(contents.contents).toHaveLength(1);
    expect(contents.contents[0]!.role).toBe("model");
    const parts = contents.contents[0]!.parts as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(1);
    expect(parts[0]!.functionCall).toEqual({
      name: "read_file",
      args: { path: "src/index.ts" },
    });
    expect(parts[0]!.thoughtSignature).toBe("sig_gemini_thought_abc123");
  });

  it("omits thoughtSignature when tool_use block does not have one", () => {
    const contents = toGeminiContents([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_456",
            name: "list_dir",
            input: { path: "." },
          },
        ],
      },
    ]);

    expect(contents.contents).toHaveLength(1);
    const parts = contents.contents[0]!.parts as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(1);
    expect(parts[0]!.functionCall).toEqual({
      name: "list_dir",
      args: { path: "." },
    });
    expect(parts[0]!.thoughtSignature).toBeUndefined();
    expect(
      Object.prototype.hasOwnProperty.call(parts[0], "thoughtSignature"),
    ).toBe(false);
  });

  it("preserves full multi-turn conversation with tool execution and thoughtSignature", () => {
    const contents = toGeminiContents([
      {
        role: "user",
        content: [{ type: "text", text: "Read package.json" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_789",
            name: "read_file",
            input: { path: "package.json" },
            thoughtSignature: "sig_round_trip_456",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_789",
            name: "read_file",
            content: '{"name": "test"}',
          },
        ],
      },
    ]);

    expect(contents.contents).toHaveLength(3);
    // 1. user prompt
    expect(contents.contents[0]!.role).toBe("user");
    // 2. assistant tool_use with thoughtSignature
    expect(contents.contents[1]!.role).toBe("model");
    const modelParts = contents.contents[1]!.parts as Array<
      Record<string, unknown>
    >;
    expect(modelParts[0]!.thoughtSignature).toBe("sig_round_trip_456");
    expect(modelParts[0]!.functionCall).toEqual({
      name: "read_file",
      args: { path: "package.json" },
    });
    // 3. user tool_result (functionResponse)
    expect(contents.contents[2]!.role).toBe("user");
    const userParts = contents.contents[2]!.parts as Array<
      Record<string, unknown>
    >;
    expect(userParts[0]!.functionResponse).toEqual({
      name: "read_file",
      response: { result: '{"name": "test"}' },
    });
  });
});

describe("GoogleLlmProvider — tool-call streaming and signatures", () => {
  it("yields tool-call events extracting thoughtSignature from wire response", async () => {
    const ssePayload = [
      `data: ${JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: "search", args: { q: "gemini" } },
                  thoughtSignature: "sig_wire_stream_xyz",
                },
              ],
            },
          },
        ],
      })}\n\n`,
      `data: [DONE]\n\n`,
    ];

    const provider = new GoogleLlmProvider({
      apiKey: "test-key",
      fetchImpl: async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            for (const chunk of ssePayload) {
              controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
          },
        });
        return new Response(stream, { status: 200, statusText: "OK" });
      },
    });

    const events: LlmStreamEvent[] = [];
    for await (const evt of provider.stream(baseRequest())) {
      events.push(evt);
    }

    const toolCalls = events.filter((e) => e.type === "tool-call");
    expect(toolCalls).toHaveLength(1);
    const callEvt = toolCalls[0] as {
      type: "tool-call";
      call: {
        toolName: string;
        argumentsText: string;
        thoughtSignature?: string;
      };
    };
    expect(callEvt.call.toolName).toBe("search");
    expect(JSON.parse(callEvt.call.argumentsText)).toEqual({ q: "gemini" });
    expect(callEvt.call.thoughtSignature).toBe("sig_wire_stream_xyz");
  });

  it("yields tool-call events without thoughtSignature when absent", async () => {
    const ssePayload = [
      `data: ${JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: "ping", args: {} },
                },
              ],
            },
          },
        ],
      })}\n\n`,
      `data: [DONE]\n\n`,
    ];

    const provider = new GoogleLlmProvider({
      apiKey: "test-key",
      fetchImpl: async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            for (const chunk of ssePayload) {
              controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
          },
        });
        return new Response(stream, { status: 200, statusText: "OK" });
      },
    });

    const events: LlmStreamEvent[] = [];
    for await (const evt of provider.stream(baseRequest())) {
      events.push(evt);
    }

    const toolCalls = events.filter((e) => e.type === "tool-call");
    expect(toolCalls).toHaveLength(1);
    const callEvt = toolCalls[0] as {
      type: "tool-call";
      call: { toolName: string; thoughtSignature?: string };
    };
    expect(callEvt.call.thoughtSignature).toBeUndefined();
  });
});

describe("GoogleLlmProvider — listModels canonical contract", () => {
  it("conforms to LlmListedModel[] return type and filters out non-chat models", async () => {
    const provider = new GoogleLlmProvider({
      apiKey: "test-key",
      fetchImpl: async () => {
        return new Response(
          JSON.stringify({
            models: [
              {
                name: "models/gemini-2.5-flash",
                displayName: "Gemini 2.5 Flash",
              },
              { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
              {
                name: "models/text-embedding-004",
                displayName: "Embedding 004",
              },
              { name: "models/aqa", displayName: "Attributed QA" },
            ],
          }),
          { status: 200, statusText: "OK" },
        );
      },
    });

    const models = await provider.listModels();
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: "gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
    });
    expect(models[1]).toMatchObject({
      id: "gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
    });
  });

  it("returns empty array when API key is missing or request fails", async () => {
    const failingProvider = new GoogleLlmProvider({
      apiKey: "test-key",
      fetchImpl: async () => new Response("Forbidden", { status: 403 }),
    });
    expect(await failingProvider.listModels()).toEqual([]);

    const noKeyProvider = new GoogleLlmProvider({
      apiKey: "",
    });
    expect(await noKeyProvider.listModels()).toEqual([]);
  });
});
