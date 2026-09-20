/**
 * CodePilot-owned runtime contracts.
 *
 * These types are authored independently for the native engine. They describe
 * the shapes the rest of the CodePilot codebase consumes (tool JSON schemas, usage counters,
 * wire messages) so that the migration is structural, not cosmetic:
 *
 *   - `AgentTool`  — a JSON-schema-described function the model may call.
 *   - `AgentUsage` — token accounting for a run.
 *   - `AgentMessage` — the provider-protocol wire message (text / tool_use /
 *     tool_result blocks). This shape is CodePilot's persisted conversation
 *     format (`resume.ts` `ResumeWireMessage`) — the native engine speaks it
 *     natively, so resume/compaction need no adapter.
 */

// ============================================================================
// Tools
// ============================================================================

/**
 * Stable identity of the single agent owned by one runtime instance.
 * Single source of truth for the dispatcher, event correlation, and run
 * metrics (runtime.js re-exports it).
 */
export const NATIVE_AGENT_ID = "codepilot-agent";

/** JSON-schema object describing a tool's input. */
export type JsonSchemaObject = Record<string, unknown>;

/**
 * Context handed to a tool's `execute` function. Deliberately minimal:
 * identifiers for correlation plus an abort signal the tool should honor.
 */
export interface AgentToolContext {
  sessionId?: string;
  agentId: string;
  conversationId?: string;
  runId?: string;
  iteration: number;
  toolCallId?: string;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

/** Lifecycle knobs for a tool. */
export interface AgentToolLifecycle {
  /** A successful call to this tool completes the current run. */
  completesRun?: boolean;
}

/**
 * A CodePilot tool: a named, JSON-schema-described async function.
 *
 * This is the native contract used by the engine's tool dispatcher. Existing
 * CodePilot tools (repository analysis, MCP bridges, terminal session tools,
 * the streaming `bash` executor) are expressed with this shape.
 */
export interface AgentTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
  /** A successful call to this tool completes the current run. */
  lifecycle?: AgentToolLifecycle;
  timeoutMs?: number;
  execute: (input: TInput, context: AgentToolContext) => Promise<TOutput>;
}

/**
 * Create a CodePilot tool. Structural — the input schema is a plain JSON
 * schema record (what providers speak), the execute function is typed by the
 * caller.
 */
export function createTool<TInput, TOutput>(config: {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
  execute: (input: TInput, context: AgentToolContext) => Promise<TOutput>;
  lifecycle?: AgentToolLifecycle;
  timeoutMs?: number;
}): AgentTool<TInput, TOutput> {
  return {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    lifecycle: config.lifecycle,
    timeoutMs: config.timeoutMs,
    execute: config.execute,
  };
}

// ============================================================================
// Usage
// ============================================================================

/** Token accounting for one run (cumulative across iterations). */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost?: number;
}

// ============================================================================
// Wire messages (provider protocol)
// ============================================================================

/** A tool_use block inside an assistant message. */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A tool_result block inside a user message (protocol shape). */
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  name: string;
  content: string;
  is_error?: boolean;
}

/** Text block. */
export interface TextBlock {
  type: "text";
  text: string;
}

/**
 * Image block inside a user message.
 *
 * `dataBase64` carries validated, metadata-stripped bytes for the live
 * request. `fileRef` is a task-scoped relative filename (`images/<id>.bin`)
 * used by persistence instead of inline bytes — never an absolute path, so
 * local filesystem layout never reaches the model. Exactly one of the two
 * is set on any given block.
 */
export interface ImageBlock {
  type: "image";
  mime: string;
  dataBase64?: string;
  fileRef?: string;
  /** Sanitized display name (never a path). */
  name?: string;
  sizeBytes?: number;
}

export type WireBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock;

/**
 * Provider-protocol message: role + text OR block array. Tool results ride in
 * a following USER message — exactly CodePilot's persisted conversation format
 * (see resume.ts) and exactly what the LLM adapters translate per provider.
 */
export interface AgentMessage {
  role: "user" | "assistant";
  content: string | WireBlock[];
  ts?: number;
}

// ============================================================================
// LLM stream events (provider-neutral)
// ============================================================================

export type LlmStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      inputText: string;
    }
  | { type: "usage"; usage: AgentUsage }
  | {
      type: "finish";
      reason: "complete" | "aborted" | "error";
      error?: string;
    };

// ============================================================================
// Model request/response
// ============================================================================

/** One streaming request to a provider. */
export interface LlmRequest {
  providerId: string;
  modelId: string;
  systemPrompt?: string;
  messages: AgentMessage[];
  tools?: AgentTool[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmProvider {
  /** Stream one completion. Yields events; the final event is always `finish`. */
  stream(request: LlmRequest): AsyncIterable<LlmStreamEvent>;
  /** Models advertised for this provider (used by discovery/UI paths). */
  listModels?(): Promise<Array<{ id: string; contextWindow?: number }>>;
}
