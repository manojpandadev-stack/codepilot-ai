/**
 * AgentStateMachine — comprehensive regression tests
 *
 * Covers:
 *  - All 11 states reachable via valid paths
 *  - Every valid transition in the graph
 *  - Every invalid transition throws InvalidStateTransitionError
 *  - Terminal states are sealed
 *  - cancel() works from every cancellable state
 *  - cancel() is idempotent on terminal states
 *  - No duplicate state-change events
 *  - reset() only allowed from terminal states
 *  - Subscriber receives events; unsubscribe stops delivery
 *  - History is built correctly
 *  - canTransitionTo() predicate is accurate
 *  - stateMachineStateToRuntimeStatus() backward-compat mapper
 *  - isTerminalState() and isCancellableState() helpers
 */

import { describe, it, expect, vi } from "vitest";
import {
  AgentStateMachine,
  InvalidStateTransitionError,
  isTerminalState,
  isCancellableState,
  stateMachineStateToRuntimeStatus,
} from "./state-machine.js";
import type { AgentState, StateTransitionEvent } from "./state-machine.js";

// ============================================================================
// Helpers
// ============================================================================

function makeMachine(initial: AgentState = "CREATED"): AgentStateMachine {
  return new AgentStateMachine(initial);
}

/** Drive machine to EXECUTING via the happy path. */
function toExecuting(): AgentStateMachine {
  const m = makeMachine();
  m.transition("INITIALIZING");
  m.transition("PLANNING");
  m.transition("EXECUTING");
  return m;
}

/** Collect all transition events emitted by a machine. */
function collectEvents(m: AgentStateMachine): StateTransitionEvent[] {
  const events: StateTransitionEvent[] = [];
  m.subscribe((e) => events.push({ ...e }));
  return events;
}

// ============================================================================
// 1 — Initial state
// ============================================================================

describe("Initial state", () => {
  it("starts in CREATED", () => {
    expect(makeMachine().state).toBe("CREATED");
  });

  it("accepts a custom initial state", () => {
    expect(makeMachine("EXECUTING").state).toBe("EXECUTING");
  });

  it("is not terminal by default", () => {
    expect(makeMachine().isTerminal).toBe(false);
  });

  it("CREATED is not in the cancellable set", () => {
    // CREATED → CANCELLED is valid but not via cancel() which checks CANCELLABLE_STATES
    expect(makeMachine().isCancellable).toBe(false);
  });
});

// ============================================================================
// 2 — Valid transitions along the happy path
// ============================================================================

describe("Happy-path transitions", () => {
  it("CREATED → INITIALIZING", () => {
    const m = makeMachine();
    m.transition("INITIALIZING");
    expect(m.state).toBe("INITIALIZING");
  });

  it("INITIALIZING → PLANNING", () => {
    const m = makeMachine("INITIALIZING");
    m.transition("PLANNING");
    expect(m.state).toBe("PLANNING");
  });

  it("PLANNING → EXECUTING", () => {
    const m = makeMachine("PLANNING");
    m.transition("EXECUTING");
    expect(m.state).toBe("EXECUTING");
  });

  it("EXECUTING → RUNNING_TOOL → EXECUTING (tool done)", () => {
    const m = toExecuting();
    m.transition("RUNNING_TOOL");
    expect(m.state).toBe("RUNNING_TOOL");
    m.transition("EXECUTING");
    expect(m.state).toBe("EXECUTING");
  });

  it("EXECUTING → WAITING_FOR_APPROVAL → EXECUTING (approved)", () => {
    const m = toExecuting();
    m.transition("WAITING_FOR_APPROVAL");
    m.transition("EXECUTING");
    expect(m.state).toBe("EXECUTING");
  });

  it("EXECUTING → VALIDATING → COMPLETED", () => {
    const m = toExecuting();
    m.transition("VALIDATING");
    m.transition("COMPLETED");
    expect(m.state).toBe("COMPLETED");
  });

  it("EXECUTING → VALIDATING → HEALING → EXECUTING (re-run after heal)", () => {
    const m = toExecuting();
    m.transition("VALIDATING");
    m.transition("HEALING");
    m.transition("EXECUTING");
    expect(m.state).toBe("EXECUTING");
  });

  it("EXECUTING → HEALING → FAILED (max attempts)", () => {
    const m = toExecuting();
    m.transition("HEALING");
    m.transition("FAILED");
    expect(m.state).toBe("FAILED");
  });

  it("EXECUTING → COMPLETED", () => {
    const m = toExecuting();
    m.transition("COMPLETED");
    expect(m.state).toBe("COMPLETED");
  });

  it("EXECUTING → FAILED", () => {
    const m = toExecuting();
    m.transition("FAILED");
    expect(m.state).toBe("FAILED");
  });

  it("PLANNING → COMPLETED (plan-only mode)", () => {
    const m = makeMachine("PLANNING");
    m.transition("COMPLETED");
    expect(m.state).toBe("COMPLETED");
  });

  it("INITIALIZING → FAILED", () => {
    const m = makeMachine("INITIALIZING");
    m.transition("FAILED");
    expect(m.state).toBe("FAILED");
  });
});

