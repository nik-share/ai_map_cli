import { promises as fs } from "node:fs";
import path from "node:path";

import ts from "typescript";

import {
  ANALYZER_VERSION,
  CONFIG_VERSION,
  CUSTOM_PRODUCER_ID,
  DEFAULT_ANALYZER_NAMES,
  DEFAULT_PRODUCER_ID,
  DEFAULT_SEMANTIC_RESOLVER,
  DEFAULT_SYNTAX_PARSER,
  PRODUCER_CONTRACT_VERSION,
  SCHEMA_VERSION,
} from "./constants.js";
import {
  buildCompilerUnitGraph,
  semanticDirectoryListingHash,
  type CompilerUnitGraph,
} from "./compiler-units.js";
import { effectiveFrameworks, resolveConfiguration } from "./config.js";
import {
  discoverSourceFiles,
  readPackageMetadata,
  type DiscoveredSource,
  type PackageMetadata,
} from "./discovery.js";
import { CodeMapError } from "./errors.js";
import { TYPESCRIPT_SEMANTIC_VERSION } from "./semantic.js";
import { loadCodeMapFrom } from "./storage.js";
import type {
  CodeMap,
  FreshnessResult,
  LoadCodeMapOptions,
  ProducerRecord,
  ScanChanges,
  SemanticInputRecord,
  WorkspacePackage,
} from "./types.js";
import { hashText } from "./utils/hash.js";
import { isPathInside, normalizeStoredPath, relativePosix } from "./utils/path.js";
import { compareText, mapLimit, stableJson } from "./utils/stable.js";

export async function checkFreshness(options: LoadCodeMapOptions = {}): Promise<FreshnessResult> {
  return (await inspectFreshness(options)).result;
}

export interface FreshnessInspection {
  result: FreshnessResult;
  map?: CodeMap;
}

/** Validate the committed artifact set once and retain it for the scan reuse fast path. */
export async function inspectFreshness(
  options: LoadCodeMapOptions = {},
): Promise<FreshnessInspection> {
  const resolved = await resolveConfiguration(options);
  let map: CodeMap;
  try {
    map = await loadCodeMapFrom(resolved.outputDir);
  } catch (error) {
    if (error instanceof CodeMapError && error.code === "MAP_NOT_FOUND") {
      return {
        result: {
          status: "missing",
          current: false,
          root: resolved.root,
          outputDir: resolved.outputDir,
          reasons: ["No complete map exists; run ai-code-map scan."],
          changes: emptyChanges(),
        },
      };
    }
    if (error instanceof CodeMapError) {
      return { result: invalidArtifactFreshness(resolved.root, resolved.outputDir, error) };
    }
    throw error;
  }
  const manifest = map.manifest;

  const prepared = await prepareSemanticInputs(resolved.root, resolved.config);
  const currentSources = await hashDiscoveredSources(
    prepared.discovered,
    resolved.config.concurrency ?? 16,
  );
  const changes = compareSources(manifest.sourceFiles, currentSources);
  const configHash = prepared.configHash;
  const reasons: string[] = [];
  if (manifest.analyzerVersion !== ANALYZER_VERSION) reasons.push("The analyzer version changed.");
  const expectedSemanticResolver = {
    name: DEFAULT_SEMANTIC_RESOLVER,
    version: TYPESCRIPT_SEMANTIC_VERSION,
  };
  if (stableJson(manifest.semanticResolver) !== stableJson(expectedSemanticResolver)) {
    reasons.push("The semantic resolver or TypeScript version changed.");
  }
  const expectedParser = { name: DEFAULT_SYNTAX_PARSER, version: ts.version };
  if (stableJson(manifest.syntaxParser) !== stableJson(expectedParser)) {
    reasons.push("The syntax parser or parser version changed.");
  }
  const expectedAnalyzers = DEFAULT_ANALYZER_NAMES.map((name) => ({
    name,
    version: ANALYZER_VERSION,
  })).sort((a, b) => compareText(a.name, b.name));
  if (stableJson(manifest.analyzers) !== stableJson(expectedAnalyzers)) {
    reasons.push("The enabled analyzer or rule-pack version changed.");
  }
  if (stableJson(manifest.producer) !== stableJson(defaultProducerRecord())) {
    reasons.push("The map was not produced by the compatible built-in analysis pipeline.");
  }
  if (manifest.configHash !== configHash)
    reasons.push("Configuration or project metadata changed.");
  const expectedCompilerUnits = prepared.compilerGraph.units.map((unit) => unit.record);
  const ownershipMismatch = map.files.some(
    (file) => prepared.compilerGraph.ownership.get(file.path) !== file.compilerUnit,
  );
  if (
    ownershipMismatch ||
    stableJson(map.project.compilerUnits) !== stableJson(expectedCompilerUnits)
  ) {
    reasons.push("The persisted compiler-unit graph or file ownership changed.");
  }
  const persistedFiles = new Map(map.files.map((file) => [file.path, file]));
  if (currentSources.some((source) => persistedFiles.get(source.path)?.lines !== source.lines)) {
    reasons.push("Persisted source line counts no longer match the indexed source bytes.");
  }
  const semanticInputChanges = await compareSemanticInputs(
    resolved.root,
    manifest.semanticInputs,
    resolved.config.concurrency ?? 16,
  );
  if (semanticInputChanges.length > 0) {
    reasons.push(`${semanticInputChanges.length} semantic compiler input(s) changed.`);
  }
  if (changes.added.length) reasons.push(`${changes.added.length} source file(s) were added.`);
  if (changes.modified.length)
    reasons.push(`${changes.modified.length} source file(s) were modified.`);
  if (changes.deleted.length)
    reasons.push(`${changes.deleted.length} source file(s) were deleted.`);
  if (changes.moved.length)
    reasons.push(`${changes.moved.length} source file(s) appear to have moved.`);
  const current = reasons.length === 0;
  const result: FreshnessResult = {
    status: current ? "current" : "stale",
    current,
    root: resolved.root,
    outputDir: resolved.outputDir,
    reasons: current ? ["Map is current."] : reasons,
    changes,
  };
  return current ? { result, map } : { result };
}

