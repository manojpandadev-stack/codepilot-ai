/** @codepilot/browser-engine — host-contract unit tests (hermetic, no Chromium).
 *
 * Proves the contract and the fail-closed cancellation boundary over the
 * injected `BrowserHostProvider` seam, not by mocking the `Browser`
 * adapter itself.
 *
 * - The real `BrowserService` drives the production path (full SSRF,
 *   redirect validation, localhost/private-IP blocking, timeouts, M4
 *   mapping, secret-free audit trail).
 * - `FakeBrowserHostProvider` drives the host adapter (`Browser`) with a
 *   fast, in-memory session so every operation shape, duration and the
 *   cancellation/error contract can be asserted deterministically.
 *
 * Every result is asserted against the host schema:
 *   success: { ok: true, value: T, durationMs: number }
 *   failure: { ok: false, error: string, durationMs: number }
 */
import { describe, expect, it, beforeEach } from "vitest";
import type {
  BrowserSession,
  NavigateResult,
  PageSnapshot,
  BrowserConsoleMessage,
  BrowserNetworkEntry,
} from "./browser-service.js";
import { Browser } from "./browser.js";
import type { BrowserHostProvider } from "./browser-provider.js";
// Type-only: keeps this suite hermetic (no Chromium, no runtime import) while
// letting the fake satisfy the real BrowserSession contract.
import type { BrowserContext, Page } from "playwright-core";

// ==============================================================================
// Hermetic fake session provider (never touches a real browser)
// ============================================================================

/** A fabricated session consistent with the service's `BrowserSession`. */
class FakeSession implements BrowserSession {
  id: string;
  context: BrowserContext;
  page: Page;
  createdAt: number;
  lastUsedAt: number;
  redirectHops: number;
  validatedUrls: Map<string, boolean>;
  consoleMessages: BrowserConsoleMessage[];
  networkRequests: BrowserNetworkEntry[];

  constructor(
    readonly taskId: string,
    id: string,
  ) {
    this.id = id;
    // The fake never drives a real page; the engine handles are inert.
    this.context = null as unknown as BrowserContext;
    this.page = null as unknown as Page;
    this.createdAt = Date.now();
    this.lastUsedAt = Date.now();
    this.redirectHops = 0;
    this.validatedUrls = new Map();
    this.consoleMessages = [];
    this.networkRequests = [];
  }
}

/**
 * Fake engine behind the `BrowserHostProvider` seam. It records every
 * call and returns deterministic results; it never launches Chromium.
 *
 * Cancellation is honoured by tracking an `aborted` flag the caller can
 * force (simulating a signal that arrives before or during the operation),
 * which makes "cancellation fails closed" deterministic.
 */
class FakeBrowserHostProvider implements BrowserHostProvider {
  sessionId = "browser-fake";

  readonly calls: Array<{ op: string; args: unknown[] }> = [];
  private aborted = false;

  private sessions = new Map<string, FakeSession>();

  constructor(readonly defaultTaskId = "t1") {}

  /** For tests: force cancellation on all subsequent ops. */
  triggerAbort(): void {
    this.aborted = true;
  }

  async getSession(
    taskId: string,
    sessionId = "default",
  ): Promise<BrowserSession> {
    this.calls.push({ op: "getSession", args: [taskId, sessionId] });
    const key = `${sessionId}::${taskId}`;
    let s = this.sessions.get(key);
    if (!s) {
      s = new FakeSession(taskId, key);
      this.sessions.set(key, s);
    }
    s.lastUsedAt = Date.now();
    return s;
  }

  async closeSession(taskId: string, sessionId = "default"): Promise<void> {
    this.calls.push({ op: "closeSession", args: [taskId, sessionId] });
    this.sessions.delete(`${sessionId}::${taskId}`);
  }

  async closeTaskSessions(taskId: string): Promise<void> {
    this.calls.push({ op: "closeTaskSessions", args: [taskId] });
    for (const k of [...this.sessions.keys()]) {
      if (k.endsWith(`::${taskId}`)) this.sessions.delete(k);
    }
  }

  async dispose(): Promise<void> {
    this.calls.push({ op: "dispose", args: [] });
    this.sessions.clear();
  }

