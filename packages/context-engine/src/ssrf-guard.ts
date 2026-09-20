/**
 * M13 — SSRF guard: strict URL/IP validation with DNS + redirect protection.
 * Part 1: IP parsing / classification (no string-prefix checks).
 *
 * DNS-rebinding design (documented limitation):
 * - Every hop resolves the hostname via `resolveAll` and rejects the request
 *   when ANY resolved address is forbidden (private, loopback, link-local,
 *   multicast, metadata, reserved, unspecified, documentation, CGNAT).
 * - The validated destination is then *pinned*: the actual HTTP connection
 *   uses a custom `lookup` that returns ONLY the validated IP, so a second
 *   DNS answer between validation and connect cannot rebind the socket.
 * - Platform limitation (honest): this pinning covers direct http/https
 *   requests made by this module. It cannot constrain a transparent proxy
 *   configured via HTTP_PROXY/HTTPS_PROXY (the proxy resolves the hostname
 *   itself), nor can it defend against a resolver that returns different
 *   answers to third parties. When `pinIp:false` is passed, no pinning is
 *   applied and rebinding protection is reduced to validate-only.
 */

import * as net from "node:net";

export type IPClass =
  | "global"
  | "private"
  | "loopback"
  | "link-local"
  | "multicast"
  | "reserved"
  | "unspecified"
  | "metadata"
  | "documentation"
  | "carrier-grade-nat";

/** Normalize IPv4 literal, accepting decimal/octal/hex per-part forms. */
export function normalizeIPv4(host: string): string | null {
  const h = host.trim();
  if (!/^[0-9a-fA-FxX.]+$/.test(h)) return null;
  const parts = h.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (p.length === 0) return null;
    let n: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums.join(".");
}

