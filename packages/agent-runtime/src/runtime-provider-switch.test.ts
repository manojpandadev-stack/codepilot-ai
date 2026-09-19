/**
 * Provider-architecture regression tests (selected-provider truth).
 *
 * Covers the verified bug-report scenarios against the NATIVE runtime
 * (CodePilotRuntime → native engine → native LLM providers; no Cline):
 *   D. provider switch after runtime init — ALL provider-scoped config moves
 *      atomically (providerId + modelId + apiKey + baseUrl), no stale reuse;
 *      asserted at the HTTP wire (request URL + body.model + auth header);
 *   E. reverse switch — explicit null CLEARS apiKey/baseUrl so an Ollama
 *      loopback baseUrl can never reach a cloud provider; a keyless cloud
 *      session fails CLOSED (missing-key error) with NO request on the wire;
 *   G. cloud provider + local privacy mode CANNOT start a session (blocked,
 *      deny-closed) — no model request can leave the machine while "local"
 *      is selected, and the guard re-evaluates on EVERY startSession.
 *
 * The model layer is stubbed (Ollama NDJSON + OpenAI-compatible SSE served
 * by ollama-fetch-stub — no network, no model); provider construction,
 * registry routing, the agent loop, tool dispatch, and event fan-out are
 * all genuine. Wire assertions use the stub's recorded requests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CodePilotRuntime,
  isRemoteProvider,
  toNativeProviderId,
} from "./runtime.js";
import { stubOllamaFetch, type OllamaStub } from "./ollama-fetch-stub.js";

function makeRuntime(
  overrides: Partial<ConstructorParameters<typeof CodePilotRuntime>[0]> = {},
): CodePilotRuntime {
  return new CodePilotRuntime({
    workspaceRoot: process.cwd(),
    providerId: "ollama",
    modelId: "qwen3:8b",
    agentMode: "act",
    // Tests play the permission pipeline: the gate path itself is covered
    // by M4 suites; here tools must reach execution.
    requestApproval: async () => ({ approved: true }),
    ...overrides,
  });
}

/** Construct + initialize + register cleanup. */
async function makeStartedRuntime(
  overrides: Partial<ConstructorParameters<typeof CodePilotRuntime>[0]> = {},
): Promise<CodePilotRuntime> {
  const rt = makeRuntime(overrides);
  await rt.initialize();
  return rt;
}

let stub: OllamaStub | null = null;

afterEach(() => {
  stub?.restore();
  stub = null;
  vi.unstubAllGlobals();
});

/** Chat-completions requests (OpenAI-family wire) seen by the stub. */
function chatCompletionRequests(s: OllamaStub) {
  return s.requests.filter((r) => r.url.includes("/chat/completions"));
}

/** Ollama chat requests seen by the stub. */
function ollamaChatRequests(s: OllamaStub) {
  return s.requests.filter((r) => r.url.includes("/api/chat"));
}

describe("M12 v2 — verbatim resume runtime behavior", () => {
  it("initialMessages seed the session transcript sent to the provider", async () => {
    stub = stubOllamaFetch([{ texts: ["Continuing."] }]);
    const rt = await makeStartedRuntime({ privacyMode: "local" });
    try {
      const initialMessages = [
        { role: "user" as const, content: "Inspect the project" },
        {
          role: "assistant" as const,
          content: [
            { type: "text" as const, text: "Reading files." },
            {
              type: "tool_use" as const,
              id: "c1",
              name: "read_files",
              input: { path: "a.ts" },
            },
          ],
        },
        {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              tool_use_id: "c1",
              name: "read_files",
              content: "file body",
            },
          ],
        },
      ];
      await rt.startSession("Continue the task from where it left off.", {
        initialMessages,
      });
      // The resumed history must reach the provider wire: the first chat
      // request body carries the seeded user turn and assistant text.
      const first = ollamaChatRequests(stub)[0];
      expect(first).toBeTruthy();
      const wire = JSON.stringify(first!.body);
      expect(wire).toContain("Inspect the project");
      expect(wire).toContain("Reading files.");
    } finally {
      await rt.dispose();
    }
  });

  it("concurrent startSession is denied — only one run owns the runtime", async () => {
    const rt = await makeStartedRuntime({ privacyMode: "local" });
    try {
      // Simulate an in-flight run: mark running and un-settled.
      (rt as unknown as { state: { status: string } }).state.status =
        "running";
      (rt as unknown as { runSettled: boolean }).runSettled = false;
      await expect(rt.startSession("second run")).rejects.toThrow(
        /already running/i,
      );
    } finally {
      await rt.dispose();
    }
  });

  it("a settled (finished) run does not block the next startSession", async () => {
    stub = stubOllamaFetch([{ texts: ["first."] }, { texts: ["second."] }]);
    const rt = await makeStartedRuntime({ privacyMode: "local" });
    try {
      await rt.startSession("first");
      await expect(rt.startSession("second")).resolves.toBeTruthy();
      expect(ollamaChatRequests(stub)).not.toHaveLength(0);
    } finally {
      await rt.dispose();
    }
  });
});

