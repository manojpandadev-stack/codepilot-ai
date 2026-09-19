/**
 * M6 — Symbol extraction.
 *
 * Lightweight, dependency-free structural analysis. No parser/AST infra exists
 * in the workspace dependencies, so extraction is regex/line-based and
 * deliberately conservative: it prefers misses over wrong guesses. Supports
 * TS/TSX, JS/JSX, Java, JSON, Markdown, CSS/SCSS and HTML headings.
 * (Documented limitation: no full compiler-grade accuracy — see docs.)
 */
import * as path from "node:path";
import type { ImportInfo, SymbolInfo } from "./types.js";

// ============================================================================
// TS/JS symbol extraction
// ============================================================================

const JS_SYMBOL_PATTERNS: ReadonlyArray<{
  re: RegExp;
  kind: SymbolInfo["kind"];
}> = [
  {
    re: /^\s*export\s+(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    kind: "class",
  },
  {
    re: /^\s*(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    kind: "class",
  },
  {
    re: /^\s*export\s+(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/,
    kind: "interface",
  },
  {
    re: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/,
    kind: "interface",
  },
  {
    re: /^\s*export\s+(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/,
    kind: "type",
  },
  { re: /^\s*export\s+(?:declare\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
  { re: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
  {
    re: /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
    kind: "function",
  },
  {
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
    kind: "function",
  },
  // export const x = ... / const x = (...) => ... (arrow assigned to export)
  {
    re: /^\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/,
    kind: "constant",
  },
  {
    re: /^\s*export\s+let\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/,
    kind: "constant",
  },
];

// brace-tracking depth guard: only report a "method" inside reasonable depth
function lineOpensBrace(line: string): number {
  let depth = 0;
  for (const ch of line) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  return depth;
}

function extractJsSymbols(content: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const lines = content.split("\n");
  let braceDepth = 0;
  let classDepth = -1;

  lines.forEach((line, idx) => {
    const before = braceDepth;
    const opens = lineOpensBrace(line);

    for (const { re, kind } of JS_SYMBOL_PATTERNS) {
      const match = re.exec(line);
      if (match?.[1]) {
        // Skip duplicates from the export/non-export pattern pairs.
        if (!symbols.some((s) => s.name === match[1] && s.line === idx + 1)) {
          symbols.push({ name: match[1], kind, line: idx + 1 });
        }
        if (kind === "class") classDepth = before;
        break;
      }
    }

    // Methods: inside a class body, indented members with parenthesized signature.
    if (classDepth >= 0 && before > classDepth) {
      const methodRe =
        /^\s+(?:public|private|protected|readonly|static|override|\s)*(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\((?![^)]*=>\s*\{?\s*$)/;
      const m = methodRe.exec(line);
      if (
        m &&
        m[1] &&
        !/^\s*(if|for|while|switch|catch|function|return)\b/.test(line) &&
        !symbols.some((s) => s.name === m[1] && s.line === idx + 1)
      ) {
        symbols.push({ name: m[1]!, kind: "method", line: idx + 1 });
      }
    }

    braceDepth += opens;
    // Close class scope when depth returns to the class's opening level.
    if (classDepth >= 0 && before > 0 && braceDepth <= classDepth) {
      classDepth = -1;
    }
  });

  return symbols;
}

// ============================================================================
// Other languages
// ============================================================================

function extractJavaSymbols(content: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const lines = content.split("\n");
  lines.forEach((line, idx) => {
    const patterns: ReadonlyArray<{ re: RegExp; kind: SymbolInfo["kind"] }> = [
      {
        re: /^\s*(?:public|protected|private)?\s*(?:abstract\s+|final\s+|static\s+)*class\s+([A-Za-z_$][\w$]*)/,
        kind: "class",
      },
      {
        re: /^\s*(?:public\s+)?interface\s+([A-Za-z_$][\w$]*)/,
        kind: "interface",
      },
      { re: /^\s*(?:public\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
      {
        re: /^\s*(?:public|protected|private)\s+(?:[\w<>\[\],\s]+\s+)?([A-Za-z_$][\w$]*)\s*\([^;{]*\)\s*(?:throws [\w,\s]+)?\{?\s*$/,
        kind: "method",
      },
      {
        re: /^\s*(?:public|protected|private)\s+(?:static\s+)?final\s+(?:[\w<>\[\],\s]+)\s+([A-Za-z_$][\w$]*)\s*=/,
        kind: "constant",
      },
    ];
    for (const { re, kind } of patterns) {
      const m = re.exec(line);
      if (
        m?.[1] &&
        !symbols.some((s) => s.name === m[1] && s.line === idx + 1)
      ) {
        symbols.push({ name: m[1]!, kind, line: idx + 1 });
        break;
      }
    }
  });
  return symbols;
}

function extractJsonSymbols(content: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const lines = content.split("\n");
  let depth = 0;
  lines.forEach((line, idx) => {
    const m = /^\s*"([^"\\]+)"\s*:/.exec(line);
    if (m && depth <= 1) {
      symbols.push({ name: m[1]!, kind: "key", line: idx + 1 });
    }
    for (const ch of line) {
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") depth = Math.max(0, depth - 1);
    }
  });
  return symbols;
}

function extractMarkdownSymbols(content: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const lines = content.split("\n");
  lines.forEach((line, idx) => {
    const m = /^(#{1,6})\s+(.+)$/.exec(line);
    if (m) {
      symbols.push({ name: m[2]!.trim(), kind: "heading", line: idx + 1 });
    }
  });
  return symbols;
}

function extractCssSymbols(content: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const re = /(^|})\s*([^{}@\n][^{\n]*)\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const selector = match[2]!.trim().replace(/\s+/g, " ");
    if (selector) {
      symbols.push({
        name: selector,
        kind: "class",
        line: content.slice(0, match.index).split("\n").length,
      });
    }
  }
  return symbols;
}

// ============================================================================
// Import / export extraction (TS/JS)
// ============================================================================

const IMPORT_PATTERNS: readonly RegExp[] = [
  // import { a, b as c } from "mod" / export { x } from "mod"
  /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g,
  // import * as ns from "mod"
  /import\s+(?:type\s+)?\*\s+as\s+([\w$]+)\s*from\s*["']([^"']+)["']/g,
  // import Default from "mod" / import Default, { a } from "mod"
  /import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*["']([^"']+)["']/g,
  // dynamic import("mod")
  /import\(\s*["']([^"']+)["']\s*\)/g,
  // side-effect import
  /import\s*["']([^"']+)["']/g,
  // const x = require("mod")
  /(?:const|let|var)\s+[\w{}\s,:]*?=\s*require\(\s*["']([^"']+)["']\s*\)/g,
];

export function extractImports(content: string): ImportInfo[] {
  const seen = new Set<string>();
  const imports: ImportInfo[] = [];
  const push = (specifier: string, names: string[]) => {
    const key = `${specifier}::${names.join(",")}`;
    if (seen.has(key)) return;
    seen.add(key);
    imports.push({ specifier, names });
  };

  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const groups = match.slice(1).filter((g) => g !== undefined) as string[];
      let specifier: string;
      let namesRaw = "";
      if (groups.length >= 2) {
        namesRaw = groups[0]!;
        specifier = groups[groups.length - 1]!;
      } else {
        specifier = groups[0] ?? "";
      }
      if (!specifier) continue;
      const names = namesRaw
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean)
        .map((n) => {
          const asMatch = /\bas\s+([\w$]+)$/.exec(n);
          return asMatch ? asMatch[1]! : n.replace(/^type\s+/, "").trim();
        })
        .filter((n) => n.length > 0);
      push(specifier, names);
    }
  }
  return imports;
}

const EXPORT_DECL_PATTERN =
  /export\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_LIST_PATTERN = /export\s*\{([^}]*)\}/g;

export function extractExports(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  EXPORT_DECL_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPORT_DECL_PATTERN.exec(content)) !== null) {
    if (m[1] && !seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  EXPORT_LIST_PATTERN.lastIndex = 0;
  while ((m = EXPORT_LIST_PATTERN.exec(content)) !== null) {
    for (const raw of m[1]!.split(",")) {
      const name = raw
        .trim()
        .split(/\s+as\s+/)
        .pop()!
        .trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
  }
  return out;
}

// ============================================================================
// Module resolution
// ============================================================================

const SOURCE_EXTS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
];

/**
 * Resolve a module specifier to a workspace-relative path. Only relative
 * specifiers (./ ../ /) resolve; bare specifiers stay unresolved — external
 * package imports are not part of the workspace graph.
 */
export function resolveModuleSpecifier(
  fromRelPath: string,
  specifier: string,
  knownPaths: ReadonlySet<string>,
): string | undefined {
  if (
    !specifier.startsWith("./") &&
    !specifier.startsWith("../") &&
    !specifier.startsWith("/")
  ) {
    return undefined;
  }
  const fromDir = path.posix.dirname(fromRelPath);
  const base = path.posix.normalize(
    path.posix.join(fromDir, specifier.replace(/\\/g, "/")),
  );
  const candidates: string[] = [];
  // TS-style resolution: `./db.js` may map to `./db.ts`; strip a known source
  // extension before probing alternatives.
  const existingExt = path.posix.extname(base);
  const extless = SOURCE_EXTS.includes(existingExt)
    ? base.slice(0, -existingExt.length)
    : base;
  for (const ext of SOURCE_EXTS) candidates.push(`${extless}${ext}`);
  for (const ext of SOURCE_EXTS) candidates.push(`${extless}/index${ext}`);
  candidates.push(base);
  candidates.push(extless);
  for (const candidate of candidates) {
    if (knownPaths.has(candidate)) return candidate;
  }
  return undefined;
}

// ============================================================================
// Facade
// ============================================================================

export function extractSymbols(
  language: string,
  filePath: string,
  content: string,
): SymbolInfo[] {
  switch (language) {
    case "typescript":
    case "javascript":
      return extractJsSymbols(content);
    case "java":
      return extractJavaSymbols(content);
    case "json":
      return extractJsonSymbols(content);
    case "markdown":
      return extractMarkdownSymbols(content);
    case "css":
      return extractCssSymbols(content);
    case "html": {
      const out: SymbolInfo[] = [];
      const lines = content.split("\n");
      lines.forEach((line, idx) => {
        const h = /<h([1-6])[^>]*>([^<]+)<\/h\1>/i.exec(line);
        if (h) out.push({ name: h[2]!.trim(), kind: "heading", line: idx + 1 });
        const id = /id=["']([^"']+)["']/.exec(line);
        if (id) out.push({ name: id[1]!, kind: "key", line: idx + 1 });
      });
      return out;
    }
    default:
      void filePath;
      return [];
  }
}
