/**
 * Markdown parser tests for the redesigned chat renderer.
 * The parser must be safe-by-construction (no HTML strings), handle the
 * constructs the agent actually emits (code fences, lists, headings, inline
 * code, bold), and fall back to plain paragraphs otherwise.
 */
import { describe, it, expect } from "vitest";
import {
  parseMarkdown,
  parseInline,
  looksLikeMarkdown,
} from "../apps/webview/src/lib/markdown.js";

describe("parseMarkdown", () => {
  it("parses fenced code blocks with language and copyable text", () => {
    const src = "Before\n```ts\nconst a = 1;\nconst b = 2;\n```\nAfter";
    const blocks = parseMarkdown(src);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ kind: "paragraph", text: "Before" });
    expect(blocks[1]).toEqual({
      kind: "code",
      lang: "ts",
      lines: ["const a = 1;", "const b = 2;"],
      text: "const a = 1;\nconst b = 2;",
    });
    expect(blocks[2]).toEqual({ kind: "paragraph", text: "After" });
  });

  it("treats an unterminated fence as a code block to EOF", () => {
    const blocks = parseMarkdown("```js\nlet x = 1;");
    expect(blocks).toEqual([
      { kind: "code", lang: "js", lines: ["let x = 1;"], text: "let x = 1;" },
    ]);
  });

  it("parses headings up to level 4", () => {
    expect(parseMarkdown("# Title")[0]).toEqual({
      kind: "heading",
      level: 1,
      text: "Title",
    });
    expect(parseMarkdown("#### Detail")[0]).toEqual({
      kind: "heading",
      level: 4,
      text: "Detail",
    });
  });

  it("parses unordered and ordered lists with continuation lines", () => {
    const blocks = parseMarkdown(
      "- one\n- two\n  continued\n1. first\n2. second",
    );
    expect(blocks).toEqual([
      {
        kind: "list",
        ordered: false,
        items: ["one", "two continued"],
        start: 1,
      },
      { kind: "list", ordered: true, items: ["first", "second"], start: 1 },
    ]);
  });

  it("parses ordered list start numbers", () => {
    const blocks = parseMarkdown("3. third\n4. fourth");
    expect(blocks[0]).toMatchObject({ kind: "list", ordered: true, start: 3 });
  });

  it("parses blockquotes", () => {
    expect(parseMarkdown("> quoted text")[0]).toEqual({
      kind: "quote",
      text: "quoted text",
    });
  });

  it("parses tables", () => {
    const blocks = parseMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |");
    expect(blocks[0]).toEqual({
      kind: "table",
      header: ["a", "b"],
      rows: [
        ["1", "2"],
        ["3", "4"],
      ],
    });
  });

  it("parses horizontal rules", () => {
    expect(parseMarkdown("above\n---\nbelow")).toHaveLength(3);
    expect(parseMarkdown("above\n---\nbelow")[1]).toEqual({ kind: "hr" });
  });

  it("folds consecutive plain lines into one paragraph", () => {
    expect(parseMarkdown("line one\nline two")).toEqual([
      { kind: "paragraph", text: "line one\nline two" },
    ]);
  });

  it("returns no blocks for empty input", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n\n")).toEqual([]);
  });
});

describe("parseInline", () => {
  it("parses bold, italic, code, strike and links", () => {
    const runs = parseInline("**bold** *em* `code` ~~gone~~ [x](https://a.b)");
    expect(runs.map((r) => r.kind)).toEqual([
      "strong",
      "text",
      "em",
      "text",
      "code",
      "text",
      "strikethrough",
      "text",
      "link",
    ]);
    const link = runs.find((r) => r.kind === "link");
    expect(link).toEqual({ kind: "link", text: "x", href: "https://a.b" });
  });

  it("keeps unmatched markers as literal text", () => {
    expect(parseInline("a * b ** c")).toEqual([
      { kind: "text", text: "a * b ** c" },
    ]);
  });

  it("keeps plain text untouched", () => {
    expect(parseInline("hello world")).toEqual([
      { kind: "text", text: "hello world" },
    ]);
  });
});

describe("looksLikeMarkdown", () => {
  it("detects markdown structure", () => {
    expect(looksLikeMarkdown("```js\ncode\n```")).toBe(true);
    expect(looksLikeMarkdown("# Heading")).toBe(true);
    expect(looksLikeMarkdown("- item")).toBe(true);
    expect(looksLikeMarkdown("1. item")).toBe(true);
    expect(looksLikeMarkdown("**bold**")).toBe(true);
    expect(looksLikeMarkdown("`code`")).toBe(true);
    expect(looksLikeMarkdown("[link](https://x.dev)")).toBe(true);
  });

  it("rejects plain prose", () => {
    expect(looksLikeMarkdown("just a normal sentence.")).toBe(false);
    expect(looksLikeMarkdown("")).toBe(false);
  });
});
