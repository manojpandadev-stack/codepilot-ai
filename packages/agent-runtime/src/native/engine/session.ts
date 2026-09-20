/**
 * Native engine — session manager.
 *
 * Owns the runtime session lifecycle the previous engine exposed:
 * create (start) / send / abort / stop / list / dispose, with a bounded
 * in-memory transcript per session and synchronous event fan-out.
 *
 * A session is ONE conversation: `send(prompt)` runs the agent loop to
 * completion (or abort), appending every wire message to the transcript so
 * TaskStore capture and resume see exactly what the model saw.
 */

import type { AgentMessage, AgentTool } from "../types.js";
import type { LlmProvider } from "../llm/types.js";
import { createLlmProvider, type LlmProviderConfig } from "../llm/registry.js";
import { runAgentLoop, type AgentLoopEvent } from "./agent-loop.js";
import type { ToolGate } from "./tool-dispatch.js";

export interface NativeSessionConfig {
  providerId: string;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  systemPrompt?: string;
  tools: AgentTool[];
  gate: ToolGate;
  maxIterations: number;
  temperature?: number;
  maxResultChars?: number;
  /** Prior conversation to seed (verbatim resume). */
  initialMessages?: AgentMessage[];
}

export interface NativeSession {
  id: string;
  transcript: AgentMessage[];
  /** Set when the loop is mid-run; cleared by settle(). */
  settled: boolean;
}

export type NativeSessionEvent =
  | {
      type: "status";
      sessionId: string;
      status: "running" | "completed" | "aborted" | "failed";
      reason?: string;
    }
  | { type: "loop"; loop: AgentLoopEvent; sessionId: string };

export class NativeSessionManager {
  private sessions = new Map<string, NativeSession>();
  private providers = new Map<string, LlmProvider>();
  private disposed = false;

  constructor(
    private readonly providerConfigs: LlmProviderConfig[],
    private readonly fetchImpl?: typeof fetch,
    private readonly maxTranscriptMessages = 400,
  ) {}

  /** List sessions (newest first), bounded. */
  list(limit = 20): Array<{ sessionId: string; updatedAt: number }> {
    return [...this.sessions.values()]
      .sort((a, b) => sessionIdTs(b.id) - sessionIdTs(a.id))
      .slice(0, limit)
      .map((s) => ({ sessionId: s.id, updatedAt: sessionIdTs(s.id) }));
  }

  get(sessionId: string): NativeSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Create a session (idempotent per id) and seed its transcript.
   *
   * Seeding REPLACES the transcript when `initialMessages` are provided:
   * `startSession` creates the session and then re-creates it inside the
   * retry closure, so appending would silently duplicate seeded history
   * (doubling context on every resumed turn). Replacement keeps exactly
   * one copy and gives retries the documented fresh transcript.
   */
  create(sessionId: string, config: NativeSessionConfig): NativeSession {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { id: sessionId, transcript: [], settled: true };
      this.sessions.set(sessionId, session);
    }
    if (config.initialMessages && config.initialMessages.length > 0) {
      session.transcript = [...config.initialMessages];
    }
    return session;
  }

  private providerFor(config: NativeSessionConfig): LlmProvider {
    const cacheKey = `${config.providerId}|${config.baseUrl ?? ""}`;
    let provider = this.providers.get(cacheKey);
    if (!provider) {
      provider = createLlmProvider(
        { providerId: config.providerId, modelId: config.modelId },
        {
          configs: this.providerConfigs.map((c) => ({
            ...c,
            // Per-session credentials win over registry defaults.
            ...(c.providerId === config.providerId && config.apiKey
              ? { apiKey: config.apiKey }
              : {}),
            ...(c.providerId === config.providerId && config.baseUrl
              ? { baseUrl: config.baseUrl }
              : {}),
          })),
          ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        },
      );
      this.providers.set(cacheKey, provider);
    }
    return provider;
  }

  /**
   * Run one prompt through the agent loop. Rejects when the session is
   * already running (concurrent-start guard) or the manager is disposed.
   * Abort via `abort(sessionId)` — the loop unwinds and the promise resolves
   * with reason "aborted".
   */
  async run(
    sessionId: string,
    config: NativeSessionConfig,
    prompt: string,
    onEvent: (event: NativeSessionEvent) => void,
    signal?: AbortSignal,
  ): Promise<{
    reason: "complete" | "aborted" | "error" | "max_iterations";
    error?: string;
    text: string;
  }> {
    if (this.disposed) throw new Error("Session manager disposed.");
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    if (!session.settled) {
      throw new Error(
        "A task is already running in this session. Stop it or wait for completion.",
      );
    }
    session.settled = false;
    onEvent({ type: "status", sessionId, status: "running" });

    try {
      const provider = this.providerFor(config);
      const result = await runAgentLoop(
        session.transcript,
        prompt,
        {
          provider,
          modelId: config.modelId,
          sessionId,
          systemPrompt: config.systemPrompt,
          tools: config.tools,
          gate: config.gate,
          maxIterations: config.maxIterations,
          temperature: config.temperature,
          maxResultChars: config.maxResultChars,
          onEvent: (loopEvent) =>
            onEvent({ type: "loop", loop: loopEvent, sessionId }),
        },
        signal,
      );
      this.trim(session);
      onEvent({
        type: "status",
        sessionId,
        status:
          result.reason === "complete"
            ? "completed"
            : result.reason === "aborted"
              ? "aborted"
              : result.reason === "max_iterations"
                ? "failed"
                : "failed",
        ...(result.error !== undefined ? { reason: result.error } : {}),
      });
      return {
        reason: result.reason,
        text: result.text,
        ...(result.error !== undefined ? { error: result.error } : {}),
      };
    } finally {
      session.settled = true;
    }
  }

  /** Abort the in-flight run for a session (no-op if idle). */
  abort(sessionId: string, controllers: Map<string, AbortController>): void {
    const controller = controllers.get(sessionId);
    if (controller && !controller.signal.aborted) controller.abort();
  }

  /** Drop one session's transcript and registry entry. */
  stop(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.transcript.length = 0;
      this.sessions.delete(sessionId);
    }
  }

  /** Drop everything (dispose path). */
  dispose(): void {
    this.sessions.clear();
    this.providers.clear();
    this.disposed = true;
  }

  /** Keep the transcript bounded (drop oldest, never split an exchange). */
  private trim(session: NativeSession): void {
    while (session.transcript.length > this.maxTranscriptMessages) {
      session.transcript.shift();
    }
  }
}

function sessionIdTs(id: string): number {
  const m = id.match(/(\d{13})/);
  return m ? Number(m[1]) : 0;
}
