// ============================================================================
// Markdown renderer for chat messages — parses once, renders React elements.
// No dangerouslySetInnerHTML, no HTML strings, safe by construction.
// ============================================================================

import { memo, useCallback, useState, type ReactNode } from "react";
import { parseInline, parseMarkdown, type MdBlock } from "./lib/markdown.js";
import { IconCheck, IconCopy } from "./lib/icons";

function Inline({ runs }: { runs: ReturnType<typeof parseInline> }) {
  return (
    <>
      {runs.map((r, i) => {
        switch (r.kind) {
          case "strong":
            return <strong key={i}>{r.text}</strong>;
          case "em":
            return <em key={i}>{r.text}</em>;
          case "strikethrough":
            return <s key={i}>{r.text}</s>;
          case "code":
            return <code key={i}>{r.text}</code>;
          case "link":
            return (
              <a
                key={i}
                href={r.href}
                target="_blank"
                rel="noreferrer noopener"
              >
                {r.text}
              </a>
            );
          default:
            return <span key={i}>{r.text}</span>;
        }
      })}
    </>
  );
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    try {
      const nav = navigator as Navigator & {
        clipboard?: { writeText: (t: string) => Promise<void> };
      };
      if (nav.clipboard) {
        void nav.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          },
          () => undefined,
        );
      }
    } catch {
      /* clipboard unavailable — button still shows state honestly */
    }
  }, [text]);

  return (
    <div className="group/code relative">
      <div className="absolute right-1.5 top-1.5 opacity-0 group-hover/code:opacity-100 focus-within:opacity-100 transition-opacity">
        <button
          onClick={copy}
          aria-label={copied ? "Code copied" : "Copy code"}
          title="Copy code"
          className={`inline-flex items-center gap-1 rounded border border-vscode-border px-1.5 py-0.5 text-[10px] ${
            copied
              ? "text-vscode-success-fg border-vscode-success-fg/40"
              : "text-vscode-desc hover:text-vscode-fg bg-vscode-bg"
          }`}
        >
          {copied ? <IconCheck size={11} /> : <IconCopy size={11} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
      {lang && (
        <div className="absolute left-2 top-1 text-[9px] uppercase tracking-wide text-vscode-desc/70 pointer-events-none">
          {lang}
        </div>
      )}
    </div>
  );
}

function Block({ block }: { block: MdBlock }) {
  switch (block.kind) {
    case "heading": {
      const Tag = `h${Math.min(block.level + 2, 6)}` as unknown as "h3";
      return (
        <Tag className="font-semibold">
          <Inline runs={parseInline(block.text)} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p>
          <Inline runs={parseInline(block.text)} />
        </p>
      );
    case "code":
      return <CodeBlock lang={block.lang} text={block.text} />;
    case "quote":
      return (
        <blockquote>
          <Inline runs={parseInline(block.text)} />
        </blockquote>
      );
    case "list": {
      const ListTag = block.ordered ? "ol" : "ul";
      return (
        <ListTag start={block.ordered ? block.start : undefined}>
          {block.items.map((item, i) => (
            <li key={i}>
              <Inline runs={parseInline(item)} />
            </li>
          ))}
        </ListTag>
      );
    }
    case "hr":
      return <hr />;
    case "table":
      return (
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                {block.header.map((h, i) => (
                  <th key={i}>
                    <Inline runs={parseInline(h)} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((c, ci) => (
                    <td key={ci}>
                      <Inline runs={parseInline(c)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** Render a chat message body as markdown. Falls back to plain preformatted text. */
export const ChatMarkdown = memo(function ChatMarkdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const blocks = parseMarkdown(text);
  return (
    <div className={`cp-md ${streaming ? "cp-streaming-caret" : ""}`}>
      {blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}
    </div>
  );
});

/** Convenience wrapper returning children only when markdown structure exists. */
export function maybeMarkdownChildren(
  text: string,
  renderMd: (t: string) => ReactNode,
): ReactNode {
  return renderMd(text);
}
