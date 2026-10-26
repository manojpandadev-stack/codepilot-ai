/**
 * F-01 — Local Only privacy is fail-closed (reproduction + regression).
 *
 * Invariant: effective privacy == "local" + remote provider ⇒ the provider
 * must never become usable, run() must never execute, zero remote requests,
 * child agents must not execute, and no factory path may expose web tools.
 *
 * Uses a global fetch trap to prove "no remote request" (not merely
 * "initialize throws"). No network, no model, no real keys.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodePilotAgent } from "./agent.js";
import {
  createBuiltinTools,
  createCodePilotBuiltinTools,
} from "./builtin-tools.js";
import { MultiAgentOrchestrator } from "./orchestrator.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function trapFetch(): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (async (input: unknown) => {
    calls.push(
      String(typeof input === "string" ? input : (input as Request).url),
    );
    throw new Error("network trap tripped — no remote request may occur");
  }) as unknown as typeof fetch);
  return { calls };
}

function agentConfig(
  providerId: string,
  privacyMode: "local" | "cloud",
): ConstructorParameters<typeof CodePilotAgent>[0] {
  return {
    providerId,
    modelId: "test-model",
    apiKey: "test-key-not-real",
    workspaceRoot: process.cwd(),
    privacyMode,
    agentMode: "act",
    maxIterations: 2,
  };
}

describe("F-01 Local Only fail-closed", () => {
  it("1. Local Only + Ollama is allowed", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown) => {
      calls.push(
        String(typeof input === "string" ? input : (input as Request).url),
      );
      return new Response(
        `${JSON.stringify({ message: { role: "assistant", content: "local ok" }, done: true })}\n`,
        { status: 200 },
      );
    });
    const agent = new CodePilotAgent(agentConfig("ollama", "local"));
    await agent.initialize();
    await expect(agent.run("hi")).resolves.toMatchObject({
      reason: "complete",
      text: "local ok",
    });
    expect(calls).toHaveLength(1);
    await agent.dispose?.();
  });

  it("2. Local Only + remote providers are rejected at initialize", async () => {
    for (const remote of ["openai", "openrouter", "anthropic", "groq"]) {
      const agent = new CodePilotAgent(agentConfig(remote, "local"));
      await expect(agent.initialize()).rejects.toThrow(
        /ocal.*[Pp]rivacy|privacy.*local/i,
      );
      await agent.dispose?.();
    }
  });

  it("3. EXPLOIT: caught initialize error must not allow run() (0 requests)", async () => {
    const trap = trapFetch();
    const agent = new CodePilotAgent(agentConfig("openrouter", "local"));
    let initBlocked = false;
    try {
      await agent.initialize();
    } catch {
      initBlocked = true;
    }
    expect(initBlocked).toBe(true);
    await expect(agent.run("do work")).rejects.toThrow();
    expect(trap.calls).toHaveLength(0);
    await agent.dispose?.();
  });

  it("4. Local Only + multi-agent remote provider rejected before network", async () => {
    const trap = trapFetch();
    const orch = new MultiAgentOrchestrator(
      {
        providerId: "openrouter",
        modelId: "test-model",
        apiKey: "test-key-not-real",
        workspaceRoot: process.cwd(),
        privacyMode: "local",
        maxIterations: 2,
      },
      { maxConcurrency: 1 },
    );
    try {
      const outcome = await orch.execute("fix the bug", "act", {
        roles: ["architect"],
      });
      expect(outcome.outcome.outcome).not.toBe("COMPLETED");
    } finally {
      orch.dispose();
    }
    expect(trap.calls).toHaveLength(0);
  });

  it("5. Local Only + enableWebFetch=true exposes no web capability", () => {
    const tools = createCodePilotBuiltinTools({
      cwd: process.cwd(),
      enableBash: false,
      enableWebFetch: true,
      privacyMode: "local",
    });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("fetch_web_content");
    expect(names).not.toContain("web_search");
    const legacyLocal = createBuiltinTools({
      cwd: process.cwd(),
      enableBash: false,
      enableWebFetch: true,
      privacyMode: "local",
    });
    expect(legacyLocal.map((t) => t.name)).not.toContain("fetch_web_content");
    expect(legacyLocal.map((t) => t.name)).not.toContain("web_search");
    // An alternate factory with no policy context also denies network
    // capability rather than assuming Cloud mode.
    const legacy = createCodePilotBuiltinTools({
      cwd: process.cwd(),
      enableBash: false,
      enableWebFetch: true,
    });
    expect(legacy.map((t) => t.name)).not.toContain("fetch_web_content");
    expect(legacy.map((t) => t.name)).not.toContain("web_search");
    const legacyFactory = createBuiltinTools({
      cwd: process.cwd(),
      enableBash: false,
      enableWebFetch: true,
    });
    expect(legacyFactory.map((t) => t.name)).not.toContain("fetch_web_content");
    expect(legacyFactory.map((t) => t.name)).not.toContain("web_search");
  });

  it("6. Normal privacy mode + remote provider still initializes", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          [
            `data: ${JSON.stringify({ choices: [{ delta: { content: "remote ok" } }] })}`,
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
            "data: [DONE]",
            "",
          ].join("\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    const agent = new CodePilotAgent(agentConfig("openai-native", "cloud"));
    await agent.initialize();
    await expect(agent.run("hi")).resolves.toMatchObject({
      reason: "complete",
      text: "remote ok",
    });
    await agent.dispose?.();
  });
});
