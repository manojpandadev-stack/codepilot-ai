/**
 * CodePilot LLM — Google Gemini adapter.
 *
 * Independently written client for the public Gemini generateContent wire
 * protocol:
 *
 *   POST {base}/v1beta/models/{model}:streamGenerateContent?alt=sse&key=…
 *
 * Streaming semantics:
 *   SSE `data:` lines each carry a GenerateContentResponse with
 *   `candidates[0].content.parts[]` where part.text is incremental content;
 *   parts may also arrive as `functionCall: {name, args}` (complete objects,
 *   no partial assembly needed). `usageMetadata` carries
 *   promptTokenCount/candidatesTokenCount. Aborted via AbortSignal.
 */

import type { AgentMessage, AgentTool } from "../types.js";
import {
  LlmError,
  type LlmListedModel,
  type LlmProvider,
  type LlmRequest,
  type LlmStreamEvent,
} from "./types.js";

export interface GoogleLlmOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const GOOGLE_DEFAULT_BASE = "https://generativelanguage.googleapis.com";

interface WirePart {
  text?: string;
  thought?: boolean;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  thoughtSignature?: string;
  thought_signature?: string;
}

interface WireResponse {
  candidates?: Array<{
    content?: { parts?: WirePart[]; role?: string };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  error?: { message?: string };
}

export function toGeminiContents(messages: AgentMessage[]): {
  system?: string;
  contents: Array<Record<string, unknown>>;
} {
  let system: string | undefined;
  const contents: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      if (
        contents.length === 0 &&
        msg.role === "user" &&
        !system &&
        msg.content.length === 0
      )
        continue;
      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }],
      });
      continue;
    }
    if (msg.role === "assistant") {
      const parts: Array<Record<string, unknown>> = [];
      for (const b of msg.content) {
        if (b.type === "text") parts.push({ text: b.text });
        else if (b.type === "image") {
          throw new Error("image blocks are only supported in user messages");
        } else if (b.type === "tool_use") {
          parts.push({
            functionCall: { name: b.name, args: b.input ?? {} },
            ...(b.thoughtSignature ? { thoughtSignature: b.thoughtSignature } : {}),
          });
        }
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
      continue;
    }
    // user: text + images (inlineData parts) + tool results (functionResponse parts).
    // Text is always emitted before images (deterministic ordering).
    const parts: Array<Record<string, unknown>> = [];
    for (const b of msg.content) {
      if (b.type === "text") parts.push({ text: b.text });
    }
    for (const b of msg.content) {
      if (b.type === "image") {
        if (typeof b.dataBase64 !== "string" || b.dataBase64.length === 0) {
          throw new Error(
            "image block has no inline bytes (fileRef-only blocks must be resolved to bytes by the host before the provider request)",
          );
        }
        parts.push({
          inlineData: {
            mimeType: b.mime ?? "image/png",
            data: b.dataBase64,
          },
        });
      } else if (b.type === "tool_result") {
        parts.push({
          functionResponse: {
            name: b.name,
            response: b.is_error ? { error: b.content } : { result: b.content },
          },
        });
      }
    }
    if (parts.length > 0) contents.push({ role: "user", parts });
  }
  return { system, contents };
}

const JSON_TO_GEMINI_TYPE: Readonly<Record<string, string>> = {
  string: "STRING",
  number: "NUMBER",
  integer: "INTEGER",
  boolean: "BOOLEAN",
  array: "ARRAY",
  object: "OBJECT",
};

const VALID_GEMINI_TYPES = new Set([
  "TYPE_UNSPECIFIED",
  "STRING",
  "NUMBER",
  "INTEGER",
  "BOOLEAN",
  "ARRAY",
  "OBJECT",
]);

/**
 * Recursively normalizes a JSON Schema node into a Google Gemini API-compatible
 * OpenAPI 3.03 Schema object.
 *
 * Strips unsupported keywords:
 *   - additionalProperties (Gemini HTTP 400 trigger)
 *   - $schema, $defs, definitions, $ref
 *   - patternProperties, unevaluatedProperties, unevaluatedItems
 *   - dependencies, dependentRequired, dependentSchemas, propertyNames
 *   - if, then, else, not
 *   - readOnly, writeOnly, contentMediaType, contentEncoding
 *
 * Converts:
 *   - lowercase JSON Schema types -> uppercase Gemini types (string -> STRING, etc.)
 *   - type arrays with "null" (e.g. ["string", "null"]) -> nullable: true + type: STRING
 *   - const: "val" -> enum: ["val"]
 *   - oneOf -> anyOf
 *   - allOf -> merged properties and required
 *   - enum values -> string[] (Gemini requires string enum items)
 *   - items -> recursive Gemini Schema
 *   - properties -> recursive Record<string, Gemini Schema>
 */
