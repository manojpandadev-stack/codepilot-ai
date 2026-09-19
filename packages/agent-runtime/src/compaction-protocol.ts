/**
 * M12 — Protocol-safety validation for compacted conversations (pure).
 *
 * Before compacted history is handed to a native session as
 * `initialMessages`, the wire shape must be valid: alternating role
 * constraints, every tool_result referring to a tool_use in the immediately
 * preceding assistant message, and no orphaned tool calls. The native engine
 * performs no defensive repair, so CodePilot must not rely on one — an
 * invalid sequence is reported and the compaction is adjusted, never sent
 * as-is.
 */

export interface ProtocolIssue {
  kind:
    | "empty-message"
    | "invalid-role"
    | "orphaned-tool-result"
    | "duplicate-tool-use-id"
    | "assistant-after-tool-result-unpaired"
    | "result-before-use";
  /** Conversation entry index (as passed in), or -1 when structural. */
  index: number;
  detail: string;
}

export interface ProtocolValidationResult {
  valid: boolean;
  issues: ProtocolIssue[];
}

interface WireShape {
  role: "user" | "assistant";
  content: string | Array<{ type: string; tool_use_id?: string; id?: string }>;
}

/**
 * Validate a wire-shaped conversation (the output of buildInitialMessages /
 * the compactor). Deliberately strict:
 * - non-empty messages only
 * - every tool_result must follow the assistant message whose content
 *   contains the matching tool_use id
 * - tool_use ids must be unique
 */
export function validateConversationProtocol(
  messages: WireShape[],
): ProtocolValidationResult {
  const issues: ProtocolIssue[] = [];
  const seenToolUseIds = new Set<string>();

  if (messages.length === 0) {
    return {
      valid: false,
      issues: [{ kind: "empty-message", index: 0, detail: "empty conversation" }],
    };
  }

  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i]!;
    if (m.role !== "user" && m.role !== "assistant") {
      issues.push({ kind: "invalid-role", index: i, detail: `role ${String(m.role)}` });
      continue;
    }
    if (typeof m.content === "string") {
      if (m.content.trim().length === 0) {
        issues.push({ kind: "empty-message", index: i, detail: "empty text content" });
      }
      continue;
    }
    if (m.content.length === 0) {
      issues.push({ kind: "empty-message", index: i, detail: "empty block list" });
      continue;
    }

    // Collect tool_use ids offered by THIS message (assistant) and results
    // required by THIS message (user tool_result blocks).
    const useIdsHere: string[] = [];
    const resultIdsHere: string[] = [];
    for (const block of m.content) {
      if (block.type === "tool_use" && typeof block.id === "string") {
        if (seenToolUseIds.has(block.id)) {
          issues.push({
            kind: "duplicate-tool-use-id",
            index: i,
            detail: `tool_use id ${block.id} appears twice`,
          });
        }
        seenToolUseIds.add(block.id);
        useIdsHere.push(block.id);
      } else if (block.type === "tool_result") {
        resultIdsHere.push(typeof block.tool_use_id === "string" ? block.tool_use_id : "");
      }
    }

    if (resultIdsHere.length > 0) {
      if (m.role !== "user") {
        issues.push({
          kind: "result-before-use",
          index: i,
          detail: "tool_result blocks must be in a user message",
        });
      }
      // Every result must pair with a tool_use in the immediately preceding
      // assistant message (provider-protocol requirement).
      const prev = i > 0 ? messages[i - 1] : undefined;
      const prevUseIds = new Set<string>();
      if (prev && prev.role === "assistant" && Array.isArray(prev.content)) {
        for (const b of prev.content) {
          if (b.type === "tool_use" && typeof b.id === "string") prevUseIds.add(b.id);
        }
      }
      for (const rid of resultIdsHere) {
        if (!rid) {
          issues.push({
            kind: "orphaned-tool-result",
            index: i,
            detail: "tool_result without tool_use_id",
          });
        } else if (!prevUseIds.has(rid)) {
          issues.push({
            kind: "orphaned-tool-result",
            index: i,
            detail: `tool_result ${rid} has no matching tool_use in the previous assistant message`,
          });
        }
      }
    }
    // useIdsHere on an assistant message is fine; a user message carrying
    // tool_use blocks would be invalid — covered by result-before-use-style
    // checks at conversion time (converter never emits that shape).
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Compaction-specific invariant: the TAIL (everything from the boundary on)
 * is kept verbatim, so it must be protocol-valid on its own. A tail that
 * STARTS with a user entry carrying tool_result blocks would orphan those
 * results (their tool_use lives in the summarized-away head). Walk back to
 * the assistant entry holding the tool_use so the pair stays together in the
 * tail. Returns the adjusted boundary (index of the first entry that may be
 * dropped) or -1 when the range cannot be safely compacted at all.
 */
export function safeCompactionBoundary(
  conversation: Array<{ role: string; blocks?: Array<{ type: string }> }>,
  proposedToIndex: number,
): number {
  if (proposedToIndex <= 0 || proposedToIndex > conversation.length) return -1;
  let idx = proposedToIndex;
  // Unsafe start: a user entry whose blocks are tool_results (the matching
  // tool_use would be summarized away). Step back to the assistant entry
  // that holds the tool_use so use+result both stay in the tail.
  const startsOrphaned = (i: number): boolean => {
    const e = conversation[i];
    if (!e || e.role !== "user") return false;
    return (e.blocks ?? []).some((b) => b.type === "tool_result");
  };
  while (idx > 0 && startsOrphaned(idx)) idx -= 1;
  if (idx <= 0) return -1;
  return idx;
}
