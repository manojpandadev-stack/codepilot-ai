import { describe, it, expect } from "vitest";
import {
  createRepositoryAnalysisTool,
  createCodeReviewTool,
  createTestIntelligenceTool,
  createCodePilotTools,
} from "./index.js";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

describe("Tool Engine", () => {
  describe("Repository Analysis Tool", () => {
    it("creates tool with correct schema", () => {
      const tool = createRepositoryAnalysisTool("/test");
      expect(tool).toBeDefined();
    });

    it("analyzes a simple directory structure", async () => {
      // Create a temp directory with known structure
      const tmpDir = path.join(os.tmpdir(), `codepilot-test-${Date.now()}`);
      await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
      await fs.writeFile(path.join(tmpDir, "pom.xml"), "<project/>");
      await fs.writeFile(
        path.join(tmpDir, "src", "Main.java"),
        "class Main {}",
      );
      await fs.writeFile(path.join(tmpDir, "README.md"), "# Test");

      try {
        const tool = createRepositoryAnalysisTool(tmpDir);
        const result = (await tool.execute({ depth: 3 })) as {
          languages: Record<string, number>;
          frameworks: string[];
          buildTools: string[];
          totalFiles: number;
        };

        expect(result.languages["Java"]).toBe(1);
        expect(result.languages["Markdown"]).toBe(1);
        expect(result.frameworks).toContain("Java/Spring Boot");
        expect(result.buildTools).toContain("Maven");
        expect(result.totalFiles).toBe(3); // pom.xml + Main.java + README.md
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("Code Review Tool", () => {
    it("detects eval() as critical security issue", async () => {
      const tool = createCodeReviewTool("/test");
      const result = (await tool.execute({
        filePath: "test.js",
        content: 'eval(userInput);\nconsole.log("done");',
        language: "javascript",
      })) as { findings: Array<{ severity: string; category: string }> };

      expect(result.findings.length).toBeGreaterThanOrEqual(1);
      const evalFinding = result.findings.find(
        (f) => f.severity === "critical",
      );
      expect(evalFinding).toBeDefined();
      expect(evalFinding!.category).toBe("security");
    });

    it("detects console.log as low severity", async () => {
      const tool = createCodeReviewTool("/test");
      const result = (await tool.execute({
        filePath: "test.js",
        content: 'console.log("debug");',
      })) as { findings: Array<{ severity: string }> };

      expect(result.findings.length).toBe(1);
      expect(result.findings[0]!.severity).toBe("low");
    });

    it("detects TODO/FIXME markers", async () => {
      const tool = createCodeReviewTool("/test");
      const result = (await tool.execute({
        filePath: "test.ts",
        content: "// TODO: implement this\n// FIXME: broken",
      })) as { findings: Array<{ severity: string }> };

      expect(result.findings.length).toBe(2);
    });

    it("returns no findings for clean code", async () => {
      const tool = createCodeReviewTool("/test");
      const result = (await tool.execute({
        filePath: "test.ts",
        content:
          "export function add(a: number, b: number) {\n  return a + b;\n}",
      })) as { findings: unknown[] };

      expect(result.findings.length).toBe(0);
    });

    it("returns error for missing content", async () => {
      const tool = createCodeReviewTool("/test");
      const result = (await tool.execute({})) as { error?: string };
      expect(result.error).toBeDefined();
    });
  });

  describe("Test Intelligence Tool", () => {
    it("creates tool correctly", () => {
      const tool = createTestIntelligenceTool("/test");
      expect(tool).toBeDefined();
    });
  });

  describe("createCodePilotTools", () => {
    it("returns array of tools", () => {
      const tools = createCodePilotTools("/test");
      expect(tools.length).toBe(3);
    });
  });
});
