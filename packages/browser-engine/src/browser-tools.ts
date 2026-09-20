/**
 * @codepilot/browser-engine — M3 browser tools.
 *
 * Every browser operation is a ToolDefinition executed through
 * ToolRegistry → ToolExecutionService → M4 (RiskEngine → PolicyEngine →
 * ApprovalManager → SecurityValidator). Read-like operations map to the
 * M4 `web_fetch` action (medium risk); state-changing interactions map to
 * `network_request` (high risk → ASK by default). The M4 mapping is added
 * in @codepilot/tool-engine (LIVE_TOOL_ID_MAP + TOOL_ID_ACTION_MAP) — the
 * tools here only declare their permission requirements honestly.
 *
 * Security notes:
 * - Input validation happens twice by design: schema validation in the
 *   executor AND deep validation in the BrowserService (fail-closed).
 * - Secrets never enter results: page text is passed through redactSecrets.
 * - ctx.signal is honored on every operation.
 */

import type {
  ToolDefinition,
  ToolContext,
  ToolErrorCode,
} from "@codepilot/tool-engine";
import { toolError, redactSecrets } from "@codepilot/tool-engine";
import type { BrowserService } from "./browser-service.js";
import {
  safeTargetOf,
  hostnameOf,
  isForbiddenIPLiteral,
} from "./url-policy.js";

// ============================================================================
// Shared input validation
// ============================================================================

const MAX_SELECTOR_LEN = 500;
const MAX_URL_LEN = 2048;
const MAX_TEXT_LEN = 100_000;

