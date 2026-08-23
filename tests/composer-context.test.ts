import { describe, it, expect } from "vitest";
import {
  mapVsCodeSeverity,
  toDiagnosticItems,
  formatDiagnosticsForAgent,
  formatDiagnosticLine,
  isLikelyBinaryFile,
  toRelativeWorkspacePath,
  healingPhaseLabel,
  healingNextActionLabel,
  describeValidationFailure,
} from "../packages/shared/src/index.js";
import {
  createEmptyComposerContext,
  addFileEntriesToContext,
  addFolderEntriesToContext,
  setProblemsInContext,
  setSelectionInContext,
  removeContextEntry,
  contextToChips,
  buildChatSendPayload,
  buildRetryPayload,
  shouldSendOnKeydown,
  reduceHealingState,
} from "../apps/webview/src/lib/messages.js";

// ============================================================================
// PART 2/7 — File picker + file context
// ============================================================================

describe("File context", () => {
  it("adds selected files as structured context, not user text", () => {
    let ctx = createEmptyComposerContext();
    ctx = addFileEntriesToContext(ctx, [{ relativePath: "package.json", name: "package.json" }]);
    const payload = buildChatSendPayload("Explain the architecture of this file.", "act", ctx);
    expect(payload.text).toBe("Explain the architecture of this file.");
    expect(payload.text).not.toContain("package.json");
    expect(payload.context?.files).toHaveLength(1);
    expect(payload.context?.files?.[0]?.relativePath).toBe("package.json");
  });

  it("supports multiple files and dedupes by relative path", () => {
    let ctx = createEmptyComposerContext();
    ctx = addFileEntriesToContext(ctx, [
      { relativePath: "a.ts" }, { relativePath: "b.ts" }, { relativePath: "a.ts" },
    ]);
    expect(ctx.files).toHaveLength(2);
  });

  it("normalizes backslash paths from the host", () => {
    let ctx = createEmptyComposerContext();
    ctx = addFileEntriesToContext(ctx, [{ relativePath: "src\\main.ts" }]);
    expect(ctx.files[0]?.relativePath).toBe("src/main.ts");
  });

  it("marks binary files as metadata, not prompt content", () => {
    expect(isLikelyBinaryFile("logo.png")).toBe(true);
    expect(isLikelyBinaryFile("App.tsx")).toBe(false);
    expect(isLikelyBinaryFile("Makefile")).toBe(false);
  });

  it("enforces workspace boundaries when converting host paths", () => {
    expect(toRelativeWorkspacePath("C:\\proj", "C:\\proj\\src\\a.ts")).toBe("src/a.ts");
    expect(toRelativeWorkspacePath("/ws", "/ws/src/a.ts")).toBe("src/a.ts");
    expect(toRelativeWorkspacePath("/ws", "/etc/passwd")).toBeNull();
  });

  it("removing a file chip does not touch the user message", () => {
    let ctx = createEmptyComposerContext();
    ctx = addFileEntriesToContext(ctx, [{ relativePath: "a.ts" }, { relativePath: "b.ts" }]);
    const chip = contextToChips(ctx).find((c) => c.ref === "a.ts");
    expect(chip).toBeDefined();
    ctx = removeContextEntry(ctx, chip!.id);
    expect(ctx.files.map((f) => f.relativePath)).toEqual(["b.ts"]);
    expect(buildChatSendPayload("hello", "act", ctx).text).toBe("hello");
  });
});

// ============================================================================
// PART 3/4/15 — Problems context (real diagnostics)
// ============================================================================

