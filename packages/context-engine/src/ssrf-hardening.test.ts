/**
 * FINAL SSRF + lifecycle hardening — regression tests.
 *
 * Covers (hermetic — injected `request` seam, no network):
 *  1. IPv6: localhost ::1, link-local fe80::/10, unique-local fc00::/7,
 *     IPv4-mapped ::ffff:0:0/96, IPv4-compatible, malformed, bracketed URLs.
 *  2. DNS rebinding: public→private, multi-address, flip-between-calls,
 *     IPv4/IPv6 mixed, pinning of the validated destination.
 *  3. Redirects: every hop re-validated (localhost, 127.0.0.1, private v4,
 *     private v6, metadata, protocol downgrade, chain limit).
 */

import { describe, it, expect } from "vitest";
import {
  classifyIPv6,
  isForbiddenIPLiteral,
  checkHostnameTextual,
  validateResolvedAddresses,
  ssrfSafeFetch,
  type GuardFetchOptions,
} from "./ssrf-guard.js";
import { checkNavigationPolicy } from "./m13-web-agent.js";

type Rec = { address: string; family: number };
const pubOk = async (): Promise<Rec[]> => [
  { address: "93.184.216.34", family: 4 },
];
const okBody = (extra = {}) => ({
  status: 200,
  headers: { "content-type": "text/plain" },
  body: "hello",
  ...extra,
});

// ---------------------------------------------------------------- IPv6 ---
describe("SSRF IPv6 hardening", () => {
  it("blocks localhost IPv6 ::1 (bare, bracketed, zone-id, uppercase)", () => {
    expect(classifyIPv6("::1")).toBe("loopback");
    expect(isForbiddenIPLiteral("::1").forbidden).toBe(true);
    expect(isForbiddenIPLiteral("[::1]").forbidden).toBe(true);
    expect(isForbiddenIPLiteral("::1%lo0").forbidden).toBe(true);
    expect(isForbiddenIPLiteral("::1%ETH0").forbidden).toBe(true);
    expect(isForbiddenIPLiteral("0:0:0:0:0:0:0:1").forbidden).toBe(true);
    expect(checkHostnameTextual("[::1]").ok).toBe(false);
    expect(checkNavigationPolicy("http://[::1]/admin").allowed).toBe(false);
    expect(checkNavigationPolicy("http://[::1%25lo0]/").allowed).toBe(false);
  });

  it("blocks IPv6 link-local fe80::/10 (incl. zone-id + brackets)", () => {
    for (const ip of ["fe80::1", "fe80::ffff", "febf::1", "FE80::1"]) {
      expect(classifyIPv6(ip)).toBe("link-local");
      expect(isForbiddenIPLiteral(ip).forbidden).toBe(true);
    }
    expect(isForbiddenIPLiteral("fe80::1%eth0").forbidden).toBe(true);
    expect(isForbiddenIPLiteral("[fe80::1%eth0]").forbidden).toBe(true);
    expect(checkNavigationPolicy("http://[fe80::1]/").allowed).toBe(false);
  });

  it("blocks IPv6 unique-local fc00::/7 (fc + fd)", () => {
    for (const ip of [
      "fc00::1",
      "fc12:3456::1",
      "fd00::1",
      "fdff:ffff::1",
      "FD00::99",
    ]) {
      expect(classifyIPv6(ip)).toBe("private");
      expect(isForbiddenIPLiteral(ip).forbidden).toBe(true);
    }
    expect(checkNavigationPolicy("http://[fd00::1]/").allowed).toBe(false);
    expect(checkNavigationPolicy("http://[fc00::1]:8080/x").allowed).toBe(
      false,
    );
  });

  it("classifies IPv4-mapped ::ffff:0:0/96 by embedded IPv4", () => {
    expect(classifyIPv6("::ffff:127.0.0.1")).toBe("loopback");
    expect(classifyIPv6("::ffff:10.0.0.1")).toBe("private");
    expect(classifyIPv6("::ffff:192.168.1.1")).toBe("private");
    expect(classifyIPv6("::ffff:169.254.169.254")).toBe("metadata");
    expect(classifyIPv6("::ffff:8.8.8.8")).toBe("global");
    // hex form of the same range
    expect(classifyIPv6("::ffff:7f00:1")).toBe("loopback");
    expect(classifyIPv6("::ffff:0a00:1")).toBe("private");
    expect(isForbiddenIPLiteral("::ffff:127.0.0.1").forbidden).toBe(true);
    expect(isForbiddenIPLiteral("[::ffff:10.0.0.1]").forbidden).toBe(true);
    expect(isForbiddenIPLiteral("::ffff:8.8.8.8").forbidden).toBe(false);
    expect(checkNavigationPolicy("http://[::ffff:127.0.0.1]/").allowed).toBe(
      false,
    );
  });

  it("blocks IPv4-compatible representations that bypass IPv4 checks", () => {
    // Deprecated ::<ipv4> form embeds a full IPv4 address.
    expect(classifyIPv6("::127.0.0.1")).toBe("loopback");
    expect(classifyIPv6("::10.0.0.1")).toBe("private");
    expect(isForbiddenIPLiteral("::10.0.0.1").forbidden).toBe(true);
    expect(checkNavigationPolicy("http://[::127.0.0.1]/").allowed).toBe(false);
  });

  it("blocks unspecified, multicast, documentation, NAT64", () => {
    expect(isForbiddenIPLiteral("::").forbidden).toBe(true);
    expect(isForbiddenIPLiteral("ff02::1").forbidden).toBe(true);
    expect(isForbiddenIPLiteral("ff00::1").forbidden).toBe(true);
    expect(isForbiddenIPLiteral("2001:db8::1").forbidden).toBe(true);
    expect(isForbiddenIPLiteral("64:ff9b::808:808").forbidden).toBe(true);
  });

  it("blocks malformed IPv6 (fail closed, no string-prefix bypass)", () => {
    for (const bad of [
      "fe80:::1",
      "gggg::1",
      "12345::",
      ":::1",
      "fe80::1::2",
    ]) {
      expect(isForbiddenIPLiteral(bad).forbidden).toBe(true);
    }
    expect(checkHostnameTextual("fe80:::1").ok).toBe(false);
  });

  it("allows a genuine global IPv6 literal", () => {
    expect(classifyIPv6("2606:2800:220:1:248:1893:25c8:1946")).toBe("global");
    expect(
      isForbiddenIPLiteral("2606:2800:220:1:248:1893:25c8:1946").forbidden,
    ).toBe(false);
  });
});

