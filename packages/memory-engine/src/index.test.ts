import { describe, it, expect } from "vitest";
import { MemoryEngine, MemoryEngine as ME } from "./index.js";

describe("MemoryEngine", () => {
  it("stores and retrieves project memory", () => {
    const engine = new MemoryEngine();
    const entry = engine.set(
      "project",
      "architecture",
      "Spring Boot microservice",
    );
    expect(entry.key).toBe("architecture");
    expect(entry.scope).toBe("project");
    expect(entry.value).toBe("Spring Boot microservice");

    const retrieved = engine.get("project", "architecture");
    expect(retrieved).toBeDefined();
    expect(retrieved!.value).toBe("Spring Boot microservice");
  });

  it("stores and retrieves user memory", () => {
    const engine = new MemoryEngine();
    engine.set("user", "preferred_framework", "Spring Boot");
    engine.set("user", "java_version", "21");

    const retrieved = engine.get("user", "preferred_framework");
    expect(retrieved!.value).toBe("Spring Boot");
  });

  it("overwrites existing entry with same key", () => {
    const engine = new MemoryEngine();
    engine.set("project", "config", "v1");
    const updated = engine.set("project", "config", "v2");
    expect(updated.value).toBe("v2");
    expect(updated.updatedAt).toBeGreaterThanOrEqual(updated.createdAt);
  });

  it("query filters by scope", () => {
    const engine = new MemoryEngine();
    engine.set("project", "arch", "Spring Boot");
    engine.set("user", "style", "Kotlin");
    engine.set("task", "attempt", "v1");

    const projectEntries = engine.query({ scope: "project" });
    expect(projectEntries.length).toBe(1);
    expect(projectEntries[0]!.key).toBe("arch");
  });

  it("query filters by tags", () => {
    const engine = new MemoryEngine();
    engine.set("project", "arch", "Spring Boot", { tags: ["java", "backend"] });
    engine.set("project", "frontend", "React", { tags: ["frontend"] });

    const javaEntries = engine.query({ tags: ["java"] });
    expect(javaEntries.length).toBe(1);
    expect(javaEntries[0]!.key).toBe("arch");
  });

  it("query filters by key prefix", () => {
    const engine = new MemoryEngine();
    engine.set("project", "auth.method", "JWT");
    engine.set("project", "auth.expiry", "24h");
    engine.set("project", "db.url", "localhost");

    const authEntries = engine.query({ keyPrefix: "auth." });
    expect(authEntries.length).toBe(2);
  });

  it("query respects limit", () => {
    const engine = new MemoryEngine();
    for (let i = 0; i < 10; i++) {
      engine.set("project", `key-${i}`, `value-${i}`);
    }

    const limited = engine.query({ limit: 3 });
    expect(limited.length).toBe(3);
  });

  it("deletes memory entries", () => {
    const engine = new MemoryEngine();
    engine.set("project", "to-delete", "value");
    expect(engine.get("project", "to-delete")).toBeDefined();

    const deleted = engine.delete("project", "to-delete");
    expect(deleted).toBe(true);
    expect(engine.get("project", "to-delete")).toBeUndefined();
  });

  it("delete returns false for non-existent entries", () => {
    const engine = new MemoryEngine();
    const result = engine.delete("project", "nonexistent");
    expect(result).toBe(false);
  });

  it("clearScope removes all entries in scope", () => {
    const engine = new MemoryEngine();
    engine.set("project", "a", "1");
    engine.set("project", "b", "2");
    engine.set("user", "c", "3");

    const count = engine.clearScope("project");
    expect(count).toBe(2);
    expect(engine.query({ scope: "project" }).length).toBe(0);
    expect(engine.query({ scope: "user" }).length).toBe(1);
  });

  it("exports and imports memory entries", () => {
    const engine = new MemoryEngine();
    engine.set("project", "a", "1");
    engine.set("user", "b", "2");

    const exported = engine.export();
    expect(exported.length).toBe(2);

    const engine2 = new MemoryEngine();
    engine2.import(exported);
    expect(engine2.get("project", "a")?.value).toBe("1");
    expect(engine2.get("user", "b")?.value).toBe("2");
  });

  it("getSummaryForPrompt generates useful prompt text", () => {
    const engine = new MemoryEngine();
    engine.set("project", "stack", "Spring Boot + React");
    engine.set("user", "style", "Kotlin-first");

    const summary = engine.getSummaryForPrompt();
    expect(summary).toContain("## Project Memory");
    expect(summary).toContain("## User Preferences");
    expect(summary).toContain("Spring Boot + React");
    expect(summary).toContain("Kotlin-first");
  });

  it("sanitizeValue redacts secrets", () => {
    const apiResult = ME.sanitizeValue("api_key=sk-1234567890");
    expect(apiResult).toContain("[REDACTED]");
    expect(apiResult).not.toContain("sk-1234567890");
    const passResult = ME.sanitizeValue("password: hunter2");
    expect(passResult).toContain("[REDACTED]");
    expect(passResult).not.toContain("hunter2");
    const bearerResult = ME.sanitizeValue("bearer abc123");
    expect(bearerResult).toContain("[REDACTED]");
    expect(bearerResult).not.toContain("abc123");
    expect(ME.sanitizeValue("normal text")).toBe("normal text");
  });

  it("does not store entries with secrets when sanitized", () => {
    const engine = new MemoryEngine();
    const safeValue = MemoryEngine.sanitizeValue("my api key is sk-abc123xyz");
    engine.set("project", "api_note", safeValue);
    expect(engine.get("project", "api_note")!.value).toContain("[REDACTED]");
  });

  it("handles expired entries in query", () => {
    const engine = new MemoryEngine();
    engine.set("task", "temp", "data", { expiresAt: Date.now() - 1000 });
    engine.set("task", "permanent", "data");

    const results = engine.query({ scope: "task" });
    expect(results.length).toBe(1);
    expect(results[0]!.key).toBe("permanent");
  });
});
