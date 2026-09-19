/**
 * @codepilot/browser-engine — BrowserService: isolated, ephemeral browser
 * sessions over Playwright with request-level SSRF enforcement.
 *
 * Security model:
 * - Ephemeral by default: fresh context per session, no persistent profile,
 *   cookies/storage die with the session. Nothing is written to disk.
 * - Request-level SSRF: every request (top-level navigation, redirects,
 *   iframes, XHR/fetch, images) passes the URL policy via page.route —
 *   the URL validator sees the FINAL redirect target because Chromium asks
 *   us before connecting to each new URL.
 * - Task-scoped isolation: sessions are keyed by taskId + sessionId; a
 *   session is never shared across tasks. Closing a task closes its sessions.
 * - Lifecycle: hard cap on concurrent sessions, idle eviction, absolute
 *   max-age, full teardown on close/cancel/dispose → no zombie Chromium.
 */

import type { Browser, BrowserContext, Page } from "playwright-core";
import {
  validateTargetUrl,
  safeTargetOf,
  type UrlPolicyOptions,
} from "./url-policy.js";

// ============================================================================
// Types
// ============================================================================

export interface PageSnapshot {
  url: string;
  title: string;
  /** Visible text (redacted by caller before model exposure). */
  text: string;
  /** Absolute links found on the page. */
  links: string[];
}

export interface NavigateResult {
  ok: boolean;
  url?: string;
  status?: number;
  title?: string;
  error?: string;
}

export interface BrowserServiceOptions {
  /** Per-navigation timeout (default 20s). */
  navigationTimeoutMs?: number;
  /** Max characters extracted from a page (default 20_000). */
  maxTextChars?: number;
  /** Max concurrent browser sessions (default 2). */
  maxSessions?: number;
  /** Idle session eviction (default 5 min). */
  idleTimeoutMs?: number;
  /** Absolute session max age regardless of activity (default 30 min). */
  maxSessionAgeMs?: number;
  /** Full-page screenshot byte cap (default 2 MiB). */
  maxScreenshotBytes?: number;
  /** URL policy knobs forwarded to validateTargetUrl. */
  urlPolicy?: UrlPolicyOptions;
  /**
   * Playwright launch channel: "chrome", "msedge", or undefined for bundled
   * Chromium. The VSIX ships playwright-core (no browser download); the host
   * passes a system channel discovered by the extension.
   */
  channel?: string;
}

interface BrowserSession {
  id: string;
  taskId: string;
  context: BrowserContext;
  page: Page;
  createdAt: number;
  lastUsedAt: number;
  /** Redirect hops observed for the current navigation chain. */
  redirectHops: number;
  /** URLs allowed by policy for THIS page load (route interceptor cache). */
  validatedUrls: Map<string, boolean>;
}

// ============================================================================
// Lazy playwright import — keeps the module loadable without browsers
// ============================================================================

type PlaywrightModule = typeof import("playwright-core");
let playwrightPromise: Promise<PlaywrightModule> | null = null;

function loadPlaywright(): Promise<PlaywrightModule> {
  if (!playwrightPromise) {
    playwrightPromise = import("playwright-core");
  }
  return playwrightPromise;
}

// ============================================================================
// Service
// ============================================================================

export class BrowserService {
  private readonly options: Required<
    Pick<
      BrowserServiceOptions,
      | "navigationTimeoutMs"
      | "maxTextChars"
      | "maxSessions"
      | "idleTimeoutMs"
      | "maxSessionAgeMs"
      | "maxScreenshotBytes"
    >
  > &
    BrowserServiceOptions;
  private readonly sessions = new Map<string, BrowserSession>();
  private browser: Browser | null = null;
  private browserLock: Promise<Browser> | null = null;
  private disposed = false;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Recent audit records (bounded); host may mirror to observability. */
  private readonly auditTrail: BrowserAuditEntry[] = [];

