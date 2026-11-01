import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readSymbolSource } from "../src/read.js";
import type { CodeMap } from "../src/types.js";
import type { RelationRecord } from "../src/types.js";
import { SCHEMA_VERSION } from "../src/constants.js";
import { hashText } from "../src/utils/hash.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "map-read-"));
  roots.push(root);
  const source = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\r\n");
  await writeFile(join(root, "source.ts"), source);
  const map = {
    relations: [] as RelationRecord[],
    files: [{ path: "source.ts", hash: hashText(source) }],
    symbols: [
      {
        id: "function:source.ts#target",
        name: "target",
        file: "source.ts",
        range: { startLine: 10, startColumn: 1, endLine: 110, endColumn: 8 },
      },
    ],
  } as CodeMap;
  const symbol = map.symbols[0];
  const file = map.files[0];
  if (!symbol || !file) throw new Error("Invalid fixture");
  return { root, map, id: symbol.id, symbol, file };
}
it("reads only the mapped range with two context lines and bounded continuation", async () => {
  const { root, map, id } = await fixture();
  const first = await readSymbolSource(map, id, { root });
  expect(first).toMatchObject({ startLine: 8, endLine: 87, truncated: true, nextOffset: 80 });
  expect(first.source.split("\n")).toHaveLength(80);
  const last = await readSymbolSource(map, id, { root, offset: first.nextOffset });
  expect(last).toMatchObject({ startLine: 88, endLine: 112, truncated: false });
  expect(last.source).not.toContain("line 113");
  expect(last.nextOffset).toBeUndefined();
});

function edge(from: string, to: string, overrides: Partial<RelationRecord> = {}): RelationRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    from,
    to,
    type: "calls",
    confidence: 1,
    origin: {
      file: "source.ts",
      line: 20,
      range: { startLine: 20, endLine: 20, startColumn: 1, endColumn: 10 },
      classification: "exact",
      explanation: "Resolved call",
      analyzer: "typescript-node",
    },
    ...overrides,
  };
}

it("returns direct reusable IDs and test call sites only on the first source page", async () => {
  const { root, map, id, symbol } = await fixture();
  const dependency = { ...symbol, id: "function:source.ts#helper", name: "helper" };
  const caller = { ...symbol, id: "function:source.ts#caller", name: "caller" };
  map.symbols.push(dependency, caller);
  const call = edge(id, dependency.id);
  const test = edge("file:source.test.ts", id);
  test.origin.file = "source.test.ts";
  test.origin.line = 72;
  map.relations = [
    call,
    call,
    edge(id, dependency.id, { type: "references" }),
    edge(id, dependency.id, {
      type: "uses-hook",
      origin: { ...call.origin, classification: "framework-derived" },
    }),
    edge(caller.id, id),
    test,
    test,
    edge(id, "unresolved:missing"),
    edge(id, "external:pkg"),
    edge(id, caller.id, { type: "contains" }),
    edge(id, caller.id, { origin: { ...call.origin, classification: "heuristic" } }),
    edge(id, caller.id, { type: "used-by", origin: { ...call.origin, classification: "derived" } }),
  ];
  const first = await readSymbolSource(map, id, { root, limit: 2 });
  expect(first.navigation).toEqual({
    links: [
      {
        direction: "outgoing",
        type: "calls",
        id: dependency.id,
        file: "source.ts",
        startLine: 10,
        endLine: 110,
        classification: "exact",
      },
      {
        direction: "incoming",
        type: "calls",
        id: caller.id,
        file: "source.ts",
        startLine: 10,
        endLine: 110,
        classification: "exact",
      },
    ],
    tests: [{ file: "source.test.ts", line: 72 }],
    omittedLinks: 0,
    omittedTests: 0,
  });
  map.relations.reverse();
  expect((await readSymbolSource(map, id, { root })).navigation).toEqual(first.navigation);
  expect((await readSymbolSource(map, dependency.id, { root })).id).toBe(dependency.id);
  const next = await readSymbolSource(map, id, { root, offset: 2 });
  expect(next).not.toHaveProperty("navigation");
});

