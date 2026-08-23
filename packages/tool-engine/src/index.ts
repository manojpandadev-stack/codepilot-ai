/**
 * @codepilot/tool-engine
 *
 * CodePilot-specific tools: repository analysis, architecture detection,
 * test intelligence, code review, security analysis, and task DAG management.
 */

import { createTool } from "@cline/agents";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ============================================================================
// Repository Analysis Tool
// ============================================================================

export function createRepositoryAnalysisTool(workspaceRoot: string): any {
  return createTool({
    name: "analyze_repository",
    description:
      "Analyze the repository structure, detect technology stack, frameworks, architecture patterns.",
    inputSchema: {
      type: "object",
      properties: {
        depth: {
          type: "number",
          description: "Maximum directory depth to scan (default: 4)",
        },
      },
      required: [],
    },
    execute: async (input: { depth?: number }) => {
      const depth = input.depth ?? 4;
      return await analyzeRepository(workspaceRoot, depth);
    },
  });
}

async function analyzeRepository(root: string, maxDepth: number) {
  const languages: Record<string, number> = {};
  const frameworks: string[] = [];
  const buildTools: string[] = [];
  const testFrameworks: string[] = [];
  let totalFiles = 0;
  const structure: string[] = [];

  const extensions: Record<string, string> = {
    ".java": "Java",
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".py": "Python",
    ".go": "Go",
    ".rs": "Rust",
    ".sql": "SQL",
    ".json": "JSON",
    ".yaml": "YAML",
    ".yml": "YAML",
    ".xml": "XML",
    ".md": "Markdown",
    ".kt": "Kotlin",
    ".gradle": "Gradle",
  };

  async function scan(dir: string, currentDepth: number): Promise<void> {
    if (currentDepth > maxDepth) return;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.name.startsWith(".") ||
          entry.name === "node_modules" ||
          entry.name === "target"
        )
          continue;
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(root, fullPath);
        if (entry.isDirectory()) {
          structure.push(`${relPath}/`);
          await scan(fullPath, currentDepth + 1);
        } else {
          totalFiles++;
          const ext = path.extname(entry.name);
          const lang = extensions[ext];
          if (lang) languages[lang] = (languages[lang] ?? 0) + 1;

          if (entry.name === "pom.xml") {
            buildTools.push("Maven");
            frameworks.push("Java/Spring Boot");
          }
          if (
            entry.name === "build.gradle" ||
            entry.name === "build.gradle.kts"
          )
            buildTools.push("Gradle");
          if (entry.name === "package.json") buildTools.push("npm");
          if (entry.name === "Cargo.toml") buildTools.push("Cargo");
          if (entry.name === "Dockerfile") buildTools.push("Docker");
          if (entry.name === "docker-compose.yml")
            buildTools.push("Docker Compose");
          if (entry.name.includes("Test.java")) testFrameworks.push("JUnit");
        }
      }
    } catch {
      /* skip */
    }
  }

  await scan(root, 0);

  return {
    technologyStack: [...new Set([...Object.keys(languages), ...frameworks])],
    frameworks: [...new Set(frameworks)],
    buildTools: [...new Set(buildTools)],
    testFrameworks: [...new Set(testFrameworks)],
    totalFiles,
    languages,
    structure: structure.slice(0, 200),
  };
}

// ============================================================================
// Code Review Tool
// ============================================================================

export interface CodeReviewFinding {
  file: string;
  line: number | null;
  severity: "critical" | "high" | "medium" | "low";
  category:
    | "bug"
    | "security"
    | "performance"
    | "architecture"
    | "maintainability"
    | "testing";
  explanation: string;
  suggestedFix?: string;
}

