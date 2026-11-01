import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readSymbolSource } from "../src/read.js";
import type { CodeMap } from "../src/types.js";
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
