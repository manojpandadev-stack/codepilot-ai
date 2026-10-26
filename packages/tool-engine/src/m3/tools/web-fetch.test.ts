/**
 * M3 web_fetch ToolDefinition — registry, validation, M4 mapping, timeline.
 */
import { describe, it, expect } from "vitest";
import { createWebFetchTool } from "./web-fetch.js";
import { createBuiltinTools } from "./index.js";
import { ToolRegistry } from "../registry.js";
import { ToolPermissionManager } from "../permission-manager.js";
import { ToolAuditLogger } from "../audit-logger.js";
import { ToolExecutionService } from "../executor.js";
import { toolIdToAction } from "../../m4/integration.js";

describe("M3 web_fetch registration", () => {
  it("creates ToolDefinition with canonical contract", () => {
    const tool = createWebFetchTool();
    expect(tool.id).toBe("web_fetch");
    expect(tool.category).toBe("analysis");
    expect(tool.capabilities).toContain("cancellable");
    expect(tool.permission.level).toBe("network");
    expect(tool.idempotent).toBe(true);
    expect(tool.inputSchema.required).toContain("url");
  });

  it("is included in createBuiltinTools", () => {
    const tools = createBuiltinTools({ workspaceRoot: process.cwd() });
    expect(tools.some((t) => t.id === "web_fetch")).toBe(true);
  });

  it("validates input without network (rejects bad URLs)", () => {
    const tool = createWebFetchTool();
    expect(tool.validate?.({ url: "" }, process.cwd())?.code).toBe(
      "VALIDATION",
    );
    expect(tool.validate?.({ url: "file:///x" }, process.cwd())?.code).toBe(
      "VALIDATION",
    );
    expect(
      tool.validate?.({ url: "https://example.com" }, process.cwd()),
    ).toBeNull();
  });

  it("M4 maps web_fetch to web_fetch action (medium, auto-allow policy)", () => {
    expect(toolIdToAction("web_fetch")).toBe("web_fetch");
    expect(toolIdToAction("use_web")).toBe("web_fetch");
  });

  it("M3 executor emits lifecycle (requested/started/completed or failed) with validation", async () => {
    const registry = new ToolRegistry();
    for (const t of createBuiltinTools({ workspaceRoot: process.cwd() })) {
      registry.register(t);
    }
    const svc = new ToolExecutionService(
      registry,
      new ToolPermissionManager(),
      new ToolAuditLogger(),
    );
    const seen: string[] = [];
    svc.subscribe((e) => seen.push(e.type));
    // Invalid URL → validation failure (failed), still emits requested
    const res = await svc.execute("web_fetch", { url: "file:///etc/passwd" });
    expect(res.status).toBe("failed");
    expect(seen).toContain("tool.requested");
    svc.dispose();
  });
});
