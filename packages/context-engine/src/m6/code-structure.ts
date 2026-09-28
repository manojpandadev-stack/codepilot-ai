/**
 * M6 — Code structure (CodeStructureProvider).
 *
 * FEATURE GAP row #8 asked for a provider abstraction over code-structure
 * extraction. The workspace has no runtime parser/AST dependency (see the
 * header of ./symbols.ts), so the default provider is the existing regex
 * extractors plus a bounded, quote/comment-aware scanner that estimates each
 * symbol's end line so the model can follow up with precise
 * `read_files` start_line/end_line ranges.
 *
 * Extent estimation rules (prefer misses over wrong guesses):
 * - Block extent: scan from the declaration line until a `{ … }` opened by
 *   the declaration closes (strings, template literals, line/block comments
 *   are skipped so `"}"` or `// }` cannot end a block early).
 * - One-line statements: a top-level `;` on the declaration line ends it.
 * - Continuations: on later lines, a `;` at depth 0 closes the statement
 *   unless the line starts a NEW statement (`export const class type …`),
 *   which aborts to `undefined`.
 * - JSON keys: extent only when `{`/`[` opens on the key line itself;
 *   primitive values report no endLine (a following key's braces must not
 *   be mistaken for this value).
 * - Markdown headings run to the next heading of equal/higher level (or EOF);
 *   HTML headings/ids are single-line.
 * - EOF/limit without a clean close → `endLine` omitted (never invented).
 *   Scanning is bounded to END_LINE_SCAN_LIMIT lines. Known limitation:
 *   regex literals with unbalanced braces can skew depth counting.
 *
 * Honest by construction: languages without a structural extractor report
 * `supported: false` — never an empty outline pretending to be one.
 */
import { detectLanguage } from "./discovery.js";
import { extractSymbols } from "./symbols.js";
import type { SymbolKind } from "./types.js";

// ============================================================================
// Types + provider interface
// ============================================================================

export interface StructuredSymbol {
  readonly name: string;
  readonly kind: SymbolKind;
  /** 1-based line number of the declaration. */
  readonly line: number;
  /** 1-based inclusive end line when extent was determined. */
  readonly endLine?: number;
}

export interface CodeStructureResult {
  readonly language: string;
  /** False when no structural extractor exists for this language. */
  readonly supported: boolean;
  readonly symbols: StructuredSymbol[];
}

export interface CodeStructureProvider {
  readonly id: string;
  supports(language: string): boolean;
  structure(
    language: string,
    filePath: string,
    content: string,
  ): StructuredSymbol[];
}

/** Languages with a regex structural extractor (mirrors extractSymbols). */
const STRUCTURED_LANGUAGES: ReadonlySet<string> = new Set([
  "typescript",
  "javascript",
  "java",
  "json",
  "markdown",
  "css",
  "html",
]);

export function isStructuredLanguage(language: string): boolean {
  return STRUCTURED_LANGUAGES.has(language);
}

/** Languages where `;` terminates statements (drives one-line closes). */
const SEMICOLON_LANGUAGES: ReadonlySet<string> = new Set([
  "typescript",
  "javascript",
  "java",
]);

/**
 * A trimmed continuation line matching this starts something NEW, so an
 * unfinished declaration from an earlier line can never claim its extent.
 */
const NEW_STATEMENT_RE =
  /^(?:export\s+|declare\s+|abstract\s+|async\s+|const\s+|let\s+|var\s+|function\s+|class\s+|interface\s+|enum\s+|type\s+|import\s+|namespace\s+|module\s+|default\s+|@)/;

// ============================================================================
// Extent estimation (quote/comment-aware, bounded)
// ============================================================================

/** Max lines scanned forward when estimating a symbol's end line. */
const END_LINE_SCAN_LIMIT = 2000;

interface ScanState {
  braceDepth: number;
  bracketDepth: number;
  opened: boolean;
  inBlockComment: boolean;
  quote: '"' | "'" | "`" | null;
}

