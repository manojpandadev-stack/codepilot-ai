/**
 * CodePilot AI — Jev decision routing: Jev-backed intent classifier.
 *
 * Uses the OFFICIAL TypeSafe AI JavaScript SDK (`@typesafe-ai/sdk`,
 * verified against docs.typesafe.ai + the published 0.6.0 package):
 * one `POST /v1/systemone` call carrying a Choice question (intent) and a
 * Score question (complexity), answered by `jev-latest` unless configured
 * otherwise. Every model output is validated against the allowed schema —
 * malformed, low-confidence, timed-out, and unavailable results all resolve
 * to an "uncertain" decision that must fall back to default routing.
 *
 * The adapter is a pure classifier: it never executes commands, approves
 * edits, touches permissions, or invokes tools.
 */
import {
  APITimeoutError,
  APIUserAbortError,
  TypeSafeClient,
  choice,
  score,
} from "@typesafe-ai/sdk";
import {
  INTENT_KINDS,
  isIntentKind,
  isValidConfidence,
  toComplexityLevel,
  uncertainDecision,
  type IntentKind,
  type RoutingDecision,
  type UncertainReason,
} from "./intent.js";
import {
  JEV_STATE_MAX_CHARS,
  type ClassifyInput,
  type ClassifyOptions,
  type IntentRouter,
} from "./router.js";

/** Default Jev model (official SDK default; resolves to jev-1.13.0). */
export const JEV_DEFAULT_MODEL = "jev-latest";

/** Default confidence gate (official confidence-routing pattern). */
export const JEV_DEFAULT_CONFIDENCE_THRESHOLD = 0.5;

/** Default per-call classifier timeout in milliseconds. */
export const JEV_DEFAULT_TIMEOUT_MS = 8000;

const INTENT_INSTRUCTIONS =
  "What is the developer asking for? Choose the single best match.";
const INTENT_CRITERIA: Record<IntentKind, string> = {
  generate_new_code:
    "Write, create, implement, or scaffold new code, files, functions, or features",
  debug_error:
    "Diagnose or fix an error, exception, failing test, crash, or broken behavior",
  write_tests:
    "Write unit, integration, or end-to-end tests, or add test coverage",
  explain_code:
    "Explain what code does, answer a question about code, or summarize behavior",
  refactor:
    "Restructure, clean up, simplify, rename, or migrate existing code without changing what it does",
  general_chat:
    "Greetings, thanks, small talk, or anything not covered by the other options",
};

const COMPLEXITY_INSTRUCTIONS = "How complex is this request to fulfill?";
const COMPLEXITY_CRITERIA = [
  "Simple request answerable directly",
  "Multi-step task within a small scope",
  "Complex multi-file implementation, redesign, or migration",
] as const;

export interface JevRouterConfig {
  /** TypeSafe API key (SecretStorage upstream; never logged). */
  apiKey: string;
  /** Jev model id or alias. Defaults to "jev-latest". */
  model?: string;
  /** Per-call timeout in milliseconds. Defaults to 8000. */
  timeoutMs?: number;
  /** Minimum intent confidence to accept. Defaults to 0.5. */
  confidenceThreshold?: number;
}

/**
 * Injectable SystemOne transport — the real SDK client by default, a mock in
 * tests. Operates on unknown payloads; validation happens in this module.
 */
export interface JevSystemOneLike {
  (
    request: { state: unknown; questions: unknown; model?: string },
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<unknown>;
}

function errorName(err: unknown): string {
  if (err instanceof APITimeoutError) return "APITimeoutError";
  if (err instanceof APIUserAbortError) return "APIUserAbortError";
  if (err instanceof Error) return err.name || "Error";
  return "Unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class JevIntentRouter implements IntentRouter {
  readonly name = "jev";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly confidenceThreshold: number;
  private readonly systemOne: JevSystemOneLike;

  constructor(config: JevRouterConfig, systemOne?: JevSystemOneLike) {
    if (!config.apiKey || config.apiKey.trim().length === 0) {
      throw new Error("JevIntentRouter requires an API key.");
    }
    this.apiKey = config.apiKey;
    this.model =
      config.model && config.model.trim().length > 0
        ? config.model.trim()
        : JEV_DEFAULT_MODEL;
    this.timeoutMs =
      typeof config.timeoutMs === "number" && config.timeoutMs > 0
        ? Math.floor(config.timeoutMs)
        : JEV_DEFAULT_TIMEOUT_MS;
    this.confidenceThreshold =
      typeof config.confidenceThreshold === "number" &&
      config.confidenceThreshold >= 0 &&
      config.confidenceThreshold <= 1
        ? config.confidenceThreshold
        : JEV_DEFAULT_CONFIDENCE_THRESHOLD;
    if (systemOne) {
      this.systemOne = systemOne;
    } else {
      const client = new TypeSafeClient({
        apiKey: this.apiKey,
        defaultModel: this.model,
        logLevel: "error",
      });
      this.systemOne = (request, options) =>
        client.systemOne(
          {
            state: request.state as never,
            questions: request.questions as never,
            ...(request.model !== undefined ? { model: request.model } : {}),
          },
          options,
        );
    }
  }

  async classify(
    input: ClassifyInput,
    options?: ClassifyOptions,
  ): Promise<RoutingDecision> {
    const started = Date.now();
    const elapsed = (): number => Date.now() - started;
    const text = (input.text ?? "").slice(0, JEV_STATE_MAX_CHARS).trim();
    if (text.length === 0) {
      return uncertainDecision("empty-input", elapsed());
    }
    if (options?.signal?.aborted) {
      return uncertainDecision("aborted", elapsed());
    }

    const timeoutMs =
      typeof options?.timeoutMs === "number" && options.timeoutMs > 0
        ? Math.floor(options.timeoutMs)
        : this.timeoutMs;

    const controller = new AbortController();
    let callerAborted = false;
    let timedOut = false;
    const signal = options?.signal;
    const onAbortRace = (): void => {
      callerAborted = true;
      controller.abort();
    };
    let abortReject: (err: Error) => void = () => undefined;
    const onAbortFired = (): void => {
      onAbortRace();
      abortReject(new Error("jev-classify-aborted"));
    };
    // A caller abort is raced explicitly (not only via the controller) so a
    // non-cooperative transport can never hold a cancelled turn either.
    const abortPromise =
      signal === undefined
        ? null
        : new Promise<never>((_, reject) => {
            abortReject = reject;
            if (signal.aborted) {
              onAbortFired();
              return;
            }
            signal.addEventListener("abort", onAbortFired, { once: true });
          });
    // Overall bound: aborting the controller asks cooperative transports to
    // stop, but the race below is what actually caps latency — a transport
    // that ignores the signal can never hold classify() past timeoutMs, and
    // its late settlement is discarded (Promise.race already observes it, so
    // no unhandled rejection escapes).
    let timeoutReject: (err: Error) => void = () => undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutReject = reject;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      timeoutReject(new Error("jev-classify-timeout"));
    }, timeoutMs);
    // The timer must not keep a CLI/test process alive on its own.
    if (typeof timer.unref === "function") timer.unref();

