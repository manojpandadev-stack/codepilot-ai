/**
 * @codepilot/llm — CodePilot-owned LLM contracts.
 *
 * These types are defined from what CodePilot's runtime, persistence, and
 * tools actually consume (agent loop, wire history, tool dispatch, usage
 * accounting). They are structurally compatible with the shapes CodePilot
 * previously imported, but they are CodePilot's own definitions — no
 * third-party agent framework is involved.
 */

// ============================================================================
// Messages (wire-compatible with CodePilot's persisted v2 conversation)
// ============================================================================

export type LlmRole = "system" | "user" | "assistant";

export interface LlmTextBlock {
  type: "text";
  text: string;
}

/** Image block (validated, metadata-stripped bytes as base64). */
export interface LlmImageBlock {
  type: "image";
  mime: string;
  dataBase64: string;
  name?: string;
  sizeBytes?: number;
}

export interface LlmToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LlmToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  /** Tool name (CodePilot extension — not all providers echo it). */
  name?: string;
}

export type LlmContentBlock =
  LlmTextBlock | LlmToolUseBlock | LlmToolResultBlock | LlmImageBlock;

export interface LlmMessage {
  role: "user" | "assistant";
  content: string | LlmContentBlock[];
}

// ============================================================================
// Tools
// ============================================================================

/** A tool the model may call. Implemented and executed host-side. */
export interface LlmToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema (object) describing the tool input. */
  inputSchema?: Record<string, unknown>;
}

/** One complete, accumulated tool call from the model. */
export interface LlmToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// ============================================================================
// Streaming protocol (what providers yield; what the agent loop consumes)
// ============================================================================

export type LlmChunk =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "toolcall"; toolCall: LlmToolCall }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; success: boolean; error?: string; stopReason?: string };

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmRequest {
  systemPrompt?: string;
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  metadata?: {
    taskId?: string;
    sessionId?: string;
  };
}

/** Model listing entry (discovery/health paths). */
export interface LlmListedModel {
  id: string;
  name?: string;
  contextWindow?: number;
}

/**
 * A CodePilot-owned model provider. Implementations speak exactly one
 * provider HTTP protocol and translate it to/from the normalized shapes
 * above. Secrets travel only in request headers at call time.
 */
export interface LlmProvider {
  readonly providerId: string;
  readonly modelId: string;
  /** Stream one assistant turn. Never throws for model-level failures —
   * those arrive as `{ type: "done", success: false }`. Transport errors
   * (network, auth, timeout, abort) reject the iterable. */
  completeStream(request: LlmRequest): AsyncIterable<LlmChunk>;
  listModels?(signal?: AbortSignal): Promise<LlmListedModel[]>;
  checkHealth?(
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; latencyMs?: number }>;
  close?(): Promise<void>;
}

export interface LlmProviderOptions {
  providerId: string;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

// ============================================================================
// Agent-tool contracts (owned; structural parity with prior imports)
// ============================================================================

/** Context a tool execution may observe. All fields optional. */
export interface AgentToolContext {
  conversationId?: string;
  agentId?: string;
  sessionId?: string;
  taskId?: string;
  toolCallId?: string;
  signal?: AbortSignal;
}

/** A host-implemented tool callable by the model through the agent loop. */
export interface AgentTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** Soft execution budget hint (ms). Enforcement is host-side. */
  timeoutMs?: number;
  lifecycle?: {
    /** A successful call completes the current run. */
    completesRun?: boolean;
  };
  retryable?: boolean;
  maxRetries?: number;
  execute: (
    input: unknown,
    ctx?: AgentToolContext,
  ) => unknown | Promise<unknown>;
}

/** Author-facing tool definition (typed input/output via inference). */
export interface AgentToolConfig<TInput = unknown, TOutput = unknown> {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  lifecycle?: {
    /** A successful call completes the current run. */
    completesRun?: boolean;
  };
  timeoutMs?: number;
  retryable?: boolean;
  maxRetries?: number;
  execute: (
    input: TInput,
    ctx?: AgentToolContext,
  ) => TOutput | Promise<TOutput>;
}

/** `editor`/`apply_patch`/`bash`-style host executor override. */
export type ToolExecutorFn = (
  input: unknown,
  cwd: string,
  context: Record<string, unknown>,
) => Promise<string>;

/** Token usage accumulated across a run. */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost?: number;
}

/** Persisted conversation message (mirrors the v2 TaskStore shape). */
export interface AgentMessage {
  role: "user" | "assistant";
  content: string | LlmContentBlock[];
  ts?: number;
}

/**
 * Minimal tool factory. Input/output types flow through inference so
 * authors keep typed `execute` callbacks; the loop consumes the widened
 * `AgentTool`. Extra fields (lifecycle/timeoutMs/retryable/maxRetries)
 * pass through untouched.
 */
export function createTool<TInput = unknown, TOutput = unknown>(
  tool: AgentToolConfig<TInput, TOutput>,
): AgentTool {
  if (!tool || typeof tool.name !== "string" || tool.name.length === 0) {
    throw new Error("createTool: tool must have a non-empty name");
  }
  if (tool.description !== undefined && typeof tool.description !== "string") {
    throw new Error("createTool: tool description must be a string");
  }
  return tool as unknown as AgentTool;
}
