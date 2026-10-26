/**
 * @codepilot/llm — Google Gemini provider.
 *
 * Speaks `POST {baseUrl}/v1beta/models/{model}:streamGenerateContent?alt=sse`:
 * - body `{ system_instruction?, contents, tools?, generationConfig? }`
 * - SSE `data:` envelopes `{ candidates: [{ content: { parts },
 *   finishReason? }], usageMetadata? }`
 * - text parts `{ text }`, function calls `{ functionCall: { name, args } }`
 * - multiple function calls accumulate in call order and flush at stream end.
 */

import type {
  LlmChunk,
  LlmListedModel,
  LlmMessage,
  LlmProvider,
  LlmProviderOptions,
  LlmRequest,
  LlmToolCall,
} from "../types.js";
import { parseSseData, postStreamText, safeJsonParse } from "./http.js";

export const GOOGLE_DEFAULT_BASE_URL =
  "https://generativelanguage.googleapis.com";

function toWireContent(
  content: LlmMessage["content"],
): Array<Record<string, unknown>> {
  if (typeof content === "string") return [{ text: content }];
  const parts: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (block.type === "text") parts.push({ text: block.text });
    else if (block.type === "tool_use") {
      parts.push({
        functionCall: { name: block.name, args: block.input },
      });
    } else if (block.type === "tool_result") {
      parts.push({
        functionResponse: {
          name: block.name ?? block.tool_use_id,
          response: { output: block.content.slice(0, 6000) },
        },
      });
    } else if (block.type === "image") {
      parts.push({
        inlineData: { mimeType: block.mime, data: block.dataBase64 },
      });
    }
  }
  return parts.length > 0 ? parts : [{ text: "" }];
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

