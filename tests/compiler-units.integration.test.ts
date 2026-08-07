import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkFreshness,
  CoreAnalyzer,
  createTypeScriptSemanticResolver,
  loadCodeMap,
  ReactAnalyzer,
  scanProject,
  TypeScriptParserAdapter,
  TypeScriptSemanticResolver,
} from "../src/index.js";
import type {
  CodeMap,
  FileRecord,
  FrameworkAnalyzer,
  ProjectRecord,
  SemanticResolveInput,
  SemanticResolver,
  SyntaxParserAdapter,
} from "../src/index.js";
import { parseCliJson, readPersistedMap, removeProject, runCli } from "./helpers.js";

interface PublicCompilerUnit {
  id: string;
  kind: "configured" | "fallback";
  root: string;
  config?: string;
  references: string[];
  extends: string[];
  pathAliases: Record<string, string[]>;
}

interface CompilerUnitProject extends ProjectRecord {
  compilerUnits: PublicCompilerUnit[];
}

interface OwnedFile extends FileRecord {
  compilerUnit: string;
}

interface CompilerUnitMap extends Omit<CodeMap, "files" | "project"> {
  files: OwnedFile[];
  project: CompilerUnitProject;
}

interface ScanCliJson {
  wrote: boolean;
  changes: {
    added: string[];
    modified: string[];
    deleted: string[];
    moved: Array<{ from: string; to: string }>;
  };
}

const fixtureTemplate = join(dirname(fileURLToPath(import.meta.url)), "fixtures/compiler-units");
const temporaryRoots: string[] = [];

async function createCompilerUnitFixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ai-code-map-compiler-units-")));
  temporaryRoots.push(root);
  await cp(fixtureTemplate, root, { recursive: true });
  return root;
}

async function createTemporaryRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map(removeProject));
});

function compilerMap(map: CodeMap): CompilerUnitMap {
  return map;
}

function fileAt(map: CompilerUnitMap, path: string): OwnedFile {
  const file = map.files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`Expected persisted file ${path}`);
  return file;
}

function ownerOf(map: CompilerUnitMap, path: string): PublicCompilerUnit {
  const ownerId = fileAt(map, path).compilerUnit;
  const owner = map.project.compilerUnits.find((candidate) => candidate.id === ownerId);
  if (!owner) throw new Error(`Expected compiler unit ${ownerId} for ${path}`);
  return owner;
}

function relationExists(map: CompilerUnitMap, type: string, from: string, to: string): boolean {
  return map.relations.some(
    (relation) => relation.type === type && relation.from === from && relation.to === to,
  );
}

function emptyChanges(): ScanCliJson["changes"] {
  return { added: [], modified: [], deleted: [], moved: [] };
}

function persistedText(map: Awaited<ReturnType<typeof readPersistedMap>>): string {
  return Object.values(map.raw)
    .map((value) => value.toString("utf8"))
    .join("\n");
}

function expectUniqueRecords(map: CompilerUnitMap): void {
  expect(new Set(map.files.map((file) => file.path)).size).toBe(map.files.length);
  expect(new Set(map.symbols.map((symbol) => symbol.id)).size).toBe(map.symbols.length);
  expect(new Set(map.relations.map((relation) => JSON.stringify(relation))).size).toBe(
    map.relations.length,
  );
}

async function writeAmbientTypes(cwd: string, declaration: string): Promise<void> {
  const packageRoot = join(cwd, "node_modules/@types/cwd-conflict");
  await mkdir(packageRoot, { recursive: true });
  await Promise.all([
    writeFile(join(cwd, "package.json"), '{"name":"unrelated-caller","private":true}\n'),
    writeFile(
      join(packageRoot, "package.json"),
      '{"name":"@types/cwd-conflict","version":"1.0.0","types":"index.d.ts"}\n',
    ),
    writeFile(join(packageRoot, "index.d.ts"), declaration),
  ]);
}