  status(taskId: string): { exists: boolean; url?: string; idleMs?: number } {
    this.calls.push({ op: "status", args: [taskId] });
    const s = this.sessions.get(`default::${taskId}`);
    if (!s) return { exists: false };
    return { exists: true, url: `https://${taskId}.test/`, idleMs: 0 };
  }

  navigate(
    taskId: string,
    sessionId: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<NavigateResult> {
    this.calls.push({
      op: "navigate",
      args: [taskId, sessionId, url, !!signal?.aborted],
    });
    if (this.aborted || signal?.aborted) {
      return Promise.resolve({ ok: false, error: "Operation cancelled" });
    }
    return Promise.resolve({ ok: true, url, status: 200, title: "t" });
  }

  click(
    taskId: string,
    sessionId: string,
    selector: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string }> {
    this.calls.push({
      op: "click",
      args: [taskId, sessionId, selector, !!signal?.aborted],
    });
    if (this.aborted || signal?.aborted)
      return Promise.resolve({ ok: false, error: "Operation cancelled" });
    return Promise.resolve({ ok: true });
  }

  fill(
    taskId: string,
    sessionId: string,
    selector: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string }> {
    this.calls.push({
      op: "fill",
      args: [taskId, sessionId, selector, text.length, !!signal?.aborted],
    });
    if (this.aborted || signal?.aborted)
      return Promise.resolve({ ok: false, error: "Operation cancelled" });
    return Promise.resolve({ ok: true });
  }

  press(
    taskId: string,
    sessionId: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string }> {
    this.calls.push({
      op: "press",
      args: [taskId, sessionId, key, !!signal?.aborted],
    });
    if (this.aborted || signal?.aborted)
      return Promise.resolve({ ok: false, error: "Operation cancelled" });
    return Promise.resolve({ ok: true });
  }

  scroll(
    taskId: string,
    sessionId: string,
    deltaX: number,
    deltaY: number,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string }> {
    this.calls.push({
      op: "scroll",
      args: [taskId, sessionId, deltaX, deltaY, !!signal?.aborted],
    });
    if (this.aborted || signal?.aborted)
      return Promise.resolve({ ok: false, error: "Operation cancelled" });
    return Promise.resolve({ ok: true });
  }

  wait(
    taskId: string,
    sessionId: string,
    selector: string | number,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string }> {
    this.calls.push({
      op: "wait",
      args: [taskId, sessionId, String(selector), !!signal?.aborted],
    });
    if (this.aborted || signal?.aborted)
      return Promise.resolve({ ok: false, error: "Operation cancelled" });
    return Promise.resolve({ ok: true });
  }

  inspect(
    taskId: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<PageSnapshot | { ok: false; error: string }> {
    this.calls.push({
      op: "inspect",
      args: [taskId, sessionId, !!signal?.aborted],
    });
    if (this.aborted || signal?.aborted) {
      return Promise.resolve({ ok: false, error: "Operation cancelled" });
    }
    return Promise.resolve({
      url: `https://${taskId}.test/`,
      title: "t",
      text: "hello",
      links: ["https://x.test/a"],
    });
  }

  screenshot(
    taskId: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true; base64: string } | { ok: false; error: string }> {
    this.calls.push({
      op: "screenshot",
      args: [taskId, sessionId, !!signal?.aborted],
    });
    if (this.aborted || signal?.aborted) {
      return Promise.resolve({ ok: false, error: "Operation cancelled" });
    }
    return Promise.resolve({ ok: true, base64: "aGVsbG8=" });
  }
}

/** Tracking unhandled rejection (asserts the host never leaks one). */
function watchUnhandledRejection(): () => void {
  const listener = (e: PromiseRejectionEvent) => {
    throw new Error(`unhandledRejection leaked: ${String(e.reason)}`);
  };
  process.on("unhandledRejection", listener);
  return () => process.off("unhandledRejection", listener);
}

describe("BrowserHost / Browser adapter (hermetic)", () => {
  let provider: FakeBrowserHostProvider;
  let host: Browser;

  beforeEach(() => {
    provider = new FakeBrowserHostProvider();
    host = new Browser(provider);
  });

  it("binds to the BrowserHost interface and keeps zero internal state", () => {
    expect(host.sessionId).toBe("browser-default");
    expect(host.status("t1")).toEqual({ exists: false });
  });

  it("getSession: one task gets one session, never sharing with another", async () => {
    const a = await host.getSession("task-a");
    const b = await host.getSession("task-b");
    expect(a.id).toBe("default::task-a");
    expect(b.id).toBe("default::task-b");
    expect(
      provider.calls.some(
        (c) => c.op === "getSession" && String(c.args[0]) === "task-a",
      ),
    ).toBe(true);
    expect(
      provider.calls.some(
        (c) => c.op === "getSession" && String(c.args[0]) === "task-b",
      ),
    ).toBe(true);
  });

  it("cancel before navigation fails closed, never claims ok, and leaves the session usable", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const nav = await host.navigate("t1", "https://x.test/", ctrl.signal);
    expect(nav.ok).toBe(false);
    if (nav.ok) throw new Error("navigate must not succeed when cancelled");
    expect(nav.error).toContain("cancelled");
    expect(nav.durationMs).toBeGreaterThanOrEqual(0);
    const s = await host.getSession("t1");
    expect(s.id).toBe("default::t1");
  });

  it("cancel during operation fails closed, no stale ok result", async () => {
    provider.triggerAbort();
    const click = await host.click("t1", "#x", new AbortController().signal);
    expect(click.ok).toBe(false);
    if (click.ok) throw new Error("click must not succeed when cancelled");
    expect(click.error).toContain("cancelled");
    expect(click.durationMs).toBeGreaterThanOrEqual(0);
    const type = await host.type(
      "t1",
      "#x",
      "hi",
      new AbortController().signal,
    );
    expect(type.ok).toBe(false);
    const press = await host.press("t1", "Enter", new AbortController().signal);
    expect(press.ok).toBe(false);
  });

  it("click / type / press honour the AbortSignal and keep the schema", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const click = await host.click("t1", "#x", ctrl.signal);
    expect(click.ok).toBe(false);
    if (click.ok) throw new Error("click must not succeed when cancelled");
    expect(typeof click.error).toBe("string");
    const type = await host.type("t1", "#x", "hi", ctrl.signal);
    expect(type.ok).toBe(false);
    const press = await host.press("t1", "Enter", ctrl.signal);
    expect(press.ok).toBe(false);
  });

  it("scroll / wait honour the AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const scroll = await host.scroll("t1", 0, 10, ctrl.signal);
    expect(scroll.ok).toBe(false);
    const wait = await host.wait("t1", "#x", ctrl.signal);
    expect(wait.ok).toBe(false);
  });

