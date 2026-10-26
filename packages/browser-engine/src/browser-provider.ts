/** @codepilot/browser-engine — browser session provider contract (host-facing).
 *
 * The abstract capability surface a browser session implementation exposes to
 * the host-side `Browser` adapter. This is the single seam at which the real
 * engine (`BrowserService`) and a hermetic test provider can be swapped.
 *
 * Security behavior lives in the implementation, never in this interface:
 * - SSRF protection (request-level, via the service's route interceptor)
 * - redirect validation
 * - localhost / private IP blocking
 * - metadata endpoint blocking
 * - timeout + cancellation
 * - M4 action mapping
 *
 * The provider's native result shapes mirror `BrowserService` so the real
 * engine and a fake can implement it without translation. The `Browser`
 * adapter is what translates them into the host `BrowserResult` / navigate
 * shapes for the runtime.
 */
import type {
  BrowserSession,
  NavigateResult,
  PageSnapshot,
} from "./browser-service.js";

export interface BrowserHostProvider {
  sessionId: string;

  /** Get-or-create a session for a task (task-scoped isolation). */
  getSession(taskId: string, sessionId?: string): Promise<BrowserSession>;

  /** Close one session (idempotent; never throws). */
  closeSession(taskId: string, sessionId?: string): Promise<void>;

  /** Close ALL sessions for a task (task termination / cancellation). */
  closeTaskSessions(taskId: string): Promise<void>;

  /** Full teardown: every session + the browser process. Idempotent. */
  dispose(): Promise<void>;

  /** Status of the browser / session (no page content). */
  status(taskId: string): { exists: boolean; url?: string; idleMs?: number };

  /** Abort-managed navigation. Fails closed: never returns `ok` on cancel. */
  navigate(
    taskId: string,
    sessionId: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<NavigateResult>;

  /** Typed interaction: click. Fails closed when cancelled. */
  click(
    taskId: string,
    sessionId: string,
    selector: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string }>;

  /** Typed interaction: fill a form field (value never logged). */
  fill(
    taskId: string,
    sessionId: string,
    selector: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string }>;

  /** Typed interaction: keyboard press (key names). */
  press(
    taskId: string,
    sessionId: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string }>;

  /** Scroll the page by pixels. */
  scroll(
    taskId: string,
    sessionId: string,
    deltaX: number,
    deltaY: number,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string }>;

  /** Wait (bounded selector or milliseconds). */
  wait(
    taskId: string,
    sessionId: string,
    selector: string | number,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string }>;

  /** Inspect: url, title, visible text (bounded, secret-redacted), links. */
  inspect(
    taskId: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<PageSnapshot | { ok: false; error: string }>;

  /** Screenshot as PNG (bounded). */
  screenshot(
    taskId: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true; base64: string } | { ok: false; error: string }>;
}
