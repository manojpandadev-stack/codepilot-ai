/**
 * CodePilot LLM — node:http(s) transport adapter.
 *
 * WHY THIS EXISTS (measured, live qwen3:8b — see tests/ollama-perf-live.test.ts):
 * Node's global `fetch` is backed by undici, which enforces a default 300s
 * HEADERS timeout (UND_ERR_HEADERS_TIMEOUT). A local CPU prefill on a
 * model like qwen3:8b is legitimately silent far longer than that while the
 * model loads and evaluates the prompt — undici then kills the request at
 * the transport layer BEFORE the Ollama provider's designed first-token
 * inactivity window (default 15 minutes) can decide anything. The transport
 * cap turned "slow local generation" into a hard, confusing failure.
 *
 * This adapter performs the same request over node:http/node:https with NO
 * transport-level timeouts of any kind. The Ollama provider's own inactivity
 * windows (firstTokenTimeoutMs before the first chunk, timeoutMs re-armed on
 * every chunk afterwards) remain the sole timeout authority — a genuinely
 * dead server or stalled stream still trips them, and cancellation still
 * propagates via the AbortSignal.
 *
 * It is an explicit opt-in transport for the local Ollama provider only.
 * Global fetch remains the default/testable transport; cloud providers keep
 * global fetch. Host-injected fetchImpl (tests, embedding hosts) always wins.
 */

import * as http from "node:http";
import * as https from "node:https";

/** Minimal Response-like surface consumed by the native LLM providers. */
export interface FetchLikeResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
  readonly body: {
    getReader(): {
      read(): Promise<{ value: Uint8Array; done: boolean }>;
    };
  };
}

/** AbortSignal.reason-style error, reproduced without DOM dependencies. */
class RequestAbortedError extends Error {
  constructor() {
    super("This operation was aborted");
    this.name = "AbortError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function normalizeHeaders(
  init: HeadersInit | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) return out;
  if (init instanceof Headers || (isRecord(init) && "forEach" in init)) {
    (init as Headers).forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(init)) {
    for (const [key, value] of init as Array<[string, string]>) {
      out[key] = value;
    }
    return out;
  }
  for (const [key, value] of Object.entries(init as Record<string, string>)) {
    out[key] = value;
  }
  return out;
}

function toPayload(body: BodyInit | null | undefined): {
  payload?: Uint8Array;
} {
  if (body === undefined || body === null) return {};
  if (typeof body === "string") {
    return { payload: Buffer.from(body, "utf8") };
  }
  if (body instanceof Uint8Array) return { payload: body };
  if (body instanceof URLSearchParams) {
    return { payload: Buffer.from(body.toString(), "utf8") };
  }
  if (body instanceof ArrayBuffer) {
    return { payload: new Uint8Array(body) };
  }
  if (ArrayBuffer.isView(body)) {
    return {
      payload: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    };
  }
  // Readable bodies (used by nobody in this codebase) are rejected loudly
  // rather than silently mis-sent.
  throw new Error(
    "nodeHttpFetch: streaming request bodies are not supported; pass a string or bytes",
  );
}

/**
 * fetch-compatible request over node:http(s) with NO transport timeouts.
 * Honors: method, headers, body (string/bytes), signal. The returned
 * response is structurally compatible with the subset of `Response` the
 * native LLM providers consume (ok/status/text/json/body.getReader()).
 */
export async function nodeHttpFetch(
  input: string | URL,
  init?: RequestInit,
): Promise<FetchLikeResponse> {
  const url = new URL(input.toString());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`nodeHttpFetch: unsupported protocol ${url.protocol}`);
  }
  const transport = url.protocol === "https:" ? https : http;
  const { payload } = toPayload(init?.body);
  const headers = normalizeHeaders(init?.headers);
  if (payload && headers["Content-Length"] === undefined) {
    headers["Content-Length"] = String(payload.byteLength);
  }

  const signal = init?.signal;
  if (signal?.aborted) throw new RequestAbortedError();

  return new Promise<FetchLikeResponse>((resolve, reject) => {
    let settled = false;
    let aborted = false;
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      reject(aborted ? new RequestAbortedError() : normalizeError(err, url));
    };

    const req = transport.request(
      url,
      { method: init?.method ?? "GET", headers },
      (res) => {
        if (settled) {
          res.resume();
          return;
        }
        settled = true;
        const status = res.statusCode ?? 0;
        const iterator = res[Symbol.asyncIterator]();
        let finished = false;
        const onAbort = (): void => {
          aborted = true;
          void iterator.return?.().catch(() => {});
          res.destroy();
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        const reader = {
          async read(): Promise<{ value: Uint8Array; done: boolean }> {
            if (aborted) throw new RequestAbortedError();
            if (finished) return { value: new Uint8Array(0), done: true };
            try {
              const r = await iterator.next();
              if (r.done) {
                finished = true;
                signal?.removeEventListener("abort", onAbort);
                return { value: new Uint8Array(0), done: true };
              }
              return { value: r.value, done: false };
            } catch (err) {
              signal?.removeEventListener("abort", onAbort);
              finished = true;
              if (aborted) throw new RequestAbortedError();
              throw normalizeError(err, url);
            }
          },
        };

        const response: FetchLikeResponse = {
          ok: status >= 200 && status < 300,
          status,
          statusText: res.statusMessage ?? "",
          body: { getReader: () => reader },
          async text(): Promise<string> {
            const chunks: Uint8Array[] = [];
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              chunks.push(value);
            }
            return Buffer.concat(chunks).toString("utf8");
          },
          async json(): Promise<unknown> {
            return JSON.parse(await response.text()) as unknown;
          },
        };
        resolve(response);
      },
    );
    req.on("error", fail);
    if (signal) {
      const onEarlyAbort = (): void => {
        aborted = true;
        req.destroy(new RequestAbortedError());
      };
      signal.addEventListener("abort", onEarlyAbort, { once: true });
    }
    if (payload) req.end(Buffer.from(payload));
    else req.end();
  });
}

/**
 * Transport errors carry the endpoint (configuration, never a credential)
 * and the underlying cause code (e.g. "connect ECONNREFUSED") so retry
 * classification sees the real pattern instead of an opaque "fetch failed".
 */
function normalizeError(err: unknown, url: URL): Error {
  if (err instanceof RequestAbortedError) return err;
  const cause = isRecord(err) ? err.cause : undefined;
  const code =
    isRecord(cause) && typeof cause.code === "string" ? cause.code : "";
  const message =
    err instanceof Error ? err.message : err ? String(err) : "request failed";
  const e = new Error(
    `request to ${url.origin}${url.pathname} failed: ${message}${code ? ` (${code})` : ""}`,
  );
  if (code) (e as Error & { code?: string }).code = code;
  return e;
}
