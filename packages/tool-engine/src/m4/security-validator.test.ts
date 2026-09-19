/**
 * SecurityValidator tests: workspace boundary, path safety, and command validation.
 * Note: SecurityValidator validates paths (workspace boundary) and redacts secrets
 * from commands. Command SAFETY (blocking rm -rf etc.) is handled by RiskEngine,
 * not SecurityValidator. SecurityValidator ensures paths stay within workspace.
 */
import { describe, it, expect } from "vitest";
import { SecurityValidator } from "./security-validator.js";

describe("SecurityValidator", () => {
  const validator = new SecurityValidator({ workspaceRoot: "/workspace" });

  it("allows reads within workspace", () => {
    const result = validator.validate("read_file", { path: "src/foo.ts" });
    expect(result.allowed).toBe(true);
  });

  it("blocks path traversal attempts", () => {
    const result = validator.validate("read_file", {
      path: "../../../etc/passwd",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("boundary");
  });

  it("blocks absolute paths (outside workspace)", () => {
    const result = validator.validate("write_file", { path: "/etc/hosts" });
    expect(result.allowed).toBe(false);
  });

  it("allows writes within workspace", () => {
    const result = validator.validate("write_file", { path: "output/log.txt" });
    expect(result.allowed).toBe(true);
  });

  it("allows commands (safety is RiskEngine's job)", () => {
    const result = validator.validate("execute_command", {
      command: "rm -rf /",
    });
    expect(result.allowed).toBe(true);
  });

  it("allows safe commands", () => {
    const result = validator.validate("execute_command", {
      command: "npm test",
    });
    expect(result.allowed).toBe(true);
  });

  it("redacts secrets from commands", () => {
    const result = validator.validate("execute_command", {
      command: "curl -H 'Bearer sk-abc123def456' http://api.example.com",
    });
    expect(result.allowed).toBe(true);
    expect(result.sanitizedPreview?.command).toContain("[REDACTED]");
  });

  it("rejects empty commands", () => {
    const result = validator.validate("execute_command", { command: "" });
    expect(result.allowed).toBe(false);
  });

  it("rejects empty paths", () => {
    const result = validator.validate("read_file", { path: "" });
    expect(result.allowed).toBe(false);
  });

  it("allows delete within workspace", () => {
    const result = validator.validate("delete_file", { path: "temp/file.txt" });
    expect(result.allowed).toBe(true);
  });

  it("blocks delete with absolute path", () => {
    const result = validator.validate("delete_file", {
      path: "/var/log/syslog",
    });
    expect(result.allowed).toBe(false);
  });

  it("blocks Windows drive paths", () => {
    const result = validator.validate("read_file", {
      path: "C:\\Windows\\System32",
    });
    expect(result.allowed).toBe(false);
  });

  it("blocks UNC paths", () => {
    const result = validator.validate("read_file", {
      path: "\\\\server\\share\\file.txt",
    });
    expect(result.allowed).toBe(false);
  });

  it("blocks sensitive file access (.env)", () => {
    const result = validator.validate("read_file", { path: ".env" });
    expect(result.allowed).toBe(false);
  });

  it("blocks sensitive file access (.ssh/id_rsa)", () => {
    const result = validator.validate("read_file", { path: ".ssh/id_rsa" });
    expect(result.allowed).toBe(false);
  });

  it("blocks sensitive file access (.ssh/config) — Windows separator", () => {
    const result = validator.validate("read_file", { path: ".ssh/config" });
    expect(result.allowed).toBe(false);
  });

  it("blocks sensitive file access (.aws/credentials) — Windows separator", () => {
    const result = validator.validate("read_file", { path: ".aws/credentials" });
    expect(result.allowed).toBe(false);
  });

  it("blocks sensitive file access (.aws/config) — Windows separator", () => {
    const result = validator.validate("read_file", { path: ".aws/config" });
    expect(result.allowed).toBe(false);
  });

  it("blocks sensitive file access (.azure/accessTokens.json) — Windows separator", () => {
    const result = validator.validate("read_file", {
      path: ".azure/accessTokens.json",
    });
    expect(result.allowed).toBe(false);
  });

  it("blocks sensitive file access (.claude-code-router/config.json) — Windows separator", () => {
    const result = validator.validate("read_file", {
      path: ".claude-code-router/config.json",
    });
    expect(result.allowed).toBe(false);
  });
});
