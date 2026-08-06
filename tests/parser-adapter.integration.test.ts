import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createTypeScriptParserAdapter,
  scanProject,
  type SyntaxParserAdapter,
} from "../src/index.js";
import { createEmptyProject, readPersistedMap, removeProject } from "./helpers.js";

const temporaryProjects: string[] = [];

async function parserFixture(): Promise<string> {
  const root = await createEmptyProject();
  temporaryProjects.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"name":"parser-adapter-fixture","private":true}\n');
  await writeFile(
    join(root, "tsconfig.json"),
    '{"compilerOptions":{"strict":true,"jsx":"preserve"},"include":["src/**/*"]}\n',
  );
  await writeFile(
    join(root, "src/Valid.tsx"),
    "export function ValidCard({ title }: { title: string }) { return <article>{title}</article>; }\n",
  );
  await writeFile(
    join(root, "src/Broken.tsx"),
    "export function BrokenCard() { return <section><strong>broken</section>; }\n",
  );
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map(removeProject));
});

describe("public ParserAdapter boundary", () => {
  it("uses the compiler-backed default for valid and partially invalid TSX without aborting", async () => {
    const root = await parserFixture();
    const compilerAdapter = createTypeScriptParserAdapter();
    expect(await compilerAdapter.supports("tsx")).toBe(true);
    const result = await scanProject({ root });

    const valid = result.map.files.find((file) => file.path === "src/Valid.tsx");
    const broken = result.map.files.find((file) => file.path === "src/Broken.tsx");
    expect(valid?.syntax.parser).toMatch(/typescript|compiler/i);
    expect(valid?.syntax.hadErrors).toBe(false);
    expect(valid?.syntax.factCount).toBeGreaterThan(0);
    expect(broken?.syntax.parser).toMatch(/typescript|compiler/i);
    expect(broken?.syntax.hadErrors).toBe(true);
    expect(result.map.symbols.some((symbol) => symbol.name === "ValidCard")).toBe(true);
    expect(result.map.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "parse-error", file: "src/Broken.tsx" }),
      ]),
    );
  });

  it("persists byte-identical output for the default and explicit compiler parser", async () => {
    const root = await parserFixture();
    const defaultScan = await scanProject({ root });
    const defaultArtifacts = await readPersistedMap(root);
    const explicitScan = await scanProject({ root, parser: createTypeScriptParserAdapter() });
    const explicitArtifacts = await readPersistedMap(root);

    expect(defaultScan.wrote).toBe(true);
    expect(explicitScan.wrote).toBe(false);
    expect(explicitScan.map.manifest).toEqual(defaultScan.map.manifest);
    expect(Object.keys(explicitArtifacts.raw).sort()).toEqual(
      Object.keys(defaultArtifacts.raw).sort(),
    );
    for (const [name, defaultArtifact] of Object.entries(defaultArtifacts.raw)) {
      const explicitArtifact = explicitArtifacts.raw[name];
      if (!explicitArtifact) throw new Error(`Missing explicit-parser artifact ${name}`);
      expect(explicitArtifact.equals(defaultArtifact)).toBe(true);
      expect(explicitArtifacts.mtimes[name]).toBe(defaultArtifacts.mtimes[name]);
    }
  });

  it("falls back to compiler evidence and diagnostics when a custom syntax adapter throws", async () => {
    const root = await parserFixture();
    const failingAdapter: SyntaxParserAdapter = {
      name: "failing-test-adapter",
      supports: () => true,
      parse: () => {
        throw new Error("intentional parser adapter failure");
      },
    };

    const result = await scanProject({
      root,
      output: ".ai/fallback-code-map",
      parser: failingAdapter,
    });
    const valid = result.map.files.find((file) => file.path === "src/Valid.tsx");

    expect(result.map.symbols.some((symbol) => symbol.name === "ValidCard")).toBe(true);
    expect(valid?.syntax.parser).toMatch(/typescript|compiler/i);
    expect(valid?.syntax.fallbackFrom).toBe(failingAdapter.name);
    expect(result.map.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "parser-fallback",
          severity: "warning",
          file: "src/Valid.tsx",
        }),
      ]),
    );
    const evidence = result.map.diagnostics
      .filter((diagnostic) => diagnostic.file === "src/Valid.tsx")
      .map((diagnostic) => diagnostic.message)
      .join(" ");
    expect(evidence).toContain(failingAdapter.name);
  });
});
