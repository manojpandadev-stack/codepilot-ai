/**
 * Deterministic fetch stub for runtime tests (test-only helper).
 *
 * Serves canned Ollama `/api/chat` NDJSON turns through the REAL native
 * provider + agent loop: no network, no model, fully deterministic, while
 * exercising the genuine production path (wire parsing, dispatch, M4 gate,
 * streaming events, usage, completion).
 *
 * Each queued turn is consumed by ONE chat request, in order; when the queue
 * is exhausted the stub answers with an empty completion turn (text-less
 * `done`) so loops always terminate. Non-chat URLs get HTTP 404. Every
 * request (url + parsed body) is recorded for wire-level assertions.
 */

import { afterEach, vi } from "vitest";

export interface StubToolCall {
  name: string;
  args?: Record<string, unknown>;
}

export interface StubTurn {
  /** Text chunks streamed in order (each becomes one content delta). */
  texts?: string[];
  /** Tool calls emitted after the text of this turn. */
  toolCalls?: StubToolCall[];
  /** Token counts reported on the done line. */
  usage?: { in: number; out: number };
}

export interface RecordedRequest {
  url: string;
  body: unknown;
  /** Normalized request headers (lower-fidelity copy — values as sent). */
  headers?: Record<string, string>;
}

export interface OllamaStub {
  requests: RecordedRequest[];
  restore: () => void;
}

function ndjsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** Normalize fetch init headers (record | entries | Headers) to a record. */
function normalizeHeaders(
  headers: HeadersInit | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  try {
    if (headers instanceof Headers) {
      return Object.fromEntries(headers.entries());
    }
    if (Array.isArray(headers)) {
      return Object.fromEntries(headers);
    }
    return { ...(headers as Record<string, string>) };
  } catch {
    return undefined;
  }
}

export function ollamaTurnBody(turn: StubTurn): string {
  let out = "";
  for (const text of turn.texts ?? []) {
    out += ndjsonLine({
      message: { role: "assistant", content: text },
      done: false,
    });
  }
  if (turn.toolCalls && turn.toolCalls.length > 0) {
    out += ndjsonLine({
      message: {
        role: "assistant",
        content: "",
        tool_calls: turn.toolCalls.map((c) => ({
          function: { name: c.name, arguments: c.args ?? {} },
        })),
      },
      done: false,
    });
  }
  out += ndjsonLine({
    done: true,
    prompt_eval_count: turn.usage?.in ?? 3,
    eval_count: turn.usage?.out ?? 5,
  });
  return out;
}

/**
 * Stub global fetch. `script` turns are served to successive chat requests
 * (Ollama `/api/chat` NDJSON or OpenAI-compatible `/chat/completions` SSE —
 * both shapes are answered from the same turn script).
 */
export function stubOllamaFetch(script: StubTurn[] = []): OllamaStub {
  const requests: RecordedRequest[] = [];
  const queue = [...script];
  const handler = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url,
    );
    let body: unknown = null;
    try {
      body =
        typeof init?.body === "string"
          ? JSON.parse(init.body)
          : (init?.body ?? null);
    } catch {
      body = init?.body ?? null;
    }
    requests.push({ url, body, headers: normalizeHeaders(init?.headers) });
    if (url.includes("/api/chat")) {
      const turn = queue.length > 0 ? queue.shift()! : {};
      return new Response(ollamaTurnBody(turn), { status: 200 });
    }
    if (url.includes("/chat/completions")) {
      const turn = queue.length > 0 ? queue.shift()! : {};
      const lines: string[] = [];
      for (const text of turn.texts ?? []) {
        lines.push(
          `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
        );
      }
      for (const call of turn.toolCalls ?? []) {
        lines.push(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `stub-${requests.length}`,
                      function: {
                        name: call.name,
                        arguments: JSON.stringify(call.args ?? {}),
                      },
                    },
                  ],
                },
              },
            ],
          })}`,
        );
      }
      lines.push(
        `data: ${JSON.stringify({
          choices: [{ finish_reason: "stop" }],
          usage: {
            prompt_tokens: turn.usage?.in ?? 3,
            completion_tokens: turn.usage?.out ?? 5,
          },
        })}`,
        "data: [DONE]",
      );
      return new Response(lines.join("\n"), { status: 200 });
    }
    if (
      url.includes("/api/tags") ||
      url.includes("/v1/models") ||
      url.includes("/models")
    ) {
      return new Response(JSON.stringify({ models: [], data: [] }), {
        status: 200,
      });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", handler as unknown as typeof fetch);
  return {
    requests,
    restore: () => vi.unstubAllGlobals(),
  };
}

export function registerStubCleanup(): void {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
}
