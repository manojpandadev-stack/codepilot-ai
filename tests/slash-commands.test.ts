import { describe, it, expect } from "vitest";
import {
  parseSlashCommand,
  SLASH_COMMANDS,
  filterSlashCommands,
} from "../apps/webview/src/lib/messages.js";

// ============================================================================
// Feature Group 3 — slash command system (real operations only)
// ============================================================================

describe("parseSlashCommand", () => {
  it("parses mode commands with a task", () => {
    const r = parseSlashCommand("/plan add auth");
    expect(r.command).toBe("plan");
    expect(r.prompt).toBe("add auth");
  });

  it("parses template commands with a task instruction", () => {
    const r = parseSlashCommand("/explain the DI container");
    expect(r.command).toBe("explain");
    expect(r.prompt).toBe("the DI container");
    expect(r.instruction).toContain("Explain");
  });

  it("resolves a real mode + instruction for every template command", () => {
    for (const def of SLASH_COMMANDS) {
      if (def.uiOnly) continue;
      const r = parseSlashCommand(`/${def.command} task`);
      expect(r.command, def.command).toBe(def.command);
      expect(r.prompt).toBe("task");
      if (def.mode) {
        expect(["plan", "act", "ask", "auto", "review"]).toContain(def.mode);
      }
    }
  });

  it("leaves unknown input untouched", () => {
    const r = parseSlashCommand("/nonexistent foo");
    expect(r.command).toBe("");
    expect(r.prompt).toBe("/nonexistent foo");
    expect(r.instruction).toBe("");
  });

  it("does not treat plain text as a command", () => {
    const r = parseSlashCommand("Fix the bug please");
    expect(r.command).toBe("");
    expect(r.prompt).toBe("Fix the bug please");
  });
});

describe("filterSlashCommands", () => {
  it("returns all commands for an empty prefix", () => {
    expect(filterSlashCommands("").length).toBe(SLASH_COMMANDS.length);
  });

  it("filters by prefix", () => {
    const names = filterSlashCommands("ex").map((c) => c.command);
    expect(names).toContain("explain");
    expect(names).not.toContain("clear");
  });

  it("exposes only real, documented commands", () => {
    const names = SLASH_COMMANDS.map((c) => c.command);
    for (const required of ["plan", "act", "ask", "review", "auto", "clear", "help", "explain", "fix", "test", "refactor", "docs", "search", "compact"]) {
      expect(names, required).toContain(required);
    }
  });
});