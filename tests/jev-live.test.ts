/**
 * Jev decision routing — OPT-IN LIVE test (excluded from the default suite).
 *
 * Runs ONE real classification against the TypeSafe AI API using the
 * verified official SDK. Requires BOTH:
 *   CODEPILOT_JEV_LIVE=1  (explicit opt-in: this sends a remote request)
 *   TYPESAFE_API_KEY      (a real TypeSafe API key; never logged)
 *
 * Without both, every test here skips. The normal suite never needs a key.
 */
import { describe, expect, it } from "vitest";
import { JevIntentRouter } from "../packages/decision-router/src/jev.js";

const LIVE =
  process.env.CODEPILOT_JEV_LIVE === "1" &&
  typeof process.env.TYPESAFE_API_KEY === "string" &&
  process.env.TYPESAFE_API_KEY.length > 0;

describe.skipIf(!LIVE)("jev live classification", () => {
  it(
    "returns a real typed decision for an explanation request",
    async () => {
      const router = new JevIntentRouter({
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        apiKey: process.env.TYPESAFE_API_KEY!,
        model: "jev-latest",
        timeoutMs: 20_000,
      });
      const decision = await router.classify({
        text: "Explain what a for loop does in JavaScript",
        mode: "ask",
      });
      // A REAL model verdict: typed, in-schema, confident — never fabricated.
      expect(decision.source).toBe("jev");
      expect(decision.intent).toBe("explain_code");
      expect(decision.confidence).toBeGreaterThanOrEqual(0.5);
      expect(decision.confidence).toBeLessThanOrEqual(1);
      expect(typeof decision.modelId).toBe("string");
      expect(decision.modelId).toMatch(/^jev-/);
    },
    30_000,
  );
});
