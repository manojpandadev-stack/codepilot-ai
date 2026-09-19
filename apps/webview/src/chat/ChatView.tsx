// ============================================================================
// Chat view — conversation layout, empty state, streaming bubble, cards
// ============================================================================

import { type ReactNode, useEffect, useRef } from "react";
import { ChatMarkdown } from "../ChatMarkdown";
import {
  CodePilotMark,
  IconBolt,
  IconChanges,
  IconChat,
  IconChevron,
  IconFile,
  IconFolder,
  IconLink,
  IconWarning,
} from "../lib/icons";
import { StatusDot } from "../lib/ui";
import type { Message, ToolEvent, M4ApprovalRequest } from "../types";
import {
  M4ApprovalCard,
  McpApprovalCard,
  ToolCard,
  type McpApprovalView,
} from "./ToolCards";

// ---------------------------------------------------------------------------
// Message bubbles
// ---------------------------------------------------------------------------

function Avatar({ role }: { role: Message["role"] }) {
  if (role === "user") {
    return (
      <div
        aria-hidden="true"
        className="w-5 h-5 rounded-full border border-vscode-border flex items-center justify-center text-[9px] font-semibold text-vscode-desc flex-shrink-0 bg-vscode-bg"
      >
        You
      </div>
    );
  }
  if (role === "system") {
    return (
      <div
        aria-hidden="true"
        className="w-5 h-5 rounded-full border border-vscode-error-fg/40 flex items-center justify-center flex-shrink-0"
      >
        <IconWarning size={11} className="text-vscode-error-fg" />
      </div>
    );
  }
  return (
    <div
      aria-hidden="true"
      className="w-5 h-5 rounded-full border border-vscode-border flex items-center justify-center flex-shrink-0 bg-vscode-bg"
    >
      <CodePilotMark size={12} />
    </div>
  );
}

const ROLE_LABEL: Record<Message["role"], string> = {
  user: "You",
  assistant: "CodePilot",
  system: "System",
  tool: "Tool",
};

