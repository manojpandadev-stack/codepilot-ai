/**
 * ToolAuditLogger tests: record shape, ring-buffer bound, queries and
 * secret redaction.
 */
import { describe, expect, it } from "vitest";
import { ToolAuditLogger, redactSecrets } from "./audit-logger.js";
import type { ToolExecutionStatus } from "./lifecycle.js";

function entry(overrides = {}): Parameters<ToolAuditLogger["record"]>[0] {
  return {
    executionId: "exec-1",
    toolId: "write_file",
    sessionId: "sess-1",
    taskId: "task-1",
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    status: "completed" as ToolExecutionStatus,
    permissionDecision: "approved_once",
    errorCategory: undefined,
    retries: 0,
    ...overrides,
  };
}

describe("ToolAuditLogger", () => {
  it("records and returns entries", () => {
    const log = new ToolAuditLogger();
    log.record(entry());
    expect(log.size()).toBe(1);
    const list = log.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.toolId).toBe("write_file");
  });

  it("bounded to maxEntries", () => {
    const log = new ToolAuditLogger({ maxEntries: 10 });
    for (let i = 0; i < 25; i++) log.record(entry({ executionId: `e${i}` }));
    expect(log.size()).toBeLessThanOrEqual(10);
  });

  it("queries by execution id", () => {
    const log = new ToolAuditLogger();
    log.record(entry({ executionId: "a" }));
    log.record(entry({ executionId: "b" }));
    expect(log.forExecution("a")).toHaveLength(1);
    expect(log.forExecution("zz")).toHaveLength(0);
  });

  it("clear() empties the log", () => {
    const log = new ToolAuditLogger();
    log.record(entry());
    log.clear();
    expect(log.size()).toBe(0);
  });

  it("redacts secret-looking values from recorded decision fields", () => {
    const log = new ToolAuditLogger();
    log.record(
      entry({
        permissionDecision: "key=sk-abcdefghijklmnop secret=supersecret123",
      }),
    );
    const recorded = log.list()[0]?.permissionDecision ?? "";
    expect(recorded).not.toContain("sk-abcdefghijklmnop");
    expect(recorded).toContain("[REDACTED]");
  });
});

describe("redactSecrets", () => {
  it("redacts API keys, bearer tokens, GitHub tokens and PEM blocks", () => {
    const input = [
      "apiKey=sk-abcdefghijklmnop",
      "Authorization: Bearer tok-123456789012",
      "ghp_12345678901234567890",
      "password=hunter2",
      "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
      "clean text",
    ].join(" ");
    const out = redactSecrets(input);
    expect(out).not.toContain("sk-abcdefghijklmnop");
    expect(out).not.toContain("tok-123456789012");
    expect(out).not.toContain("ghp_12345678901234567890");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(out).toContain("clean text");
  });
});
