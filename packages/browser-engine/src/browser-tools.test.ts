/**
 * Browser tool + M4 integration tests.
 *
 * Proves the security-relevant properties:
 * - Every browser tool is registered and schema-validated.
 * - The M4 pipeline maps browser tools to the intended actions and risk
 *   levels (web_fetch=medium for reads, network_request=high/ASK for
 *   state-changing interactions) — no fall-through to auto-approved reads.
 * - Approval flow: a denied click produces a DENIED execution; an approved
 *   click executes and reaches the (mocked) service.
 * - Secret redaction on extract results.
 */

import { describe, expect, it } from "vitest";
import { createBrowserTools } from "./browser-tools.js";
import type { BrowserService } from "./browser-service.js";
import {
  M4PermissionPipeline,
  ToolRegistry,
  ToolPermissionManager,
  ToolAuditLogger,
  ToolExecutionService,
  toolIdToAction,
} from "@codepilot/tool-engine";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

// ============================================================================
// Fixtures
// ============================================================================

/** Minimal fake BrowserService — records calls, no browser. */
interface FakeBrowserService {
  navigate: (
    taskId: string,
    sessionId: string,
    url: string,
    signal?: AbortSignal,
  ) => Promise<{ ok: boolean; url?: string; status?: number; title?: string; error?: string }>;
  goBack: () => Promise<{ ok: boolean; url?: string; title?: string }>;
  goForward: () => Promise<{ ok: boolean; url?: string; title?: string }>;
  reload: () => Promise<{ ok: boolean; url?: string; title?: string }>;
  click: (
    t: string,
    s: string,
    selector: string,
    signal?: AbortSignal,
  ) => Promise<{ ok: boolean; error?: string }>;
  fill: (
    t: string,
    s: string,
    selector: string,
    value: string,
    signal?: AbortSignal,
  ) => Promise<{ ok: boolean; error?: string }>;
  press: (t: string, s: string, key: string, signal?: AbortSignal) => Promise<{ ok: boolean; error?: string }>;
  scroll: (t: string, s: string, dx: number, dy: number, signal?: AbortSignal) => Promise<{ ok: boolean; error?: string }>;
  wait: (t: string, s: string, sel: string | number, signal?: AbortSignal) => Promise<{ ok: boolean; error?: string }>;
  inspect: (
    t: string,
    s: string,
    signal?: AbortSignal,
  ) => Promise<{ url: string; title: string; text: string; links: string[] } | { ok: false; error: string }>;
  screenshot: (
    t: string,
    s: string,
    signal?: AbortSignal,
  ) => Promise<{ ok: true; base64: string } | { ok: false; error: string }>;
  closeSession: (taskId: string, sessionId?: string) => Promise<void>;
}

function makeFakeService() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const service: FakeBrowserService = {
    navigate: async (taskId: string, sessionId: string, url: string, signal?: AbortSignal) => {
      calls.push({ op: "navigate", args: [taskId, sessionId, url, signal?.aborted] });
      return { ok: true, url, status: 200, title: "Test Page" };
    },
    goBack: async () => ({ ok: true, url: "https://x.test/", title: "t" }),
    goForward: async () => ({ ok: true, url: "https://x.test/", title: "t" }),
    reload: async () => ({ ok: true, url: "https://x.test/", title: "t" }),
    click: async (_t: string, _s: string, selector: string) => {
      calls.push({ op: "click", args: [selector] });
      return { ok: true };
    },
    fill: async (_t: string, _s: string, selector: string, value: string) => {
      calls.push({ op: "fill", args: [selector, value] });
      return { ok: true };
    },
    press: async () => ({ ok: true }),
    scroll: async () => ({ ok: true }),
    wait: async () => ({ ok: true }),
    inspect: async () => ({
      url: "https://x.test/",
      title: "t",
      text: "token: sk-live-abcdef1234567890hello",
      links: ["https://x.test/a"],
    }),
    screenshot: async () => ({ ok: true, base64: "aGVsbG8=" }),
    closeSession: async () => undefined,
  };
  return { service: service as unknown as BrowserService, calls };
}

function makeM4(): M4PermissionPipeline {
  const dir = mkdtempSync(join(tmpdir(), "browser-m4-"));
  return new M4PermissionPipeline({
    workspaceRoot: dir,
    approvalTimeoutMs: 250,
    autoApproveReads: true,
    presentApproval: async () => {
      // Simulate the user DENYING in the approval UI (never resolve-allow).
      return new Promise((resolve) => {
        setTimeout(
          () => resolve({ decision: "deny" as const, reason: "test deny" }),
          50,
        );
      });
    },
  });
}

function setup() {
  const { service, calls } = makeFakeService();
  const tools = createBrowserTools({ service });
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  const m4 = makeM4();
  const exec = new ToolExecutionService(
    registry,
    new ToolPermissionManager(),
    new ToolAuditLogger(),
    { defaultTimeoutMs: 15_000 },
    m4,
  );
  return { tools, registry, exec, calls, m4 };
}