function scanLine(
  line: string,
  state: ScanState,
  semicolonClose: boolean,
): boolean {
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (state.inBlockComment) {
      if (ch === "*" && line[i + 1] === "/") {
        state.inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (state.quote !== null) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === state.quote) state.quote = null;
      i += 1;
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") break; // line comment → EOL
    if (ch === "/" && line[i + 1] === "*") {
      state.inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      state.quote = ch;
      i += 1;
      continue;
    }
    if (ch === "{") {
      state.braceDepth += 1;
      state.opened = true;
      i += 1;
      continue;
    }
    if (ch === "[") {
      state.bracketDepth += 1;
      state.opened = true;
      i += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (ch === "}") state.braceDepth = Math.max(0, state.braceDepth - 1);
      else state.bracketDepth = Math.max(0, state.bracketDepth - 1);
      i += 1;
      if (state.opened && state.braceDepth === 0 && state.bracketDepth === 0) {
        return true; // block/array extent closed
      }
      continue;
    }
    if (
      ch === ";" &&
      semicolonClose &&
      !state.opened &&
      state.braceDepth === 0 &&
      state.bracketDepth === 0
    ) {
      return true; // statement terminator (one-line or continuation line)
    }
    i += 1;
  }
  // Unterminated quotes resync at EOL (template literals may span lines).
  if (state.quote !== null && state.quote !== "`") state.quote = null;
  return false;
}

function estimateEndLine(
  lines: string[],
  startIdx: number,
  kind: SymbolKind,
  language: string,
): number | undefined {
  if (startIdx < 0 || startIdx >= lines.length) return undefined;

  // Markdown sections and single-line HTML tags have dedicated rules.
  if (kind === "heading" && language === "markdown") {
    const match = /^(#{1,6})\s/.exec(lines[startIdx] ?? "");
    const level = match?.[1]?.length ?? 0;
    if (level === 0) return undefined;
    for (let i = startIdx + 1; i < lines.length; i += 1) {
      const next = /^(#{1,6})\s/.exec(lines[i]!);
      if (next && next[1]!.length <= level) return i; // 0-based next heading → its line − 1
    }
    return lines.length; // section runs to EOF
  }
  if (language === "html" && (kind === "heading" || kind === "key")) {
    return startIdx + 1;
  }

  const state: ScanState = {
    braceDepth: 0,
    bracketDepth: 0,
    opened: false,
    inBlockComment: false,
    quote: null,
  };
  const semicolonLanguage = SEMICOLON_LANGUAGES.has(language);
  const jsonLike = language === "json";
  const limit = Math.min(lines.length, startIdx + END_LINE_SCAN_LIMIT);

  for (let i = startIdx; i < limit; i += 1) {
    const line = lines[i]!;
    if (i > startIdx && !state.opened) {
      if (jsonLike) return undefined; // value stayed on the key line or absent
      if (NEW_STATEMENT_RE.test(line.trimStart())) return undefined;
    }
    if (scanLine(line, state, semicolonLanguage)) return i + 1;
    if (i === startIdx && !state.opened && !semicolonLanguage && !jsonLike) {
      return undefined; // CSS: the selector's block must open on its line
    }
  }
  return undefined; // EOF or scan limit — extent never invented
}

// ============================================================================
// Default provider + active-provider seam
// ============================================================================

export const regexCodeStructureProvider: CodeStructureProvider = {
  id: "regex",
  supports: (language) => STRUCTURED_LANGUAGES.has(language),
  structure(language, filePath, content) {
    if (!STRUCTURED_LANGUAGES.has(language)) return [];
    const lines = content.split("\n");
    return extractSymbols(language, filePath, content).map((symbol) => {
      const endLine = estimateEndLine(
        lines,
        symbol.line - 1,
        symbol.kind,
        language,
      );
      return endLine === undefined
        ? { name: symbol.name, kind: symbol.kind, line: symbol.line }
        : {
            name: symbol.name,
            kind: symbol.kind,
            line: symbol.line,
            endLine,
          };
    });
  },
};

let activeProvider: CodeStructureProvider = regexCodeStructureProvider;

export function getCodeStructureProvider(): CodeStructureProvider {
  return activeProvider;
}

/** Test/injection seam — omit (or pass undefined) to restore the default. */
export function setCodeStructureProvider(
  provider?: CodeStructureProvider,
): void {
  activeProvider = provider ?? regexCodeStructureProvider;
}

// ============================================================================
// Facade
// ============================================================================

export function inspectCodeStructure(
  filePath: string,
  content: string,
): CodeStructureResult {
  const language = detectLanguage(filePath);
  const supported = activeProvider.supports(language);
  const symbols = supported
    ? activeProvider.structure(language, filePath, content)
    : [];
  return { language, supported, symbols };
}
