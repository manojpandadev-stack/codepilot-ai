/** @codepilot/browser-engine — engine adapter: Browser over playwright-core.
 *
 * Thin adapter over BrowserService that binds the host-side BrowserHost
 * interface to a real BrowserService. Session state lives entirely inside
 * the provider; this adapter is free of playwright/Chromium and only maps
 * the provider's native result shapes onto the host `BrowserResult` /
 * navigate shapes for the runtime.
 */
import type { BrowserHost, BrowserResult } from "./browser-host.js";
import type { BrowserHostProvider } from "./browser-provider.js";
import type { BrowserSession } from "./browser-service.js";

// Re-exported so consumers of this adapter can name the host contract without
// reaching into the sibling module.
export type {
  BrowserHost,
  BrowserResult,
  HostCancellation,
} from "./browser-host.js";

/**
 * Real browser adapter. Keeps zero internal state beyond the provider it
 * owns; every operation is delegated to the provider with fail-closed
 * semantics on the supplied AbortSignal. Navigation fails closed on the
 * SSRF verdict (no ok is ever claimed for a blocked URL).
 *
 * `sessionId` is the PUBLIC host-facing browser session id. The provider
 * uses an internal sub-key (`default`) for session isolation; the host
 * never depends on that sub-scheme.
 */
export class Browser implements BrowserHost {
  readonly sessionId = "browser-default";

  /** @internal */ private readonly provider: BrowserHostProvider;

  constructor(provider: BrowserHostProvider) {
    this.provider = provider;
  }

  async getSession(taskId: string): Promise<BrowserSession> {
    // `default` mirrors BrowserService's internal session sub-key so that
    // getSession and the operations always resolve the same session.
    return this.provider.getSession(taskId, "default");
  }

  async closeSession(taskId: string): Promise<void> {
    await this.provider.closeSession(taskId, "default");
  }

  async closeTaskSessions(taskId: string): Promise<void> {
    await this.provider.closeTaskSessions(taskId);
  }

  async dispose(): Promise<void> {
    await this.provider.dispose();
  }

  status(taskId: string): { exists: boolean; url?: string; idleMs?: number } {
    return this.provider.status(taskId);
  }

  async navigate(
    taskId: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<BrowserResult<{ url: string; status: number; title: string }>> {
    const started = Date.now();
    const result = await this.provider.navigate(taskId, "default", url, signal);
    if (!result.ok) {
      return {
        ok: false,
        error: result.error!,
        durationMs: Date.now() - started,
      };
    }
    return {
      ok: true,
      value: { url: result.url!, status: result.status!, title: result.title! },
      durationMs: Date.now() - started,
    };
  }

  async click(
    taskId: string,
    selector: string,
    signal?: AbortSignal,
  ): Promise<BrowserResult<void>> {
    const started = Date.now();
    const result = await this.provider.click(
      taskId,
      "default",
      selector,
      signal,
    );
    if (!result.ok) {
      return {
        ok: false,
        error: result.error!,
        durationMs: Date.now() - started,
      };
    }
    return { ok: true, value: undefined, durationMs: Date.now() - started };
  }

  async type(
    taskId: string,
    selector: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<BrowserResult<void>> {
    const started = Date.now();
    const result = await this.provider.fill(
      taskId,
      "default",
      selector,
      text,
      signal,
    );
    if (!result.ok) {
      return {
        ok: false,
        error: result.error!,
        durationMs: Date.now() - started,
      };
    }
    return { ok: true, value: undefined, durationMs: Date.now() - started };
  }

  async press(
    taskId: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<BrowserResult<void>> {
    const started = Date.now();
    const result = await this.provider.press(taskId, "default", key, signal);
    if (!result.ok) {
      return {
        ok: false,
        error: result.error!,
        durationMs: Date.now() - started,
      };
    }
    return { ok: true, value: undefined, durationMs: Date.now() - started };
  }

  async scroll(
    taskId: string,
    deltaX: number,
    deltaY: number,
    signal?: AbortSignal,
  ): Promise<BrowserResult<void>> {
    const started = Date.now();
    const result = await this.provider.scroll(
      taskId,
      "default",
      deltaX,
      deltaY,
      signal,
    );
    if (!result.ok) {
      return {
        ok: false,
        error: result.error!,
        durationMs: Date.now() - started,
      };
    }
    return { ok: true, value: undefined, durationMs: Date.now() - started };
  }

  async wait(
    taskId: string,
    selector: string | number,
    signal?: AbortSignal,
  ): Promise<BrowserResult<void>> {
    const started = Date.now();
    const result = await this.provider.wait(
      taskId,
      "default",
      selector,
      signal,
    );
    if (!result.ok) {
      return {
        ok: false,
        error: result.error!,
        durationMs: Date.now() - started,
      };
    }
    return { ok: true, value: undefined, durationMs: Date.now() - started };
  }

  async extract(
    taskId: string,
    signal?: AbortSignal,
  ): Promise<
    BrowserResult<{ url: string; title: string; text: string; links: string[] }>
  > {
    const started = Date.now();
    const snap = await this.provider.inspect(taskId, "default", signal);
    if ("ok" in snap && snap.ok === false) {
      return {
        ok: false,
        error: snap.error!,
        durationMs: Date.now() - started,
      };
    }
    return {
      ok: true,
      value: snap as {
        url: string;
        title: string;
        text: string;
        links: string[];
      },
      durationMs: Date.now() - started,
    };
  }

  async screenshot(
    taskId: string,
    signal?: AbortSignal,
  ): Promise<BrowserResult<{ base64: string }>> {
    const started = Date.now();
    const result = await this.provider.screenshot(taskId, "default", signal);
    if (!result.ok) {
      return {
        ok: false,
        error: result.error!,
        durationMs: Date.now() - started,
      };
    }
    return {
      ok: true,
      value: { base64: result.base64 },
      durationMs: Date.now() - started,
    };
  }
}
