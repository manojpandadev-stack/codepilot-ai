// ============================================================================
// Markdown parsing for chat messages (pure functions, unit-testable)
// ============================================================================

/** One parsed block element. Rendered by the ChatMarkdown React component. */
export type MdBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { kind: "paragraph"; text: string }
  | {
      kind: "code";
      lang: string;
      lines: string[];
      /** Raw text for the copy button. */
      text: string;
    }
  | { kind: "quote"; text: string }
  | {
      kind: "list";
      ordered: boolean;
      items: string[];
      /** Zero-based start number for ordered lists. */
      start: number;
    }
  | { kind: "hr" }
  | {
      kind: "table";
      header: string[];
      rows: string[][];
    };

/** Parsed inline runs inside a paragraph/heading/quote/list item. */
export type MdInline =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string }
  | { kind: "strikethrough"; text: string };

/** Escape regex special characters. */
function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse inline markdown into runs. Handles `code`, **strong**, *em*,
 * ~~strike~~, and [text](url). Unmatched markers stay literal text.
 */
export function parseInline(text: string): MdInline[] {
  const runs: MdInline[] = [];
  // One combined scan, longest markers first.
  const pattern = new RegExp(
    [
      "`([^`\\n]+)`", // 1: inline code
      "\\*\\*(?=\\S)([\\s\\S]*?\\S)\\*\\*", // 2: strong
      "(?<![\\w*])\\*(?=[^\\s*])([^*\\n]*[^\\s*])?\\*(?![\\w*])", // 3: em
      "~~(?=\\S)([\\s\\S]*?\\S)~~", // 4: strikethrough
      "\\[([^\\]\\n]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)", // 5,6: link
    ].join("|"),
    "g",
  );
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last)
      runs.push({ kind: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined) {
      runs.push({ kind: "code", text: m[1] });
    } else if (m[2] !== undefined) {
      runs.push({ kind: "strong", text: m[2] });
    } else if (m[3] !== undefined) {
      runs.push({ kind: "em", text: m[3] ?? "" });
    } else if (m[4] !== undefined) {
      runs.push({ kind: "strikethrough", text: m[4] });
    } else if (m[5] !== undefined && m[6] !== undefined) {
      runs.push({ kind: "link", text: m[5], href: m[6] });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ kind: "text", text: text.slice(last) });
  return runs;
}

/** Parse a markdown string into a block tree. */
export function parseMarkdown(src: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = (src ?? "").replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      blocks.push({ kind: "code", lang, lines: body, text: body.join("\n") });
      i += 1; // skip closing fence (or EOF)
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1]!.length as 1 | 2 | 3 | 4,
        text: heading[2]!,
      });
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }

    // Blockquote
    if (line.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) {
        body.push(lines[i]!.replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ kind: "quote", text: body.join(" ").trim() });
      continue;
    }

    // Table
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]!)
    ) {
      const splitRow = (row: string): string[] =>
        row
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((c) => c.trim());
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|")) {
        rows.push(splitRow(lines[i]!));
        i += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    // List
    const bullet = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      const ordered = /\d/.test(bullet[2]!.charAt(0));
      const start = ordered ? parseInt(bullet[2]!, 10) : 1;
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i]!;
        const cm = cur.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (cm && /\d/.test(cm[2]!.charAt(0)) === ordered) {
          items.push(cm[3]!);
          i += 1;
        } else if (
          cur.trim() !== "" &&
          cur.startsWith("  ") &&
          items.length > 0 &&
          items[items.length - 1] !== undefined
        ) {
          // Continuation line folds into the previous item.
          items[items.length - 1] += " " + cur.trim();
          i += 1;
        } else {
          break;
        }
        // Skip a single blank line between items.
        const next = i < lines.length ? lines[i] : undefined;
        const after = lines[i + 1];
        if (
          next !== undefined &&
          next.trim() === "" &&
          after !== undefined &&
          /^\s*(?:[-*+]|\d+[.)])\s/.test(after)
        ) {
          i += 1;
          continue;
        }
      }
      blocks.push({ kind: "list", ordered, items, start });
      continue;
    }

    // Paragraph — fold consecutive non-empty, non-structural lines.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^```/.test(lines[i]!) &&
      !/^#{1,4}\s/.test(lines[i]!) &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]!) &&
      !lines[i]!.startsWith(">") &&
      !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i]!)
    ) {
      para.push(lines[i]!);
      i += 1;
    }
    blocks.push({ kind: "paragraph", text: para.join("\n") });
  }
  return blocks;
}

/** True when the text contains markdown structure worth rendering. */
export function looksLikeMarkdown(src: string): boolean {
  if (!src) return false;
  return (
    /```/.test(src) ||
    /^#{1,4}\s/m.test(src) ||
    /^\s*[-*+]\s+/m.test(src) ||
    /^\s*\d+[.)]\s+/m.test(src) ||
    /\*\*[^*\n]+\*\*/.test(src) ||
    /`[^`\n]+`/.test(src) ||
    /^\s*>/m.test(src) ||
    /\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)/.test(src)
  );
}

/** Escape a string for safe interpolation into a RegExp. */
export { escRe as escapeRegExp };
