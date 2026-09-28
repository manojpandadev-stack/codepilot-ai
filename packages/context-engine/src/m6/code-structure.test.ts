/**
 * CodeStructureProvider + inspectCodeStructure (parity gap row #8).
 *
 * Real-source parsing with line ranges, quote/comment-aware extents,
 * markdown sections, JSON value rules, honest unsupported-language
 * reporting, and the active-provider injection seam.
 */
import { describe, expect, it } from "vitest";
import {
  getCodeStructureProvider,
  inspectCodeStructure,
  isStructuredLanguage,
  regexCodeStructureProvider,
  setCodeStructureProvider,
  type CodeStructureProvider,
} from "./code-structure.js";

describe("inspectCodeStructure — real TS parsing with extents", () => {
  const source = [
    "export interface Options {", // 1
    "  label: string;", // 2
    "}", // 3
    "", // 4
    "export class Widget {", // 5
    "  render() {", // 6
    '    const badge = "}";', // 7
    "    return badge; // }", // 8
    "  }", // 9
    "}", // 10
    "", // 11
    "export const makeWidget = () => {", // 12
    "  return new Widget();", // 13
    "};", // 14
    "", // 15
    "export type Id = string | number;", // 16
  ].join("\n");

  it("extracts symbols with correct 1-based line ranges", () => {
    const result = inspectCodeStructure("sample.ts", source);
    expect(result.language).toBe("typescript");
    expect(result.supported).toBe(true);
    const byName = Object.fromEntries(result.symbols.map((s) => [s.name, s]));
    expect(byName.Options).toMatchObject({
      kind: "interface",
      line: 1,
      endLine: 3,
    });
    // "}"" on line 7 and "// }" on line 8 must NOT close the class early.
    expect(byName.Widget).toMatchObject({ kind: "class", line: 5, endLine: 10 });
    expect(byName.render).toMatchObject({ kind: "method", line: 6, endLine: 9 });
    expect(byName.makeWidget).toMatchObject({
      kind: "constant",
      line: 12,
      endLine: 14,
    });
    expect(byName.Id).toMatchObject({ kind: "type", line: 16, endLine: 16 });
  });

  it("handles multi-line signatures (params wrapped, brace on a later line)", () => {
    const source = [
      "export function process(", // 1
      "  input: string,", // 2
      "): Result {", // 3
      "  return null;", // 4
      "}", // 5
    ].join("\n");
    const result = inspectCodeStructure("proc.ts", source);
    const fn = result.symbols.find((s) => s.name === "process");
    expect(fn).toMatchObject({ kind: "function", line: 1, endLine: 5 });
  });

  it("closes multi-line type unions at the `;` but aborts at sibling statements", () => {
    const union = [
      "export type Id2 =", // 1
      "  | string", // 2
      "  | number;", // 3
    ].join("\n");
    const unionResult = inspectCodeStructure("union.ts", union);
    expect(unionResult.symbols.find((s) => s.name === "Id2")).toMatchObject({
      line: 1,
      endLine: 3,
    });

    // ASI style: the next statement's `;` must never be claimed as extent.
    const asi = [
      "export const noSemi = (a) => a", // 1
      "export const other = 1;", // 2
    ].join("\n");
    const asiResult = inspectCodeStructure("asi.ts", asi);
    const noSemi = asiResult.symbols.find((s) => s.name === "noSemi");
    expect(noSemi).toBeDefined();
    expect(noSemi!.endLine).toBeUndefined();
  });
});

describe("inspectCodeStructure — JSON and markdown rules", () => {
  const json = [
    "{", // 1
    '  "name": "widget",', // 2
    '  "nested": {', // 3
    '    "a": 1', // 4
    "  },", // 5
    '  "tags": ["x"]', // 6
    "}", // 7
  ].join("\n");

  it("bounds JSON values that open on the key line; primitives report no endLine", () => {
    const result = inspectCodeStructure("data.json", json);
    expect(result.supported).toBe(true);
    const byName = Object.fromEntries(result.symbols.map((s) => [s.name, s]));
    // Primitive value: never inherits the NEXT key's braces.
    expect(byName.name).toMatchObject({ line: 2 });
    expect(byName.name!.endLine).toBeUndefined();
    expect(byName.nested).toMatchObject({ line: 3, endLine: 5 });
    expect(byName.tags).toMatchObject({ line: 6, endLine: 6 });
  });

  it("markdown headings run to the next heading of equal/higher level (or EOF)", () => {
    const md = ["# A", "## B", "intro", "# C", "tail"].join("\n");
    const result = inspectCodeStructure("doc.md", md);
    expect(result.supported).toBe(true);
    const byName = Object.fromEntries(result.symbols.map((s) => [s.name, s]));
    expect(byName.A).toMatchObject({ line: 1, endLine: 3 });
    expect(byName.B).toMatchObject({ line: 2, endLine: 3 });
    expect(byName.C).toMatchObject({ line: 4, endLine: 5 });
  });
});

describe("inspectCodeStructure — honest fallbacks", () => {
  it("reports supported:false for detectable but unstructured languages", () => {
    const result = inspectCodeStructure("mod.rs", "fn main() {}");
    expect(result.language).toBe("rust");
    expect(result.supported).toBe(false);
    expect(result.symbols).toEqual([]);
    expect(isStructuredLanguage("rust")).toBe(false);
    expect(isStructuredLanguage("typescript")).toBe(true);
  });

  it("reports supported:false for unknown extensions too", () => {
    const result = inspectCodeStructure("mystery.xyz", "whatever {}");
    expect(result.supported).toBe(false);
    expect(result.symbols).toEqual([]);
  });
});

describe("CodeStructureProvider seam", () => {
  it("uses the injected provider and restores the default on reset", () => {
    const custom: CodeStructureProvider = {
      id: "custom-test-provider",
      supports: (language) => language === "typescript",
      structure: () => [{ name: "Injected", kind: "class", line: 1, endLine: 4 }],
    };
    setCodeStructureProvider(custom);
    try {
      expect(getCodeStructureProvider()).toBe(custom);
      const result = inspectCodeStructure("a.ts", "");
      expect(result.supported).toBe(true);
      expect(result.symbols).toEqual([
        { name: "Injected", kind: "class", line: 1, endLine: 4 },
      ]);
      // Unsupported language path stays honest even with a custom provider.
      expect(inspectCodeStructure("a.rs", "x").supported).toBe(false);
    } finally {
      setCodeStructureProvider();
    }
    expect(getCodeStructureProvider()).toBe(regexCodeStructureProvider);
    expect(regexCodeStructureProvider.id).toBe("regex");
  });
});