function err(code: ToolErrorCode, message: string, executionId: string) {
  return toolError(code, message, executionId, {
    recoverable:
      code === "TIMEOUT" || code === "VALIDATION" || code === "INTERNAL",
    retryable: code === "TIMEOUT",
    cancelled: code === "CANCELLED",
    timedOut: code === "TIMEOUT",
  });
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function requireString(
  input: Record<string, unknown>,
  key: string,
  maxLen: number,
  executionId: string,
): string {
  const v = asString(input[key]);
  if (v === null || v.trim().length === 0) {
    throw err(
      "VALIDATION",
      `Missing required string parameter '${key}'`,
      executionId,
    );
  }
  if (v.length > maxLen) {
    throw err(
      "VALIDATION",
      `Parameter '${key}' exceeds ${maxLen} characters`,
      executionId,
    );
  }
  return v;
}

function requireNumber(
  input: Record<string, unknown>,
  key: string,
  executionId: string,
  opts: { min?: number; max?: number } = {},
): number {
  const v = input[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw err(
      "VALIDATION",
      `Missing required numeric parameter '${key}'`,
      executionId,
    );
  }
  if (opts.min !== undefined && v < opts.min) {
    throw err(
      "VALIDATION",
      `Parameter '${key}' must be >= ${opts.min}`,
      executionId,
    );
  }
  if (opts.max !== undefined && v > opts.max) {
    throw err(
      "VALIDATION",
      `Parameter '${key}' must be <= ${opts.max}`,
      executionId,
    );
  }
  return v;
}

// ============================================================================
// Tool factory
// ============================================================================

export interface BrowserToolConfig {
  service: BrowserService;
  /** Selector sanitizer (optional). Return null to reject the selector. */
  selectorPolicy?: (selector: string) => string | null;
}

/** Common permission block generator. */
function permission(
  level: "read" | "network",
  requiresApproval: boolean,
  rationale: string,
) {
  return { level, requiresApproval, rationale };
}

export function createBrowserTools(
  config: BrowserToolConfig,
): ToolDefinition[] {
  const { service } = config;
  const selectorPolicy =
    config.selectorPolicy ??
    ((s: string) => (s.length <= MAX_SELECTOR_LEN ? s : null));

  function resolveSessionId(_ctx: ToolContext): string {
    // Session keyed by task; "default" within a task unless the model asks
    // for a named session (still task-scoped → no cross-task leakage).
    return "default";
  }

  // ---- browser_navigate ----------------------------------------------------

  const browserNavigate: ToolDefinition = {
    id: "browser_navigate",
    name: "browser_navigate",
    description:
      "Navigate the browser to an http(s) URL. The URL is validated against " +
      "the SSRF/domain policy; private and internal addresses are blocked. " +
      "Returns the final URL, HTTP status and page title.",
    category: "analysis",
    version: "1.0.0",
    capabilities: ["network", "cancellable"],
    permission: permission("network", false, "Navigate to a public web page"),
    idempotent: true,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to open" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    validate(input, _cwd) {
      const url = asString(input.url);
      if (!url) return err("VALIDATION", "url must be a string", "validate");
      if (url.length > MAX_URL_LEN)
        return err("VALIDATION", "url too long", "validate");
      const policyHost = safeTargetOf(url);
      if (policyHost === "(invalid url)") {
        return err("VALIDATION", "url is not a valid URL", "validate");
      }
      // Defense-in-depth: literal/host SSRF check at tool-validation time —
      // BEFORE M4, so a forbidden target is rejected even if a future M4
      // policy is misconfigured to auto-allow. Full DNS validation still
      // happens in BrowserService (fail-closed).
      const literal = isForbiddenIPLiteral(hostnameOf(url) ?? "");
      if (literal.forbidden) {
        return err(
          "PATH_SECURITY",
          `blocked by SSRF policy: ${literal.reason}`,
          "validate",
        );
      }
      return null;
    },
    async execute(input, ctx) {
      const executionId = ctx.executionId;
      try {
        const url = requireString(
          input as Record<string, unknown>,
          "url",
          MAX_URL_LEN,
          executionId,
        );
        const result = await service.navigate(
          ctx.taskId ?? "no-task",
          resolveSessionId(ctx),
          url,
          ctx.signal,
        );
        if (!result.ok) {
          const blocked = result.error?.includes("blocked") ?? false;
          throw err(
            blocked ? "PATH_SECURITY" : "TIMEOUT",
            result.error ?? "navigation failed",
            executionId,
          );
        }
        return {
          ok: true,
          url: result.url,
          status: result.status,
          title: result.title,
        };
      } catch (e) {
        if (isToolError(e)) throw e;
        throw err("INTERNAL", sanitize(e), executionId);
      }
    },
  };

  // ---- browser_back / browser_forward / browser_reload ---------------------

  const browserBack: ToolDefinition = {
    id: "browser_back",
    name: "browser_back",
    description: "Go back one page in browser history.",
    category: "analysis",
    version: "1.0.0",
    capabilities: ["network", "cancellable"],
    permission: permission("network", false, "Browser history back"),
    idempotent: true,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(_input, ctx) {
      const result = await service.goBack(
        ctx.taskId ?? "no-task",
        resolveSessionId(ctx),
        ctx.signal,
      );
      if (!result.ok)
        throw err("INTERNAL", result.error ?? "back failed", ctx.executionId);
      return { ok: true, url: result.url, title: result.title };
    },
  };

  const browserForward: ToolDefinition = {
    ...browserBack,
    id: "browser_forward",
    name: "browser_forward",
    description: "Go forward one page in browser history.",
  };

  const browserReload: ToolDefinition = {
    ...browserBack,
    id: "browser_reload",
    name: "browser_reload",
    description: "Reload the current page.",
  };

  // ---- browser_click -------------------------------------------------------

  const browserClick: ToolDefinition = {
    id: "browser_click",
    name: "browser_click",
    description:
      "Click an element on the current page. May change remote state " +
      "(buttons, links, forms) — requires approval by default.",
    category: "analysis",
    version: "1.0.0",
    capabilities: ["network", "cancellable"],
    permission: permission(
      "network",
      true,
      "Click may change remote state on a website",
    ),
    idempotent: false,
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector of the element to click",
        },
      },
      required: ["selector"],
      additionalProperties: false,
    },
    validate(input) {
      const selector = asString(input.selector);
      if (!selector)
        return err("VALIDATION", "selector must be a string", "validate");
      if (selectorPolicy(selector) === null) {
        return err("VALIDATION", "selector rejected by policy", "validate");
      }
      return null;
    },
    async execute(input, ctx) {
      try {
        const selector = requireString(
          input as Record<string, unknown>,
          "selector",
          MAX_SELECTOR_LEN,
          ctx.executionId,
        );
        const result = await service.click(
          ctx.taskId ?? "no-task",
          resolveSessionId(ctx),
          selector,
          ctx.signal,
        );
        if (!result.ok) {
          throw err(
            result.error?.includes("cancelled") ? "CANCELLED" : "INTERNAL",
            result.error ?? "click failed",
            ctx.executionId,
          );
        }
        return { ok: true };
      } catch (e) {
        if (isToolError(e)) throw e;
        throw err("INTERNAL", sanitize(e), ctx.executionId);
      }
    },
  };

  // ---- browser_type --------------------------------------------------------

  const browserType: ToolDefinition = {
    id: "browser_type",
    name: "browser_type",
    description:
      "Fill a form field with text. The typed value is never logged. " +
      "Typing into forms may change remote state — requires approval.",
    category: "analysis",
    version: "1.0.0",
    capabilities: ["network", "cancellable"],
    permission: permission(
      "network",
      true,
      "Fill a form field on a website (value is not logged)",
    ),
    idempotent: false,
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector of the input element",
        },
        text: { type: "string", description: "Text to enter (never logged)" },
        submit: { type: "boolean", description: "Press Enter afterwards" },
      },
      required: ["selector", "text"],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      try {
        const rec = input as Record<string, unknown>;
        const selector = requireString(
          rec,
          "selector",
          MAX_SELECTOR_LEN,
          ctx.executionId,
        );
        const text = requireString(rec, "text", MAX_TEXT_LEN, ctx.executionId);
        const fillResult = await service.fill(
          ctx.taskId ?? "no-task",
          resolveSessionId(ctx),
          selector,
          text,
          ctx.signal,
        );
        if (!fillResult.ok) {
          throw err(
            "INTERNAL",
            fillResult.error ?? "fill failed",
            ctx.executionId,
          );
        }
        if (input.submit === true) {
          await service.press(
            ctx.taskId ?? "no-task",
            resolveSessionId(ctx),
            "Enter",
            ctx.signal,
          );
        }
        return { ok: true };
      } catch (e) {
        if (isToolError(e)) throw e;
        throw err("INTERNAL", sanitize(e), ctx.executionId);
      }
    },
  };

  // ---- browser_press / browser_scroll / browser_wait -----------------------

  const browserPress: ToolDefinition = {
    id: "browser_press",
    name: "browser_press",
    description:
      "Press a keyboard key in the browser (e.g. Enter, Escape). May submit " +
      "forms — requires approval.",
    category: "analysis",
    version: "1.0.0",
    capabilities: ["network", "cancellable"],
    permission: permission(
      "network",
      true,
      "Key press may submit forms or trigger actions",
    ),
    idempotent: false,
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key name, e.g. Enter" },
      },
      required: ["key"],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      try {
        const key = requireString(
          input as Record<string, unknown>,
          "key",
          64,
          ctx.executionId,
        );
        const result = await service.press(
          ctx.taskId ?? "no-task",
          resolveSessionId(ctx),
          key,
          ctx.signal,
        );
        if (!result.ok)
          throw err(
            "INTERNAL",
            result.error ?? "press failed",
            ctx.executionId,
          );
        return { ok: true };
      } catch (e) {
        if (isToolError(e)) throw e;
        throw err("INTERNAL", sanitize(e), ctx.executionId);
      }
    },
  };

  const browserScroll: ToolDefinition = {
    id: "browser_scroll",
    name: "browser_scroll",
    description: "Scroll the page by pixels. Read-like navigation aid.",
    category: "analysis",
    version: "1.0.0",
    capabilities: ["cancellable"],
    permission: permission("read", false, "Scroll the current page"),
    idempotent: true,
    inputSchema: {
      type: "object",
      properties: {
        deltaX: { type: "number", description: "Horizontal pixels" },
        deltaY: {
          type: "number",
          description: "Vertical pixels (positive = down)",
        },
      },
      required: ["deltaY"],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const rec = input as Record<string, unknown>;
      const deltaY = requireNumber(rec, "deltaY", ctx.executionId, {
        min: -50_000,
        max: 50_000,
      });
      const deltaX = typeof rec.deltaX === "number" ? rec.deltaX : 0;
      const result = await service.scroll(
        ctx.taskId ?? "no-task",
        resolveSessionId(ctx),
        deltaX,
        deltaY,
        ctx.signal,
      );
      if (!result.ok)
        throw err("INTERNAL", result.error ?? "scroll failed", ctx.executionId);
      return { ok: true };
    },
  };

  const browserWait: ToolDefinition = {
    id: "browser_wait",
    name: "browser_wait",
    description: "Wait for a selector to appear or for a bounded time.",
    category: "analysis",
    version: "1.0.0",
    capabilities: ["cancellable"],
    permission: permission("read", false, "Wait on the current page"),
    idempotent: true,
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector to wait for" },
        ms: {
          type: "number",
          description: "Max milliseconds to wait (<= 10000)",
        },
      },
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const rec = input as Record<string, unknown>;
      const sel = asString(rec.selector);
      const ms = typeof rec.ms === "number" ? rec.ms : undefined;
      if ((sel === null || sel.length === 0) && ms === undefined) {
        throw err("VALIDATION", "Provide 'selector' or 'ms'", ctx.executionId);
      }
      const result = await service.wait(
        ctx.taskId ?? "no-task",
        resolveSessionId(ctx),
        sel ?? Math.min(ms ?? 5000, 10_000),
        ctx.signal,
      );
      if (!result.ok)
        throw err("TIMEOUT", result.error ?? "wait failed", ctx.executionId);
      return { ok: true };
    },
  };

  // ---- browser_extract -----------------------------------------------------

  const browserExtract: ToolDefinition = {
    id: "browser_extract",
    name: "browser_extract",
    description:
      "Inspect the current page: URL, title, visible text (bounded, " +
      "secret-redacted) and links. Read-only.",
    category: "analysis",
    version: "1.0.0",
    capabilities: ["cancellable"],
    permission: permission("read", false, "Read the current page content"),
    idempotent: true,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(_input, ctx) {
      const snap = await service.inspect(
        ctx.taskId ?? "no-task",
        resolveSessionId(ctx),
        ctx.signal,
      );
      if ("ok" in snap && snap.ok === false) {
        throw err("INTERNAL", snap.error, ctx.executionId);
      }
      const page = snap as Exclude<typeof snap, { ok: false; error: string }>;
      // Secrets redacted BEFORE anything can reach the model.
      const redactedText: string = redactSecrets(page.text);
      return {
        ok: true,
        url: page.url,
        title: page.title,
        text: redactedText,
        links: page.links,
      };
    },
  };

  // ---- browser_screenshot --------------------------------------------------

  const browserScreenshot: ToolDefinition = {
    id: "browser_screenshot",
    name: "browser_screenshot",
    description: "Capture a PNG screenshot of the current page (bounded size).",
    category: "analysis",
    version: "1.0.0",
    capabilities: ["cancellable"],
    permission: permission("read", false, "Screenshot the current page"),
    idempotent: true,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(_input, ctx) {
      const shot = await service.screenshot(
        ctx.taskId ?? "no-task",
        resolveSessionId(ctx),
        ctx.signal,
      );
      if (!shot.ok) throw err("INTERNAL", shot.error, ctx.executionId);
      return { ok: true, imageBase64: shot.base64 };
    },
  };

  // ---- browser_close -------------------------------------------------------

  const browserClose: ToolDefinition = {
    id: "browser_close",
    name: "browser_close",
    description: "Close the browser session and destroy the page context.",
    category: "analysis",
    version: "1.0.0",
    capabilities: [],
    permission: permission("read", false, "Close the browser session"),
    idempotent: true,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(_input, ctx) {
      await service.closeSession(ctx.taskId ?? "no-task");
      return { ok: true };
    },
  };

  return [
    browserNavigate,
    browserBack,
    browserForward,
    browserReload,
    browserClick,
    browserType,
    browserPress,
    browserScroll,
    browserWait,
    browserExtract,
    browserScreenshot,
    browserClose,
  ];
}

// ============================================================================
// Helpers
// ============================================================================

function isToolError(e: unknown): boolean {
  return (
    e !== null && typeof e === "object" && "code" in e && "executionId" in e
  );
}

function sanitize(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return message.slice(0, 300);
}
