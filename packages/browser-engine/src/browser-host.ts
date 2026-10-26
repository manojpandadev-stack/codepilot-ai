/** @codepilot/browser-engine — browser host contract.
 *
 * A thin, dependency-free host interface so @codepilot/agent-runtime never
 * depends on Playwright/Chromium directly. The concrete implementation is
 * `Browser` (packages/browser-engine/src/browser.ts) over playwright-core.
 *
 * The concrete browser keeps zero internal state: every operation is
 * session-scoped (taskId + sessionId) and cancellation is carried by the
 * caller's AbortSignal. Cancellation must survive every browser boundary:
 * a cancelled call never claims success, the session stays usable, and every
 * session for the task is torn down when the task is cancelled.
 */
import type { BrowserSession } from "./browser-service.js";

/** Result of a single browser operation. */
export type BrowserResult<T> =
  | { ok: true; value: T; durationMs: number }
  | { ok: false; error: string; durationMs: number };

/** Host-side cancellation state. A cancelled host operation never completes
 * as `ok`; the session remains open and usable. */
export interface HostCancellation {
  /** Set true by the host when cancellation is observed; cleared on
   *  completion. Consumers check this before trusting a `ok` result. */
  cancelled: boolean;
}

/**
 * Abstract host for the browser capability. The agent-runtime binds to this
 * interface, so switching the engine (Playwright, Selenium, a future cloud
 * browser) never touches the runtime.
 */
export interface BrowserHost {
  /** Unique browser session id (task-scoped; engine owns the lifecycle). */
  sessionId: string;

  /** Get-or-create a session for a task (isolation: one task ≠ another). */
  getSession(taskId: string): Promise<BrowserSession>;

  /** Close one session (idempotent; never throws). */
  closeSession(taskId: string): Promise<void>;

  /** Close ALL sessions for a task (task termination / cancellation). */
  closeTaskSessions(taskId: string): Promise<void>;

  /** Full teardown: every session + the browser process. Idempotent. */
  dispose(): Promise<void>;

  /** Status of the browser / session (no page content). */
  status(taskId: string): { exists: boolean; url?: string; idleMs?: number };

  /** Abort-managed navigation. Fails closed: never returns `ok` on
   *  cancellation; the session stays open and usable. */
  navigate(
    taskId: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<BrowserResult<{ url: string; status: number; title: string }>>;

  /** Typed interaction: click. Fails closed when cancelled. */
  click(
    taskId: string,
    selector: string,
    signal?: AbortSignal,
  ): Promise<BrowserResult<void>>;

  /** Typed interaction: type into a form field (fail-closed on cancel). */
  type(
    taskId: string,
    selector: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<BrowserResult<void>>;

  /** Typed interaction: keyboard press (key names). */
  press(
    taskId: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<BrowserResult<void>>;

  /** Scroll the page by pixels. */
  scroll(
    taskId: string,
    deltaX: number,
    deltaY: number,
    signal?: AbortSignal,
  ): Promise<BrowserResult<void>>;

  /** Wait (bounded). */
  wait(
    taskId: string,
    selector: string | number,
    signal?: AbortSignal,
  ): Promise<BrowserResult<void>>;

  /** Extract bounded, secret-redacted DOM text + links. Read-only. */
  extract(
    taskId: string,
    signal?: AbortSignal,
  ): Promise<
    BrowserResult<{ url: string; title: string; text: string; links: string[] }>
  >;

  /** Screenshot (bounded PNG). */
  screenshot(
    taskId: string,
    signal?: AbortSignal,
  ): Promise<BrowserResult<{ base64: string }>>;
}