// ============================================================================
// 3 — All states are reachable
// ============================================================================

describe("All 11 states reachable", () => {
  const reachable: AgentState[] = [
    "CREATED",
    "INITIALIZING",
    "PLANNING",
    "EXECUTING",
    "WAITING_FOR_APPROVAL",
    "RUNNING_TOOL",
    "VALIDATING",
    "HEALING",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
  ];

  for (const state of reachable) {
    it(`${state} is reachable`, () => {
      let m: AgentStateMachine;
      switch (state) {
        case "CREATED":
          m = makeMachine();
          break;
        case "INITIALIZING":
          m = makeMachine("INITIALIZING");
          break;
        case "PLANNING":
          m = makeMachine("PLANNING");
          break;
        case "EXECUTING":
          m = toExecuting();
          break;
        case "WAITING_FOR_APPROVAL":
          m = toExecuting();
          m.transition("WAITING_FOR_APPROVAL");
          break;
        case "RUNNING_TOOL":
          m = toExecuting();
          m.transition("RUNNING_TOOL");
          break;
        case "VALIDATING":
          m = toExecuting();
          m.transition("VALIDATING");
          break;
        case "HEALING":
          m = toExecuting();
          m.transition("HEALING");
          break;
        case "COMPLETED":
          m = toExecuting();
          m.transition("COMPLETED");
          break;
        case "FAILED":
          m = toExecuting();
          m.transition("FAILED");
          break;
        case "CANCELLED":
          m = toExecuting();
          m.transition("CANCELLED");
          break;
      }
      expect(m.state).toBe(state);
    });
  }
});

// ============================================================================
// 4 — Invalid transitions throw
// ============================================================================

describe("Invalid transitions throw InvalidStateTransitionError", () => {
  it("CREATED → EXECUTING (skips INITIALIZING)", () => {
    expect(() => makeMachine().transition("EXECUTING")).toThrow(
      InvalidStateTransitionError,
    );
  });

  it("CREATED → COMPLETED", () => {
    expect(() => makeMachine().transition("COMPLETED")).toThrow(
      InvalidStateTransitionError,
    );
  });

  it("INITIALIZING → EXECUTING (skips PLANNING)", () => {
    expect(() => makeMachine("INITIALIZING").transition("EXECUTING")).toThrow(
      InvalidStateTransitionError,
    );
  });

  it("PLANNING → RUNNING_TOOL", () => {
    expect(() => makeMachine("PLANNING").transition("RUNNING_TOOL")).toThrow(
      InvalidStateTransitionError,
    );
  });

  it("RUNNING_TOOL → COMPLETED (must return to EXECUTING first)", () => {
    const m = toExecuting();
    m.transition("RUNNING_TOOL");
    expect(() => m.transition("COMPLETED")).toThrow(
      InvalidStateTransitionError,
    );
  });

  it("WAITING_FOR_APPROVAL → COMPLETED", () => {
    const m = toExecuting();
    m.transition("WAITING_FOR_APPROVAL");
    expect(() => m.transition("COMPLETED")).toThrow(
      InvalidStateTransitionError,
    );
  });

  it("HEALING → WAITING_FOR_APPROVAL", () => {
    const m = toExecuting();
    m.transition("HEALING");
    expect(() => m.transition("WAITING_FOR_APPROVAL")).toThrow(
      InvalidStateTransitionError,
    );
  });

  it("error has correct from/to properties", () => {
    try {
      makeMachine().transition("EXECUTING");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidStateTransitionError);
      const err = e as InvalidStateTransitionError;
      expect(err.from).toBe("CREATED");
      expect(err.to).toBe("EXECUTING");
    }
  });
});

// ============================================================================
// 5 — Terminal states are sealed
// ============================================================================