describe("Milestone 1 compiler-unit behavior", () => {
  it("is byte-identical across unrelated CWDs with conflicting ambient types", async () => {
    const root = await createCompilerUnitFixture();
    const callerOne = await createTemporaryRoot("ai-code-map-caller-one-");
    const callerTwo = await createTemporaryRoot("ai-code-map-caller-two-");
    await Promise.all([
      writeAmbientTypes(
        callerOne,
        'declare function cwdAmbientChoice(): { source: "caller-one" };\n',
      ),
      writeAmbientTypes(callerTwo, 'declare const cwdAmbientChoice: { source: "caller-two" };\n'),
    ]);
    const projectTypes = join(root, "node_modules/@types/project-stable");
    await mkdir(projectTypes, { recursive: true });
    await Promise.all([
      writeFile(
        join(projectTypes, "package.json"),
        '{"name":"@types/project-stable","version":"1.0.0","types":"index.d.ts"}\n',
      ),
      writeFile(
        join(projectTypes, "index.d.ts"),
        'declare function projectStableAmbient(): { source: "project-root" };\n',
      ),
    ]);

    const output = join(root, ".ai/cwd-independent-map");
    const config = join(root, ".ai/code-map/config.json");
    const arguments_ = ["scan", "--root", root, "--config", config, "--output", output, "--json"];

    const targetScan = await runCli(arguments_, root);
    expect(targetScan.code, targetScan.stderr).toBe(0);
    expect((parseCliJson(targetScan) as ScanCliJson).wrote).toBe(true);
    const targetMap = await readPersistedMap(root, output);
    const projectAmbientSymbol = targetMap.symbols.find(
      (symbol) => symbol.name === "readProjectStableAmbient",
    );
    expect(projectAmbientSymbol?.signature).toMatch(/source/i);
    expect(projectAmbientSymbol?.signature).not.toMatch(/\bany\b/i);

    for (const cwd of [callerOne, callerTwo]) {
      await rm(output, { recursive: true, force: true });
      const fresh = await runCli(arguments_, cwd);
      expect(fresh.code, fresh.stderr).toBe(0);
      expect(parseCliJson(fresh)).toMatchObject({ wrote: true });
      const freshlyAnalyzed = await readPersistedMap(root, output);
      expect(Object.keys(freshlyAnalyzed.raw).sort()).toEqual(Object.keys(targetMap.raw).sort());
      for (const name of Object.keys(targetMap.raw)) {
        expect(freshlyAnalyzed.raw[name]?.equals(targetMap.raw[name] as Buffer), name).toBe(true);
      }

      const repeated = await runCli(arguments_, cwd);
      expect(repeated.code, repeated.stderr).toBe(0);
      expect(parseCliJson(repeated)).toMatchObject({ wrote: false, changes: emptyChanges() });
      const fromCaller = await readPersistedMap(root, output);
      expect(Object.keys(fromCaller.raw).sort()).toEqual(Object.keys(targetMap.raw).sort());
      for (const name of Object.keys(targetMap.raw)) {
        expect(fromCaller.raw[name]?.equals(targetMap.raw[name] as Buffer), name).toBe(true);
      }
    }

    const text = persistedText(await readPersistedMap(root, output));
    expect(text).not.toContain(root);
    expect(text).not.toContain(callerOne);
    expect(text).not.toContain(callerTwo);
    expect((await checkFreshness({ root, config, output })).current).toBe(true);
  }, 120_000);

  it("keeps workspace aliases and app-to-library project-reference semantics distinct", async () => {
    const root = await createCompilerUnitFixture();
    const map = compilerMap((await scanProject({ root })).map);

    const appAlias = fileAt(map, "packages/app/src/use-alias.ts").imports.find(
      (item) => item.source === "@local/value",
    );
    const adminAlias = fileAt(map, "packages/admin/src/use-alias.ts").imports.find(
      (item) => item.source === "@local/value",
    );
    expect(appAlias).toMatchObject({
      resolved: "packages/app/src/local/value.ts",
      external: false,
    });
    expect(adminAlias).toMatchObject({
      resolved: "packages/admin/src/local/value.ts",
      external: false,
    });
    expect(
      relationExists(
        map,
        "calls",
        "function:packages/app/src/use-alias.ts#useAppAlias",
        "function:packages/app/src/local/value.ts#workspaceAliasValue",
      ),
    ).toBe(true);
    expect(
      relationExists(
        map,
        "calls",
        "function:packages/admin/src/use-alias.ts#useAdminAlias",
        "function:packages/admin/src/local/value.ts#workspaceAliasValue",
      ),
    ).toBe(true);

    expect(fileAt(map, "packages/app/src/App.tsx").imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "@fixture/library",
          resolved: "packages/library/src/index.ts",
          external: false,
        }),
      ]),
    );
    expect(
      relationExists(
        map,
        "reexports",
        "file:packages/library/src/index.ts",
        "file:packages/library/src/factory.ts",
      ),
    ).toBe(true);
    expect(
      relationExists(
        map,
        "calls",
        "component:packages/app/src/App.tsx#App",
        "function:packages/library/src/factory.ts#makeLibraryValue",
      ),
    ).toBe(true);
    expect(
      relationExists(
        map,
        "instantiates",
        "component:packages/app/src/App.tsx#App",
        "class:packages/library/src/factory.ts#LibraryValue",
      ),
    ).toBe(true);
    expect(
      relationExists(
        map,
        "renders",
        "component:packages/app/src/App.tsx#App",
        "component:packages/library/src/LibraryWidget.tsx#LibraryWidget",
      ),
    ).toBe(true);

    const appUnit = ownerOf(map, "packages/app/src/use-alias.ts");
    const adminUnit = ownerOf(map, "packages/admin/src/use-alias.ts");
    const libraryUnit = ownerOf(map, "packages/library/src/factory.ts");
    const solutionUnit = map.project.compilerUnits.find((unit) => unit.config === "tsconfig.json");
    expect(appUnit.id).not.toBe(adminUnit.id);
    expect(appUnit.pathAliases["@local/*"]).toEqual(["packages/app/src/local/*"]);
    expect(adminUnit.pathAliases["@local/*"]).toEqual(["packages/admin/src/local/*"]);
    expect(appUnit.extends.length).toBeGreaterThan(0);
    expect(appUnit.references.length).toBeGreaterThan(0);
    expect(libraryUnit.extends.length).toBeGreaterThan(0);
    expect(solutionUnit?.references.length).toBeGreaterThan(0);
    expectUniqueRecords(map);
  }, 60_000);

  it("assigns browser, tooling, overlapping, and orphan files to deterministic owners", async () => {
    const rootA = await createCompilerUnitFixture();
    const rootB = await createCompilerUnitFixture();
    const overlapA = "packages/overlap/tsconfig.a.json";
    const overlapB = "packages/overlap/tsconfig.b.json";
    const [aContents, bContents] = await Promise.all([
      readFile(join(rootA, overlapA)),
      readFile(join(rootA, overlapB)),
    ]);
    for (const root of [rootA, rootB]) {
      await Promise.all([rm(join(root, overlapA)), rm(join(root, overlapB))]);
    }
    await writeFile(join(rootA, overlapA), aContents);
    await writeFile(join(rootA, overlapB), bContents);
    await writeFile(join(rootB, overlapB), bContents);
    await writeFile(join(rootB, overlapA), aContents);

    const mapA = compilerMap((await scanProject({ root: rootA })).map);
    const mapB = compilerMap((await scanProject({ root: rootB })).map);
    expect(ownerOf(mapA, "packages/app/src/App.tsx").config).toBe("packages/app/tsconfig.json");
    expect(ownerOf(mapA, "packages/app/vite.config.ts").config).toBe(
      "packages/app/tsconfig.node.json",
    );
    expect(ownerOf(mapA, "packages/overlap/src/shared.ts").config).toBe(overlapA);
    expect(ownerOf(mapB, "packages/overlap/src/shared.ts").config).toBe(overlapA);

    const orphanOwner = ownerOf(mapA, "orphan.ts");
    expect(orphanOwner).toMatchObject({ kind: "fallback", root: "." });
    expect(ownerOf(mapA, "ambient.ts").id).toBe(orphanOwner.id);
    expect(
      mapA.symbols.some(
        (symbol) => symbol.id === "function:orphan.ts#useOrphan" && symbol.file === "orphan.ts",
      ),
    ).toBe(true);
    expect(
      relationExists(
        mapA,
        "calls",
        "function:orphan.ts#useOrphan",
        "function:orphan.ts#orphanHelper",
      ),
    ).toBe(true);

    for (const file of mapA.files) {
      expect(typeof file.compilerUnit).toBe("string");
      expect(
        mapA.project.compilerUnits.filter((unit) => unit.id === file.compilerUnit),
      ).toHaveLength(1);
    }
    expect(mapA.project.compilerUnits.filter((unit) => unit.kind === "fallback")).toHaveLength(1);
    expectUniqueRecords(mapA);

    const persistedA = await readPersistedMap(rootA);
    const persistedB = await readPersistedMap(rootB);
    expect(Object.keys(persistedB.raw).sort()).toEqual(Object.keys(persistedA.raw).sort());
    for (const name of Object.keys(persistedA.raw)) {
      expect(persistedB.raw[name]?.equals(persistedA.raw[name] as Buffer), name).toBe(true);
    }
  }, 120_000);

  it("uses one shared freshness fingerprint for configs and dependency metadata", async () => {
    const root = await createCompilerUnitFixture();
    const first = await scanProject({ root });
    expect(first.wrote).toBe(true);
    expect((await checkFreshness({ root })).current).toBe(true);

    const mutations: Array<{ name: string; apply: () => Promise<void> }> = [
      {
        name: "transitively extended config",
        apply: async () => {
          const path = join(root, "tsconfig.base.json");
          const config = JSON.parse(await readFile(path, "utf8")) as {
            compilerOptions: Record<string, unknown>;
          };
          config.compilerOptions.forceConsistentCasingInFileNames = true;
          await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
        },
      },
      {
        name: "referenced config",
        apply: async () => {
          const path = join(root, "packages/library/tsconfig.json");
          const config = JSON.parse(await readFile(path, "utf8")) as {
            compilerOptions: Record<string, unknown>;
          };
          config.compilerOptions.noUnusedLocals = true;
          await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
        },
      },
      {
        name: "applicable sibling config",
        apply: async () => {
          const path = join(root, "tsconfig.sibling.json");
          const config = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
          config.compilerOptions = { checkJs: true };
          await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
        },
      },
      {
        name: "workspace dependency range",
        apply: async () => {
          const path = join(root, "package.json");
          const manifest = JSON.parse(await readFile(path, "utf8")) as {
            dependencies: Record<string, string>;
          };
          manifest.dependencies.react = "^19.2.0";
          await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
        },
      },
      {
        name: "nested workspace dependency range",
        apply: async () => {
          const path = join(root, "packages/app/package.json");
          const manifest = JSON.parse(await readFile(path, "utf8")) as {
            dependencies: Record<string, string>;
          };
          manifest.dependencies["@fixture/library"] = "workspace:*";
          await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
        },
      },
      {
        name: "relevant lockfile",
        apply: async () => {
          const path = join(root, "pnpm-lock.yaml");
          const lockfile = await readFile(path, "utf8");
          await writeFile(path, `${lockfile}\n# dependency resolution changed\n`);
        },
      },
    ];

    for (const mutation of mutations) {
      await mutation.apply();
      const stale = await checkFreshness({ root });
      expect(stale.current, mutation.name).toBe(false);
      expect(stale.status, mutation.name).toBe("stale");
      expect(stale.changes, mutation.name).toEqual(emptyChanges());
      const refreshed = await scanProject({ root });
      expect(refreshed.wrote, mutation.name).toBe(true);
      expect((await checkFreshness({ root })).current, mutation.name).toBe(true);
    }

    const stableBefore = await readPersistedMap(root);
    const unchanged = await scanProject({ root });
    const stableAfter = await readPersistedMap(root);
    expect(unchanged.wrote).toBe(false);
    expect(unchanged.changes).toEqual(emptyChanges());
    for (const name of Object.keys(stableBefore.raw)) {
      expect(stableAfter.raw[name]?.equals(stableBefore.raw[name] as Buffer), name).toBe(true);
      expect(stableAfter.mtimes[name]).toBe(stableBefore.mtimes[name]);
    }
  }, 180_000);

  it("bounds out-of-root references, extends paths, and symlinks", async () => {
    const root = await createCompilerUnitFixture();
    const outside = await createTemporaryRoot("ai-code-map-outside-unit-");
    const outsideSecret = "OUTSIDE_COMPILER_UNIT_SECRET_5f7b";
    const outsideConfig = join(outside, "tsconfig.json");
    await Promise.all([
      writeFile(
        join(outside, "outside.ts"),
        `export const outsideSecret = ${JSON.stringify(outsideSecret)};\n`,
      ),
      writeFile(
        outsideConfig,
        '{"compilerOptions":{"target":"ESNext"},"include":["outside.ts"]}\n',
      ),
    ]);

    const escapeExtends = join(root, "tsconfig.escape-extends.json");
    const relativeOutsideConfig = relative(root, outsideConfig).split(sep).join("/");
    await writeFile(
      escapeExtends,
      `${JSON.stringify({ extends: relativeOutsideConfig, files: [] }, null, 2)}\n`,
    );
    await symlink(outsideConfig, join(root, "tsconfig.symlink.json"));
    await symlink(join(outside, "outside.ts"), join(root, "packages/app/src/outside-link.ts"));

    const rootConfigPath = join(root, "tsconfig.json");
    const rootConfig = JSON.parse(await readFile(rootConfigPath, "utf8")) as {
      references: Array<{ path: string }>;
    };
    rootConfig.references.push(
      { path: outsideConfig },
      { path: "./tsconfig.escape-extends.json" },
      { path: "./tsconfig.symlink.json" },
    );
    await writeFile(rootConfigPath, `${JSON.stringify(rootConfig, null, 2)}\n`);

    const scan = await scanProject({ root });
    const map = compilerMap(scan.map);
    const persisted = await readPersistedMap(root);
    const text = persistedText(persisted);
    expect(map.files.some((file) => file.path === "packages/app/src/outside-link.ts")).toBe(false);
    expect(map.files.every((file) => !file.path.includes(".."))).toBe(true);
    expect(map.project.compilerUnits.every((unit) => !unit.config?.includes(".."))).toBe(true);
    expect(text).not.toContain(outside);
    expect(text).not.toContain(outsideSecret);
    expect(text).not.toContain(outsideConfig);
    await expect(access(join(root, "outside.ts"))).rejects.toThrow();
  }, 60_000);

  it("preserves the public semantic-resolver adapter and default Core/React behavior", async () => {
    const root = await createCompilerUnitFixture();
    const delegate = createTypeScriptSemanticResolver();
    const inputs: SemanticResolveInput[] = [];
    const resolver: SemanticResolver = {
      name: "compiler-unit-contract-wrapper",
      version: "1.0.0",
      async resolve(input) {
        inputs.push(input);
        return delegate.resolve(input);
      },
    };

    const map = compilerMap((await scanProject({ root, semanticResolver: resolver })).map);
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.every((input) => input.root === root)).toBe(true);
    expect(map.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "function:packages/library/src/factory.ts#makeLibraryValue",
          kind: "function",
        }),
        expect.objectContaining({
          id: "component:packages/app/src/App.tsx#App",
          kind: "react-component",
        }),
      ]),
    );
    expect(map.symbols.some((symbol) => symbol.kind.startsWith("next-"))).toBe(false);
    expect(map.symbols.some((symbol) => symbol.kind.startsWith("nest-"))).toBe(false);
    expect(compilerMap(await loadCodeMap({ root })).project.compilerUnits).toEqual(
      map.project.compilerUnits,
    );
  }, 60_000);

  it("reuses a complete unchanged default map without invoking analysis components", async () => {
    const root = await createCompilerUnitFixture();
    const config = join(root, ".ai/code-map/config.json");
    const output = join(root, ".ai/unchanged-reuse-map");
    const first = await scanProject({ root, config, output });
    const before = await readPersistedMap(root, output);
    const semantic = vi.spyOn(TypeScriptSemanticResolver.prototype, "resolve");
    const core = vi.spyOn(CoreAnalyzer.prototype, "analyze");
    const react = vi.spyOn(ReactAnalyzer.prototype, "analyze");
    const parser = vi.spyOn(TypeScriptParserAdapter.prototype, "parse");

    const second = await scanProject({ root, config, output });
    const cli = await runCli(
      ["scan", "--root", root, "--config", config, "--output", output, "--json"],
      root,
    );
    const after = await readPersistedMap(root, output);

    expect(first.wrote).toBe(true);
    expect(second.wrote).toBe(false);
    expect(second.changes).toEqual(emptyChanges());
    expect(second.map).toEqual(first.map);
    expect(cli.code, cli.stderr).toBe(0);
    expect(parseCliJson(cli)).toMatchObject({
      wrote: false,
      changes: emptyChanges(),
      counts: first.counts,
    });
    expect(semantic).not.toHaveBeenCalled();
    expect(core).not.toHaveBeenCalled();
    expect(react).not.toHaveBeenCalled();
    expect(parser).not.toHaveBeenCalled();
    for (const name of Object.keys(before.raw)) {
      expect(after.raw[name]?.equals(before.raw[name] as Buffer), name).toBe(true);
      expect(after.mtimes[name]).toBe(before.mtimes[name]);
    }
    expect((await checkFreshness({ root, config, output })).current).toBe(true);
  }, 60_000);

  it("falls through to full analysis and repairs every stale or invalid reuse candidate", async () => {
    const root = await createCompilerUnitFixture();
    const config = join(root, ".ai/code-map/config.json");
    const output = join(root, ".ai/stale-reuse-map");
    await scanProject({ root, config, output });
    const semantic = vi.spyOn(TypeScriptSemanticResolver.prototype, "resolve");
    const outputFile = (name: string): string => join(output, name);

    const mutations: Array<{ name: string; apply: () => Promise<void> }> = [
      {
        name: "source",
        apply: async () => {
          const path = join(root, "orphan.ts");
          await writeFile(
            path,
            `${await readFile(path, "utf8")}\nexport const reuseSourceEdit = true;\n`,
          );
        },
      },
      {
        name: "scanner config",
        apply: async () => {
          const value = JSON.parse(await readFile(config, "utf8")) as Record<string, unknown>;
          value.includePrivateSymbols = true;
          await writeFile(config, `${JSON.stringify(value, null, 2)}\n`);
        },
      },
      {
        name: "package dependency range",
        apply: async () => {
          const path = join(root, "package.json");
          const value = JSON.parse(await readFile(path, "utf8")) as {
            dependencies: Record<string, string>;
          };
          value.dependencies.react = "^19.3.0";
          await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
        },
      },
      {
        name: "lockfile",
        apply: async () => {
          const path = join(root, "pnpm-lock.yaml");
          await writeFile(path, `${await readFile(path, "utf8")}\n# reuse-invalidating edit\n`);
        },
      },
      {
        name: "tool identity",
        apply: async () => {
          const path = outputFile("manifest.json");
          const value = JSON.parse(await readFile(path, "utf8")) as {
            analyzerVersion: string;
          };
          value.analyzerVersion = "stale-validator-tool";
          await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
        },
      },
      {
        name: "invalid managed artifact",
        apply: async () => {
          await writeFile(outputFile("files.jsonl"), "not-json\n");
        },
      },
      {
        name: "invalid overview artifact",
        apply: async () => {
          await writeFile(outputFile("overview.md"), "# stale but parseable overview\n");
        },
      },
      {
        name: "missing managed artifact",
        apply: async () => {
          await rm(outputFile("relations.jsonl"));
        },
      },
    ];

    for (const mutation of mutations) {
      semantic.mockClear();
      await mutation.apply();
      const repaired = await scanProject({ root, config, output });
      expect(repaired.wrote, mutation.name).toBe(true);
      expect(semantic, mutation.name).toHaveBeenCalled();
      expect(compilerMap(await loadCodeMap({ root, config, output })), mutation.name).toEqual(
        repaired.map,
      );
      expect((await checkFreshness({ root, config, output })).current, mutation.name).toBe(true);
    }
  }, 120_000);

  it("never reuses a default map for custom parser, analyzer, or resolver identities", async () => {
    const root = await createCompilerUnitFixture();
    const config = join(root, ".ai/code-map/config.json");
    const output = join(root, ".ai/custom-reuse-map");
    await scanProject({ root, config, output });
    const delegate = createTypeScriptSemanticResolver();
    const resolverCall = vi.fn((input: SemanticResolveInput) => delegate.resolve(input));
    const parserCall = vi.fn(() => ({
      parser: "validator-custom-parser",
      facts: [],
      issues: [],
      hadErrors: false,
    }));
    const analyzerCall = vi.fn(() => ({}));
    const resolver: SemanticResolver = {
      name: "validator-custom-resolver",
      version: "1.0.0",
      resolve: resolverCall,
    };
    const parser: SyntaxParserAdapter = {
      name: "validator-custom-parser",
      version: "1.0.0",
      supports: () => true,
      parse: parserCall,
    };
    const analyzer: FrameworkAnalyzer = {
      name: "validator-custom-analyzer",
      version: "1.0.0",
      supports: () => true,
      analyze: analyzerCall,
    };

    const parsed = await scanProject({ root, config, output, parser });
    expect(parsed.wrote).toBe(true);
    expect(parserCall).toHaveBeenCalled();
    expect(parsed.map.manifest.syntaxParser.name).toBe("validator-custom-parser");

    await scanProject({ root, config, output });
    const analyzed = await scanProject({ root, config, output, analyzers: [analyzer] });
    expect(analyzed.wrote).toBe(true);
    expect(analyzerCall).toHaveBeenCalled();
    expect(analyzed.map.manifest.analyzers).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "validator-custom-analyzer" })]),
    );

    await scanProject({ root, config, output });
    const resolved = await scanProject({ root, config, output, semanticResolver: resolver });
    expect(resolved.wrote).toBe(true);
    expect(resolverCall).toHaveBeenCalled();
    expect(resolved.map.manifest.semanticResolver.name).toBe("validator-custom-resolver");
  }, 60_000);
});
