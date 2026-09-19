/**
 * Extension browser host — real browser automation for the CodePilot agent.
 *
 * Responsibilities:
 * - Own the singleton @codepilot/browser-engine BrowserService.
 * - Discover a usable system browser channel (chrome / msedge) — the VSIX
 *   ships playwright-core WITHOUT browser binaries, so a system channel is
 *   required. Discovery happens once and is cached.
 * - Expose browser tools to the live agent as AgentTool[] (the same
 *   extraTools pattern MCP uses): every call passes the runtime's beforeTool
 *   hook → LiveToolPermissionBridge → M4 → SecurityValidator BEFORE the
 *   wrapper runs. Execution goes through ToolRegistry + ToolExecutionService
 *   with the M4 pipeline — never a raw BrowserService call from the agent.
 * - M18 observability: every tool outcome is counted.
 * - Deactivate: full teardown (no zombie Chromium).
 */

import * as fs from "node:fs";
import {
  BrowserService,
  createBrowserTools,
  type BrowserToolConfig,
} from "@codepilot/browser-engine";
import { ToolRegistry, ToolPermissionManager, ToolAuditLogger, ToolExecutionService } from "@codepilot/tool-engine";
import type { M4PermissionPipeline, ToolDefinition } from "@codepilot/tool-engine";
import type { AgentTool } from "@codepilot/agent-runtime";

// ============================================================================
// Channel discovery
// ============================================================================

const CHANNEL_CANDIDATES: Array<{ channel: "chrome" | "msedge"; paths: string[] }> = [
  {
    channel: "chrome",
    paths: [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ],
  },
  {
    channel: "msedge",
    paths: [
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ],
  },
];

let discoveredChannel: string | null | undefined;

/**
 * Find a system browser for playwright-core's channel launch. Returns null
 * when none is installed — browser tools then report a clear, actionable
 * error instead of failing with a cryptic launcher message.
 */
export function discoverBrowserChannel(): string | null {
  if (discoveredChannel !== undefined) return discoveredChannel;
  discoveredChannel = null;
  for (const candidate of CHANNEL_CANDIDATES) {
    for (const p of candidate.paths) {
      try {
        if (fs.existsSync(p)) {
          discoveredChannel = candidate.channel;
          return discoveredChannel;
        }
      } catch {
        // stat failures — keep scanning
      }
    }
  }
  return discoveredChannel;
}

/** Test hook: reset cached discovery. */
export function resetBrowserChannelDiscovery(): void {
  discoveredChannel = undefined;
}

// ============================================================================
// Host service
// ============================================================================

export interface BrowserHostOptions {
  workspaceRoot: string;
  m4: M4PermissionPipeline;
  observability: {
    increment: (name: string, tags?: Record<string, string>) => void;
    observeMs: (name: string, ms: number) => void;
  };
}

export class ExtensionBrowserService {
  private readonly service: BrowserService;
  private readonly registry = new ToolRegistry();
  private readonly permissions = new ToolPermissionManager();
  private readonly audit = new ToolAuditLogger();
  private execService: ToolExecutionService;
  private readonly tools: ToolDefinition[];

  constructor(private readonly options: BrowserHostOptions) {
    const channel = discoverBrowserChannel();
    this.service = new BrowserService({
      channel: channel ?? undefined,
      maxSessions: 2,
      navigationTimeoutMs: 20_000,
    });
    const toolConfig: BrowserToolConfig = { service: this.service };
    this.tools = createBrowserTools(toolConfig);
    for (const t of this.tools) this.registry.register(t);
    this.execService = this.buildExecService();
  }

  private buildExecService(): ToolExecutionService {
    return new ToolExecutionService(
      this.registry,
      this.permissions,
      this.audit,
      { defaultTimeoutMs: 60_000 },
      this.options.m4,
    );
  }

  /** AgentTool[] for the live agent (extraTools). M4-gated per call. */
  buildAgentTools(): AgentTool[] {
    const exec = this.execService;
    return this.tools.map((t) => ({
      name: t.id,
      description: t.description.slice(0, 400),
      inputSchema: t.inputSchema as unknown as Record<string, unknown>,
      execute: async (input: unknown) => {
        const started = Date.now();
        try {
          const result = await exec.execute(t.id, input ?? {}, {
            // Task correlation comes from the runtime context implicitly;
            // browser sessions are additionally keyed per task inside the
            // service. The executor's M4 evaluation decides allow/deny/ask.
            timeoutMs: 60_000,
          });
          const duration = Date.now() - started;
          if (result.status === "completed") {
            this.options.observability.increment("codepilot_browser_tool_calls_total", {
              tool: t.id,
              status: "success",
            });
            this.options.observability.observeMs("codepilot_browser_tool_duration_ms", duration);
            return { ok: true, ...(result.output as Record<string, unknown>) };
          }
          const denied = result.status === "denied";
          this.options.observability.increment("codepilot_browser_tool_calls_total", {
            tool: t.id,
            status: denied ? "denied" : "error",
          });
          return {
            ok: false,
            error: result.error?.message ?? `browser tool ${t.id} ${result.status}`,
          };
        } catch (err) {
          this.options.observability.increment("codepilot_browser_tool_calls_total", {
            tool: t.id,
            status: "error",
          });
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    }));
  }

  /** Status for diagnostics (no page content). */
  status(): { channel: string | null; sessions: number } {
    return {
      channel: discoverBrowserChannel(),
      sessions: this.service.sessionCount(),
    };
  }

  /** Close all sessions for a task (task end / cancellation). */
  async closeTaskSessions(taskId: string): Promise<void> {
    await this.service.closeTaskSessions(taskId);
  }

  /** Full teardown on deactivate. */
  async dispose(): Promise<void> {
    this.execService.dispose();
    await this.service.dispose();
  }
}

// ============================================================================
// Singleton
// ============================================================================

let instance: ExtensionBrowserService | null = null;

export function getBrowserService(): ExtensionBrowserService | null {
  return instance;
}

/**
 * Lazily create the host browser service. Returns null when no system
 * browser is available — callers surface a clear "browser unavailable"
 * message instead of pretending the capability exists.
 */
export function ensureBrowserService(options: BrowserHostOptions): ExtensionBrowserService | null {
  if (instance) return instance;
  if (!discoverBrowserChannel()) {
    return null;
  }
  instance = new ExtensionBrowserService(options);
  return instance;
}

/** Deactivate hook. */
export async function disposeBrowserService(): Promise<void> {
  if (instance) {
    await instance.dispose();
    instance = null;
  }
}
