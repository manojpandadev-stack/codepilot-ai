/**
 * @codepilot/tool-engine — M3 typed terminal streaming
 *
 * Phase 3 (production terminal streaming) shared core for every terminal
 * execution path (one-shot M3 commands AND M7 background sessions):
 *
 * - Typed runtime events (`terminal.*`) with correlation (taskId, executionId,
 *   seq) and per-execution monotonic sequence numbers preserving order.
 * - UTF-8-safe incremental decoding: a multi-byte character split across
 *   chunks is buffered (TextDecoder stream mode) instead of being corrupted
 *   by a per-chunk `toString("utf8")`.
 * - Bounded retention with a deterministic head+tail policy: the beginning
 *   AND end of output are preserved under truncation, truncation is always
 *   reported (never silently discarded), and memory stays capped.
 *
 * This module does not spawn processes and does not replace the M4 security
 * pipeline — it is the event/retention layer the spawn primitives feed.
 */

// ============================================================================
// Typed terminal events
// ============================================================================

/** Stream channel of an emitted output event. */
export type TerminalStreamChannel = "stdout" | "stderr";

/**
 * Typed terminal stream events. Every event carries the correlation triple
 * (taskId, executionId, seq) so consumers can safely associate chunks with a
 * specific terminal execution / tool call.
 *
 * Ordering guarantee: within one execution, `seq` is monotonically increasing
 * starting at 1 and events are emitted in seq order.
 */
export type TerminalStreamEvent =
  | {
      type: "terminal.started";
      /** Always 1 — terminal.started is the first event of an execution. */
      seq: number;
      command: string;
      pid: number | undefined;
    }
  | {
      type: "terminal.stdout";
      seq: number;
      data: string;
      byteCount: number;
    }
  | {
      type: "terminal.stderr";
      seq: number;
      data: string;
      byteCount: number;
    }
  | {
      type: "terminal.exit";
      seq: number;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      durationMs: number;
    }
  | {
      type: "terminal.error";
      seq: number;
      message: string;
      /** "spawn" = process could not be started; "stream" = read failure. */
      phase: "spawn" | "stream";
    }
  | {
      type: "terminal.cancelled";
      seq: number;
      durationMs: number;
    }
  | {
      type: "terminal.timeout";
      seq: number;
      timeoutMs: number;
      durationMs: number;
    };

/** Correlation mixin added by emitters (session/execution-scoped). */
export interface TerminalStreamCorrelation {
  /** CodePilot task identifier, when the host has one. */
  taskId?: string;
  /** Terminal execution id — for tools this is the tool executionId. */
  executionId: string;
  /** Unix timestamp (ms) of emission. */
  timestamp: number;
}

/** Fully-qualified terminal event handed to sinks. */
export type TerminalStreamEventWithCorrelation = TerminalStreamEvent &
  TerminalStreamCorrelation;

/** Typed event sink (UI/runtime forwarding). Never throws into the emitter. */
export type TerminalStreamSink = (
  event: TerminalStreamEventWithCorrelation,
) => void;

// ============================================================================
// UTF-8-safe incremental decoding
// ============================================================================

/**
 * Incremental UTF-8 decoder for a process output stream. Buffers partial
 * multi-byte sequences so a character split across two chunks decodes
 * correctly (a naive per-chunk toString("utf8") turns it into U+FFFD).
 */
export class Utf8StreamDecoder {
  private readonly decoder = new TextDecoder("utf-8");

  /**
   * Feed the next raw chunk. Returns the decoded text for this chunk,
   * holding back any trailing partial multi-byte sequence.
   */
  decode(chunk: Buffer | string): string {
    if (typeof chunk === "string") return chunk;
    return this.decoder.decode(chunk, { stream: true });
  }

  /** Flush any held-back partial sequence at end-of-stream. */
  end(): string {
    return this.decoder.decode();
  }
}

// ============================================================================
// Bounded head+tail retention with truncation metadata
// ============================================================================

export type TerminalRetentionPolicy = "head+tail";

/** Deterministic truncation metadata - always present when output was cut. */
export interface TerminalTruncation {
  truncated: true;
  policy: TerminalRetentionPolicy;
  /** Bytes kept from the beginning of the stream. */
  headBytes: number;
  /** Bytes kept from the end of the stream. */
  tailBytes: number;
  /** Total bytes produced by the stream before truncation. */
  totalBytes: number;
  /** Total bytes dropped by truncation. */
  droppedBytes: number;
  /** Marker string inserted between head and tail when both exist. */
  marker: string;
}

