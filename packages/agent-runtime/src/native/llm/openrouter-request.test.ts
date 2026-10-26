/**
 * Deterministic request-construction regression suite for the OpenRouter
 * (OpenAI-compatible) adapter.
 *
 * WHY THIS EXISTS
 * ---------------
 * A live CodePilot run against OpenRouter failed with the generic
 *
 *   "Error from provider (Console): The request contains invalid parameters.
 *    Check the request body for any errors or inconsistencies."
 *
 * That message hides which field the provider rejected, so it cannot be acted
 * on. These tests lock down the two properties that actually matter:
 *
 *   1. The emitted request body only ever contains fields that an
 *      OpenAI-compatible / OpenRouter chat-completions endpoint accepts
 *      (scenarios A-I below).
 *   2. A non-OK provider response keeps its real diagnostics (status, upstream
 *      provider, code/type, offending parameter, request id) in the surfaced
 *      error instead of a truncated raw blob.
 *
 * NO NETWORK. `fetchImpl` is always a stub; the normal suite must pass offline.
 */

import { describe, expect, it } from "vitest";
import { OpenAiCompatibleLlmProvider } from "./openai-compatible.js";
import type { LlmStreamEvent } from "./types.js";
import { LlmError } from "./types.js";
import type { AgentTool } from "../types.js";
import {
  extractProviderError,
  formatProviderError,
  upstreamProviderFromMessage,
} from "./provider-error.js";

const MODEL = "qwen/qwen3.6-35b-a3b";

/** The exact envelope OpenRouter returned for the live failure. */
const OR_INVALID_PARAMETERS_BODY = JSON.stringify({
  error: {
    code: 400,
    message:
      "Error from provider (Console): The request contains invalid parameters. Check the request body for any errors or inconsistencies.",
    metadata: { provider_name: "Console", raw: "SHOULD_NEVER_BE_SURFACED" },
  },
});

/** Fields an OpenAI-compatible chat-completions body may legally carry here. */
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "model",
  "messages",
  "stream",
  "tools",
  "temperature",
  "max_tokens",
]);

const SSE_OK =
  'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
  'data: {"choices":[{"finish_reason":"stop"}]}\n\n' +
  "data: [DONE]\n\n";

const TOOL: AgentTool = {
  name: "read_files",
  description: "Read one or more files from disk.",
  inputSchema: {
    type: "object",
    properties: {
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Paths.",
      },
    },
    required: ["paths"],
    additionalProperties: false,
  },
} as unknown as AgentTool;

