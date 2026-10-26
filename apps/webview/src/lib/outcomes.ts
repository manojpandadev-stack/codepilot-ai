// ============================================================================
// Outcome presentation — privacy blocks and provider test verdicts
// ----------------------------------------------------------------------------
// The HOST is authoritative for every outcome below. The WebView only renders
// what the host decided; it can never authorize network access, and it never
// infers security state by parsing human-readable error text when a structured
// flag is present.
//
// All three `describe*` functions accept `unknown` and FAIL SAFE: an
// unrecognized shape or a verdict this build has never heard of resolves to a
// neutral "unknown" view. An unknown value must never render as success, never
// render as a privacy block, and never crash the message pipeline.
// ============================================================================

/**
 * What kind of outcome this is. `privacy` is deliberately its own kind: it is
 * NOT a provider failure, NOT an auth failure, and NOT a network failure.
 */
export type OutcomeKind =
  | "privacy"
  | "auth"
  | "config"
  | "network"
  | "cancelled"
  | "timeout"
  | "success"
  | "unknown";

/** A rendered outcome: what happened, and what the user can do about it. */
export interface OutcomeView {
  kind: OutcomeKind;
  /** Short headline. Never implies an outcome it was not told. */
  title: string;
  /** The host's own wording, preserved verbatim (bounded). */
  detail?: string;
  /** Next step the user can take. Never "add a key to bypass Local Only". */
  action?: string;
  /** True ONLY when a privacy policy refused the request. */
  privacyBlocked: boolean;
  /** Provider the outcome is attributed to, when the host tagged it. */
  providerId?: string;
}

/** `privacy/result` acknowledgement, with the host's decision. */
export interface PrivacyOutcomeView extends OutcomeView {
  ok: boolean;
}

/**
 * Privacy-block action copy.
 *
 * Deliberately NEVER suggests adding an API key: credentials are orthogonal to
 * the policy, and offering "add a key" here would read as a way around Local
 * Only.
 */
const PRIVACY_ACTION =
  "Review the privacy mode, or select a local provider such as Ollama.";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Bound + trim a host string; never return an unbounded or empty detail. */
function boundedDetail(value: unknown, max = 400): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function providerLabel(providerId: string | undefined): string {
  return providerId ?? "The provider";
}

/**
 * Classify a `provider/inference_result` or `provider/test_result` verdict.
 *
 * Maps the STRUCTURED `state` only. Free text is used exclusively to separate
 * "cancelled" from "timed out" inside the `failed` bucket — never to decide
 * whether a request was privacy-blocked.
 */
export function describeProviderVerdict(payload: unknown): OutcomeView {
  const p = asRecord(payload);
  if (!p) {
    return {
      kind: "unknown",
      title: "Provider test did not report a result.",
      privacyBlocked: false,
    };
  }
  const providerId =
    typeof p.providerId === "string" && p.providerId.length > 0
      ? p.providerId
      : undefined;
  const state = p.state;
  const detail = boundedDetail(p.message);
  const name = providerLabel(providerId);
  const scoped = providerId ? { providerId } : {};

  switch (state) {
    case "blocked":
      // NOT "provider broken": nothing was sent, so the provider was never
      // tested. Rendering this as a failure would blame a healthy provider.
      // The provider is NAMED so the user knows what to switch away from.
      return {
        kind: "privacy",
        title: `Blocked by privacy policy: ${name}`,
        detail,
        action: PRIVACY_ACTION,
        privacyBlocked: true,
        ...scoped,
      };
    case "success":
      return {
        kind: "success",
        title: `${name} responded successfully.`,
        detail,
        privacyBlocked: false,
        ...scoped,
      };
    case "connected":
      return {
        kind: "success",
        title: `${name} is connected.`,
        detail,
        privacyBlocked: false,
        ...scoped,
      };
    case "auth-failed":
      return {
        kind: "auth",
        title: `${name} rejected the API key.`,
        detail,
        action: "Check the stored API key for this provider.",
        privacyBlocked: false,
        ...scoped,
      };
    case "auth-required":
      return {
        kind: "auth",
        title: `${name} needs an API key.`,
        detail,
        action: "Add an API key for this provider in the provider panel.",
        privacyBlocked: false,
        ...scoped,
      };
    case "auth-invalid":
      return {
        kind: "auth",
        title: `${name} rejected the API key.`,
        detail,
        action: "Replace the stored API key for this provider.",
        privacyBlocked: false,
        ...scoped,
      };
    case "invalid-config":
      return {
        kind: "config",
        title: `${name} is not configured correctly.`,
        detail,
        action: "Review this provider's settings.",
        privacyBlocked: false,
        ...scoped,
      };
    case "no-endpoint":
      return {
        kind: "config",
        title: `${name} has no testable endpoint.`,
        detail,
        privacyBlocked: false,
        ...scoped,
      };
    case "rate-limited":
      return {
        kind: "network",
        title: `${name} is rate limiting requests.`,
        detail,
        action: "Wait a moment and try again.",
        privacyBlocked: false,
        ...scoped,
      };
    case "unavailable":
      return {
        kind: "network",
        title: `${name} is unavailable.`,
        detail,
        action: "Check that the provider is running and reachable.",
        privacyBlocked: false,
        ...scoped,
      };
    case "failed": {
      // Same bucket, different causes: only the free text separates them, and
      // only WITHIN the failure direction. It can never upgrade a failure into
      // a privacy block or a success.
      const lower = (detail ?? "").toLowerCase();
      if (/cancel|abort/.test(lower)) {
        return {
          kind: "cancelled",
          title: `${name} test was cancelled.`,
          detail,
          privacyBlocked: false,
          ...scoped,
        };
      }
      if (/time ?out|timed out|did not respond in time/.test(lower)) {
        return {
          kind: "timeout",
          title: `${name} did not respond in time.`,
          detail,
          action: "Try again, or raise the provider timeout.",
          privacyBlocked: false,
          ...scoped,
        };
      }
      return {
        kind: "network",
        title: `${name} could not complete the test.`,
        detail,
        privacyBlocked: false,
        ...scoped,
      };
    }
    default:
      // FAIL SAFE: an unrecognized verdict is reported as unknown. It is never
      // shown as success and never shown as a privacy block.
      return {
        kind: "unknown",
        title: `${name} returned an unrecognized test result.`,
        detail,
        privacyBlocked: false,
        ...scoped,
      };
  }
}

