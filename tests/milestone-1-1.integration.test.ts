import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";

import {
  checkFreshness,
  CoreAnalyzer,
  createTypeScriptSemanticResolver,
  loadCodeMap,
  NextJsAnalyzer,
  scanProject,
  TypeScriptParserAdapter,
  TypeScriptSemanticResolver,
} from "../src/index.js";
import type {
  CodeMap,
  Framework,
  FrameworkAnalyzer,
  RelationRecord,
  SemanticResolveInput,
  SemanticResolver,
  SymbolRecord,
  SyntaxParseInput,
  SyntaxParseResult,
} from "../src/index.js";
import { BoundedTypeScriptFileSystem } from "../src/compiler-units.js";
import { stableJson } from "../src/utils/stable.js";
import { readPersistedMap, removeProject } from "./helpers.js";

const temporaryRoots: string[] = [];

interface ProjectFiles {
  [path: string]: string | Buffer;
}

async function createProject(files: ProjectFiles): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ai-code-map-milestone-1-1-")));
  temporaryRoots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents);
  }
  return root;
}

function scannerConfig(include: string[] = ["src/**/*"], tsconfig = "tsconfig.json"): string {
  return `${JSON.stringify(
    {
      version: 1,
      root: "../..",
      include,
      exclude: [
        "**/node_modules/**",
        "**/.next/**",
        "**/dist/**",
        "**/build/**",
        "**/coverage/**",
        "**/.git/**",
        "**/.ai/**",
        "**/*.generated.*",
      ],
      tsconfig,
      frameworks: ["auto"],
      output: ".ai/code-map",
      includePrivateSymbols: false,
    },
    null,
    2,
  )}\n`;
}

function packageJson(name: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ name, private: true, type: "module", ...extra }, null, 2)}\n`;
}

function tsconfig(extra: Record<string, unknown> = {}): string {
  const { compilerOptions: compilerOptionOverrides, ...configOverrides } = extra;
  const compilerOptions =
    compilerOptionOverrides &&
    typeof compilerOptionOverrides === "object" &&
    !Array.isArray(compilerOptionOverrides)
      ? (compilerOptionOverrides as Record<string, unknown>)
      : {};
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        jsx: "preserve",
        types: [],
        ...compilerOptions,
      },
      include: ["src/**/*.ts", "src/**/*.tsx", "src/**/*.js", "src/**/*.jsx"],
      ...configOverrides,
    },
    null,
    2,
  )}\n`;
}

function symbolNamed(map: Pick<CodeMap, "symbols">, name: string, file?: string): SymbolRecord {
  const symbol = map.symbols.find(
    (candidate) => candidate.name === name && (file === undefined || candidate.file === file),
  );
  if (!symbol) throw new Error(`Expected symbol ${name}${file ? ` in ${file}` : ""}`);
  return symbol;
}

function relationKey(relation: RelationRecord): string {
  const { range } = relation.origin;
  return [
    relation.from,
    relation.type,
    relation.to,
    relation.origin.file,
    range.startLine,
    range.startColumn,
    range.endLine,
    range.endColumn,
  ].join("\u0000");
}

function emptyChanges(): { added: string[]; modified: string[]; deleted: string[]; moved: [] } {
  return { added: [], modified: [], deleted: [], moved: [] };
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function collectStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, output);
  }
  return output;
}

function manifestIntegrityHash(manifest: CodeMap["manifest"]): string {
  const integrityContent: Record<string, unknown> = { ...manifest };
  delete integrityContent.integrityHash;
  return sha256(Buffer.from(stableJson(integrityContent)));
}

