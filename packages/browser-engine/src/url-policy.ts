/**
 * @codepilot/browser-engine — URL / network security policy (pure).
 *
 * Every browser navigation and every in-page network request passes through
 * this policy before any connection is attempted. It reuses the hardened
 * SSRF classifier from @codepilot/context-engine (strict IP classification,
 * no string-prefix checks, metadata/link-local/CGNAT coverage) so the browser
 * capability inherits the SAME security posture as the M13 fetch stack
 * instead of maintaining a second, diverging implementation.
 *
 * Layered model (all layers must pass):
 *   1. Scheme allow-list: http/https only.
 *   2. Credential hygiene: userinfo in URL is rejected (embedded creds).
 *   3. Host classification: IP literals via classify*, hostnames resolved and
 *      every resolved address checked (DNS-rebinding-resistant: all answers
 *      must be global — one private answer rejects the host).
 *   4. Domain allow/deny lists (suffix match) for policy-based control.
 */

import { promises as dnsPromises } from "node:dns";import * as net from "node:net";

// Context-engine's strict classifier. It is unexported from the barrel (the
// M13 module imports it internally), so we import from the module path via
// the package export map — added "exports" entry "./ssrf-guard".
import {
  checkHostnameTextual,
  classifyIPv4,
  classifyIPv6,
  isForbiddenIPLiteral,
  stripIpDecorations,
} from "@codepilot/context-engine/ssrf-guard";

// ============================================================================
// Types
// ============================================================================

export type UrlPolicyVerdict =
  | "allowed"
  | "blocked-scheme"
  | "blocked-credentials"
  | "blocked-private-network"
  | "blocked-denied-domain"
  | "blocked-not-allow-listed"
  | "blocked-dns"
  | "blocked-invalid";

export interface UrlPolicyDecision {
  verdict: UrlPolicyVerdict;
  /** Human-readable, secret-free reason (safe for approval UI + audit). */
  reason: string;
  /** Hostname/IP as validated (for audit logs; never creds or path). */
  host?: string;
}

export interface UrlPolicyOptions {
  /** Suffix-matched denied domains — always win over allow-list. */
  deniedDomains?: string[];
  /**
   * Suffix-matched allow-list. Empty = all globally-routable hosts allowed
   * (SSRF layer still applies). Non-empty = only listed hosts may load.
   */
  allowedDomains?: string[];
  /** Max redirect hops the caller may follow (enforced by BrowserService). */
  maxRedirects?: number;
  /**
   * Allow loopback/private targets. ONLY used by tests and explicit
   * user-approved local dev scenarios; the production default is false.
   */
  allowPrivateNetworks?: boolean;
}

// ============================================================================
// Core validation
// ============================================================================

