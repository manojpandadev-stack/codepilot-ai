// ============================================================================
// Webview-local view types shared across redesigned components.
// Message-contract normalization lives in lib/messages.ts (unit-tested);
// these are the React view models.
// ============================================================================

export interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: number;
  toolName?: string;
  status?: "running" | "completed" | "error";
}

export interface ToolEvent {
  id: string;
  name: string;
  status: "started" | "completed" | "error";
  detail?: string;
  durationMs?: number;
  /**
   * Live terminal output accumulated from `terminal/output` chunks
   * (command tools only). Single string — never thousands of nodes.
   */
  output?: string;
  /** True once the live buffer hit its display cap (explicit truncation). */
  outputTruncated?: boolean;
  /** Highest chunk sequence applied (stale/duplicate defense). */
  outputSeq?: number;
}

export interface Settings {
  provider: string;
  model: string;
  privacyMode: string;
  agentMode: string;
  temperature: number;
  baseUrl: string;
}

export interface AutoApproval {
  readFiles: boolean;
  editFiles: boolean;
  executeCommands: boolean;
  webFetch: boolean;
  mcpServers: boolean;
  browser: boolean;
  maxAutoApprovals: number;
}

/** M4 approval card as presented by the extension host. */
export interface M4ApprovalRequest {
  approvalId: string;
  toolId: string;
  executionId: string;
  action: string;
  description?: string;
  riskLevel: string;
  riskReasons?: string[];
  preview?: string;
  workingDirectory?: string;
  allowSession?: boolean;
  allowTask?: boolean;
}

/** Terminal session snapshot surfaced by the host (M7). */
export interface TerminalSessionView {
  id: string;
  status: string;
  pid?: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Live output accumulated from terminal/output chunks (M7 sessions). */
  liveOutput?: string;
  /** Highest chunk sequence applied (stale/duplicate defense). */
  liveSeq?: number;
  /** True when the live display buffer hit its cap. */
  liveTruncated?: boolean;
  /** Command that started the session (safe metadata from the host). */
  command?: string;
}

/** One bounded command-history record for the terminal tab (M7). */
export interface TerminalHistoryView {
  sessionId: string;
  command: string;
  args: string[];
  startedAt: number;
  durationMs: number;
  status: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  stdoutTail: string;
  stderrTail: string;
  outputTruncated: boolean;
}

/** One metric series for the observability reader (M18). */
export interface MetricRow {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export interface DiffCreatedPayload {
  changeSetId: string;
  changes: Array<{
    id: string;
    filePath: string;
    diff: string;
    status: string;
    isNew: boolean;
  }>;
}
