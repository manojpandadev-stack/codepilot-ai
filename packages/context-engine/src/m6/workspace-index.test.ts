/**
 * M6 — Context engine tests.
 *
 * Covers workspace discovery, incremental indexing, secret redaction,
 * sensitive-path blocking, retrieval ranking + explainability, token
 * budgeting, lexical RAG, reindex invalidation and pruning.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverWorkspace } from "./discovery.js";
import { isSensitivePath, redactSecrets } from "./security.js";
import { WorkspaceIndex } from "./workspace-index.js";

// ============================================================================
// Fixture helpers
// ============================================================================

let tmpRoot: string;

function makeFile(rel: string, content: string): void {
  const abs = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "m6-test-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ============================================================================
// Discovery
// ============================================================================

describe("discoverWorkspace", () => {
  it("walks the workspace and classifies files", () => {
    makeFile("src/a.ts", "export const a = 1;\n");
    makeFile(
      "tests/a.test.ts",
      "import { it } from 'vitest';\nit('x', () => {});\n",
    );
    makeFile("node_modules/pkg/index.js", "// ignored\n");
    makeFile("README.md", "# Hello\n");

    const result = discoverWorkspace({ workspaceRoot: tmpRoot });
    const rels = result.files.map((f) => f.relativePath).sort();
    expect(rels).toEqual(["README.md", "src/a.ts", "tests/a.test.ts"]);
    const src = result.files.find((f) => f.relativePath === "src/a.ts");
    expect(src?.kind).toBe("source");
    const test = result.files.find((f) => f.relativePath === "tests/a.test.ts");
    expect(test?.isTest).toBe(true);
  });

  it("marks sensitive files meta-only and never reads their content", () => {
    makeFile(".env", "API_KEY=super-secret-value\n");
    makeFile("src/ok.ts", "export const ok = 1;\n");

    const result = discoverWorkspace({
      workspaceRoot: tmpRoot,
      includeHidden: true,
    });
    const env = result.files.find((f) => f.relativePath === ".env");
    expect(env).toBeDefined();
    expect(env?.isSensitive).toBe(true);
    expect(env?.metaOnly).toBe(true);
    expect(result.stats.skippedSensitive).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// Sensitive-path policy + redaction
// ============================================================================

describe("security policy", () => {
  it("flags credential-bearing paths", () => {
    expect(isSensitivePath(".env")).toBe(true);
    expect(isSensitivePath("config/.env.local")).toBe(true);
    expect(isSensitivePath("secrets.json")).toBe(true);
    expect(isSensitivePath("keys/id_rsa")).toBe(true);
    expect(isSensitivePath(".ssh/config")).toBe(true);
    expect(isSensitivePath("src/main.ts")).toBe(false);
    expect(isSensitivePath("docs/ENV.md")).toBe(false);
  });

  it("redacts high-confidence secrets without corrupting code", () => {
    const input = [
      "const key = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';",
      "token=ghp_1234567890123456789012345678901234567890",
      "export const name = 'billing';",
    ].join("\n");
    const { content, redactions } = redactSecrets(input);
    expect(redactions).toBeGreaterThanOrEqual(2);
    expect(content).not.toContain("sk-proj-");
    expect(content).not.toContain("ghp_");
    expect(content).toContain("billing");
  });
});

// ============================================================================
// WorkspaceIndex — indexing
// ============================================================================

describe("WorkspaceIndex.indexDiscovered", () => {
  it("ingests content, symbols, imports and exports", () => {
    makeFile(
      "src/user.ts",
      [
        "import { db } from './db.js';",
        "export interface User { id: string }",
        "export class UserService {",
        "  async find(id: string) { return db.query(id); }",
        "}",
        "export const DEFAULT_ROLE = 'user';",
      ].join("\n"),
    );
    makeFile("src/db.ts", "export const db = { query: (id: string) => id };\n");

    const index = new WorkspaceIndex(tmpRoot);
    const result = index.indexDiscovered(
      discoverWorkspace({ workspaceRoot: tmpRoot }).files,
    );

    expect(result.indexed).toBeGreaterThanOrEqual(2);
    const user = index.getFile("src/user.ts");
    expect(user).toBeDefined();
    const names = user?.symbols.map((s) => s.name) ?? [];
    expect(names).toContain("User");
    expect(names).toContain("UserService");
    expect(user?.imports.some((i) => i.specifier === "./db.js")).toBe(true);
    // Relative import resolved against the known set.
    expect(
      user?.imports.find((i) => i.specifier === "./db.js")?.resolvedPath,
    ).toBe("src/db.ts");
    expect(user?.exports).toContain("DEFAULT_ROLE");
  });

  it("never ingests sensitive files", () => {
    makeFile(".env", "SECRET=topsecret\n");
    makeFile("src/a.ts", "export const a = 1;\n");

    const index = new WorkspaceIndex(tmpRoot);
    index.indexDiscovered(discoverWorkspace({ workspaceRoot: tmpRoot }).files);
    expect(index.hasFile(".env")).toBe(false);
    expect(index.hasFile("src/a.ts")).toBe(true);
  });

  it("redacts secrets inside indexed content", () => {
    makeFile(
      "src/config.ts",
      "export const key = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';\n",
    );

    const index = new WorkspaceIndex(tmpRoot);
    index.indexDiscovered(discoverWorkspace({ workspaceRoot: tmpRoot }).files);
    const content = index.getFile("src/config.ts")?.content ?? "";
    expect(content).not.toContain("sk-proj-");
    expect(index.statsSnapshot.redactionsApplied).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// Incremental updates
// ============================================================================

describe("WorkspaceIndex incremental updates", () => {
  it("reindexes a changed file and drops deleted files via prune", () => {
    makeFile("src/a.ts", "export const a = 1;\n");
    makeFile("src/b.ts", "export const b = 2;\n");

    const index = new WorkspaceIndex(tmpRoot);
    index.indexDiscovered(discoverWorkspace({ workspaceRoot: tmpRoot }).files);
    expect(index.fileCount).toBe(2);

    // Change a file's content.
    makeFile("src/a.ts", "export const a = 42;\n");
    const changed = index.reindexFile("src/a.ts");
    expect(changed).toBe(true);
    expect(index.getFile("src/a.ts")?.content).toContain("42");

    // Delete a file, then prune.
    fs.rmSync(path.join(tmpRoot, "src", "b.ts"));
    const removed = index.pruneMissing(["src/a.ts"]);
    expect(removed).toBe(1);
    expect(index.hasFile("src/b.ts")).toBe(false);
  });

  it("rejects reindexing paths outside the workspace", () => {
    const index = new WorkspaceIndex(tmpRoot);
    expect(index.reindexFile("../outside.ts")).toBe(false);
  });
});

// ============================================================================
// Retrieval + ranking
// ============================================================================

describe("WorkspaceIndex.retrieve", () => {
  it("ranks the relevant file first and explains why", () => {
    makeFile(
      "src/auth/login.ts",
      "export function login(user: string, password: string) { return true; }\n",
    );
    makeFile(
      "src/payments/charge.ts",
      "export function charge(card: string, amount: number) { return true; }\n",
    );

    const index = new WorkspaceIndex(tmpRoot);
    index.indexDiscovered(discoverWorkspace({ workspaceRoot: tmpRoot }).files);

    const result = index.retrieve({
      task: "fix the login function validation",
      modelContextWindow: 64_000,
    });
    expect(result.selected.length).toBeGreaterThan(0);
    expect(result.selected[0]?.path).toBe("src/auth/login.ts");
    expect(result.selected[0]?.reasons.length).toBeGreaterThan(0);
  });

  it("boosts explicitly mentioned and active files", () => {
    makeFile("src/a.ts", "export const a = 1;\n");
    makeFile("src/b.ts", "export const b = 2;\n");

    const index = new WorkspaceIndex(tmpRoot);
    index.indexDiscovered(discoverWorkspace({ workspaceRoot: tmpRoot }).files);

    const result = index.retrieve({
      task: "unrelated task about nothing",
      mentionedFiles: ["src/b.ts"],
      activeFile: "src/b.ts",
      modelContextWindow: 64_000,
    });
    expect(result.selected[0]?.path).toBe("src/b.ts");
    expect(result.selected[0]?.reasons).toContain(
      "explicitly mentioned by user",
    );
  });

  it("respects the token budget and reports omissions", () => {
    makeFile("src/big.ts", `export const big = "${"x".repeat(20_000)}";\n`);
    makeFile("src/small.ts", "export const small = 1;\n");

    const index = new WorkspaceIndex(tmpRoot);
    index.indexDiscovered(discoverWorkspace({ workspaceRoot: tmpRoot }).files);

    const result = index.retrieve({
      task: "small",
      tokenBudget: 1_000,
      maxFiles: 1,
    });
    expect(result.selected.length).toBe(1);
    expect(result.selected[0]?.path).toBe("src/small.ts");
    // Either the big file was omitted for budget or max-files reasons.
    expect(result.omitted.length).toBeGreaterThan(0);
    expect(result.budget.usedContextTokens).toBeLessThanOrEqual(1_000);
  });
});

// ============================================================================
// Lexical RAG
// ============================================================================

describe("WorkspaceIndex.ragSearch", () => {
  it("finds files containing the query terms", () => {
    makeFile("src/auth.ts", "export function authenticate(token: string) {}\n");
    makeFile("src/other.ts", "export const unrelated = true;\n");

    const index = new WorkspaceIndex(tmpRoot);
    index.indexDiscovered(discoverWorkspace({ workspaceRoot: tmpRoot }).files);

    const hits = index.ragSearch(["authenticate"]);
    expect(hits.length).toBe(1);
    expect(hits[0]?.path).toBe("src/auth.ts");
    expect(hits[0]?.matchedTerms).toContain("authenticate");
  });
});
