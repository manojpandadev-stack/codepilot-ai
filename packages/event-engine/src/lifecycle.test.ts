/**
 * Lifecycle hardening — EventBus subscriptions do not accumulate.
 *
 * Repeatedly exercises on → emit → unsubscribe → removeAllListeners and
 * verifies handler delivery counts stay exact across cycles.
 */
import { describe, it, expect } from "vitest";
import { EventBus } from "./index.js";

describe("lifecycle: EventBus subscriptions", () => {
  it("repeated subscribe → emit → unsubscribe cycles deliver exactly once", () => {
    const bus = new EventBus();
    for (let i = 0; i < 10; i++) {
      let calls = 0;
      const u1 = bus.on("agent.completed", () => {
        calls += 1;
      });
      const u2 = bus.on("agent.completed", () => {
        calls += 1;
      });
      bus.emit({ type: "agent.completed", timestamp: Date.now(), sessionId: "s", payload: {} });
      expect(calls).toBe(2);
      u1();
      u2();
      bus.emit({ type: "agent.completed", timestamp: Date.now(), sessionId: "s", payload: {} });
      expect(calls).toBe(2);
    }
    bus.removeAllListeners();
    bus.removeAllListeners(); // idempotent
  });

  it("removeAllListeners releases everything", () => {
    const bus = new EventBus();
    let calls = 0;
    bus.on("agent.error", () => {
      calls += 1;
    });
    bus.removeAllListeners();
    bus.emit({ type: "agent.error", timestamp: Date.now(), sessionId: "s", payload: {} });
    expect(calls).toBe(0);
  });
});