/** Validate a URL string against the full layered policy. */
export async function validateTargetUrl(
  url: string,
  options: UrlPolicyOptions = {},
): Promise<UrlPolicyDecision> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { verdict: "blocked-invalid", reason: "invalid URL" };
  }

  // 1. Scheme allow-list — anything but http/https is rejected outright
  //    (file:, about:, chrome:, data:, view-source:, ws:, ftp:, …).
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      verdict: "blocked-scheme",
      reason: `protocol ${parsed.protocol} is not allowed (http/https only)`,
    };
  }

  // 2. Embedded credentials (@user:pass@host) — leak vector.
  if (parsed.username || parsed.password) {
    return {
      verdict: "blocked-credentials",
      reason: "URLs with embedded credentials are not allowed",
    };
  }

  const rawHost = parsed.hostname.toLowerCase();

  // 3. SSRF classification.
  const literal = isForbiddenIPLiteral(rawHost);
  if (literal.forbidden) {
    // Metadata IPs and friends are rejected regardless of lists.
    if (options.allowPrivateNetworks && /loopback|private|link-local/.test(literal.reason)) {
      // fall through — explicitly permitted private networks
    } else {
      return {
        verdict: "blocked-private-network",
        reason: `blocked by SSRF policy: ${literal.reason}`,
        host: rawHost,
      };
    }
  }

  if (net.isIP(rawHost) !== 0) {
    // Pure IP literal that survived step 3 is a global address — allow.
    if (!options.allowPrivateNetworks) {
      const cls = classifyIPv4(rawHost) ?? classifyIPv6(rawHost);
      if (cls && cls !== "global") {
        return {
          verdict: "blocked-private-network",
          reason: `IP is ${cls}, not globally routable`,
          host: rawHost,
        };
      }
    }
    return { verdict: "allowed", reason: "ok", host: rawHost };
  }

  // Hostname: strip decorations (trailing dot, brackets, zone ids).
  const host = stripIpDecorations(rawHost).toLowerCase();
  if (!host || host.length === 0) {
    return { verdict: "blocked-invalid", reason: "empty hostname", host: rawHost };
  }

  // 4. Domain lists.
  for (const denied of options.deniedDomains ?? []) {
    const d = denied.toLowerCase();
    if (host === d || host.endsWith(`.${d}`)) {
      return {
        verdict: "blocked-denied-domain",
        reason: `domain ${d} is denied`,
        host,
      };
    }
  }
  const allowed = options.allowedDomains ?? [];
  if (allowed.length > 0) {
    const ok = allowed.some((a) => {
      const al = a.toLowerCase();
      return host === al || host.endsWith(`.${al}`);
    });
    if (!ok) {
      return {
        verdict: "blocked-not-allow-listed",
        reason: `domain ${host} is not allow-listed`,
        host,
      };
    }
  }

  // 5. DNS resolution — rebinding resistance: EVERY resolved address must be
  //    globally routable. One private answer rejects the whole host (a
  //    rebinding attack would pair a public answer with a private one).
  //    Uses getaddrinfo (dns.lookup, all addresses) — the SAME resolution
  //    Chromium will perform, including OS hosts-file entries, so "localhost"
  //    is classified as loopback rather than misreported as DNS failure.
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dnsPromises.lookup(host, { all: true });
  } catch {
    // Unresolvable host: fall back to the textual classifier so hosts with
    // local-looking NAMES (lab.internal, .local, suspicious TLDs) still get
    // the strict treatment instead of a plain DNS error.
    const textual = checkHostnameTextual(host);
    if (!textual.ok) {
      return {
        verdict: "blocked-private-network",
        reason: textual.reason,
        host,
      };
    }
    return { verdict: "blocked-dns", reason: `DNS resolution failed for ${host}`, host };
  }
  if (!addresses || addresses.length === 0) {
    return { verdict: "blocked-dns", reason: `no addresses for ${host}`, host };
  }
  for (const { address } of addresses) {
    if (!options.allowPrivateNetworks) {
      const cls = classifyIPv4(address) ?? classifyIPv6(address);
      if (cls && cls !== "global") {
        return {
          verdict: "blocked-private-network",
          reason: `${host} resolves to a non-global address (${address})`,
          host,
        };
      }
    } else {
      // Private networks allowed — still reject true metadata.
      const cls = classifyIPv4(address) ?? classifyIPv6(address);
      if (cls === "metadata" || cls === "reserved" || cls === "unspecified") {
        return {
          verdict: "blocked-private-network",
          reason: `${host} resolves to a forbidden address (${address})`,
          host,
        };
      }
    }
  }

  return { verdict: "allowed", reason: "ok", host };
}

/**
 * Validate a redirect hop. Same rules as validateTargetUrl plus a hop budget
 * enforced by the caller across the redirect chain.
 */
export async function validateRedirectTarget(
  url: string,
  hopsSoFar: number,
  maxRedirects: number,
  options: UrlPolicyOptions = {},
): Promise<UrlPolicyDecision> {
  if (hopsSoFar >= maxRedirects) {
    return {
      verdict: "blocked-invalid",
      reason: `redirect limit (${maxRedirects}) exceeded`,
    };
  }
  return validateTargetUrl(url, options);
}

/** Audit-safe target description: scheme + host only, never path/query. */
export function safeTargetOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}`;
  } catch {
    return "(invalid url)";
  }
}

/** Hostname only (no scheme, no path) — for domain-keyed session policies. */
export function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Re-exported for the route interceptor's literal fast-path and tool validation. */
export { checkHostnameTextual, isForbiddenIPLiteral };
