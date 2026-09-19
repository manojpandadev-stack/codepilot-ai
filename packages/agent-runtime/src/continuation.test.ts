/**
 * M12 v5 — continuation selection unit tests: shared builder reuse,
 * compacted-preference rule, trailing incomplete-tool trim, and empty cases.
 */
import { describe, it, expect } from "vitest";
import {
  selectContinuationMessages,
  selectContinuationChain,
  trimTrailingIncompleteToolExchange,
  MAX_TURN_CHAIN_TASKS,
  type ResumeWireMessage,
} from "./resume.js";
import type { PersistedTask } from "./m12-task-store.js";

function taskWith(
  conversation: PersistedTask["conversation"],
  id = "task-test",
): PersistedTask {
  const now = Date.now();
  return {
    id,
    createdAtMs: now,
    updatedAtMs: now,
    status: "completed",
    title: "test",
    messages: [],
    conversation,
    resumeGeneration: 0,
  };
}

describe("trimTrailingIncompleteToolExchange", () => {
  it("keeps text-only and paired tails untouched", () => {
    const messages: ResumeWireMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    expect(trimTrailingIncompleteToolExchange(messages)).toBe(messages);
  });

  it("keeps a complete tool pair (assistant uses + following user results)", () => {
    const messages: ResumeWireMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "c1", name: "read_file", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "c1", name: "read_file", content: "x" }],
      },
    ];
    expect(trimTrailingIncompleteToolExchange(messages)).toBe(messages);
  });

  it("withholds unpaired tool_use but preserves trailing text", () => {
    const messages: ResumeWireMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "working" },
          { type: "tool_use", id: "c9", name: "bash", input: {} },
        ],
      },
    ];
    const trimmed = trimTrailingIncompleteToolExchange(messages);
    expect(trimmed).toHaveLength(2);
    expect(trimmed[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "working" }],
    });
  });

  it("drops a uses-only trailing assistant message entirely", () => {
    const messages: ResumeWireMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "c9", name: "bash", input: {} }],
      },
    ];
    const trimmed = trimTrailingIncompleteToolExchange(messages);
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0]?.role).toBe("user");
  });

  it("handles empty input", () => {
    expect(trimTrailingIncompleteToolExchange([])).toEqual([]);
  });
});

describe("selectContinuationMessages", () => {
  it("returns [] for v1 records (no conversation)", () => {
    expect(selectContinuationMessages(taskWith(undefined))).toEqual([]);
  });

  it("reuses the faithful build for plain history", () => {
    const task = taskWith([
      { role: "user", text: "do it", timestampMs: 1 },
    ]);
    const messages = selectContinuationMessages(task);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user", content: "do it" });
  });

  it("prefers the compacted alternative only when strictly shorter", () => {
    const task = taskWith([
      { role: "user", text: "a", timestampMs: 1 },
      { role: "assistant", text: "b", timestampMs: 2 },
      { role: "user", text: "c", timestampMs: 3 },
    ]);
    const full = selectContinuationMessages(task);
    expect(full.length).toBeGreaterThan(1);
    const shorter: ResumeWireMessage[] = [{ role: "user", content: "summary" }];
    expect(selectContinuationMessages(task, { compacted: shorter })).toEqual(shorter);
    // Equal-or-longer compacted build is ignored (resume rule).
    const longer: ResumeWireMessage[] = [...full, ...full];
    expect(selectContinuationMessages(task, { compacted: longer })).toEqual(full);
    expect(selectContinuationMessages(task, { compacted: [] })).toEqual(full);
    expect(selectContinuationMessages(task, { compacted: null })).toEqual(full);
  });

  it("trims an interrupted tool tail only when asked", () => {
    const task = taskWith([
      { role: "user", text: "run it", timestampMs: 1 },
      {
        role: "assistant",
        timestampMs: 2,
        blocks: [
          { type: "tool_use", id: "cx", name: "bash", input: "{}" },
        ],
      },
    ]);
    // Default (resume behavior): untouched.
    expect(selectContinuationMessages(task)).toHaveLength(2);
    // Per-turn seeding: clean boundary only (uses-only tail dropped).
    const trimmed = selectContinuationMessages(task, { trimIncompleteTail: true });
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0]?.role).toBe("user");
  });
});

describe("selectContinuationChain", () => {
  const userTurn = (text: string, ts: number): PersistedTask =>
    taskWith([{ role: "user", text, timestampMs: ts }]);

  it("returns [] for an empty chain", () => {
    expect(selectContinuationChain([])).toEqual([]);
  });

  it("concatenates per-task histories oldest→newest", () => {
    const chain = selectContinuationChain([userTurn("one", 1), userTurn("two", 2)]);
    expect(chain.map((m) => m.content)).toEqual(["one", "two"]);
  });

  it("skips v1/empty tasks without breaking order", () => {
    const chain = selectContinuationChain([
      userTurn("one", 1),
      taskWith(undefined),
      userTurn("three", 3),
    ]);
    expect(chain.map((m) => m.content)).toEqual(["one", "three"]);
  });

  it("caps the chain tail (context discipline)", () => {
    expect(MAX_TURN_CHAIN_TASKS).toBeGreaterThanOrEqual(2);
    const tasks = Array.from({ length: MAX_TURN_CHAIN_TASKS + 5 }, (_, i) =>
      userTurn(`t${i}`, i),
    );
    const chain = selectContinuationChain(tasks);
    expect(chain.map((m) => m.content)).toEqual(
      Array.from({ length: MAX_TURN_CHAIN_TASKS }, (_, k) => `t${k + 5}`),
    );
    // Explicit smaller cap wins.
    expect(
      selectContinuationChain(tasks, { maxTasks: 2 }).map((m) => m.content),
    ).toEqual([`t${MAX_TURN_CHAIN_TASKS + 3}`, `t${MAX_TURN_CHAIN_TASKS + 4}`]);
  });

  it("applies per-task compacted alternatives", () => {
    const big = taskWith(
      [
        { role: "user", text: "a", timestampMs: 1 },
        { role: "assistant", text: "b", timestampMs: 2 },
        { role: "user", text: "c", timestampMs: 3 },
      ],
      "task-big",
    );
    const small = taskWith([{ role: "user", text: "fresh", timestampMs: 9 }], "task-small");
    const chain = selectContinuationChain([big, small], {
      composeCompacted: (t) =>
        t.id === big.id ? [{ role: "user", content: "big-summary" }] : null,
    });
    expect(chain).toHaveLength(2);
    expect(chain[0]).toMatchObject({ role: "user", content: "big-summary" });
    expect(chain[1]).toMatchObject({ role: "user", content: "fresh" });
  });

  it("tolerates a throwing compacted resolver", () => {
    const chain = selectContinuationChain([userTurn("one", 1)], {
      composeCompacted: () => {
        throw new Error("summarizer down");
      },
    });
    expect(chain.map((m) => m.content)).toEqual(["one"]);
  });

  it("trims intermediate interrupted tails per segment", () => {
    const interrupted = taskWith([
      { role: "user", text: "run it", timestampMs: 1 },
      {
        role: "assistant",
        timestampMs: 2,
        blocks: [{ type: "tool_use", id: "cx", name: "bash", input: "{}" }],
      },
    ]);
    const chain = selectContinuationChain([interrupted, userTurn("next", 3)]);
    // The unpaired use is withheld; surrounding turns stay ordered.
    expect(chain.map((m) => m.content)).toEqual(["run it", "next"]);
  });
});