it("bounds navigation rows and reports omitted neighbors and test sites", async () => {
  const { root, map, id, symbol } = await fixture();
  for (let i = 0; i < 10; i++) {
    const target = { ...symbol, id: `function:source.ts#helper${i}` };
    map.symbols.push(target);
    map.relations.push(edge(id, target.id));
    const test = edge("file:__tests__/source.ts", id);
    test.origin.file = "__tests__/source.ts";
    test.origin.line = i + 1;
    map.relations.push(test);
  }
  const { navigation } = await readSymbolSource(map, id, { root });
  expect(navigation?.links).toHaveLength(8);
  expect(navigation?.tests).toEqual(
    [1, 2, 3, 4].map((line) => ({ file: "__tests__/source.ts", line })),
  );
  expect(navigation).toMatchObject({ omittedLinks: 2, omittedTests: 6 });
});

it("omits oversized navigation entries without truncating reusable IDs", async () => {
  const { root, map, id, symbol } = await fixture();
  const huge = { ...symbol, id: `function:source.ts#${"a".repeat(5000)}` };
  const small = { ...symbol, id: "function:source.ts#z" };
  map.symbols.push(huge, small);
  map.relations = [edge(id, huge.id), edge(id, small.id)];
  const { navigation } = await readSymbolSource(map, id, { root });
  expect(navigation?.links.map((link) => link.id)).toEqual([small.id]);
  expect(navigation?.omittedLinks).toBe(1);
  expect(JSON.stringify(navigation).length).toBeLessThanOrEqual(4000);

  // Individually small entries must also obey the shared character budget.
  const medium = Array.from({ length: 8 }, (_, i) => ({
    ...symbol,
    id: `function:source.ts#${String(i).repeat(1000)}`,
  }));
  map.symbols.push(...medium);
  map.relations = medium.map((target) => edge(id, target.id));
  const combined = (await readSymbolSource(map, id, { root })).navigation;
  expect(JSON.stringify(combined).length).toBeLessThanOrEqual(4000);
  expect(combined?.links.length).toBeGreaterThan(0);
  expect(combined?.omittedLinks).toBeGreaterThan(0);
  expect((combined?.links.length ?? 0) + (combined?.omittedLinks ?? 0)).toBe(8);
});
it("rejects stale source and missing exact IDs instead of reading a guessed location", async () => {
  const { root, map, id } = await fixture();
  await expect(readSymbolSource(map, "target", { root })).rejects.toThrow(/exact.*ID/);
  await writeFile(join(root, "source.ts"), "changed");
  await expect(readSymbolSource(map, id, { root })).rejects.toThrow(/scan/);
});
it("rejects unsafe source paths, symlinks and invalid pagination", async () => {
  const { root, map, id, symbol, file } = await fixture();
  for (const options of [
    { limit: 0 },
    { limit: 201 },
    { limit: NaN },
    { offset: -1 },
    { offset: 0.5 },
    { offset: 999 },
  ]) {
    await expect(readSymbolSource(map, id, { root, ...options })).rejects.toThrow();
  }
  await rm(join(root, "source.ts"));
  await symlink(join(root, "missing.ts"), join(root, "source.ts"));
  await expect(readSymbolSource(map, id, { root })).rejects.toThrow(/symbolic|out-of-root/);
  symbol.file = "../outside.ts";
  file.path = "../outside.ts";
  await expect(readSymbolSource(map, id, { root })).rejects.toThrow(/symbolic|out-of-root/);
});

it("rejects oversized pages rather than flooding the context or silently omitting source", async () => {
  const { root, map, id, symbol, file } = await fixture();
  const source = "x".repeat(12001);
  await writeFile(join(root, "source.ts"), source);
  file.hash = hashText(source);
  symbol.range = { startLine: 1, endLine: 1, startColumn: 1, endColumn: 12002 };
  await expect(readSymbolSource(map, id, { root })).rejects.toThrow(/12000/);
});