function ipv4ToInt(ip: string): number | null {
  const norm = normalizeIPv4(ip) ?? (net.isIPv4(ip) ? ip : null);
  if (!norm) return null;
  const p = norm.split(".").map((x) => parseInt(x, 10));
  const a = p[0] ?? 0;
  const b = p[1] ?? 0;
  const c = p[2] ?? 0;
  const d = p[3] ?? 0;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

export function classifyIPv4(ip: string): IPClass | null {
  const v = ipv4ToInt(ip);
  if (v === null) return null;
  // NOTE: bitwise `&` yields a SIGNED int32, so every masked comparison must
  // be coerced with `>>> 0` before comparing against (unsigned) literals —
  // otherwise any range >= 0x80000000 (192.168/16, 172.16/12, 169.254/16,
  // multicast, reserved, documentation) misclassifies as global. That was a
  // live SSRF bypass; the `m` helper below closes it.
  const m = (mask: number): number => (v & mask) >>> 0;
  if (v >>> 24 === 127) return "loopback";
  if (v === 0x00000000) return "unspecified";
  if (v === 0x00000001) return "reserved";
  // Cloud metadata endpoints are link-local (169.254/16) but classified as
  // metadata first so callers can distinguish the SSRF target explicitly.
  if (v === 0xa9fea9fe) return "metadata";
  if (v === 0xa9fea9fd) return "metadata";
  if (m(0xff000000) === 0x0a000000) return "private";
  if (m(0xfff00000) === 0xac100000) return "private";
  if (m(0xffff0000) === 0xc0a80000) return "private";
  if (m(0xffff0000) === 0xa9fe0000) return "link-local";
  if (m(0xffffff00) === 0xc0000200) return "documentation";
  if (m(0xffffff00) === 0xc6336400) return "documentation";
  if (m(0xffffff00) === 0xcb007100) return "documentation";
  if (m(0xffc00000) === 0x64400000) return "carrier-grade-nat";
  if (m(0xf0000000) === 0xe0000000) return "multicast";
  if (m(0xf0000000) === 0xf0000000) return "reserved";
  return "global";
}

/** Parse IPv6 (zone-id strip, embedded IPv4) into 8 groups. */
export function parseIPv6Groups(addr: string): number[] | null {
  let a = addr.trim();
  const pct = a.indexOf("%");
  if (pct !== -1) a = a.slice(0, pct);
  if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
  // Embedded IPv4 (dotted decimal/octal/hex, incl. deprecated ::<ipv4>
  // compatible form): rewrite textually to two hex groups FIRST, then run
  // the standard pure-hex parser. Slicing at the last ":" loses the "::"
  // compression marker (e.g. "::127.0.0.1" left a lone ":"), so substitution
  // before parsing is the only correct approach.
  const tailMatch =
    /(\d+\.\d+\.\d+\.\d+)$/.exec(a) ??
    /([0-9a-fA-FxX.]+\.[0-9a-fA-FxX.]+)$/.exec(a);
  if (tailMatch?.[1]) {
    const nv =
      normalizeIPv4(tailMatch[1]) ??
      (net.isIPv4(tailMatch[1]) ? tailMatch[1] : null);
    if (nv) {
      const oct = nv.split(".").map((x) => parseInt(x, 10));
      const o0 = oct[0] ?? 0;
      const o1 = oct[1] ?? 0;
      const o2 = oct[2] ?? 0;
      const o3 = oct[3] ?? 0;
      a = `${a.slice(0, a.length - tailMatch[1].length)}${((o0 << 8) | o1).toString(16)}:${((o2 << 8) | o3).toString(16)}`;
    }
  }
  const parts: string[] = [];
  if (a.includes("::")) {
    const i = a.indexOf("::");
    if (a.indexOf("::", i + 2) !== -1) return null;
    const b = a.slice(0, i) ? a.slice(0, i).split(":") : [];
    const af = a.slice(i + 2) ? a.slice(i + 2).split(":") : [];
    if (b.length + af.length > 8) return null;
    parts.push(...b, ...Array(8 - b.length - af.length).fill("0"), ...af);
  } else if (a.length === 0) {
    return null;
  } else {
    parts.push(...a.split(":"));
  }
  if (parts.length !== 8) return null;
  const g: number[] = [];
  for (const p of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
    g.push(parseInt(p, 16));
  }
  return g.length === 8 ? g : null;
}

export function classifyIPv6(addr: string): IPClass | null {
  const g = parseIPv6Groups(addr);
  if (!g) return null;
  const a = g[0] ?? 0;
  const b = g[1] ?? 0;
  const c = g[2] ?? 0;
  const d = g[3] ?? 0;
  const e = g[4] ?? 0;
  const f = g[5] ?? 0;
  const h6 = g[6] ?? 0;
  const h7 = g[7] ?? 0;
  if (g.every((x) => x === 0)) return "unspecified";
  if (
    a === 0 &&
    b === 0 &&
    c === 0 &&
    d === 0 &&
    e === 0 &&
    f === 0 &&
    h6 === 0 &&
    h7 === 1
  )
    return "loopback";
  if ((a & 0xff00) === 0xff00) return "multicast";
  if ((a & 0xfe00) === 0xfc00) return "private";
  if ((a & 0xffc0) === 0xfe80) return "link-local";
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return (
      classifyIPv4(
        `${(h6 >> 8) & 0xff}.${h6 & 0xff}.${(h7 >> 8) & 0xff}.${h7 & 0xff}`,
      ) ?? "reserved"
    );
  }
  if (a === 0x0064 && b === 0xff9b) return "reserved";
  if (
    a === 0 &&
    b === 0 &&
    c === 0 &&
    d === 0 &&
    e === 0 &&
    f === 0 &&
    (h6 !== 0 || h7 > 1)
  ) {
    return (
      classifyIPv4(
        `${(h6 >> 8) & 0xff}.${h6 & 0xff}.${(h7 >> 8) & 0xff}.${h7 & 0xff}`,
      ) ?? "reserved"
    );
  }
  if (a === 0x2001 && b === 0x0db8) return "documentation";
  return "global";
}
/** Strip brackets / zone-id for uniform IP-literal handling. */
export function stripIpDecorations(host: string): string {
  let h = host.trim();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  const pct = h.indexOf("%");
  if (pct !== -1) h = h.slice(0, pct);
  return h;
}

