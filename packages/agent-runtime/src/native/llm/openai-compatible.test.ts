import { describe, expect, it } from "vitest";
import { OpenAiCompatibleLlmProvider } from "./openai-compatible.js";
import type { LlmToolCall } from "./types.js";
import { LlmError } from "./types.js";

describe("OpenAI compatible HTTP status mapping", () => {
  async function failureOf(status: number, body = "err"): Promise<LlmError> {
    const provider = new OpenAiCompatibleLlmProvider("test", {
      baseUrl: "https://example.test/v1",
      fetchImpl: async () => new Response(body, { status }),
    });
    try {
      for await (const _evt of provider.stream({
        providerId: "test",
        modelId: "m",
        messages: [],
      })) {
        // drain
      }
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      return err as LlmError;
    }
    throw new Error(`expected stream to throw for HTTP ${status}`);
  }

  it("maps 402 to a non-transient billing error (never retried)", async () => {
    const err = await failureOf(
      402,
      JSON.stringify({ error: { message: "insufficient credits" } }),
    );
    expect(err.status).toBe(402);
    expect(err.transient).toBe(false);
    expect(err.message).toContain("402");
  });

  it("maps 401 to a non-transient auth error", async () => {
    const err = await failureOf(401);
    expect(err.status).toBe(401);
    expect(err.transient).toBe(false);
  });

  it("maps 429 to a transient rate-limit error", async () => {
    const err = await failureOf(429);
    expect(err.status).toBe(429);
    expect(err.transient).toBe(true);
  });

  it("maps 5xx to transient errors", async () => {
    const err = await failureOf(503);
    expect(err.status).toBe(503);
    expect(err.transient).toBe(true);
  });
});

describe("OpenAI compatible terminal protocol", () => {
  async function reasons(body: string) {
    const provider = new OpenAiCompatibleLlmProvider("test", {
      baseUrl: "https://example.test/v1",
      fetchImpl: async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });
    const out: string[] = [];
    for await (const event of provider.stream({
      providerId: "test",
      modelId: "m",
      messages: [],
    })) {
      if (event.type === "finish") out.push(event.reason);
    }
    return out;
  }
  it("accepts the protocol finish_reason even when the final DONE line lacks a newline", async () => {
    expect(
      await reasons(
        'data: {"choices":[{"finish_reason":"stop"}]}\ndata: [DONE]',
      ),
    ).toEqual(["complete"]);
  });
  it("does not infer success from EOF without a provider finish reason", async () => {
    expect(
      await reasons('data: {"choices":[{"delta":{"content":"partial"}}]}\n'),
    ).toEqual(["incomplete"]);
  });

  async function toolCalls(body: string): Promise<LlmToolCall[]> {
    const provider = new OpenAiCompatibleLlmProvider("test", {
      baseUrl: "https://example.test/v1",
      fetchImpl: async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });
    const out: LlmToolCall[] = [];
    for await (const event of provider.stream({
      providerId: "test",
      modelId: "m",
      messages: [],
      tools: [
        {
          name: "read_files",
          description: "",
          inputSchema: {},
          execute: async () => "",
        },
        {
          name: "editor",
          description: "",
          inputSchema: {},
          execute: async () => "",
        },
        {
          name: "run_commands",
          description: "",
          inputSchema: {},
          execute: async () => "",
        },
      ],
    })) {
      if (event.type === "tool-call") out.push(event.call);
    }
    return out;
  }

  const chunk = (delta: unknown, finish?: string): string =>
    `data: ${JSON.stringify({ choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] })}`;

  it("does not duplicate a tool name repeated across delta fragments (live OpenRouter failure)", async () => {
    // Observed live: qwen/qwen3.6-35b-a3b via OpenRouter repeats the FULL
    // function.name in every fragment for the same index. The old += logic
    // produced "read_filesread_files", which dispatch correctly rejected.
    const body = [
      chunk({
        tool_calls: [
          { index: 0, id: "call_1", function: { name: "read_files" } },
        ],
      }),
      chunk({
        tool_calls: [
          { index: 0, function: { name: "read_files", arguments: "{}" } },
        ],
      }),
      chunk({}, "tool_calls"),
      "data: [DONE]",
    ].join("\n");
    const calls = await toolCalls(body);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolName).toBe("read_files");
    expect(calls[0]?.argumentsText).toBe("{}");
  });

  it("captures a tool name that first arrives on a later fragment", async () => {
    const body = [
      chunk({ tool_calls: [{ index: 0, id: "call_2", function: {} }] }),
      chunk({ tool_calls: [{ index: 0, function: { name: "editor" } }] }),
      chunk({}, "tool_calls"),
      "data: [DONE]",
    ].join("\n");
    const calls = await toolCalls(body);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolName).toBe("editor");
  });

  it("joins genuinely split name fragments only when they form an offered tool", async () => {
    const body = [
      chunk({
        tool_calls: [
          { index: 0, id: "call_split", function: { name: "read_" } },
        ],
      }),
      chunk({
        tool_calls: [
          { index: 0, function: { name: "files", arguments: "{}" } },
        ],
      }),
      chunk({}, "tool_calls"),
      "data: [DONE]",
    ].join("\n");
    const calls = await toolCalls(body);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolName).toBe("read_files");
    expect(calls[0]?.argumentsText).toBe("{}");
  });

  it("keeps the first name deterministically when a later fragment conflicts", async () => {
    const body = [
      chunk({
        tool_calls: [
          { index: 0, id: "call_3", function: { name: "read_files" } },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { name: "editor" } }] }),
      chunk({}, "tool_calls"),
      "data: [DONE]",
    ].join("\n");
    const calls = await toolCalls(body);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolName).toBe("read_files");
  });

  it("still concatenates split arguments across fragments with a repeated name", async () => {
    const body = [
      chunk({
        tool_calls: [
          { index: 0, id: "call_4", function: { name: "run_commands" } },
        ],
      }),
      chunk({
        tool_calls: [
          {
            index: 0,
            function: { name: "run_commands", arguments: '{"command":' },
          },
        ],
      }),
      chunk({
        tool_calls: [
          {
            index: 0,
            function: { name: "run_commands", arguments: '"echo hi"}' },
          },
        ],
      }),
      chunk({}, "tool_calls"),
      "data: [DONE]",
    ].join("\n");
    const calls = await toolCalls(body);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolName).toBe("run_commands");
    expect(calls[0]?.argumentsText).toBe('{"command":"echo hi"}');
  });
});

