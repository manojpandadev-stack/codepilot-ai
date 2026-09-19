import { describe, expect, it } from "vitest";

/**
 * REAL Ollama connectivity regression (requirements #1–#3).
 * Skips automatically when no local Ollama is reachable so CI stays green.
 * Uses plain fetch — no workspace imports needed at the repo root.
 */
const OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const EXPECTED_MODEL = "qwen3:8b";

async function ollamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

interface OllamaTag {
  name: string;
  size?: number;
  details?: { parameter_size?: string; quantization_level?: string };
}

describe("Ollama direct connectivity", () => {
  it("answers /api/tags on 127.0.0.1:11434", async () => {
    if (!(await ollamaReachable())) return;
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    expect(res.ok).toBe(true);
    const data = (await res.json()) as { models?: OllamaTag[] };
    expect(Array.isArray(data.models)).toBe(true);
  });

  it(`has ${EXPECTED_MODEL} installed`, { timeout: 60_000 }, async () => {
    if (!(await ollamaReachable())) return;
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const data = (await res.json()) as { models?: OllamaTag[] };
    const names = (data.models ?? []).map((m) => m.name);
    expect(names).toContain(EXPECTED_MODEL);
  });

  it("returns a real streaming completion for the canonical smoke prompt", { timeout: 240_000 }, async () => {
    if (!(await ollamaReachable())) return;
    const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: EXPECTED_MODEL,
        prompt: "Respond with exactly: CodePilot AI is working.",
        stream: true,
        think: false,
        options: { num_predict: 512 },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    expect(res.ok).toBe(true);
    expect(res.body).not.toBeNull();

    // Consume the NDJSON stream like the agent provider does.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let chunks = 0;
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (!line) continue;
        const obj = JSON.parse(line) as { response?: string; done?: boolean };
        if (typeof obj.response === "string") {
          chunks += 1;
          text += obj.response;
        }
      }
    }
    expect(chunks).toBeGreaterThan(0); // streamed, not one-shot
    expect(text.length).toBeGreaterThan(0); // real model output
  });
});

// ============================================================================
// Test Connection parity — the exact provider the VS Code host uses
// ============================================================================

import { OllamaProvider } from "../packages/model-gateway/src/index.js";
import type { ProviderHealth } from "../packages/model-gateway/src/index.js";

describe("Ollama Test Connection parity (gateway OllamaProvider)", () => {
  it("gateway healthCheck reports HEALTHY against the live server", { timeout: 30_000 }, async () => {
    if (!(await ollamaReachable())) return;
    const provider = new OllamaProvider({
      id: "ollama",
      name: "Ollama (Local)",
      type: "ollama",
      baseUrl: `${OLLAMA_BASE_URL}/`, // trailing slash, as the settings UI may store it
      enabled: true,
    });
    const health: ProviderHealth = await provider.healthCheck();
    expect(health.status).toBe("HEALTHY");
  });

  it("discovers installed models — including qwen3:8b — through /api/tags", { timeout: 30_000 }, async () => {
    if (!(await ollamaReachable())) return;
    const provider = new OllamaProvider({
      id: "ollama",
      name: "Ollama (Local)",
      type: "ollama",
      baseUrl: OLLAMA_BASE_URL,
      enabled: true,
    });
    const models = await provider.listModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain(EXPECTED_MODEL);
  });

  it("model switching: resolves qwen3:8b and returns null for an absent model", { timeout: 30_000 }, async () => {
    if (!(await ollamaReachable())) return;
    const provider = new OllamaProvider({
      id: "ollama",
      name: "Ollama (Local)",
      type: "ollama",
      baseUrl: OLLAMA_BASE_URL,
      enabled: true,
    });
    expect(await provider.getModel(EXPECTED_MODEL)).not.toBeNull();
    expect(await provider.getModel("no-such-model:latest")).toBeNull();
  });

  it("streams a real /api/chat completion — the production generation path", { timeout: 240_000 }, async () => {
    if (!(await ollamaReachable())) return;
    // The native Ollama provider POSTs to /api/chat with stream:true
    // and consumes the NDJSON incrementally. This mirrors that contract.
    const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: EXPECTED_MODEL,
        messages: [
          { role: "user", content: "Reply with exactly: CodePilot Ollama works." },
        ],
        stream: true,
        think: false,
        options: { num_predict: 64 },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    expect(res.ok).toBe(true);
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let chunks = 0;
    let text = "";
    let sawDone = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (!line) continue;
        const obj = JSON.parse(line) as {
          message?: { content?: string };
          done?: boolean;
        };
        if (typeof obj.message?.content === "string" && obj.message.content) {
          chunks += 1;
          text += obj.message.content;
        }
        if (obj.done === true) sawDone = true;
      }
    }
    expect(chunks).toBeGreaterThan(1); // incrementally streamed
    expect(text.length).toBeGreaterThan(0); // real model output
    expect(sawDone).toBe(true); // terminal NDJSON frame received
  });
});