export function defaultProducerRecord(): ProducerRecord {
  return {
    id: DEFAULT_PRODUCER_ID,
    kind: "built-in",
    fingerprint: hashText(
      stableJson({
        id: DEFAULT_PRODUCER_ID,
        contract: PRODUCER_CONTRACT_VERSION,
        schema: SCHEMA_VERSION,
        analyzer: ANALYZER_VERSION,
        syntaxParser: { name: DEFAULT_SYNTAX_PARSER, version: ts.version },
        semanticResolver: {
          name: DEFAULT_SEMANTIC_RESOLVER,
          version: TYPESCRIPT_SEMANTIC_VERSION,
        },
        analyzers: [...DEFAULT_ANALYZER_NAMES],
        capabilities: [
          "artifact-integrity-v2",
          "compiler-unit-ownership-v3",
          "module-provenance-v2",
          "portable-paths-v2",
          "semantic-input-closure-v2",
        ],
      }),
    ),
  };
}

export function customProducerRecord(components: unknown): ProducerRecord {
  return {
    id: CUSTOM_PRODUCER_ID,
    kind: "custom",
    fingerprint: hashText(
      stableJson({
        id: CUSTOM_PRODUCER_ID,
        contract: PRODUCER_CONTRACT_VERSION,
        components,
      }),
    ),
  };
}

export interface PreparedSemanticInputs {
  packageMetadata: PackageMetadata;
  frameworks: ReturnType<typeof effectiveFrameworks>;
  discovered: DiscoveredSource[];
  compilerGraph: CompilerUnitGraph;
  configHash: string;
}

/** Shared scan/check construction for every semantic input that can affect canonical facts. */
export async function prepareSemanticInputs(
  root: string,
  config: Parameters<typeof discoverSourceFiles>[1],
): Promise<PreparedSemanticInputs> {
  const packageMetadata = await readPackageMetadata(root);
  const frameworks = effectiveFrameworks(config.frameworks, packageMetadata.frameworks);
  const discovered = await discoverSourceFiles(root, config);
  const compilerGraph = await buildCompilerUnitGraph(
    root,
    config,
    discovered,
    packageMetadata.workspaces,
  );
  const configHash = await computeAnalysisConfigHash(
    root,
    config,
    frameworks,
    packageMetadata.raw,
    packageMetadata.workspaces,
    compilerGraph,
  );
  return { packageMetadata, frameworks, discovered, compilerGraph, configHash };
}

