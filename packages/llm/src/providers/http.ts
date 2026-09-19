/**
 * @codepilot/llm — shared HTTP plumbing for provider adapters.
 *
 * Rules every adapter follows:
 * - Secrets travel only in request headers and NEVER appear in thrown
 *   errors, logs, or recorded metadata (headers are never serialized).
 * - All reads are abort-aware (caller signal) and bounded (per-read caps).
 * - Malformed wire payloads degrade to errors, never to hangs.
 */

export interface HttpPostOptions {
  headers?: Record<string, string>;
  /** AbortSignal for the whole request. */
  signal?: AbortSignal;
  /** Hard cap on the response body buffered for non-streaming calls. */
  maxBodyChars?: number;
}

/** POST JSON and parse the full response body as JSON. */
export async function postJson<T>(
  url: string,
  body: unknown,
  options: HttpPostOptions = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...options.headers },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (err) {
    throw mapTransportError(err, url);
  }
  const text = await readBoundedText(response, options.maxBodyChars ?? 4_000_000);
  if (!response.ok) {
    throw new Error(
      `provider request failed: HTTP ${response.status} ${snip(text, 300)}`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("provider returned malformed JSON");
  }
}

/** POST and yield raw text segments as they stream in (NDJSON/SSE-agnostic). */
export async function* postStreamText(
  url: string,
  body: unknown,
  options: HttpPostOptions & { maxStreamChars?: number } = {},
): AsyncGenerator<string, void, void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...options.headers },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (err) {
    throw mapTransportError(err, url);
  }
  if (!response.ok || !response.body) {
    const text = await readBoundedText(response, 4_000);
    throw new Error(
      `provider request failed: HTTP ${response.status} ${snip(text, 300)}`,
    );
  }
  const cap = options.maxStreamChars ?? 8_000_000;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        throw new Error("provider stream exceeded size bound");
      }
      buffered += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line.length > 0) yield line;
      }
    }
    const tail = (buffered + decoder.decode()).trim();
    if (tail.length > 0) yield tail;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // best effort
    }
  }
}

/** Parse one Server-Sent-Events line into its data payload (null for control). */
export function parseSseData(line: string): string | null {
  if (!line.startsWith("data:")) return null;
  const data = line.slice("data:".length).trim();
  if (data === "" || data === "[DONE]") return null;
  return data;
}

export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function snip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

async function readBoundedText(
  response: Response,
  maxChars: number,
): Promise<string> {
  const text = await response.text();
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid url)";
  }
}

function mapTransportError(err: unknown, url: string): Error {
  if (err instanceof Error) {
    if (err.name === "AbortError") return err;
    if (/timeout|timed out/i.test(err.message)) {
      return new Error(`provider request timed out (${hostOf(url)})`);
    }
  }
  const detail = err instanceof Error ? err.message : String(err);
  // Never propagate raw fetch internals (they can echo URLs/headers).
  return new Error(`provider transport failed (${hostOf(url)}): ${snip(detail, 160)}`);
}
