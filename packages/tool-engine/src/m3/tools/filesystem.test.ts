/**
 * Built-in filesystem tools: read/write/edit/delete/move plus the security
 * invariants (traversal reject, boundary enforcement, no clobber, caps).
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { WorkspaceBoundary } from "../workspace-boundary.js";
import { createFilesystemTools, readCapped } from "./filesystem.js";
import { makeCtx, tempWorkspace } from "../testing-helpers.js";

function makeTools(root: string) {
  const boundary = new WorkspaceBoundary(root);
  return { boundary, tools: createFilesystemTools(boundary) };
}

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

describe("read_file", () => {
  it("reads a file and reports size/truncation", async () => {
    const ws = tempWorkspace({ "a.txt": "hello world" });
    try {
      const { tools } = makeTools(ws.root);
      const { ctx } = makeCtx();
      const out = (await tools[0]!.execute({ path: "a.txt" }, ctx)) as {
        path: string;
        content: string;
        size: number;
        truncated: boolean;
      };
      expect(out.path).toBe("a.txt");
      expect(out.content).toBe("hello world");
      expect(out.size).toBe(11);
      expect(out.truncated).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  it("returns NOT_FOUND for a missing file", async () => {
    const ws = tempWorkspace();
    try {
      const { tools } = makeTools(ws.root);
      const { ctx } = makeCtx();
      const err = await tryExecute(tools[0]!, { path: "nope" }, ctx);
      expect(err?.code).toBe("NOT_FOUND");
    } finally {
      ws.cleanup();
    }
  });

  it("rejects traversal attempts with PATH_SECURITY", async () => {
    const ws = tempWorkspace();
    try {
      const { tools } = makeTools(ws.root);
      const { ctx } = makeCtx();
      const err = await tryExecute(tools[0]!, { path: "../outside" }, ctx);
      expect(err?.code).toBe("PATH_SECURITY");
    } finally {
      ws.cleanup();
    }
  });
});

describe("write_file", () => {
  it("writes and creates parent directories", async () => {
    const ws = tempWorkspace();
    try {
      const { tools } = makeTools(ws.root);
      const { ctx } = makeCtx();
      const out = (await tools[1]!.execute(
        { path: "src/deep/new.txt", content: "x" },
        ctx,
      )) as {
        path: string;
      };
      expect(out.path).toBe("src/deep/new.txt");
      expect(
        fs.readFileSync(path.join(ws.root, "src", "deep", "new.txt"), "utf8"),
      ).toBe("x");
    } finally {
      ws.cleanup();
    }
  });

  it("rejects writes outside the workspace (no file is created)", async () => {
    const ws = tempWorkspace();
    try {
      const { tools } = makeTools(ws.root);
      const { ctx } = makeCtx();
      const err = await tryExecute(
        tools[1]!,
        { path: "../evil.txt", content: "x" },
        ctx,
      );
      expect(err?.code).toBe("PATH_SECURITY");
      expect(fs.existsSync(path.join(path.dirname(ws.root), "evil.txt"))).toBe(
        false,
      );
    } finally {
      ws.cleanup();
    }
  });
});

describe("edit_file", () => {
  it("replaces a unique match", async () => {
    const ws = tempWorkspace({ "a.txt": "one two one" });
    try {
      const { tools } = makeTools(ws.root);
      const { ctx } = makeCtx();
      const out = (await tools[2]!.execute(
        { path: "a.txt", search: "two", replace: "TWO" },
        ctx,
      )) as {
        matched: number;
      };
      expect(out.matched).toBe(1);
      expect(fs.readFileSync(path.join(ws.root, "a.txt"), "utf8")).toBe(
        "one TWO one",
      );
    } finally {
      ws.cleanup();
    }
  });

  it("requires an explicit occurrence for multiple matches", async () => {
    const ws = tempWorkspace({ "a.txt": "a b a" });
    try {
      const { tools } = makeTools(ws.root);
      const { ctx } = makeCtx();
      const err = await tryExecute(
        tools[2]!,
        { path: "a.txt", search: "a", replace: "z" },
        ctx,
      );
      expect(err?.code).toBe("VALIDATION");
      expect(err?.message).toContain("appears 2 times");
      // With an explicit occurrence it works and targets the right index.
      await tools[2]!.execute(
        { path: "a.txt", search: "a", replace: "z", occurrence: 2 },
        ctx,
      );
      expect(fs.readFileSync(path.join(ws.root, "a.txt"), "utf8")).toBe(
        "a b z",
      );
    } finally {
      ws.cleanup();
    }
  });

  it("returns NOT_FOUND when the search text is absent", async () => {
    const ws = tempWorkspace({ "a.txt": "nothing here" });
    try {
      const { tools } = makeTools(ws.root);
      const { ctx } = makeCtx();
      const err = await tryExecute(
        tools[2]!,
        { path: "a.txt", search: "zzz", replace: "y" },
        ctx,
      );
      expect(err?.code).toBe("NOT_FOUND");
    } finally {
      ws.cleanup();
    }
  });
});

describe("delete_file & move_file", () => {
  it("deletes a file and refuses directories", async () => {
    const ws = tempWorkspace({ "gone.txt": "x", "dir/inner.txt": "y" });
    try {
      const { tools } = makeTools(ws.root);
      const { ctx } = makeCtx();
      const out = (await tools[3]!.execute({ path: "gone.txt" }, ctx)) as {
        deleted: boolean;
      };
      expect(out.deleted).toBe(true);
      expect(fs.existsSync(path.join(ws.root, "gone.txt"))).toBe(false);

      const err = await tryExecute(tools[3]!, { path: "dir" }, ctx);
      expect(err?.code).toBe("VALIDATION");
    } finally {
      ws.cleanup();
    }
  });

  it("moves a file without clobbering an existing destination", async () => {
    const ws = tempWorkspace({ "src.txt": "a", "dest.txt": "b" });
    try {
      const { tools } = makeTools(ws.root);
      const { ctx } = makeCtx();
      const err = await tryExecute(
        tools[4]!,
        { source: "src.txt", destination: "dest.txt" },
        ctx,
      );
      expect(err?.code).toBe("PATH_SECURITY");
      // Unobstructed move works.
      const out = (await tools[4]!.execute(
        { source: "src.txt", destination: "moved.txt" },
        ctx,
      )) as {
        source: string;
        destination: string;
      };
      expect(out.destination).toBe("moved.txt");
      expect(fs.existsSync(path.join(ws.root, "moved.txt"))).toBe(true);
    } finally {
      ws.cleanup();
    }
  });
});

describe("readCapped", () => {
  it("returns only capBytes and flags truncation", async () => {
    const ws = tempWorkspace();
    try {
      const file = path.join(ws.root, "big.txt");
      fs.writeFileSync(file, "x".repeat(10_000));
      const read = readCapped(file, 128);
      expect(read.content.length).toBe(128);
      expect(read.size).toBe(10_000);
      expect(read.truncated).toBe(true);
    } finally {
      ws.cleanup();
    }
  });
});

describe("createFilesystemTools", () => {
  it("exposes all five ids with schemas and permission levels", () => {
    const ws = tempWorkspace();
    try {
      const { tools } = makeTools(ws.root);
      expect(tools.map((t) => t.id)).toEqual([
        "read_file",
        "write_file",
        "edit_file",
        "delete_file",
        "move_file",
      ]);
      for (const t of tools) {
        expect(t.inputSchema.type).toBe("object");
        expect(t.permission.level).toBeDefined();
      }
    } finally {
      ws.cleanup();
    }
  });
});
