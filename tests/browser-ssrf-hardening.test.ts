/**
 * Browser SSRF hardening regression tests (Phase 5).
 *
 * Pure-policy tests against validateTargetUrl — the exact function
 * BrowserService consults before every navigation AND every in-page request
 * (route interceptor). No network access required: IP-literal and scheme
 * checks are offline; hostname probes use recorded redirect chains instead
 * of live DNS.
 *
 * Locked invariants (production defaults, options = {}):
 *  - loopback / private / link-local / CGNAT / doc-range literals: BLOCKED
 *  - metadata endpoints (169.254.169.254/.253): BLOCKED, even with the
 *    TEST-ONLY allowPrivateNetworks override
 *  - IPv4 obfuscation (decimal, hex, octal, mixed, short forms): BLOCKED
 *  - IPv4-mapped IPv6 and the URL-canonicalized IPv4-TRANSLATED form
 *    (::ffff:0:127.0.0.1 -> [::ffff:0:7f00:1]) embedding a private address:
 *    BLOCKED (regression for the 0:ffff/96 classifier gap fixed in
 *    ssrf-guard.ts)
 *  - redirect chains that land on a private IP: BLOCKED
 *  - non-http(s) schemes, embedded credentials, malformed hosts: BLOCKED
 *  - global hosts (example.com): ALLOWED
 */
import { describe, expect, it } from "vitest";
import { validateTargetUrl } from "../packages/browser-engine/src/url-policy.js";

async function verdict(url: string, options: Record<string, unknown> = {}) {
  return (await validateTargetUrl(url, options)).verdict;
}

const BLOCK = (v: string) => expect(v).toMatch(/^blocked-/);

describe("SSRF hardening — production defaults block private networks", () => {
  it("blocks the required loopback/private/metadata targets", async () => {
    const targets = [
      "http://127.0.0.1:8080/",
      "http://localhost:3000/app",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]:9000/",
      "http://10.0.0.5/x",
      "http://192.168.1.10/y",
    ];
    for (const t of targets) BLOCK(await verdict(t));
  });

  it("blocks the wider RFC-1918 / link-local / CGNAT space", async () => {
    const targets = [
      "http://172.16.0.9/",
      "http://172.31.255.1/",
      "http://169.254.10.10/",
      "http://100.64.0.1/",
      "http://0.0.0.0/",
    ];
    for (const t of targets) BLOCK(await verdict(t));
  });
});

describe("SSRF hardening — IPv4 obfuscation", () => {
  it("blocks decimal / hex / octal / mixed / short loopback spellings", async () => {
    const targets = [
      "http://2130706433/", // 127.0.0.1 decimal
      "http://0x7f000001/", // hex
      "http://0177.0.0.1/", // octal
      "http://127.1/", // short
      "http://0/", // zero net
      "http://0x7f.1/", // mixed radix -> 127.0.0.1
      "http://0177.0x0.0.1/", // mixed radix -> 127.0.0.1
    ];
    for (const t of targets) BLOCK(await verdict(t));
  });

  it("allows mixed-radix spellings that canonicalize to GLOBAL addresses", async () => {
    // 0170 (octal) = 120 -> 120.1.2.4 is global APNIC space; the policy must
    // not blanket-block obfuscated IPv4, only its private resolutions.
    expect(await verdict("http://0170.1.0x2.4/")).toBe("allowed");
  });
});

describe("SSRF hardening — IPv6", () => {
  it("blocks private/loopback/link-local IPv6", async () => {
    const targets = ["http://[fd00::1]/", "http://[fe80::1]/", "http://[::1]/"];
    for (const t of targets) BLOCK(await verdict(t));
  });

  it("blocks IPv4-mapped IPv6 embedding a loopback address", async () => {
    BLOCK(await verdict("http://[::ffff:127.0.0.1]/"));
  });

  it("blocks the URL-canonicalized IPv4-TRANSLATED form (::ffff:0:127.0.0.1)", async () => {
    // WHATWG URL canonicalizes ::ffff:0:127.0.0.1 to [::ffff:0:7f00:1]
    // (RFC 4291 IPv4-translated prefix). This is a regression test for the
    // classifier gap where that form was misclassified as global.
    BLOCK(await verdict("http://[::ffff:0:127.0.0.1]/"));
    BLOCK(await verdict("http://[::ffff:0:10.0.0.5]/"));
  });

  it("still allows genuinely global IPv4-translated addresses", async () => {
    expect(await verdict("http://[::ffff:0:8.8.8.8]/")).toBe("allowed");
  });
});

describe("SSRF hardening — redirect chains", () => {
  it("blocks a redirect hop that lands on a private IP", async () => {
    BLOCK(
      await verdict("http://redirector.example/tp", {
        recordedRedirectChain: ["http://10.9.8.7/hit"],
      }),
    );
  });
});

describe("SSRF hardening — schemes, credentials, malformed URLs", () => {
  it("blocks unsupported schemes", async () => {
    for (const t of ["ftp://example.com/", "gopher://example.com/", "file:///etc/passwd"])
      BLOCK(await verdict(t));
  });

  it("blocks embedded credentials and userinfo smuggling", async () => {
    BLOCK(await verdict("http://u:p@example.com/"));
    BLOCK(await verdict("http://169.254.169.254@evil.example/"));
  });

  it("blocks malformed URLs and hosts", async () => {
    BLOCK(await verdict("http://exa mples.com/"));
    BLOCK(await verdict("http:///"));
    BLOCK(await verdict("http://2001:db8::1/"));
  });
});

describe("SSRF hardening — global hosts remain reachable", () => {
  it("allows example.com over https and http", async () => {
    expect(await verdict("https://example.com/")).toBe("allowed");
    expect(await verdict("http://example.com/")).toBe("allowed");
  });
});

describe("SSRF hardening — TEST-ONLY override boundaries", () => {
  const OVERRIDE = { allowPrivateNetworks: true };

  it("permits loopback/private ONLY when the explicit test override is set", async () => {
    expect(
      (await validateTargetUrl("http://127.0.0.1:8080/", OVERRIDE)).verdict,
    ).toBe("allowed");
    expect((await validateTargetUrl("http://10.0.0.5/", OVERRIDE)).verdict).toBe(
      "allowed",
    );
    // Production default remains closed.
    BLOCK(await verdict("http://127.0.0.1:8080/", {}));
  });

  it("NEVER permits cloud metadata endpoints, even with the override", async () => {
    BLOCK(await verdict("http://169.254.169.254/latest/meta-data/", OVERRIDE));
    BLOCK(await verdict("http://169.254.169.253/", OVERRIDE));
  });
});