export function toGeminiSchema(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { type: "OBJECT", properties: {} };
  }

  const input = raw as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  // 1. Resolve nullable and type
  let inferredNullable: boolean | undefined =
    typeof input.nullable === "boolean" ? input.nullable : undefined;
  let resolvedType: string | undefined;

  if (typeof input.type === "string") {
    const lower = input.type.toLowerCase();
    if (JSON_TO_GEMINI_TYPE[lower]) {
      resolvedType = JSON_TO_GEMINI_TYPE[lower];
    } else if (VALID_GEMINI_TYPES.has(input.type.toUpperCase())) {
      resolvedType = input.type.toUpperCase();
    }
  } else if (Array.isArray(input.type)) {
    const types = (input.type as unknown[]).map((t) => String(t).toLowerCase());
    if (types.includes("null")) {
      inferredNullable = true;
    }
    const nonNullTypes = types.filter((t) => t !== "null");
    if (nonNullTypes.length > 0 && nonNullTypes[0] && JSON_TO_GEMINI_TYPE[nonNullTypes[0]]) {
      resolvedType = JSON_TO_GEMINI_TYPE[nonNullTypes[0]];
    }
  }

  // 2. Handle const -> enum
  let enumValues: string[] | undefined;
  if (Array.isArray(input.enum)) {
    enumValues = (input.enum as unknown[]).map((v) => String(v));
    if (!resolvedType) resolvedType = "STRING";
  } else if (input.const !== undefined) {
    enumValues = [String(input.const)];
    if (!resolvedType) {
      if (typeof input.const === "number") {
        resolvedType = Number.isInteger(input.const) ? "INTEGER" : "NUMBER";
      } else if (typeof input.const === "boolean") {
        resolvedType = "BOOLEAN";
      } else {
        resolvedType = "STRING";
      }
    }
  }

  // 3. Infer type if not yet known
  if (!resolvedType) {
    if (input.properties && typeof input.properties === "object") {
      resolvedType = "OBJECT";
    } else if (input.items) {
      resolvedType = "ARRAY";
    } else if (input.anyOf || input.oneOf) {
      // type can be omitted when anyOf is present
    } else {
      resolvedType = "STRING";
    }
  }

  if (resolvedType) {
    output.type = resolvedType;
  }

  if (inferredNullable !== undefined) {
    output.nullable = inferredNullable;
  }

  if (enumValues) {
    output.enum = enumValues;
  }

  // 4. Description & Title
  if (typeof input.description === "string" && input.description.length > 0) {
    output.description = input.description;
  }
  if (typeof input.title === "string" && input.title.length > 0) {
    output.title = input.title;
  }
  if (typeof input.format === "string" && input.format.length > 0) {
    output.format = input.format;
  }
  if (input.default !== undefined) {
    output.default = input.default;
  }

  // 5. Constraints
  if (typeof input.minimum === "number") output.minimum = input.minimum;
  if (typeof input.maximum === "number") output.maximum = input.maximum;
  if (typeof input.minLength === "number") output.minLength = input.minLength;
  if (typeof input.maxLength === "number") output.maxLength = input.maxLength;
  if (typeof input.minItems === "number") output.minItems = input.minItems;
  if (typeof input.maxItems === "number") output.maxItems = input.maxItems;
  if (typeof input.minProperties === "number") output.minProperties = input.minProperties;
  if (typeof input.maxProperties === "number") output.maxProperties = input.maxProperties;
  if (typeof input.pattern === "string") output.pattern = input.pattern;
  if (input.example !== undefined) output.example = input.example;

  // 6. Properties & Required (for OBJECT)
  let propertiesMap: Record<string, unknown> | undefined;
  if (input.properties && typeof input.properties === "object" && !Array.isArray(input.properties)) {
    propertiesMap = {};
    for (const [propName, propSchema] of Object.entries(input.properties as Record<string, unknown>)) {
      if (propSchema !== undefined) {
        propertiesMap[propName] = toGeminiSchema(propSchema);
      }
    }
  }

  let requiredFields: string[] | undefined;
  if (Array.isArray(input.required)) {
    const req = (input.required as unknown[])
      .filter((k): k is string => typeof k === "string" && k.length > 0);
    if (req.length > 0) {
      requiredFields = req;
    }
  }

  // 7. allOf merging (merge properties and required from allOf subschemas)
  if (Array.isArray(input.allOf)) {
    for (const sub of input.allOf as unknown[]) {
      if (sub && typeof sub === "object") {
        const subNormalized = toGeminiSchema(sub);
        if (subNormalized.properties && typeof subNormalized.properties === "object") {
          propertiesMap = {
            ...(propertiesMap ?? {}),
            ...(subNormalized.properties as Record<string, unknown>),
          };
        }
        if (Array.isArray(subNormalized.required)) {
          requiredFields = Array.from(
            new Set([...(requiredFields ?? []), ...(subNormalized.required as string[])]),
          );
        }
        if (!output.description && typeof subNormalized.description === "string") {
          output.description = subNormalized.description;
        }
      }
    }
  }

  if (propertiesMap || resolvedType === "OBJECT") {
    output.properties = propertiesMap ?? {};
  }
  if (requiredFields && requiredFields.length > 0) {
    output.required = requiredFields;
  }

  // 8. Items (for ARRAY)
  if (input.items) {
    if (Array.isArray(input.items)) {
      // Tuple schema in JSON Schema -> anyOf in Gemini items
      output.items = {
        anyOf: (input.items as unknown[]).map(toGeminiSchema),
      };
    } else if (typeof input.items === "object") {
      output.items = toGeminiSchema(input.items);
    }
  } else if (resolvedType === "ARRAY") {
    // Gemini Schema requires items when type is ARRAY
    output.items = { type: "STRING" };
  }

  // 9. anyOf / oneOf
  const anyOfRaw = Array.isArray(input.anyOf)
    ? input.anyOf
    : Array.isArray(input.oneOf)
      ? input.oneOf
      : null;
  if (anyOfRaw) {
    output.anyOf = (anyOfRaw as unknown[]).map(toGeminiSchema);
  }

  return output;
}

