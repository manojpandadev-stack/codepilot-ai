/**
 * M6 — Context security.
 *
 * Two layers, both enforced at INGESTION time (before any content enters the
 * index, cache, or any retrieval path):
 *
 * 1. Sensitive-path blocking — files matching these patterns are never read,
 *    never indexed, never cached. Reading context is not permission to expose
 *    secrets to the LLM.
 * 2. Secret redaction — high-confidence credential patterns embedded in
 *    ordinary source files are replaced with [REDACTED] before storage.
 *    Only high-confidence patterns are used so ordinary code is not corrupted.
 */
import * as path from "node:path";

// ============================================================================
// Layer 1 — sensitive path policy
// ============================================================================

/**
 * Path patterns (workspace-relative, forward slashes, case-insensitive) that
 * must never enter model context. Kept explicit for auditability.
 */
export const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /^\.env(\.[^/]*)?$/,
  /(^|\/)\.env(\.[^/]*)?$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\..*)?$/i,
  /\.(pem|pfx|p12|keystore|jks|key)$/i,
  /(^|\/)credentials(\.json|\.txt)?$/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)\.kube(\/|$)/i,
  /application_default_credentials\.json$/i,
  /service[-_]?account[^/]*\.json$/i,
  /(^|\/)secrets?\.(json|ya?ml|txt|properties)$/i,
  /(^|\/)\.htpasswd$/i,
  /(^|\/)auth\.json$/i, // composer auth
  /(^|\/)\.kube$/i,
  /\.tfvars$/i, // terraform variable files often hold secrets
];

/** Normalize + test a workspace-relative path against sensitive policy. */
export function isSensitivePath(relativePath: string): boolean {
  const norm = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(norm));
}

// ============================================================================
// Layer 2 — embedded secret redaction
// ============================================================================

interface SecretRule {
  pattern: RegExp;
  replacement: string;
}

/**
 * High-confidence credential patterns. Deliberately narrow: false positives
 * would corrupt legitimate source code shown to the model.
 */
const SECRET_RULES: readonly SecretRule[] = [
  // AWS access key id
  {
    pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED_AWS_KEY]",
  },
  // GitHub tokens (classic + fine-grained)
  {
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  // OpenAI-style keys
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replacement: "[REDACTED_API_KEY]" },
  // Slack tokens
  {
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: "[REDACTED_SLACK_TOKEN]",
  },
  // Google API keys
  {
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replacement: "[REDACTED_GOOGLE_KEY]",
  },
  // PEM private key blocks (multiline)
  {
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  // JWTs (three base64url segments)
  {
    pattern:
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: "[REDACTED_JWT]",
  },
];

export interface RedactionResult {
  readonly content: string;
  /** Number of replacements applied (never the matched values). */
  readonly redactions: number;
}

/** Redact high-confidence secrets from arbitrary text. Never logs matches. */
export function redactSecrets(content: string): RedactionResult {
  let out = content;
  let count = 0;
  for (const rule of SECRET_RULES) {
    out = out.replace(rule.pattern, () => {
      count++;
      return rule.replacement;
    });
  }
  return { content: out, redactions: count };
}

/** True when the given path can be safely resolved inside `root`. */
export function isInsideWorkspace(root: string, absolutePath: string): boolean {
  const rel = path.relative(root, absolutePath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