describe("isRemoteProvider — remote/local classification", () => {
  it("classifies local runtimes as local", () => {
    expect(isRemoteProvider("ollama")).toBe(false);
    expect(isRemoteProvider("lmstudio")).toBe(false);
  });

  it("classifies cloud/gateway catalogue providers as remote", () => {
    expect(isRemoteProvider("openai-native")).toBe(true);
    expect(isRemoteProvider("anthropic")).toBe(true);
    expect(isRemoteProvider("openrouter")).toBe(true);
    expect(isRemoteProvider("gemini")).toBe(true);
  });

  it("fail-closed: unknown providers count as remote", () => {
    expect(isRemoteProvider("totally-unknown-provider")).toBe(true);
  });

  it("legacy alias maps google onto the gemini family, others pass through", () => {
    // The native LLM registry accepts CodePilot ids directly; only the
    // historical google→gemini alias remains.
    expect(toNativeProviderId("openai")).toBe("openai");
    expect(toNativeProviderId("google")).toBe("gemini");
    expect(toNativeProviderId("openrouter")).toBe("openrouter");
  });
});

describe("D/E: atomic provider switch via updateConfig", () => {
  it("D: the next session starts with the FULL new provider config", async () => {
    stub = stubOllamaFetch([{ texts: ["switched."] }]);
    const rt = await makeStartedRuntime({
      providerId: "ollama",
      modelId: "qwen3:8b",
      baseUrl: "http://localhost:11434",
      privacyMode: "cloud",
    });
    try {
      // Atomic switch: OpenRouter config arrives as ONE patch.
      rt.updateConfig({
        providerId: "openrouter",
        modelId: "deepseek/deepseek-chat-v3.1:free",
        apiKey: "sk-or-test-123",
        baseUrl: "https://openrouter.ai/api/v1",
      });

      await rt.startSession("hello");

      // The wire proves atomicity: OpenRouter endpoint + new model + new
      // key, and the stale Ollama loopback URL is gone entirely.
      const chats = chatCompletionRequests(stub);
      expect(chats.length).toBeGreaterThan(0);
      expect(chats[0]!.url).toBe(
        "https://openrouter.ai/api/v1/chat/completions",
      );
      const body = chats[0]!.body as Record<string, unknown>;
      expect(body["model"]).toBe("deepseek/deepseek-chat-v3.1:free");
      const headers = (chats[0]!.headers ?? {}) as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer sk-or-test-123");
      // OpenRouter attribution headers travel with the request.
      expect(headers["HTTP-Referer"]).toContain("github.com");
      for (const r of stub.requests) {
        expect(r.url).not.toContain("localhost:11434");
      }
    } finally {
      await rt.dispose();
    }
  });

  it("E: explicit null CLEARS apiKey/baseUrl — no stale value survives a switch", async () => {
    stub = stubOllamaFetch([]);
    const rt = await makeStartedRuntime({
      providerId: "ollama",
      modelId: "qwen3:8b",
      baseUrl: "http://localhost:11434",
      apiKey: "ollama-does-not-need-one",
      privacyMode: "cloud",
    });
    try {
      // Host contract (buildProviderSwitchPatch): a target provider with no
      // stored key and no override sends null for BOTH — clear, don't reuse.
      rt.updateConfig({
        providerId: "openai-native",
        modelId: "gpt-5.6",
        apiKey: null,
        baseUrl: null,
      });

      // Fail-closed: without a key the native provider cannot be
      // constructed — the session fails with a missing-key error and NO
      // request (stale or otherwise) reaches the wire.
      await expect(rt.startSession("hello")).rejects.toThrow(
        /API key is required/i,
      );
      expect(chatCompletionRequests(stub)).toHaveLength(0);
    } finally {
      await rt.dispose();
    }
  });

  it("E2: reverse switch back to Ollama restores the Ollama base URL", async () => {
    stub = stubOllamaFetch([{ texts: ["back local."] }]);
    const rt = await makeStartedRuntime({
      providerId: "openai-native",
      modelId: "gpt-5.6",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      privacyMode: "cloud",
    });
    try {
      // Switch patch the host builds for ollama: provider + model + clear key
      // + resolved Ollama baseUrl.
      rt.updateConfig({
        providerId: "ollama",
        modelId: "qwen3:8b",
        apiKey: null,
        baseUrl: "http://localhost:11434",
      });

      await rt.startSession("hello");

      // Local endpoint restored, cleared key NOT sent on the wire.
      const chats = ollamaChatRequests(stub);
      expect(chats.length).toBeGreaterThan(0);
      expect(chats[0]!.url).toContain("localhost:11434");
      const body = chats[0]!.body as Record<string, unknown>;
      expect(body["model"]).toBe("qwen3:8b");
      const headers = (chats[0]!.headers ?? {}) as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
    } finally {
      await rt.dispose();
    }
  });

  it("D2: undefined leaves fields untouched (partial updates stay partial)", async () => {
    stub = stubOllamaFetch([{ texts: ["ok."] }]);
    const rt = await makeStartedRuntime({
      providerId: "ollama",
      modelId: "qwen3:8b",
      baseUrl: "http://localhost:11434",
      privacyMode: "cloud",
    });
    try {
      rt.updateConfig({ modelId: "qwen2.5-coder:3b" });
      await rt.startSession("hello");
      const chats = ollamaChatRequests(stub);
      expect(chats.length).toBeGreaterThan(0);
      const body = chats[0]!.body as Record<string, unknown>;
      expect(body["model"]).toBe("qwen2.5-coder:3b");
      expect(chats[0]!.url).toContain("localhost:11434");
    } finally {
      await rt.dispose();
    }
  });
});