/**
 * Top-level function declaration parameter schema conversion.
 * Gemini requires the top-level parameters to be an OBJECT with properties.
 */
export function toGeminiFunctionDeclarationSchema(raw: unknown): Record<string, unknown> {
  const schema = toGeminiSchema(raw);
  if (schema.type !== "OBJECT") {
    schema.type = "OBJECT";
  }
  if (!schema.properties || typeof schema.properties !== "object") {
    schema.properties = {};
  }
  return schema;
}

export class GoogleLlmProvider implements LlmProvider {
  readonly id = "google";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: GoogleLlmOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? GOOGLE_DEFAULT_BASE).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 180_000;
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const tools = request.tools ?? [];
    const { contents } = toGeminiContents(request.messages);
    const body: Record<string, unknown> = {
      contents,
      ...(request.systemPrompt
        ? { systemInstruction: { parts: [{ text: request.systemPrompt }] } }
        : {}),
      ...(request.temperature !== undefined || request.maxTokens !== undefined
        ? {
            generationConfig: {
              ...(request.temperature !== undefined
                ? { temperature: request.temperature }
                : {}),
              ...(request.maxTokens !== undefined
                ? { maxOutputTokens: request.maxTokens }
                : {}),
            },
          }
        : {}),
      ...(tools.length > 0
        ? {
            tools: [
              {
                functionDeclarations: tools.map((tool: AgentTool) => ({
                  name: tool.name,
                  description: tool.description?.trim() || tool.name,
                  parameters: toGeminiFunctionDeclarationSchema(tool.inputSchema),
                })),
              },
            ],
          }
        : {}),
    };

    const url =
      `${this.baseUrl}/v1beta/models/${encodeURIComponent(request.modelId)}` +
      `:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`;

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) controller.abort();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // Google retired gemini-2.5-flash / gemini-2.5-pro for keys created after mid-2025 (HTTP 404).
      // Transparently fall back to gemini-3.8-flash so user chat requests never 404 fail.
      if (
        response.status === 404 &&
        (request.modelId === "gemini-2.5-flash" ||
          request.modelId === "gemini-2.5-pro" ||
          request.modelId === "gemini-2.0-flash")
      ) {
        const fallbackUrl =
          `${this.baseUrl}/v1beta/models/gemini-3.8-flash` +
          `:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`;
        const fallbackRes = await this.fetchImpl(fallbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        response = fallbackRes;
      }
    } catch (err) {
      cleanup();
      if (request.signal?.aborted) {
        yield { type: "finish", reason: "aborted" };
        return;
      }
      throw new LlmError(
        this.id,
        `request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!response.ok || !response.body) {
      cleanup();
      if (response.status === 503) {
        throw new LlmError(
          this.id,
          "Gemini is temporarily busy. Try again shortly or select another available model.",
          {
            status: 503,
            transient: true,
          },
        );
      }
      const detail = await response.text().catch(() => "");
      // Never include the key in errors — the URL is not echoed.
      throw new LlmError(
        this.id,
        `generateContent failed ${response.status}: ${detail.slice(0, 300)}`,
        {
          status: response.status,
        },
      );
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let abortRequested = false;

    function cleanup(): void {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
    }

    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const rawLine = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (rawLine.length === 0 || !rawLine.startsWith("data:")) continue;
          const payload = rawLine.slice(5).trim();
          if (payload.length === 0 || payload === "[DONE]") continue;
          let evt: WireResponse;
          try {
            evt = JSON.parse(payload) as WireResponse;
          } catch {
            continue;
          }
          if (evt.error) {
            // Only a STRUCTURED 503 signals genuine unavailability. A previous
            // free-text scan of the provider message relabeled unrelated Gemini
            // errors (context/token-limit 400 INVALID_ARGUMENT, quota 429,
            // internal 500) whose text merely contained "503"/"unavailable"/
            // "high demand" as a transient "temporarily busy" — masking the real,
            // per-request cause of long-prompt failures. Gemini reports real
            // unavailability with code 503 or status UNAVAILABLE; HTTP-level 503
            // is already handled above via response.status.
            const is503 =
              (evt.error as { code?: unknown; status?: unknown }).code === 503 ||
              (evt.error as { code?: unknown; status?: unknown }).status === "UNAVAILABLE";
            if (is503) {
              throw new LlmError(
                this.id,
                "Gemini is temporarily busy. Try again shortly or select another available model.",
                {
                  status: 503,
                  transient: true,
                },
              );
            }
            throw new LlmError(this.id, evt.error.message ?? "stream error");
          }
          const parts = evt.candidates?.[0]?.content?.parts ?? [];
          for (const part of parts) {
            if (typeof part.text === "string" && part.text.length > 0) {
              if (part.thought === true) {
                yield { type: "reasoning-delta", text: part.text };
              } else {
                yield { type: "text-delta", text: part.text };
              }
            }
            if (part.functionCall?.name) {
              const sig = part.thoughtSignature ?? part.thought_signature;
              yield {
                type: "tool-call",
                call: {
                  toolCallId: `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                  toolName: part.functionCall.name,
                  argumentsText: JSON.stringify(part.functionCall.args ?? {}),
                  ...(sig ? { thoughtSignature: sig } : {}),
                },
              };
            }
          }
          if (evt.usageMetadata) {
            inputTokens = evt.usageMetadata.promptTokenCount ?? inputTokens;
            outputTokens =
              (evt.usageMetadata.candidatesTokenCount ?? 0) +
              (evt.usageMetadata.thoughtsTokenCount ?? 0);
          }
        }
        if (request.signal?.aborted) {
          abortRequested = true;
          break;
        }
      }
      if (inputTokens > 0 || outputTokens > 0) {
        yield {
          type: "usage",
          usage: {
            inputTokens,
            outputTokens,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        };
      }
      yield { type: "finish", reason: abortRequested ? "aborted" : "complete" };
    } catch (err) {
      if (request.signal?.aborted) {
        yield { type: "finish", reason: "aborted" };
        return;
      }
      yield {
        type: "finish",
        reason: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      cleanup();
    }
  }

  async listModels(signal?: AbortSignal): Promise<LlmListedModel[]> {
    if (!this.apiKey) {
      return [];
    }
    const url = `${GOOGLE_DEFAULT_BASE}/v1beta/models?key=${this.apiKey}`;
    const res = await this.fetchImpl(url, { signal });
    if (!res.ok) {
      return [];
    }
    const body: unknown = await res.json();
    const modelsObj =
      typeof body === "object" && body !== null && "models" in body
        ? (body as { models?: unknown[] }).models
        : null;
    if (!Array.isArray(modelsObj)) {
      return [];
    }
    return modelsObj.flatMap((m) => {
      if (
        typeof m !== "object" ||
        m === null ||
        typeof (m as { name?: unknown }).name !== "string"
      ) {
        return [];
      }
      const name = (m as { name: string }).name;
      if (!/models\//.test(name)) {
        return [];
      }
      const modelId = name.replace(/^models\//, "");
      if (/embed|vision-duck|aqa/i.test(modelId)) {
        return [];
      }
      const displayName =
        typeof (m as { displayName?: unknown }).displayName === "string"
          ? (m as { displayName: string }).displayName
          : undefined;
      return [
        {
          id: modelId,
          name: displayName ?? modelId,
          capabilities: {},
        },
      ];
    });
  }

  async checkHealth(
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; latencyMs?: number }> {
    if (!this.apiKey) {
      return { ok: false };
    }
    try {
      const url = `${GOOGLE_DEFAULT_BASE}/v1beta/models?key=${this.apiKey}`;
      const start = Date.now();
      const res = await this.fetchImpl(url, { signal });
      const latencyMs = Date.now() - start;
      return { ok: res.ok, latencyMs };
    } catch {
      return { ok: false };
    }
  }
}
