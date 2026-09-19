/**
 * M12 integration — TaskStore-driven persistence in the live extension path.
 *
 * Proves the exact store semantics the extension host relies on:
 * - create → appendMessage → update (status + agentState correlation)
 * - restart simulation: markInterruptedOnStartup flips running → interrupted
 * - resume correlation: a task whose agentState.sessionId matches a runtime
 *   session id is findable via list()
 * - corrupt files are quarantined, never crash listing
 * - secret-shaped values never reach disk in plaintext
 *
 * These are the guarantees the extension's session/resume handler depends on.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { TaskStore } from "../packages/agent-runtime/src/m12-task-store";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-m12-ext-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("M12 extension-side TaskStore integration", () => {
  it("persists a task with real conversation state and model config", async () => {
    const store = new TaskStore(dir);
    const task = await store.create("Fix failing test", {
      providerId: "ollama",
      modelId: "qwen3:8b",
      mode: "act",
    });
    expect(task.status).toBe("running");

    await store.appendMessage(
      task.id,
      "user",
      "Fix the failing test in foo.ts",
    );
    await store.appendMessage(
      task.id,
      "assistant",
      "Edited foo.ts and reran tests — green.",
    );

    // Simulate the extension correlating sessionId with the task.
    await store.update(task.id, {
      agentState: { sessionId: "sess-abc", mode: "act" },
    });

    const loaded = await store.get(task.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.messages).toHaveLength(2);
    expect(loaded!.messages[0]!.role).toBe("user");
    expect(loaded!.messages[1]!.content).toContain("green");
    expect((loaded!.agentState as Record<string, unknown>).sessionId).toBe(
      "sess-abc",
    );
    expect(loaded!.modelConfig?.providerId).toBe("ollama");
  });

  it("restart simulation: running tasks become interrupted, resume finds them by sessionId", async () => {
    const store = new TaskStore(dir);
    const a = await store.create("Long refactor");
    const b = await store.create("Small fix");
    await store.update(b.id, { status: "completed" });

    // Extension host dies and restarts.
    const interrupted = await store.markInterruptedOnStartup();
    expect(interrupted).toBe(1);

    const afterRestart = await store.get(a.id);
    expect(afterRestart!.status).toBe("interrupted");

    // Resume handler: find by sessionId correlation, exclude completed/archived.
    await store.update(a.id, { agentState: { sessionId: "sess-xyz" } });
    const tasks = await store.list();
    const resumable = tasks.find(
      (t) =>
        t.status !== "completed" &&
        t.status !== "archived" &&
        (t.agentState as Record<string, unknown> | undefined)?.sessionId ===
          "sess-xyz",
    );
    expect(resumable?.id).toBe(a.id);
  });

  it("corrupt task files are quarantined and never break listing", async () => {
    const store = new TaskStore(dir);
    await store.create("healthy");
    fs.writeFileSync(path.join(dir, "task-broken.json"), "{ not json", "utf8");

    const tasks = await store.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe("healthy");
    expect(fs.existsSync(path.join(dir, "task-broken.json.corrupt"))).toBe(
      true,
    );
  });

  it("never persists secret-shaped values in plaintext", async () => {
    const store = new TaskStore(dir);
    const task = await store.create("secret check", {
      apiKey: "sk-live-abcdefghijklmnop1234",
    });
    await store.appendMessage(
      task.id,
      "user",
      "my key is ghp_abcdefghij1234567890 keep it safe",
    );

    const raw = fs.readFileSync(path.join(dir, `${task.id}.json`), "utf8");
    expect(raw).not.toContain("sk-live-abcdefghijklmnop1234");
    expect(raw).not.toContain("ghp_abcdefghij1234567890");
    expect(raw).toContain("[REDACTED]");
  });
});
