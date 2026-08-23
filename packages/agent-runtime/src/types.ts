import type { AgentTool, AgentUsage, AgentMessage } from "@cline/agents";
import type { PrivacyMode, CodePilotAgentMode } from "@codepilot/shared";

/**
 * Configuration for the CodePilot agent runtime.
 */
export interface CodePilotAgentConfig {
  providerId: string;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  workspaceRoot: string;
  privacyMode: PrivacyMode;
  agentMode: CodePilotAgentMode;
  maxIterations?: number;
  temperature?: number;
  systemPrompt?: string;
  toolPolicies?: Record<string, { enabled?: boolean; autoApprove?: boolean }>;
  extraTools?: AgentTool[];
  enableTools?: boolean;
}

/**
 * Options for creating a CodePilotRuntime.
 */
export interface CodePilotRuntimeOptions {
  workspaceRoot: string;
  providerId: string;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  privacyMode?: PrivacyMode;
  agentMode?: CodePilotAgentMode;
  toolPolicies?: Record<string, { enabled?: boolean; autoApprove?: boolean }>;
  extraTools?: AgentTool[];
  maxIterations?: number;
  temperature?: number;
  systemPrompt?: string;
  /**
   * Staging bridge: invoked when a write tool (`editor`/`apply_patch`) must
   * register its in-memory proposal as a pending ChangeSet. The host returns
   * the ChangeSet id. No file write happens here.
   */
  onWriteProposal?: (
    toolName: string,
    proposals: Array<{ filePath: string; relativePath: string; proposedContent: string }>
  ) => Promise<{ changeSetId: string }>;
  /**
   * Approval callback for tools that are neither auto-approved nor staged
   * (e.g. `run_commands`). The host decides (e.g. native VS Code prompt).
   */
  requestApproval?: (request: {
    toolCallId: string;
    toolName: string;
    input: unknown;
  }) => Promise<{ approved: boolean; reason?: string }> | { approved: boolean; reason?: string };
}

/**
 * An event emitted by the CodePilot agent.
 */
export type AgentEvent =
  | { type: "started"; sessionId: string }
  | { type: "thinking"; iteration: number }
  | { type: "text_delta"; text: string; accumulated: string }
  | { type: "reasoning_delta"; text: string; accumulated: string }
  | { type: "tool_requested"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool_approved"; toolCallId: string; approved: boolean }
  | { type: "tool_started"; toolCallId: string; toolName: string }
  | { type: "tool_completed"; toolCallId: string; toolName: string; output: unknown; durationMs: number }
  | { type: "tool_failed"; toolCallId: string; toolName: string; error: string }
  | { type: "file_changed"; path: string; status: string }
  | { type: "test_started"; command: string }
  | { type: "test_completed"; passed: number; failed: number; duration: number }
  | { type: "error"; error: string; recoverable: boolean }
  | { type: "completed"; result: string; usage: AgentUsage }
  | { type: "cancelled" }
  | { type: "status"; message: string; metadata?: Record<string, unknown> }
  | { type: "healing_started"; attempt: number; maxAttempts: number }
  | { type: "healing_progress"; attempt: number; maxAttempts: number; phase: string; message: string }
  | { type: "healing_succeeded"; attempt: number; durationMs: number }
  | { type: "healing_failed"; attempts: number; error: string };

export type AgentEventListener = (event: AgentEvent) => void;

/**
 * Internal state of the agent runtime.
 */
export interface AgentRuntimeState {
  status: "idle" | "running" | "aborted" | "failed";
  sessionId: string | null;
  currentIteration: number;
  messages: AgentMessage[];
  usage: AgentUsage;
  filesChanged: string[];
  toolCallHistory: Array<{ name: string; count: number; totalDurationMs: number }>;
  lastError: string | null;
}