/** Capture the body CodePilot would POST, returning a canned SSE response. */
async function captureBody(
  request: Parameters<OpenAiCompatibleLlmProvider["stream"]>[0],
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const provider = new OpenAiCompatibleLlmProvider("openrouter", {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "sk-or-test-not-a-real-key",
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(SSE_OK, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  for await (const _evt of provider.stream(request)) {
    void (_evt as LlmStreamEvent);
  }
  if (!captured) throw new Error("provider did not issue a request");
  return captured;
}

const TOOL_TURN = [
  { role: "user" as const, content: "read a.ts" },
  {
    role: "assistant" as const,
    content: [
      {
        type: "tool_use" as const,
        id: "call_1",
        name: "read_files",
        input: { paths: ["a.ts"] },
      },
    ],
  },
  {
    role: "user" as const,
    content: [
      {
        type: "tool_result" as const,
        tool_use_id: "call_1",
        name: "read_files",
        content: "line1\nline2",
      },
    ],
  },
] as unknown as Parameters<
  OpenAiCompatibleLlmProvider["stream"]
>[0]["messages"];

/** Drive the adapter against a non-OK provider response and capture the error. */
async function captureError(
  status: number,
  body: string,
  request: Parameters<OpenAiCompatibleLlmProvider["stream"]>[0],
): Promise<LlmError> {
  const provider = new OpenAiCompatibleLlmProvider("openrouter", {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "sk-or-test-not-a-real-key",
    fetchImpl: async () =>
      new Response(body, {
        status,
        headers: { "content-type": "application/json" },
      }),
  });
  try {
    for await (const _evt of provider.stream(request))
      void (_evt as LlmStreamEvent);
  } catch (err) {
    return err as LlmError;
  }
  throw new Error("expected the provider to reject the request");
}

/**
 * Drive a stream and capture the terminal error message.
 *
 * A mid-stream provider failure is caught by the adapter's own generator
 * handler and re-surfaced as a `finish` event with `reason: "error"` (the same
 * channel the agent loop reads), NOT as a rejected iteration.
 */
async function captureStreamError(
  provider: OpenAiCompatibleLlmProvider,
  request: Parameters<OpenAiCompatibleLlmProvider["stream"]>[0],
): Promise<string> {
  let failure: string | undefined;
  for await (const evt of provider.stream(request)) {
    if (evt.type === "finish" && evt.reason === "error") failure = evt.error;
  }
  if (failure === undefined)
    throw new Error("expected the provider stream to fail");
  return failure;
}

const SIMPLE_REQUEST: Parameters<OpenAiCompatibleLlmProvider["stream"]>[0] = {
  providerId: "openrouter",
  modelId: MODEL,
  systemPrompt: "You are CodePilot.",
  messages: [{ role: "user", content: "hello" }],
  temperature: 0.7,
  maxTokens: 8192,
};

describe("OpenRouter request construction (deterministic, no network)", () => {
  // ---- A. valid request -------------------------------------------------
  it("A: emits only OpenAI-compatible top-level fields", async () => {
    const body = await captureBody(SIMPLE_REQUEST);
    for (const key of Object.keys(body)) {
      expect(ALLOWED_TOP_LEVEL_KEYS.has(key)).toBe(true);
    }
    expect(body["model"]).toBe(MODEL);
    expect(body["stream"]).toBe(true);
    expect(body["temperature"]).toBe(0.7);
    expect(Array.isArray(body["messages"])).toBe(true);
  });

  // ---- B. invalid max-token field --------------------------------------
  it("B: uses max_tokens and never max_completion_tokens", async () => {
    const body = await captureBody(SIMPLE_REQUEST);
    expect(body["max_tokens"]).toBe(8192);
    expect("max_completion_tokens" in body).toBe(false);
    // The 8192 output cap is the token-budget fix for the old HTTP 402; it must
    // be sent as `max_tokens`, the field OpenRouter's chat endpoint accepts.
    expect(Number(body["max_tokens"])).toBeGreaterThan(0);
    expect(Number(body["max_tokens"])).toBeLessThanOrEqual(8192);
  });

  it("B2: omits max_tokens entirely when no budget is derived", async () => {
    const { maxTokens: _omitted, ...rest } = SIMPLE_REQUEST;
    const body = await captureBody(rest as typeof SIMPLE_REQUEST);
    expect("max_tokens" in body).toBe(false);
  });
  // ---- C. invalid tool schema ------------------------------------------
  it("C: emits a well-formed OpenAI function tool", async () => {
    const body = await captureBody({ ...SIMPLE_REQUEST, tools: [TOOL] });
    const tools = body["tools"] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!["type"]).toBe("function");
    const fn = tools[0]!["function"] as Record<string, unknown>;
    expect(fn["name"]).toBe("read_files");
    expect(typeof fn["description"]).toBe("string");
    const params = fn["parameters"] as Record<string, unknown>;
    expect(params["type"]).toBe("object");
    expect(Array.isArray(params["required"])).toBe(true);
  });

  it("C2: rejects duplicate tool names before they reach the wire", async () => {
    // OpenRouter answers duplicate function names with a generic
    // "invalid parameters" 400, so the adapter must refuse them locally.
    await expect(
      captureBody({ ...SIMPLE_REQUEST, tools: [TOOL, TOOL] }),
    ).rejects.toThrow(/duplicate tool name: read_files/);
  });

  // ---- D. invalid tool_choice ------------------------------------------
  it("D: never emits a tool_choice the endpoint would reject", async () => {
    const body = await captureBody({ ...SIMPLE_REQUEST, tools: [TOOL] });
    // The adapter does not force tool_choice; if present it must be a legal
    // OpenAI value ("auto" | "none" | "required" | {"type":"function"}).
    const choice = body["tool_choice"];
    if (choice !== undefined) {
      expect(["auto", "none", "required"]).toContain(choice);
    }
  });

  // ---- E. unsupported parameter ----------------------------------------
  it("E: emits no reasoning/response_format/routing parameters", async () => {
    const body = await captureBody(SIMPLE_REQUEST);
    for (const forbidden of [
      "reasoning",
      "response_format",
      "max_completion_tokens",
      "parallel_tool_calls",
      "provider",
      "transforms",
      "seed",
      "top_p",
      "stop",
      "user",
    ]) {
      expect(forbidden in body).toBe(false);
    }
  });

  // ---- F. malformed messages -------------------------------------------
  it("F: maps a tool_result turn to a valid tool_call_id pairing", async () => {
    const body = await captureBody({ ...SIMPLE_REQUEST, messages: TOOL_TURN });
    const messages = body["messages"] as Array<Record<string, unknown>>;
    const assistant = messages.find((m) => m["role"] === "assistant")!;
    const calls = assistant["tool_calls"] as Array<Record<string, unknown>>;
    expect(calls).toHaveLength(1);
    const id = (calls[0]!["id"] as string) ?? "";
    expect(id.length).toBeGreaterThan(0);

    const toolMsg = messages.find((m) => m["role"] === "tool")!;
    expect(toolMsg["tool_call_id"]).toBe(id);
    expect(typeof toolMsg["content"]).toBe("string");
  });

  // ---- G. unsupported response_format ----------------------------------
  it("G: response_format stays absent unless explicitly requested", async () => {
    const body = await captureBody(SIMPLE_REQUEST);
    expect("response_format" in body).toBe(false);
  });

  // ---- H. valid request WITH tools -------------------------------------
  it("H: streams successfully with tools attached", async () => {
    const body = await captureBody({ ...SIMPLE_REQUEST, tools: [TOOL] });
    expect(Array.isArray(body["tools"])).toBe(true);
    expect(body["stream"]).toBe(true);
  });

  // ---- I. valid request WITHOUT tools ----------------------------------
  it("I: omits tools entirely when none are supplied", async () => {
    const body = await captureBody(SIMPLE_REQUEST);
    expect("tools" in body).toBe(false);
  });

  // ---- Diagnostics preservation ----------------------------------------
  it("preserves provider diagnostics instead of a generic message", async () => {
    const err = await captureError(
      400,
      OR_INVALID_PARAMETERS_BODY,
      SIMPLE_REQUEST,
    );
    expect(err.message).toContain("HTTP 400");
    expect(err.message).toContain("Provider: Console");
    expect(err.message).toContain("Code: 400");
    // The provider's raw metadata blob must never be surfaced.
    expect(err.message).not.toContain("SHOULD_NEVER_BE_SURFACED");
    // The generic wrapper must not be the only thing the user sees.
    expect(err.message).toMatch(/HTTP 400/);
  });

  it("extracts the upstream provider name from the wrapper prose", () => {
    expect(
      upstreamProviderFromMessage(
        "Error from provider (Console): The request contains invalid parameters.",
      ),
    ).toBe("Console");
  });

  it("surfaces an explicitly named offending parameter", () => {
    const details = extractProviderError(
      400,
      JSON.stringify({
        error: { code: 400, message: "invalid request", param: "max_tokens" },
      }),
    );
    expect(details.parameter).toBe("max_tokens");
    expect(formatProviderError(details)).toContain("Parameter: max_tokens");
  });

  it("never echoes a forbidden field from metadata", () => {
    const details = extractProviderError(
      400,
      JSON.stringify({
        error: {
          code: 400,
          message: "bad",
          metadata: {
            provider_name: "Console",
            raw: "SECRET_ECHO",
            prompt: "P",
          },
        },
      }),
    );
    expect(JSON.stringify(details)).not.toContain("SECRET_ECHO");
    expect(JSON.stringify(details)).not.toContain('"prompt"');
  });

  it("flags an unparseable body instead of pretending to have details", () => {
    const details = extractProviderError(500, "not json at all");
    expect(details.status).toBe("500");
    expect(details.message).toContain("not json at all");
  });

  // ---- Real OpenRouter envelope shapes ----------------------------------
  it("reads the root-level request_id that OpenRouter returns", () => {
    // Documented shape: request_id is a SIBLING of `error`, not inside it.
    const details = extractProviderError(
      401,
      JSON.stringify({
        type: "error",
        error: {
          type: "authentication_error",
          message: "Invalid credentials",
          error_type: "authentication",
        },
        request_id: null,
      }),
    );
    expect(details.message).toBe("Invalid credentials");
    expect(details.type).toBe("authentication_error");
    // null request_id must NOT become the string "null".
    expect(details.requestId).toBeUndefined();
  });

  it("surfaces the generation id when OpenRouter provides one", () => {
    const details = extractProviderError(
      400,
      JSON.stringify({
        error: {
          code: 400,
          message: "The request contains invalid parameters.",
        },
        request_id: "gen-abc123",
      }),
    );
    expect(details.requestId).toBe("gen-abc123");
    expect(formatProviderError(details)).toContain("Request-Id: gen-abc123");
  });

  it("keeps mid-stream HTTP 200 errors fully structured", async () => {
    // OpenRouter commits the 200 status before the model emits a token, so a
    // provider failure arrives as an SSE `error` chunk on an OK response.
    const provider = new OpenAiCompatibleLlmProvider("openrouter", {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-test-not-a-real-key",
      fetchImpl: async () =>
        new Response(
          'data: {"error":{"message":"Provider is temporarily overloaded","code":502,"error_type":"provider_unavailable"},"request_id":"gen-stream-1"}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    const message = await captureStreamError(provider, SIMPLE_REQUEST);
    expect(message).toContain("chat failed mid-stream");
    expect(message).toContain("HTTP 200");
    expect(message).toContain("Error: Provider is temporarily overloaded");
    expect(message).toContain("Request-Id: gen-stream-1");
  });
});
