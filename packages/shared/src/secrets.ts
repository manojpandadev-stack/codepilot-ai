/**
 * @codepilot/shared — canonical secret scrubber.
 *
 * THE single shared secret-scrubbing implementation for CodePilot. Every
 * sink (structured logs, tool audit JSONL, TaskStore persistence) funnels
 * through `scrubSecretsText` so no second redaction implementation can drift:
 * a bearer token caught by the audit trail is caught by task persistence too
 * (and vice versa).
 *
 * Span-preserving: non-secret context (URL scheme/host, query-string names)
 * survives; only credential VALUES are replaced. Detection (`containsSecret`)
 * simply compares scrubbed output — one rule set, two uses.
 */

interface SecretRule {
  /** `replacement` supports `$1` back-references for preserved context. */
  pattern: RegExp;
  replacement: string;
}

/** Query-string keys whose VALUES are credentials. */
const SECRET_QUERY_KEYS =
  "(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|key|secret|client[_-]?secret|password|passwd|pwd|sig|signature|auth|authorization)";

const SECRET_SCRUB_RULES: SecretRule[] = [
  // URL query credentials: `?token=…` / `&api_key=…`. Runs FIRST so the value
  // is bounded at the next `&`/`#` instead of swallowing the whole URL.
  {
    pattern: new RegExp(`([?&]${SECRET_QUERY_KEYS}=)[^&#\\s]*`, "gi"),
    replacement: "$1[REDACTED]",
  },
  // URL userinfo credentials: `https://user:pass@host` → scheme + host kept.
  { pattern: /(\bhttps?:\/\/)[^\s/@]+@/gi, replacement: "$1[REDACTED]@" },
  // "Bearer <token>" header form — the value after the label is the secret.
  // Leading boundary: "torchbearer x" must not match.
  { pattern: /\bbearer\s+\S+/gi, replacement: "[REDACTED]" },
  // `key: value` / `key=value` credential pairs.
  // Leading boundary: "monkey=banana" must not match on its "key=" tail.
  {
    pattern:
      /\b(?:api[_-]?key|apikey|token|secret|password|passwd|pwd|authorization|bearer)\s*[:=]\s*\S+/gi,
    replacement: "[REDACTED]",
  },
  // Provider-specific token shapes.
  // Leading boundary on sk-: "task-123…" / "flask-server" contain "sk-"
  // as a substring and must never match.
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}/g, replacement: "[REDACTED]" },
  { pattern: /\b(xox[a-z]?|github_pat)[-_][A-Za-z0-9_-]{16,}\b/g, replacement: "[REDACTED]" },
  { pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g, replacement: "[REDACTED]" },
  { pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: "[REDACTED]" },
  {
    pattern:
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: "[REDACTED]",
  },
  {
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED]",
  },
];

/**
 * Replace every credential span in `text` with `[REDACTED]`, preserving
 * non-secret context. Never throws (regexes are static, replacements total).
 */
export function scrubSecretsText(text: string): string {
  let out = text;
  for (const rule of SECRET_SCRUB_RULES) {
    // Global regexes are stateful (lastIndex) — reset so shared rules are
    // safe under concurrent/repeated calls.
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out;
}

/** True when `text` contains any credential span the scrubber would remove. */
export function containsSecretText(text: string): boolean {
  return scrubSecretsText(text) !== text;
}
