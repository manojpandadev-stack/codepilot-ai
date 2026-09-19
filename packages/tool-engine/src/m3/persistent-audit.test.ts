/**
 * PersistentAuditLogger tests: durable append-only JSONL audit sink.
 *
 * Proves: events persist, append order, restart recovery, torn-tail recovery,
 * deterministic rotation, total disk budget, valid JSONL under concurrent
 * record() calls, and redaction of bearer tokens, OpenAI keys, GitHub
 * tokens, PEM material, command secrets, and URL credentials/query strings.
 *
 * Uses an in-memory AuditStorageAdapter — the production node-fs adapter in
 * the extension host implements the same contract (append whole lines,
 * fsync on sync()).
 */

import { describe, expect, it } from "vitest";
import {
  PersistentAuditLogger,
  type AuditStorageAdapter,
  type ToolAuditEntry,
} from "./audit-logger.js";
import type { ToolExecutionStatus } from "./lifecycle.js";

function entry(overrides: Partial<ToolAuditEntry> = {}): ToolAuditEntry {
  return {
    executionId: "exec-1",
    toolId: "execute_command",
    sessionId: "sess-1",
    taskId: "task-1",
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_000_050,
    durationMs: 50,
    status: "completed" as ToolExecutionStatus,
    permissionDecision: "approved",
    errorCategory: undefined,
    retries: 0,
    action: "execute_command",
    risk: "MEDIUM",
    approved: true,
    safeTarget: "npm",
    ...overrides,
  };
}

/** In-memory AuditStorageAdapter with failure injection for tests. */
function makeMemoryAdapter(): AuditStorageAdapter & {
  files: Map<string, string>;
  syncCalls: number;
  failAppends: boolean;
  raw(name: string): string;
} {
  const files = new Map<string, string>();
  let syncCalls = 0;
  const adapter: AuditStorageAdapter & {
    files: Map<string, string>;
    syncCalls: number;
    failAppends: boolean;
    raw(name: string): string;
  } = {
    files,
    syncCalls: 0,
    failAppends: false,
    raw: (name: string) => files.get(name) ?? "",
    directory: () => "/audit",
    readFile: (name: string) => files.get(name) ?? null,
    appendLine: (name: string, line: string) => {
      if (adapter.failAppends) throw new Error("disk exploded");
      files.set(name, (files.get(name) ?? "") + line);
    },
    removeFile: (name: string) => {
      files.delete(name);
    },
    listFiles: () =>
      [...files.entries()].map(([name, content]) => ({
        name,
        size: Buffer.byteLength(content, "utf8"),
      })),
    sync: () => {
      syncCalls += 1;
      adapter.syncCalls = syncCalls;
    },
  };
  return adapter;
}

function parseAll(raw: string): ToolAuditEntry[] {
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as ToolAuditEntry);
}