export function toGeminiSchema(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { type: "OBJECT", properties: {} };
  }

  const input = raw as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  // Gemini rejects unsupported JSON Schema keywords with HTTP 400.
  // Strip them so the converted schema is always Gemini-compatible.
  const UNSUPPORTED_GEMINI_KEYS = new Set([
    "additionalProperties",
    "$schema",
    "$defs",
    "definitions",
    "patternProperties",
    "unevaluatedProperties",
    "unevaluatedItems",
    "dependencies",
    "dependentRequired",
    "dependentSchemas",
    "propertyNames",
    "if",
    "then",
    "else",
    "not",
    "readOnly",
    "writeOnly",
    "contentMediaType",
    "contentEncoding",
  ]);

  const inputKeys = Object.keys(input);

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
    if (
      nonNullTypes.length > 0 &&
      nonNullTypes[0] &&
      JSON_TO_GEMINI_TYPE[nonNullTypes[0]]
    ) {
      resolvedType = JSON_TO_GEMINI_TYPE[nonNullTypes[0]];
    }
  }

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

  if (!resolvedType) {
    if (input.properties && typeof input.properties === "object") {
      resolvedType = "OBJECT";
    } else if (input.items) {
      resolvedType = "ARRAY";
    } else if (input.anyOf || input.oneOf) {
      // type can be omitted
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

  if (typeof input.minimum === "number") output.minimum = input.minimum;
  if (typeof input.maximum === "number") output.maximum = input.maximum;
  if (typeof input.minLength === "number") output.minLength = input.minLength;
  if (typeof input.maxLength === "number") output.maxLength = input.maxLength;
  if (typeof input.minItems === "number") output.minItems = input.minItems;
  if (typeof input.maxItems === "number") output.maxItems = input.maxItems;
  if (typeof input.minProperties === "number")
    output.minProperties = input.minProperties;
  if (typeof input.maxProperties === "number")
    output.maxProperties = input.maxProperties;
  if (typeof input.pattern === "string") output.pattern = input.pattern;
  if (input.example !== undefined) output.example = input.example;

  let propertiesMap: Record<string, unknown> | undefined;
  if (
    input.properties &&
    typeof input.properties === "object" &&
    !Array.isArray(input.properties)
  ) {
    propertiesMap = {};
    for (const [propName, propSchema] of Object.entries(
      input.properties as Record<string, unknown>,
    )) {
      if (propSchema !== undefined) {
        propertiesMap[propName] = toGeminiSchema(propSchema);
      }
    }
  }

  let requiredFields: string[] | undefined;
  if (Array.isArray(input.required)) {
    const req = (input.required as unknown[]).filter(
      (k): k is string => typeof k === "string" && k.length > 0,
    );
    if (req.length > 0) {
      requiredFields = req;
    }
  }

  if (Array.isArray(input.allOf)) {
    for (const sub of input.allOf as unknown[]) {
      if (sub && typeof sub === "object") {
        const subNormalized = toGeminiSchema(sub);
        if (
          subNormalized.properties &&
          typeof subNormalized.properties === "object"
        ) {
          propertiesMap = {
            ...(propertiesMap ?? {}),
            ...(subNormalized.properties as Record<string, unknown>),
          };
        }
        if (Array.isArray(subNormalized.required)) {
          requiredFields = Array.from(
            new Set([
              ...(requiredFields ?? []),
              ...(subNormalized.required as string[]),
            ]),
          );
        }
        if (
          !output.description &&
          typeof subNormalized.description === "string"
        ) {
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

  if (input.items) {
    if (Array.isArray(input.items)) {
      output.items = {
        anyOf: (input.items as unknown[]).map(toGeminiSchema),
      };
    } else if (typeof input.items === "object") {
      output.items = toGeminiSchema(input.items);
    }
  } else if (resolvedType === "ARRAY") {
    output.items = { type: "STRING" };
  }

  const anyOfRaw = Array.isArray(input.anyOf)
    ? input.anyOf
    : Array.isArray(input.oneOf)
      ? input.oneOf
      : null;
  if (anyOfRaw) {
    output.anyOf = (anyOfRaw as unknown[]).map(toGeminiSchema);
  }

  // Strip unsupported JSON Schema keywords that Google Gemini rejects with HTTP 400.
  for (const key of inputKeys) {
    if (UNSUPPORTED_GEMINI_KEYS.has(key)) {
      delete output[key];
    }
  }

  return output;
}

export function toGeminiFunctionDeclarationSchema(
  raw: unknown,
): Record<string, unknown> {
  const schema = toGeminiSchema(raw);
  if (schema.type !== "OBJECT") {
    schema.type = "OBJECT";
  }
  if (!schema.properties || typeof schema.properties !== "object") {
    schema.properties = {};
  }
  return schema;
}

export class GoogleProvider implements LlmProvider {
  readonly providerId: string;
  readonly modelId: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(options: LlmProviderOptions) {
    if (!options.modelId) throw new Error("provider requires modelId");
    this.providerId = options.providerId;
    this.modelId = options.modelId;
    const base = (options.baseUrl ?? GOOGLE_DEFAULT_BASE_URL)
      .trim()
      .replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) {
      throw new Error(
        `provider "${options.providerId}" requires an http(s) baseUrl`,
      );
    }
    this.baseUrl = base;
    this.apiKey = options.apiKey;
  }

  private url(overrideModel?: string): string {
    const model = overrideModel ?? this.modelId;
    const key = this.apiKey
      ? `?key=${encodeURIComponent(this.apiKey)}&alt=sse`
      : "?alt=sse";
    return `${this.baseUrl}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent${key}`;
  }

  async *completeStream(request: LlmRequest): AsyncIterable<LlmChunk> {
    const body: Record<string, unknown> = {
      contents: request.messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: toWireContent(m.content),
      })),
      generationConfig: {
        ...(request.temperature !== undefined
          ? { temperature: request.temperature }
          : {}),
        ...(request.maxTokens !== undefined
          ? { maxOutputTokens: request.maxTokens }
          : {}),
      },
    };
    if (request.systemPrompt) {
      body.system_instruction = { parts: [{ text: request.systemPrompt }] };
    }
    if (request.tools && request.tools.length > 0) {
      body.tools = [
        {
          function_declarations: request.tools.map((t) => ({
            name: t.name,
            description: t.description?.trim() || t.name,
            parameters: toGeminiFunctionDeclarationSchema(t.inputSchema),
          })),
        },
      ];
    }

    let lines: AsyncIterable<string>;
    try {
      lines = postStreamText(this.url(), body, { signal: request.signal });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        yield { type: "done", success: false, error: "aborted" };
        return;
      }
      throw err;
    }

    const calls: LlmToolCall[] = [];
    const currentUsage: { inputTokens: number; outputTokens: number } = {
      inputTokens: 0,
      outputTokens: 0,
    };
    let failed: string | null = null;
    let callIndex = 0;

    const processLine = (line: string): { text?: string } | undefined => {
      const data = parseSseData(line);
      if (data === null) return undefined;
      const parsed = safeJsonParse(data) as {
        candidates?: Array<{
          content?: { parts?: Array<Record<string, unknown>> };
          finishReason?: unknown;
        }>;
        usageMetadata?: {
          promptTokenCount?: unknown;
          candidatesTokenCount?: unknown;
        };
        error?: { message?: unknown };
      } | null;
      if (!parsed || typeof parsed !== "object") return undefined;
      if (parsed.error && typeof parsed.error === "object") {
        const errorObj = parsed.error as {
          message?: unknown;
          code?: unknown;
          status?: unknown;
        };
        const message = errorObj.message;
        // Only a STRUCTURED 503 signals genuine unavailability. Gemini
        // reports real unavailability with code 503 or status UNAVAILABLE;
        // HTTP-level 503 is handled by postStreamText throwing "HTTP 503".
        // Free-text tokens ("503"/"unavailable"/"high demand") must NOT
        // widen this: unrelated 400/429/500 errors whose detail merely
        // contains such a token would be mislabeled "temporarily busy".
        const is503 =
          errorObj.code === 503 || errorObj.status === "UNAVAILABLE";
        if (is503) {
          failed =
            "Gemini is temporarily busy. Try again shortly or select another available model.";
          return undefined;
        }
        failed =
          typeof message === "string"
            ? message.slice(0, 500)
            : "google stream error";
        return undefined;
      }
      let lineText = "";
      for (const candidate of parsed.candidates ?? []) {
        for (const part of candidate.content?.parts ?? []) {
          if (typeof part.text === "string" && part.text) {
            lineText += part.text;
          }
          const fn = part.functionCall as
            { name?: unknown; args?: unknown } | undefined;
          if (fn && typeof fn.name === "string" && fn.name) {
            callIndex += 1;
            const input =
              fn.args && typeof fn.args === "object" && !Array.isArray(fn.args)
                ? (fn.args as Record<string, unknown>)
                : {};
            calls.push({ id: `call-${callIndex}`, name: fn.name, input });
          }
        }
      }
      const meta = parsed.usageMetadata;
      if (meta && typeof meta === "object") {
        currentUsage.inputTokens =
          typeof meta.promptTokenCount === "number" ? meta.promptTokenCount : 0;
        currentUsage.outputTokens =
          typeof meta.candidatesTokenCount === "number"
            ? meta.candidatesTokenCount
            : 0;
      }
      return lineText ? { text: lineText } : undefined;
    };

    try {
      try {
        for await (const line of lines) {
          if (request.signal?.aborted) {
            yield { type: "done", success: false, error: "aborted" };
            return;
          }
          const res = processLine(line);
          if (res?.text) yield { type: "text", text: res.text };
          if (failed) break;
        }
      } catch (err) {
        if (err instanceof Error && /HTTP 503/i.test(err.message)) {
          const busyErr = new Error(
            "Gemini is temporarily busy. Try again shortly or select another available model.",
          );
          (busyErr as { status?: number }).status = 503;
          throw busyErr;
        }
        if (
          err instanceof Error &&
          /HTTP 404/i.test(err.message) &&
          (this.modelId === "gemini-2.5-flash" ||
            this.modelId === "gemini-2.5-pro" ||
            this.modelId === "gemini-2.0-flash")
        ) {
          lines = postStreamText(this.url("gemini-3.8-flash"), body, {
            signal: request.signal,
          });
          for await (const line of lines) {
            if (request.signal?.aborted) {
              yield { type: "done", success: false, error: "aborted" };
              return;
            }
            const res = processLine(line);
            if (res?.text) yield { type: "text", text: res.text };
            if (failed) break;
          }
        } else {
          throw err;
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        yield { type: "done", success: false, error: "aborted" };
        return;
      }
      throw err;
    }

    if (failed) {
      yield { type: "done", success: false, error: failed };
      return;
    }
    for (const toolCall of calls) {
      yield { type: "toolcall", toolCall };
    }
    if (currentUsage.inputTokens > 0 || currentUsage.outputTokens > 0) {
      yield {
        type: "usage",
        inputTokens: currentUsage.inputTokens,
        outputTokens: currentUsage.outputTokens,
      };
    }
    yield { type: "done", success: true, stopReason: "completed" };
  }

  async listModels(signal?: AbortSignal): Promise<LlmListedModel[]> {
    if (!this.apiKey) {
      return [];
    }
    const url = `${GOOGLE_DEFAULT_BASE_URL}/v1beta/models?key=${this.apiKey}`;
    const res = await fetch(url, { signal });
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
      // Only generation-capable models
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
    _signal?: AbortSignal,
  ): Promise<{ ok: boolean; latencyMs?: number }> {
    // No cheap unauthenticated probe exists for API-key Gemini; report
    // unavailable rather than burning a keyed call from a health check.
    return { ok: false };
  }
}