describe("Problems context", () => {
  const raw = [
    { file: "src/GreetingService.java", line: 12, column: 5, severity: 0, message: "Cannot resolve symbol 'GreetingService'", source: "javac" },
    { file: "src/a.ts", line: 3, column: 1, severity: 1, message: "'x' is declared but never used", source: "ts" },
    { file: "src/b.ts", line: 8, column: 2, severity: 2, message: "Prefer const", source: "eslint" },
    { file: "src/c.ts", line: 1, column: 1, severity: 8, message: "Unused hint" },
    { file: "src/dup.ts", line: 1, column: 1, severity: 0, message: "dup" },
    { file: "src/dup.ts", line: 1, column: 1, severity: 0, message: "dup" },
  ];

  it("maps VS Code severities correctly (0/1/2/8)", () => {
    expect(mapVsCodeSeverity(0)).toBe("Error");
    expect(mapVsCodeSeverity(1)).toBe("Warning");
    expect(mapVsCodeSeverity(2)).toBe("Information");
    expect(mapVsCodeSeverity(8)).toBe("Hint");
    expect(mapVsCodeSeverity(99)).toBe("Information");
  });

  it("converts raw diagnostics into structured items with dedup", () => {
    const items = toDiagnosticItems(raw);
    expect(items).toHaveLength(5);
    expect(items[0]).toMatchObject({
      file: "src/GreetingService.java", line: 12, column: 5,
      severity: "Error", source: "javac",
    });
  });

  it("formats a diagnostic line with file:line:col and severity", () => {
    const line = formatDiagnosticLine({
      file: "src/main/java/GreetingService.java", line: 12, column: 5,
      severity: "Error", message: "Cannot resolve symbol 'GreetingService'", source: "javac",
    });
    expect(line).toBe("src/main/java/GreetingService.java:12:5 [ERROR] Cannot resolve symbol 'GreetingService' (javac)");
  });

  it("zero diagnostics produces a clean-state block, not an error", () => {
    const block = formatDiagnosticsForAgent({ scope: "workspace", items: [] });
    expect(block).toContain("no problems detected");
    expect(block).toContain("zero");
  });

  it("multiple diagnostics produce a structured agent block", () => {
    const items = toDiagnosticItems(raw);
    const block = formatDiagnosticsForAgent({ scope: "workspace", items });
    expect(block).toContain("VS Code Problems (workspace) — 5 total:");
    expect(block).toContain("[ERROR]");
    expect(block).toContain("[WARN]");
    expect(block).toContain("[INFO]");
    expect(block).toContain("[HINT]");
    // Errors sort first
    expect(block.indexOf("[ERROR]")).toBeLessThan(block.indexOf("[WARN]"));
  });

  it("@problem never becomes the user message; problems become metadata", () => {
    let ctx = createEmptyComposerContext();
    ctx = setProblemsInContext(ctx, { scope: "workspace", items: toDiagnosticItems(raw) });
    const payload = buildChatSendPayload("Fix the current problems.", "act", ctx);
    expect(payload.text).toBe("Fix the current problems.");
    expect(payload.text).not.toContain("@problem");
    expect(payload.context?.diagnostics?.items).toHaveLength(5);
    expect(contextToChips(ctx).some((c) => c.label.startsWith("⚠ Problems (5)"))).toBe(true);
  });

  it("zero-problems chip shows a check state and does not fail the chat", () => {
    let ctx = createEmptyComposerContext();
    ctx = setProblemsInContext(ctx, { scope: "workspace", items: [] });
    const chips = contextToChips(ctx);
    expect(chips.some((c) => c.label === "✓ Problems: 0")).toBe(true);
    const payload = buildChatSendPayload("hello", "act", ctx);
    expect(payload.text).toBe("hello");
  });

  it("problems chip can be removed", () => {
    let ctx = createEmptyComposerContext();
    ctx = setProblemsInContext(ctx, { scope: "workspace", items: toDiagnosticItems(raw) });
    ctx = removeContextEntry(ctx, "problems");
    expect(ctx.diagnostics).toBeNull();
    expect(contextToChips(ctx)).toHaveLength(0);
  });
});

// ============================================================================
// PART 5/6/8/13/14 — Context architecture, chips, selection, composer
// ============================================================================

