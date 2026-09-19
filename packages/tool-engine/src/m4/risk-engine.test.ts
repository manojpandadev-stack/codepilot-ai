/**
 * RiskEngine tests: deterministic risk assessment for tool actions.
 */
import { describe, it, expect } from "vitest";
import { RiskEngine } from "./risk-engine.js";

describe("RiskEngine", () => {
  const engine = new RiskEngine();

  it("assesses read_file as low risk", () => {
    const risk = engine.assess("read_file", {});
    expect(risk.level).toBe("low");
  });

  it("assesses list_directory as low risk", () => {
    const risk = engine.assess("list_directory", {});
    expect(risk.level).toBe("low");
  });

  it("assesses write_file as medium risk", () => {
    const risk = engine.assess("write_file", {});
    expect(risk.level).toBe("medium");
  });

  it("assesses delete_file as high risk", () => {
    const risk = engine.assess("delete_file", {});
    expect(risk.level).toBe("high");
  });

  it("assesses execute_command as high risk", () => {
    const risk = engine.assess("execute_command", {});
    expect(risk.level).toBe("high");
  });

  it("assesses rm -rf as critical risk", () => {
    const risk = engine.assess("execute_command", { command: "rm -rf /" });
    expect(risk.level).toBe("critical");
  });

  it("is deterministic — same inputs produce same output", () => {
    const a = engine.assess("write_file", { path: "src/foo.ts" });
    const b = engine.assess("write_file", { path: "src/foo.ts" });
    expect(a).toEqual(b);
  });

  it("includes reasons for the risk assessment", () => {
    const risk = engine.assess("delete_file", {});
    expect(risk.reasons.length).toBeGreaterThan(0);
  });

  it("detects recursive delete as destructive", () => {
    const risk = engine.assess("delete_file", { recursive: true });
    expect(risk.destructive).toBe(true);
  });

  it("detects outside workspace operations as critical", () => {
    const risk = engine.assess("delete_file", { outsideWorkspace: true });
    expect(risk.level).toBe("critical");
  });

  it("is destructive for critical commands", () => {
    const risk = engine.assess("execute_command", { command: "rm -rf /" });
    expect(risk.destructive).toBe(true);
  });
});
