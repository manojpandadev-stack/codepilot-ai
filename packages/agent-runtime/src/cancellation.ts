/**
 * @codepilot/agent-runtime — Cancellation & Timeout primitives
 *
 * Provides:
 *   CancellationToken  — lightweight cooperative cancellation signal
 *   CancellationSource — creates and controls a CancellationToken
 *   TimeoutManager     — schedules a cancellation after a deadline
 *
 * Design principles:
 *   - No dependency on the native agent engine or VS Code APIs.
 *   - Idempotent: cancelling an already-cancelled token is a no-op.
 *   - Listeners are invoked synchronously on cancel.
 *   - TimeoutManager clears its timer on dispose() — no resource leaks.
 */

// ============================================================================
// CancellationError
// ============================================================================

export class CancellationError extends Error {
  readonly reason: string;

  constructor(reason = "Operation was cancelled") {
    super(reason);
    this.name = "CancellationError";
    this.reason = reason;
  }
}

// ============================================================================
// CancellationListener
// ============================================================================

export type CancellationListener = (reason: string) => void;

// ============================================================================
// CancellationToken
// ============================================================================

/**
 * Read-only view of a cancellation signal.
 * Passed to long-running operations so they can poll or subscribe.
 */
export interface CancellationToken {
  /** True once the token has been cancelled. */
  readonly isCancelled: boolean;
  /** The reason string supplied at cancellation time, or undefined. */
  readonly cancellationReason: string | undefined;
  /**
   * Register a callback to be invoked synchronously when the token is
   * cancelled. If already cancelled, the callback is invoked immediately.
   * @returns An unsubscribe function.
   */
  onCancelled(listener: CancellationListener): () => void;
  /**
   * Throw a `CancellationError` if the token has been cancelled.
   */
  throwIfCancelled(): void;
}

// ============================================================================
// CancellationSource
// ============================================================================

/**
 * Creates and owns a CancellationToken.
 * Call `cancel(reason?)` to signal cancellation to all token consumers.
 */
export class CancellationSource {
  private _cancelled = false;
  private _reason: string | undefined;
  private _listeners = new Set<CancellationListener>();

  /** The token managed by this source. */
  readonly token: CancellationToken;

  constructor() {
    // Capture `this` so the token's methods close over the source's fields.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const src = this;
    this.token = {
      get isCancelled(): boolean {
        return src._cancelled;
      },
      get cancellationReason(): string | undefined {
        return src._reason;
      },
      onCancelled(listener: CancellationListener): () => void {
        if (src._cancelled) {
          try {
            listener(src._reason ?? "");
          } catch {
            /* listeners must not crash the runtime */
          }
          return () => undefined;
        }
        src._listeners.add(listener);
        return () => {
          src._listeners.delete(listener);
        };
      },
      throwIfCancelled(): void {
        if (src._cancelled) {
          throw new CancellationError(src._reason);
        }
      },
    };
  }

  get isCancelled(): boolean {
    return this._cancelled;
  }

  /**
   * Cancel the token and invoke all registered listeners synchronously.
   * Idempotent: subsequent calls are ignored.
   */
  cancel(reason = "Cancelled"): void {
    if (this._cancelled) return;
    this._cancelled = true;
    this._reason = reason;
    for (const listener of this._listeners) {
      try {
        listener(reason);
      } catch {
        /* ignore listener errors */
      }
    }
    this._listeners.clear();
  }

  /** Dispose without cancelling — clears listener references. */
  dispose(): void {
    this._listeners.clear();
  }
}

// ============================================================================
// TimeoutManager
// ============================================================================

/**
 * Schedules cancellation of a `CancellationSource` after a deadline.
 *
 * Usage:
 * ```ts
 * const source = new CancellationSource();
 * const timer = new TimeoutManager(source, 30_000, "Run timed out");
 * try {
 *   await doWork(source.token);
 * } finally {
 *   timer.dispose(); // always clear the timer
 * }
 * ```
 */
export class TimeoutManager {
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _fired = false;
  private _source: CancellationSource;
  private _reason: string;

  /**
   * @param source     The `CancellationSource` to cancel on timeout.
   * @param timeoutMs  Deadline in milliseconds. Pass 0 to disable (no timer set).
   * @param reason     Reason string forwarded to `source.cancel()`.
   */
  constructor(
    source: CancellationSource,
    timeoutMs: number,
    reason: string = "Operation timed out",
  ) {
    this._source = source;
    this._reason = reason;
    if (timeoutMs > 0) {
      this._timer = setTimeout(() => {
        this._fired = true;
        this._timer = null;
        this._source.cancel(this._reason);
      }, timeoutMs);
    }
  }

