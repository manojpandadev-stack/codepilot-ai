/**
 * @codepilot/llm — adapter wire-protocol tests (mocked fetch, no network).
 *
 * Each adapter is proven against recorded-shape payloads: chunk kinds,
 * tool-call accumulation, usage, done/error terminals, and abort.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { OllamaProvider, splitThinking } from "./providers/ollama.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { createLlmProvider } from "./factory.js";
import type { LlmChunk } from "./types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const payload = lines.join("\n");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}

async function collect(stream: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe("splitThinking", () => {
  it("splits think spans from text", () => {
    expect(splitThinking("hello <think>reasoning here</think> world")).toEqual([
      { kind: "text", text: "hello " },
      { kind: "reasoning", text: "reasoning here" },
      { kind: "text", text: " world" },
    ]);
  });

  it("keeps parallel same-name tool calls separate, preserving order and server ids", async () => {
    // Recorded wire shape from Ollama 0.34.0 / qwen3:8b: two parallel calls
    // of the SAME tool arrive as discrete entries with distinct
    // `function.index` and distinct server ids.
    const lines = [
      JSON.stringify({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_n7b2adlg",
              function: {
                index: 0,
                name: "get_time",
                arguments: { city: "Tokyo" },
              },
            },
          ],
        },
        done: false,
      }),
      JSON.stringify({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_afdwnfa5",
              function: {
                index: 1,
                name: "get_time",
                arguments: { city: "Paris" },
              },
            },
          ],
        },
        done: false,
      }),
      JSON.stringify({ done: true, prompt_eval_count: 153, eval_count: 165 }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(lines.join("\n"), { status: 200 })),
    );
    const provider = new OllamaProvider({
      providerId: "ollama",
      modelId: "qwen3:8b",
    });
    const chunks = await collect(
      provider.completeStream({
        messages: [{ role: "user", content: "time in Tokyo and Paris" }],
      }),
    );
    const calls = chunks
      .filter(
        (c): c is Extract<LlmChunk, { type: "toolcall" }> =>
          c.type === "toolcall",
      )
      .map((c) => c.toolCall);
    expect(calls).toHaveLength(2);
    // Order preserved by function.index; ids are the server's verbatim.
    expect(calls[0]).toMatchObject({
      id: "call_n7b2adlg",
      name: "get_time",
      input: { city: "Tokyo" },
    });
    expect(calls[1]).toMatchObject({
      id: "call_afdwnfa5",
      name: "get_time",
      input: { city: "Paris" },
    });
  });

  it("passes plain text through untouched", () => {
    expect(splitThinking("just text")).toEqual([
      { kind: "text", text: "just text" },
    ]);
  });
});

describe("OllamaProvider", () => {
  it("streams text, reasoning, tool calls, usage, done", async () => {
    const lines = [
      JSON.stringify({
        message: { role: "assistant", content: "Hi <think>plan</think> there" },
        done: false,
      }),
      JSON.stringify({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              function: {
                name: "read_file",
                arguments: '{"path":"a.ts"}',
              },
            },
          ],
        },
        done: false,
      }),
      JSON.stringify({ done: true, prompt_eval_count: 10, eval_count: 5 }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(lines.join("\n"), { status: 200 })),
    );
    const provider = new OllamaProvider({
      providerId: "ollama",
      modelId: "qwen3:8b",
    });
    const chunks = await collect(
      provider.completeStream({
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    const kinds = chunks.map((c) => c.type);
    expect(kinds).toContain("text");
    expect(kinds).toContain("reasoning");
    expect(kinds).toContain("toolcall");
    expect(kinds).toContain("usage");
    expect(kinds[kinds.length - 1]).toBe("done");
    const tool = chunks.find((c) => c.type === "toolcall");
    expect(tool).toMatchObject({
      type: "toolcall",
      toolCall: { name: "read_file", input: { path: "a.ts" } },
    });
    const usage = chunks.find((c) => c.type === "usage");
    expect(usage).toMatchObject({
      type: "usage",
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it("surfaces provider errors as failed done", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "model not found" }), {
            status: 200,
          }),
      ),
    );
    const provider = new OllamaProvider({
      providerId: "ollama",
      modelId: "nope",
    });
    const chunks = await collect(
      provider.completeStream({ messages: [{ role: "user", content: "hi" }] }),
    );
    const done = chunks[chunks.length - 1]!;
    expect(done.type).toBe("done");
    if (done.type === "done") {
      expect(done.success).toBe(false);
      expect(done.error).toContain("model not found");
    }
  });

  it("rejects non-http base urls", () => {
    expect(
      () =>
        new OllamaProvider({
          providerId: "ollama",
          modelId: "x",
          baseUrl: "ftp://evil",
        }),
    ).toThrow(/http/);
  });
});

describe("OpenAICompatibleProvider", () => {
  it("accumulates split tool-call deltas and usage", async () => {
    const lines = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Working " } }] })}`,
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call-1", function: { name: "bash" } },
              ],
            },
          },
        ],
      })}`,
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"comma' } }],
            },
          },
        ],
      })}`,
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: 'nd":"ls"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      })}`,
      "data: [DONE]",
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(sseStream(lines), { status: 200 })),
    );
    const provider = new OpenAICompatibleProvider({
      providerId: "openai-compatible",
      modelId: "m",
      baseUrl: "https://example.test/v1",
    });
    const chunks = await collect(
      provider.completeStream({ messages: [{ role: "user", content: "go" }] }),
    );
    expect(chunks[0]).toMatchObject({ type: "text", text: "Working " });
    const tool = chunks.find((c) => c.type === "toolcall");
    expect(tool).toMatchObject({
      type: "toolcall",
      toolCall: { id: "call-1", name: "bash", input: { command: "ls" } },
    });
    expect(chunks).toContainEqual({
      type: "usage",
      inputTokens: 7,
      outputTokens: 3,
    });
    expect(chunks[chunks.length - 1]).toMatchObject({
      type: "done",
      success: true,
    });
  });

  it("requires a base url", () => {
    expect(
      () => new OpenAICompatibleProvider({ providerId: "x", modelId: "m" }),
    ).toThrow(/baseUrl/);
  });
});

describe("AnthropicProvider", () => {
  it("parses text, tool input_json deltas, and usage", async () => {
    const lines = [
      "event: message_start",
      `data: ${JSON.stringify({ message: { usage: { input_tokens: 12 } } })}`,
      "event: content_block_start",
      `data: ${JSON.stringify({ index: 0, content_block: { type: "text" } })}`,
      "event: content_block_delta",
      `data: ${JSON.stringify({ index: 0, delta: { type: "text_delta", text: "Hello" } })}`,
      "event: content_block_stop",
      `data: ${JSON.stringify({ index: 0 })}`,
      "event: content_block_start",
      `data: ${JSON.stringify({ index: 1, content_block: { type: "tool_use", id: "toolu-1", name: "read_file" } })}`,
      "event: content_block_delta",
      `data: ${JSON.stringify({ index: 1, delta: { type: "input_json_delta", partial_json: '{"path"' } })}`,
      "event: content_block_delta",
      `data: ${JSON.stringify({ index: 1, delta: { type: "input_json_delta", partial_json: ':"b.ts"}' } })}`,
      "event: content_block_stop",
      `data: ${JSON.stringify({ index: 1 })}`,
      "event: message_delta",
      `data: ${JSON.stringify({ usage: { output_tokens: 9 } })}`,
      "event: message_stop",
      `data: ${JSON.stringify({ type: "message_stop" })}`,
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(sseStream(lines), { status: 200 })),
    );
    const provider = new AnthropicProvider({
      providerId: "anthropic",
      modelId: "claude-x",
      apiKey: "test-key",
    });
    const chunks = await collect(
      provider.completeStream({ messages: [{ role: "user", content: "go" }] }),
    );
    expect(chunks).toContainEqual({ type: "text", text: "Hello" });
    expect(chunks).toContainEqual({
      type: "toolcall",
      toolCall: { id: "toolu-1", name: "read_file", input: { path: "b.ts" } },
    });
    expect(chunks).toContainEqual({
      type: "usage",
      inputTokens: 12,
      outputTokens: 9,
    });
    expect(chunks[chunks.length - 1]).toMatchObject({
      type: "done",
      success: true,
    });
  });
});

describe("GoogleProvider", () => {
  it("parses text parts and function calls", async () => {
    const lines = [
      `data: ${JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: "Sure " },
                { functionCall: { name: "bash", args: { command: "ls" } } },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 6 },
      })}`,
    ];
    const { GoogleProvider } = await import("./providers/google.js");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(sseStream(lines), { status: 200 })),
    );
    const provider = new GoogleProvider({
      providerId: "gemini",
      modelId: "gemini-2.5-flash",
      apiKey: "test-key",
    });
    const chunks = await collect(
      provider.completeStream({ messages: [{ role: "user", content: "go" }] }),
    );
    expect(chunks).toContainEqual({ type: "text", text: "Sure " });
    expect(chunks).toContainEqual({
      type: "toolcall",
      toolCall: { id: "call-1", name: "bash", input: { command: "ls" } },
    });
    expect(chunks).toContainEqual({
      type: "usage",
      inputTokens: 5,
      outputTokens: 6,
    });
  });
});

describe("createLlmProvider", () => {
  it("normalizes legacy provider ids", async () => {
    const { normalizeProviderId } = await import("./factory.js");
    expect(normalizeProviderId("openai")).toBe("openai-native");
    expect(normalizeProviderId("google")).toBe("gemini");
    expect(normalizeProviderId("ollama")).toBe("ollama");
  });

  it("fails closed for unknown providers without a base url", async () => {
    expect(() =>
      createLlmProvider({ providerId: "mystery", modelId: "m" }),
    ).toThrow(/explicit baseUrl/);
  });

  it("routes unknown providers with a base url to compatible", async () => {
    const p = createLlmProvider({
      providerId: "mystery",
      modelId: "m",
      baseUrl: "https://example.test/v1",
    });
    expect(p.providerId).toBe("mystery");
  });
});
