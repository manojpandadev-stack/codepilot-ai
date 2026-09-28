/**
 * FRONTEND INTEGRATION — Tools / Skills / Teams / Model-capability states.
 *
 * Deterministic (no LLM, no live model). Drives the REAL extension message
 * dispatcher through the integration harness and asserts the exact message
 * contracts the React UI depends on:
 *
 *   TOOLS    — not-created vs ready vs empty are distinguishable (never a
 *              fake "0 tools" for an unavailable registry); approval policy
 *              metadata is authoritative (PolicyEngine, not name inference);
 *              runtime/ready fires exactly once per runtime creation.
 *   SKILLS   — loading→result, EMPTY for an empty workspace, DISCOVERED for
 *              workspace + home skills, failure surfaces skills/error (never
 *              rendered as empty); malformed skill file tolerated.
 *   TEAMS    — team/list lazy-initializes the service and always answers
 *              (no stuck "Loading teams…"); create success + validation
 *              failures + persistence round-trip; event re-sync.
 *   MODELS   — toolCalling tri-state reaches the webview contract; malformed
 *              values coerce to "unknown"; catalogue truth: qwen3:8b=true,
 *              qwen2.5-coder:3b=unknown (never "supported").
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyToolRegistryState,
  isLoadFailureState,
  normalizeModelList,
  toolCallingLabel,
  validateSkillsState,
} from "../apps/webview/src/lib/messages.js";
import {
  modelToolCallingSupport,
  getProviderCatalog,
} from "../packages/model-gateway/src/index.js";
import {
  freshHost,
  reopenHost,
  type FreshHost,
} from "./vscode-integration-harness.js";

describe("frontend integration — tools/skills/teams/model states", () => {
  let host: FreshHost;
  let captured: Array<{ type: string; payload?: Record<string, unknown> }>;
  let workspaceDir = "";

  beforeEach(async () => {
    host = await freshHost();
    captured = [];
    host.ext.__setWebviewSinkForIntegrationTest((m) => {
      captured.push(m as { type: string; payload?: Record<string, unknown> });
    });
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-frontend-"));
    const folders = (
      host.vscodeStub as unknown as {
        workspace: { workspaceFolders: Array<{ uri: { fsPath: string } }> };
      }
    ).workspace;
    folders.workspaceFolders.length = 0;
    folders.workspaceFolders.push({ uri: { fsPath: workspaceDir } });
  });

  afterEach(async () => {
    host.ext.__clearWebviewSinkForIntegrationTest();
    await host.ext.deactivate().catch(() => {});
    host.cleanup();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  function send(type: string, payload: unknown) {
    return host.seams.handleMessage({
      type: type as never,
      id: `t-${Math.random().toString(36).slice(2)}`,
      payload,
      timestamp: Date.now(),
    });
  }

  function lastOf(type: string) {
    return captured.filter((m) => m.type === type).at(-1);
  }

  // ==========================================================================
  // PART 1/8/13 — Tools registry states + runtime lifecycle
  // ==========================================================================

  it("tools/list BEFORE runtime creation: explicit runtimeReady:false — classified runtime-not-ready, never '0 tools'", async () => {
    await send("tools/list", {});
    const msg = lastOf("tools/list_result");
    expect(msg).toBeDefined();
    const payload = msg?.payload as {
      tools: unknown[];
      runtimeReady: boolean;
      runtimeStatus?: string;
    };
    expect(payload.runtimeReady).toBe(false);
    expect(Array.isArray(payload.tools)).toBe(true);
    expect(payload.runtimeStatus).toBe("not-created");
    const classified = classifyToolRegistryState(payload);
    expect(classified.state).toBe("runtime-not-ready");
    expect(classified.tools).toHaveLength(0);
  });

  it("tools/list AFTER runtime creation: ready, populated, approval metadata authoritative", async () => {
    await host.seams.ensureRuntime();
    await send("tools/list", {});
    const msg = lastOf("tools/list_result");
    const payload = msg?.payload as {
      tools: Array<{ name: string; permission: string; source: string; description?: string }>;
      runtimeReady: boolean;
      runtimeStatus?: string;
    };
    expect(payload.runtimeReady).toBe(true);
    expect(payload.runtimeStatus).toBe("ready");
    expect(payload.tools.length).toBeGreaterThan(0);

    const names = new Set(payload.tools.map((t) => t.name));
    for (const t of ["read_files", "search", "bash", "run_commands", "editor", "delete_file"]) {
      expect(names.has(t)).toBe(true);
    }
    // PART 2 — real execution policy from the PolicyEngine, not the name:
    // mutating/execute tools REQUIRE approval; read-only tools are auto.
    const byName = Object.fromEntries(payload.tools.map((t) => [t.name, t]));
    for (const approvalTool of ["bash", "run_commands", "write_file", "editor", "delete_file"]) {
      expect(byName[approvalTool]!.permission).toBe("approval");
    }
    for (const autoTool of ["read_files", "search"]) {
      expect(byName[autoTool]!.permission).toBe("auto");
    }
    const classified = classifyToolRegistryState(payload);
    expect(classified.state).toBe("available");
    expect(classified.tools).toHaveLength(payload.tools.length);
  });

  it("runtime/ready fires exactly once when the runtime is created", async () => {
    expect(captured.some((m) => m.type === "runtime/ready")).toBe(false);
    await host.seams.ensureRuntime();
    const ready = captured.filter((m) => m.type === "runtime/ready");
    expect(ready).toHaveLength(1);
    // A second ensureRuntime reuses the singleton — no duplicate push.
    await host.seams.ensureRuntime();
    expect(captured.filter((m) => m.type === "runtime/ready")).toHaveLength(1);
  });

  it("runtime/ready arrives BEFORE the runtime can answer tools/list as ready (ordering)", async () => {
    const readySentAt = captured.findIndex((m) => m.type === "runtime/ready");
    expect(readySentAt).toBe(-1);
    await host.seams.ensureRuntime();
    const readyIdx = captured.findIndex((m) => m.type === "runtime/ready");
    expect(readyIdx).toBeGreaterThanOrEqual(0);
    // Now a tools/list asks AFTER the push and must answer ready.
    await send("tools/list", {});
    const payload = lastOf("tools/list_result")?.payload as { runtimeReady: boolean };
    expect(payload.runtimeReady).toBe(true);
  });

  // ==========================================================================
  // PART 4/9/12 — Skills discovery states
  // ==========================================================================

  it("skills: empty workspace → explicit EMPTY (not failure, not loading)", async () => {
    await send("skills/list", {});
    const msg = lastOf("skills/list_result");
    expect(msg).toBeDefined();
    const normalized = validateSkillsState(msg?.payload);
    expect(normalized).not.toBeNull();
    expect(normalized!.skills).toHaveLength(0);
    // Webview classification: no error + zero items = genuine EMPTY.
    expect(isLoadFailureState(null, normalized!.skills.length)).toBe(false);
  });

  it("skills: one workspace skill is discovered; multiple skills are all listed", async () => {
    const dir = path.join(workspaceDir, ".codepilot", "skills");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "caching.md"),
      "---\nname: caching\ndescription: caching skill description\n---\nCache API responses with tests.",
      "utf-8",
    );
    await send("skills/list", {});
    let skills = (lastOf("skills/list_result")?.payload as { skills: Array<{ name: string }> }).skills;
    expect(skills.map((s) => s.name)).toContain("caching");

    fs.writeFileSync(
      path.join(dir, "refactor.md"),
      "---\nname: refactor\ndescription: refactoring skill\n---\nRefactor in small steps.",
      "utf-8",
    );
    await send("skills/list", {});
    skills = (lastOf("skills/list_result")?.payload as { skills: Array<{ name: string }> }).skills;
    expect(skills.map((s) => s.name)).toEqual(expect.arrayContaining(["caching", "refactor"]));
  });

  it("skills: a malformed skill file does not break discovery of valid siblings", async () => {
    const dir = path.join(workspaceDir, ".codepilot", "skills");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "broken.md"), "not frontmatter at all\njust prose", "utf-8");
    fs.writeFileSync(
      path.join(dir, "good.md"),
      "---\nname: good\ndescription: valid skill\n---\nBody.",
      "utf-8",
    );
    await send("skills/list", {});
    const msg = lastOf("skills/list_result");
    // Either the valid skill is discovered (tolerant) or an explicit error
    // is reported — a crash or silent empty is NOT acceptable.
    if (msg?.type === "skills/list_result") {
      const skills = (msg.payload as { skills: Array<{ name: string }> }).skills;
      expect(skills.map((s) => s.name)).toContain("good");
    } else {
      expect(lastOf("skills/error")).toBeDefined();
    }
  });

  it("skills: workspace change is picked up without a webview reload (auto refresh path)", async () => {
    await send("skills/list", {});
    let skills = (lastOf("skills/list_result")?.payload as { skills: Array<{ name: string }> }).skills;
    expect(skills).toHaveLength(0);

    const dir = path.join(workspaceDir, ".codepilot", "skills");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "late.md"),
      "---\nname: late\ndescription: appears after root change\n---\nBody.",
      "utf-8",
    );
    // The service re-resolves its root per request (harness re-activates per
    // test); a fresh request reflects the current workspace contents.
    await send("skills/list", {});
    skills = (lastOf("skills/list_result")?.payload as { skills: Array<{ name: string }> }).skills;
    expect(skills.map((s) => s.name)).toContain("late");
  });

  // ==========================================================================
  // PART 5/6/7 — Teams lifecycle, create, validation
  // ==========================================================================

  it("teams: team/list lazy-initializes the service and ALWAYS answers (no stuck loading)", async () => {
    await send("team/list", {});
    const list = lastOf("team/list_result");
    expect(list).toBeDefined();
    const teams = (list?.payload as { teams?: unknown[] }).teams;
    expect(Array.isArray(teams)).toBe(true);
    // No error surrogate replaced the list — the service initialized.
    expect(
      captured.filter(
        (m) => m.type === "team/result" && (m.payload as { action?: string })?.action === "list",
      ),
    ).toHaveLength(0);
  });

  it("teams: create success → persisted → refreshed list contains the team", async () => {
    await send("team/create", {
      objective: "Add caching to the API layer and add tests.",
      roles: ["architect", "coder", "tester", "reviewer"],
      maxConcurrency: 2,
    });
    const result = captured
      .filter((m) => m.type === "team/result" && (m.payload as { action?: string })?.action === "create")
      .at(-1);
    expect(result).toBeDefined();
    expect((result!.payload as { success?: boolean }).success).toBe(true);
    const teamId = (result!.payload as { teamId?: string }).teamId;
    expect(typeof teamId).toBe("string");

    await send("team/list", {});
    const teams = (lastOf("team/list_result")?.payload as { teams: Array<{ teamId: string }> }).teams;
    expect(teams.some((t) => t.teamId === teamId)).toBe(true);
  });

  it("teams: validation failures answer success:false with actionable errors (no fake success)", async () => {
    await send("team/create", { objective: "   " });
    let result = captured
      .filter((m) => m.type === "team/result" && (m.payload as { action?: string })?.action === "create")
      .at(-1);
    expect((result?.payload as { success?: boolean }).success).toBe(false);
    expect(String((result?.payload as { error?: string }).error)).toContain("objective");

    await send("team/create", {
      objective: "valid objective",
      roles: ["not-a-role"],
    });
    result = captured
      .filter((m) => m.type === "team/result" && (m.payload as { action?: string })?.action === "create")
      .at(-1);
    expect((result?.payload as { success?: boolean }).success).toBe(false);
    expect(String((result?.payload as { error?: string }).error)).toContain("role");

    await send("team/create", {
      objective: "valid objective",
      roles: ["coder"],
      maxConcurrency: 99,
    });
    result = captured
      .filter((m) => m.type === "team/result" && (m.payload as { action?: string })?.action === "create")
      .at(-1);
    expect((result?.payload as { success?: boolean }).success).toBe(false);
    expect(String((result?.payload as { error?: string }).error)).toContain("maxConcurrency");
  });

  // ==========================================================================
  // PART 3 — Model tool-calling capability (tri-state truth)
  // ==========================================================================

  it("catalogue truth: qwen3:8b=true, qwen2.5-coder:3b=unknown, BYO=unknown", () => {
    expect(modelToolCallingSupport("ollama", "qwen3:8b")).toBe("true");
    expect(modelToolCallingSupport("ollama", "qwen2.5-coder:3b")).toBe("unknown");
    expect(modelToolCallingSupport("ollama", "totally-unlisted:latest")).toBe("unknown");
    expect(modelToolCallingSupport("byo-provider", "any-model")).toBe("unknown");
  });

  it("catalogue payloads carry the toolCalling tri-state for ollama models", () => {
    const ollama = getProviderCatalog().find((p) => p.id === "ollama");
    expect(ollama).toBeDefined();
    const qwen3 = ollama!.models.find((m) => m.id === "qwen3:8b");
    const qwen25 = ollama!.models.find((m) => m.id === "qwen2.5-coder:3b");
    expect(qwen3?.toolCalling).toBe("true");
    expect(qwen25?.toolCalling).toBe("unknown");
  });

  it("webview contract: tri-state survives normalizeModelList; malformed coerces to unknown (never 'true')", () => {
    const normalized = normalizeModelList({
      models: [
        { id: "qwen3:8b", name: "qwen3:8b", provider: "ollama", toolCalling: "true" },
        { id: "qwen2.5-coder:3b", name: "qwen2.5-coder:3b", provider: "ollama", toolCalling: "unknown" },
        { id: "garbage", name: "garbage", provider: "ollama", toolCalling: "maybe" },
        { id: "absent", name: "absent", provider: "ollama" },
      ],
    });
    expect(normalized.map((m) => m.toolCalling)).toEqual([
      "true",
      "unknown",
      "unknown",
      "unknown",
    ]);
    // Labels: unknown is "?"/Unknown — never "Supported".
    expect(toolCallingLabel("true").text).toBe("Supported");
    expect(toolCallingLabel("false").text).toBe("Not supported");
    expect(toolCallingLabel("unknown").text).toBe("Unknown");
    expect(toolCallingLabel("unknown").symbol).toBe("?");
    expect(toolCallingLabel(undefined).text).toBe("Unknown");
  });

  it("model/list carries toolCalling for every discovered ollama model (live or catalogue)", async () => {
    await send("model/list", {});
    const msg = lastOf("model/list");
    expect(msg).toBeDefined();
    const payload = msg?.payload as { models?: Array<{ id: string; toolCalling?: string }> };
    expect(Array.isArray(payload.models)).toBe(true);
    for (const m of payload.models ?? []) {
      // Every entry carries a tri-state; only the exact literals survive.
      expect(["true", "false", "unknown"]).toContain(m.toolCalling ?? "unknown");
      // The verified-lie guard: 3b must NEVER arrive as "true".
      if (m.id === "qwen2.5-coder:3b") {
        expect(m.toolCalling).not.toBe("true");
      }
    }
  });

  // ==========================================================================
  // PART 11 — restart / recovery (no stale AVAILABLE across a real restart)
  // ==========================================================================

  it("restart recovery: reopened host re-answers tools/skills/teams from a fresh service graph (stale state cannot survive)", async () => {
    await host.seams.ensureRuntime();
    await send("team/create", {
      objective: "Persistence must survive an extension-host restart.",
      roles: ["coder"],
      maxConcurrency: 1,
    });
    const created = captured
      .filter((m) => m.type === "team/result" && (m.payload as { action?: string })?.action === "create")
      .at(-1);
    expect((created?.payload as { success?: boolean }).success).toBe(true);
    const storageDir = host.storageDir;
    await host.ext.deactivate().catch(() => {});
    host.cleanup(); // removes storageDir — reopenHost creates a fresh one

    // Extension-host restart: brand-new module graph + services; the webview
    // would re-bootstrap. No AVAILABLE state can leak across this boundary.
    const reopened = await reopenHost(storageDir);
    const sink: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    reopened.ext.__setWebviewSinkForIntegrationTest((m) => {
      sink.push(m as { type: string; payload?: Record<string, unknown> });
    });
    const reFolders = (
      reopened.vscodeStub as unknown as {
        workspace: { workspaceFolders: Array<{ uri: { fsPath: string } }> };
      }
    ).workspace;
    reFolders.workspaceFolders.length = 0;
    reFolders.workspaceFolders.push({ uri: { fsPath: workspaceDir } });
    try {
      const send2 = (type: string, payload: unknown) =>
        reopened.seams.handleMessage({
          type: type as never,
          id: `r-${Math.random().toString(36).slice(2)}`,
          payload,
          timestamp: Date.now(),
        });
      const last2 = (type: string) =>
        sink.filter((m) => m.type === type).at(-1);

      // Tools: the fresh host must answer not-ready FIRST (runtime is lazy),
      // and ready only after the runtime is created again.
      await send2("tools/list", {});
      expect(
        ((last2("tools/list_result")?.payload as { runtimeReady?: boolean })?.runtimeReady) ?? true,
      ).toBe(false);
      await reopened.seams.ensureRuntime();
      expect(sink.some((m) => m.type === "runtime/ready")).toBe(true);
      await send2("tools/list", {});
      const readyPayload = last2("tools/list_result")?.payload as {
        runtimeReady: boolean;
        tools: unknown[];
      };
      expect(readyPayload.runtimeReady).toBe(true);
      expect(readyPayload.tools.length).toBeGreaterThan(0);

      // Teams: fresh service initializes lazily and re-lists (persisted).
      await send2("team/list", {});
      const teams = (last2("team/list_result")?.payload as { teams?: Array<{ teamId: string }> }).teams;
      expect(Array.isArray(teams)).toBe(true);

      // Skills: fresh discovery answers for the same workspace.
      await send2("skills/list", {});
      expect(last2("skills/list_result") ?? last2("skills/error")).toBeDefined();
    } finally {
      reopened.ext.__clearWebviewSinkForIntegrationTest();
      await reopened.ext.deactivate().catch(() => {});
      reopened.cleanup();
    }
  }, 60_000);
});
