/**
 * M6 — Typed errors. Partial failure degrades gracefully; these errors are
 * only thrown for conditions the caller must know about (invalid workspace,
 * boundary violations). Per-file indexing failures are recorded in stats
 * instead of thrown so one bad file cannot break the whole index.
 */

export type M6ErrorCode =
  | "INVALID_WORKSPACE"
  | "WORKSPACE_BOUNDARY"
  | "INDEX_FAILURE"
  | "BUDGET_EXCEEDED";

export class M6ContextError extends Error {
  readonly code: M6ErrorCode;
  constructor(code: M6ErrorCode, message: string) {
    super(message);
    this.name = "M6ContextError";
    this.code = code;
  }
}
