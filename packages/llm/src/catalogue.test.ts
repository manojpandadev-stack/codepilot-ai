/**
 * @codepilot/llm — provider/model vision capability tests.
 *
 * `modelSupportsVision` is the gate the agent runtime consults before it
 * sends image content (see runtime's fail-closed vision guard). The contract
 * under test:
 *
 *   true      → catalogue knows this exact model accepts image input
 *   false     → catalogue knows it does NOT (runtime must fail closed)
 *   undefined → capability is statically unknowable (local/BYO endpoints);
 *               the runtime allows the request and the server owns the truth
 *
 * Zero network: pure catalogue lookups.
 */

import { describe, it, expect } from "vitest";
import { modelSupportsVision, modelToolCallingSupport } from "./catalogue.js";

describe("modelSupportsVision — catalogued models decide by capability", () => {
  it("reports true for catalogued vision models", () => {
    expect(modelSupportsVision("openai-native", "gpt-4o")).toBe(true);
    expect(modelSupportsVision("openai-native", "gpt-4o-mini")).toBe(true);
    expect(modelSupportsVision("gemini", "gemini-2.5-pro")).toBe(true);
    expect(modelSupportsVision("google", "gemini-2.5-pro")).toBe(true);
  });

  it("reports false for a catalogued text-only model (fail-closed signal)", () => {
    expect(modelSupportsVision("ollama", "qwen3:8b")).toBe(false);
  });
});

describe("modelSupportsVision — statically unknowable pairs return undefined", () => {
  it("treats local runtimes as unknowable (user installs the model)", () => {
    expect(modelSupportsVision("ollama", "llava")).toBeUndefined();
    expect(modelSupportsVision("lmstudio", "any-model")).toBeUndefined();
  });

  it("honors an explicit catalogued entry for a local model (qwen3:8b)", () => {
    // qwen3:8b has an explicit catalogue entry whose capabilities lack vision,
    // so the catalogue KNOWS it is text-only — explicit per-model metadata
    // outranks the local-runtime-unknowable rule. The runtime must fail
    // closed rather than send image blocks to a text-only model.
    expect(modelSupportsVision("ollama", "qwen3:8b")).toBe(false);
    expect(modelSupportsVision("ollama", "qwen2.5-coder:3b")).toBe(false);
  });

  it("treats bring-your-own endpoints as unknowable", () => {
    expect(
      modelSupportsVision("openai-compatible", "any-model"),
    ).toBeUndefined();
    expect(modelSupportsVision("custom", "any-model")).toBeUndefined();
    expect(modelSupportsVision("openai", "gpt-4o")).toBeUndefined();
  });

  it("returns undefined for an unknown provider id", () => {
    expect(modelSupportsVision("not-a-provider", "any-model")).toBeUndefined();
  });

  it("falls back to provider-level capabilities for an unlisted model", () => {
    // openai-native's provider-level capabilities are tools+streaming only, so
    // an unlisted model is treated as text-only (false) rather than unknown.
    expect(modelSupportsVision("openai-native", "gpt-5-unknown")).toBe(false);
  });
});

// ============================================================================
// modelToolCallingSupport — tri-state native tool-calling capability
// (Phase 3, tool automation reliability). Policy under test:
//   "true"    → authoritative evidence of native structured tool calls
//   "false"   → authoritative evidence the model cannot emit them
//   "unknown" → no reliable evidence; the runtime MUST NOT disable the
//               native tool pipeline on unknown (no silent capability loss)
// ============================================================================

describe("modelToolCallingSupport — tri-state policy", () => {
  it("reports authoritative support for a verified model (qwen3:8b)", () => {
    expect(modelToolCallingSupport("ollama", "qwen3:8b")).toBe("true");
  });

  it("reports unknown for qwen2.5-coder:3b — no invented support claim", () => {
    // The catalogue must NOT claim reliable tool calling for this model:
    // live observation shows it sometimes answers an explicit terminal
    // request in prose instead of emitting a structured tool call, and no
    // authoritative metadata establishes support. "unknown" keeps the
    // native pipeline enabled while refusing to overclaim.
    expect(modelToolCallingSupport("ollama", "qwen2.5-coder:3b")).toBe(
      "unknown",
    );
  });

  it("never reports false from absence of evidence", () => {
    // A catalogued model without a toolCallingSupport field is unknown, not
    // false — absence of curated evidence is never a denial.
    expect(modelToolCallingSupport("openai-native", "gpt-4o")).toBe("unknown");
    expect(
      modelToolCallingSupport("anthropic", "claude-sonnet-4-20250514"),
    ).toBe("unknown");
  });

  it("treats unlisted local-runtime and BYO models as unknown (never false)", () => {
    expect(modelToolCallingSupport("ollama", "llava")).toBe("unknown");
    expect(modelToolCallingSupport("lmstudio", "any-model")).toBe("unknown");
    expect(modelToolCallingSupport("openai-compatible", "any-model")).toBe(
      "unknown",
    );
    expect(modelToolCallingSupport("custom", "any-model")).toBe("unknown");
    expect(modelToolCallingSupport("openai", "gpt-x")).toBe("unknown");
  });

  it("falls back to provider-level tool capability as a weak true signal", () => {
    // Provider-level metadata is a protocol claim: enough for "true", never
    // for "false".
    expect(modelToolCallingSupport("openai-native", "gpt-5-unknown")).toBe(
      "true",
    );
    expect(modelToolCallingSupport("gemini", "some-model")).toBe("true");
  });

  it("returns unknown for an unknown provider id", () => {
    expect(modelToolCallingSupport("not-a-provider", "any-model")).toBe(
      "unknown",
    );
  });
});
