import { expect, it } from "vitest";
import * as api from "../src/index.js";
import type { CodeMap, RelationRecord } from "../src/types.js";
import { SCHEMA_VERSION } from "../src/constants.js";

const range = { startLine: 1, endLine: 3, startColumn: 1, endColumn: 2 };
const run = "function:src/a.ts#run";
function fixture(): CodeMap {
  const edge: RelationRecord = {
    schemaVersion: SCHEMA_VERSION,
    from: run,
    to: "external:lib#call",
    type: "calls",
    confidence: 1,
    origin: {
      file: "src/a.ts",
      line: 2,
      range,
      classification: "exact",
      explanation: "Evidence detail",
      analyzer: "test",
    },
  };
  return {
    project: { name: "fixture" },
    files: [
      { id: "file:src/empty.ts", path: "src/empty.ts" },
      { id: "file:src/a.ts", path: "src/a.ts" },
    ],
    symbols: [
      {
        id: run,
        name: "run",
        kind: "function",
        file: "src/a.ts",
        range,
        signature: "Large signature",
      },
      { id: "variable:src/a.ts#unused", name: "unused", kind: "variable", file: "src/a.ts", range },
    ],
    relations: [
      edge,
      { ...edge, origin: { ...edge.origin, line: 3 } },
      { ...edge, to: "unresolved:guess", origin: { ...edge.origin, classification: "heuristic" } },
      { ...edge, origin: { ...edge.origin, classification: "framework-derived" } },
      { ...edge, from: "file:src/a.ts", to: run, type: "contains" },
      {
        ...edge,
        from: "external:lib#call",
        to: run,
        type: "used-by",
        origin: { ...edge.origin, classification: "derived" },
      },
    ],
  } as CodeMap;
}

it("preserves every node and structural relation while grouping repeated evidence", () => {
  const input = fixture();
  const before = structuredClone(input);
  const graph = api.buildProjectMap(input);
  expect(graph.files.map((file) => file.id)).toEqual(["file:src/a.ts", "file:src/empty.ts"]);
  expect(graph.symbols.map((symbol) => symbol.id)).toEqual([run, "variable:src/a.ts#unused"]);
  expect(graph.endpoints.map((endpoint) => endpoint.id)).toEqual([
    "external:lib#call",
    "unresolved:guess",
  ]);
  expect(graph.counts).toEqual({
    files: 2,
    symbols: 2,
    endpoints: 2,
    relationGroups: 5,
    relationRecords: 6,
  });
  expect(graph.relations).toContainEqual({
    from: "s1",
    type: "calls",
    classification: "exact",
    targets: [{ ref: "e1", count: 2 }],
  });
  expect(graph.relations.map((group) => group.classification)).toEqual(
    expect.arrayContaining(["exact", "framework-derived", "heuristic", "derived"]),
  );
  const refs = new Set(
    [...graph.files, ...graph.symbols, ...graph.endpoints].map((node) => node.ref),
  );
  for (const group of graph.relations) {
    expect(refs.has(group.from)).toBe(true);
    for (const target of group.targets) expect(refs.has(target.ref)).toBe(true);
  }
  const text = api.formatProjectMap(graph);
  expect(text).toContain("f2 src/empty.ts");
  expect(text).toContain("s1 f1:1-3 function function:src/a.ts#run");
  expect(text).toContain("s1 calls [exact] -> e1*2");
  expect(text).toContain("End of map");
  expect(text).not.toContain("Large signature");
  expect(text).not.toContain("Evidence detail");
  expect(input).toEqual(before);
  input.files.reverse();
  input.symbols.reverse();
  input.relations.reverse();
  expect(api.buildProjectMap(input)).toEqual(graph);
  expect(api.formatProjectMap(api.buildProjectMap(input))).toBe(text);
});

it("prints a complete empty map without inventing nodes or links", () => {
  const input = fixture();
  input.files = [];
  input.symbols = [];
  input.relations = [];
  const graph = api.buildProjectMap(input);
  expect(graph.counts).toEqual({
    files: 0,
    symbols: 0,
    endpoints: 0,
    relationGroups: 0,
    relationRecords: 0,
  });
  expect(graph.relations).toEqual([]);
  expect(api.formatProjectMap(graph)).toContain("End of map");
});
