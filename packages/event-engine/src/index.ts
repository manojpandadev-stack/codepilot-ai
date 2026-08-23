/**
 * @codepilot/event-engine
 *
 * Unified event model and event bus for CodePilot AI.
 * Provides typed event emission, subscription, and persistence for
 * agent lifecycle events, tool events, and streaming data.
 */

export type EventType =
  | "agent.started"
  | "agent.thinking"
  | "agent.text_delta"
  | "agent.tool_requested"
  | "agent.tool_approved"
  | "agent.tool_started"
  | "agent.tool_output"
  | "agent.tool_completed"
  | "agent.file_changed"
  | "agent.test_started"
  | "agent.test_completed"
  | "agent.error"
  | "agent.completed"
  | "agent.cancelled";

export interface CodePilotEvent<T = unknown> {
  type: EventType;
  timestamp: number;
  sessionId: string;
  payload: T;
  metadata?: Record<string, unknown>;
}

export type EventHandler<T = unknown> = (event: CodePilotEvent<T>) => void;

/**
 * Typed event bus for CodePilot AI.
 */
export class EventBus {
  private handlers = new Map<EventType, Set<EventHandler>>();
  private history: CodePilotEvent[] = [];
  private maxHistory = 1000;

  /**
   * Subscribe to an event type.
   */
  on<T = unknown>(type: EventType, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler as EventHandler);

    return () => {
      this.handlers.get(type)?.delete(handler as EventHandler);
    };
  }

  /**
   * Emit an event.
   */
  emit<T = unknown>(event: CodePilotEvent<T>): void {
    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory / 2);
    }

    const handlers = this.handlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch {
          // Don't let handler errors break event propagation
        }
      }
    }
  }

  /**
   * Get event history.
   */
  getHistory(sessionId?: string, limit = 100): CodePilotEvent[] {
    const filtered = sessionId
      ? this.history.filter((e) => e.sessionId === sessionId)
      : this.history;
    return filtered.slice(-limit);
  }

  /**
   * Clear event history.
   */
  clearHistory(): void {
    this.history = [];
  }

  /**
   * Remove all handlers.
   */
  removeAllListeners(): void {
    this.handlers.clear();
  }
}

/**
 * Create a typed event emitter helper.
 */
export function createEventEmitter(bus: EventBus, sessionId: string) {
  return {
    emit<T>(
      type: EventType,
      payload: T,
      metadata?: Record<string, unknown>,
    ): void {
      bus.emit({
        type,
        timestamp: Date.now(),
        sessionId,
        payload,
        metadata,
      });
    },
  };
}
