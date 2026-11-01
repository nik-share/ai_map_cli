import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildSourceContext } from "../src/context.js";
import type { CodeMap, RelationRecord, SymbolRecord } from "../src/types.js";
import { hashText } from "../src/utils/hash.js";
import { SCHEMA_VERSION } from "../src/constants.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "map-context-"));
  roots.push(root);
  const source = Array.from({ length: 24 }, (_, i) => `source line ${i + 1}`).join("\n");
  await writeFile(join(root, "source.ts"), source);
  await writeFile(join(root, "caller.ts"), source);
  const symbol = (name: string, file: string, start: number, end: number): SymbolRecord =>
    ({
      schemaVersion: SCHEMA_VERSION,
      id: `function:${file}#${name}`,
      name,
      kind: "function",
      file,
      range: { startLine: start, endLine: end, startColumn: 1, endColumn: 1 },
    }) as SymbolRecord;
  const target = symbol("target", "source.ts", 3, 8);
  const helper = symbol("helper", "source.ts", 8, 12);
  const caller = symbol("caller", "caller.ts", 5, 7);
  const unrelated = symbol("unrelated", "source.ts", 20, 22);
  const edge = (from: string, to: string, classification = "exact"): RelationRecord =>
    ({
      schemaVersion: SCHEMA_VERSION,
      from,
      to,
      type: "calls",
      confidence: 1,
      origin: {
        file: "source.ts",
        line: 5,
        range: target.range,
        classification,
        analyzer: "typescript-node",
        explanation: "fixture",
      },
    }) as RelationRecord;
  const map = {
    symbols: [target, helper, caller, unrelated],
    files: [
      { path: "source.ts", hash: hashText(source) },
      { path: "caller.ts", hash: hashText(source) },
    ],
    relations: [
      edge(target.id, helper.id),
      edge(helper.id, target.id),
      edge(caller.id, target.id),
      edge(target.id, unrelated.id, "heuristic"),
    ],
  } as CodeMap;
  return { root, source, map, target, helper, caller, unrelated };
}

it("collects direct source neighbors and merges overlapping ranges without following uncertain edges", async () => {
  const f = await fixture();
  const result = await buildSourceContext(f.map, f.target.id, { root: f.root });
  expect(result.selected.map((s) => s.id).sort()).toEqual(
    [f.target.id, f.helper.id, f.caller.id].sort(),
  );
  expect(result.snippets).toEqual([
    {
      file: "source.ts",
      startLine: 1,
      endLine: 14,
      source: f.source.split("\n").slice(0, 14).join("\n"),
    },
    {
      file: "caller.ts",
      startLine: 3,
      endLine: 9,
      source: f.source.split("\n").slice(2, 9).join("\n"),
    },
  ]);
  expect(result.usedLines).toBe(21);
  expect(result.omitted).toEqual([]);
  f.map.symbols.reverse();
  f.map.relations.reverse();
  expect(await buildSourceContext(f.map, f.target.id, { root: f.root })).toEqual(result);
});

it("enforces a shared line budget and reports the unread ranges instead of silently claiming completeness", async () => {
  const f = await fixture();
  const result = await buildSourceContext(f.map, f.target.id, { root: f.root, maxLines: 5 });
  expect(result.usedLines).toBe(5);
  expect(result.snippets).toEqual([
    {
      file: "source.ts",
      startLine: 1,
      endLine: 5,
      source: "source line 1\nsource line 2\nsource line 3\nsource line 4\nsource line 5",
    },
  ]);
  expect(result.omitted).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: f.target.id, file: "source.ts", startLine: 6, endLine: 10 }),
    ]),
  );
});

it("bounds characters across all snippets and does not emit a partial oversized line", async () => {
  const f = await fixture();
  const source = "x".repeat(600) + "\n" + f.source;
  await writeFile(join(f.root, "source.ts"), source);
  const file = f.map.files.find((f) => f.path === "source.ts");
  if (!file) throw new Error("fixture");
  file.hash = hashText(source);
  const result = await buildSourceContext(f.map, f.target.id, { root: f.root, maxChars: 256 });
  expect(result.usedChars).toBeLessThanOrEqual(256);
  expect(result.snippets.some((s) => s.source.includes("x"))).toBe(false);
  expect(result.omitted.some((o) => o.id === f.target.id && o.startLine === 1)).toBe(true);
});

it("validates source hashes and root boundaries for every selected file", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "caller.ts"), "changed");
  await expect(buildSourceContext(f.map, f.target.id, { root: f.root })).rejects.toMatchObject({
    code: "STALE_SOURCE",
  });
  await rm(join(f.root, "caller.ts"));
  await symlink(join(f.root, "source.ts"), join(f.root, "caller.ts"));
  await expect(buildSourceContext(f.map, f.target.id, { root: f.root })).rejects.toThrow();
});

it("keeps no-match queries empty and prefers behavioral matches over partial type names", async () => {
  const f = await fixture();
  expect((await buildSourceContext(f.map, "missing", { root: f.root })).snippets).toEqual([]);
  const type = {
    ...f.target,
    id: "type:source.ts#TargetOptions",
    name: "TargetOptions",
    kind: "type-alias",
  } as SymbolRecord;
  f.map.symbols.push(type);
  const result = await buildSourceContext(f.map, "target", { root: f.root, seeds: 1 });
  expect(result.matches[0]?.id).toBe(f.target.id);
  await expect(buildSourceContext(f.map, "target", { root: f.root, maxLines: 0 })).rejects.toThrow(
    RangeError,
  );
});

