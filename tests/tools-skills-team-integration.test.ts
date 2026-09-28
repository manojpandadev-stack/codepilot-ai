/**
 * Tools / Skills / Team — integration regression tests (real extension host).
 *
 * Covers the defects found in VS Code UI testing:
 * 1. Tools: `runtimeReady:false` was discarded by the webview — the panel
 *    showed "Registry unavailable" for both not-ready AND genuinely empty.
 *    The host contract (runtimeReady flag + payload) must be observable.
 * 2. Skills: discovery failure vs. genuinely empty workspace must be
 *    distinguishable end-to-end (`skills/error` vs `skills/list_result`).
 * 3. Teams: a `team/list` request when the service cannot initialize must
 *    ALWAYS answer (previously silent — the UI stayed on "Loading teams…").
 *
 * Uses the real extension message dispatcher (freshHost harness); no mocks
 * for the flows under test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyToolRegistryState,
  isLoadFailureState,
} from "../apps/webview/src/lib/messages.js";
import { freshHost, type FreshHost } from "./vscode-integration-harness.js";

describe("tools/skills/team host integration (UI defect regressions)", () => {
  let host: FreshHost;
  let captured: Array<{ type: string; payload?: Record<string, unknown> }>;
  let workspaceDir = "";

  beforeEach(async () => {
    host = await freshHost();
    captured = [];
    host.ext.__setWebviewSinkForIntegrationTest((m) => {
      captured.push(m as { type: string; payload?: Record<string, unknown> });
    });
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-tst-ws-"));
    const folders = (
      host.vscodeStub as unknown as {
        workspace: { workspaceFolders: Array<{ uri: { fsPath: string } }> };
      }
    ).workspace;
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
      id: `test-${Math.random().toString(36).slice(2)}`,
      payload,
      timestamp: Date.now(),
    });
  }

  function lastOf(type: string) {
    return captured.filter((m) => m.type === type).at(-1);
  }

  function writeSkill(name: string, body: string): void {
    const dir = path.join(workspaceDir, ".codepilot", "skills");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.md`), body, "utf-8");
  }

  it("tools/list answers with an explicit runtimeReady flag the UI can classify", async () => {
    await send("tools/list", {});
    const msg = lastOf("tools/list_result");
    expect(msg).toBeDefined();
    const payload = msg?.payload as {
      tools: unknown[];
      runtimeReady: boolean;
      error?: string;
    };
    // The exact contract the fixed webview depends on: a boolean flag plus
    // the tool list (or error). Without this the UI cannot distinguish
    // "runtime not started" from "registry empty".
    expect(typeof payload.runtimeReady).toBe("boolean");
    expect(Array.isArray(payload.tools)).toBe(true);
    // Classification must never confuse the two empty-looking states.
    const classified = classifyToolRegistryState(payload);
    expect(["available", "runtime-not-ready"]).toContain(classified.state);
  });

  it(
    "runtime/ready fires exactly once when the runtime is created",
    async () => {
      // The handler reads `payload.text` (verified via event trace): runtime
      // creation happens inside sendPromptToAgent → ensureRuntime().
      // runtime/ready is emitted right after runtime.initialize(), long
      // before the full agent turn (real LLM generation) completes — so we
      // poll for the event instead of awaiting the whole turn.
      const turn = send("chat/send", { text: "noop", requestId: "r-lifecycle" });
      turn.catch(() => {}); // the turn outcome is not the subject of this test
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if (captured.some((m) => m.type === "runtime/ready")) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      const readyEvents = captured.filter((m) => m.type === "runtime/ready");
      expect(readyEvents.length).toBe(1);
    },
    120_000,
  );

  it("skills/list distinguishes discovery results from failures", async () => {
    await send("skills/list", {});
    const ok = lastOf("skills/list_result");
    expect(ok).toBeDefined();
    const skills = (ok?.payload as { skills?: unknown[] }).skills;
    expect(Array.isArray(skills)).toBe(true);
    // An empty workspace is a legitimate EMPTY, not a failure.
    expect(isLoadFailureState(null, skills!.length)).toBe(false);
  });

  it("skills/list reports discovered workspace skills", async () => {
    // Frontmatter with an explicit name — the same format the existing
    // skills-activation fixtures use (RulesEngine parses `name:`).
    const dir = path.join(workspaceDir, ".codepilot", "skills");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "caching.md"),
      "---\nname: caching\ndescription: caching skill description\n---\nCache API responses with tests.",
      "utf-8",
    );
    await send("skills/list", {});
    const msg = lastOf("skills/list_result");
    const skills = (msg?.payload as { skills: Array<{ name: string }> }).skills;
    expect(skills.map((s) => s.name)).toContain("caching");
  });

  it("team/list lazy-initializes the TeamService and always answers with a list", async () => {
    // The harness boots without an explicit team backend. Two defects are
    // covered here: (a) the original silent return that left the webview on
    // "Loading teams…" forever, and (b) the interim loud-error path, which
    // answered "team service not initialized" instead of initializing it.
    // The authoritative fix: team/list → getTeamService() → listTeams() →
    // team/list_result, with a real (possibly empty) teams array.
    await send("team/list", {});
    const listResult = lastOf("team/list_result");
    expect(listResult).toBeDefined();
    const teams = (listResult?.payload as { teams?: unknown[] }).teams;
    expect(Array.isArray(teams)).toBe(true);
    // No error surrogate for a merely-uninitialized service.
    const listError = captured.filter(
      (m) => m.type === "team/result" && (m.payload as { action?: string })?.action === "list",
    );
    expect(listError.length).toBe(0);
  });

  it("team/create persists a team and the refreshed list contains it", async () => {
    await send("team/create", {
      objective: "Add caching to the API layer and add tests.",
      // Role IDs per TEAM_ROLES (team-service.ts). Labels like "planner"
      // are rejected by createTeam validation.
      roles: ["architect", "coder", "tester", "reviewer"],
      maxConcurrency: 2,
    });
    const result = captured.filter(
      (m) => m.type === "team/result" && (m.payload as { action?: string })?.action === "create",
    ).at(-1);
    expect(result).toBeDefined();
    expect((result!.payload as { success?: boolean }).success).toBe(true);
    // The create flow pushes an authoritative list right after the result.
    await send("team/list", {});
    const list = lastOf("team/list_result");
    const teams = (list?.payload as { teams?: Array<{ teamId: string }> }).teams;
    expect(Array.isArray(teams)).toBe(true);
    expect(teams!.length).toBeGreaterThan(0);
  });

  it(
    "provider/list answers with honest typed connection states (BUG 1)",
    async () => {
      // Deterministic down-endpoint: point Ollama at a dead port through the
      // REAL provider/configure path (the environment may have a live Ollama
      // on 11434; the dead port guarantees the honest verdict).
      await send("provider/configure", {
        providerId: "ollama",
        baseUrl: "http://127.0.0.1:1",
      });
      await send("provider/list", {});
      const msg = lastOf("provider/list");
      expect(msg).toBeDefined();
      const payload = msg?.payload as {
        providers?: Array<{
          id: string;
          state?: string;
          connected?: boolean;
        }>;
        selectedProviderId?: string;
        selectedState?: { state?: string; connected?: boolean };
      };
      expect(Array.isArray(payload.providers)).toBe(true);
      const ollama = payload.providers!.find((p) => p.id === "ollama");
      expect(ollama).toBeDefined();
      expect(ollama!.state).toBe("unavailable");
      expect(ollama!.connected).toBe(false);
      // Every entry carries a typed state; connected iff state=connected.
      const TYPED = [
        "configured",
        "checking",
        "connected",
        "unavailable",
        "auth-required",
        "auth-invalid",
        "rate-limited",
        "no-endpoint",
        "unverified",
      ];
      for (const entry of payload.providers!) {
        expect(TYPED).toContain(entry.state);
        expect(entry.connected).toBe(entry.state === "connected");
      }
      // The selected provider always gets a fresh host verdict.
      expect(typeof payload.selectedProviderId).toBe("string");
      expect(payload.selectedState).toBeDefined();
      expect(payload.selectedState!.connected).toBe(false);
    },
    60_000,
  );

  it("provider/test answers with a real probe classification (BUG 1)", async () => {
    await send("provider/configure", {
      providerId: "ollama",
      baseUrl: "http://127.0.0.1:1",
    });
    await send("provider/test", { providerId: "ollama" });
    const msg = lastOf("provider/test_result");
    expect(msg).toBeDefined();
    const payload = msg?.payload as {
      providerId: string;
      state: string;
      connected?: boolean;
      message: string;
    };
    expect(payload.providerId).toBe("ollama");
    // Dead endpoint: honest unavailable + secret-free message.
    expect(payload.state).toBe("unavailable");
    expect(typeof payload.message).toBe("string");
  }, 60_000);
});
