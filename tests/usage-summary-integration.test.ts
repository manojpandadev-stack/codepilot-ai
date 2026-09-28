/**
 * Phase 3 — `usage/summary` round-trip through the REAL host handler.
 *
 * The message type and host cases existed with no consumer at all (FEATURE
 * GAP rows 6/44). This proves the full loop: WebView request → extension
 * dispatcher → UsageLedger summary/recent → reply → normalizeUsageSummary.
 *
 * Honesty invariant under test: a fresh (unpriced/empty) ledger reports
 * pricingCoverage "none", and the normalizer turns the host's $0 into NULL —
 * the UI can never render a fabricated $0.00.
 */

import { afterEach, describe, expect, it } from "vitest";
import { freshHost, type FreshHost } from "./vscode-integration-harness";
import {
  normalizeUsageSummary,
  validateUsageAction,
} from "../apps/webview/src/lib/messages.js";

interface CapturedMessage {
  type: string;
  payload?: Record<string, unknown>;
}

const hosts: Array<{ host: FreshHost; captured: CapturedMessage[] }> = [];

async function trackedHost(): Promise<{
  host: FreshHost;
  captured: CapturedMessage[];
}> {
  const host = await freshHost();
  const captured: CapturedMessage[] = [];
  host.ext.__setWebviewSinkForIntegrationTest((m) => {
    captured.push(m as CapturedMessage);
  });
  const entry = { host, captured };
  hosts.push(entry);
  return entry;
}

async function send(
  host: FreshHost,
  type: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await host.seams.handleMessage({
    type: type as never,
    id: `usage-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    payload,
    timestamp: Date.now(),
  } as never);
}

afterEach(async () => {
  while (hosts.length > 0) {
    const { host } = hosts.pop()!;
    host.ext.__clearWebviewSinkForIntegrationTest();
    await host.ext.deactivate().catch(() => {});
    host.cleanup();
  }
});

describe("usage/summary round-trip", () => {
  it("replies to usage/summary with a normalizable summary (empty → cost null)", async () => {
    const { host, captured } = await trackedHost();
    await send(host, "usage/summary", {});

    const replies = captured.filter((m) => m.type === "usage/summary");
    expect(replies).toHaveLength(1);
    const normalized = normalizeUsageSummary(replies[0]!.payload);
    expect(normalized).not.toBeNull();
    // Fresh host: no records → honest "none" coverage and NULL cost.
    expect(normalized!.summary.totalRequests).toBe(0);
    expect(normalized!.summary.pricingCoverage).toBe("none");
    expect(normalized!.summary.totalEstimatedCostUsd).toBeNull();
    expect(normalized!.recent).toEqual([]);
  });

  it("usage/clear replies with a summary-only payload that still normalizes", async () => {
    const { host, captured } = await trackedHost();
    await send(host, "usage/summary", {});
    await send(host, "usage/clear", {});

    const replies = captured.filter((m) => m.type === "usage/summary");
    expect(replies.length).toBeGreaterThanOrEqual(2);
    const normalized = normalizeUsageSummary(replies.at(-1)!.payload);
    expect(normalized).not.toBeNull();
    expect(normalized!.summary.totalRequests).toBe(0);
    expect(normalized!.recent).toEqual([]); // clear reply omits recent
  });

  it("the outbound request passes the WebView usage allowlist", () => {
    expect(validateUsageAction("usage/summary").ok).toBe(true);
    expect(validateUsageAction("usage/clear").ok).toBe(true);
    expect(validateUsageAction("usage/anything-else").ok).toBe(false);
  });
});
