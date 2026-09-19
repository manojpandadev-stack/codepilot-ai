/**
 * @codepilot/agent-runtime — AgentStateMachine
 *
 * Explicit typed state machine for the CodePilot agent lifecycle.
 *
 * Valid state transition graph:
 *
 *   CREATED
 *     └─> INITIALIZING
 *           └─> PLANNING
 *                 └─> EXECUTING
 *                       ├─> WAITING_FOR_APPROVAL
 *                       │     └─> EXECUTING  (approved)
 *                       │     └─> CANCELLED  (denied/user cancel)
 *                       ├─> RUNNING_TOOL
 *                       │     └─> EXECUTING  (tool done)
 *                       │     └─> HEALING    (tool failed + heal)
 *                       │     └─> FAILED     (tool failed, no heal)
 *                       ├─> VALIDATING
 *                       │     └─> HEALING    (validation failed)
 *                       │     └─> COMPLETED  (validation passed)
 *                       │     └─> EXECUTING  (re-run after validation)
 *                       ├─> HEALING
 *                       │     └─> EXECUTING  (re-run after repair)
 *                       │     └─> FAILED     (max attempts)
 *                       ├─> COMPLETED
 *                       ├─> FAILED
 *                       └─> CANCELLED
 *
 * Terminal states: COMPLETED, FAILED, CANCELLED
 * Cancellable states: all except terminal states
 */

// ============================================================================
// State types
// ============================================================================

export type AgentState =
  | "CREATED"
  | "INITIALIZING"
  | "PLANNING"
  | "EXECUTING"
  | "WAITING_FOR_APPROVAL"
  | "RUNNING_TOOL"
  | "VALIDATING"
  | "HEALING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