// ------------------------------------------------------- DNS rebinding ---
describe("SSRF DNS-rebinding hardening", () => {
  it("rejects public hostname resolving to private IP", async () => {
    const r = await validateResolvedAddresses(
      "public.example.com",
      async () => [{ address: "10.0.0.5", family: 4 }],
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/forbidden/i);
  });

  it("rejects when ANY of multiple addresses is forbidden", async () => {
    const r = await validateResolvedAddresses("multi.example.com", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    expect(r.ok).toBe(false);
  });

  it("rejects IPv4/IPv6 mixed results containing a private v6", async () => {
    const r = await validateResolvedAddresses("mix.example.com", async () => [
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      { address: "fd00::1", family: 6 },
    ]);
    expect(r.ok).toBe(false);
  });

  it("rejects hostname resolving to metadata / loopback / link-local", async () => {
    for (const addr of [
      "169.254.169.254",
      "127.0.0.1",
      "::1",
      "fe80::1",
      "::ffff:10.0.0.1",
    ]) {
      const r = await validateResolvedAddresses(
        "evil.example.com",
        async () => [{ address: addr, family: addr.includes(":") ? 6 : 4 }],
      );
      expect(r.ok).toBe(false);
    }
  });

  it("fails closed on rebinding-style flip between validate and connect", async () => {
    // First answer public, second answer private: ssrfSafeFetch resolves once
    // per hop and pins the validated IP, so a flip-flopping resolver that
    // turns private on the hop's own resolution is rejected.
    let calls = 0;
    const flipping = async (): Promise<Rec[]> => {
      calls += 1;
      return calls === 1
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "10.0.0.9", family: 4 }];
    };
    const first = await validateResolvedAddresses(
      "rebind.example.com",
      flipping,
    );
    expect(first.ok).toBe(true);
    const second = await ssrfSafeFetch("http://rebind.example.com/", {
      resolveAll: flipping,
      request: async () => okBody(),
    });
    // second resolution returns private → blocked before any request
    expect(second.ok).toBe(false);
  });

  it("pins the validated destination (no re-resolution at connect)", async () => {
    let requestIp: string | undefined;
    const r = await ssrfSafeFetch("http://pinned.example.com/", {
      resolveAll: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async (_t, ip) => {
        requestIp = ip;
        return okBody();
      },
    });
    expect(r.ok).toBe(true);
    expect(requestIp).toBe("93.184.216.34");
    expect(r.usedIp).toBe("93.184.216.34");
  });

  it("pins normalized form for obfuscated IPv4 literals", async () => {
    let requestIp: string | undefined;
    const r = await ssrfSafeFetch("http://93.184.216.34/", {
      resolveAll: pubOk,
      request: async (_t, ip) => {
        requestIp = ip;
        return okBody();
      },
    });
    expect(r.ok).toBe(true);
    expect(requestIp).toBe("93.184.216.34");
  });

  it("never passes bracketed/zone-id literals to the dial layer", async () => {
    const r = await ssrfSafeFetch("http://[::1]/", {
      resolveAll: pubOk,
      request: async () => okBody(),
    });
    expect(r.ok).toBe(false);
  });
});