/** Normalize any IP literal to its canonical dial address (brackets/zone stripped, obfuscated IPv4 dotted). */
export function normalizeDialAddress(host: string): string {
  const h = stripIpDecorations(host);
  const v4 = normalizeIPv4(h) ?? (net.isIPv4(h) ? h : null);
  if (v4) return v4;
  return h;
}
export function isForbiddenIPLiteral(host: string): {
  forbidden: boolean;
  reason: string;
} {
  const h = stripIpDecorations(host);
  const v4 = normalizeIPv4(h) ?? (net.isIPv4(h) ? h : null);
  if (v4) {
    if (v4 === "169.254.169.254" || v4 === "169.254.169.253")
      return { forbidden: true, reason: "cloud metadata endpoint blocked" };
    const cls = classifyIPv4(v4);
    if (cls !== "global")
      return { forbidden: true, reason: `IPv4 ${v4} is ${cls}` };
    return { forbidden: false, reason: "ok" };
  }
  if (host.includes(":") || h.includes(":")) {
    const cls = classifyIPv6(h);
    if (cls === null)
      return { forbidden: true, reason: "malformed IPv6 blocked" };
    if (cls !== "global") return { forbidden: true, reason: `IPv6 is ${cls}` };
    return { forbidden: false, reason: "ok" };
  }
  return { forbidden: false, reason: "not an IP literal" };
}

