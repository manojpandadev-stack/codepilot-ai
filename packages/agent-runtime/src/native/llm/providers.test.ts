/**
 * Native provider image-block mapping (deterministic, no network).
 *
 * Proves each vendor adapter translates validated image blocks into its own
 * wire shape, rejects fileRef-only blocks loudly (host must resolve bytes
 * first), rejects assistant-position images, and leaves text-only behavior
 * exactly unchanged.
 */
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../types.js";
import { toOllamaMessages } from "./ollama.js";
import { toOpenAiMessages } from "./openai-compatible.js";
import { toAnthropicMessages } from "./anthropic.js";
import { toGeminiContents } from "./google.js";

const IMG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function userWithImage(text = "look"): AgentMessage[] {
  return [
    {
      role: "user",
      content: [
        {
          type: "image",
          mime: "image/png",
          dataBase64: IMG_B64,
          name: "shot.png",
          sizeBytes: 95,
        },
        { type: "text", text },
      ],
    },
  ];
}

describe("ollama image mapping", () => {
  it("attaches base64 as images[] on the user message", () => {
    const out = toOllamaMessages(userWithImage());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      role: "user",
      content: "look",
      images: [IMG_B64],
    });
  });

  it("emits an image-only turn (no text required)", () => {
    const out = toOllamaMessages(userWithImage(""));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ role: "user", images: [IMG_B64] });
  });

  it("rejects fileRef-only blocks instead of dropping them", () => {
    expect(() =>
      toOllamaMessages([
        {
          role: "user",
          content: [
            { type: "image", mime: "image/png", fileRef: "images/x.bin" },
          ],
        },
      ]),
    ).toThrow(/no inline bytes/);
  });

  it("rejects assistant-position images", () => {
    expect(() =>
      toOllamaMessages([
        {
          role: "assistant",
          content: [{ type: "image", mime: "image/png", dataBase64: IMG_B64 }],
        },
      ]),
    ).toThrow(/only supported in user messages/);
  });

  it("leaves text-only behavior unchanged", () => {
    expect(toOllamaMessages([{ role: "user", content: "hi" }])).toEqual([
      { role: "user", content: "hi" },
    ]);
  });
});

describe("openai-compatible image mapping", () => {
  it("builds image_url data-URL content parts", () => {
    const out = toOpenAiMessages(userWithImage());
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${IMG_B64}` },
        },
      ],
    });
  });

  it("rejects fileRef-only and assistant-position images", () => {
    expect(() =>
      toOpenAiMessages([
        {
          role: "user",
          content: [
            { type: "image", mime: "image/png", fileRef: "images/x.bin" },
          ],
        },
      ]),
    ).toThrow(/no inline bytes/);
    expect(() =>
      toOpenAiMessages([
        {
          role: "assistant",
          content: [{ type: "image", mime: "image/png", dataBase64: IMG_B64 }],
        },
      ]),
    ).toThrow(/only supported in user messages/);
  });
});

describe("anthropic image mapping", () => {
  it("builds base64 source blocks", () => {
    const out = toAnthropicMessages(userWithImage());
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: IMG_B64 },
        },
      ],
    });
  });

  it("rejects fileRef-only and assistant-position images", () => {
    expect(() =>
      toAnthropicMessages([
        {
          role: "user",
          content: [
            { type: "image", mime: "image/jpeg", fileRef: "images/x.bin" },
          ],
        },
      ]),
    ).toThrow(/no inline bytes/);
    expect(() =>
      toAnthropicMessages([
        {
          role: "assistant",
          content: [{ type: "image", mime: "image/png", dataBase64: IMG_B64 }],
        },
      ]),
    ).toThrow(/only supported in user messages/);
  });
});

describe("gemini image mapping", () => {
  it("builds inlineData parts", () => {
    const { contents } = toGeminiContents(userWithImage());
    expect(contents).toHaveLength(1);
    expect(contents[0]).toEqual({
      role: "user",
      parts: [
        { text: "look" },
        { inlineData: { mimeType: "image/png", data: IMG_B64 } },
      ],
    });
  });

  it("rejects fileRef-only and assistant-position images", () => {
    expect(() =>
      toGeminiContents([
        {
          role: "user",
          content: [
            { type: "image", mime: "image/webp", fileRef: "images/x.bin" },
          ],
        },
      ]),
    ).toThrow(/no inline bytes/);
    expect(() =>
      toGeminiContents([
        {
          role: "assistant",
          content: [{ type: "image", mime: "image/png", dataBase64: IMG_B64 }],
        },
      ]),
    ).toThrow(/only supported in user messages/);
  });
});
