/**
 * Mapper between the REAL @cline/core session-event contract and CodePilot's
 * AgentEvent union.
 *
 * The contract below was verified empirically against @cline/core@0.0.75
 * (see scripts/probe-cline-ollama.ts and scripts/probe-cline-tools.ts):
 *
 * Top-level CoreSessionEvent.type:
 *   "status"           payload: { sessionId, status }
 *   "agent_event"      payload: { sessionId, event: InnerAgentEvent, teamRole? }
 *   "chunk"            payload: JSON echo of agent_event (ignored)
 *   "ended"            payload: { sessionId, reason }
 *   "hook"             payload: { hookEventName, toolName?, toolCallId?, output? }
 *
 * InnerAgentEvent.type (as actually emitted by the local runtime host):
 *   "iteration_start"  { iteration }
 *   "content_start"    { contentType: "text", text, accumulated }
 *                      { contentType: "reasoning", text, accumulated }
 *                      { contentType: "tool", toolName, toolCallId, input }
 *   "content_end"      { contentType: "text", text }
 *                      { contentType: "tool", toolName, toolCallId, output, durationMs }
 *   "usage"            { inputTokens, outputTokens, totalCost? }
 *   "iteration_end"    { iteration, hadToolCalls, toolCallCount }  → ignored
 *   "done"             { reason, text, iterations, usage }
 */
import type { AgentEvent } from "./types.js";

export interface MappedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost?: number;
}

export interface MappedCoreEvent {
  events: AgentEvent[];
  usage?: MappedUsage;
  sessionId?: string;
  /** True when this event marks the end of a run (done / status completed). */
  ended?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function mapUsage(raw: unknown): MappedUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const input = num(raw.inputTokens);
  const output = num(raw.outputTokens);
  if (input === 0 && output === 0) return undefined;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: num(raw.cacheReadTokens),
    cacheWriteTokens: num(raw.cacheWriteTokens),
    totalCost: typeof raw.totalCost === "number" ? raw.totalCost : undefined,
  };
}

/** Map one raw ClineCore CoreSessionEvent into CodePilot AgentEvents. Never throws. */
export function mapCoreEvent(raw: unknown): MappedCoreEvent {
  const out: MappedCoreEvent = { events: [] };
  if (!isRecord(raw)) return out;

  const type = str(raw.type);
  const payload = asRecord(raw.payload);
  if (typeof payload.sessionId === "string") out.sessionId = payload.sessionId;

  switch (type) {
    case "agent_event": {
      mapInnerAgentEvent(asRecord(payload.event), out);
      break;
    }

    case "status": {
      const status = str(payload.status);
      if (status === "running") {
        out.events.push({ type: "status", message: "Agent running…" });
      } else if (status === "completed") {
        out.ended = true;
        out.events.push({ type: "status", message: "Run finished." });
      } else if (status === "idle") {
        out.events.push({ type: "status", message: "Agent idle." });
      }
      break;
    }

    case "ended":
      out.ended = true;
      break;

    case "hook": {
      const hookName = str(payload.hookEventName);
      if (hookName === "tool_call") {
        out.events.push({
          type: "tool_started",
          toolCallId: str(payload.toolCallId, `hook-${Date.now()}`),
          toolName: str(payload.toolName, "unknown"),
        });
      } else if (hookName === "tool_result") {
        out.events.push({
          type: "tool_completed",
          toolCallId: str(payload.toolCallId),
          toolName: str(payload.toolName, "unknown"),
          output: payload.output ?? null,
          durationMs: 0,
        });
      }
      break;
    }

    // chunk / session_snapshot / pending_prompts / team_progress → ignored
    default:
      break;
  }

  return out;
}


function mapInnerAgentEvent(inner: Record<string, unknown>, out: MappedCoreEvent): void {
  switch (str(inner.type)) {
    case "iteration_start":
      out.events.push({ type: "thinking", iteration: num(inner.iteration) });
      break;

    case "content_start": {
      const contentType = str(inner.contentType, "text");
      if (contentType === "text") {
        out.events.push({ type: "text_delta", text: str(inner.text), accumulated: str(inner.accumulated, str(inner.text)) });
      } else if (contentType === "reasoning") {
        // qwen3 thinking tokens → surfaced as reasoning status, never as chat text.
        out.events.push({ type: "reasoning_delta", text: str(inner.text), accumulated: str(inner.accumulated, str(inner.text)) });
      } else if (contentType === "tool") {
        out.events.push({
          type: "tool_started",
          toolCallId: str(inner.toolCallId),
          toolName: str(inner.toolName, "unknown"),
        });
      }
      break;
    }

    case "content_end": {
      if (str(inner.contentType, "text") === "tool") {
        const toolErr = extractToolError(inner.output);
        if (toolErr !== undefined) {
          out.events.push({
            type: "tool_failed",
            toolCallId: str(inner.toolCallId),
            toolName: str(inner.toolName, "unknown"),
            error: toolErr,
          });
        } else {
          out.events.push({
            type: "tool_completed",
            toolCallId: str(inner.toolCallId),
            toolName: str(inner.toolName, "unknown"),
            output: inner.output ?? null,
            durationMs: num(inner.durationMs),
          });
        }
      }
      // content_end(text) is intentionally not forwarded: deltas already
      // carried the full text and `done` carries the final message.
      break;
    }

    case "usage": {
      const usage = mapUsage(inner);
      if (usage) out.usage = usage;
      break;
    }

    case "done": {
      out.ended = true;
      const finalUsage = mapUsage(inner.usage);
      if (finalUsage) out.usage = finalUsage;
      const reason = str(inner.reason, "completed");
      if (reason === "completed") {
        out.events.push({ type: "completed", result: str(inner.text), usage: out.usage ?? emptyUsage() });
      } else if (reason === "aborted" || reason === "cancelled" || reason === "stopped") {
        out.events.push({ type: "cancelled" });
      } else {
        out.events.push({
          type: "error",
          error: str(inner.error, `Agent finished abnormally (${reason})`),
          recoverable: false,
        });
      }
      break;
    }

    default:
      // iteration_end / turn-finished / unknown → intentionally ignored
      break;
  }
}

/** Tool outputs are arrays of per-file results that may embed `error` strings. */
function extractToolError(output: unknown): string | undefined {
  if (!Array.isArray(output)) return undefined;
  const parts: string[] = [];
  for (const entry of output) {
    const rec = asRecord(entry);
    if (typeof rec.error === "string" && rec.error.length > 0) {
      const query = str(rec.query);
      parts.push(query ? `${query}: ${rec.error}` : rec.error);
    }
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

function emptyUsage(): MappedUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}
