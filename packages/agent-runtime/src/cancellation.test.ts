/**
 * Cancellation & Retry primitives — regression tests
 *
 * Covers:
 *  - CancellationSource: cancel(), isCancelled, cancellationReason
 *  - CancellationToken: onCancelled, throwIfCancelled
 *  - Idempotent cancellation
 *  - Already-cancelled token fires listeners immediately
 *  - Unsubscribe from onCancelled
 *  - TimeoutManager: fires after deadline, dispose() stops it
 *  - withTimeout(): resolves normally, cancels on timeout, cancels on parent token
 *  - withRetry(): success on first try, retries transient errors, stops on non-retryable
 *  - withRetry(): respects maxRetries, stops on cancellation
 *  - isTransientError(): correct classification of transient vs permanent errors
 *  - CancellationError is instanceof Error
 */

import { describe, it, expect, vi } from "vitest";
import {
  CancellationSource,
  CancellationError,
  TimeoutManager,
  withTimeout,
  withRetry,
  isTransientError,
} from "./cancellation.js";

// ============================================================================
// CancellationSource + CancellationToken
// ============================================================================

describe("CancellationSource", () => {
  it("starts uncancelled", () => {
    const src = new CancellationSource();
    expect(src.isCancelled).toBe(false);
    expect(src.token.isCancelled).toBe(false);
    expect(src.token.cancellationReason).toBeUndefined();
  });

  it("cancel() marks token as cancelled", () => {
    const src = new CancellationSource();
    src.cancel("test reason");
    expect(src.isCancelled).toBe(true);
    expect(src.token.isCancelled).toBe(true);
    expect(src.token.cancellationReason).toBe("test reason");
  });

  it("cancel() is idempotent — second call is ignored", () => {
    const src = new CancellationSource();
    src.cancel("first");
    src.cancel("second"); // should be ignored
    expect(src.token.cancellationReason).toBe("first");
  });

  it("cancel() invokes all registered listeners synchronously", () => {
    const src = new CancellationSource();
    const received: string[] = [];
    src.token.onCancelled((r) => received.push(`a:${r}`));
    src.token.onCancelled((r) => received.push(`b:${r}`));
    src.cancel("go");
    expect(received).toEqual(["a:go", "b:go"]);
  });

  it("onCancelled fires immediately when already cancelled", () => {
    const src = new CancellationSource();
    src.cancel("already");
    const received: string[] = [];
    src.token.onCancelled((r) => received.push(r));
    expect(received).toEqual(["already"]);
  });

  it("unsubscribe from onCancelled prevents delivery", () => {
    const src = new CancellationSource();
    const received: string[] = [];
    const unsub = src.token.onCancelled((r) => received.push(r));
    unsub();
    src.cancel("nope");
    expect(received).toHaveLength(0);
  });

  it("throwing listener does not prevent other listeners from running", () => {
    const src = new CancellationSource();
    const reached: string[] = [];
    src.token.onCancelled(() => {
      throw new Error("listener crash");
    });
    src.token.onCancelled(() => reached.push("ok"));
    src.cancel("x");
    expect(reached).toEqual(["ok"]);
  });

  it("throwIfCancelled() does nothing when not cancelled", () => {
    const src = new CancellationSource();
    expect(() => src.token.throwIfCancelled()).not.toThrow();
  });

  it("throwIfCancelled() throws CancellationError when cancelled", () => {
    const src = new CancellationSource();
    src.cancel("stop");
    expect(() => src.token.throwIfCancelled()).toThrow(CancellationError);
  });

  it("throwIfCancelled() includes reason in error message", () => {
    const src = new CancellationSource();
    src.cancel("custom reason");
    try {
      src.token.throwIfCancelled();
    } catch (e) {
      expect(e).toBeInstanceOf(CancellationError);
      expect((e as CancellationError).reason).toBe("custom reason");
    }
  });

  it("dispose() clears listeners without cancelling", () => {
    const src = new CancellationSource();
    const received: string[] = [];
    src.token.onCancelled((r) => received.push(r));
    src.dispose();
    src.cancel("after dispose");
    // Token is cancelled but no listeners remain to fire
    expect(src.isCancelled).toBe(true);
    expect(received).toHaveLength(0);
  });
});

// ============================================================================
// CancellationError
// ============================================================================

