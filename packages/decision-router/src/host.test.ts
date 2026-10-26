import { describe, expect, it, vi } from "vitest";
import { FallbackIntentRouter } from "./fallback.js";
import {
  resolveTurnRouting,
  type JevHostDeps,
  type TurnRoutingInput,
} from "./host.js";
import { uncertainDecision, type RoutingDecision } from "./intent.js";
import { RoutingMetrics } from "./metrics.js";
import type { IntentRouter } from "./router.js";

const SETTINGS = {
  enabled: true,
  assist: false,
  model: "jev-latest",
  timeoutMs: 1000,
  confidenceThreshold: 0.5,
  privacyMode: "cloud",
};

function cannedRouter(decision: RoutingDecision): IntentRouter {
  return {
    name: "mock-jev",
    classify: async () => ({ ...decision }),
  };
}

function depsWith(
  remote: IntentRouter | null,
  overrides?: Partial<JevHostDeps>,
): JevHostDeps {
  return {
    settings: { ...SETTINGS },
    createRemoteRouter: () => remote,
    fallback: new FallbackIntentRouter(),
    metrics: new RoutingMetrics(),
    ...overrides,
  };
}

const INPUT: TurnRoutingInput = {
  requestId: "req-1",
  text: "Fix the TypeError when clicking submit",
  mode: "act",
};

describe("resolveTurnRouting", () => {
  it("returns null when disabled (existing behavior untouched)", async () => {
    const remote = cannedRouter({
      intent: "debug_error",
      complexity: 1,
      confidence: 0.9,
      source: "jev",
    });
    const deps = depsWith(remote, {
      settings: { ...SETTINGS, enabled: false },
    });
    const onStatus = vi.fn();
    const r = await resolveTurnRouting({ ...deps, onStatus }, INPUT, new Map());
    expect(r).toBeNull();
    expect(onStatus).not.toHaveBeenCalled();
    expect(deps.metrics.summary().attempts).toBe(0);
  });

  it("uses the fallback locally under Local Only (no remote call)", async () => {
    const classify = vi.fn(async () => uncertainDecision("unavailable", 1));
    const deps = depsWith(
      { name: "mock-jev", classify },
      { settings: { ...SETTINGS, privacyMode: "local" } },
    );
    const r = await resolveTurnRouting(deps, INPUT, new Map());
    expect(r).not.toBeNull();
    expect(r!.remote).toBe(false);
    expect(r!.decision.source).toBe("fallback");
    expect(r!.decision.intent).toBe("debug_error");
    expect(classify).not.toHaveBeenCalled();
    expect(deps.metrics.summary().fallbackUsed).toBe(1);
  });

  it("falls back locally when no key is stored", async () => {
    const deps = depsWith(null);
    const r = await resolveTurnRouting(deps, INPUT, new Map());
    expect(r?.decision.source).toBe("fallback");
    expect(r?.remote).toBe(false);
  });

  it("prefers a confident Jev verdict in cloud mode", async () => {
    const remote = cannedRouter({
      intent: "debug_error",
      complexity: 1,
      confidence: 0.9,
      source: "jev",
      modelId: "jev-1.13.0",
      latencyMs: 100,
    });
    const status: string[] = [];
    const deps = depsWith(remote, { onStatus: (m) => status.push(m) });
    const r = await resolveTurnRouting(deps, INPUT, new Map());
    expect(r?.decision.source).toBe("jev");
    expect(r?.remote).toBe(true);
    expect(r?.workflow).toBe("debug");
    expect(r?.assistMode).toBeNull();
    expect(deps.metrics.summary().jevSuccess).toBe(1);
    expect(status.length).toBe(1);
    expect(status[0]).toMatch(/debug_error/);
  });

  it("falls back when Jev is uncertain", async () => {
    const remote = cannedRouter(uncertainDecision("low-confidence", 50));
    const deps = depsWith(remote);
    const r = await resolveTurnRouting(deps, INPUT, new Map());
    expect(r?.decision.source).toBe("fallback");
    expect(r?.remote).toBe(false);
    expect(deps.metrics.summary().fallbackUsed).toBe(1);
  });

  it("records timeouts when the remote call times out", async () => {
    const remote = cannedRouter(uncertainDecision("timeout", 1000));
    const deps = depsWith(remote);
    const r = await resolveTurnRouting(deps, INPUT, new Map());
    expect(r?.decision.source).toBe("fallback");
    expect(deps.metrics.summary().timeouts).toBe(1);
  });

  it("dedupes concurrent requests for the same turn", async () => {
    let calls = 0;
    const remote: IntentRouter = {
      name: "mock-jev",
      classify: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return {
          intent: "explain_code",
          complexity: 0,
          confidence: 0.9,
          source: "jev" as const,
        };
      },
    };
    const deps = depsWith(remote);
    const inflight = new Map();
    const [a, b] = await Promise.all([
      resolveTurnRouting(deps, INPUT, inflight),
      resolveTurnRouting(deps, INPUT, inflight),
    ]);
    expect(calls).toBe(1);
    expect(a?.decision.intent).toBe("explain_code");
    expect(b?.decision.intent).toBe("explain_code");
    expect(deps.metrics.summary().attempts).toBe(1);
  });

  it("discards late results for cancelled turns", async () => {
    const remote = cannedRouter({
      intent: "debug_error",
      complexity: 1,
      confidence: 0.9,
      source: "jev",
    });
    const deps = depsWith(remote, { isCancelled: () => true });
    const r = await resolveTurnRouting(deps, INPUT, new Map());
    expect(r).toBeNull();
    expect(deps.metrics.summary().cancelled).toBe(1);
  });

  it("never throws on router failures", async () => {
    const remote: IntentRouter = {
      name: "exploding",
      classify: async () => {
        throw new Error("transport exploded");
      },
    };
    // Fallback still runs locally after the remote throw.
    const deps = depsWith(remote);
    const r = await resolveTurnRouting(deps, INPUT, new Map());
    // The remote throw propagates out of classify (not an operational
    // uncertain) — resolveTurnRoutingInner has no catch, so the outer
    // wrapper converts it to null: the turn proceeds by default behavior.
    expect(r).toBeNull();
  });
});
