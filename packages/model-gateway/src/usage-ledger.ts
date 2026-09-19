/**
 * @codepilot/model-gateway — local usage/cost ledger
 *
 * CodePilot-side token & cost accounting. Records what ACTUALLY happened in
 * the live runtime (provider, model, tokens) and ESTIMATES cost from the
 * catalogue's published per-Mtok pricing. Estimated values are always marked
 * as estimates. No API keys are ever accepted or stored here.
 *
 * Storage contract: the host supplies a bounded persistence adapter (VS Code
 * globalState in the extension, in-memory in tests). Records are capped;
 * clearing is explicit.
 */

import { getProviderCatalog } from "./provider-catalog.js";

// ============================================================================
// Types
// ============================================================================

/** One recorded model interaction. Never contains credentials. */
export interface UsageRecord {
  /** Millisecond epoch. */
  ts: number;
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** USD estimate from catalogue pricing (marked as estimate in the UI). */
  estimatedCostUsd?: number;
  /** Correlation with the CodePilot task/session. */
  taskId?: string;
  /**
   * What this usage is FOR — "agent" (normal model turns), "compaction"
   * (context summarization), "health" (provider health checks). Lets the
   * UI/reports separate compaction spend from normal agent spend so summary
   * tokens are never counted as normal agent output.
   */
  reason?: "agent" | "compaction" | "health";
}

export interface UsageSummary {
  /** Sum over all retained records. */
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUsd: number;
  /** Per-provider rollup, sorted by cost desc then tokens desc. */
  byProvider: Array<{
    providerId: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  }>;
  /** True when every record was priced from published catalogue data. */
  pricingCoverage: "full" | "partial" | "none";
}

/** Bounded persistence adapter supplied by the host. */
export interface UsageStore {
  read(): UsageRecord[];
  write(records: UsageRecord[]): void;
}

// ============================================================================
// Configuration
// ============================================================================

/** Maximum retained records (host may pass a smaller cap). */
export const MAX_USAGE_RECORDS = 500;

// ============================================================================
// Ledger
// ============================================================================

export class UsageLedger {
  private records: UsageRecord[];
  private readonly cap: number;

  constructor(
    private readonly store?: UsageStore,
    cap: number = MAX_USAGE_RECORDS,
  ) {
    this.cap = Math.max(1, cap);
    // A corrupt/unavailable store must never prevent the ledger from working.
    try {
      this.records = store?.read() ?? [];
    } catch {
      this.records = [];
    }
    if (!Array.isArray(this.records)) this.records = [];
    if (this.records.length > this.cap) {
      this.records = this.records.slice(this.records.length - this.cap);
    }
  }

  /**
   * Record a real token usage event and estimate cost from the catalogue.
   * Prices are USD per million tokens (CodePilot-owned catalogue data in
   * @codepilot/llm).
   */
  record(input: {
    providerId: string;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    taskId?: string;
    reason?: "agent" | "compaction" | "health";
  }): UsageRecord {
    const rec: UsageRecord = {
      ts: Date.now(),
      providerId: input.providerId,
      modelId: input.modelId,
      inputTokens: Math.max(0, Math.round(input.inputTokens || 0)),
      outputTokens: Math.max(0, Math.round(input.outputTokens || 0)),
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: input.cacheWriteTokens,
      taskId: input.taskId,
      reason: input.reason ?? "agent",
    };
    const price = estimateCost(
      rec.providerId,
      rec.modelId,
      rec.inputTokens,
      rec.outputTokens,
    );
    if (price !== undefined) rec.estimatedCostUsd = price;
    this.records.push(rec);
    if (this.records.length > this.cap) {
      this.records = this.records.slice(this.records.length - this.cap);
    }
    this.persist();
    return rec;
  }

  summary(): UsageSummary {
    const byProvider = new Map<
      string,
      {
        providerId: string;
        requests: number;
        inputTokens: number;
        outputTokens: number;
        estimatedCostUsd: number;
      }
    >();
    let priced = 0;
    for (const r of this.records) {
      let agg = byProvider.get(r.providerId);
      if (!agg) {
        agg = {
          providerId: r.providerId,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
        };
        byProvider.set(r.providerId, agg);
      }
      agg.requests += 1;
      agg.inputTokens += r.inputTokens;
      agg.outputTokens += r.outputTokens;
      agg.estimatedCostUsd += r.estimatedCostUsd ?? 0;
      if (r.estimatedCostUsd !== undefined) priced += 1;
    }
    const pricingCoverage: UsageSummary["pricingCoverage"] =
      this.records.length === 0
        ? "none"
        : priced === this.records.length
          ? "full"
          : priced > 0
            ? "partial"
            : "none";
    return {
      totalRequests: this.records.length,
      totalInputTokens: this.records.reduce((a, r) => a + r.inputTokens, 0),
      totalOutputTokens: this.records.reduce((a, r) => a + r.outputTokens, 0),
      totalEstimatedCostUsd: this.records.reduce(
        (a, r) => a + (r.estimatedCostUsd ?? 0),
        0,
      ),
      byProvider: [...byProvider.values()].sort(
        (a, b) =>
          b.estimatedCostUsd - a.estimatedCostUsd ||
          b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
      ),
      pricingCoverage,
    };
  }

  /** Recent records, newest first, bounded. */
  recent(limit = 50): UsageRecord[] {
    return this.records.slice(-limit).reverse();
  }

  /** Explicitly clear all local usage statistics. */
  clear(): void {
    this.records = [];
    this.persist();
  }

  private persist(): void {
    try {
      this.store?.write(this.records);
    } catch {
      // Persistence failures must never break the agent event pipeline.
    }
  }
}

// ============================================================================
// Cost estimation
// ============================================================================

/**
 * Estimate USD cost for a request from catalogue pricing.
 * Returns undefined when the provider/model has no published pricing —
 * callers must show "estimated cost unavailable", never a fabricated number.
 */
export function estimateCost(
  providerId: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const provider = getProviderCatalog().find((p) => p.id === providerId);
  const model = provider?.models.find((m) => m.id === modelId);
  if (!model) {
    // OpenRouter-style "vendor/model" ids can be matched on suffix.
    const bySuffix = provider?.models.find(
      (m) => modelId.endsWith(m.id) || m.id.endsWith(modelId),
    );
    if (!bySuffix) return undefined;
    return priceWith(bySuffix, inputTokens, outputTokens);
  }
  return priceWith(model, inputTokens, outputTokens);
}

function priceWith(
  model: { inputPerMtok?: number; outputPerMtok?: number },
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  if (model.inputPerMtok === undefined && model.outputPerMtok === undefined) {
    return undefined;
  }
  const input = ((model.inputPerMtok ?? 0) / 1_000_000) * inputTokens;
  const output = ((model.outputPerMtok ?? 0) / 1_000_000) * outputTokens;
  // Round to a tenth of a cent to keep the ledger tidy.
  return Math.round((input + output) * 100_000) / 100_000;
}
