import { describe, expect, it } from "vitest";
import {
  INTENT_KINDS,
  isIntentKind,
  isValidConfidence,
  toComplexityLevel,
  uncertainDecision,
} from "./intent.js";

describe("intent contracts", () => {
  it("defines exactly the six supported intents", () => {
    expect([...INTENT_KINDS].sort()).toEqual(
      [
        "debug_error",
        "explain_code",
        "general_chat",
        "generate_new_code",
        "refactor",
        "write_tests",
      ].sort(),
    );
  });

  it("validates intent ids strictly", () => {
    expect(isIntentKind("debug_error")).toBe(true);
    expect(isIntentKind("uncertain")).toBe(false);
    expect(isIntentKind("DELETE")).toBe(false);
    expect(isIntentKind(undefined)).toBe(false);
    expect(isIntentKind(42)).toBe(false);
  });

  it("validates confidence in [0, 1]", () => {
    expect(isValidConfidence(0)).toBe(true);
    expect(isValidConfidence(1)).toBe(true);
    expect(isValidConfidence(0.87)).toBe(true);
    expect(isValidConfidence(-0.1)).toBe(false);
    expect(isValidConfidence(1.1)).toBe(false);
    expect(isValidConfidence(Number.NaN)).toBe(false);
    expect(isValidConfidence("0.9")).toBe(false);
  });

  it("clamps raw scores to complexity levels", () => {
    expect(toComplexityLevel(-3)).toBe(0);
    expect(toComplexityLevel(0.2)).toBe(0);
    expect(toComplexityLevel(1.4)).toBe(1);
    expect(toComplexityLevel(2.6)).toBe(2);
    expect(toComplexityLevel(Number.NaN)).toBe(1);
    expect(toComplexityLevel(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it("builds a canonical uncertain decision", () => {
    const d = uncertainDecision("timeout", 12);
    expect(d.intent).toBe("uncertain");
    expect(d.confidence).toBe(0);
    expect(d.source).toBe("uncertain");
    expect(d.reason).toBe("timeout");
    expect(d.latencyMs).toBe(12);
  });
});