describe("G: privacy guard — cloud provider + local privacy mode", () => {
  it("blocks startSession before ANY model request is made", async () => {
    stub = stubOllamaFetch([]);
    const rt = await makeStartedRuntime({
      providerId: "openai-native",
      modelId: "gpt-5.6",
      privacyMode: "local",
    });
    try {
      await expect(rt.startSession("explain the repo")).rejects.toMatchObject({
        message: expect.stringMatching(/privacy/i),
      });
      // No request of any kind left the host.
      expect(stub.requests).toHaveLength(0);
    } finally {
      await rt.dispose();
    }
  });

  it("blocks ALL remote providers under local privacy, not just OpenAI", async () => {
    for (const providerId of ["anthropic", "openrouter", "gemini"]) {
      stub = stubOllamaFetch([]);
      const rt = await makeStartedRuntime({
        providerId,
        modelId: "any",
        privacyMode: "local",
      });
      try {
        await expect(rt.startSession("hi")).rejects.toMatchObject({
          message: expect.stringMatching(/privacy/i),
        });
        expect(stub.requests).toHaveLength(0);
      } finally {
        await rt.dispose();
      }
      stub.restore();
      stub = null;
    }
  });

  it("permits local providers under local privacy (Ollama still works)", async () => {
    stub = stubOllamaFetch([{ texts: ["local ok."] }]);
    const rt = await makeStartedRuntime({
      providerId: "ollama",
      modelId: "qwen3:8b",
      privacyMode: "local",
      baseUrl: "http://localhost:11434",
    });
    try {
      await expect(rt.startSession("hello")).resolves.toBeTruthy();
      const chats = ollamaChatRequests(stub);
      expect(chats.length).toBeGreaterThan(0);
      expect((chats[0]!.body as Record<string, unknown>)["model"]).toBe(
        "qwen3:8b",
      );
    } finally {
      await rt.dispose();
    }
  });

  it("cloud privacy mode permits remote providers (explicit user choice)", async () => {
    stub = stubOllamaFetch([{ texts: ["cloud ok."] }]);
    const rt = await makeStartedRuntime({
      providerId: "openai-native",
      modelId: "gpt-5.6",
      privacyMode: "cloud",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
    });
    try {
      await expect(rt.startSession("hi")).resolves.toBeTruthy();
      const chats = chatCompletionRequests(stub);
      expect(chats.length).toBeGreaterThan(0);
      expect(chats[0]!.url).toBe(
        "https://api.openai.com/v1/chat/completions",
      );
    } finally {
      await rt.dispose();
    }
  });
});

// The guard lives in startSession, so EVERY new session re-validates. This
// keeps a live Ollama session from silently becoming a cloud session after a
// mid-session provider switch while privacy is still "local".
describe("guard re-evaluation per session", () => {
  it("a runtime switched to a remote provider re-checks privacy at each start", async () => {
    stub = stubOllamaFetch([{ texts: ["local task done."] }]);
    const rt = await makeStartedRuntime({
      providerId: "ollama",
      modelId: "qwen3:8b",
      privacyMode: "local",
      baseUrl: "http://localhost:11434",
    });
    try {
      // First session: local — allowed.
      await expect(rt.startSession("local task")).resolves.toBeTruthy();

      // Mid-session switch to OpenRouter (user clicked a different provider).
      rt.updateConfig({
        providerId: "openrouter",
        modelId: "deepseek/deepseek-chat-v3.1:free",
        apiKey: "sk-or-x",
        baseUrl: "https://openrouter.ai/api/v1",
      });

      // Next session must be blocked — the switch cannot silently go cloud.
      await expect(rt.startSession("next task")).rejects.toMatchObject({
        message: expect.stringMatching(/privacy/i),
      });
      // The blocked start never reached the OpenRouter endpoint.
      for (const r of stub.requests) {
        expect(r.url).not.toContain("openrouter.ai");
      }
    } finally {
      await rt.dispose();
    }
  });
});
