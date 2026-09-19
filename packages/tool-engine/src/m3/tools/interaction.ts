/**
 * @codepilot/tool-engine — M3 built-in interaction tool
 *
 * ask_user routes a question to the host through the ToolContext approval
 * channel. In M3 the `requestApproval` callback is the host interaction
 * contract (the VS Code WebView surfaces it); M4 will attach a dedicated
 * question dialog to the same channel. When no host channel is available the
 * tool fails explicitly rather than guessing an answer.
 */

import type { ToolDefinition } from "../types.js";
import { toolError } from "../types.js";

export interface AskUserInput {
  question: string;
  options?: string[];
}

export function createAskUserTool(): ToolDefinition<AskUserInput, unknown> {
  return {
    id: "ask_user",
    name: "Ask User",
    description:
      "Ask the user a question and wait for their answer. Use sparingly — only when a decision genuinely needs human input.",
    category: "interaction",
    version: "1.0.0",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to ask the user",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Optional suggested answers",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        answer: { type: "string" },
        options: { type: "array", items: { type: "string" } },
      },
      required: ["question", "answer"],
    },
    capabilities: ["cancellable"],
    permission: {
      level: "interaction",
      requiresApproval: false,
      rationale: "Ask the user a question",
    },
    idempotent: false,
    async execute(input, ctx): Promise<unknown> {
      const question = input.question;
      if (typeof question !== "string" || question.trim().length === 0) {
        throw toolError(
          "VALIDATION",
          "question must be a non-empty string",
          ctx.executionId,
          {
            recoverable: false,
          },
        );
      }
      const options = Array.isArray(input.options)
        ? input.options.filter((o): o is string => typeof o === "string")
        : undefined;
      if (!ctx.requestApproval) {
        throw toolError(
          "UNSUPPORTED",
          "ask_user requires a host approval channel — none is available in this context",
          ctx.executionId,
        );
      }
      const decision = await ctx.requestApproval({
        toolId: "ask_user",
        executionId: ctx.executionId,
        summary: options?.length
          ? `${question} (options: ${options.join(", ")})`
          : question,
      });
      if (ctx.signal.aborted) {
        throw toolError(
          "CANCELLED",
          "Cancelled while waiting for user answer",
          ctx.executionId,
          {
            recoverable: false,
          },
        );
      }
      const answer =
        decision.reason?.trim() ??
        (decision.approved ? "approved" : "rejected");
      return { question, answer, options };
    },
  };
}