describe("Terminal states are sealed", () => {
  const terminals: AgentState[] = ["COMPLETED", "FAILED", "CANCELLED"];

  for (const terminal of terminals) {
    describe(`${terminal}`, () => {
      it("isTerminal === true", () => {
        const m = makeMachine(terminal);
        expect(m.isTerminal).toBe(true);
      });

      it("cannot transition to CREATED", () => {
        const m = makeMachine(terminal);
        expect(() => m.transition("CREATED" as AgentState)).toThrow(
          InvalidStateTransitionError,
        );
      });

      it("cannot transition to EXECUTING", () => {
        const m = makeMachine(terminal);
        expect(() => m.transition("EXECUTING")).toThrow(
          InvalidStateTransitionError,
        );
      });

      it("cannot transition to INITIALIZING", () => {
        const m = makeMachine(terminal);
        expect(() => m.transition("INITIALIZING")).toThrow(
          InvalidStateTransitionError,
        );
      });

      it("canTransitionTo() always false", () => {
        const m = makeMachine(terminal);
        const all: AgentState[] = [
          "CREATED",
          "INITIALIZING",
          "PLANNING",
          "EXECUTING",
          "WAITING_FOR_APPROVAL",
          "RUNNING_TOOL",
          "VALIDATING",
          "HEALING",
          "COMPLETED",
          "FAILED",
          "CANCELLED",
        ];
        for (const s of all) {
          expect(m.canTransitionTo(s)).toBe(false);
        }
      });
    });
  }
});

// ============================================================================
// 6 — cancel() from every cancellable state
// ============================================================================

describe("cancel() from every cancellable state", () => {
  const cancellable: AgentState[] = [
    "INITIALIZING",
    "PLANNING",
    "EXECUTING",
    "WAITING_FOR_APPROVAL",
    "RUNNING_TOOL",
    "VALIDATING",
    "HEALING",
  ];

  for (const from of cancellable) {
    it(`${from} → CANCELLED via cancel()`, () => {
      const m = makeMachine(from);
      const result = m.cancel("test");
      expect(result).toBe(true);
      expect(m.state).toBe("CANCELLED");
      expect(m.isTerminal).toBe(true);
    });
  }

  it("cancel() returns false when already COMPLETED", () => {
    const m = toExecuting();
    m.transition("COMPLETED");
    expect(m.cancel()).toBe(false);
    expect(m.state).toBe("COMPLETED");
  });

  it("cancel() returns false when already FAILED", () => {
    const m = toExecuting();
    m.transition("FAILED");
    expect(m.cancel()).toBe(false);
  });

  it("cancel() returns false when already CANCELLED", () => {
    const m = toExecuting();
    m.cancel();
    expect(m.cancel()).toBe(false);
    expect(m.state).toBe("CANCELLED"); // unchanged
  });

  it("cancel() on CREATED succeeds since CREATED → CANCELLED is a valid transition", () => {
    const m = makeMachine("CREATED");
    const result = m.cancel("cancelled before init");
    expect(result).toBe(true);
    expect(m.state).toBe("CANCELLED");
  });
});

// ============================================================================
// 7 — Subscriber events
// ============================================================================

describe("Subscriber events", () => {
  it("subscriber receives event on transition", () => {
    const m = makeMachine();
    const events = collectEvents(m);
    m.transition("INITIALIZING", "starting up");
    expect(events).toHaveLength(1);
    expect(events[0]!.from).toBe("CREATED");
    expect(events[0]!.to).toBe("INITIALIZING");
    expect(events[0]!.reason).toBe("starting up");
  });

  it("event seq is monotonically increasing", () => {
    const m = makeMachine();
    const events = collectEvents(m);
    m.transition("INITIALIZING");
    m.transition("PLANNING");
    m.transition("EXECUTING");
    expect(events[0]!.seq).toBe(1);
    expect(events[1]!.seq).toBe(2);
    expect(events[2]!.seq).toBe(3);
  });

  it("event timestamp is a positive number", () => {
    const m = makeMachine();
    const events = collectEvents(m);
    m.transition("INITIALIZING");
    expect(events[0]!.timestamp).toBeGreaterThan(0);
  });

  it("unsubscribe stops event delivery", () => {
    const m = makeMachine();
    const events: StateTransitionEvent[] = [];
    const unsub = m.subscribe((e) => events.push({ ...e }));
    m.transition("INITIALIZING");
    unsub();
    m.transition("PLANNING");
    expect(events).toHaveLength(1);
    expect(events[0]!.to).toBe("INITIALIZING");
  });

  it("multiple subscribers each receive events independently", () => {
    const m = makeMachine();
    const a: StateTransitionEvent[] = [];
    const b: StateTransitionEvent[] = [];
    m.subscribe((e) => a.push({ ...e }));
    m.subscribe((e) => b.push({ ...e }));
    m.transition("INITIALIZING");
    m.transition("PLANNING");
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
  });

  it("throwing subscriber does not crash the machine", () => {
    const m = makeMachine();
    m.subscribe(() => {
      throw new Error("listener error");
    });
    expect(() => m.transition("INITIALIZING")).not.toThrow();
    expect(m.state).toBe("INITIALIZING");
  });

  it("no event emitted for same-state idempotent transition", () => {
    // Same-state is a no-op (returns a noop event but doesn't notify)
    const m = toExecuting();
    const events = collectEvents(m);
    // Attempting same state: EXECUTING → EXECUTING is not a valid transition
    // (EXECUTING is not in its own allowed set), so this should throw
    expect(() => m.transition("EXECUTING")).toThrow(
      InvalidStateTransitionError,
    );
    expect(events).toHaveLength(0);
  });
});