it("uses missing query words in source to prefer an action over its enclosing class and list filters", async () => {
  const f = await fixture();
  const source = [
    "class RequestService {",
    "  processRequest() {",
    "    if (action === 'approved' || action === 'rejected') {",
    "      return 'approved or rejected';",
    "    }",
    "  }",
    "}",
    "function listRequests() {",
    "  return ['approved', 'rejected'];",
    "}",
  ].join("\n");
  await writeFile(join(f.root, "source.ts"), source);
  const symbol = (name: string, kind: SymbolRecord["kind"], start: number, end: number) => ({
    ...f.target,
    id: `${kind}:source.ts#${name}`,
    name,
    kind,
    range: { startLine: start, endLine: end, startColumn: 1, endColumn: 1 },
  });
  const action = symbol("processRequest", "method", 2, 6);
  f.map.symbols = [
    symbol("RequestService", "class", 1, 7),
    symbol("listRequests", "function", 8, 10),
    action,
  ];
  const indexed = f.map.files[0];
  if (!indexed) throw new Error("fixture file");
  f.map.files = [{ ...indexed, hash: hashText(source) }];
  f.map.relations = [];
  const result = await buildSourceContext(f.map, "approve reject source request", { root: f.root });
  expect(result.matches.map((match) => match.id)).toEqual([action.id]);
  expect(result.snippets[0]?.endLine).toBe(8);
  expect(result.moreMatches).toBe(2);
});

it("does not expand a reference-only class, but still reads a class requested explicitly", async () => {
  const f = await fixture();
  const container = {
    ...f.target,
    id: "class:source.ts#Container",
    name: "Container",
    kind: "class" as const,
    range: { startLine: 1, endLine: 24, startColumn: 1, endColumn: 1 },
  };
  f.map.symbols.push(container);
  const relation = f.map.relations[0];
  if (!relation) throw new Error("fixture relation");
  f.map.relations.push({
    ...relation,
    from: f.target.id,
    to: container.id,
    type: "references",
  });
  const result = await buildSourceContext(f.map, f.target.id, { root: f.root });
  expect(result.selected.some((symbol) => symbol.id === container.id)).toBe(false);
  expect(result.usedLines).toBe(21);
  expect(result.omittedNavigation).toBe(1);
  const explicit = await buildSourceContext(f.map, container.id, { root: f.root });
  expect(explicit.snippets[0]?.endLine).toBe(24);
});

it("includes exact file-level entry points under the same source budget and freshness checks", async () => {
  const f = await fixture();
  const indexed = f.map.files.find((file) => file.path === "caller.ts");
  const template = f.map.relations[0];
  if (!indexed || !template) throw new Error("fixture");
  indexed.id = "file:caller.ts";
  const edge = {
    ...template,
    from: indexed.id,
    to: f.target.id,
    type: "references" as const,
    origin: {
      ...template.origin,
      file: "caller.ts",
      line: 18,
      range: { startLine: 18, endLine: 18, startColumn: 1, endColumn: 1 },
    },
  };
  f.map.relations = [edge];
  const result = await buildSourceContext(f.map, f.target.id, { root: f.root });
  expect(result.fileReferences).toEqual([{ file: "caller.ts", line: 18 }]);
  expect(result.snippets.find((snippet) => snippet.file === "caller.ts")).toMatchObject({
    startLine: 1,
    endLine: 24,
  });
  const limited = await buildSourceContext(f.map, f.target.id, { root: f.root, maxLines: 11 });
  expect(limited.usedLines).toBe(11);
  expect(limited.omitted).toContainEqual({
    id: indexed.id,
    file: "caller.ts",
    startLine: 2,
    endLine: 24,
  });
  await writeFile(join(f.root, "caller.ts"), "changed");
  await expect(buildSourceContext(f.map, f.target.id, { root: f.root })).rejects.toMatchObject({
    code: "STALE_SOURCE",
  });
});

it("bounds large file-reference windows and ignores uncertain and non-canonical file endpoints", async () => {
  const f = await fixture();
  const indexed = f.map.files.find((file) => file.path === "caller.ts");
  const template = f.map.relations[0];
  if (!indexed || !template) throw new Error("fixture");
  const source = Array.from({ length: 150 }, (_, i) => `route line ${i + 1}`).join("\n");
  await writeFile(join(f.root, "caller.ts"), source);
  indexed.id = "file:caller.ts";
  indexed.hash = hashText(source);
  const edge = {
    ...template,
    from: indexed.id,
    to: f.target.id,
    type: "references" as const,
    origin: {
      ...template.origin,
      file: "caller.ts",
      line: 100,
      range: { startLine: 100, endLine: 100, startColumn: 1, endColumn: 1 },
    },
  };
  f.map.relations = [
    edge,
    { ...edge, origin: { ...edge.origin, line: 20, classification: "heuristic" } },
    { ...edge, from: "file:unknown.ts", origin: { ...edge.origin, line: 30 } },
  ];
  const result = await buildSourceContext(f.map, f.target.id, { root: f.root });
  expect(result.fileReferences).toEqual([{ file: "caller.ts", line: 100 }]);
  expect(result.snippets.find((snippet) => snippet.file === "caller.ts")).toMatchObject({
    startLine: 92,
    endLine: 108,
  });
  f.map.relations.reverse();
  expect(await buildSourceContext(f.map, f.target.id, { root: f.root })).toEqual(result);
});
