/**
 * M3 ToolDefinition `web_fetch` — canonical registry entry.
 *
 * Reuses the audited SSRF pipeline in @codepilot/context-engine (webFetch →
 * ssrfSafeFetch): strict IP classification, DNS every-address validation,
 * IP pinning, per-redirect re-validation, bounded timeout/size/redirects.
 * Minimal request headers only — never forwards Authorization, cookies,
 * API keys, or SecretStorage values.
 */

import type { ToolDefinition, ToolError } from "../types.js";
import { toolError } from "../types.js";
import { webFetch } from "@codepilot/context-engine";

function checkAborted(ctx: { signal: AbortSignal }, where: string): void {
  if (ctx.signal.aborted) {
    throw new DOMException(`Cancelled ${where}`, "AbortError");
  }
}

export interface WebFetchM3Input {
  url: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export function createWebFetchTool(): ToolDefinition<WebFetchM3Input, unknown> {
  return {
    id: "web_fetch",
    name: "Web Fetch",
    description:
      "Fetch a public HTTPS webpage or text API response when current external information or documentation is required. Prefer local project information when it already contains the answer.",
    category: "analysis",
    version: "1.0.0",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Absolute http(s) URL to fetch (max 2048 chars).",
        },
        timeoutMs: {
          type: "number",
          description: "Timeout in ms (1000-30000, default 15000).",
        },
        maxBytes: {
          type: "number",
          description: "Max response bytes (1024-2097152, default 1048576).",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        finalUrl: { type: "string" },
        status: { type: "number" },
        contentType: { type: "string" },
        title: { type: "string" },
        text: { type: "string" },
        truncated: { type: "boolean" },
      },
      required: [
        "url",
        "finalUrl",
        "status",
        "contentType",
        "text",
        "truncated",
      ],
    },
    capabilities: ["network", "cancellable"],
    permission: {
      level: "network",
      requiresApproval: false,
      rationale: "Fetch a public web resource (SSRF-guarded, M4 auto-allow)",
    },
    idempotent: true,
    validate(input, _cwd): ToolError | null {
      const executionId = "validation";
      if (
        !input ||
        typeof input.url !== "string" ||
        input.url.trim().length === 0
      ) {
        return toolError(
          "VALIDATION",
          "web_fetch requires { url }",
          executionId,
          {
            recoverable: false,
          },
        );
      }
      if (input.url.length > 2048) {
        return toolError(
          "VALIDATION",
          "URL too long (max 2048 chars)",
          executionId,
          {
            recoverable: false,
          },
        );
      }
      let parsed: URL;
      try {
        parsed = new URL(input.url);
      } catch {
        return toolError(
          "VALIDATION",
          `Invalid URL: ${input.url.slice(0, 200)}`,
          executionId,
          {
            recoverable: false,
          },
        );
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return toolError(
          "VALIDATION",
          "Only HTTP/HTTPS URLs are allowed",
          executionId,
          {
            recoverable: false,
          },
        );
      }
      return null;
    },
    async execute(input, ctx): Promise<unknown> {
      checkAborted(ctx, "before web_fetch");
      ctx.progress({ message: `Fetching ${input.url.slice(0, 128)}` });
      const result = await webFetch(input.url, {
        ...(input.timeoutMs !== undefined
          ? { timeoutMs: input.timeoutMs }
          : {}),
        ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
        signal: ctx.signal,
      });
      checkAborted(ctx, "after web_fetch");
      return result;
    },
  };
}