/**
 * Classify a host `error` card.
 *
 * The host tags privacy refusals with `privacyBlocked: true`. That STRUCTURED
 * flag — never the message text — decides the outcome, so a privacy block can
 * never be mistaken for a provider or auth failure.
 */
export function describeErrorCard(payload: unknown): OutcomeView {
  const p = asRecord(payload);
  if (!p) {
    return {
      kind: "unknown",
      title: "An unknown error was reported.",
      privacyBlocked: false,
    };
  }
  const providerId =
    typeof p.providerId === "string" && p.providerId.length > 0
      ? p.providerId
      : undefined;
  const detail = boundedDetail(p.message);
  const name = providerLabel(providerId);
  const scoped = providerId ? { providerId } : {};

  // STRUCTURED privacy signal wins over everything else.
  if (p.privacyBlocked === true) {
    return {
      kind: "privacy",
      title: providerId
        ? `Blocked by privacy policy: ${providerId}`
        : "Blocked by privacy policy",
      detail: detail ?? "No request was made.",
      action: PRIVACY_ACTION,
      privacyBlocked: true,
      ...scoped,
    };
  }

  // Non-privacy classification. Text matching routes WITHIN the failure
  // direction only; it can never produce a privacy block. It also never
  // re-emits an Authorization header as an action.
  const text = detail ?? "";
  if (
    /\b(temporarily busy|model experiencing high demand|503 unavailable)\b/i.test(
      text,
    )
  ) {
    return {
      kind: "network",
      title:
        "Gemini is temporarily busy. Try again shortly or select another available model.",
      privacyBlocked: false,
      ...scoped,
    };
  }
  if (
    /\b(api key|credential|unauthori[sz]ed|forbidden|authentication)\b/i.test(
      text,
    )
  ) {
    return {
      kind: "auth",
      title: `${name} could not authenticate.`,
      detail,
      action: "Check the stored API key for this provider.",
      privacyBlocked: false,
      ...scoped,
    };
  }
  if (/time ?out|timed out|did not respond in time/i.test(text)) {
    return {
      kind: "timeout",
      title: `${name} did not respond in time.`,
      detail,
      action: "Try again, or raise the provider timeout.",
      privacyBlocked: false,
      ...scoped,
    };
  }
  if (/cancel|abort/i.test(text)) {
    return {
      kind: "cancelled",
      title: `${name} request was cancelled.`,
      detail,
      privacyBlocked: false,
      ...scoped,
    };
  }
  if (/\b(base url|not configured|invalid config)\b/i.test(text)) {
    return {
      kind: "config",
      title: `${name} is not configured correctly.`,
      detail,
      action: "Review this provider's settings.",
      privacyBlocked: false,
      ...scoped,
    };
  }
  return {
    kind: "network",
    title: `${name} request failed.`,
    detail,
    privacyBlocked: false,
    ...scoped,
  };
}

/**
 * Classify a `privacy/result` acknowledgement or rejection.
 *
 * UI feedback only: it reports what the HOST decided. A rejection never changes
 * privacy mode, and the WebView cannot enable network access.
 */
export function describePrivacyResult(payload: unknown): PrivacyOutcomeView {
  const p = asRecord(payload);
  if (!p || typeof p.ok !== "boolean") {
    return {
      ok: false,
      kind: "unknown",
      title: "Privacy mode was not changed.",
      detail: "The host did not confirm a privacy mode update.",
      privacyBlocked: false,
    };
  }
  if (p.ok === false) {
    return {
      ok: false,
      kind: "config",
      title: "Privacy mode change was rejected.",
      detail: boundedDetail(p.error) ?? "The host rejected the requested mode.",
      action: "Choose a valid privacy mode in Settings.",
      privacyBlocked: false,
    };
  }
  const mode =
    boundedDetail(p.applied, 32) ??
    boundedDetail(p.mode, 32) ??
    "the requested mode";
  return {
    ok: true,
    kind: "success",
    title: `Privacy mode set to ${mode}.`,
    privacyBlocked: false,
  };
}