// ============================================================================
// 8 — History
// ============================================================================

describe("History", () => {
  it("history is empty on creation", () => {
    expect(makeMachine().history).toHaveLength(0);
  });

  it("records each transition in order", () => {
    const m = makeMachine();
    m.transition("INITIALIZING");
    m.transition("PLANNING");
    m.transition("EXECUTING");
    expect(m.history).toHaveLength(3);
    expect(m.history[0]!.to).toBe("INITIALIZING");
    expect(m.history[1]!.to).toBe("PLANNING");
    expect(m.history[2]!.to).toBe("EXECUTING");
  });

  it("cancel() records in history", () => {
    const m = makeMachine("EXECUTING");
    m.cancel("user stopped");
    const last = m.history[m.history.length - 1];
    expect(last?.to).toBe("CANCELLED");
    expect(last?.reason).toBe("user stopped");
  });
});

// ============================================================================
// 9 — reset()
// ============================================================================

describe("reset()", () => {
  it("resets to CREATED from COMPLETED", () => {
    const m = toExecuting();
    m.transition("COMPLETED");
    m.reset();
    expect(m.state).toBe("CREATED");
    expect(m.isTerminal).toBe(false);
  });

  it("resets to CREATED from FAILED", () => {
    const m = toExecuting();
    m.transition("FAILED");
    m.reset();
    expect(m.state).toBe("CREATED");
  });

  it("resets to CREATED from CANCELLED", () => {
    const m = toExecuting();
    m.cancel();
    m.reset();
    expect(m.state).toBe("CREATED");
  });

  it("clears history on reset", () => {
    const m = toExecuting();
    m.transition("COMPLETED");
    m.reset();
    expect(m.history).toHaveLength(0);
  });

  it("throws when called from non-terminal state", () => {
    const m = toExecuting();
    expect(() => m.reset()).toThrow(/Cannot reset.*non-terminal/);
  });

  it("can run a full second cycle after reset", () => {
    const m = makeMachine();
    m.transition("INITIALIZING");
    m.transition("PLANNING");
    m.transition("EXECUTING");
    m.transition("COMPLETED");
    m.reset();
    // Second cycle
    m.transition("INITIALIZING");
    m.transition("PLANNING");
    m.transition("EXECUTING");
    m.transition("COMPLETED");
    expect(m.state).toBe("COMPLETED");
  });
});

// ============================================================================
// 10 — canTransitionTo()
// ============================================================================

describe("canTransitionTo()", () => {
  it("returns true for valid next states", () => {
    const m = makeMachine();
    expect(m.canTransitionTo("INITIALIZING")).toBe(true);
    expect(m.canTransitionTo("CANCELLED")).toBe(true);
  });

  it("returns false for invalid next states", () => {
    const m = makeMachine();
    expect(m.canTransitionTo("EXECUTING")).toBe(false);
    expect(m.canTransitionTo("COMPLETED")).toBe(false);
  });

  it("returns false from terminal state for everything", () => {
    const m = makeMachine("COMPLETED");
    expect(m.canTransitionTo("CREATED")).toBe(false);
    expect(m.canTransitionTo("EXECUTING")).toBe(false);
  });
});

// ============================================================================
// 11 — stateMachineStateToRuntimeStatus() backward-compat mapper
// ============================================================================