/** Terminal states that must not transition to any active state. */
const TERMINAL_STATES = new Set<AgentState>([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

/** States from which cancellation is permitted. */
const CANCELLABLE_STATES = new Set<AgentState>([
  "INITIALIZING",
  "PLANNING",
  "EXECUTING",
  "WAITING_FOR_APPROVAL",
  "RUNNING_TOOL",
  "VALIDATING",
  "HEALING",
]);

/**
 * The complete set of valid transitions: from → Set<to>.
 * Any transition not listed here is invalid and will throw.
 */
const VALID_TRANSITIONS: ReadonlyMap<
  AgentState,
  ReadonlySet<AgentState>
> = new Map<AgentState, ReadonlySet<AgentState>>([
  ["CREATED", new Set<AgentState>(["INITIALIZING", "CANCELLED"])],
  ["INITIALIZING", new Set<AgentState>(["PLANNING", "FAILED", "CANCELLED"])],
  [
    "PLANNING",
    new Set<AgentState>(["EXECUTING", "COMPLETED", "FAILED", "CANCELLED"]),
  ],
  [
    "EXECUTING",
    new Set<AgentState>([
      "WAITING_FOR_APPROVAL",
      "RUNNING_TOOL",
      "VALIDATING",
      "HEALING",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
    ]),
  ],
  [
    "WAITING_FOR_APPROVAL",
    new Set<AgentState>(["EXECUTING", "CANCELLED", "FAILED"]),
  ],
  [
    "RUNNING_TOOL",
    new Set<AgentState>(["EXECUTING", "HEALING", "FAILED", "CANCELLED"]),
  ],
  [
    "VALIDATING",
    new Set<AgentState>([
      "EXECUTING",
      "HEALING",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
    ]),
  ],
  [
    "HEALING",
    new Set<AgentState>(["EXECUTING", "FAILED", "COMPLETED", "CANCELLED"]),
  ],
  // Terminal states have no outgoing transitions
  ["COMPLETED", new Set<AgentState>()],
  ["FAILED", new Set<AgentState>()],
  ["CANCELLED", new Set<AgentState>()],
]);

// ============================================================================
// Transition event
// ============================================================================

export interface StateTransitionEvent {
  /** Transition sequence number (monotonically increasing per machine instance). */
  seq: number;
  from: AgentState;
  to: AgentState;
  timestamp: number;
  reason?: string;
}

export type StateTransitionListener = (event: StateTransitionEvent) => void;

// ============================================================================
// AgentStateMachine
// ============================================================================

/**
 * Pure typed state machine for the CodePilot agent lifecycle.
 *
 * - Validates every transition before applying it.
 * - Throws `InvalidStateTransitionError` for illegal transitions.
 * - Terminal states are sealed — any further transition attempt throws.
 * - Emits typed `StateTransitionEvent` to all registered listeners.
 * - No dependency on the agent loop or any I/O subsystem.
 */
export class AgentStateMachine {
  private _state: AgentState;
  private _seq = 0;
  private _listeners = new Set<StateTransitionListener>();
  private _history: StateTransitionEvent[] = [];

  constructor(initialState: AgentState = "CREATED") {
    this._state = initialState;
  }

  // ---- Inspection ----

  get state(): AgentState {
    return this._state;
  }

  get isTerminal(): boolean {
    return TERMINAL_STATES.has(this._state);
  }

  get isCancellable(): boolean {
    return CANCELLABLE_STATES.has(this._state);
  }

  /** Full transition history for this machine instance (newest last). */
  get history(): readonly StateTransitionEvent[] {
    return this._history;
  }

  // ---- Transition ----

  /**
   * Attempt a state transition.
   *
   * @throws {InvalidStateTransitionError} when the transition is not in the
   *   valid-transition graph or the current state is terminal.
   */
  transition(to: AgentState, reason?: string): StateTransitionEvent {
    const from = this._state;

    if (TERMINAL_STATES.has(from)) {
      throw new InvalidStateTransitionError(
        from,
        to,
        `Cannot leave terminal state "${from}"`,
      );
    }

    const allowed = VALID_TRANSITIONS.get(from);
    if (!allowed || !allowed.has(to)) {
      throw new InvalidStateTransitionError(
        from,
        to,
        `"${from}" → "${to}" is not a valid transition`,
      );
    }

    // Idempotent same-state transition: no-op, no event.
    if (from === to) {
      const noop: StateTransitionEvent = {
        seq: this._seq,
        from,
        to,
        timestamp: Date.now(),
        reason,
      };
      return noop;
    }

    this._state = to;
    const event: StateTransitionEvent = {
      seq: ++this._seq,
      from,
      to,
      timestamp: Date.now(),
      reason,
    };
    this._history.push(event);
    this._notifyListeners(event);
    return event;
  }

  /**
   * Attempt to transition to CANCELLED from any cancellable state.
   * No-ops silently when already terminal (idempotent for stop-signal propagation).
   *
   * @returns true if cancellation was applied, false if state was already terminal.
   */
  cancel(reason = "Cancelled by user"): boolean {
    if (this.isTerminal) return false;
    if (!this.isCancellable && this._state !== "CREATED") return false;
    this.transition("CANCELLED", reason);
    return true;
  }

  /**
   * Check whether a transition is valid without performing it.
   */
  canTransitionTo(to: AgentState): boolean {
    if (TERMINAL_STATES.has(this._state)) return false;
    const allowed = VALID_TRANSITIONS.get(this._state);
    return allowed?.has(to) ?? false;
  }

  // ---- Subscription ----

  subscribe(listener: StateTransitionListener): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  // ---- Reset ----

  /**
   * Reset to CREATED for reuse (e.g. new task on same runtime instance).
   * Only allowed when current state is terminal.
   *
   * @throws {Error} when called from a non-terminal state.
   */
  reset(): void {
    if (!this.isTerminal) {
      throw new Error(
        `Cannot reset AgentStateMachine from non-terminal state "${this._state}". Cancel or wait for completion first.`,
      );
    }
    this._state = "CREATED";
    this._history = [];
    this._seq = 0;
  }

  // ---- Private ----

  private _notifyListeners(event: StateTransitionEvent): void {
    for (const listener of this._listeners) {
      try {
        listener(event);
      } catch {
        // Listeners must never crash the state machine.
      }
    }
  }
}

// ============================================================================
// Error types
// ============================================================================

export class InvalidStateTransitionError extends Error {
  readonly from: AgentState;
  readonly to: AgentState;

  constructor(from: AgentState, to: AgentState, message: string) {
    super(message);
    this.name = "InvalidStateTransitionError";
    this.from = from;
    this.to = to;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** True when `state` is a terminal state (COMPLETED | FAILED | CANCELLED). */
export function isTerminalState(state: AgentState): boolean {
  return TERMINAL_STATES.has(state);
}

/** True when `state` supports cancellation. */
export function isCancellableState(state: AgentState): boolean {
  return CANCELLABLE_STATES.has(state);
}

/**
 * Map an AgentState to the legacy `AgentRuntimeState.status` string used by
 * CodePilotRuntime consumers before the state machine was introduced.
 * Allows the existing `getState()` API to stay backward-compatible.
 */
export function stateMachineStateToRuntimeStatus(
  state: AgentState,
): "idle" | "running" | "aborted" | "failed" {
  switch (state) {
    case "CREATED":
    case "COMPLETED":
    case "CANCELLED":
      return "idle";
    case "FAILED":
      return "failed";
    case "INITIALIZING":
    case "PLANNING":
    case "EXECUTING":
    case "WAITING_FOR_APPROVAL":
    case "RUNNING_TOOL":
    case "VALIDATING":
    case "HEALING":
      return "running";
    default: {
      // Exhaustive check — TypeScript will error if a new state is added
      // without updating this switch.
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}