export function createCodeReviewTool(workspaceRoot: string): any {
  return createTool({
    name: "review_code",
    description:
      "Review code for bugs, security issues, performance problems, and code quality.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "File path to review" },
        content: { type: "string", description: "Code content to review" },
        language: { type: "string", description: "Programming language" },
      },
      required: [],
    },
    execute: async (input: {
      filePath?: string;
      content?: string;
      language?: string;
    }) => {
      let content = input.content;
      const filePath = input.filePath;

      if (!content && filePath) {
        const fullPath = path.join(workspaceRoot, filePath);
        content = await fs.readFile(fullPath, "utf-8");
      }

      if (!content) return { findings: [], error: "No content to review" };

      const findings = reviewCode(content, filePath ?? "unknown");
      return { findings, summary: `${findings.length} findings` };
    },
  });
}

function reviewCode(content: string, filePath: string): CodeReviewFinding[] {
  const findings: CodeReviewFinding[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    if (/eval\s*\(/.test(line)) {
      findings.push({
        file: filePath,
        line: lineNum,
        severity: "critical",
        category: "security",
        explanation:
          "Use of eval() is a security risk — can lead to code injection.",
        suggestedFix: "Replace eval() with a safe alternative.",
      });
    }

    if (/console\.(log|debug|info)\s*\(/.test(line)) {
      findings.push({
        file: filePath,
        line: lineNum,
        severity: "low",
        category: "maintainability",
        explanation:
          "Console output in production code. Use a proper logging framework.",
      });
    }

    if (/TODO|FIXME|HACK|XXX/.test(line)) {
      findings.push({
        file: filePath,
        line: lineNum,
        severity: "low",
        category: "maintainability",
        explanation: `Unresolved marker: ${line.trim()}`,
      });
    }

    if (line.length > 200) {
      findings.push({
        file: filePath,
        line: lineNum,
        severity: "low",
        category: "maintainability",
        explanation: `Line exceeds 200 characters (${line.length} chars).`,
      });
    }
  }

  return findings;
}

// ============================================================================
// Test Intelligence Tool
// ============================================================================

export function createTestIntelligenceTool(workspaceRoot: string): any {
  return createTool({
    name: "test_intelligence",
    description:
      "Detect test framework, find affected tests for changed files.",
    inputSchema: {
      type: "object",
      properties: {
        changedFiles: {
          type: "array",
          items: { type: "string" },
          description: "Recently changed files",
        },
      },
      required: [],
    },
    execute: async (input: { changedFiles?: string[] }) => {
      const framework = await detectTestFramework(workspaceRoot);
      const affectedTests = findAffectedTests(input.changedFiles ?? []);
      return { framework, affectedTests };
    },
  });
}

async function detectTestFramework(root: string): Promise<string> {
  try {
    const pomPath = path.join(root, "pom.xml");
    await fs.access(pomPath);
    const pomContent = await fs.readFile(pomPath, "utf-8");
    if (pomContent.includes("junit")) return "JUnit 5";
  } catch {
    /* not Java */
  }

  try {
    const pkgPath = path.join(root, "package.json");
    await fs.access(pkgPath);
    const pkgContent = await fs.readFile(pkgPath, "utf-8");
    if (pkgContent.includes("vitest")) return "Vitest";
    if (pkgContent.includes("jest")) return "Jest";
  } catch {
    /* not Node */
  }

  return "Unknown";
}

function findAffectedTests(changedFiles: string[]): string[] {
  const testFiles: string[] = [];
  for (const file of changedFiles) {
    if (
      file.includes("Test.") ||
      file.includes("test.") ||
      file.includes("spec.")
    ) {
      testFiles.push(file);
      continue;
    }
    if (file.endsWith(".java"))
      testFiles.push(file.replace(".java", "Test.java"));
    if (file.endsWith(".ts") || file.endsWith(".js")) {
      const base = file.replace(/\.(ts|js)$/, "");
      testFiles.push(`${base}.test.ts`, `${base}.spec.ts`);
    }
  }
  return testFiles;
}

// ============================================================================
// Factory: Create all CodePilot tools
// ============================================================================

export function createCodePilotTools(workspaceRoot: string): any[] {
  return [
    createRepositoryAnalysisTool(workspaceRoot),
    createCodeReviewTool(workspaceRoot),
    createTestIntelligenceTool(workspaceRoot),
  ];
}