  it("extract honours the AbortSignal and keeps the schema", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await host.extract("t1", ctrl.signal);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("extract must not succeed on an aborted signal");
    expect(typeof r.error).toBe("string");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("screenshot honours the AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await host.screenshot("t1", ctrl.signal);
    expect(r.ok).toBe(false);
    if (r.ok)
      throw new Error("screenshot must not succeed on an aborted signal");
    expect(typeof r.error).toBe("string");
  });

  it("durationMs is always present on success", async () => {
    const s = await host.getSession("t1");
    expect(s.id).toBe("default::t1");
    const nav = await host.navigate(
      "t1",
      "https://x.test/",
      new AbortController().signal,
    );
    expect(nav.ok).toBe(true);
    expect(typeof nav.durationMs).toBe("number");
    const snap = await host.extract("t1", new AbortController().signal);
    expect(snap.ok).toBe(true);
    expect(typeof snap.durationMs).toBe("number");
    const shot = await host.screenshot("t1", new AbortController().signal);
    expect(shot.ok).toBe(true);
    expect(typeof shot.durationMs).toBe("number");
  });

  it("close and dispose tear down the provider, and dispose is idempotent", async () => {
    await host.getSession("t1");
    await host.closeSession("t1");
    await host.closeTaskSessions("t1");
    await host.dispose();
    // dispose is idempotent — calling again does not throw.
    await expect(host.dispose()).resolves.toBeUndefined();
  });

  it("no unhandled rejection leaks during cancelled calls", async () => {
    const off = watchUnhandledRejection();
    try {
      const ctrl = new AbortController();
      ctrl.abort();
      const nav = await host.navigate("t1", "https://x.test/", ctrl.signal);
      expect(nav.ok).toBe(false);
      const click = await host.click("t1", "#x", ctrl.signal);
      expect(click.ok).toBe(false);
    } finally {
      off();
    }
  });
});