export function checkHostnameTextual(host: string): {
  ok: boolean;
  reason: string;
} {
  const h = host.toLowerCase().trim();
  if (h.length === 0) return { ok: false, reason: "empty hostname" };
  if (!h.includes(".") && !h.includes(":")) {
    return { ok: false, reason: "single-label hostnames are blocked" };
  }
  if (h === "localhost") return { ok: false, reason: "localhost blocked" };
  if (h.endsWith(".localhost"))
    return { ok: false, reason: "localhost subdomain blocked" };
  if (
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".invalid") ||
    h.endsWith(".test")
  )
    return { ok: false, reason: "special-use TLD blocked" };
  const lit = isForbiddenIPLiteral(h);
  if (lit.forbidden) return { ok: false, reason: lit.reason };
  const digits = h.replace(/\./g, "");
  if (/^(0[xX][0-9a-fA-F]+|0[0-7]+|[0-9]+)$/.test(digits)) {
    let n: number | null = null;
    if (/^0[xX][0-9a-fA-F]+$/.test(digits)) n = parseInt(digits, 16);
    else if (/^0[0-7]+$/.test(digits)) n = parseInt(digits, 8);
    else n = parseInt(digits, 10);
    if (n !== null && Number.isInteger(n) && n >= 0 && n <= 0xffffffff) {
      const dotted = `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
      const cls = classifyIPv4(dotted);
      if (cls && cls !== "global")
        return { ok: false, reason: `numeric IP ${dotted} is ${cls}` };
    }
  }
  return { ok: true, reason: "ok" };
}

export async function validateResolvedAddresses(
  hostname: string,
  resolveAll: (
    h: string,
  ) => Promise<Array<{ address: string; family: number }>>,
): Promise<{ ok: boolean; reason: string; addresses: string[] }> {
  const t = checkHostnameTextual(hostname);
  if (!t.ok) return { ok: false, reason: t.reason, addresses: [] };
  // IP literals (incl. bracketed/zone-id/obfuscated forms): classify strictly
  // with proper parsing — never string-prefix checks, never pass-through.
  const bare = stripIpDecorations(hostname);
  const v4lit = normalizeIPv4(bare) ?? (net.isIPv4(bare) ? bare : null);
  if (v4lit) {
    const lit = isForbiddenIPLiteral(v4lit);
    if (lit.forbidden) return { ok: false, reason: lit.reason, addresses: [] };
    return { ok: true, reason: "ok", addresses: [v4lit] };
  }
  if (net.isIPv6(bare)) {
    const lit = isForbiddenIPLiteral(bare);
    if (lit.forbidden) return { ok: false, reason: lit.reason, addresses: [] };
    return { ok: true, reason: "ok", addresses: [bare] };
  }
  if (hostname.includes(":") || bare.includes(":")) {
    // Looks like IPv6 (maybe malformed): fail closed.
    const lit = isForbiddenIPLiteral(hostname);
    if (lit.forbidden) return { ok: false, reason: lit.reason, addresses: [] };
    return { ok: false, reason: "malformed IP literal blocked", addresses: [] };
  }
  let recs: Array<{ address: string; family: number }>;
  try {
    recs = await resolveAll(hostname);
  } catch {
    return { ok: false, reason: "DNS resolution failed", addresses: [] };
  }
  if (recs.length === 0)
    return { ok: false, reason: "no DNS records", addresses: [] };
  const addrs = recs.map((r) => r.address);
  for (const a of addrs) {
    const lit = isForbiddenIPLiteral(a);
    if (lit.forbidden)
      return {
        ok: false,
        reason: `resolves to forbidden (${lit.reason})`,
        addresses: addrs,
      };
  }
  return { ok: true, reason: "ok", addresses: addrs };
}

export interface GuardFetchOptions {
  timeoutMs?: number;
  maxChars?: number;
  maxRedirects?: number;
  resolveAll?: (
    h: string,
  ) => Promise<Array<{ address: string; family: number }>>;
  /** Test seam: inject raw HTTP exchange without touching the network. */
  request?: (
    target: URL,
    ip: string | undefined,
    host: string,
    timeoutMs: number,
  ) => Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }>;
  allowedDomains?: string[];
  deniedDomains?: string[];
  pinIp?: boolean;
}

export interface GuardFetchResult {
  ok: boolean;
  finalUrl: string;
  status?: number;
  contentType?: string;
  text?: string;
  rawHtml?: string;
  error?: string;
  hops: number;
  usedIp?: string;
}

function domainPolicy(
  host: string,
  o: GuardFetchOptions,
): { ok: boolean; reason: string } {
  const h = host.toLowerCase();
  for (const d of o.deniedDomains ?? []) {
    if (h === d.toLowerCase() || h.endsWith(`.${d.toLowerCase()}`))
      return { ok: false, reason: `domain ${d} denied` };
  }
  const al = o.allowedDomains ?? [];
  if (al.length > 0) {
    const ok = al.some(
      (a) => h === a.toLowerCase() || h.endsWith(`.${a.toLowerCase()}`),
    );
    if (!ok) return { ok: false, reason: `domain ${h} not allow-listed` };
  }
  return { ok: true, reason: "ok" };
}

async function dnsResolveAll(
  h: string,
): Promise<Array<{ address: string; family: number }>> {
  const { lookup } = await import("node:dns/promises");
  return lookup(h, { all: true });
}

function rawRequest(
  target: URL,
  pinIp: string | undefined,
  sniHost: string,
  timeoutMs: number,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const start = (mod: {
      request: (
        u: URL,
        o: Record<string, unknown>,
        cb: (res: {
          statusCode?: number;
          headers: Record<string, string | string[] | undefined>;
          on: (e: string, f: (...a: never[]) => void) => void;
        }) => void,
      ) => {
        on: (e: string, f: (x: unknown) => void) => void;
        setTimeout: (n: number, f: () => void) => void;
        end: () => void;
        destroy: (e?: Error) => void;
      };
    }): void => {
      const headers: Record<string, string> = {};
      const lookup =
        pinIp !== undefined
          ? (
              _h: string,
              _o: unknown,
              cb: (e: unknown, a: string, f: number) => void,
            ): void => {
              const dial = normalizeDialAddress(pinIp);
              cb(null, dial, net.isIP(dial));
            }
          : undefined;
      const req = mod.request(
        target,
        {
          method: "GET",
          headers: { "User-Agent": "CodePilot-AI/0.1.0", Host: sniHost },
          lookup,
        },
        (res) => {
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") headers[k.toLowerCase()] = v;
            else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(", ");
          }
          const chunks: Buffer[] = [];
          const cap = 1_048_576;
          let bytes = 0;
          res.on("data", (c: unknown) => {
            const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
            bytes += b.length;
            if (bytes <= cap) chunks.push(b);
          });
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          res.on("error", reject as (...a: never[]) => void);
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      req.end();
    };
    if (target.protocol === "https:") {
      void import("node:https").then((m) => start(m.default as never));
    } else {
      void import("node:http").then((m) => start(m.default as never));
    }
  });
}

export async function ssrfSafeFetch(
  url: string,
  opts: GuardFetchOptions = {},
): Promise<GuardFetchResult> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const maxRedirects = opts.maxRedirects ?? 5;
  const resolveAll = opts.resolveAll ?? dnsResolveAll;
  const doPin = opts.pinIp !== false;
  let current = url;
  let hops = 0;
  for (;;) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return { ok: false, finalUrl: current, error: "invalid URL", hops };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        ok: false,
        finalUrl: current,
        error: `protocol ${parsed.protocol} blocked`,
        hops,
      };
    }
    const textual = checkHostnameTextual(parsed.hostname);
    if (!textual.ok)
      return { ok: false, finalUrl: current, error: textual.reason, hops };
    const dom = domainPolicy(parsed.hostname, opts);
    if (!dom.ok)
      return { ok: false, finalUrl: current, error: dom.reason, hops };
    const dnsCheck = await validateResolvedAddresses(
      parsed.hostname,
      resolveAll,
    );
    if (!dnsCheck.ok)
      return { ok: false, finalUrl: current, error: dnsCheck.reason, hops };
    // Pin the validated destination: normalize (strip brackets/zone, expand
    // obfuscated IPv4) so the custom lookup below dials EXACTLY the address
    // that was validated — no re-resolution, no rebinding window.
    const rawPin = doPin ? dnsCheck.addresses[0] : undefined;
    const pinIp =
      rawPin !== undefined ? normalizeDialAddress(rawPin) : undefined;
    const doRequest = opts.request ?? rawRequest;
    try {
      const out = await doRequest(
        parsed,
        pinIp,
        stripIpDecorations(parsed.hostname),
        timeoutMs,
      );
      if (out.status >= 300 && out.status < 400) {
        const loc = out.headers["location"] ?? "";
        if (!loc)
          return {
            ok: false,
            finalUrl: current,
            error: `redirect without location (HTTP ${out.status})`,
            hops,
            usedIp: pinIp,
          };
        hops += 1;
        if (hops > maxRedirects)
          return {
            ok: false,
            finalUrl: current,
            error: "too many redirects",
            hops,
            usedIp: pinIp,
          };
        try {
          current = new URL(loc, current).toString();
        } catch {
          return {
            ok: false,
            finalUrl: current,
            error: "invalid redirect target",
            hops,
            usedIp: pinIp,
          };
        }
        continue;
      }
      if (out.status < 200 || out.status >= 300) {
        return {
          ok: false,
          finalUrl: current,
          error: `HTTP ${out.status}`,
          hops,
          usedIp: pinIp,
        };
      }
      const ct = out.headers["content-type"] ?? "";
      const mc = opts.maxChars ?? 30000;
      const text = out.body.length > mc ? out.body.slice(0, mc) : out.body;
      return {
        ok: true,
        finalUrl: current,
        status: out.status,
        contentType: ct,
        text,
        rawHtml: ct.includes("text/html") ? out.body : undefined,
        hops,
        usedIp: pinIp,
      };
    } catch (err) {
      return {
        ok: false,
        finalUrl: current,
        error: err instanceof Error ? err.message : String(err),
        hops,
        usedIp: pinIp,
      };
    }
  }
}