describe("PersistentAuditLogger — durability", () => {
  it("persists an audit event as one JSONL record with safe metadata", async () => {
    const adapter = makeMemoryAdapter();
    const log = new PersistentAuditLogger(adapter);
    log.record(entry());
    await log.flush();

    const records = parseAll(adapter.raw("tool-audit.jsonl"));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      taskId: "task-1",
      toolId: "execute_command",
      action: "execute_command",
      risk: "MEDIUM",
      permissionDecision: "approved",
      durationMs: 50,
      status: "completed",
      approved: true,
      safeTarget: "npm",
    });
    expect(typeof records[0]!.startedAt).toBe("number");
    await log.dispose();
  });

  it("appends multiple events in record order", async () => {
    const adapter = makeMemoryAdapter();
    const log = new PersistentAuditLogger(adapter);
    log.record(entry({ executionId: "e1", safeTarget: "ls" }));
    log.record(entry({ executionId: "e2", safeTarget: "npm" }));
    log.record(entry({ executionId: "e3", safeTarget: "git" }));
    await log.flush();

    const records = parseAll(adapter.raw("tool-audit.jsonl"));
    expect(records.map((r) => r.executionId)).toEqual(["e1", "e2", "e3"]);
    // In-memory recent cache mirrors the persisted order.
    expect(log.list(10).map((r) => r.executionId)).toEqual(["e1", "e2", "e3"]);
    await log.dispose();
  });

  it("restart recovers records from disk into a fresh instance", async () => {
    const adapter = makeMemoryAdapter();
    const first = new PersistentAuditLogger(adapter);
    first.record(entry({ executionId: "before-restart-1" }));
    first.record(entry({ executionId: "before-restart-2" }));
    await first.dispose();

    // Simulate extension reload: brand-new logger over the same storage.
    const second = new PersistentAuditLogger(adapter);
    const recovered = second.readPersisted(100);
    expect(recovered.map((r) => r.executionId)).toEqual([
      "before-restart-1",
      "before-restart-2",
    ]);
    // Recent-event cache is rebuilt so auditLog() keeps working.
    expect(second.list(100).map((r) => r.executionId)).toEqual([
      "before-restart-1",
      "before-restart-2",
    ]);
    // …and new records append after the recovered ones.
    second.record(entry({ executionId: "after-restart" }));
    await second.flush();
    expect(second.readPersisted(100).map((r) => r.executionId)).toEqual([
      "before-restart-1",
      "before-restart-2",
      "after-restart",
    ]);
    await second.dispose();
  });

  it("a torn (incomplete) final line from a crash is dropped safely", async () => {
    const adapter = makeMemoryAdapter();
    const first = new PersistentAuditLogger(adapter);
    first.record(entry({ executionId: "good-1" }));
    first.record(entry({ executionId: "good-2" }));
    await first.flush();
    // Crash mid-append: partial line with no trailing newline.
    adapter.appendLine("tool-audit.jsonl", '{"executionId": "torn-par');
    await first.dispose();

    const second = new PersistentAuditLogger(adapter);
    const recovered = second.readPersisted(100);
    expect(recovered.map((r) => r.executionId)).toEqual(["good-1", "good-2"]);
    // New appends land on a clean boundary.
    second.record(entry({ executionId: "good-3" }));
    await second.flush();
    expect(second.readPersisted(100).map((r) => r.executionId)).toEqual([
      "good-1",
      "good-2",
      "good-3",
    ]);
    await second.dispose();
  });

  it("rotates deterministically once the file budget is exceeded", async () => {
    const adapter = makeMemoryAdapter();
    const maxFileBytes = 64 * 1024; // class minimum
    const log = new PersistentAuditLogger(adapter, {
      maxFileBytes,
      maxTotalBytes: 10 * 1024 * 1024,
      maxFiles: 4,
    });
    let rotated = false;
    for (let i = 0; i < 3000 && !rotated; i += 1) {
      log.record(entry({ executionId: `r${i}` }));
      if (i % 25 === 24) {
        await log.flush();
        rotated = adapter.files.has("tool-audit.jsonl.1");
      }
    }
    await log.flush();
    expect(adapter.files.has("tool-audit.jsonl.1")).toBe(true);
    // The active segment never exceeds its budget.
    const activeSize = Buffer.byteLength(
      adapter.raw("tool-audit.jsonl"),
      "utf8",
    );
    expect(activeSize).toBeLessThanOrEqual(maxFileBytes);
    // Oldest → newest read order still holds across segments.
    const all = log.readPersisted(5000).map((r) => r.executionId);
    const nums = all.map((id) => Number(id.slice(1)));
    const sorted = [...nums].sort((a, b) => a - b);
    expect(nums).toEqual(sorted);
    await log.dispose();
  });

  it("total disk usage stays bounded and oldest segments are pruned first", async () => {
    const adapter = makeMemoryAdapter();
    const maxFileBytes = 64 * 1024;
    const maxTotalBytes = 64 * 1024;
    const log = new PersistentAuditLogger(adapter, {
      maxFileBytes,
      maxTotalBytes,
      maxFiles: 4,
    });
    for (let i = 0; i < 1500; i += 1) {
      log.record(entry({ executionId: `d${i}` }));
      if (i % 25 === 24) await log.flush();
    }
    await log.flush();
    const files = adapter.listFiles();
    const total = files.reduce((sum, f) => sum + f.size, 0);
    // Bounded: budget + at most one active segment overrun window.
    expect(total).toBeLessThanOrEqual(maxTotalBytes + maxFileBytes);
    expect(files.length).toBeLessThanOrEqual(4);
    // Pruning removed the oldest: the earliest records are gone while the
    // most recent tail survives.
    const surviving = new Set(
      log.readPersisted(10000).map((r) => r.executionId),
    );
    expect(surviving.has("d0")).toBe(false);
    expect(surviving.has("d1499")).toBe(true);
    await log.dispose();
  });

  it("concurrent record() calls remain valid JSONL", async () => {
    const adapter = makeMemoryAdapter();
    const log = new PersistentAuditLogger(adapter);
    // 50 synchronous record() calls — no awaits between them.
    for (let i = 0; i < 50; i += 1) {
      log.record(entry({ executionId: `c${i}` }));
    }
    await log.flush();
    const lines = adapter.raw("tool-audit.jsonl").split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(50);
    const ids = lines.map((l) => (JSON.parse(l) as ToolAuditEntry).executionId);
    expect(ids).toEqual(Array.from({ length: 50 }, (_, i) => `c${i}`));
    await log.dispose();
  });

  it("a failing disk never throws into the caller", async () => {
    const adapter = makeMemoryAdapter();
    const log = new PersistentAuditLogger(adapter);
    adapter.failAppends = true;
    expect(() =>
      log.record(entry({ executionId: "lost" })),
    ).not.toThrow();
    await expect(log.flush()).resolves.toBeUndefined();
    // Recovery: writes resume once the disk is back.
    adapter.failAppends = false;
    log.record(entry({ executionId: "found" }));
    await log.flush();
    expect(parseAll(adapter.raw("tool-audit.jsonl")).map((r) => r.executionId)).toEqual([
      "found",
    ]);
    await log.dispose();
  });
});

