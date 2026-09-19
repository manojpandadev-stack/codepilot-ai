/**
 * Terminal webview boundary tests (Phase 17) — pure message/state contract:
 * strict validation, bounded appends with stale/duplicate defense, and
 * completion detail shaping. No React renderer needed; App.tsx reduces
 * through exactly these helpers.
 */
import { describe, expect, it } from "vitest";
import {
  validateTerminalOutput,
  appendTerminalOutput,
  terminalCompletionDetail,
  isTerminalToolName,
  MAX_TERMINAL_LIVE_BUFFER,
  MAX_TERMINAL_DETAIL_CHARS,
} from "../apps/webview/src/lib/messages.js";

function validChunk(overrides: Record<string, unknown> = {}) {
  return {
    toolCallId: "call-1",
    toolName: "bash",
    stream: "stdout",
    data: "hello",
    seq: 2,
    executionId: "call-1",
    requestId: "req-1",
    ...overrides,
  };
}

describe("validateTerminalOutput", () => {
  it("accepts a well-formed chunk", () => {
    expect(validateTerminalOutput(validChunk())).toMatchObject({
      toolCallId: "call-1",
      toolName: "bash",
      stream: "stdout",
      data: "hello",
      seq: 2,
    });
  });

  it("rejects malformed payloads safely", () => {
    expect(validateTerminalOutput(null)).toBeNull();
    expect(validateTerminalOutput(undefined)).toBeNull();
    expect(validateTerminalOutput("chunk")).toBeNull();
    expect(validateTerminalOutput({})).toBeNull();
    expect(validateTerminalOutput(validChunk({ toolCallId: "" }))).toBeNull();
    expect(validateTerminalOutput(validChunk({ stream: "stdin" }))).toBeNull();
    expect(validateTerminalOutput(validChunk({ stream: "STDOUT" }))).toBeNull();
    expect(validateTerminalOutput(validChunk({ data: "" }))).toBeNull();
    expect(validateTerminalOutput(validChunk({ data: 42 }))).toBeNull();
    expect(validateTerminalOutput(validChunk({ seq: 0 }))).toBeNull();
    expect(validateTerminalOutput(validChunk({ seq: 1.5 }))).toBeNull();
    expect(validateTerminalOutput(validChunk({ seq: "2" }))).toBeNull();
    expect(validateTerminalOutput(validChunk({ toolCallId: "x".repeat(201) }))).toBeNull();
  });

  it("bounds per-chunk data at the boundary", () => {
    const big = validChunk({ data: "y".repeat(100_000), seq: 3 });
    const parsed = validateTerminalOutput(big);
    expect(parsed).not.toBeNull();
    expect(parsed!.data.length).toBeLessThanOrEqual(65_536);
  });
});

describe("appendTerminalOutput", () => {
  it("appends newer chunks in order", () => {
    let state = { output: "", outputTruncated: false, lastSeq: 0 };
    state = appendTerminalOutput(state, validateTerminalOutput(validChunk({ data: "a", seq: 1 }))!);
    state = appendTerminalOutput(state, validateTerminalOutput(validChunk({ data: "b", seq: 2 }))!);
    expect(state).toMatchObject({ output: "ab", outputTruncated: false, lastSeq: 2 });
  });

  it("drops stale and duplicate sequences", () => {
    let state = { output: "ab", outputTruncated: false, lastSeq: 2 };
    const stale = validateTerminalOutput(validChunk({ data: "OLD", seq: 1 }))!;
    const dupe = validateTerminalOutput(validChunk({ data: "OLD", seq: 2 }))!;
    expect(appendTerminalOutput(state, stale)).toBe(state);
    expect(appendTerminalOutput(state, dupe)).toBe(state);
  });

  it("truncates deterministically past the cap, keeping head and tail", () => {
    const cap = 1000;
    let state = { output: "", outputTruncated: false, lastSeq: 0 };
    state = appendTerminalOutput(
      state,
      validateTerminalOutput(validChunk({ data: "H".repeat(800), seq: 1 }))!,
      cap,
    );
    expect(state.outputTruncated).toBe(false);
    state = appendTerminalOutput(
      state,
      validateTerminalOutput(validChunk({ data: "T".repeat(800), seq: 2 }))!,
      cap,
    );
    expect(state.outputTruncated).toBe(true);
    expect(state.output).toContain("H".repeat(10));
    expect(state.output).toContain("T".repeat(10));
    expect(state.output).toContain("truncated");
    expect(state.output.length).toBeLessThanOrEqual(cap + 100);
  });

  it("default cap matches the exported constant", () => {
    expect(MAX_TERMINAL_LIVE_BUFFER).toBe(100_000);
    let state = { output: "", outputTruncated: false, lastSeq: 0 };
    // Validator slices chunks to 64k first: two max chunks exceed the cap.
    state = appendTerminalOutput(
      state,
      validateTerminalOutput(validChunk({ data: "z".repeat(100_000), seq: 1 }))!,
    );
    expect(state.outputTruncated).toBe(false);
    state = appendTerminalOutput(
      state,
      validateTerminalOutput(validChunk({ data: "z".repeat(100_000), seq: 2 }))!,
    );
    expect(state.outputTruncated).toBe(true);
  });
});

describe("terminalCompletionDetail", () => {
  it("covers every terminal tool name", () => {
    for (const name of ["execute_command", "run_command", "run_commands", "bash", "terminal"]) {
      expect(isTerminalToolName(name)).toBe(true);
      expect(terminalCompletionDetail(name, "out").detail).toBe("out");
    }
  });

  it("leaves non-terminal tools untouched", () => {
    expect(isTerminalToolName("read_file")).toBe(false);
    expect(terminalCompletionDetail("read_file", "out")).toEqual({});
  });

  it("renders objects as bounded JSON, empties as nothing", () => {
    expect(terminalCompletionDetail("bash", null)).toEqual({});
    expect(terminalCompletionDetail("bash", undefined)).toEqual({});
    expect(terminalCompletionDetail("bash", "").detail).toBeUndefined();
    const detail = terminalCompletionDetail("bash", { exitCode: 0 })?.detail ?? "";
    expect(detail).toContain("exitCode");
  });

  it("bounds detail text explicitly", () => {
    expect(MAX_TERMINAL_DETAIL_CHARS).toBe(20_000);
    const detail = terminalCompletionDetail("bash", "q".repeat(30_000))?.detail ?? "";
    expect(detail.length).toBeLessThanOrEqual(MAX_TERMINAL_DETAIL_CHARS + 100);
    expect(detail).toContain("truncated");
  });
});