describe("CancellationError", () => {
  it("is an instance of Error", () => {
    expect(new CancellationError()).toBeInstanceOf(Error);
  });

  it("has name CancellationError", () => {
    expect(new CancellationError().name).toBe("CancellationError");
  });

  it("default reason is present", () => {
    const e = new CancellationError();
    expect(e.reason).toBeTruthy();
    expect(e.message).toBeTruthy();
  });

  it("custom reason is preserved", () => {
    const e = new CancellationError("timeout fired");
    expect(e.reason).toBe("timeout fired");
    expect(e.message).toBe("timeout fired");
  });
});

// ============================================================================
// TimeoutManager
// ============================================================================

describe("TimeoutManager", () => {
  it("cancels the source after the deadline", async () => {
    const src = new CancellationSource();
    const timer = new TimeoutManager(src, 30, "deadline");
    await new Promise((r) => setTimeout(r, 60));
    expect(src.isCancelled).toBe(true);
    expect(src.token.cancellationReason).toBe("deadline");
    expect(timer.fired).toBe(true);
    timer.dispose(); // no-op
  });

  it("dispose() prevents firing", async () => {
    const src = new CancellationSource();
    const timer = new TimeoutManager(src, 100, "late");
    timer.dispose();
    await new Promise((r) => setTimeout(r, 150));
    expect(src.isCancelled).toBe(false);
    expect(timer.fired).toBe(false);
  });

  it("timeoutMs=0 never fires", async () => {
    const src = new CancellationSource();
    const timer = new TimeoutManager(src, 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(src.isCancelled).toBe(false);
    expect(timer.fired).toBe(false);
    timer.dispose();
  });

  it("fired === false before deadline", () => {
    const src = new CancellationSource();
    const timer = new TimeoutManager(src, 5000);
    expect(timer.fired).toBe(false);
    timer.dispose();
  });
});

// ============================================================================
// withTimeout()
// ============================================================================

describe("withTimeout()", () => {
  it("resolves the operation when it completes before timeout", async () => {
    const result = await withTimeout(async () => "done", { timeoutMs: 1000 });
    expect(result).toBe("done");
  });

  it("rejects with CancellationError when timeout fires", async () => {
    await expect(
      withTimeout(
        async (token) => {
          // Block until cancelled (poll every ms)
          await new Promise<void>((_resolve, reject) => {
            const interval = setInterval(() => {
              if (token.isCancelled) {
                clearInterval(interval);
                reject(
                  new CancellationError(token.cancellationReason ?? "timeout"),
                );
              }
            }, 1);
          });
          return "late";
        },
        { timeoutMs: 30, timeoutReason: "timed out" },
      ),
    ).rejects.toThrow(CancellationError);
  });

  it("rejects with CancellationError when parent token is cancelled", async () => {
    const parent = new CancellationSource();
    const p = withTimeout(
      async (token) => {
        await new Promise<void>((_resolve, reject) => {
          const unsub = token.onCancelled((r) => {
            unsub();
            reject(new CancellationError(r));
          });
        });
      },
      { parentToken: parent.token },
    );
    setTimeout(() => parent.cancel("parent cancelled"), 20);
    await expect(p).rejects.toThrow(CancellationError);
  });

  it("resolves without timeout when timeoutMs is 0", async () => {
    const result = await withTimeout(async () => 42, { timeoutMs: 0 });
    expect(result).toBe(42);
  });
});

// ============================================================================
// withRetry()
// ============================================================================

describe("withRetry()", () => {
  it("returns result on first success", async () => {
    const op = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(op, { maxRetries: 3 });
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and succeeds on second attempt", async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      if (calls < 2) throw new Error("ECONNREFUSED temporary");
      return "success";
    };
    const result = await withRetry(op, {
      maxRetries: 3,
      initialDelayMs: 1,
      isRetryable: () => true,
    });
    expect(result).toBe("success");
    expect(calls).toBe(2);
  });

  it("exhausts maxRetries and rethrows last error", async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      throw new Error(`fail-${calls}`);
    };
    await expect(
      withRetry(op, {
        maxRetries: 2,
        initialDelayMs: 1,
        isRetryable: () => true,
      }),
    ).rejects.toThrow("fail-3");
    expect(calls).toBe(3); // initial + 2 retries
  });

  it("does not retry when isRetryable returns false", async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      throw new Error("Permission denied");
    };
    await expect(
      withRetry(op, {
        maxRetries: 5,
        initialDelayMs: 1,
        isRetryable: () => false,
      }),
    ).rejects.toThrow("Permission denied");
    expect(calls).toBe(1);
  });

  it("never retries CancellationError", async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      throw new CancellationError("cancelled mid-op");
    };
    await expect(
      withRetry(op, { maxRetries: 5, initialDelayMs: 1 }),
    ).rejects.toThrow(CancellationError);
    expect(calls).toBe(1);
  });

  it("stops retrying when token is cancelled between retries", async () => {
    const src = new CancellationSource();
    let calls = 0;
    const op = async () => {
      calls++;
      throw new Error("ECONNREFUSED retry-me");
    };
    const observer = vi.fn(
      (_attempt: {
        attempt: number;
        maxRetries: number;
        delayMs: number;
        error: unknown;
      }) => {
        if (calls >= 2) src.cancel("stopped");
      },
    );
    await expect(
      withRetry(
        op,
        { maxRetries: 10, initialDelayMs: 1, isRetryable: () => true },
        src.token,
        observer,
      ),
    ).rejects.toThrow(CancellationError);
    expect(calls).toBeLessThan(10);
  });

  it("calls observer with correct attempt metadata", async () => {
    const observations: Array<{ attempt: number; maxRetries: number }> = [];
    let calls = 0;
    const op = async () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return "ok";
    };
    await withRetry(
      op,
      { maxRetries: 5, initialDelayMs: 1, isRetryable: () => true },
      undefined,
      (a) =>
        observations.push({ attempt: a.attempt, maxRetries: a.maxRetries }),
    );
    expect(observations[0]!.attempt).toBe(1);
    expect(observations[1]!.attempt).toBe(2);
    expect(observations.every((o) => o.maxRetries === 5)).toBe(true);
  });
});