  /** True if the timeout fired before `dispose()` was called. */
  get fired(): boolean {
    return this._fired;
  }

  /** Clear the scheduled timeout. No-op if already fired or not set. */
  dispose(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}

// ============================================================================
// withTimeout — convenience wrapper for a single async operation
// ============================================================================

/**
 * Wrap an async operation with a combined timeout + cancellation token.
 */
export async function withTimeout<T>(
  operation: (token: CancellationToken) => Promise<T>,
  options: {
    timeoutMs?: number;
    parentToken?: CancellationToken;
    timeoutReason?: string;
  } = {},
): Promise<T> {
  const source = new CancellationSource();

  let parentUnsub: (() => void) | undefined;
  if (options.parentToken) {
    parentUnsub = options.parentToken.onCancelled((reason) => {
      source.cancel(reason);
    });
  }

  const timer = new TimeoutManager(
    source,
    options.timeoutMs ?? 0,
    options.timeoutReason ?? "Operation timed out",
  );

  try {
    return await operation(source.token);
  } finally {
    timer.dispose();
    parentUnsub?.();
    source.dispose();
  }
}

// ============================================================================
// RetryPolicy
// ============================================================================

export interface RetryPolicyOptions {
  /** Maximum number of retry attempts (not counting the initial try). */
  maxRetries: number;
  /**
   * Initial delay before the first retry (ms). Default: 500.
   * Actual delay is `initialDelayMs * 2^attempt` (exponential backoff),
   * capped at `maxDelayMs`.
   */
  initialDelayMs?: number;
  /** Maximum delay between retries (ms). Default: 10 000. */
  maxDelayMs?: number;
  /**
   * Predicate that returns true when an error should be retried.
   * If omitted, all errors are retried up to `maxRetries`.
   */
  isRetryable?: (error: unknown) => boolean;
}

export interface RetryAttempt {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  error: unknown;
}

export type RetryObserver = (attempt: RetryAttempt) => void;

/**
 * Execute an async operation with configurable retry and backoff.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicyOptions,
  token?: CancellationToken,
  observer?: RetryObserver,
): Promise<T> {
  const { maxRetries, initialDelayMs = 500, maxDelayMs = 10_000 } = policy;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    token?.throwIfCancelled();

    try {
      return await operation();
    } catch (err) {
      lastError = err;

      // CancellationError is never retried
      if (err instanceof CancellationError) throw err;

      // Non-retryable error
      if (policy.isRetryable && !policy.isRetryable(err)) throw err;

      // Exhausted retries
      if (attempt >= maxRetries) break;

      // Exponential back-off with jitter
      const base = Math.min(initialDelayMs * Math.pow(2, attempt), maxDelayMs);
      const jitter = base * 0.1 * (Math.random() * 2 - 1);
      const delayMs = Math.round(Math.max(0, base + jitter));

      observer?.({ attempt: attempt + 1, maxRetries, delayMs, error: err });

      // Interruptible delay
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        token?.onCancelled((reason) => {
          clearTimeout(timer);
          reject(new CancellationError(reason));
        });
      });
    }
  }

  throw lastError;
}

// ============================================================================
// isTransientError — used by the runtime to decide whether to retry
// ============================================================================

/**
 * Returns true when an error looks like a transient infrastructure failure
 * safe to retry.
 */
export function isTransientError(error: unknown): boolean {
  if (error instanceof CancellationError) return false;

  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  const lower = message.toLowerCase();

  // Never retry these
  const permanentPatterns = [
    "permission denied",
    "access denied",
    "unauthorized",
    "forbidden",
    "invalid api key",
    "authentication failed",
    "workspace escape",
    "path traversal",
    "command injection",
    "security",
    "secret leak",
    "quota exceeded",
    "rate limit",
    "invalid argument",
    "invalid input",
    "workspace boundary",
    "cannot find module",
    "module not found",
  ];
  for (const pat of permanentPatterns) {
    if (lower.includes(pat)) return false;
  }

  // Transient patterns
  const transientPatterns = [
    "econnrefused",
    "econnreset",
    "etimedout",
    "enotfound",
    "socket hang up",
    "network",
    "timeout",
    "timed out",
    "503",
    "502",
    "504",
    "service unavailable",
    "bad gateway",
    "temporarily unavailable",
    "connection refused",
    "connection reset",
    "ollama",
  ];
  for (const pat of transientPatterns) {
    if (lower.includes(pat)) return true;
  }

  return false;
}
