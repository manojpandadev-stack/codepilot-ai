/**
 * @codepilot/agent-runtime — Persistent Agent Session
 *
 * Deterministic, crash-safe session surface on top of the existing M12
 * TaskStore. This layer owns session identity and checkpoint/restore logic
 * only; the agent runtime, ToolGate, M4 approval, cancellation, verification,
 * self-healing, repository intelligence and browser integration are unchanged.
 */