describe("stateMachineStateToRuntimeStatus()", () => {
  it("maps CREATED to idle", () => {
    expect(stateMachineStateToRuntimeStatus("CREATED")).toBe("idle");
  });

  it("maps COMPLETED to idle", () => {
    expect(stateMachineStateToRuntimeStatus("COMPLETED")).toBe("idle");
  });

  it("maps CANCELLED to idle", () => {
    expect(stateMachineStateToRuntimeStatus("CANCELLED")).toBe("idle");
  });

  it("maps FAILED to failed", () => {
    expect(stateMachineStateToRuntimeStatus("FAILED")).toBe("failed");
  });

  const activeStates: AgentState[] = [
    "INITIALIZING",
    "PLANNING",
    "EXECUTING",
    "WAITING_FOR_APPROVAL",
    "RUNNING_TOOL",
    "VALIDATING",
    "HEALING",
  ];

  for (const s of activeStates) {
    it(`maps ${s} to running`, () => {
      expect(stateMachineStateToRuntimeStatus(s)).toBe("running");
    });
  }
});

// ============================================================================
// 12 — isTerminalState() and isCancellableState() helpers
// ============================================================================

describe("isTerminalState()", () => {
  it("returns true for COMPLETED, FAILED, CANCELLED", () => {
    expect(isTerminalState("COMPLETED")).toBe(true);
    expect(isTerminalState("FAILED")).toBe(true);
    expect(isTerminalState("CANCELLED")).toBe(true);
  });

  it("returns false for all non-terminal states", () => {
    const nonTerminal: AgentState[] = [
      "CREATED",
      "INITIALIZING",
      "PLANNING",
      "EXECUTING",
      "WAITING_FOR_APPROVAL",
      "RUNNING_TOOL",
      "VALIDATING",
      "HEALING",
    ];
    for (const s of nonTerminal) {
      expect(isTerminalState(s)).toBe(false);
    }
  });
});

describe("isCancellableState()", () => {
  const cancellable: AgentState[] = [
    "INITIALIZING",
    "PLANNING",
    "EXECUTING",
    "WAITING_FOR_APPROVAL",
    "RUNNING_TOOL",
    "VALIDATING",
    "HEALING",
  ];

  for (const s of cancellable) {
    it(`${s} is cancellable`, () => {
      expect(isCancellableState(s)).toBe(true);
    });
  }

  it("CREATED is not cancellable", () => {
    expect(isCancellableState("CREATED")).toBe(false);
  });

  it("terminal states are not cancellable", () => {
    expect(isCancellableState("COMPLETED")).toBe(false);
    expect(isCancellableState("FAILED")).toBe(false);
    expect(isCancellableState("CANCELLED")).toBe(false);
  });
});

// ============================================================================
// 13 — No duplicate transitions emitted
// ============================================================================

describe("No duplicate state transitions", () => {
  it("each transition fires exactly one event", () => {
    const m = makeMachine();
    const listener = vi.fn();
    m.subscribe(listener);
    m.transition("INITIALIZING");
    m.transition("PLANNING");
    m.transition("EXECUTING");
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("failed transition does not fire event", () => {
    const m = makeMachine();
    const listener = vi.fn();
    m.subscribe(listener);
    try {
      m.transition("EXECUTING");
    } catch {
      // expected
    }
    expect(listener).not.toHaveBeenCalled();
    expect(m.state).toBe("CREATED");
  });
});

// ============================================================================
// 14 — Full lifecycle regression
// ============================================================================

describe("Full lifecycle: happy path", () => {
  it("CREATED → INITIALIZING → PLANNING → EXECUTING → RUNNING_TOOL → EXECUTING → VALIDATING → COMPLETED", () => {
    const m = makeMachine();
    m.transition("INITIALIZING");
    m.transition("PLANNING");
    m.transition("EXECUTING");
    m.transition("RUNNING_TOOL");
    m.transition("EXECUTING");
    m.transition("VALIDATING");
    m.transition("COMPLETED");
    expect(m.state).toBe("COMPLETED");
    expect(m.isTerminal).toBe(true);
    expect(m.history).toHaveLength(7);
  });
});

describe("Full lifecycle: healing path", () => {
  it("EXECUTING → VALIDATING → HEALING → EXECUTING → VALIDATING → COMPLETED", () => {
    const m = toExecuting();
    m.transition("VALIDATING");
    m.transition("HEALING");
    m.transition("EXECUTING");
    m.transition("VALIDATING");
    m.transition("COMPLETED");
    expect(m.state).toBe("COMPLETED");
  });
});

describe("Full lifecycle: cancellation mid-run", () => {
  it("EXECUTING → RUNNING_TOOL → cancel() → CANCELLED", () => {
    const m = toExecuting();
    m.transition("RUNNING_TOOL");
    m.cancel("user stopped it");
    expect(m.state).toBe("CANCELLED");
    expect(m.isTerminal).toBe(true);
  });
});