function parseJsonLines<T>(contents: string): T[] {
  return contents
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

function serializeJsonLines(records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

async function coherentlyTamperCompanion(
  root: string,
  artifactName: "project.json" | "files.jsonl" | "symbols.jsonl" | "relations.jsonl",
  mutate: (contents: string) => string,
): Promise<void> {
  const output = join(root, ".ai/code-map");
  const artifactPath = join(output, artifactName);
  const changed = Buffer.from(mutate(await readFile(artifactPath, "utf8")));
  await writeFile(artifactPath, changed);

  const manifestPath = join(output, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CodeMap["manifest"];
  const artifact = manifest.artifacts.find((candidate) => candidate.path === artifactName);
  if (!artifact) throw new Error(`Missing manifest artifact ${artifactName}`);
  artifact.hash = sha256(changed);
  manifest.integrityHash = manifestIntegrityHash(manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function expectCompanionIntegrityCoherent(root: string): Promise<void> {
  const output = join(root, ".ai/code-map");
  const manifest = JSON.parse(
    await readFile(join(output, "manifest.json"), "utf8"),
  ) as CodeMap["manifest"];
  expect(manifest.integrityHash).toBe(manifestIntegrityHash(manifest));
  for (const artifact of manifest.artifacts) {
    expect(artifact.hash, artifact.path).toBe(sha256(await readFile(join(output, artifact.path))));
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map(removeProject));
});

describe("Milestone 1.1 semantic correctness and freshness", () => {
  // Rejects hashing only indexed files or successful toolchain reads while silently dropping a
  // failed file/readability probe made inside the active TypeScript library root.
  it("stales and recomputes when an unindexed semantic import changes", async () => {
    const root = await createProject({
      "package.json": packageJson("semantic-closure"),
      "tsconfig.json": tsconfig({ include: ["src/**/*.ts", "support/**/*.ts"] }),
      ".ai/code-map/config.json": scannerConfig(["src/**/*.ts"]),
      "src/index.ts":
        'import { semanticValue } from "../support/value.js";\n' +
        'import { unreadableValue } from "../support/unreadable.js";\n' +
        "export function publicValue() { return semanticValue(); }\n" +
        "export function publicUnreadable() { return unreadableValue(); }\n",
      "support/value.ts": 'export function semanticValue() { return "one"; }\n',
      "support/unreadable.ts": "export function unreadableValue() { return true; }\n",
    });
    await chmod(join(root, "support/unreadable.ts"), 0o000);

    const boundedFileSystem = new BoundedTypeScriptFileSystem(root);
    const activeTypeScriptLib = await realpath(dirname(ts.getDefaultLibFilePath({})));
    const defaultLibrary = join(activeTypeScriptLib, "lib.d.ts");
    const absentToolchainCandidate = join(
      activeTypeScriptLib,
      "__ai_code_map_absent_toolchain_candidate__.d.ts",
    );
    const absentProjectCandidate = join(root, "support/absent-project-candidate.ts");
    expect(boundedFileSystem.fileExists(absentToolchainCandidate)).toBe(false);
    expect(boundedFileSystem.readFile(absentToolchainCandidate)).toBeUndefined();
    const defaultLibraryBytes = await readFile(defaultLibrary);
    expect(boundedFileSystem.readFile(defaultLibrary)).toBeDefined();
    expect(boundedFileSystem.fileExists(absentProjectCandidate)).toBe(false);
    const boundedInputs = boundedFileSystem.semanticInputs();
    expect(boundedInputs).toContainEqual({
      path: "__ai_code_map_absent_toolchain_candidate__.d.ts",
      kind: "resolution-probe",
      scope: "toolchain",
      targetKind: "file",
      exists: false,
    });
    expect(boundedInputs).toContainEqual({
      path: "__ai_code_map_absent_toolchain_candidate__.d.ts",
      kind: "resolution-probe",
      scope: "toolchain",
      targetKind: "readable-file",
      exists: false,
    });
    expect(boundedInputs).toContainEqual({
      path: "lib.d.ts",
      kind: "toolchain-file",
      hash: sha256(defaultLibraryBytes),
    });
    expect(boundedInputs).toContainEqual({
      path: "support/absent-project-candidate.ts",
      kind: "resolution-probe",
      scope: "project",
      targetKind: "file",
      exists: false,
    });

    const initial = await scanProject({ root });
    expect(initial.map.files.map((file) => file.path)).toEqual(["src/index.ts"]);
    expect(symbolNamed(initial.map, "publicValue").signature).toMatch(/string/);
    expect(
      initial.map.manifest.semanticInputs.some(
        (input) =>
          input.kind === "resolution-probe" &&
          input.targetKind === "readable-file" &&
          input.path === "support/unreadable.ts" &&
          !input.exists,
      ),
    ).toBe(true);
    expect(
      initial.map.manifest.semanticInputs.some((input) => input.kind === "toolchain-file"),
    ).toBe(true);
    expect((await checkFreshness({ root })).current).toBe(true);

    await writeFile(
      join(root, "support/value.ts"),
      "export function semanticValue() { return 42; }\n",
    );

    const stale = await checkFreshness({ root });
    expect(stale.current).toBe(false);
    expect(stale.changes).toEqual(emptyChanges());
    const refreshed = await scanProject({ root });
    expect(refreshed.wrote).toBe(true);
    expect(symbolNamed(refreshed.map, "publicValue").signature).toMatch(/number/);
    expect(symbolNamed(refreshed.map, "publicValue").signature).not.toMatch(/string/);
    expect((await checkFreshness({ root })).current).toBe(true);

    await writeFile(
      join(root, "support/new-program-root.ts"),
      "export const newlyIncludedProgramRoot = true;\n",
    );
    const addedProgramRoot = await checkFreshness({ root });
    expect(addedProgramRoot.current).toBe(false);
    expect(addedProgramRoot.changes).toEqual(emptyChanges());
    const repairedProgramRoots = await scanProject({ root });
    expect(repairedProgramRoots.wrote).toBe(true);
    expect(repairedProgramRoots.map.files.map((file) => file.path)).toEqual(["src/index.ts"]);
    expect((await checkFreshness({ root })).current).toBe(true);

    await chmod(join(root, "support/unreadable.ts"), 0o644);
    const becameReadable = await checkFreshness({ root });
    expect(becameReadable.current).toBe(false);
    expect(becameReadable.changes).toEqual(emptyChanges());
    const repairedReadableProbe = await scanProject({ root });
    expect(repairedReadableProbe.wrote).toBe(true);
    expect(symbolNamed(repairedReadableProbe.map, "publicUnreadable").signature).toMatch(/boolean/);
    expect((await checkFreshness({ root })).current).toBe(true);
  });

  // Rejects tracking only root/workspace manifests or existing files: package-scope maps, absent
  // package probes, @types directory listings, and symlink targets all participate in resolution.
  it("tracks package-scope maps and package-resolution filesystem observations", async () => {
    const nestedPackagePath = "packages/nested/package.json";
    const nestedManifest = {
      name: "nested-resolution-scope",
      private: true,
      type: "module",
      imports: { "#choice": "./src/one.ts" },
      exports: { "./choice": "./src/one.ts" },
    };
    const root = await createProject({
      "package.json": packageJson("nested-resolution-root"),
      "tsconfig.json": tsconfig({ include: ["packages/**/*.ts"] }),
      ".ai/code-map/config.json": scannerConfig(["packages/**/*.ts"]),
      "packages/nested/src/one.ts": "export function choice() { return 1; }\n",
      "packages/nested/src/two.ts": "export function choice() { return 2; }\n",
      "packages/nested/src/use.ts":
        'import { choice as importedChoice } from "#choice";\n' +
        'import { choice as exportedChoice } from "nested-resolution-scope/choice";\n' +
        "export function useChoices() { return importedChoice() + exportedChoice(); }\n",
    });

    const beforePackageScope = (await scanProject({ root })).map;
    const beforePackageImports = beforePackageScope.files.find(
      (file) => file.path === "packages/nested/src/use.ts",
    )?.imports;
    expect(
      beforePackageImports?.find((item) => item.source === "#choice")?.resolved,
    ).toBeUndefined();
    expect(
      beforePackageImports?.find((item) => item.source === "nested-resolution-scope/choice")
        ?.resolved,
    ).toBeUndefined();

    await writeFile(join(root, nestedPackagePath), `${JSON.stringify(nestedManifest, null, 2)}\n`);
    expect((await checkFreshness({ root })).current).toBe(false);
    const initial = (await scanProject({ root })).map;
    const initiallyImported = initial.files
      .find((file) => file.path === "packages/nested/src/use.ts")
      ?.imports.find((item) => item.source === "#choice");
    const initiallyExported = initial.files
      .find((file) => file.path === "packages/nested/src/use.ts")
      ?.imports.find((item) => item.source === "nested-resolution-scope/choice");
    expect(initiallyImported?.resolved).toBe("packages/nested/src/one.ts");
    expect(initiallyExported?.resolved).toBe("packages/nested/src/one.ts");

    nestedManifest.imports["#choice"] = "./src/two.ts";
    await writeFile(join(root, nestedPackagePath), `${JSON.stringify(nestedManifest, null, 2)}\n`);
    expect((await checkFreshness({ root })).current).toBe(false);
    const afterImports = (await scanProject({ root })).map;
    expect(
      afterImports.files
        .find((file) => file.path === "packages/nested/src/use.ts")
        ?.imports.find((item) => item.source === "#choice")?.resolved,
    ).toBe("packages/nested/src/two.ts");

    nestedManifest.exports["./choice"] = "./src/two.ts";
    await writeFile(join(root, nestedPackagePath), `${JSON.stringify(nestedManifest, null, 2)}\n`);
    expect((await checkFreshness({ root })).current).toBe(false);
    const afterExports = (await scanProject({ root })).map;
    expect(
      afterExports.files
        .find((file) => file.path === "packages/nested/src/use.ts")
        ?.imports.find((item) => item.source === "nested-resolution-scope/choice")?.resolved,
    ).toBe("packages/nested/src/two.ts");

    const dependencyRoot = await createProject({
      "package.json": packageJson("dependency-observation-root"),
      "tsconfig.json": tsconfig({ compilerOptions: { types: undefined } }),
      ".ai/code-map/config.json": scannerConfig(),
      "src/index.ts":
        'import { linkedPackage } from "linked-dep";\n' +
        'import { latePackage } from "late-package";\n' +
        "export function linkedResult() { return linkedPackage(); }\n" +
        "export function latePackageResult() { return latePackage(); }\n" +
        "export function lateAmbientResult() { return lateAmbient(); }\n",
      "packages/link-one/package.json": packageJson("linked-dep", { types: "./index.d.ts" }),
      "packages/link-one/index.d.ts": "export function linkedPackage(): string;\n",
      "packages/link-two/package.json": packageJson("linked-dep", { types: "./index.d.ts" }),
      "packages/link-two/index.d.ts": "export function linkedPackage(): number;\n",
    });
    await mkdir(join(dependencyRoot, "node_modules/@types"), { recursive: true });
    const dependencyLink = join(dependencyRoot, "node_modules/linked-dep");
    await symlink("../packages/link-one", dependencyLink, "dir");

    const beforeDependencyAppearance = (await scanProject({ root: dependencyRoot })).map;
    expect(symbolNamed(beforeDependencyAppearance, "linkedResult").signature).toMatch(/string/);
    expect(
      beforeDependencyAppearance.manifest.semanticInputs.some(
        (input) => input.kind === "directory-listing" && input.path === "node_modules/@types",
      ),
    ).toBe(true);
    expect(
      beforeDependencyAppearance.manifest.semanticInputs.some(
        (input) => input.kind === "symlink" && input.path === "node_modules/linked-dep",
      ),
    ).toBe(true);

    await mkdir(join(dependencyRoot, "node_modules/late-package"), { recursive: true });
    await writeFile(
      join(dependencyRoot, "node_modules/late-package/package.json"),
      packageJson("late-package", { types: "./index.d.ts" }),
    );
    await writeFile(
      join(dependencyRoot, "node_modules/late-package/index.d.ts"),
      "export function latePackage(): number;\n",
    );
    const packageAppeared = await checkFreshness({ root: dependencyRoot });
    expect(packageAppeared.current).toBe(false);
    expect(packageAppeared.changes).toEqual(emptyChanges());
    const afterPackageAppearance = await scanProject({ root: dependencyRoot });
    expect(symbolNamed(afterPackageAppearance.map, "latePackageResult").signature).toMatch(
      /number/,
    );
    expect((await checkFreshness({ root: dependencyRoot })).current).toBe(true);

    await mkdir(join(dependencyRoot, "node_modules/@types/late-global"), { recursive: true });
    await writeFile(
      join(dependencyRoot, "node_modules/@types/late-global/package.json"),
      packageJson("@types/late-global", { types: "./index.d.ts" }),
    );
    await writeFile(
      join(dependencyRoot, "node_modules/@types/late-global/index.d.ts"),
      "declare function lateAmbient(): boolean;\n",
    );
    const ambientTypesAppeared = await checkFreshness({ root: dependencyRoot });
    expect(ambientTypesAppeared.current).toBe(false);
    expect(ambientTypesAppeared.changes).toEqual(emptyChanges());
    const afterAmbientTypesAppearance = await scanProject({ root: dependencyRoot });
    expect(symbolNamed(afterAmbientTypesAppearance.map, "lateAmbientResult").signature).toMatch(
      /boolean/,
    );
    expect((await checkFreshness({ root: dependencyRoot })).current).toBe(true);

    await rm(dependencyLink);
    await symlink("../packages/link-two", dependencyLink, "dir");
    const linkRetargeted = await checkFreshness({ root: dependencyRoot });
    expect(linkRetargeted.current).toBe(false);
    expect(linkRetargeted.changes).toEqual(emptyChanges());
    const afterLinkRetarget = await scanProject({ root: dependencyRoot });
    expect(symbolNamed(afterLinkRetarget.map, "linkedResult").signature).toMatch(/number/);
    expect(symbolNamed(afterLinkRetarget.map, "linkedResult").signature).not.toMatch(/string/);
    expect((await checkFreshness({ root: dependencyRoot })).current).toBe(true);
  });

  // Rejects treating manifest.json as the entire map commit or trusting independently valid
  // records whose hashes agree but whose imports, units, ranges, or ownership contradict peers.
  it("reports every missing or invalid companion non-current and repairs it", async () => {
    const root = await createProject({
      "package.json": packageJson("companion-validation"),
      "tsconfig.json": tsconfig(),
      ".ai/code-map/config.json": scannerConfig(),
      "src/value.ts": "export function companionValue() { return 1; }\n",
      "src/index.ts":
        'import { companionValue } from "./value.js";\n' +
        "export function useCompanion() { return companionValue(); }\n",
      "src/orphan.js": "export const orphanCompanion = true;\n",
    });
    await scanProject({ root });
    const output = join(root, ".ai/code-map");
    const mutations: Array<{ name: string; apply(): Promise<void> }> = [
      { name: "overview.md missing", apply: () => rm(join(output, "overview.md")) },
      { name: "manifest.json missing", apply: () => rm(join(output, "manifest.json")) },
      {
        name: "manifest.json unreadable",
        apply: () => chmod(join(output, "manifest.json"), 0o000),
      },
      {
        name: "manifest.json invalid",
        apply: () => writeFile(join(output, "manifest.json"), "not-json\n"),
      },
      {
        name: "project.json invalid",
        apply: () => writeFile(join(output, "project.json"), "{}\n"),
      },
      { name: "files.jsonl missing", apply: () => rm(join(output, "files.jsonl")) },
      {
        name: "symbols.jsonl invalid",
        apply: () => writeFile(join(output, "symbols.jsonl"), "not-json\n"),
      },
      { name: "relations.jsonl missing", apply: () => rm(join(output, "relations.jsonl")) },
      {
        name: "diagnostics.json invalid",
        apply: () => writeFile(join(output, "diagnostics.json"), "{}\n"),
      },
    ];

    for (const mutation of mutations) {
      await mutation.apply();
      const freshness = await checkFreshness({ root });
      expect(freshness.current, mutation.name).toBe(false);
      const repaired = await scanProject({ root });
      expect(repaired.wrote, mutation.name).toBe(true);
      await expect(loadCodeMap({ root })).resolves.toEqual(repaired.map);
      expect((await checkFreshness({ root })).current, mutation.name).toBe(true);
    }

    const coherentCorruptions: Array<{ name: string; apply(): Promise<void> }> = [
      {
        name: "an import cannot be both resolved and external",
        apply: () =>
          coherentlyTamperCompanion(root, "files.jsonl", (contents) => {
            const files = parseJsonLines<CodeMap["files"][number]>(contents);
            const importedFile = files.find((file) => file.imports.length > 0);
            if (!importedFile?.imports[0]) throw new Error("Expected a persisted import");
            importedFile.imports[0].external = true;
            return serializeJsonLines(files);
          }),
      },
      {
        name: "a resolved import requires its matching imports relation",
        apply: () =>
          coherentlyTamperCompanion(root, "relations.jsonl", (contents) => {
            const relations = parseJsonLines<CodeMap["relations"][number]>(contents);
            const imported = relations.find((relation) => relation.type === "imports");
            if (!imported) throw new Error("Expected a persisted imports relation");
            imported.to = "external:unresolved#coherent-mismatch";
            return serializeJsonLines(relations);
          }),
      },
      {
        name: "a configured compiler unit id is canonical",
        apply: async () => {
          let originalId: string | undefined;
          const changedId = "compiler-unit:configured:tampered.json";
          await coherentlyTamperCompanion(root, "project.json", (contents) => {
            const project = JSON.parse(contents) as CodeMap["project"];
            const configured = project.compilerUnits.find((unit) => unit.kind === "configured");
            if (!configured) throw new Error("Expected a configured compiler unit");
            originalId = configured.id;
            configured.id = changedId;
            return `${JSON.stringify(project, null, 2)}\n`;
          });
          if (!originalId) throw new Error("Expected the original compiler unit id");
          await coherentlyTamperCompanion(root, "files.jsonl", (contents) => {
            const files = parseJsonLines<CodeMap["files"][number]>(contents);
            for (const file of files) {
              if (file.compilerUnit === originalId) file.compilerUnit = changedId;
            }
            return serializeJsonLines(files);
          });
        },
      },
      {
        name: "a compiler unit reference must name a persisted configured unit",
        apply: () =>
          coherentlyTamperCompanion(root, "project.json", (contents) => {
            const project = JSON.parse(contents) as CodeMap["project"];
            const configured = project.compilerUnits.find((unit) => unit.kind === "configured");
            if (!configured) throw new Error("Expected a configured compiler unit");
            configured.references.push("missing-tsconfig.json");
            return `${JSON.stringify(project, null, 2)}\n`;
          }),
      },
      {
        name: "project path aliases must equal the compatibility compiler unit projection",
        apply: () =>
          coherentlyTamperCompanion(root, "project.json", (contents) => {
            const project = JSON.parse(contents) as CodeMap["project"];
            project.pathAliases["tampered-alias"] = ["src/value.ts"];
            return `${JSON.stringify(project, null, 2)}\n`;
          }),
      },
      {
        name: "an indexed configured file cannot be reassigned to the fallback unit",
        apply: async () => {
          const clean = await loadCodeMap({ root });
          const fallback = clean.project.compilerUnits.find((unit) => unit.kind === "fallback");
          const configuredFile = clean.files.find(
            (file) =>
              clean.project.compilerUnits.find((unit) => unit.id === file.compilerUnit)?.kind ===
              "configured",
          );
          if (!fallback || !configuredFile) {
            throw new Error("Expected configured and fallback ownership in the fixture");
          }
          await coherentlyTamperCompanion(root, "files.jsonl", (contents) => {
            const files = parseJsonLines<CodeMap["files"][number]>(contents);
            const changed = files.find((file) => file.path === configuredFile.path);
            if (!changed) throw new Error("Expected the configured file to reassign");
            changed.compilerUnit = fallback.id;
            return serializeJsonLines(files);
          });
        },
      },
      {
        name: "persisted line counts must equal the indexed source bytes",
        apply: () =>
          coherentlyTamperCompanion(root, "files.jsonl", (contents) => {
            const files = parseJsonLines<CodeMap["files"][number]>(contents);
            const changed = files.find((file) => file.path === "src/index.ts");
            if (!changed) throw new Error("Expected the indexed file to inflate");
            changed.lines += 100;
            return serializeJsonLines(files);
          }),
      },
      {
        name: "a symbol range must remain within its owner file",
        apply: async () => {
          const clean = await loadCodeMap({ root });
          const symbol = clean.symbols.find((candidate) => candidate.kind === "function");
          if (!symbol) throw new Error("Expected a persisted function symbol");
          const owner = clean.files.find((file) => file.path === symbol.file);
          if (!owner) throw new Error("Expected the symbol owner file");
          await coherentlyTamperCompanion(root, "symbols.jsonl", (contents) => {
            const symbols = parseJsonLines<CodeMap["symbols"][number]>(contents);
            const changed = symbols.find((candidate) => candidate.id === symbol.id);
            if (!changed) throw new Error("Expected the symbol to mutate");
            changed.range.endLine = owner.lines + 1;
            return serializeJsonLines(symbols);
          });
        },
      },
      {
        name: "a relation origin and range must agree and remain within its origin file",
        apply: async () => {
          const clean = await loadCodeMap({ root });
          const call = clean.relations.find((relation) => relation.type === "calls");
          if (!call) throw new Error("Expected a persisted call relation");
          const owner = clean.files.find((file) => file.path === call.origin.file);
          if (!owner) throw new Error("Expected the relation origin file");
          await coherentlyTamperCompanion(root, "relations.jsonl", (contents) => {
            const relations = parseJsonLines<CodeMap["relations"][number]>(contents);
            const changed = relations.find(
              (relation) => relationKey(relation) === relationKey(call),
            );
            if (!changed) throw new Error("Expected the relation to mutate");
            changed.origin.line = changed.origin.range.startLine + 1;
            changed.origin.range.endLine = owner.lines + 1;
            return serializeJsonLines(relations);
          });
        },
      },
      {
        name: "contains and exports evidence cannot move to a different file",
        apply: async () => {
          const clean = await loadCodeMap({ root });
          await coherentlyTamperCompanion(root, "relations.jsonl", (contents) => {
            const relations = parseJsonLines<CodeMap["relations"][number]>(contents);
            const movable = relations.filter(
              (candidate) => candidate.type === "contains" || candidate.type === "exports",
            );
            if (!movable.some((relation) => relation.type === "contains")) {
              throw new Error("Expected a contains relation to move");
            }
            if (!movable.some((relation) => relation.type === "exports")) {
              throw new Error("Expected an exports relation to move");
            }
            for (const relation of movable) {
              const otherFile = clean.files.find((file) => file.path !== relation.origin.file);
              if (!otherFile) throw new Error("Expected another file for moved evidence");
              relation.origin.file = otherFile.path;
              relation.origin.line = 1;
              relation.origin.range = {
                startLine: 1,
                startColumn: 1,
                endLine: 1,
                endColumn: 1,
              };
            }
            return serializeJsonLines(relations);
          });
        },
      },
    ];

    for (const corruption of coherentCorruptions) {
      await corruption.apply();
      // Rejects a test helper that accidentally invalidates an artifact or manifest hash and thus
      // never exercises the intended aggregate/cross-record validation layer.
      await expectCompanionIntegrityCoherent(root);
      expect((await checkFreshness({ root })).current, corruption.name).toBe(false);
      await expect(loadCodeMap({ root }), corruption.name).rejects.toThrow();
      const repaired = await scanProject({ root });
      expect(repaired.wrote, corruption.name).toBe(true);
      await expect(loadCodeMap({ root })).resolves.toEqual(repaired.map);
      expect((await checkFreshness({ root })).current, corruption.name).toBe(true);
    }
  }, 240_000);

  // Rejects decoding managed artifacts with replacement characters for equality/reuse, or
  // repairing corrupt bytes while still reporting wrote:false and rewriting unchanged output.
  it("repairs invalid-byte artifact corruption to canonical bytes and preserves warm mtimes", async () => {
    const root = await createProject({
      "package.json": packageJson("artifact-byte-repair"),
      "tsconfig.json": tsconfig(),
      ".ai/code-map/config.json": scannerConfig(),
      "src/index.ts":
        "export function artifactTarget() { return 1; }\n" +
        "export function useArtifactTarget() { return artifactTarget(); }\n",
    });

    await scanProject({ root });
    const canonical = await readPersistedMap(root);
    const relationsPath = join(root, ".ai/code-map/relations.jsonl");
    await writeFile(
      relationsPath,
      Buffer.concat([Buffer.from([0x80]), canonical.raw["relations.jsonl"] ?? Buffer.alloc(0)]),
    );

    expect((await checkFreshness({ root })).current).toBe(false);
    await expect(loadCodeMap({ root })).rejects.toThrow();

    const repaired = await scanProject({ root });
    expect(repaired.wrote).toBe(true);
    await expect(loadCodeMap({ root })).resolves.toEqual(repaired.map);
    expect((await checkFreshness({ root })).current).toBe(true);
    const repairedArtifacts = await readPersistedMap(root);
    for (const [name, bytes] of Object.entries(canonical.raw)) {
      expect(repairedArtifacts.raw[name]?.equals(bytes), name).toBe(true);
    }

    const repairedMtime = (await stat(relationsPath, { bigint: true })).mtimeNs;
    const unchanged = await scanProject({ root });
    expect(unchanged.wrote).toBe(false);
    expect((await stat(relationsPath, { bigint: true })).mtimeNs).toBe(repairedMtime);
  });

  // Rejects hashing replacement-decoded text during initial analysis: 0x80 and 0x81 decode to the
  // same replacement character, but their canonical source identities must remain different.
  it("uses exact raw bytes for initial and freshness hashes, including invalid UTF-8", async () => {
    const invalidSource = (byte: number): Buffer =>
      Buffer.concat([
        Buffer.from('export const invalidByte = "'),
        Buffer.from([byte]),
        Buffer.from('";\n'),
      ]);
    const firstBytes = invalidSource(0x80);
    const root = await createProject({
      "package.json": packageJson("raw-byte-hash"),
      "tsconfig.json": tsconfig({ compilerOptions: { allowJs: true, checkJs: false } }),
      ".ai/code-map/config.json": scannerConfig(["src/**/*.js"]),
      "src/invalid.js": firstBytes,
    });

    const initial = await scanProject({ root });
    const initialFile = initial.map.files.find((file) => file.path === "src/invalid.js");
    expect(initialFile?.hash).toBe(sha256(firstBytes));
    const manifestSource = initial.map.manifest.sourceFiles.find(
      (source) => source.path === "src/invalid.js",
    );
    expect(manifestSource).toMatchObject({
      path: "src/invalid.js",
      hash: sha256(firstBytes),
      compilerUnit: initialFile?.compilerUnit,
      lines: initialFile?.lines,
    });
    expect((await checkFreshness({ root })).current).toBe(true);

    const secondBytes = invalidSource(0x81);
    expect(secondBytes.toString("utf8")).toBe(firstBytes.toString("utf8"));
    await writeFile(join(root, "src/invalid.js"), secondBytes);
    expect((await checkFreshness({ root })).current).toBe(false);
    const refreshed = await scanProject({ root });
    expect(refreshed.map.files.find((file) => file.path === "src/invalid.js")?.hash).toBe(
      sha256(secondBytes),
    );
    expect((await checkFreshness({ root })).current).toBe(true);
  });

  // Rejects checking only allowJs:false: an allowJs:true exclusion or a file matched by no
  // configured unit must also have one fallback owner, one analysis, and an actionable diagnostic.
  it("analyzes every JavaScript fallback cause exactly once with a portable diagnostic", async () => {
    const scenarios = [
      {
        name: "allowJs false",
        file: "src/allow-js-false.js",
        symbol: "allowJsFalseHelper",
        config: tsconfig({
          compilerOptions: { allowJs: false, checkJs: false },
          include: ["src/**/*"],
        }),
        source:
          "export function allowJsFalseHelper() { return 1; }\n" +
          "export function useAllowJsFalse() { return allowJsFalseHelper(); }\n",
      },
      {
        name: "allowJs true but excluded",
        file: "src/excluded.jsx",
        symbol: "ExcludedView",
        config: tsconfig({
          compilerOptions: { allowJs: true, checkJs: false },
          include: ["src/**/*"],
          exclude: ["src/excluded.jsx"],
        }),
        source: "export function ExcludedView() { return <span>excluded</span>; }\n",
      },
      {
        name: "no configured inclusion",
        file: "src/unmatched.js",
        symbol: "unmatchedHelper",
        config: tsconfig({
          compilerOptions: { allowJs: true, checkJs: false },
          include: ["configured/**/*.ts"],
        }),
        source:
          "export function unmatchedHelper() { return 1; }\n" +
          "export function useUnmatched() { return unmatchedHelper(); }\n",
      },
    ];

    for (const scenario of scenarios) {
      const root = await createProject({
        "package.json": packageJson(`fallback-${scenario.name.replaceAll(" ", "-")}`),
        "tsconfig.json": scenario.config,
        ".ai/code-map/config.json": scannerConfig(["src/**/*", "configured/**/*"]),
        "configured/index.ts": "export const configured = true;\n",
        [scenario.file]: scenario.source,
      });

      const map = (await scanProject({ root })).map;
      const fallbackFile = map.files.find((file) => file.path === scenario.file);
      expect(fallbackFile, scenario.name).toBeDefined();
      const owner = map.project.compilerUnits.find(
        (unit) => unit.id === fallbackFile?.compilerUnit,
      );
      expect(owner, scenario.name).toMatchObject({ kind: "fallback", root: "." });
      expect(
        map.files.filter((file) => file.path === scenario.file),
        scenario.name,
      ).toHaveLength(1);
      expect(
        map.symbols.filter(
          (symbol) => symbol.file === scenario.file && symbol.name === scenario.symbol,
        ),
        scenario.name,
      ).toHaveLength(1);
      const diagnostic = map.diagnostics.find(
        (item) =>
          item.file === scenario.file &&
          /fallback|not included|excluded|configuration/i.test(item.message),
      );
      expect(diagnostic, scenario.name).toBeDefined();
      expect(diagnostic?.message, scenario.name).not.toContain(root);
      expect(diagnostic?.message, scenario.name).not.toMatch(/(?:[A-Za-z]:[\\/]|^\\\\|^\/)/);
    }
  });

  // Rejects a project-reference fallback that only maps rootDir:src output paths; TypeScript's
  // default root for a composite package must map root-level index.ts to dist/index.d.ts too.
  it("resolves src-root and default-root reference packages without aliases or build output", async () => {
    const root = await createProject({
      "package.json": packageJson("reference-package-root", {
        workspaces: ["packages/*"],
      }),
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "tsconfig.json": `${JSON.stringify(
        {
          files: [],
          references: [
            { path: "./packages/library" },
            { path: "./packages/root-library" },
            { path: "./packages/app" },
          ],
        },
        null,
        2,
      )}\n`,
      ".ai/code-map/config.json": scannerConfig(["packages/**/*.ts"]),
      "packages/library/package.json": packageJson("@fixture/reference-library", {
        types: "./dist/index.d.ts",
        exports: {
          ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        },
      }),
      "packages/library/tsconfig.json": tsconfig({
        compilerOptions: {
          composite: true,
          declaration: true,
          rootDir: "src",
          outDir: "dist",
        },
        include: ["src/**/*.ts"],
      }),
      "packages/library/src/index.ts": "export function libraryValue() { return 7; }\n",
      "packages/root-library/package.json": packageJson("@fixture/root-reference-library", {
        types: "./dist/index.d.ts",
        exports: {
          ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        },
      }),
      "packages/root-library/tsconfig.json": tsconfig({
        compilerOptions: {
          composite: true,
          declaration: true,
          noEmit: false,
          outDir: "dist",
        },
        include: ["index.ts"],
      }),
      "packages/root-library/index.ts": "export function rootLibraryValue() { return 11; }\n",
      "packages/app/package.json": packageJson("@fixture/reference-app", {
        dependencies: {
          "@fixture/reference-library": "workspace:*",
          "@fixture/root-reference-library": "workspace:*",
        },
      }),
      "packages/app/tsconfig.json": tsconfig({
        compilerOptions: { composite: true, rootDir: "src" },
        include: ["src/**/*.ts"],
        references: [{ path: "../library" }, { path: "../root-library" }],
      }),
      "packages/app/src/index.ts":
        'import { libraryValue } from "@fixture/reference-library";\n' +
        'import { rootLibraryValue } from "@fixture/root-reference-library";\n' +
        "export function appValue() { return libraryValue() + rootLibraryValue(); }\n",
    });
    await mkdir(join(root, "node_modules/@fixture"), { recursive: true });
    await symlink(
      "../../packages/library",
      join(root, "node_modules/@fixture/reference-library"),
      "dir",
    );
    await symlink(
      "../../packages/root-library",
      join(root, "node_modules/@fixture/root-reference-library"),
      "dir",
    );
    await expect(readFile(join(root, "packages/library/dist/index.d.ts"))).rejects.toThrow();
    await expect(readFile(join(root, "packages/root-library/dist/index.d.ts"))).rejects.toThrow();

    const map = (await scanProject({ root })).map;
    const app = map.files.find((file) => file.path === "packages/app/src/index.ts");
    expect(app?.imports).toContainEqual(
      expect.objectContaining({
        source: "@fixture/reference-library",
        resolved: "packages/library/src/index.ts",
        external: false,
      }),
    );
    expect(
      map.relations.some(
        (relation) =>
          relation.type === "calls" &&
          relation.from === "function:packages/app/src/index.ts#appValue" &&
          relation.to === "function:packages/library/src/index.ts#libraryValue",
      ),
    ).toBe(true);
    expect(app?.imports).toContainEqual(
      expect.objectContaining({
        source: "@fixture/root-reference-library",
        resolved: "packages/root-library/index.ts",
        external: false,
      }),
    );
    expect(
      map.relations.some(
        (relation) =>
          relation.type === "calls" &&
          relation.from === "function:packages/app/src/index.ts#appValue" &&
          relation.to === "function:packages/root-library/index.ts#rootLibraryValue",
      ),
    ).toBe(true);
    expect(
      map.relations.some(
        (relation) =>
          relation.type === "references" &&
          relation.to === "function:packages/root-library/index.ts#rootLibraryValue",
      ),
    ).toBe(true);
    expect(map.project.pathAliases["@fixture/reference-library"]).toBeUndefined();
    expect(map.project.pathAliases["@fixture/root-reference-library"]).toBeUndefined();
  });

  // Rejects stringly IDs where configured path "fallback" and the reserved generated fallback
  // both become compiler-unit:fallback.
  it("keeps a configured unit named fallback distinct from the generated fallback", async () => {
    const root = await createProject({
      "package.json": packageJson("collision-safe-units"),
      fallback: tsconfig({
        compilerOptions: { allowJs: false },
        include: ["src/**/*.ts"],
      }),
      ".ai/code-map/config.json": scannerConfig(["src/**/*"], "fallback"),
      "src/configured.ts": "export const configuredValue = true;\n",
      "src/orphan.js": "export const fallbackValue = true;\n",
    });

    const map = (await scanProject({ root })).map;
    const configured = map.project.compilerUnits.find(
      (unit) => unit.kind === "configured" && unit.config === "fallback",
    );
    const fallback = map.project.compilerUnits.find((unit) => unit.kind === "fallback");
    expect(configured).toBeDefined();
    expect(fallback).toBeDefined();
    expect(configured?.id).not.toBe(fallback?.id);
    expect(new Set(map.project.compilerUnits.map((unit) => unit.id)).size).toBe(
      map.project.compilerUnits.length,
    );
    expect(map.files.find((file) => file.path === "src/configured.ts")?.compilerUnit).toBe(
      configured?.id,
    );
    expect(map.files.find((file) => file.path === "src/orphan.js")?.compilerUnit).toBe(
      fallback?.id,
    );
  });

  // Rejects using the current host's path.resolve semantics for alias targets: on POSIX, drive
  // and UNC strings look relative, while parent traversal can still resolve inside the root.
  it("persists only portable relative wildcard targets from a nested tsconfig", async () => {
    const root = await createProject({
      "package.json": packageJson("nested-alias-safety"),
      "tsconfig.json": `${JSON.stringify(
        { files: [], references: [{ path: "./packages/app" }] },
        null,
        2,
      )}\n`,
      ".ai/code-map/config.json": scannerConfig(["packages/**/*.ts"]),
      "packages/app/tsconfig.json": tsconfig({
        compilerOptions: {
          composite: true,
          baseUrl: ".",
          paths: {
            "@safe/*": ["src/*"],
            "@drive/*": ["C:\\private\\drive-alias-secret\\*"],
            "@unc/*": ["\\\\server\\private-share\\unc-alias-secret\\*"],
            "@posix/*": ["/private/posix-alias-secret/*"],
            "@parent/*": ["../shared/parent-alias-secret/*"],
          },
        },
        include: ["src/**/*.ts"],
      }),
      "packages/app/src/index.ts": "export const nestedAliasValue = true;\n",
      "packages/shared/parent-alias-secret/value.ts": "export const secret = true;\n",
    });

    const map = (await scanProject({ root })).map;
    const unit = map.project.compilerUnits.find(
      (candidate) => candidate.config === "packages/app/tsconfig.json",
    );
    expect(unit?.pathAliases["@safe/*"]).toEqual(["packages/app/src/*"]);
    const persistedTargets = Object.values(unit?.pathAliases ?? {}).flat();
    for (const forbidden of [
      "C:\\private\\drive-alias-secret\\*",
      "\\\\server\\private-share\\unc-alias-secret\\*",
      "/private/posix-alias-secret/*",
      "../shared/parent-alias-secret/*",
      "packages/shared/parent-alias-secret/*",
    ]) {
      expect(
        persistedTargets.some((target) => target.includes(forbidden)),
        forbidden,
      ).toBe(false);
    }
    expect(persistedTargets).toEqual(["packages/app/src/*"]);
  });

  // Rejects host-dependent or field-specific sanitizing and one-time trust decisions that let a
  // built-in-shaped Proxy swap in mutating analyzer methods after producer classification.
  it("never persists absolute or traversing paths in any portable semantic field", async () => {
    const root = await createProject({
      "package.json": packageJson("portable-persistence", {
        dependencies: { next: "^15.0.0", react: "^19.0.0" },
      }),
      "tsconfig.json": tsconfig({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "/private/absolute alias with spaces/*": ["support/*"],
            "../traversing-alias-secret/*": ["support/*"],
            "C:\\private\\absolute-alias-secret\\*": ["support/*"],
          },
        },
        include: ["src/**/*.ts", "src/**/*.tsx", "support/**/*.ts"],
      }),
      ".ai/code-map/config.json": scannerConfig(),
      "support/type.ts":
        "export class UnindexedPortableType { readonly value = 1; }\n" +
        "export function makePortableType() { return new UnindexedPortableType(); }\n",
      "src/PortableReact.tsx":
        'import { useEffect, useMemo } from "react";\n' +
        "export function PortableReact() {\n" +
        '  useEffect(() => undefined, ["/private/effect path/portable-effect-secret"]);\n' +
        '  const value = useMemo(() => 1, ["C:\\\\memo path\\\\portable-memo-secret"]);\n' +
        "  return <span>{value}</span>;\n" +
        "}\n",
    });
    const posixAbsolute = join(
      dirname(root),
      "outside path with spaces portable-space-secret-91b3",
      "entry.js",
    );
    const windowsAbsolute = "C:\\private\\windows-secret-6ca2\\entry.js";
    const uncAbsolute = "\\\\server\\private-share\\unc-secret-48ef\\entry.js";
    const analyzerPosixAbsolute = "/private/custom-fact-secret-a18e/value.ts";
    const analyzerWindowsAbsolute = "D:\\private\\custom-fact-secret-b29f\\value.ts";
    const analyzerSpacedAbsolute = "/private/custom fact path/custom-fact-space-secret-c30a.ts";
    const supportsMutationPosix = "/private/supports-mutation-secret-d41b/value.ts";
    const supportsMutationWindows = "E:\\private\\supports-mutation-secret-e52c\\value.ts";
    const analyzeMutationPosix = "/private/analyze mutation path/analyze-mutation-secret-f63d.ts";
    const analyzeMutationWindows = "F:\\private\\analyze-mutation-secret-a74e\\value.ts";
    const corePrototypeMutation = "/private/core-prototype-mutation-secret-c96f/value.ts";
    const imports = [posixAbsolute, windowsAbsolute, uncAbsolute]
      .map((specifier) => `import ${JSON.stringify(specifier)};`)
      .join("\n");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "src/index.ts"),
      `${imports}\n` +
        'import { makePortableType } from "../support/type.js";\n' +
        "export function portableValue() { return makePortableType(); }\n" +
        `export function absoluteImportType(value: import(${JSON.stringify(
          join(root, "support/type.ts"),
        )}).UnindexedPortableType) { return value; }\n`,
    );

    const customAnalyze = vi.fn((context: Parameters<FrameworkAnalyzer["analyze"]>[0]) => {
      context.file.env.push(analyzeMutationPosix);
      context.file.operations.push({
        kind: "filesystem",
        api: analyzeMutationWindows,
        line: 1,
      });
      return {
        symbols: [
          {
            schemaVersion: context.file.schemaVersion,
            id: "function:src/index.ts#customPersistenceBoundary",
            name: "customPersistenceBoundary",
            kind: "function" as const,
            file: context.relativePath,
            range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
            exported: false,
            facts: {
              nestedPersistenceBoundary: {
                posix: analyzerPosixAbsolute,
                nested: {
                  windows: analyzerWindowsAbsolute,
                  values: [analyzerSpacedAbsolute],
                },
              },
            },
            sourceHash: context.sourceHash,
          },
        ],
      };
    });
    const customSupports = vi.fn((context: Parameters<FrameworkAnalyzer["supports"]>[0]) => {
      context.file.env.push(supportsMutationPosix);
      context.file.operations.push({
        kind: "filesystem",
        api: supportsMutationWindows,
        line: 1,
      });
      return context.relativePath === "src/index.ts";
    });
    let supportsReads = 0;
    let analyzeReads = 0;
    const persistenceBoundaryAnalyzer = new Proxy(new NextJsAnalyzer(), {
      get(target, property) {
        if (property === "supports") {
          supportsReads += 1;
          if (supportsReads === 1) {
            // Exact identity is intentional: it reproduces the former one-time trust check.
            // eslint-disable-next-line @typescript-eslint/unbound-method
            return NextJsAnalyzer.prototype.supports;
          }
          return customSupports;
        }
        if (property === "analyze") {
          analyzeReads += 1;
          if (analyzeReads === 1) {
            // Exact identity is intentional: it reproduces the former one-time trust check.
            // eslint-disable-next-line @typescript-eslint/unbound-method
            return NextJsAnalyzer.prototype.analyze;
          }
          return customAnalyze;
        }
        if (property === "name") return target.name;
        if (property === "version") return target.version;
        return undefined;
      },
    });
    // The exact method is restored in finally; retaining it unbound is deliberate here.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalCoreAnalyze = CoreAnalyzer.prototype.analyze;
    const invokeOriginalCore = originalCoreAnalyze.bind(new CoreAnalyzer());
    const mutateCorePrototype = vi.fn(() => {
      CoreAnalyzer.prototype.analyze = (context) => {
        context.file.env.push(corePrototypeMutation);
        return invokeOriginalCore(context);
      };
      return false;
    });
    const prototypeMutator: FrameworkAnalyzer = {
      name: "core-prototype-mutator",
      version: "1.0.0",
      supports: mutateCorePrototype,
      analyze: () => ({}),
    };
    let map: CodeMap;
    try {
      map = (
        await scanProject({
          root,
          analyzers: [prototypeMutator, persistenceBoundaryAnalyzer],
        })
      ).map;
    } finally {
      CoreAnalyzer.prototype.analyze = originalCoreAnalyze;
    }
    expect(mutateCorePrototype).toHaveBeenCalled();
    await expect(loadCodeMap({ root })).resolves.toEqual(map);
    expect(map.manifest.producer.kind).toBe("custom");
    expect(map.manifest.analyzers).toContainEqual(
      expect.objectContaining({ name: "nextjs", version: "0.1.0-experimental" }),
    );
    const importTypeSignature = symbolNamed(map, "absoluteImportType").signature;
    expect(importTypeSignature).not.toContain(root);
    expect(importTypeSignature).toContain("<literal>");
    const portableReact = symbolNamed(map, "PortableReact", "src/PortableReact.tsx");
    expect(portableReact.kind).toBe("react-component");
    expect(portableReact.facts.effects).toContain("<literal>");
    expect(portableReact.facts.memo).toContain("<literal>");
    const customBoundary = map.symbols.find(
      (symbol) => symbol.name === "customPersistenceBoundary" && symbol.file === "src/index.ts",
    );
    if (customBoundary) {
      expect(JSON.stringify(customBoundary.facts)).toContain("<outside-root>");
    }
    const persisted = await readPersistedMap(root);
    const strings = collectStrings(map);
    strings.push(...Object.values(persisted.raw).map((contents) => contents.toString("utf8")));
    for (const forbidden of [
      root,
      dirname(root),
      posixAbsolute,
      windowsAbsolute,
      uncAbsolute,
      "/private/absolute alias with spaces/*",
      "../traversing-alias-secret/*",
      "C:\\private\\absolute-alias-secret\\*",
      "portable-space-secret-91b3",
      "portable-effect-secret",
      "portable-memo-secret",
      analyzerPosixAbsolute,
      analyzerWindowsAbsolute,
      analyzerSpacedAbsolute,
      "custom-fact-secret-a18e",
      "custom-fact-secret-b29f",
      "custom-fact-space-secret-c30a",
      supportsMutationPosix,
      supportsMutationWindows,
      analyzeMutationPosix,
      analyzeMutationWindows,
      "supports-mutation-secret-d41b",
      "supports-mutation-secret-e52c",
      "analyze-mutation-secret-f63d",
      "analyze-mutation-secret-a74e",
      corePrototypeMutation,
      "core-prototype-mutation-secret-c96f",
    ]) {
      expect(
        strings.some((value) => value.includes(forbidden)),
        forbidden,
      ).toBe(false);
    }
    expect(strings.some((value) => value.startsWith("/"))).toBe(false);
    expect(strings.some((value) => /^[A-Za-z]:[\\/]/.test(value))).toBe(false);
    expect(strings.some((value) => /^\\\\/.test(value))).toBe(false);

    const unnamedRoot = await createProject({
      "package.json": `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
      "tsconfig.json": tsconfig(),
      ".ai/code-map/config.json": scannerConfig(),
      "src/index.ts": "export const unnamedProjectValue = true;\n",
    });
    const unnamedMap = (await scanProject({ root: unnamedRoot })).map;
    expect(unnamedMap.project.name).toBe("unnamed-project");
    const unnamedPersisted = await readPersistedMap(unnamedRoot);
    const unnamedStrings = collectStrings(unnamedMap);
    unnamedStrings.push(
      ...Object.values(unnamedPersisted.raw).map((contents) => contents.toString("utf8")),
    );
    expect(unnamedStrings.some((value) => value.includes(basename(unnamedRoot)))).toBe(false);

    const outsidePackageToken = "outside-package-symlink-secret-b85f";
    const outsidePackageRoot = await createProject({
      [`manifests/${outsidePackageToken}.json`]: packageJson(outsidePackageToken),
    });
    const symlinkedPackageRoot = await createProject({
      "tsconfig.json": tsconfig(),
      ".ai/code-map/config.json": scannerConfig(),
      "src/index.ts": "export const symlinkedPackageValue = true;\n",
    });
    await symlink(
      join(outsidePackageRoot, "manifests", `${outsidePackageToken}.json`),
      join(symlinkedPackageRoot, "package.json"),
      "file",
    );
    await expect(scanProject({ root: symlinkedPackageRoot })).rejects.toThrow();
    const rejectedArtifacts = await Promise.all(
      [
        "overview.md",
        "manifest.json",
        "project.json",
        "files.jsonl",
        "symbols.jsonl",
        "relations.jsonl",
        "diagnostics.json",
      ].map((artifact) =>
        readFile(join(symlinkedPackageRoot, ".ai/code-map", artifact)).catch(() => Buffer.alloc(0)),
      ),
    );
    expect(
      rejectedArtifacts.some((contents) => contents.toString("utf8").includes(outsidePackageToken)),
    ).toBe(false);
  });

  // Rejects treating route: as an unconditional sanitization bypass, or recognizing only native
  // POSIX paths while custom drive, UNC, file-URI, and selected-root identifiers reach artifacts.
  it("bounds custom route and endpoint text without dropping legitimate routes or built-ins", async () => {
    const root = await createProject({
      "package.json": packageJson("custom-identifier-boundary"),
      "tsconfig.json": tsconfig(),
      ".ai/code-map/config.json": scannerConfig(),
      "src/index.ts":
        "export function routeHelper() { return 1; }\n" +
        "export function routeOwner() { return routeHelper(); }\n",
    });
    const unsafeValues = [
      `${root}/selected-root-route-secret`,
      "/private/posix-route-secret/value",
      "C:\\private\\drive-route-secret\\value",
      "\\\\server\\private-share\\unc-route-secret\\value",
      "pkg/\\\\server\\share\\embedded-unc-secret",
      "file:///private/file-uri-route-secret/value",
    ];
    const customAnalyzer: FrameworkAnalyzer = {
      name: "custom-identifier-boundary",
      version: "1.0.0",
      supports: (context) => context.relativePath === "src/index.ts",
      analyze: (context) => ({
        relations: [
          ...unsafeValues.flatMap((value) => [
            {
              schemaVersion: context.file.schemaVersion,
              from: "function:src/index.ts#routeOwner",
              type: "handles-route" as const,
              to: `route:${value}`,
              confidence: 0.9,
              origin: {
                file: context.relativePath,
                line: 2,
                range: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 2 },
                explanation: "custom route contribution",
                classification: "framework-derived" as const,
                analyzer: "custom-identifier-boundary",
              },
            },
            {
              schemaVersion: context.file.schemaVersion,
              from: "function:src/index.ts#routeOwner",
              type: "depends-on" as const,
              to: `external:${value}#value`,
              confidence: 0.9,
              origin: {
                file: context.relativePath,
                line: 2,
                range: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 2 },
                explanation: "custom identifier contribution",
                classification: "framework-derived" as const,
                analyzer: "custom-identifier-boundary",
              },
            },
          ]),
          {
            schemaVersion: context.file.schemaVersion,
            from: "function:src/index.ts#routeOwner",
            type: "handles-route" as const,
            to: "route:/users/:id",
            confidence: 0.9,
            origin: {
              file: context.relativePath,
              line: 2,
              range: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 2 },
              explanation: "legitimate custom web route",
              classification: "framework-derived" as const,
              analyzer: "custom-identifier-boundary",
            },
          },
        ],
      }),
    };

    const map = (await scanProject({ root, analyzers: [customAnalyzer] })).map;
    expect(
      map.relations.some(
        (relation) => relation.type === "handles-route" && relation.to === "route:/users/:id",
      ),
    ).toBe(true);
    expect(
      map.relations.some(
        (relation) =>
          relation.type === "calls" &&
          relation.from === "function:src/index.ts#routeOwner" &&
          relation.to === "function:src/index.ts#routeHelper" &&
          relation.origin.classification === "exact",
      ),
    ).toBe(true);
    const persisted = await readPersistedMap(root);
    const strings = collectStrings(map);
    strings.push(...Object.values(persisted.raw).map((value) => value.toString("utf8")));
    for (const forbidden of [
      root,
      "selected-root-route-secret",
      "posix-route-secret",
      "drive-route-secret",
      "unc-route-secret",
      "pkg/\\\\server\\share\\embedded-unc-secret",
      "embedded-unc-secret",
      "file-uri-route-secret",
      "file:///private",
    ]) {
      expect([...new Set(strings.filter((value) => value.includes(forbidden)))], forbidden).toEqual(
        [],
      );
    }
  });

  // Rejects sanitizing only an identifier that starts with file:///: package-prefixed module text
  // can carry the same foreign host path into both FileRecord.imports and relation endpoints.
  it("quarantines embedded file URIs from built-in import records and endpoints", async () => {
    const unsafeModule = "pkg/file:///private/host-secret.ts";
    const routeShapedAbsoluteModule = "/custom/:host-secret/value.ts";
    const root = await createProject({
      "package.json": packageJson("embedded-file-uri-import"),
      "tsconfig.json": tsconfig(),
      ".ai/code-map/config.json": scannerConfig(),
      "src/index.ts":
        `import { hostSecret } from ${JSON.stringify(unsafeModule)};\n` +
        `import ${JSON.stringify(routeShapedAbsoluteModule)};\n` +
        "export function callHostSecret() { return hostSecret(); }\n",
    });

    const map = (await scanProject({ root })).map;
    expect(symbolNamed(map, "callHostSecret", "src/index.ts")).toBeDefined();
    await expect(loadCodeMap({ root })).resolves.toEqual(map);

    const source = map.files.find((file) => file.path === "src/index.ts");
    expect(source).toBeDefined();
    expect(source?.imports.some((record) => record.source.includes("file:///"))).toBe(false);
    expect(source?.imports.some((record) => record.source === routeShapedAbsoluteModule)).toBe(
      false,
    );
    expect(map.relations.some((relation) => relation.to.includes("file:///"))).toBe(false);

    const persisted = await readPersistedMap(root);
    const strings = collectStrings(map);
    strings.push(...Object.values(persisted.raw).map((value) => value.toString("utf8")));
    for (const forbidden of [
      unsafeModule,
      routeShapedAbsoluteModule,
      "file:///private",
      "/private/host-secret.ts",
    ]) {
      expect(
        strings.some((value) => value.includes(forbidden)),
        forbidden,
      ).toBe(false);
    }
  });

  // Rejects deferring schema/range validation until the aggregate map is persisted, where one
  // invalid extension record aborts the scan and erases independently valid built-in/custom facts.
  it("skips an invalid custom contribution without aborting built-in or valid custom analysis", async () => {
    const root = await createProject({
      "package.json": packageJson("invalid-custom-contribution"),
      "tsconfig.json": tsconfig(),
      ".ai/code-map/config.json": scannerConfig(),
      "src/index.ts":
        "export function builtInTarget() { return 1; }\n" +
        "export function builtInCaller() { return builtInTarget(); }\n",
      "src/z-later.ts": "export function laterBuiltInTarget() { return 2; }\n",
    });
    const validAnalyzer: FrameworkAnalyzer = {
      name: "valid-custom-contribution",
      version: "1.0.0",
      supports: (context) => context.relativePath === "src/index.ts",
      analyze: (context) => ({
        symbols: [
          {
            schemaVersion: context.file.schemaVersion,
            id: "function:src/index.ts#validCustomFact",
            name: "validCustomFact",
            kind: "function" as const,
            file: context.relativePath,
            range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
            exported: false,
            facts: { source: "valid custom analyzer" },
            sourceHash: context.sourceHash,
          },
        ],
        relations: [
          {
            schemaVersion: context.file.schemaVersion,
            from: "function:src/index.ts#builtInCaller",
            type: "depends-on" as const,
            to: "function:src/z-later.ts#laterBuiltInTarget",
            confidence: 0.9,
            origin: {
              file: context.relativePath,
              line: 2,
              range: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 2 },
              explanation: "valid forward cross-file custom dependency",
              classification: "framework-derived" as const,
              analyzer: "valid-custom-contribution",
            },
          },
        ],
      }),
    };
    const invalidFramework = "invalid-custom-framework" as unknown as Framework;
    const invalidAnalyzer: FrameworkAnalyzer = {
      name: "invalid-range-contribution",
      version: "1.0.0",
      supports: (context) => context.relativePath === "src/index.ts",
      analyze: (context) => ({
        symbols: [
          {
            schemaVersion: context.file.schemaVersion,
            id: "function:src/index.ts#invalidRangeFact",
            name: "invalidRangeFact",
            kind: "function" as const,
            file: context.relativePath,
            range: { startLine: 999, startColumn: 1, endLine: 999, endColumn: 2 },
            exported: false,
            facts: {},
            sourceHash: context.sourceHash,
          },
        ],
        relations: [
          {
            schemaVersion: context.file.schemaVersion,
            from: "function:src/index.ts#builtInCaller",
            type: "imports" as const,
            to: "external:ghost-custom-package#ghostValue",
            confidence: 0.9,
            origin: {
              file: context.relativePath,
              line: 1,
              range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
              explanation: "invalid ghost custom import",
              classification: "framework-derived" as const,
              analyzer: "invalid-range-contribution",
            },
          },
          {
            schemaVersion: context.file.schemaVersion,
            from: "file:src/index.ts",
            type: "exports" as const,
            to: "function:src/index.ts#validCustomFact",
            confidence: 0.9,
            origin: {
              file: context.relativePath,
              line: 1,
              range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
              explanation: "invalid custom export of a non-exported symbol",
              classification: "framework-derived" as const,
              analyzer: "invalid-range-contribution",
            },
          },
        ],
        frameworks: [invalidFramework],
      }),
    };

    const map = (await scanProject({ root, analyzers: [validAnalyzer, invalidAnalyzer] })).map;
    await expect(loadCodeMap({ root })).resolves.toEqual(map);

    expect(symbolNamed(map, "builtInTarget", "src/index.ts")).toBeDefined();
    expect(symbolNamed(map, "builtInCaller", "src/index.ts")).toBeDefined();
    const laterTarget = symbolNamed(map, "laterBuiltInTarget", "src/z-later.ts");
    expect(symbolNamed(map, "validCustomFact", "src/index.ts")).toBeDefined();
    expect(map.symbols.some((symbol) => symbol.name === "invalidRangeFact")).toBe(false);
    expect(
      map.relations.some(
        (relation) =>
          relation.type === "calls" &&
          relation.from === "function:src/index.ts#builtInCaller" &&
          relation.to === "function:src/index.ts#builtInTarget" &&
          relation.origin.classification === "exact",
      ),
    ).toBe(true);
    expect(
      map.relations.filter(
        (relation) =>
          relation.type === "depends-on" &&
          relation.from === "function:src/index.ts#builtInCaller" &&
          relation.to === laterTarget.id &&
          relation.origin.analyzer === validAnalyzer.name,
      ),
    ).toHaveLength(1);
    expect(
      map.relations.some(
        (relation) =>
          relation.type === "imports" && relation.to === "external:ghost-custom-package#ghostValue",
      ),
    ).toBe(false);
    expect(
      map.relations.some(
        (relation) =>
          relation.type === "exports" &&
          relation.from === "file:src/index.ts" &&
          relation.to === "function:src/index.ts#validCustomFact" &&
          relation.origin.analyzer === invalidAnalyzer.name,
      ),
    ).toBe(false);
    expect(map.files.some((file) => (file.frameworks as string[]).includes(invalidFramework))).toBe(
      false,
    );
    expect((map.project.frameworks as string[]).includes(invalidFramework)).toBe(false);
    const warning = map.diagnostics.find(
      (diagnostic) =>
        diagnostic.code === "analysis-error" &&
        diagnostic.severity === "warning" &&
        diagnostic.file === "src/index.ts" &&
        diagnostic.message.includes(invalidAnalyzer.name),
    );
    expect(warning).toBeDefined();
    expect(warning?.message).toMatch(/failed|invalid|skip/i);
    expect(warning?.message).not.toContain(root);
    expect(warning?.message).not.toContain("/private/");
  });

  // Rejects deriving external module IDs from local bindings (state/router), attributing a local
  // imported object's method to its source spelling, or ignoring checker shadowing of an import.
  it("uses imported module provenance for external calls and marks guesses unresolved", async () => {
    const root = await createProject({
      "package.json": packageJson("external-module-provenance", {
        dependencies: { react: "^19.0.0" },
      }),
      "tsconfig.json": tsconfig(),
      ".ai/code-map/config.json": scannerConfig(),
      "src/local.ts":
        "export class LocalService { run() { return 1; } }\n" +
        "export const localService = new LocalService();\n",
      "src/index.ts":
        'import router from "next/router";\n' +
        'import { useState as state } from "react";\n' +
        'import { useMemo } from "react";\n' +
        'import { localService } from "./local.js";\n' +
        "export function externalCalls() {\n" +
        "  state(0);\n" +
        '  router.push("/home");\n' +
        "  mystery();\n" +
        "}\n" +
        "export function localImportedObjectCall() { localService.run(); }\n" +
        "export function shadowedImport(useMemo: () => void) { useMemo(); }\n" +
        "export function neighboringImport() { useMemo(() => 1, []); }\n",
    });

    const map = (await scanProject({ root })).map;
    const calls = map.relations.filter(
      (relation) => relation.type === "calls" && relation.from.includes("#externalCalls"),
    );
    expect(
      calls.find((relation) => relation.to === "external:react#useState")?.origin.classification,
    ).toBe("exact");
    expect(
      calls.find((relation) => relation.to === "external:next/router#push")?.origin.classification,
    ).toBe("exact");
    expect(
      calls.find((relation) => relation.to === "external:unresolved#mystery")?.origin
        .classification,
    ).toBe("heuristic");
    expect(calls.some((relation) => relation.to === "external:state#state")).toBe(false);
    expect(calls.some((relation) => relation.to === "external:router#push")).toBe(false);

    const localCalls = map.relations.filter(
      (relation) => relation.type === "calls" && relation.from.includes("#localImportedObjectCall"),
    );
    expect(
      localCalls.some(
        (relation) =>
          relation.to === "method:src/local.ts#LocalService.run" &&
          relation.origin.classification === "exact",
      ),
    ).toBe(true);
    expect(
      localCalls.some(
        (relation) =>
          relation.to.startsWith("external:") &&
          (relation.to.includes("./local") || relation.to.includes("src/local")),
      ),
    ).toBe(false);

    const shadowedCalls = map.relations.filter(
      (relation) => relation.type === "calls" && relation.from.includes("#shadowedImport"),
    );
    expect(
      shadowedCalls.some(
        (relation) =>
          relation.to === "external:react#useMemo" && relation.origin.classification === "exact",
      ),
    ).toBe(false);
    expect(
      shadowedCalls.some(
        (relation) =>
          relation.to === "external:unresolved#useMemo" &&
          relation.origin.classification === "heuristic",
      ),
    ).toBe(true);
    expect(
      map.relations.some(
        (relation) =>
          relation.type === "calls" &&
          relation.from.includes("#neighboringImport") &&
          relation.to === "external:react#useMemo" &&
          relation.origin.classification === "exact",
      ),
    ).toBe(true);
  });

  // Rejects treating a checker-resolved but scanner-unindexed local import as an exact external
  // package merely because its declaration has no indexed symbol target.
  it("keeps scanner-unindexed local import calls uncertain instead of exact external", async () => {
    const root = await createProject({
      "package.json": packageJson("unindexed-local-import-provenance"),
      "tsconfig.json": tsconfig({ include: ["src/**/*.ts", "support/**/*.ts"] }),
      ".ai/code-map/config.json": scannerConfig(["src/**/*.ts"]),
      "src/index.ts":
        'import { local } from "../support/value.js";\n' +
        "export function useUnindexedLocal() { return local(); }\n",
      "support/value.ts": "export function local() { return 1; }\n",
    });

    const map = (await scanProject({ root })).map;
    expect(map.files.map((file) => file.path)).toEqual(["src/index.ts"]);
    const calls = map.relations.filter(
      (relation) =>
        relation.type === "calls" && relation.from === "function:src/index.ts#useUnindexedLocal",
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(
      calls.some(
        (relation) =>
          relation.to === "external:../support/value.js#local" ||
          (relation.to.includes("support/value") &&
            relation.origin.classification === "exact" &&
            relation.confidence === 1),
      ),
    ).toBe(false);
    expect(
      calls.some(
        (relation) =>
          relation.to.includes("unresolved") &&
          relation.origin.classification !== "exact" &&
          relation.confidence < 1,
      ),
    ).toBe(true);
    const persisted = await readPersistedMap(root);
    const persistedStrings = collectStrings(map);
    persistedStrings.push(...Object.values(persisted.raw).map((value) => value.toString("utf8")));
    expect(persistedStrings.some((value) => value.includes(root))).toBe(false);
  });

  // Rejects using the checker alias name "default" (or the local import spelling) instead of the
  // indexed declaration's logical component name for JSX render targets.
  it("links a default-import JSX render to the actual component exactly once", async () => {
    const root = await createProject({
      "package.json": packageJson("default-react-render", {
        dependencies: { react: "^19.0.0" },
      }),
      "tsconfig.json": tsconfig(),
      ".ai/code-map/config.json": scannerConfig(),
      "src/Child.tsx": "export default function ActualChild() { return <span>child</span>; }\n",
      "src/App.tsx":
        'import RenamedChild from "./Child.js";\n' +
        "export function App() { return <RenamedChild />; }\n",
    });

    const map = (await scanProject({ root })).map;
    const app = symbolNamed(map, "App", "src/App.tsx");
    const child = symbolNamed(map, "ActualChild", "src/Child.tsx");
    expect(child.kind).toBe("react-component");
    const renders = map.relations.filter(
      (relation) => relation.type === "renders" && relation.from === app.id,
    );
    expect(renders.filter((relation) => relation.to === child.id)).toHaveLength(1);
    expect(renders.some((relation) => /#(?:default|RenamedChild)$/.test(relation.to))).toBe(false);
  });

  // Rejects name-only or line-only React de-duplication, while also rejecting the opposite fault
  // of retaining two analyzer contributions for the very same complete evidence range.
  it("keeps every repeated JSX and custom-hook occurrence by full range", async () => {
    const root = await createProject({
      "package.json": packageJson("react-occurrence-identity", {
        dependencies: { react: "^19.0.0" },
      }),
      "tsconfig.json": tsconfig(),
      ".ai/code-map/config.json": scannerConfig(),
      "src/RepeatedChild.tsx": "export function RepeatedChild() { return <span>child</span>; }\n",
      "src/hooks.ts": '"use client";\n' + "export function useThing() { return 1; }\n",
      "src/RepeatedApp.tsx":
        'import { RepeatedChild } from "./RepeatedChild.js";\n' +
        'import { useThing } from "./hooks.js";\n' +
        "export function RepeatedApp() {\n" +
        "  useThing();\n" +
        "  useThing(); useThing();\n" +
        "  return <>\n" +
        "    <RepeatedChild />\n" +
        "    <RepeatedChild /><RepeatedChild />\n" +
        "  </>;\n" +
        "}\n",
    });

    const duplicateAnalyzer: FrameworkAnalyzer = {
      name: "duplicate-react-evidence",
      version: "1.0.0",
      supports: (context) => context.relativePath === "src/RepeatedApp.tsx",
      analyze: (context) => {
        let rendered: ts.JsxSelfClosingElement | undefined;
        let hook: ts.CallExpression | undefined;
        const visit = (node: ts.Node): void => {
          if (
            !rendered &&
            ts.isJsxSelfClosingElement(node) &&
            ts.isIdentifier(node.tagName) &&
            node.tagName.text === "RepeatedChild"
          ) {
            rendered = node;
          }
          if (
            !hook &&
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "useThing"
          ) {
            hook = node;
          }
          node.forEachChild(visit);
        };
        context.sourceFile.forEachChild(visit);
        const range = (node: ts.Node) => {
          const start = context.sourceFile.getLineAndCharacterOfPosition(
            node.getStart(context.sourceFile, false),
          );
          const end = context.sourceFile.getLineAndCharacterOfPosition(node.getEnd());
          return {
            startLine: start.line + 1,
            startColumn: start.character + 1,
            endLine: end.line + 1,
            endColumn: end.character + 1,
          };
        };
        return {
          relations: [
            ...(rendered
              ? [
                  {
                    schemaVersion: context.file.schemaVersion,
                    from: "component:src/RepeatedApp.tsx#RepeatedApp",
                    type: "renders" as const,
                    to: "component:src/RepeatedChild.tsx#RepeatedChild",
                    confidence: 0.2,
                    origin: {
                      file: context.relativePath,
                      line: range(rendered).startLine,
                      range: range(rendered),
                      explanation: "duplicate custom JSX evidence",
                      classification: "heuristic" as const,
                      analyzer: "duplicate-react-evidence",
                    },
                  },
                ]
              : []),
            ...(hook
              ? [
                  {
                    schemaVersion: context.file.schemaVersion,
                    from: "component:src/RepeatedApp.tsx#RepeatedApp",
                    type: "uses-hook" as const,
                    to: "hook:src/hooks.ts#useThing",
                    confidence: 0.2,
                    origin: {
                      file: context.relativePath,
                      line: range(hook).startLine,
                      range: range(hook),
                      explanation: "duplicate custom hook evidence",
                      classification: "heuristic" as const,
                      analyzer: "duplicate-react-evidence",
                    },
                  },
                ]
              : []),
          ],
        };
      },
    };

    const map = (await scanProject({ root, analyzers: [duplicateAnalyzer] })).map;
    const app = symbolNamed(map, "RepeatedApp", "src/RepeatedApp.tsx");
    const child = symbolNamed(map, "RepeatedChild", "src/RepeatedChild.tsx");
    const hook = symbolNamed(map, "useThing", "src/hooks.ts");
    const expectations = [
      { type: "renders", to: child.id },
      { type: "uses-hook", to: hook.id },
    ] as const;
    for (const expectation of expectations) {
      const relations = map.relations.filter(
        (relation) =>
          relation.type === expectation.type &&
          relation.from === app.id &&
          relation.to === expectation.to,
      );
      expect(relations, expectation.type).toHaveLength(3);
      expect(
        new Set(relations.map((relation) => JSON.stringify(relation.origin.range))).size,
        expectation.type,
      ).toBe(3);
      expect(new Set(relations.map((relation) => relation.origin.range.startLine)).size).toBe(2);
      const sameLine = relations.filter(
        (relation, _index, all) =>
          all.filter(
            (candidate) => candidate.origin.range.startLine === relation.origin.range.startLine,
          ).length === 2,
      );
      expect(sameLine, expectation.type).toHaveLength(2);
      expect(new Set(sameLine.map((relation) => relation.origin.range.startColumn)).size).toBe(2);
    }
  });

  // Rejects line-only relation de-duplication, which collapses distinct same-line call sites, as
  // well as retaining competing duplicate contributions for one semantic evidence range.
  it("keeps distinct same-line call sites while persisting no duplicate semantic relations", async () => {
    const root = await createProject({
      "package.json": packageJson("relation-uniqueness"),
      "tsconfig.json": tsconfig(),
      ".ai/code-map/config.json": scannerConfig(),
      "src/index.ts":
        "export function target() { return 1; }\n" +
        "export function invokeTwice() { target(); target(); }\n",
    });

    const map = (await scanProject({ root })).map;
    expect(new Set(map.relations.map(relationKey)).size).toBe(map.relations.length);
    const calls = map.relations.filter(
      (relation) =>
        relation.type === "calls" &&
        relation.from.includes("#invokeTwice") &&
        relation.to.includes("#target"),
    );
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((relation) => relation.origin.range.startColumn)).size).toBe(2);
  });

  // Rejects mutable name/version equality, overly broad parser recognition, and trust in a
  // manifest or companion whose declared integrity no longer covers its persisted bytes.
  it("authenticates built-in producers and every manifest or companion integrity field", async () => {
    const root = await createProject({
      "package.json": packageJson("producer-provenance"),
      "tsconfig.json": tsconfig(),
      ".ai/code-map/config.json": scannerConfig(),
      "src/index.ts": "export function producerValue() { return 1; }\n",
    });
    await scanProject({ root });

    const delegate = createTypeScriptSemanticResolver();
    const spoofResolve = vi.fn((input: SemanticResolveInput) => delegate.resolve(input));
    const spoof: SemanticResolver = {
      name: delegate.name,
      version: delegate.version,
      resolve: spoofResolve,
    };
    const custom = await scanProject({ root, semanticResolver: spoof });
    expect(spoofResolve).toHaveBeenCalled();
    expect(custom.wrote).toBe(true);

    const builtInResolve = vi.spyOn(TypeScriptSemanticResolver.prototype, "resolve");
    const restoredDefault = await scanProject({ root });
    expect(builtInResolve).toHaveBeenCalled();
    expect(restoredDefault.wrote).toBe(true);
    expect((await checkFreshness({ root })).current).toBe(true);

    builtInResolve.mockClear();
    const beforeExactParser = await readPersistedMap(root);
    const exactParser = await scanProject({ root, parser: new TypeScriptParserAdapter() });
    expect(exactParser.wrote).toBe(false);
    expect(builtInResolve).not.toHaveBeenCalled();
    const afterExactParser = await readPersistedMap(root);
    expect(Object.keys(afterExactParser.raw).sort()).toEqual(
      Object.keys(beforeExactParser.raw).sort(),
    );
    for (const [path, contents] of Object.entries(beforeExactParser.raw)) {
      expect(afterExactParser.raw[path]?.equals(contents), path).toBe(true);
    }

    const parserProxyTarget = new TypeScriptParserAdapter();
    const parserProxyDelegate = new TypeScriptParserAdapter();
    const customProxySupports = vi.fn(() => true);
    const customProxyParse = vi.fn((input: SyntaxParseInput) => parserProxyDelegate.parse(input));
    let parserSupportsReads = 0;
    let parserParseReads = 0;
    const parserProxy = new Proxy(parserProxyTarget, {
      get(target, property) {
        if (property === "supports") {
          parserSupportsReads += 1;
          if (parserSupportsReads === 1) {
            // Exact identity reproduces the former mutable-property provenance check.
            // eslint-disable-next-line @typescript-eslint/unbound-method
            return TypeScriptParserAdapter.prototype.supports;
          }
          return customProxySupports;
        }
        if (property === "parse") {
          parserParseReads += 1;
          if (parserParseReads === 1) {
            // Exact identity reproduces the former mutable-property provenance check.
            // eslint-disable-next-line @typescript-eslint/unbound-method
            return TypeScriptParserAdapter.prototype.parse;
          }
          return customProxyParse;
        }
        if (property === "name") return target.name;
        if (property === "version") return target.version;
        return undefined;
      },
    });
    builtInResolve.mockClear();
    const proxiedParser = await scanProject({ root, parser: parserProxy });
    expect(proxiedParser.wrote).toBe(true);
    expect(proxiedParser.map.manifest.producer.kind).toBe("custom");
    expect(builtInResolve).toHaveBeenCalled();

    builtInResolve.mockClear();
    const restoredAfterProxy = await scanProject({ root });
    expect(restoredAfterProxy.wrote).toBe(true);
    expect(builtInResolve).toHaveBeenCalled();
    expect((await checkFreshness({ root })).current).toBe(true);

    const spoofParserInputs: SyntaxParseInput[] = [];
    class SpoofedTypeScriptParser extends TypeScriptParserAdapter {
      override parse(input: SyntaxParseInput): SyntaxParseResult {
        spoofParserInputs.push(input);
        return super.parse(input);
      }
    }
    const customParser = await scanProject({ root, parser: new SpoofedTypeScriptParser() });
    expect(spoofParserInputs.length).toBeGreaterThan(0);
    expect(customParser.wrote).toBe(true);

    builtInResolve.mockClear();
    const restoredAfterParser = await scanProject({ root });
    expect(builtInResolve).toHaveBeenCalled();
    expect(restoredAfterParser.wrote).toBe(true);
    expect((await checkFreshness({ root })).current).toBe(true);

    const overriddenParser = new TypeScriptParserAdapter();
    const builtInParse = overriddenParser.parse.bind(overriddenParser);
    const overriddenParserInputs: SyntaxParseInput[] = [];
    overriddenParser.parse = (input: SyntaxParseInput): SyntaxParseResult => {
      overriddenParserInputs.push(input);
      return builtInParse(input);
    };
    const customInstance = await scanProject({ root, parser: overriddenParser });
    expect(overriddenParserInputs.length).toBeGreaterThan(0);
    expect(customInstance.wrote).toBe(true);

    builtInResolve.mockClear();
    const restoredAfterInstanceOverride = await scanProject({ root });
    expect(builtInResolve).toHaveBeenCalled();
    expect(restoredAfterInstanceOverride.wrote).toBe(true);
    expect((await checkFreshness({ root })).current).toBe(true);

    const manifestPath = join(root, ".ai/code-map/manifest.json");
    const semanticInputsTamper = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as CodeMap["manifest"];
    expect(semanticInputsTamper.semanticInputs.length).toBeGreaterThan(0);
    semanticInputsTamper.semanticInputs = [];
    await writeFile(manifestPath, `${JSON.stringify(semanticInputsTamper, null, 2)}\n`);
    expect((await checkFreshness({ root })).current).toBe(false);
    builtInResolve.mockClear();
    const repairedSemanticInputs = await scanProject({ root });
    expect(repairedSemanticInputs.wrote).toBe(true);
    expect(builtInResolve).toHaveBeenCalled();
    expect((await checkFreshness({ root })).current).toBe(true);

    const producerTamper = JSON.parse(await readFile(manifestPath, "utf8")) as CodeMap["manifest"];
    producerTamper.producer.fingerprint = "0".repeat(64);
    await writeFile(manifestPath, `${JSON.stringify(producerTamper, null, 2)}\n`);
    expect((await checkFreshness({ root })).current).toBe(false);
    builtInResolve.mockClear();
    const repairedProducer = await scanProject({ root });
    expect(repairedProducer.wrote).toBe(true);
    expect(builtInResolve).toHaveBeenCalled();
    expect((await checkFreshness({ root })).current).toBe(true);

    builtInResolve.mockClear();
    const projectPath = join(root, ".ai/code-map/project.json");
    await writeFile(projectPath, ` \n${await readFile(projectPath, "utf8")}`);
    expect((await checkFreshness({ root })).current).toBe(false);
    const repaired = await scanProject({ root });
    expect(repaired.wrote).toBe(true);
    expect(builtInResolve).toHaveBeenCalled();
    await expect(loadCodeMap({ root })).resolves.toEqual(repaired.map);
  });
});
