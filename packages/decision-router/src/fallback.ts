/**
 * CodePilot AI — Jev decision routing: deterministic local fallback.
 *
 * A zero-dependency, zero-network classifier used when Jev is disabled,
 * unreachable, or uncertain. Keyword scoring is deliberately transparent and
 * deterministic: the same text always yields the same decision. Confidence is
 * a heuristic share of matched weight — callers apply the same confidence
 * threshold they use for Jev before acting on it.
 */
import {
  INTENT_KINDS,
  uncertainDecision,
  type ComplexityLevel,
  type IntentKind,
  type RoutingDecision,
} from "./intent.js";
import { JEV_STATE_MAX_CHARS, type IntentRouter } from "./router.js";

interface WeightedPattern {
  pattern: RegExp;
  weight: number;
}

const INTENT_PATTERNS: Record<IntentKind, WeightedPattern[]> = {
  debug_error: [
    { pattern: /\btraceback\b|\bstack trace\b|\bexception\b/i, weight: 3 },
    { pattern: /\b\w*error\b|\bbug\b|\bcrash(?:es|ed|ing)?\b/i, weight: 2 },
    {
      pattern: /\bfail(?:s|ed|ing|ure)?\b|\bbroken\b|\bnot working\b/i,
      weight: 2,
    },
    { pattern: /\bwhy\b.{0,20}\b(?:error|fail)/i, weight: 2 },
    { pattern: /\bfix\b/i, weight: 1 },
  ],
  write_tests: [
    {
      pattern: /\bunit tests?\b|\bintegration tests?\b|\be2e tests?\b/i,
      weight: 3,
    },
    { pattern: /\btest coverage\b|\bcover with tests\b/i, weight: 3 },
    { pattern: /\bwrite tests?\b|\badd tests?\b|\btests? for\b/i, weight: 2 },
    { pattern: /\bwrite\b.{0,30}\btests?\b/i, weight: 2 },
    {
      pattern: /\bassert\b|\bjest\b|\bvitest\b|\bpytest\b|\bmocha\b/i,
      weight: 2,
    },
    { pattern: /\btest\b/i, weight: 1 },
  ],
  explain_code: [
    {
      pattern: /\bexplain\b|\bwhat does\b|\bhow does\b|\bwhy does\b/i,
      weight: 3,
    },
    { pattern: /\bwhat is\b|\bwhat are\b|\bmean(?:s|ing)?\b/i, weight: 2 },
    { pattern: /\bdocument\b|\bsummar(?:y|ize|ise)\b/i, weight: 1 },
  ],
  refactor: [
    { pattern: /\brefactor\b|\brestructur\w*\b/i, weight: 3 },
    { pattern: /\bclean ?up\b|\bsimplify\b|\bmigrat\w*\b/i, weight: 2 },
    { pattern: /\brename\b|\bextract\b|\bsplit\b/i, weight: 1 },
  ],
  generate_new_code: [
    {
      pattern: /\bcreat\w*\b|\bgenerat\w*\b|\bscaffold\b|\bimplement\b/i,
      weight: 2,
    },
    {
      pattern:
        /\bwrite\b.{0,30}\b(?:function|class|component|script|file|code|endpoint|api)\b/i,
      weight: 3,
    },
    {
      pattern:
        /\badd\b.{0,30}\b(?:feature|function|method|endpoint|command|support)\b/i,
      weight: 2,
    },
    {
      pattern:
        /\bnew\b.{0,30}\b(?:function|class|component|file|module|command)\b/i,
      weight: 2,
    },
    { pattern: /\bbuild\b/i, weight: 1 },
  ],
  general_chat: [
    {
      pattern: /^(hi|hey|hello|thanks|thank you|who are you|help)\b/i,
      weight: 3,
    },
    { pattern: /\bthanks?\b/i, weight: 1 },
  ],
};

/** Complexity hints: presence of multi-file/scale language. */
const COMPLEXITY_PATTERNS: Array<{ pattern: RegExp; level: ComplexityLevel }> =
  [
    {
      pattern:
        /\bmulti-?file\b|\bacross\b.{0,20}\bfiles\b|\bentire\b.{0,20}\b(codebase|repo|project)\b/i,
      level: 2,
    },
    { pattern: /\barchitect\w*\b|\bredesign\b|\bmicroserv\w*\b/i, level: 2 },
    { pattern: /\bseveral\b|\bmultiple\b|\bcomplex\b/i, level: 1 },
  ];

/**
 * Minimum matched weight for a non-uncertain verdict. Below this the
 * request carries no detectable intent signal.
 */
export const FALLBACK_MIN_WEIGHT = 2;

export class FallbackIntentRouter implements IntentRouter {
  readonly name = "fallback";

  classify(
    input: { text: string; mode?: string; taskId?: string },
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<RoutingDecision> {
    void options;
    const started = Date.now();
    const text = (input.text ?? "").slice(0, JEV_STATE_MAX_CHARS);
    if (text.trim().length === 0) {
      return Promise.resolve(
        uncertainDecision("empty-input", Date.now() - started),
      );
    }
    const scores = new Map<IntentKind, number>();
    let total = 0;
    for (const intent of INTENT_KINDS) {
      let score = 0;
      for (const { pattern, weight } of INTENT_PATTERNS[intent]) {
        if (pattern.test(text)) score += weight;
      }
      scores.set(intent, score);
      total += score;
    }
    let best: IntentKind = "general_chat";
    let bestScore = 0;
    for (const intent of INTENT_KINDS) {
      const score = scores.get(intent) ?? 0;
      if (score > bestScore) {
        best = intent;
        bestScore = score;
      }
    }
    const latencyMs = Date.now() - started;
    if (bestScore < FALLBACK_MIN_WEIGHT || total <= 0) {
      return Promise.resolve(uncertainDecision("low-confidence", latencyMs));
    }
    let complexity: ComplexityLevel =
      best === "refactor" || best === "generate_new_code" ? 1 : 0;
    for (const { pattern, level } of COMPLEXITY_PATTERNS) {
      if (pattern.test(text)) {
        complexity = level;
        break;
      }
    }
    return Promise.resolve({
      intent: best,
      complexity,
      confidence: Math.min(0.95, bestScore / total),
      source: "fallback" as const,
      latencyMs,
    });
  }
}