function MessageBubble({
  message,
  streaming = false,
}: {
  message: Message;
  streaming?: boolean;
}) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  if (isSystem) {
    return (
      <div className="flex items-start gap-2 cp-fade-up">
        <Avatar role="system" />
        <div className="flex-1 min-w-0 rounded-md border border-vscode-error-fg/30 bg-vscode-error-fg/5 px-3 py-2 text-[12px] text-vscode-error-fg whitespace-pre-wrap break-words">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 cp-fade-up group">
      <Avatar role={message.role} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-vscode-desc">
            {ROLE_LABEL[message.role]}
          </span>
          <span className="text-[9px] text-vscode-desc/60 opacity-0 group-hover:opacity-100 transition-opacity">
            {new Date(message.timestamp).toLocaleTimeString()}
          </span>
        </div>
        <div
          className={`mt-0.5 rounded-lg px-3 py-2 border ${
            isUser
              ? "bg-vscode-list-hover/60 border-vscode-border"
              : "bg-vscode-panel/70 border-vscode-border"
          }`}
        >
          {isUser ? (
            <div className="text-[13px] whitespace-pre-wrap break-words text-vscode-fg">
              {message.content}
            </div>
          ) : (
            <ChatMarkdown text={message.content} streaming={streaming} />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state (onboarding — real commands only)
// ---------------------------------------------------------------------------

const SUGGESTIONS: Array<{ label: string; command: string }> = [
  { label: "Explain this repository", command: "/explain this repository" },
  { label: "Fix failing tests", command: "/fix the failing tests" },
  { label: "Refactor a service", command: "/refactor " },
  { label: "Add authentication", command: "/act add authentication" },
];

function EmptyState({ onPick }: { onPick: (command: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6 py-10">
      <div className="w-12 h-12 rounded-xl border border-vscode-border bg-vscode-panel flex items-center justify-center mb-3">
        <CodePilotMark size={26} />
      </div>
      <h1 className="text-[16px] font-semibold text-vscode-fg">CodePilot AI</h1>
      <p className="mt-1 text-[12px] text-vscode-desc">
        Your AI software engineer
      </p>
      <p className="mt-0.5 text-[10px] text-vscode-desc/80 tracking-wide">
        Understand · Build · Test · Fix · Refactor
      </p>

      <div className="mt-5 w-full max-w-[340px] space-y-1">
        <div className="cp-section-title text-left mb-1">Try</div>
        {SUGGESTIONS.map((s) => (
          <button
            key={s.label}
            onClick={() => onPick(s.command)}
            className="w-full flex items-center gap-2 rounded-md border border-vscode-border bg-vscode-panel/60 px-3 py-1.5 text-[11px] text-vscode-fg hover:bg-vscode-list-hover hover:border-vscode-text-link/40 transition-colors text-left"
          >
            <IconBolt
              size={11}
              className="text-vscode-text-link flex-shrink-0"
            />
            <span className="truncate">{s.label}</span>
            <span className="ml-auto font-mono text-[9px] text-vscode-desc flex-shrink-0">
              {s.command.split(" ")[0]}
            </span>
          </button>
        ))}
      </div>

      <p className="mt-4 text-[10px] text-vscode-desc/70">
        Every file change is staged, diffed and requires your approval.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat view
// ---------------------------------------------------------------------------

export interface ChatViewProps {
  messages: Message[];
  streamingText: string;
  toolEvents: ToolEvent[];
  m4Approvals: M4ApprovalRequest[];
  mcpApprovals: McpApprovalView[];
  onM4Decision: (
    approvalId: string,
    decision: "allow" | "deny",
    scope?: "once" | "session" | "task",
  ) => void;
  onMcpDecision: (requestId: string, decision: "approve" | "reject") => void;
  onPickSuggestion: (command: string) => void;
  composer: ReactNode;
  executionStatus: ReactNode;
  healingOutcome: ReactNode;
  /** Optional continuity strip (M12 v5) rendered above the transcript. */
  continuityBar?: ReactNode;
}

export function ChatView({
  messages,
  streamingText,
  toolEvents,
  m4Approvals,
  mcpApprovals,
  onM4Decision,
  onMcpDecision,
  onPickSuggestion,
  composer,
  executionStatus,
  healingOutcome,
  continuityBar,
}: ChatViewProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // Track whether the user scrolled away; only auto-scroll when pinned.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      stickToBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (stickToBottomRef.current) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages, streamingText, toolEvents]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {executionStatus}
      {healingOutcome}
      {continuityBar}
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0">
        {messages.length === 0 &&
        !streamingText &&
        toolEvents.length === 0 &&
        m4Approvals.length === 0 &&
        mcpApprovals.length === 0 ? (
          <EmptyState onPick={onPickSuggestion} />
        ) : (
          <div className="px-3 py-3 space-y-3">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}

            {streamingText && (
              <MessageBubble
                message={{
                  id: "streaming",
                  role: "assistant",
                  content: streamingText,
                  timestamp: Date.now(),
                }}
                streaming
              />
            )}

            {toolEvents.length > 0 && (
              <div className="pl-7 space-y-1">
                {toolEvents.map((evt) => (
                  <ToolCard key={evt.id} event={evt} />
                ))}
              </div>
            )}

            {mcpApprovals.map((approval) => (
              <div key={approval.requestId} className="pl-7">
                <McpApprovalCard
                  approval={approval}
                  onDecision={onMcpDecision}
                />
              </div>
            ))}

            {m4Approvals.map((a) => (
              <div key={a.approvalId} className="pl-7">
                <M4ApprovalCard request={a} onDecision={onM4Decision} />
              </div>
            ))}

            <div ref={endRef} />
          </div>
        )}
      </div>
      {composer}
    </div>
  );
}

// Re-exports used by App.tsx chip rendering
export {
  IconFile,
  IconFolder,
  IconLink,
  IconChanges,
  IconChevron,
  IconChat,
  StatusDot,
};