// ============================================================================
// isTransientError()
// ============================================================================

describe("isTransientError()", () => {
  const transient = [
    new Error("ECONNREFUSED 127.0.0.1:11434"),
    new Error("ECONNRESET: connection reset by peer"),
    new Error("ETIMEDOUT: operation timed out"),
    new Error("socket hang up"),
    new Error("network unreachable"),
    new Error("503 Service Unavailable"),
    new Error("502 Bad Gateway"),
    new Error("Ollama server not responding"),
    new Error("timed out after 30000ms"),
    "ENOTFOUND hostname.local",
  ];

  for (const err of transient) {
    it(`classifies as transient: ${err instanceof Error ? err.message : err}`, () => {
      expect(isTransientError(err)).toBe(true);
    });
  }

  const permanent = [
    new CancellationError("stopped"),
    new Error("Permission denied: /etc/passwd"),
    new Error("Access denied: insufficient privileges"),
    new Error("401 Unauthorized"),
    new Error("Invalid API key provided"),
    new Error("workspace escape attempt detected"),
    new Error("path traversal detected: ../../../etc"),
    new Error("quota exceeded: daily limit"),
    new Error("rate limit: 429 Too Many Requests"),
    new Error("Invalid argument: model not found"),
    new Error("workspace boundary violated"),
  ];

  for (const err of permanent) {
    it(`classifies as NOT transient: ${err instanceof Error ? err.message : err}`, () => {
      expect(isTransientError(err)).toBe(false);
    });
  }

  it("treats unknown string errors as non-transient", () => {
    expect(isTransientError("something unexpected")).toBe(false);
  });

  it("treats non-Error objects as non-transient", () => {
    expect(isTransientError(42)).toBe(false);
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });
});

// ============================================================================
// Integration: CancellationSource + TimeoutManager + withRetry
// ============================================================================

describe("Integration: timeout + retry cooperation", () => {
  it("timeout fires during retry backoff and rejects", async () => {
    const src = new CancellationSource();
    // 30ms timeout is shorter than the cumulative retries (3 * 50ms = 150ms)
    const timer = new TimeoutManager(src, 30, "timeout fired");

    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new Error("ECONNREFUSED");
        },
        { maxRetries: 5, initialDelayMs: 50, isRetryable: () => true },
        src.token,
      ),
    ).rejects.toThrow(CancellationError);

    timer.dispose();
    expect(attempts).toBeLessThan(5);
  });

  it("successful operation before timeout resolves normally", async () => {
    const src = new CancellationSource();
    const timer = new TimeoutManager(src, 5000);

    const result = await withRetry(
      async () => "fast",
      { maxRetries: 3 },
      src.token,
    );
    timer.dispose();

    expect(result).toBe("fast");
    expect(src.isCancelled).toBe(false);
  });
});