// ============================================================================
// Registry + M4 mapping
// ============================================================================

describe("browser tools — registry", () => {
  it("registers all 12 browser tools with unique ids", () => {
    const { tools } = setup();
    const ids = tools.map((t) => t.id);
    expect(ids).toEqual([
      "browser_navigate",
      "browser_back",
      "browser_forward",
      "browser_reload",
      "browser_click",
      "browser_type",
      "browser_press",
      "browser_scroll",
      "browser_wait",
      "browser_extract",
      "browser_screenshot",
      "browser_close",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("M4 maps read-like browser tools to web_fetch", () => {
    for (const id of [
      "browser_navigate",
      "browser_extract",
      "browser_screenshot",
      "browser_wait",
      "browser_scroll",
      "browser_close",
      "browser_back",
      "browser_forward",
      "browser_reload",
    ]) {
      expect(toolIdToAction(id), id).toBe("web_fetch");
    }
  });

  it("M4 maps state-changing browser tools to network_request", () => {
    for (const id of ["browser_click", "browser_type", "browser_press"]) {
      expect(toolIdToAction(id), id).toBe("network_request");
    }
  });
});

// ============================================================================
// Execution through the executor + M4
// ============================================================================

describe("browser tools — execution + M4", () => {
  it("browser_navigate executes (web_fetch allow path) and reaches the service", async () => {
    const { exec, calls } = setup();
    const result = await exec.execute(
      "browser_navigate",
      { url: "https://93.184.216.34/" },
      { taskId: "t1" },
    );
    expect(result.status).toBe("completed");
    expect(calls.some((c) => c.op === "navigate")).toBe(true);
  });

  it("browser_navigate REJECTS a private target before the service runs", async () => {
    const { exec, calls } = setup();
    const result = await exec.execute(
      "browser_navigate",
      { url: "http://169.254.169.254/latest/meta-data/" },
      { taskId: "t1" },
    );
    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("blocked");
    // The fake service must never see the request.
    expect(calls.some((c) => c.op === "navigate")).toBe(false);
  });

  it("browser_click requires approval and DENIES when the user denies", async () => {
    const { exec, calls } = setup();
    const result = await exec.execute(
      "browser_click",
      { selector: "#submit" },
      { taskId: "t1" },
    );
    // presentApproval denies → execution denied, service never called.
    expect(result.status).toBe("denied");
    expect(calls.some((c) => c.op === "click")).toBe(false);
  });

  it("browser_click executes when the user approves", async () => {
    const { tools, calls } = setup();
    const registry = new ToolRegistry();
    for (const t of tools) registry.register(t);
    const dir = mkdtempSync(join(tmpdir(), "browser-m4-"));
    let presented: string | null = null;
    const m4 = new M4PermissionPipeline({
      workspaceRoot: dir,
      approvalTimeoutMs: 5_000,
      autoApproveReads: true,
      presentApproval: async (request) => {
        // Capture the approvalId and resolve it like the WebView does —
        // via the ApprovalManager, NOT by the presentApproval return value
        // (which the pipeline intentionally ignores; it is fire-and-forget).
        presented = request.approvalId;
        m4.approvalManager.approve(request.approvalId, "single_execution", "test approve");
        return { decision: "allow" as const };
      },
    });
    const exec = new ToolExecutionService(
      registry,
      new ToolPermissionManager(),
      new ToolAuditLogger(),
      { defaultTimeoutMs: 15_000 },
      m4,
    );
    const result = await exec.execute(
      "browser_click",
      { selector: "#submit" },
      { taskId: "t1" },
    );
    expect(presented).not.toBeNull();
    expect(result.status).toBe("completed");
    expect(calls.some((c) => c.op === "click" && c.args[0] === "#submit")).toBe(true);
  });

  it("browser_extract redacts secrets from page text", async () => {
    const { exec } = setup();
    const result = await exec.execute("browser_extract", {}, { taskId: "t1" });
    expect(result.status).toBe("completed");
    const output = result.output as { text?: string };
    expect(output.text).not.toContain("sk-live-abcdef1234567890");
    expect(output.text).toContain("[REDACTED]");
  });

  it("schema validation rejects malformed input before M4", async () => {
    const { exec } = setup();
    const result = await exec.execute("browser_navigate", { url: 42 }, { taskId: "t1" });
    expect(result.status).toBe("failed");
    const missing = await exec.execute("browser_click", {}, { taskId: "t1" });
    expect(missing.status).toBe("failed");
  });

  it("browser_close runs without a live session (idempotent)", async () => {
    const { exec } = setup();
    const result = await exec.execute("browser_close", {}, { taskId: "no-such-task" });
    expect(result.status).toBe("completed");
  });
});
