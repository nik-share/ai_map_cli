import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../src/constants.js";
import { formatShowResult } from "../src/show.js";
import type { RelationRecord, ShowResult } from "../src/types.js";

const range = { startLine: 10, startColumn: 1, endLine: 40, endColumn: 2 };
function relation(to: string, overrides: Partial<RelationRecord> = {}): RelationRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    from: "function:src/a.ts#run",
    to,
    type: "calls",
    confidence: 1,
    origin: {
      file: "src/a.ts",
      line: 10,
      range,
      explanation: "Resolved",
      classification: "exact",
      analyzer: "test",
    },
    ...overrides,
  };
}
function result(): ShowResult {
  return {
    selector: "run",
    matches: [
      {
        symbol: {
          schemaVersion: SCHEMA_VERSION,
          id: "function:src/a.ts#run",
          name: "run",
          kind: "function",
          file: "src/a.ts",
          range,
          exported: true,
          signature: "function run(): void",
          documentation: "Detailed documentation",
          facts: { detail: "long detail" },
          sourceHash: "a".repeat(64),
        },
        file: {
          schemaVersion: SCHEMA_VERSION,
          id: "file:src/a.ts",
          compilerUnit: "unit:.",
          path: "src/a.ts",
          language: "ts",
          frameworks: [],
          hash: "a".repeat(64),
          lines: 40,
          imports: [],
          exports: [],
          symbolIds: [],
          env: [],
          operations: [],
          syntax: { parser: "typescript", factCount: 0, hadErrors: false },
        },
        inbound: [],
        outbound: [
          relation("external:lib#call"),
          relation("function:src/b.ts#save"),
          relation("function:src/b.ts#save"),
          relation("unresolved:unknown"),
          relation("file:src/a.ts", { type: "contains" }),
          relation("function:src/b.ts#save", { type: "references" }),
        ],
      },
    ],
  };
}

describe("compact show", () => {
  it("prioritizes internal links, groups occurrences, reports omissions and full source range", () => {
    const input = result();
    const before = structuredClone(input);
    const text = formatShowResult(input, { limit: 1 });
    expect(text).toContain("path: src/a.ts:10:1-40:2");
    expect(text).toContain("-> calls -> function:src/b.ts#save (2 occurrences)");
    expect(text).not.toContain("external:lib#call");
    expect(text).not.toContain("unresolved:unknown");
    expect(text).toContain("1/2 groups shown; 1 omitted; 3 records filtered");
    expect(text).not.toContain("Detailed documentation");
    expect(input).toEqual(before);
  });
  it("preserves full output on request, including low-confidence evidence and facts", () => {
    const text = formatShowResult(result(), { full: true });
    expect(text).toContain("documentation: Detailed documentation");
    expect(text).toContain("detail: long detail");
    expect(text).toContain("unresolved:unknown (1)");
    expect(text.match(/-> calls -> function:src\/b.ts#save/g)).toHaveLength(2);
  });
  it("hides heuristic and inverse evidence while keeping framework-derived links", () => {
    const input = result();
    const base = relation("function:src/h.ts#guess");
    for (const match of input.matches) {
      match.outbound = [
        { ...base, origin: { ...base.origin, classification: "heuristic" } },
        {
          ...base,
          to: "component:src/view.tsx#View",
          type: "renders",
          origin: { ...base.origin, classification: "framework-derived" },
        },
      ];
      match.inbound = [
        { ...base, type: "used-by", origin: { ...base.origin, classification: "derived" } },
      ];
    }
    const text = formatShowResult(input);
    expect(text).toContain("-> renders -> component:src/view.tsx#View");
    expect(text).not.toContain("#guess");
    expect(text).toContain("1/1 groups shown; 0 omitted; 2 records filtered");
  });
  it("bounds broad selectors and uses one relation budget across symbols", () => {
    const input = result();
    input.matches = Array.from({ length: 8 }, () => structuredClone(input.matches)).flat();
    const text = formatShowResult(input, { limit: 2 });
    expect(text.match(/^run \[function\]/gm)).toHaveLength(5);
    expect(text.match(/^ {2}->/gm)).toHaveLength(2);
    expect(text).toContain("Symbols: 5/8 shown; 3 omitted");
  });
  it("bounds long signatures and validates relation limits", () => {
    const input = result();
    for (const match of input.matches) match.symbol.signature = "x".repeat(10000);
    expect(formatShowResult(input)).toContain("… [truncated]");
    expect(formatShowResult(input).length).toBeLessThan(1500);
    for (const limit of [0, -1, 51, 1.5, NaN])
      expect(() => formatShowResult(input, { limit })).toThrow(RangeError);
  });
});