describe("Context architecture", () => {
  it("folders and selection are structured metadata", () => {
    let ctx = createEmptyComposerContext();
    ctx = addFolderEntriesToContext(ctx, [{ relativePath: "src/backend" }]);
    ctx = setSelectionInContext(ctx, { filePath: "src/GreetingService.java", startLine: 10, endLine: 20 });
    const payload = buildChatSendPayload("Review this", "act", ctx);
    expect(payload.context?.folders?.[0]?.relativePath).toBe("src/backend");
    expect(payload.context?.selection).toMatchObject({ filePath: "src/GreetingService.java", startLine: 10, endLine: 20 });
    expect(payload.text).toBe("Review this");
  });

  it("selection chip renders file + line range", () => {
    let ctx = createEmptyComposerContext();
    ctx = setSelectionInContext(ctx, { filePath: "src/GreetingService.java", startLine: 10, endLine: 20 });
    const chips = contextToChips(ctx);
    expect(chips[0]?.label).toBe("📝 Selection: GreetingService.java L10–20");
  });

  it("single-line selection chip shows one line number", () => {
    let ctx = createEmptyComposerContext();
    ctx = setSelectionInContext(ctx, { filePath: "a.ts", startLine: 5, endLine: 5 });
    expect(contextToChips(ctx)[0]?.label).toBe("📝 Selection: a.ts L5");
  });

  it("context is sent exactly once with only non-empty fields", () => {
    let ctx = createEmptyComposerContext();
    ctx = addFileEntriesToContext(ctx, [{ relativePath: "src/unique-file.ts" }]);
    const payload = buildChatSendPayload("hi", "act", ctx);
    // One context entry, never duplicated, never leaked into the user text.
    expect(payload.context?.files).toHaveLength(1);
    expect(payload.text).not.toContain("unique-file");
    expect(JSON.stringify(payload)?.match(/unique-file\.ts/g)).toHaveLength(2); // relativePath + name only
    expect(Object.keys(payload.context ?? {})).toEqual(["files"]);
  });

  it("empty context serializes to an empty object", () => {
    const payload = buildChatSendPayload("hi", "act", createEmptyComposerContext());
    expect(payload.context).toEqual({});
  });

  it("retry payload contains only the original text — no stale context", () => {
    const retry = buildRetryPayload("original question");
    expect(retry).toEqual({ text: "original question" });
    expect(JSON.stringify(retry)).not.toContain("context");
  });

  it("Enter sends exactly once; Shift+Enter does not", () => {
    expect(shouldSendOnKeydown("Enter", false)).toBe(true);
    expect(shouldSendOnKeydown("Enter", true)).toBe(false);
    expect(shouldSendOnKeydown("a", false)).toBe(false);
  });
});

// ============================================================================
// PART 11/12/16 — Self-healing status
// ============================================================================

describe("Self-healing status", () => {
  it("every event updates ONE status object (no duplicate messages)", () => {
    let state = reduceHealingState(null, { kind: "started", attempt: 1, maxAttempts: 3, exitCode: 1, command: "mvn test", stderrExcerpt: "GreetingServiceTest.testGreet expected:<Hi, World!> but was:<Hello, World!>" });
    expect(state.active).toBe(true);
    expect(state.failureDetail).toContain("exit code 1");
    expect(state.failureDetail).toContain("mvn test");

    state = reduceHealingState(state, { kind: "progress", phase: "diagnosis_started", attempt: 1 });
    expect(state.phase).toBe("diagnosis_started");

    state = reduceHealingState(state, { kind: "progress", phase: "repair_started", attempt: 1 });
    expect(state.phase).toBe("repair_started");

    state = reduceHealingState(state, { kind: "progress", phase: "validation_started", attempt: 2 });
    expect(state.attempt).toBe(2);
    expect(state.phase).toBe("validation_started");
  });

  it("phase labels are human-readable, never raw internal ids", () => {
    expect(healingPhaseLabel("diagnosis_started")).toBe("Diagnosis started");
    expect(healingPhaseLabel("validation_failed")).toBe("Validation failed");
    expect(healingNextActionLabel("validation_failed")).toBe("Analyzing failure…");
    expect(healingNextActionLabel("repair_started")).toBe("Applying fix…");
    expect(healingNextActionLabel("repair_completed")).toBe("Re-running validation…");
    expect(healingNextActionLabel("validation_passed")).toBe("All checks green.");
  });

  it("succeeded state closes the status with attempt count", () => {
    let state = reduceHealingState(null, { kind: "started", attempt: 1, maxAttempts: 3 });
    state = reduceHealingState(state, { kind: "succeeded", attempt: 2, durationMs: 4200 });
    expect(state.active).toBe(false);
    expect(state.success).toBe(true);
    expect(state.message).toContain("2 attempts");
    expect(state.message).toContain("4200ms");
  });

  it("exhausted state reports manual intervention needed", () => {
    let state = reduceHealingState(null, { kind: "started", attempt: 1, maxAttempts: 3 });
    state = reduceHealingState(state, { kind: "exhausted", maxAttempts: 3 });
    expect(state.active).toBe(false);
    expect(state.success).toBe(false);
    expect(state.message).toContain("3 attempts");
    expect(state.message).toContain("manual intervention");
  });

  it("validation failure description includes command and stderr excerpt", () => {
    const text = describeValidationFailure({
      exitCode: 1,
      command: "mvn test",
      stderr: "GreetingServiceTest.testGreet:49 expected:<Hi, World!> but was:<Hello, World!>",
    });
    expect(text).toContain("Validation failed (exit 1)");
    expect(text).toContain("Command: mvn test");
    expect(text).toContain("GreetingServiceTest.testGreet");
  });
});
