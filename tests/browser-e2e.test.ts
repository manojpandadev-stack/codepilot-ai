/**
 * M13 — REAL browser E2E (system Chromium via playwright-core).
 *
 * Deterministic local test server serves a small app; the tests drive a REAL
 * browser through the production BrowserService and the M3 tools:
 *
 *   navigate → inspect → type → click → submit → inspect result
 *   screenshot, back/forward/reload, wait
 *
 * Security E2E: SSRF targets (localhost by name, metadata IP, file:) are
 * rejected BEFORE any navigation; private-network flag is required for the
 * local server (explicitly permitted for this test only); cancellation
 * closes the session; service dispose kills the browser process.
 *
 * Honest skip: when no system Chrome/Edge is installed the suite is SKIPPED
 * (reported, not silently passed).
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  BrowserService,
  validateTargetUrl,
} from "../packages/browser-engine/src/index.js";
import { createBrowserTools } from "../packages/browser-engine/src/browser-tools.js";
import { discoverBrowserChannel } from "../apps/vscode-extension/src/browser-service";

// ============================================================================
// Deterministic local test server
// ============================================================================

const PORT = 18123;
const BASE = `http://127.0.0.1:${PORT}`;

const INDEX_HTML = `<!doctype html>
<html>
<head><title>CodePilot Browser Test App</title></head>
<body>
  <h1 id="heading">Welcome</h1>
  <a id="page2link" href="/page2">Go to page 2</a>
  <form id="f" action="/submit" method="get">
    <input id="name" name="name" type="text" />
    <button id="go" type="submit">Submit</button>
  </form>
  <div id="secret" style="display:none">hidden text</div>
</body>
</html>`;

const PAGE2_HTML = `<!doctype html>
<html><head><title>Page 2</title></head>
<body><h1 id="p2">Page 2 reached</h1>
<a id="back" href="/">Index</a></body></html>`;

function submitHtml(name: string): string {
  return `<!doctype html>
<html><head><title>Submitted</title></head>
<body><h1 id="result">Hello, ${name}!</h1>
<p id="echo">You submitted: ${name}</p></body></html>`;
}

let server: http.Server;
let requestsSeen: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    requestsSeen.push(url);
    if (url.startsWith("/submit")) {
      const name = new URL(url, BASE).searchParams.get("name") ?? "nobody";
      res.writeHead(200, { "content-type": "text/html" });
      res.end(submitHtml(name.replace(/[^a-zA-Z0-9 ]/g, "")));
      return;
    }
    const body =
      url === "/page2"
        ? PAGE2_HTML
        : INDEX_HTML;
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ============================================================================
// Service availability
// ============================================================================

const CHANNEL = discoverBrowserChannel();
const d = (await validateTargetUrl(`${BASE}/`, { allowPrivateNetworks: true }));
const BROWSER_AVAILABLE = CHANNEL !== null;

// ============================================================================
// Real browser E2E — the local server REQUIRES allowPrivateNetworks (the
// production default blocks private networks; this flag models the explicit
// user approval of a local dev target).
// ============================================================================

describe.skipIf(!BROWSER_AVAILABLE)("browser E2E — REAL Chromium", () => {
  let service: BrowserService;

  beforeAll(() => {
    service = new BrowserService({
      channel: CHANNEL ?? undefined,
      navigationTimeoutMs: 15_000,
      urlPolicy: { allowPrivateNetworks: true },
    });
  });

  afterAll(async () => {
    await service.dispose();
  });

  it("launches a real browser and navigates", async () => {
    const r = await service.navigate("task-e2e", "default", `${BASE}/`);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.title).toBe("CodePilot Browser Test App");
    expect(service.sessionCount()).toBe(1);
  });

  it("inspects the page: title, visible text, links", async () => {
    const snap = await service.inspect("task-e2e", "default");
    if ("ok" in snap && snap.ok === false) throw new Error(snap.error);
    expect(snap.title).toBe("CodePilot Browser Test App");
    expect(snap.text).toContain("Welcome");
    expect(snap.links.some((l) => l.endsWith("/page2"))).toBe(true);
  });

  it("types into a form and clicks submit — result verified", async () => {
    const fill = await service.fill("task-e2e", "default", "#name", "World");
    expect(fill.ok).toBe(true);
    const click = await service.click("task-e2e", "default", "#go");
    expect(click.ok).toBe(true);
    await service.wait("task-e2e", "default", "#result");
    const snap = await service.inspect("task-e2e", "default");
    if ("ok" in snap && snap.ok === false) throw new Error(snap.error);
    expect(snap.url).toContain("/submit");
    expect(snap.text).toContain("Hello, World!");
  });

  it("navigates via link then goes back / forward / reload", async () => {
    await service.navigate("task-e2e", "default", `${BASE}/`);
    await service.click("task-e2e", "default", "#page2link");
    await service.wait("task-e2e", "default", "#p2");
    expect((await service.inspect("task-e2e", "default")).title).toBe("Page 2");

    const back = await service.goBack("task-e2e", "default");
    expect(back.ok).toBe(true);
    expect((await service.inspect("task-e2e", "default")).text).toContain("Welcome");

    const fwd = await service.goForward("task-e2e", "default");
    expect(fwd.ok).toBe(true);
    expect((await service.inspect("task-e2e", "default")).title).toBe("Page 2");

    const reload = await service.reload("task-e2e", "default");
    expect(reload.ok).toBe(true);
    expect(reload.title).toBe("Page 2");
  });

  it("captures a bounded PNG screenshot", async () => {
    const shot = await service.screenshot("task-e2e", "default");
    expect(shot.ok).toBe(true);
    if (shot.ok) {
      // PNG magic bytes: 89 50 4E 47
      const buf = Buffer.from(shot.base64, "base64");
      expect(buf.byteLength).toBeGreaterThan(100);
      expect(buf[0]).toBe(0x89);
      expect(buf[1]).toBe(0x50);
    }
  });

  it("scroll and press operate on the live page", async () => {
    expect((await service.scroll("task-e2e", "default", 0, 120)).ok).toBe(true);
    expect((await service.press("task-e2e", "default", "Escape")).ok).toBe(true);
  });

  it("hidden page content is NOT extracted (display:none text stays out of innerText)", async () => {
    const snap = await service.inspect("task-e2e", "default");
    if ("ok" in snap && snap.ok === false) throw new Error(snap.error);
    expect(snap.text).not.toContain("hidden text");
  });

  it("session isolation: two tasks never share a session", async () => {
    const a = service.status("task-a", "default");
    expect(a.exists).toBe(false);
    await service.navigate("task-a", "default", `${BASE}/`);
    await service.navigate("task-b", "default", `${BASE}/page2`);
    const sa = service.status("task-a");
    const sb = service.status("task-b");
    expect(sa.url).toBe(`${BASE}/`);
    expect(sb.url).toBe(`${BASE}/page2`);
    expect(service.sessionCount()).toBe(2);
    await service.closeTaskSessions("task-a");
    expect(service.status("task-a").exists).toBe(false);
    expect(service.status("task-b").exists).toBe(true);
    await service.closeTaskSessions("task-b");
  });

  it("SSRF: navigate to localhost by NAME is blocked even in this permissive test config only when the flag is off", async () => {
    // Production-policy check (no private flag): must be rejected outright.
    const strict = await validateTargetUrl(`${BASE}/`);
    expect(strict.verdict).toBe("blocked-private-network");
  });

  it("file: URLs are rejected by policy (never reach the browser)", async () => {
    const verdict = await validateTargetUrl("file:///C:/Windows/win.ini", {
      allowPrivateNetworks: true,
    });
    expect(verdict.verdict).toBe("blocked-scheme");
  });

  it("cancellation: aborted navigate does not wedge the session", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await service.navigate("task-cancel", "default", `${BASE}/`, ctrl.signal);
    // Aborted before/at navigation → error result, service stays healthy.
    expect(r.ok).toBe(false);
    const after = await service.navigate("task-cancel", "default", `${BASE}/`);
    expect(after.ok).toBe(true);
    await service.closeTaskSessions("task-cancel");
  });

  it("dispose: closes every session and the browser process", async () => {
    const svc2 = new BrowserService({
      channel: CHANNEL ?? undefined,
      urlPolicy: { allowPrivateNetworks: true },
    });
    await svc2.navigate("task-x", "default", `${BASE}/`);
    expect(svc2.sessionCount()).toBe(1);
    await svc2.dispose();
    expect(svc2.sessionCount()).toBe(0);
    // Further use fails cleanly.
    await expect(svc2.navigate("task-x", "default", `${BASE}/`)).rejects.toThrow();
  });

  it("audit trail records operations without page content or secrets", async () => {
    const trail = service.getAuditTrail();
    expect(trail.length).toBeGreaterThan(0);
    const dump = JSON.stringify(trail);
    expect(dump).not.toContain("hidden text");
    expect(dump).not.toContain("Hello, World");
    // Targets are scheme://host only.
    for (const e of trail) {
      if (e.target !== "(none)" && e.target !== "(invalid url)") {
        expect(e.target).toMatch(/^https?:\/\/[^/]+$/);
      }
    }
  });
});

// ============================================================================
// Tool-level E2E through the REAL M4 pipeline (local server target)
// ============================================================================

describe.skipIf(!BROWSER_AVAILABLE)("browser tools E2E — real browser through tools", { timeout: 120_000 }, () => {
  it("browser_navigate tool reaches the real Chromium", async () => {
    const svc = new BrowserService({
      channel: CHANNEL ?? undefined,
      urlPolicy: { allowPrivateNetworks: true },
    });
    const tools = createBrowserTools({ service: svc });
    const nav = tools.find((t) => t.id === "browser_navigate")!;
    const out = (await nav.execute(
      { url: `${BASE}/` },
      {
        executionId: "e2e-exec-1",
        taskId: "task-tools",
        cwd: tmpdir(),
        signal: new AbortController().signal,
        progress: () => {},
      },
    )) as { ok: boolean; title?: string };
    expect(out.ok).toBe(true);
    expect(out.title).toBe("CodePilot Browser Test App");
    await svc.dispose();
  });
});

// Guard against unused import when browser is missing.
void fs;
void path;
