/**
 * search_files and search_text: matching behavior, path scoping, ignored
 * directories and result limits.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { WorkspaceBoundary } from "../workspace-boundary.js";
import { createSearchTools, globToRegex } from "./search.js";
import { makeCtx, tempWorkspace } from "../testing-helpers.js";

function makeTools(root: string) {
  const boundary = new WorkspaceBoundary(root);
  return { boundary, tools: createSearchTools(boundary) };
}

async function run(
  toolIdx: number,
  root: string,
  input: Record<string, unknown>,
) {
  const { tools } = makeTools(root);
  const { ctx } = makeCtx();
  const tool = tools[toolIdx];
  if (!tool) throw new Error(`search tool index ${toolIdx} missing`);
  return await tool.execute(input, ctx);
}

describe("search_files", () => {
  it("finds files by glob", async () => {
    const ws = tempWorkspace({
      "a.test.ts": "x",
      "b.test.js": "x",
      "c.ts": "x",
      "sub/d.test.ts": "x",
    });
    try {
      const out = (await run(0, ws.root, { pattern: "*.test.ts" })) as {
        matches: Array<{ path: string }>;
      };
      const paths = out.matches.map((m) => m.path).sort();
      expect(paths).toEqual(["a.test.ts", "sub/d.test.ts"]);
    } finally {
      ws.cleanup();
    }
  });

  it("finds files by substring", async () => {
    const ws = tempWorkspace({ "myFile.ts": "x", "other.txt": "x" });
    try {
      const out = (await run(0, ws.root, { pattern: "myfile" })) as {
        matches: Array<{ path: string }>;
      };
      expect(out.matches.map((m) => m.path)).toEqual(["myFile.ts"]);
    } finally {
      ws.cleanup();
    }
  });

  it("respects path scoping and ignores node_modules/.git", async () => {
    const ws = tempWorkspace({
      "src/keep.ts": "x",
      "src/nested/deep.ts": "x",
      "node_modules/skip.ts": "x",
      ".git/config": "x",
    });
    try {
      const out = (await run(0, ws.root, { pattern: "*.ts", path: "src" })) as {
        matches: Array<{ path: string }>;
      };
      const paths = out.matches.map((m) => m.path).sort();
      expect(paths).toEqual(["keep.ts", "nested/deep.ts"]);
    } finally {
      ws.cleanup();
    }
  });

  it("rejects an invalid path scope", async () => {
    const ws = tempWorkspace({ "x.ts": "x" });
    try {
      const { ctx } = makeCtx();
      const tool = makeTools(ws.root).tools[0];
      if (!tool) throw new Error("search_files tool missing");
      const err = await tryExecute(tool, { pattern: "*.ts", path: "../" }, ctx);
      expect(err?.code).toBe("PATH_SECURITY");
    } finally {
      ws.cleanup();
    }
  });
});

describe("search_text", () => {
  it("finds matching lines with file + line numbers", async () => {
    const ws = tempWorkspace({
      "a.txt": "hello world\nsecond line",
      "b.txt": "no match here",
    });
    try {
      const out = (await run(1, ws.root, { query: "hello" })) as {
        matches: Array<{ path: string; line: number; text: string }>;
      };
      expect(out.matches).toEqual([
        { path: "a.txt", line: 1, text: "hello world" },
      ]);
    } finally {
      ws.cleanup();
    }
  });

  it("is case-insensitive by default and can be disabled", async () => {
    const ws = tempWorkspace({ "a.txt": "Hello" });
    try {
      const loose = (await run(1, ws.root, { query: "hello" })) as {
        count: number;
      };
      expect(loose.count).toBe(1);
      const strict = (await run(1, ws.root, {
        query: "hello",
        ignoreCase: false,
      })) as {
        count: number;
      };
      expect(strict.count).toBe(0);
    } finally {
      ws.cleanup();
    }
  });

  it("honors glob filters", async () => {
    const ws = tempWorkspace({ "a.ts": "result", "a.md": "result" });
    try {
      const out = (await run(1, ws.root, {
        query: "result",
        glob: "*.ts",
      })) as {
        matches: Array<{ path: string }>;
      };
      expect(out.matches.map((m) => m.path)).toEqual(["a.ts"]);
    } finally {
      ws.cleanup();
    }
  });

  it("skips binary files", async () => {
    const ws = tempWorkspace();
    try {
      fs.writeFileSync(
        path.join(ws.root, "bin.dat"),
        Buffer.from([0, 1, 2, 0]),
      );
      fs.writeFileSync(path.join(ws.root, "text.txt"), "target");
      const out = (await run(1, ws.root, { query: "target" })) as {
        count: number;
      };
      expect(out.count).toBe(1);
    } finally {
      ws.cleanup();
    }
  });
});

describe("globToRegex", () => {
  it("matches glob patterns with anchored, case-insensitive semantics", () => {
    const re = globToRegex("*.test.TS");
    expect(re.test("a.test.ts")).toBe(true);
    expect(re.test("a.test.js")).toBe(false);
    const single = globToRegex("a?.txt");
    expect(single.test("ab.txt")).toBe(true);
    expect(single.test("abc.txt")).toBe(false);
  });
});

async function tryExecute(
  tool: {
    execute(input: Record<string, unknown>, ctx: unknown): Promise<unknown>;
  },
  input: Record<string, unknown>,
  ctx: unknown,
): Promise<{ code: string; message: string } | null> {
  try {
    await tool.execute(input, ctx);
    return null;
  } catch (err) {
    return {
      code: (err as { code: string }).code,
      message: (err as { message: string }).message,
    };
  }
}