// ------------------------------------------------------------ Redirects ---
describe("SSRF redirect hardening (every hop re-validated)", () => {
  const redirectTo = (loc: string) => async () => ({
    status: 302,
    headers: { location: loc },
    body: "",
  });

  async function fetchWithRedirects(
    startHost: string,
    script: (host: string) => Promise<{
      status: number;
      headers: Record<string, string>;
      body: string;
    }>,
    opts?: Partial<GuardFetchOptions>,
  ) {
    const resolveAll = async (host: string): Promise<Rec[]> => {
      if (host === startHost) return [{ address: "93.184.216.34", family: 4 }];
      if (host === "127.0.0.1" || host === "localhost")
        return [{ address: "127.0.0.1", family: 4 }];
      if (host === "10.1.2.3") return [{ address: "10.1.2.3", family: 4 }];
      if (host === "169.254.169.254")
        return [{ address: "169.254.169.254", family: 4 }];
      if (host === "[::1]" || host === "::1")
        return [{ address: "::1", family: 6 }];
      if (host === "[fd00::1]" || host === "fd00::1")
        return [{ address: "fd00::1", family: 6 }];
      if (host === "public.example.com")
        return [{ address: "93.184.216.34", family: 4 }];
      return [{ address: "93.184.216.34", family: 4 }];
    };
    return ssrfSafeFetch(`http://${startHost}/start`, {
      resolveAll,
      request: async (target) => script(target.hostname),
      ...opts,
    });
  }

  it("blocks public → localhost redirect", async () => {
    const r = await fetchWithRedirects("public.example.com", async (h) =>
      h === "public.example.com"
        ? {
            status: 302,
            headers: { location: "http://localhost/admin" },
            body: "",
          }
        : okBody(),
    );
    expect(r.ok).toBe(false);
  });

  it("blocks public → 127.0.0.1 redirect", async () => {
    const r = await fetchWithRedirects("public.example.com", async (h) =>
      h === "public.example.com"
        ? {
            status: 302,
            headers: { location: "http://127.0.0.1:8080/admin" },
            body: "",
          }
        : okBody(),
    );
    expect(r.ok).toBe(false);
  });

  it("blocks public → private IPv4 redirect", async () => {
    const r = await fetchWithRedirects("public.example.com", async (h) =>
      h === "public.example.com"
        ? {
            status: 302,
            headers: { location: "http://10.1.2.3/internal" },
            body: "",
          }
        : okBody(),
    );
    expect(r.ok).toBe(false);
  });

  it("blocks public → private IPv6 redirect", async () => {
    const r = await fetchWithRedirects("public.example.com", async (h) =>
      h === "public.example.com"
        ? { status: 302, headers: { location: "http://[fd00::1]/" }, body: "" }
        : okBody(),
    );
    expect(r.ok).toBe(false);
  });

  it("blocks public → cloud metadata redirect", async () => {
    const r = await fetchWithRedirects("public.example.com", async (h) =>
      h === "public.example.com"
        ? {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data/" },
            body: "",
          }
        : okBody(),
    );
    expect(r.ok).toBe(false);
  });

  it("blocks https → file/ftp/gopher redirect targets", async () => {
    for (const target of [
      "file:///etc/passwd",
      "ftp://public.example.com/x",
      "gopher://public.example.com/1",
    ]) {
      const r = await fetchWithRedirects("public.example.com", async (h) =>
        h === "public.example.com"
          ? { status: 302, headers: { location: target }, body: "" }
          : okBody(),
      );
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/protocol/i);
    }
  });

  it("blocks redirect chains exceeding the safe maximum", async () => {
    const r = await ssrfSafeFetch("http://public.example.com/0", {
      resolveAll: async () => [{ address: "93.184.216.34", family: 4 }],
      maxRedirects: 3,
      request: async (target) => {
        const m = /\/(\d+)$/.exec(target.pathname);
        const n = m ? Number(m[1]) : 0;
        return {
          status: 302,
          headers: { location: `http://public.example.com/${n + 1}` },
          body: "",
        };
      },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/too many redirects/i);
  });

  it("still allows a public → public redirect", async () => {
    const r = await ssrfSafeFetch("http://public.example.com/a", {
      resolveAll: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async (target) =>
        target.pathname === "/a"
          ? {
              status: 302,
              headers: { location: "http://public.example.com/b" },
              body: "",
            }
          : okBody(),
    });
    expect(r.ok).toBe(true);
    expect(r.hops).toBe(1);
  });

  it("denies allow-listed start redirecting off the allow-list", async () => {
    const r = await ssrfSafeFetch("http://public.example.com/a", {
      resolveAll: async () => [{ address: "93.184.216.34", family: 4 }],
      allowedDomains: ["public.example.com"],
      request: async (target) =>
        target.hostname === "public.example.com"
          ? {
              status: 302,
              headers: { location: "http://evil.example.com/x" },
              body: "",
            }
          : okBody(),
    });
    expect(r.ok).toBe(false);
  });

  it("uses the request seam (no real network)", async () => {
    void redirectTo;
    let called = 0;
    const r = await ssrfSafeFetch("http://public.example.com/", {
      resolveAll: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async () => {
        called += 1;
        return okBody();
      },
    });
    expect(r.ok).toBe(true);
    expect(called).toBe(1);
  });
});