export async function computeAnalysisConfigHash(
  root: string,
  config: Parameters<typeof discoverSourceFiles>[1],
  frameworks: string[],
  packageJson: Record<string, unknown>,
  workspaces: WorkspacePackage[],
  compilerGraph: CompilerUnitGraph,
): Promise<string> {
  const inputFiles = [
    ...compilerGraph.configInputs,
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-workspace.yml",
    "lerna.json",
    "rush.json",
    ...semanticPackageInputs(workspaces),
  ];
  const analysisInputs = await hashExistingInputs(root, inputFiles);
  return hashText(
    stableJson({
      config: {
        version: config.version,
        include: [...config.include].sort(compareText),
        exclude: [...config.exclude].sort(compareText),
        ...(config.tsconfig ? { tsconfig: normalizeStoredPath(config.tsconfig) } : {}),
        frameworks: [...config.frameworks].sort(compareText),
        includePrivateSymbols: config.includePrivateSymbols,
      },
      frameworks,
      analysisInputs,
      package: packageJson,
      compilerUnits: compilerGraph.units.map((unit) => ({
        record: unit.record,
        programRoots: unit.sourceFiles.map((file) => relativePosix(root, file)),
      })),
      ownership: [...compilerGraph.ownership.entries()].sort(([a], [b]) => compareText(a, b)),
      toolchain: {
        schema: SCHEMA_VERSION,
        config: CONFIG_VERSION,
        analyzer: ANALYZER_VERSION,
        typescript: ts.version,
        semanticResolver: TYPESCRIPT_SEMANTIC_VERSION,
        syntaxParser: DEFAULT_SYNTAX_PARSER,
        analyzers: [...DEFAULT_ANALYZER_NAMES],
      },
    }),
  );
}

function semanticPackageInputs(workspaces: WorkspacePackage[]): string[] {
  const lockfiles = [
    "pnpm-lock.yaml",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
  ];
  return [
    ...lockfiles,
    ...workspaces.flatMap((workspace) => [
      `${workspace.path}/package.json`,
      ...lockfiles.map((lockfile) => `${workspace.path}/${lockfile}`),
    ]),
  ];
}

