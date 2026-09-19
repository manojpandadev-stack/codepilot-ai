/**
 * @codepilot/changeset-engine — M5 structured errors
 *
 * Typed, actionable errors for the file mutation / diff / checkpoint
 * subsystem. Errors never embed file contents or secrets — only paths
 * relative to the workspace and machine-readable codes.
 */

/** All M5 error codes. */
export type M5ErrorCode =
  | "INVALID_PATH"
  | "OUTSIDE_WORKSPACE"
  | "SENSITIVE_FILE"
  | "PERMISSION_DENIED"
  | "APPROVAL_REJECTED"
  | "FILE_NOT_FOUND"
  | "FILE_ALREADY_EXISTS"
  | "CONCURRENT_MODIFICATION"
  | "CHECKPOINT_NOT_FOUND"
  | "RESTORE_CONFLICT"
  | "CHECKSUM_MISMATCH"
  | "CANCELLED"
  | "TIMEOUT"
  | "FS_ERROR"
  | "VALIDATION";

/** Structured M5 error. */
export class M5Error extends Error {
  readonly code: M5ErrorCode;
  /** Workspace-relative path the error refers to, when known. */
  readonly path?: string;
  /** Machine-readable detail (e.g. expected vs actual hash). */
  readonly details?: Record<string, string>;

  constructor(
    code: M5ErrorCode,
    message: string,
    options?: {
      path?: string;
      details?: Record<string, string>;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "M5Error";
    this.code = code;
    this.path = options?.path;
    this.details = options?.details;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  /** Plain-object form safe for events/audit/UI (no contents, no secrets). */
  toJSON(): {
    code: M5ErrorCode;
    message: string;
    path?: string;
    details?: Record<string, string>;
  } {
    return {
      code: this.code,
      message: this.message,
      ...(this.path !== undefined ? { path: this.path } : {}),
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }

  /** Type guard for thrown values. */
  static is(err: unknown): err is M5Error {
    return err instanceof M5Error;
  }
}

/** Normalize an unknown thrown value (fs errors etc.) into an M5Error. */
export function toM5Error(err: unknown, path?: string): M5Error {
  if (M5Error.is(err)) return err;
  const raw = err instanceof Error ? err.message : String(err);
  const code = isNodeFsError(err) ? fsCodeToM5(err.code) : "FS_ERROR";
  return new M5Error(code, raw, { path, cause: err });
}

function isNodeFsError(err: unknown): err is { code: string } & Error {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string"
  );
}

function fsCodeToM5(code: string): M5ErrorCode {
  switch (code) {
    case "ENOENT":
      return "FILE_NOT_FOUND";
    case "EEXIST":
      return "FILE_ALREADY_EXISTS";
    case "EACCES":
    case "EPERM":
      return "PERMISSION_DENIED";
    case "EBUSY":
    case "EMFILE":
      return "FS_ERROR";
    default:
      return "FS_ERROR";
  }
}
