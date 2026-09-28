/**
 * Vision fail-closed guard (runtime ↔ catalogue contract).
 *
 * The runtime must consult `modelSupportsVision` BEFORE any provider request:
 *   - a model the catalogue knows is text-only (explicit entry without a
 *     vision capability, e.g. ollama/qwen3:8b) rejects image-bearing input
 *     with a clear error and makes NO network call;
 *   - a statically-unknowable pair (local model absent from the catalogue,
 *     e.g. ollama/llava) is allowed through — the local server owns the
 *     truth — and the image bytes must actually reach the wire payload.
 *
 * The model layer is stubbed Ollama NDJSON (no network, deterministic);
 * the guard, agent loop, and wire payloads are genuine.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodePilotRuntime } from "./runtime.js";
import { stubOllamaFetch } from "./ollama-fetch-stub.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeRuntime(modelId: string): CodePilotRuntime {
  return new CodePilotRuntime({
    workspaceRoot: process.cwd(),
    providerId: "ollama",
    modelId,
    agentMode: "act",
    requestApproval: async () => ({ approved: true }),
  });
}

describe("CodePilotRuntime — vision fail-closed guard", () => {
  it("rejects image input for a catalogued text-only model before any request", async () => {
    const stub = stubOllamaFetch([{ texts: ["must never be consumed"] }]);
    const runtime = makeRuntime("qwen3:8b");
    const errors: string[] = [];
    runtime.subscribe((event) => {
      if (event.type === "error" && "error" in event) {
        errors.push(String(event.error));
      }
    });
    try {
      await expect(
        runtime.startSession("look at this", {
          initialMessages: [
            {
              role: "user",
              content: [
                { type: "text", text: "look" },
                { type: "image", mime: "image/png", dataBase64: "aGVsbG8=" },
              ],
            },
          ],
        }),
      ).rejects.toThrow(/does not support image input/);

      // Fail-closed: not a single provider request may have been made.
      expect(
        stub.requests.filter((r) => r.url.includes("/api/chat")),
      ).toHaveLength(0);

      // The failure is surfaced as a non-recoverable error event, naming the
      // model and provider so the user knows what to switch.
      expect(errors.join("\n")).toMatch(/does not support image input/);
      expect(errors.join("\n")).toContain("qwen3:8b");
    } finally {
      await runtime.dispose();
    }
  });

  it("allows image input for a statically-unknowable local model and sends the bytes", async () => {
    const stub = stubOllamaFetch([{ texts: ["The image shows a test."] }]);
    const runtime = makeRuntime("llava"); // absent from the catalogue
    let completed = 0;
    runtime.subscribe((event) => {
      if (event.type === "completed") completed += 1;
    });
    try {
      await runtime.startSession("what is in this image?", {
        initialMessages: [
          {
            role: "user",
            content: [
              { type: "image", mime: "image/png", dataBase64: "aGVsbG8=" },
            ],
          },
        ],
      });
      expect(completed).toBe(1);
      // The image bytes must actually ride the wire (top-level images field).
      const chat = stub.requests.find((r) => r.url.includes("/api/chat"));
      const messages =
        (chat?.body as { messages?: Array<Record<string, unknown>> })
          ?.messages ?? [];
      const user = messages.find((m) => m.role === "user");
      expect(user?.images).toEqual(["aGVsbG8="]);
    } finally {
      await runtime.dispose();
    }
  });
});