async function hashExistingInputs(
  root: string,
  relativePaths: string[],
): Promise<Array<{ path: string; hash: string }>> {
  const output: Array<{ path: string; hash: string }> = [];
  for (const relative of [...new Set(relativePaths.map(normalizeStoredPath))].sort(compareText)) {
    const absolute = path.resolve(root, relative);
    const candidate = path.relative(root, absolute);
    if (candidate === ".." || candidate.startsWith(`..${path.sep}`) || path.isAbsolute(candidate)) {
      continue;
    }
    try {
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      const [realRoot, realInput] = await Promise.all([fs.realpath(root), fs.realpath(absolute)]);
      if (!isPathInside(realRoot, realInput)) continue;
      output.push({ path: relative, hash: hashText(await fs.readFile(absolute)) });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return output;
}

export function compareSources(
  before: Array<{ path: string; hash: string }>,
  after: Array<{ path: string; hash: string }>,
): ScanChanges {
  const beforeMap = new Map(before.map((file) => [file.path, file.hash]));
  const afterMap = new Map(after.map((file) => [file.path, file.hash]));
  const added = [...afterMap.keys()].filter((file) => !beforeMap.has(file));
  const deleted = [...beforeMap.keys()].filter((file) => !afterMap.has(file));
  const modified = [...afterMap.keys()].filter(
    (file) => beforeMap.has(file) && beforeMap.get(file) !== afterMap.get(file),
  );
  const moved: ScanChanges["moved"] = [];
  const remainingAdded = new Set(added);
  const remainingDeleted = new Set(deleted);
  for (const oldPath of deleted.sort(compareText)) {
    const hash = beforeMap.get(oldPath);
    const newPath = [...remainingAdded]
      .sort(compareText)
      .find((candidate) => afterMap.get(candidate) === hash);
    if (newPath) {
      moved.push({ from: oldPath, to: newPath });
      remainingAdded.delete(newPath);
      remainingDeleted.delete(oldPath);
    }
  }
  return {
    added: [...remainingAdded].sort(compareText),
    modified: modified.sort(compareText),
    deleted: [...remainingDeleted].sort(compareText),
    moved,
  };
}

async function hashDiscoveredSources(
  files: DiscoveredSource[],
  concurrency: number,
): Promise<Array<{ path: string; hash: string; lines: number }>> {
  return mapLimit(files, concurrency, async (file) => {
    const bytes = await fs.readFile(file.absolutePath);
    const content = bytes.toString("utf8");
    return {
      path: file.relativePath,
      hash: hashText(bytes),
      lines: content.length === 0 ? 0 : content.split(/\r\n|\r|\n/).length,
    };
  });
}

async function compareSemanticInputs(
  root: string,
  before: SemanticInputRecord[],
  concurrency: number,
): Promise<string[]> {
  const realRoot = await fs.realpath(root);
  const toolchainRoot = await fs.realpath(path.dirname(ts.getDefaultLibFilePath({})));
  const current = await mapLimit(before, concurrency, async (input) => {
    let changed: boolean;
    switch (input.kind) {
      case "file":
        changed = (await hashSemanticFileInput(root, realRoot, input.path)) !== input.hash;
        break;
      case "resolution-probe":
        changed =
          (await semanticProbeState(
            input.scope === "toolchain" ? toolchainRoot : root,
            input.scope === "toolchain" ? toolchainRoot : realRoot,
            input.path,
            input.targetKind,
          )) !== input.exists;
        break;
      case "directory-listing":
        changed =
          (await hashSemanticDirectoryInput(
            input.scope === "toolchain" ? toolchainRoot : root,
            input.scope === "toolchain" ? toolchainRoot : realRoot,
            input.path,
          )) !== input.hash;
        break;
      case "symlink":
        changed =
          (await semanticSymlinkTarget(
            input.scope === "toolchain" ? toolchainRoot : root,
            input.scope === "toolchain" ? toolchainRoot : realRoot,
            input.path,
          )) !== input.target;
        break;
      case "toolchain-file":
        changed = (await hashToolchainFileInput(input.path)) !== input.hash;
        break;
    }
    return { path: input.path, changed };
  });
  return current
    .filter((input) => input.changed)
    .map((input) => input.path)
    .sort(compareText);
}

async function hashSemanticFileInput(
  root: string,
  realRoot: string,
  relative: string,
): Promise<string | null> {
  const absolute = path.resolve(root, relative);
  if (!isPathInside(root, absolute)) return null;
  try {
    const realInput = await fs.realpath(absolute);
    if (!isPathInside(realRoot, realInput)) return null;
    const stat = await fs.stat(realInput);
    if (!stat.isFile()) return null;
    return hashText(await fs.readFile(realInput));
  } catch {
    return null;
  }
}

async function semanticProbeState(
  root: string,
  realRoot: string,
  relative: string,
  targetKind: "file" | "directory" | "readable-file",
): Promise<boolean> {
  const absolute = path.resolve(root, relative);
  if (!isPathInside(root, absolute)) return false;
  try {
    const realInput = await fs.realpath(absolute);
    if (!isPathInside(realRoot, realInput)) return false;
    const stat = await fs.stat(realInput);
    if (targetKind === "file") return stat.isFile();
    if (targetKind === "directory") return stat.isDirectory();
    if (!stat.isFile()) return false;
    const handle = await fs.open(realInput, "r");
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

async function hashSemanticDirectoryInput(
  root: string,
  realRoot: string,
  relative: string,
): Promise<string | null> {
  const absolute = path.resolve(root, relative);
  if (!isPathInside(root, absolute)) return null;
  try {
    const realInput = await fs.realpath(absolute);
    if (!isPathInside(realRoot, realInput) || !(await fs.stat(realInput)).isDirectory())
      return null;
    const candidates = ts.sys.getDirectories(absolute).sort(compareText);
    const permitted: string[] = [];
    for (const candidate of candidates) {
      try {
        const resolved = path.resolve(absolute, candidate);
        const realCandidate = await fs.realpath(resolved);
        if (isPathInside(realRoot, realCandidate)) permitted.push(candidate);
      } catch {
        // The bounded compiler host also excludes inaccessible entries.
      }
    }
    return semanticDirectoryListingHash(absolute, permitted);
  } catch {
    return null;
  }
}

async function semanticSymlinkTarget(
  root: string,
  realRoot: string,
  relative: string,
): Promise<string | null> {
  const absolute = path.resolve(root, relative);
  if (!isPathInside(root, absolute)) return null;
  try {
    const realInput = await fs.realpath(absolute);
    if (!isPathInside(realRoot, realInput)) return "<outside-root>";
    return relativePosix(realRoot, realInput);
  } catch {
    return null;
  }
}

async function hashToolchainFileInput(relative: string): Promise<string | null> {
  try {
    const libraryRoot = await fs.realpath(path.dirname(ts.getDefaultLibFilePath({})));
    const absolute = path.resolve(libraryRoot, relative);
    if (!isPathInside(libraryRoot, absolute)) return null;
    const realInput = await fs.realpath(absolute);
    if (!isPathInside(libraryRoot, realInput) || !(await fs.stat(realInput)).isFile()) return null;
    return hashText(await fs.readFile(realInput));
  } catch {
    return null;
  }
}

function invalidArtifactFreshness(
  root: string,
  outputDir: string,
  error: CodeMapError,
): FreshnessResult {
  const reason = error.message.includes("manifest integrity hash")
    ? "The persisted manifest's analyzer, producer, configuration, semantic-input, or artifact metadata failed its integrity check."
    : `The persisted artifact set is incomplete, invalid, or incompatible (${error.code}).`;
  return {
    status: "stale",
    current: false,
    root,
    outputDir,
    reasons: [reason],
    changes: emptyChanges(),
  };
}

function emptyChanges(): ScanChanges {
  return { added: [], modified: [], deleted: [], moved: [] };
}