    try {
      const raw = await Promise.race([
        this.systemOne(
          {
            state: {
              request: text,
              ...(input.mode ? { mode: input.mode } : {}),
            },
            questions: {
              intent: choice(INTENT_INSTRUCTIONS, { ...INTENT_CRITERIA }),
              complexity: score(COMPLEXITY_INSTRUCTIONS, [
                ...COMPLEXITY_CRITERIA,
              ]),
            },
            model: this.model,
          },
          { signal: controller.signal, timeout: timeoutMs },
        ),
        timeoutPromise,
        ...(abortPromise === null ? [] : [abortPromise]),
      ]);
      if (callerAborted || options?.signal?.aborted) {
        return uncertainDecision("aborted", elapsed());
      }
      if (timedOut) {
        return uncertainDecision("timeout", elapsed());
      }
      return this.validateResponse(raw, elapsed());
    } catch (err) {
      if (callerAborted || options?.signal?.aborted) {
        return uncertainDecision("aborted", elapsed());
      }
      const name = errorName(err);
      const reason: UncertainReason =
        timedOut || name === "APITimeoutError" ? "timeout" : "unavailable";
      return uncertainDecision(reason, elapsed());
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbortFired);
    }
  }

  /**
   * Strict schema validation of one SystemOne response. Anything off-schema
   * (or below the confidence threshold) is an uncertain decision — never a
   * guess.
   */
  private validateResponse(raw: unknown, latencyMs: number): RoutingDecision {
    if (!isRecord(raw) || !isRecord(raw.answers)) {
      return uncertainDecision("invalid-response", latencyMs);
    }
    const intentAns = raw.answers["intent"];
    const complexityAns = raw.answers["complexity"];
    if (!isRecord(intentAns) || intentAns["type"] !== "choice") {
      return uncertainDecision("invalid-response", latencyMs);
    }
    if (!isIntentKind(intentAns["choice"])) {
      return uncertainDecision("invalid-response", latencyMs);
    }
    if (!isValidConfidence(intentAns["confidence"])) {
      return uncertainDecision("invalid-response", latencyMs);
    }
    if (!isRecord(intentAns["probabilities"])) {
      return uncertainDecision("invalid-response", latencyMs);
    }
    let probabilitySum = 0;
    for (const option of INTENT_KINDS) {
      const p = (intentAns["probabilities"] as Record<string, unknown>)[option];
      if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
        return uncertainDecision("invalid-response", latencyMs);
      }
      probabilitySum += p;
    }
    if (probabilitySum < 0.9 || probabilitySum > 1.1) {
      return uncertainDecision("invalid-response", latencyMs);
    }
    const confidence = intentAns["confidence"] as number;
    if (confidence < this.confidenceThreshold) {
      return uncertainDecision("low-confidence", latencyMs);
    }
    if (!isRecord(complexityAns) || complexityAns["type"] !== "score") {
      return uncertainDecision("invalid-response", latencyMs);
    }
    if (
      typeof complexityAns["score"] !== "number" ||
      !Number.isFinite(complexityAns["score"] as number)
    ) {
      return uncertainDecision("invalid-response", latencyMs);
    }
    if (!isValidConfidence(complexityAns["confidence"])) {
      return uncertainDecision("invalid-response", latencyMs);
    }
    const decision: RoutingDecision = {
      intent: intentAns["choice"] as IntentKind,
      complexity: toComplexityLevel(complexityAns["score"] as number),
      confidence,
      source: "jev",
      latencyMs,
    };
    if (isRecord(raw) && typeof raw["model"] === "string") {
      decision.modelId = raw["model"] as string;
    }
    return decision;
  }
}