  constructor(options: BrowserServiceOptions = {}) {
    this.options = {
      navigationTimeoutMs: options.navigationTimeoutMs ?? 20_000,
      maxTextChars: options.maxTextChars ?? 20_000,
      maxSessions: options.maxSessions ?? 2,
      idleTimeoutMs: options.idleTimeoutMs ?? 5 * 60_000,
      maxSessionAgeMs: options.maxSessionAgeMs ?? 30 * 60_000,
      maxScreenshotBytes: options.maxScreenshotBytes ?? 2 * 1024 * 1024,
      ...options,
    };
    // Periodic sweep guarantees idle/max-age eviction even if the agent
    // forgets to close — bounds resource use and prevents zombies.
    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, 60_000);
    if (typeof this.sweepTimer === "object" && this.sweepTimer !== null) {
      // Node setInterval returns a Timeout with unref — keep the process free.
      this.sweepTimer.unref?.();
    }
  }

  /** Bounded audit trail of browser operations (secret-free). */
  getAuditTrail(): readonly BrowserAuditEntry[] {
    return this.auditTrail;
  }

  private audit(entry: Omit<BrowserAuditEntry, "timestampMs">): void {
    this.auditTrail.push({ ...entry, timestampMs: Date.now() });
    if (this.auditTrail.length > 200) this.auditTrail.shift();
  }

  // ---- Lifecycle -----------------------------------------------------------

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.browserLock) return this.browserLock;
    this.browserLock = (async () => {
      const pw = await loadPlaywright();
      const launchOptions: Parameters<typeof pw.chromium.launch>[0] = {
        headless: true,
        args: [
          "--no-first-run",
          "--disable-features=Translate",
          "--disable-background-networking",
          "--disable-component-update",
        ],
      };
      if (this.options.channel) launchOptions.channel = this.options.channel;
      const browser = await pw.chromium.launch(launchOptions);
      browser.on("disconnected", () => {
        // Crash handling: forget the handle so the next call relaunches.
        if (this.browser === browser) this.browser = null;
        for (const [id] of this.sessions) {
          void this.destroySession(id, "browser-crashed").catch(() => {});
          this.sessions.delete(id);
        }
      });
      this.browser = browser;
      return browser;
    })();
    try {
      return await this.browserLock;
    } finally {
      this.browserLock = null;
    }
  }

  /**
   * Get-or-create an isolated session for a task. Sessions are never shared
   * across tasks — the key includes the taskId.
   */
  async getSession(taskId: string, sessionId = "default"): Promise<BrowserSession> {
    this.assertAlive();
    const key = sessionKey(taskId, sessionId);
    const existing = this.sessions.get(key);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    if (this.sessions.size >= this.options.maxSessions) {
      // Evict the least-recently-used session first.
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [k, s] of this.sessions) {
        if (s.lastUsedAt < oldest) {
          oldest = s.lastUsedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        await this.destroySession(oldestKey, "evicted-lru");
        this.sessions.delete(oldestKey);
      }
    }
    const browser = await this.ensureBrowser();
    // Ephemeral context: no persistence, no service workers' cache on disk.
    const context = await browser.newContext({
      // Sane desktop viewport; screenshots stay small.
      viewport: { width: 1280, height: 720 },
      // Downloads are DENIED unless explicitly allowed per-call.
      acceptDownloads: false,
      // No third-party cookie heuristics needed for ephemeral browsing.
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const session: BrowserSession = {
      id: key,
      taskId,
      context,
      page,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      redirectHops: 0,
      validatedUrls: new Map(),
    };
    this.installRouteInterceptor(session);
    this.sessions.set(key, session);
    this.audit({
      taskId,
      sessionId,
      action: "session-open",
      target: "(none)",
      outcome: "ok",
    });
    return session;
  }

  /** Close one session. Idempotent; never throws. */
  async closeSession(taskId: string, sessionId = "default"): Promise<void> {
    const key = sessionKey(taskId, sessionId);
    await this.destroySession(key, "closed");
    this.sessions.delete(key);
  }

  /** Close ALL sessions for a task (task termination / cancellation). */
  async closeTaskSessions(taskId: string): Promise<void> {
    for (const [key, s] of [...this.sessions]) {
      if (s.taskId === taskId) {
        await this.destroySession(key, "task-ended");
        this.sessions.delete(key);
      }
    }
  }

  /** Full teardown: every session + the browser process. Idempotent. */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const key of [...this.sessions.keys()]) {
      await this.destroySession(key, "disposed");
      this.sessions.delete(key);
    }
    const browser = this.browser;
    this.browser = null;
    if (browser) {
      try {
        await browser.close();
      } catch {
        // best effort — the process kill below is the hard guarantee
      }
      try {
        // Hard fallback: ensure no zombie chromium remains. (Playwright's
        // Browser.close() already kills the process; this is belt-and-braces.)
        const proc = (browser as unknown as { process?: () => ReturnType<typeof import("node:child_process").spawn> | null }).process?.();
        proc?.kill();
      } catch {
        // already gone
      }
    }
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error("BrowserService has been disposed");
  }

  private async destroySession(
    key: string,
    reason: string,
  ): Promise<void> {
    const s = this.sessions.get(key);
    if (!s) return;
    this.audit({
      taskId: s.taskId,
      sessionId: s.id,
      action: "session-close",
      target: "(none)",
      outcome: "ok",
      detail: reason,
    });
    try {
      await s.context.close();
    } catch {
      // best effort
    }
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const [key, s] of [...this.sessions]) {
      const idle = now - s.lastUsedAt > this.options.idleTimeoutMs;
      const aged = now - s.createdAt > this.options.maxSessionAgeMs;
      if (idle || aged) {
        await this.destroySession(key, idle ? "idle-timeout" : "max-age");
        this.sessions.delete(key);
      }
    }
  }

  // ---- Request interception (SSRF enforcement point) -----------------------

  /**
   * Install the route interceptor: EVERY request the page makes (navigations,
   * redirects, iframes, XHR/fetch, subresources) is validated against the URL
   * policy before Chromium connects. Non-http(s) schemes and private targets
   * are aborted.
   */
  private installRouteInterceptor(session: BrowserSession): void {
    void session.page.route("**/*", async (route) => {
      const url = route.request().url();
      try {
        // Resource-type policy: navigation + XHR/fetch validated fully;
        // subresources validated too (they can hit internal hosts as well).
        const isNav = route.request().isNavigationRequest();
        const hopKey = isNav ? "nav" : "sub";
        if (isNav) {
          // Redirect chain accounting on navigation requests.
          const prev = session.redirectHops;
          const redirectedFrom = route.request().redirectedFrom();
          session.redirectHops = redirectedFrom ? prev + 1 : 0;
          if (session.redirectHops > 5) {
            session.validatedUrls.set(url, false);
            await route.abort("aborted");
            this.audit({
              taskId: session.taskId,
              sessionId: session.id,
              action: "navigate",
              target: safeTargetOf(url),
              outcome: "blocked",
              detail: "redirect limit exceeded",
            });
            return;
          }
        }
        const cached = session.validatedUrls.get(`${hopKey}:${url}`);
        const verdict =
          cached !== undefined
            ? cached
            : (
                await validateTargetUrl(url, this.options.urlPolicy ?? {})
              ).verdict === "allowed";
        session.validatedUrls.set(`${hopKey}:${url}`, verdict);
        if (!verdict) {
          await route.abort("blockedbyclient");
          this.audit({
            taskId: session.taskId,
            sessionId: session.id,
            action: isNav ? "navigate" : "request",
            target: safeTargetOf(url),
            outcome: "blocked",
            detail: "url policy",
          });
          return;
        }
        await route.continue();
      } catch {
        // Interceptor failure must fail CLOSED.
        try {
          await route.abort("blockedbyclient");
        } catch {
          // route may already be handled
        }
      }
    });
  }

  // ---- Operations ----------------------------------------------------------

  /** Navigate the session's page. Aborts on signal; validates the target. */
  async navigate(
    taskId: string,
    sessionId: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<NavigateResult> {
    const started = Date.now();
    const session = await this.getSession(taskId, sessionId);
    const policy = await validateTargetUrl(url, this.options.urlPolicy ?? {});
    if (policy.verdict !== "allowed") {
      this.audit({
        taskId,
        sessionId,
        action: "navigate",
        target: safeTargetOf(url),
        outcome: "blocked",
        detail: policy.reason,
        durationMs: Date.now() - started,
      });
      return { ok: false, error: `navigation blocked: ${policy.reason}` };
    }
    try {
      const response = await withAbort(
        () =>
          session.page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: this.options.navigationTimeoutMs,
          }),
        signal,
      );
      const finalUrl = session.page.url();
      session.lastUsedAt = Date.now();
      this.audit({
        taskId,
        sessionId,
        action: "navigate",
        target: safeTargetOf(finalUrl),
        outcome: "ok",
        detail: response ? `status ${response.status()}` : "no response",
        durationMs: Date.now() - started,
      });
      return {
        ok: true,
        url: finalUrl,
        status: response?.status(),
        title: await session.page.title(),
      };
    } catch (err) {
      const message = sanitizeError(err);
      this.audit({
        taskId,
        sessionId,
        action: "navigate",
        target: safeTargetOf(url),
        outcome: "error",
        detail: message,
        durationMs: Date.now() - started,
      });
      return { ok: false, error: message };
    }
  }

  async goBack(taskId: string, sessionId: string, signal?: AbortSignal): Promise<NavigateResult> {
    return this.historyNav(taskId, sessionId, "goBack", signal);
  }

  async goForward(taskId: string, sessionId: string, signal?: AbortSignal): Promise<NavigateResult> {
    return this.historyNav(taskId, sessionId, "goForward", signal);
  }

  async reload(taskId: string, sessionId: string, signal?: AbortSignal): Promise<NavigateResult> {
    return this.historyNav(taskId, sessionId, "reload", signal);
  }

  private async historyNav(
    taskId: string,
    sessionId: string,
    op: "goBack" | "goForward" | "reload",
    signal?: AbortSignal,
  ): Promise<NavigateResult> {
    const started = Date.now();
    const session = await this.getSession(taskId, sessionId);
    try {
      const response = await withAbort(
        () =>
          op === "goBack"
            ? session.page.goBack({ waitUntil: "domcontentloaded", timeout: this.options.navigationTimeoutMs })
            : op === "goForward"
              ? session.page.goForward({ waitUntil: "domcontentloaded", timeout: this.options.navigationTimeoutMs })
              : session.page.reload({ waitUntil: "domcontentloaded", timeout: this.options.navigationTimeoutMs }),
        signal,
      );
      session.lastUsedAt = Date.now();
      this.audit({
        taskId,
        sessionId,
        action: op,
        target: safeTargetOf(session.page.url()),
        outcome: "ok",
        durationMs: Date.now() - started,
      });
      return {
        ok: true,
        url: session.page.url(),
        status: response?.status(),
        title: await session.page.title(),
      };
    } catch (err) {
      const message = sanitizeError(err);
      this.audit({
        taskId,
        sessionId,
        action: op,
        target: safeTargetOf(session.page.url()),
        outcome: "error",
        detail: message,
        durationMs: Date.now() - started,
      });
      return { ok: false, error: message };
    }
  }

  /** Click an element. Selector-scoped; state-changing → M4 ASK upstream. */
  async click(
    taskId: string,
    sessionId: string,
    selector: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string }> {
    const started = Date.now();
    const session = await this.getSession(taskId, sessionId);
    try {
      await withAbort(
        () =>
          session.page.click(selector, {
            timeout: 10_000,
            // Clicks must target VISIBLE elements — no offscreen hijinks.
            trial: false,
          }),
        signal,
      );
      session.lastUsedAt = Date.now();
      this.audit({
        taskId,
        sessionId,
        action: "click",
        target: safeTargetOf(session.page.url()),
        outcome: "ok",
        detail: `selector ${selector.slice(0, 80)}`,
        durationMs: Date.now() - started,
      });
      return { ok: true };
    } catch (err) {
      const message = sanitizeError(err);
      this.audit({
        taskId,
        sessionId,
        action: "click",
        target: safeTargetOf(session.page.url()),
        outcome: "error",
        detail: message,
        durationMs: Date.now() - started,
      });
      return { ok: false, error: message };
    }
  }

  /** Fill a form field (clears existing value first). */
  async fill(
    taskId: string,
    sessionId: string,
    selector: string,
    value: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string }> {
    const started = Date.now();
    const session = await this.getSession(taskId, sessionId);
    try {
      await withAbort(() => session.page.fill(selector, value, { timeout: 10_000 }), signal);
      session.lastUsedAt = Date.now();
      // The VALUE is never recorded (form contents may be sensitive).
      this.audit({
        taskId,
        sessionId,
        action: "fill",
        target: safeTargetOf(session.page.url()),
        outcome: "ok",
        detail: `selector ${selector.slice(0, 80)}; value redacted`,
        durationMs: Date.now() - started,
      });
      return { ok: true };
    } catch (err) {
      const message = sanitizeError(err);
      this.audit({
        taskId,
        sessionId,
        action: "fill",
        target: safeTargetOf(session.page.url()),
        outcome: "error",
        detail: message,
        durationMs: Date.now() - started,
      });
      return { ok: false, error: message };
    }
  }

  /** Press a key (Enter to submit, Escape, …). */
  async press(
    taskId: string,
    sessionId: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string }> {
    const started = Date.now();
    const session = await this.getSession(taskId, sessionId);
    try {
      await withAbort(() => session.page.keyboard.press(key), signal);
      session.lastUsedAt = Date.now();
      this.audit({
        taskId,
        sessionId,
        action: "press",
        target: safeTargetOf(session.page.url()),
        outcome: "ok",
        detail: `key ${key.slice(0, 40)}`,
        durationMs: Date.now() - started,
      });
      return { ok: true };
    } catch (err) {
      const message = sanitizeError(err);
      this.audit({
        taskId,
        sessionId,
        action: "press",
        target: safeTargetOf(session.page.url()),
        outcome: "error",
        detail: message,
        durationMs: Date.now() - started,
      });
      return { ok: false, error: message };
    }
  }

  /** Scroll the page by pixels (positive = down). */
  async scroll(
    taskId: string,
    sessionId: string,
    deltaX: number,
    deltaY: number,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string }> {
    const session = await this.getSession(taskId, sessionId);
    try {
      await withAbort(
        () =>
          session.page.evaluate(
            ([dx, dy]) => window.scrollBy(dx, dy),
            [deltaX, deltaY] as const,
          ),
        signal,
      );
      session.lastUsedAt = Date.now();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: sanitizeError(err) };
    }
  }

  /** Wait (selector or milliseconds). */
  async wait(
    taskId: string,
    sessionId: string,
    selector: string | number,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string }> {
    const session = await this.getSession(taskId, sessionId);
    try {
      if (typeof selector === "number") {
        const ms = Math.min(selector, 10_000);
        await withAbort(() => new Promise((r) => setTimeout(r, ms)), signal);
      } else {
        await withAbort(
          () => session.page.waitForSelector(selector, { timeout: 10_000 }),
          signal,
        );
      }
      session.lastUsedAt = Date.now();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: sanitizeError(err) };
    }
  }

  /** Inspect: url, title, visible text (bounded), links. */
  async inspect(
    taskId: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<PageSnapshot | { ok: false; error: string }> {
    const started = Date.now();
    const session = await this.getSession(taskId, sessionId);
    try {
      const url = session.page.url();
      const title = await session.page.title();
      const text = await withAbort(
        () => session.page.evaluate(() => document.body?.innerText ?? ""),
        signal,
      );
      const links = await withAbort(
        () =>
          session.page.evaluate(() =>
            Array.from(document.querySelectorAll("a[href]"))
              .map((a) => (a as HTMLAnchorElement).href)
              .filter((h) => h.startsWith("http://") || h.startsWith("https://"))
              .slice(0, 200),
          ),
        signal,
      );
      session.lastUsedAt = Date.now();
      const snapshot: PageSnapshot = {
        url,
        title,
        text: text.slice(0, this.options.maxTextChars),
        links,
      };
      this.audit({
        taskId,
        sessionId,
        action: "inspect",
        target: safeTargetOf(url),
        outcome: "ok",
        durationMs: Date.now() - started,
      });
      return snapshot;
    } catch (err) {
      const message = sanitizeError(err);
      this.audit({
        taskId,
        sessionId,
        action: "inspect",
        target: safeTargetOf(session.page.url()),
        outcome: "error",
        detail: message,
        durationMs: Date.now() - started,
      });
      return { ok: false, error: message };
    }
  }

  /** Screenshot as PNG (bounded). Returns base64 or null on failure. */
  async screenshot(
    taskId: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true; base64: string } | { ok: false; error: string }> {
    const started = Date.now();
    const session = await this.getSession(taskId, sessionId);
    try {
      const buf = await withAbort(
        () => session.page.screenshot({ type: "png", fullPage: false }),
        signal,
      );
      if (buf.byteLength > this.options.maxScreenshotBytes) {
        return {
          ok: false,
          error: `screenshot too large (${buf.byteLength} bytes)`,
        };
      }
      session.lastUsedAt = Date.now();
      this.audit({
        taskId,
        sessionId,
        action: "screenshot",
        target: safeTargetOf(session.page.url()),
        outcome: "ok",
        detail: `${buf.byteLength} bytes`,
        durationMs: Date.now() - started,
      });
      return { ok: true, base64: buf.toString("base64") };
    } catch (err) {
      const message = sanitizeError(err);
      this.audit({
        taskId,
        sessionId,
        action: "screenshot",
        target: safeTargetOf(session.page.url()),
        outcome: "error",
        detail: message,
        durationMs: Date.now() - started,
      });
      return { ok: false, error: message };
    }
  }

  /** Session status (no page content). */
  status(taskId: string, sessionId = "default"): {
    exists: boolean;
    url?: string;
    createdAt?: number;
    idleMs?: number;
  } {
    const s = this.sessions.get(sessionKey(taskId, sessionId));
    if (!s) return { exists: false };
    return {
      exists: true,
      url: s.page.url(),
      createdAt: s.createdAt,
      idleMs: Date.now() - s.lastUsedAt,
    };
  }

  /** Number of live sessions (tests + health). */
  sessionCount(): number {
    return this.sessions.size;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function sessionKey(taskId: string, sessionId: string): string {
  return `${taskId}::${sessionId}`;
}

/**
 * Run an operation under an abort signal. LAZY: the operation factory is
 * invoked only after the pre-abort check, so a cancelled call never starts
 * the underlying Playwright action (an already-started goto would interrupt
 * the session's next navigation). A mid-flight abort rejects immediately;
 * the abandoned operation's late rejection is swallowed (it is already
 * reported as cancelled and must not become an unhandled rejection).
 */
async function withAbort<T>(
  startOp: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new Error("Operation cancelled");
  const op = startOp();
  if (!signal) return op;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      op.catch(() => {}); // abandoned — do not leak an unhandled rejection
      reject(new Error("Operation cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    op.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** Strip potentially sensitive details from playwright errors for results. */
function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 300);
}

export interface BrowserAuditEntry {
  taskId: string;
  sessionId: string;
  action: string;
  /** scheme://host only — never path, query, or content. */
  target: string;
  outcome: "ok" | "blocked" | "error";
  detail?: string;
  durationMs?: number;
  timestampMs: number;
}