describe("OpenAI compatible terminal protocol — F-03 incomplete-stream handling", () => {
  async function reasons(body: string) {
    const provider = new OpenAiCompatibleLlmProvider("test", {
      baseUrl: "https://example.test/v1",
      fetchImpl: async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });
    const out: string[] = [];
    for await (const event of provider.stream({
      providerId: "test",
      modelId: "m",
      messages: [],
    })) {
      if (event.type === "finish") out.push(event.reason);
    }
    return out;
  }

  async function toolCalls(body: string) {
    const provider = new OpenAiCompatibleLlmProvider("test", {
      baseUrl: "https://example.test/v1",
      fetchImpl: async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });
    const out: Array<{ name: string; args: string }> = [];
    for await (const event of provider.stream({
      providerId: "test",
      modelId: "m",
      messages: [],
    })) {
      if (event.type === "tool-call")
        out.push({ name: event.call.toolName, args: event.call.argumentsText });
    }
    return out;
  }

  const chunk = (delta: unknown, finish?: string): string =>
    `data: ${JSON.stringify({
      choices: [
        {
          delta,
          ...(finish ? { finish_reason: finish } : {}),
        },
      ],
    })}`;

  it("does not infer success from EOF without a provider finish reason (retained)", async () => {
    expect(
      await reasons('data: {"choices":[{"delta":{"content":"partial"}}]}\n'),
    ).toEqual(["incomplete"]);
  });

  it("does not infer success from a bare [DONE] with no finish_reason", async () => {
    expect(await reasons("data: [DONE]\n")).toEqual(["incomplete"]);
  });

  it("treats EOF after partial text with no finish_reason as incomplete", async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"hello"}}]}' + "\n",
      'data: {"choices":[{"delta":{"content":" world"}}]}' + "\n",
      "data: [DONE]\n",
    ].join("\n");
    expect(await reasons(body)).toEqual(["incomplete"]);
  });

  it("treats EOF after a partial (unfinished) tool call as incomplete", async () => {
    const body = [
      chunk({ tool_calls: [{ index: 0, id: "call_1", function: {} }] }),
      'data: {"choices":[{"delta":{"tool_calls":[{index:0}]}}]}' + "\n",
      // stream ends while the tool call is still being described — no
      // finish_reason, no [DONE]; the model cut off mid-tool-call.
    ].join("\n");
    const calls = await toolCalls(body);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe(""); // name never arrived
    // The provider-level finish must be incomplete, never complete.
    expect(await reasons(body)).toEqual(["incomplete"]);
  });

  it("treats a [DONE] with pending unflushed tool-call fragments as incomplete", async () => {
    // The provider describes a tool call across fragments but never emits a
    // finish_reason; it then sends [DONE]. That is an incomplete turn, not a
    // successful one — the model did not finish describing the call.
    const body = [
      chunk({
        tool_calls: [{ index: 0, id: "call_1", function: { name: "editor" } }],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: "{ " } }] }),
      // stream terminates here; the arguments never finished and there is no
      // finish_reason. [DONE] is just the SSE terminator.
      "data: [DONE]\n",
    ].join("\n");
    const calls = await toolCalls(body);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("editor");
    expect(calls[0]?.args).toBe("{ ");
    expect(await reasons(body)).toEqual(["incomplete"]);
  });

  it("still completes when the provider emits an explicit finish_reason", async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"done"}}]}' + "\n",
      chunk({}, "stop"),
      "data: [DONE]\n",
    ].join("\n");
    expect(await reasons(body)).toEqual(["complete"]);
  });

  it("preserves cancellation: a transport abort before any chunk is aborted, not incomplete", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new OpenAiCompatibleLlmProvider("test", {
      baseUrl: "https://example.test/v1",
      fetchImpl: async () =>
        new Response("data: [DONE]\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      signal: controller.signal,
    });
    const out: string[] = [];
    for await (const event of provider.stream({
      providerId: "test",
      modelId: "m",
      messages: [],
    })) {
      if (event.type === "finish") out.push(event.reason);
    }
    // Cancellation wins over the (irrelevant) protocol terminator.
    expect(out).toEqual(["aborted"]);
  });
});