describe("PersistentAuditLogger — redaction", () => {
  async function persistedRaw(
    decision: string | undefined,
    target: string | undefined,
  ): Promise<string> {
    const adapter = makeMemoryAdapter();
    const log = new PersistentAuditLogger(adapter);
    log.record(entry({ permissionDecision: decision, safeTarget: target }));
    await log.flush();
    const raw = adapter.raw("tool-audit.jsonl");
    await log.dispose();
    return raw;
  }

  it("redacts bearer tokens", async () => {
    const raw = await persistedRaw(
      "denied: Authorization: Bearer tok-123456789012",
      undefined,
    );
    expect(raw).not.toContain("tok-123456789012");
    expect(raw).toContain("[REDACTED]");
  });

  it("redacts OpenAI-style API keys", async () => {
    const raw = await persistedRaw("key=sk-abcdefghijklmnop", undefined);
    expect(raw).not.toContain("sk-abcdefghijklmnop");
    expect(raw).toContain("[REDACTED]");
  });

  it("redacts GitHub tokens", async () => {
    const raw = await persistedRaw(
      "saw ghp_12345678901234567890 in output",
      undefined,
    );
    expect(raw).not.toContain("ghp_12345678901234567890");
    expect(raw).toContain("[REDACTED]");
  });

  it("redacts PEM/private-key material", async () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIBPAIBAAJBhai\n-----END RSA PRIVATE KEY-----";
    const raw = await persistedRaw(`leaked ${pem} here`, undefined);
    expect(raw).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(raw).not.toContain("MIIBPAIBAAJBhai");
    expect(raw).toContain("[REDACTED]");
  });

  it("redacts command secrets in safe targets", async () => {
    const raw = await persistedRaw(undefined, "run --token=supersecret123");
    expect(raw).not.toContain("supersecret123");
  });

  it("never persists sensitive URL credentials or query data", async () => {
    const raw = await persistedRaw(
      undefined,
      "https://api.example.com/data?api_key=SUPERSECRET&x=1",
    );
    expect(raw).not.toContain("SUPERSECRET");
    // The non-secret part of the target survives.
    expect(raw).toContain("api.example.com");
  });

  it("redacts URL userinfo credentials", async () => {
    const raw = await persistedRaw(
      undefined,
      "fetch https://admin:hunter2@example.com/x failed",
    );
    expect(raw).not.toContain("hunter2");
    expect(raw).toContain("example.com");
  });

  it("leaves clean metadata untouched", async () => {
    const raw = await persistedRaw("approved", "npm");
    expect(raw).toContain("approved");
    expect(raw).toContain("npm");
  });
});