export interface TerminalRetentionResult {
  /** Retained text (bounded). Empty string when nothing was produced. */
  text: string;
  /** Truncation metadata; undefined when output fit within the cap. */
  truncation?: TerminalTruncation;
}

export const TRUNCATION_MARKER = "\n...[output truncated by CodePilot]...\n";

/**
 * Bounded retention buffer with a deterministic head+tail policy.
 *
 * - Total memory per stream never exceeds roughly `maxBytes + marker`.
 * - The beginning (head) and end (tail) of the output are preserved so a
 *   truncated result still shows startup diagnostics and the final error.
 * - `snapshot()` reports truncation explicitly - output is never silently
 *   discarded.
 */
export class TerminalRetentionBuffer {
  private readonly maxBytes: number;
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private totalBytes = 0;

  constructor(maxBytes: number) {
    if (!Number.isFinite(maxBytes) || maxBytes < 0) {
      throw new Error("TerminalRetentionBuffer: maxBytes must be >= 0");
    }
    this.maxBytes = maxBytes;
  }

  /** Total raw bytes observed (before truncation). */
  get totalSize(): number {
    return this.totalBytes;
  }

  /** Append one raw chunk (bytes counted before UTF-8 decoding). */
  append(chunk: Buffer | string): void {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (buf.length === 0) return;
    this.totalBytes += buf.length;
    if (this.maxBytes === 0) return; // retain nothing; truncation is total

    const markerBudget = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
    const halfCap = Math.max(0, Math.floor((this.maxBytes - markerBudget) / 2));

    if (this.head.length < halfCap) {
      const room = halfCap - this.head.length;
      if (buf.length <= room) {
        this.head = Buffer.concat([this.head, buf]);
      } else {
        this.head = Buffer.concat([this.head, buf.subarray(0, room)]);
        const tailRoom = Math.min(buf.length - room, halfCap);
        // Copy: buf may be a caller-reused view; tail must own its bytes and
        // match the declared Buffer<ArrayBuffer> field type.
        this.tail = Buffer.from(buf.subarray(buf.length - tailRoom));
      }
    } else {
      const keep = Math.min(buf.length, halfCap);
      const newTail =
        this.tail.length + keep <= halfCap
          ? Buffer.concat([this.tail, buf.subarray(buf.length - keep)])
          : Buffer.concat([
              this.tail.subarray(
                this.tail.length + keep - halfCap,
                this.tail.length,
              ),
              buf.subarray(buf.length - keep),
            ]);
      this.tail = newTail;
    }
  }

  /**
   * Fold the retained head/tail into the bounded result. Deterministic:
   * head first, marker, tail - or the exact head when nothing was dropped.
   */
  snapshot(): TerminalRetentionResult {
    if (this.totalBytes <= this.head.length + this.tail.length) {
      if (this.maxBytes === 0 && this.totalBytes > 0) {
        return {
          text: TRUNCATION_MARKER,
          truncation: {
            truncated: true,
            policy: "head+tail",
            headBytes: 0,
            tailBytes: 0,
            totalBytes: this.totalBytes,
            droppedBytes: this.totalBytes,
            marker: TRUNCATION_MARKER,
          },
        };
      }
      return { text: Buffer.concat([this.head, this.tail]).toString("utf8") };
    }
    const dropped = this.totalBytes - this.head.length - this.tail.length;
    return {
      text:
        this.head.toString("utf8") +
        TRUNCATION_MARKER +
        this.tail.toString("utf8"),
      truncation: {
        truncated: true,
        policy: "head+tail",
        headBytes: this.head.length,
        tailBytes: this.tail.length,
        totalBytes: this.totalBytes,
        droppedBytes: dropped,
        marker: TRUNCATION_MARKER,
      },
    };
  }

  /** Whether truncation currently applies (introspection for tests). */
  get isTruncating(): boolean {
    return this.totalBytes > this.head.length + this.tail.length;
  }
}

// ============================================================================
// Per-execution event sequence
// ============================================================================

/**
 * Monotonic per-execution sequence counter. `next()` returns 1, 2, 3, ... in
 * emission order - consumers rely on it for ordering, so it must never be
 * incremented outside the emission path.
 */
export class TerminalSequence {
  private seq = 0;
  next(): number {
    this.seq += 1;
    return this.seq;
  }
  get value(): number {
    return this.seq;
  }
}
