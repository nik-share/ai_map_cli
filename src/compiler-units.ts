import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import fg from "fast-glob";
import ts from "typescript";

import { SCHEMA_VERSION } from "./constants.js";
import type {
  CodeMapConfig,
  CompilerUnitRecord,
  DiagnosticRecord,
  SemanticInputObservation,
  WorkspacePackage,
} from "./types.js";
import type { DiscoveredSource } from "./discovery.js";
import {
  isPathInside,
  isSafeRelativePathPattern,
  normalizeStoredPath,
  relativePosix,
} from "./utils/path.js";
import { configuredCompilerUnitId, generatedCompilerUnitId } from "./ids.js";
import { hashText } from "./utils/hash.js";
import { compareText } from "./utils/stable.js";

const CONFIG_PATTERNS = ["**/tsconfig.json", "**/jsconfig.json", "**/tsconfig.*.json"];
const CONFIG_IGNORES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.ai/**",
  "**/.next/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
];
const FALLBACK_UNIT_ID = generatedCompilerUnitId("fallback");

export interface CompilerUnitPlan {
  record: CompilerUnitRecord;
  sourceFiles: string[];
  ownedFiles: string[];
}

export interface CompilerUnitGraph {
  units: CompilerUnitPlan[];
  ownership: Map<string, string>;
  configInputs: string[];
  diagnostics: DiagnosticRecord[];
  primaryConfig?: string;
}

interface ParsedConfigNode {
  absolutePath: string;
  relativePath: string;
  parsed: ts.ParsedCommandLine;
  source: ts.TsConfigSourceFile;
  sourceFiles: string[];
  sourceFileKeys: Set<string>;
  references: string[];
  extends: string[];
  pathAliases: Record<string, string[]>;
  hasOwnFileSelection: boolean;
  allowJs: boolean;
  valid: boolean;
}

/**
 * Build the bounded compiler configuration graph and assign every indexed source exactly once.
 * The returned plan contains normalized records only; compiler objects are intentionally omitted.
 */
export async function buildCompilerUnitGraph(
  root: string,
  config: CodeMapConfig,
  sources: readonly DiscoveredSource[],
  workspaces: readonly WorkspacePackage[],
): Promise<CompilerUnitGraph> {
  const realRoot = realpathSync(root);
  const diagnostics: DiagnosticRecord[] = [];
  const fileSystem = new BoundedTypeScriptFileSystem(realRoot);
  const candidatePaths = await discoverConfigCandidates(realRoot, config, diagnostics);
  const parsedByPath = new Map<string, ParsedConfigNode>();
  const queue = [...candidatePaths];

  while (queue.length > 0) {
    const candidate = queue.shift();
    if (!candidate) continue;
    const logical = normalizeStoredPath(candidate);
    if (parsedByPath.has(logical)) continue;
    const absolute = path.resolve(realRoot, logical);
    const node = parseConfigNode(realRoot, absolute, fileSystem, diagnostics);
    if (!node) continue;
    parsedByPath.set(node.relativePath, node);
    for (const reference of node.references) {
      if (!parsedByPath.has(reference) && !queue.includes(reference)) queue.push(reference);
    }
    queue.sort(compareText);
  }

  const indexedKeys = new Set(sources.map((source) => canonicalPath(source.absolutePath)));
  const boundaryPaths = [".", ...workspaces.map((workspace) => workspace.path)].sort((a, b) =>
    compareText(a, b),
  );
  const seedPaths = new Set<string>();
  const configured = configuredTsconfigPath(realRoot, config.tsconfig, diagnostics);
  if (configured) seedPaths.add(configured);
  for (const conventional of ["tsconfig.json", "jsconfig.json"]) {
    if (parsedByPath.has(conventional)) seedPaths.add(conventional);
  }
  const extendedDependencies = new Set([...parsedByPath.values()].flatMap((node) => node.extends));
  const referenceTargets = new Set([...parsedByPath.values()].flatMap((node) => node.references));
  for (const node of parsedByPath.values()) {
    const directory = normalizeStoredPath(path.posix.dirname(node.relativePath));
    const atBoundary = boundaryPaths.includes(directory);
    const intersects = [...node.sourceFileKeys].some((file) => indexedKeys.has(file));
    const conventional = ["tsconfig.json", "jsconfig.json"].includes(
      path.posix.basename(node.relativePath),
    );
    const extendsOnlyBase =
      extendedDependencies.has(node.relativePath) &&
      !node.hasOwnFileSelection &&
      !conventional &&
      !referenceTargets.has(node.relativePath) &&
      configured !== node.relativePath;
    if (!extendsOnlyBase && (atBoundary || intersects)) seedPaths.add(node.relativePath);
  }

  // References from a retained solution/config node remain graph nodes even when they own no files.
  const retained = new Set<string>();
  const retainQueue = [...seedPaths].sort(compareText);
  while (retainQueue.length > 0) {
    const current = retainQueue.shift();
    if (!current || retained.has(current)) continue;
    const node = parsedByPath.get(current);
    if (!node) continue;
    retained.add(current);
    for (const reference of node.references) {
      if (!retained.has(reference)) retainQueue.push(reference);
    }
    retainQueue.sort(compareText);
  }

  const nodes = [...retained]
    .map((relative) => parsedByPath.get(relative))
    .filter((node): node is ParsedConfigNode => node !== undefined && node.valid)
    .sort((a, b) => compareText(a.relativePath, b.relativePath));
  const validNodePaths = new Set(nodes.map((node) => node.relativePath));
  const ownership = new Map<string, string>();
  const ownedByUnit = new Map<string, string[]>();
  const jsFallbackWarnings = new Set<string>();

  for (const source of [...sources].sort((a, b) => compareText(a.relativePath, b.relativePath))) {
    const sourceKey = canonicalPath(source.absolutePath);
    const selected = nodes.filter((node) => node.sourceFileKeys.has(sourceKey));
    const jsSource = isJavaScriptSourceFile(source.absolutePath);
    const eligible = jsSource ? selected.filter((node) => node.allowJs) : selected;
    const owner = chooseOwner(eligible, source.absolutePath, realRoot, boundaryPaths);
    if (jsSource && !owner && !jsFallbackWarnings.has(source.relativePath)) {
      jsFallbackWarnings.add(source.relativePath);
      const underDisallowingConfig = nodes.some(
        (node) =>
          !node.allowJs && isPathInside(path.dirname(node.absolutePath), source.absolutePath),
      );
      const underAllowingConfig = nodes.some(
        (node) =>
          node.allowJs && isPathInside(path.dirname(node.absolutePath), source.absolutePath),
      );
      const reason =
        selected.length > 0 || underDisallowingConfig
          ? "the applicable configuration does not allow JavaScript"
          : underAllowingConfig
            ? "the nearby JavaScript-enabled configuration does not include the file"
            : "no eligible configuration includes the file";
      diagnostics.push({
        ...graphDiagnostic(
          `A selected JavaScript source uses fallback compiler ownership because ${reason}.`,
          source.relativePath,
        ),
        severity: "warning",
      });
    }
    const ownerId = owner ? configuredCompilerUnitId(owner.relativePath) : FALLBACK_UNIT_ID;
    ownership.set(source.relativePath, ownerId);
    const owned = ownedByUnit.get(ownerId) ?? [];
    owned.push(source.absolutePath);
    ownedByUnit.set(ownerId, owned);
  }

  const units: CompilerUnitPlan[] = nodes.map((node) => {
    const rootPath = normalizeStoredPath(path.posix.dirname(node.relativePath));
    const id = configuredCompilerUnitId(node.relativePath);
    return {
      record: {
        id,
        kind: "configured",
        root: rootPath,
        config: node.relativePath,
        references: node.references.filter((reference) => validNodePaths.has(reference)),
        extends: node.extends,
        pathAliases: node.pathAliases,
      },
      sourceFiles: node.sourceFiles,
      ownedFiles: (ownedByUnit.get(id) ?? []).sort(compareText),
    };
  });

  units.push({
    record: {
      id: FALLBACK_UNIT_ID,
      kind: "fallback",
      root: ".",
      references: [],
      extends: [],
      pathAliases: {},
    },
    sourceFiles: (ownedByUnit.get(FALLBACK_UNIT_ID) ?? []).sort(compareText),
    ownedFiles: (ownedByUnit.get(FALLBACK_UNIT_ID) ?? []).sort(compareText),
  });

  const configInputs = new Set<string>();
  for (const node of parsedByPath.values()) {
    configInputs.add(node.relativePath);
    for (const extended of node.extends) configInputs.add(extended);
  }

  const primaryConfig =
    configured && validNodePaths.has(configured)
      ? configured
      : ["tsconfig.json", "jsconfig.json"].find((candidate) => validNodePaths.has(candidate));
  return {
    units: units.sort((a, b) => compareText(a.record.id, b.record.id)),
    ownership,
    configInputs: [...configInputs].sort(compareText),
    diagnostics: normalizeGraphDiagnostics(diagnostics),
    ...(primaryConfig ? { primaryConfig } : {}),
  };
}

async function discoverConfigCandidates(
  root: string,
  config: CodeMapConfig,
  diagnostics: DiagnosticRecord[],
): Promise<string[]> {
  const matches = await fg(CONFIG_PATTERNS, {
    cwd: root,
    onlyFiles: true,
    unique: true,
    dot: false,
    followSymbolicLinks: false,
    ignore: [...CONFIG_IGNORES, ...config.exclude],
  });
  const candidates = new Set(matches.map(normalizeStoredPath));
  if (config.tsconfig) {
    const configured = configuredTsconfigPath(root, config.tsconfig, diagnostics);
    if (configured) candidates.add(configured);
  }
  return [...candidates]
    .filter((candidate) => safeRegularFile(root, path.resolve(root, candidate)))
    .sort(compareText);
}

function configuredTsconfigPath(
  root: string,
  configured: string | undefined,
  diagnostics: DiagnosticRecord[],
): string | undefined {
  if (!configured) return undefined;
  const absolute = path.resolve(root, configured);
  if (!isPathInside(root, absolute) || !safeRegularFile(root, absolute)) {
    diagnostics.push(
      graphDiagnostic("The configured TypeScript project is unavailable or unsafe."),
    );
    return undefined;
  }
  return relativePosix(root, absolute);
}

function parseConfigNode(
  root: string,
  absolutePath: string,
  fileSystem: BoundedTypeScriptFileSystem,
  diagnostics: DiagnosticRecord[],
): ParsedConfigNode | undefined {
  if (!safeRegularFile(root, absolutePath)) {
    diagnostics.push(graphDiagnostic("A TypeScript project reference was unavailable or unsafe."));
    return undefined;
  }
  const relativePath = relativePosix(root, absolutePath);
  let source: ts.TsConfigSourceFile;
  try {
    source = ts.readJsonConfigFile(absolutePath, fileSystem.readFile);
  } catch {
    diagnostics.push(
      graphDiagnostic("A TypeScript configuration could not be read.", relativePath),
    );
    return undefined;
  }
  const host = fileSystem.parseHost(path.dirname(absolutePath));
  let parsed: ts.ParsedCommandLine;
  try {
    parsed = ts.parseJsonSourceFileConfigFileContent(
      source,
      host,
      path.dirname(absolutePath),
      undefined,
      absolutePath,
      undefined,
      undefined,
      fileSystem.extendedConfigCache,
    );
  } catch {
    diagnostics.push(
      graphDiagnostic("A TypeScript configuration could not be parsed.", relativePath),
    );
    return undefined;
  }

  const optionSafety = sanitizeCompilerOptions(parsed.options, root, path.dirname(absolutePath));
  if (!optionSafety.valid) {
    diagnostics.push(
      graphDiagnostic("A TypeScript configuration option escaped the selected root.", relativePath),
    );
  }
  const parsedSourceFiles = parsed.fileNames
    .filter((fileName) => safeRegularFile(root, fileName))
    .map((fileName) => realpathSync(fileName))
    .filter((fileName, index, values) => values.indexOf(fileName) === index)
    .sort(compareText);
  const sourceFiles = parsedSourceFiles
    .filter((fileName) => {
      if (parsed.options.allowJs === true) return true;
      return !isJavaScriptSourceFile(fileName);
    })
    .sort(compareText);
  const references: string[] = [];
  const safeReferences: ts.ProjectReference[] = [];
  for (const reference of parsed.projectReferences ?? []) {
    const target = ts.resolveProjectReferencePath(reference);
    if (!safeRegularFile(root, target)) {
      diagnostics.push(
        graphDiagnostic("A TypeScript project reference escaped the selected root.", relativePath),
      );
      continue;
    }
    references.push(relativePosix(root, target));
    safeReferences.push(reference);
  }
  parsed.projectReferences = safeReferences.sort((a, b) =>
    compareText(ts.resolveProjectReferencePath(a), ts.resolveProjectReferencePath(b)),
  );

  const extended = (source.extendedSourceFiles ?? [])
    .filter((fileName) => safeRegularFile(root, fileName))
    .map((fileName) => relativePosix(root, realpathSync(fileName)))
    .filter((fileName, index, values) => values.indexOf(fileName) === index)
    .sort(compareText);
  if ((source.extendedSourceFiles ?? []).length !== extended.length) {
    diagnostics.push(
      graphDiagnostic("A TypeScript extends dependency escaped the selected root.", relativePath),
    );
  }
  for (const error of parsed.errors) {
    if (error.category === ts.DiagnosticCategory.Error) {
      diagnostics.push(
        graphDiagnostic("TypeScript reported an invalid project configuration.", relativePath),
      );
      break;
    }
  }
  const configText = fileSystem.readFile(absolutePath) ?? "";
  const rawConfig = ts.parseConfigFileTextToJson(absolutePath, configText).config as
    Record<string, unknown> | undefined;

  return {
    absolutePath,
    relativePath,
    parsed,
    source,
    sourceFiles,
    sourceFileKeys: new Set(parsedSourceFiles.map(canonicalPath)),
    references: [...new Set(references)].sort(compareText),
    extends: extended,
    pathAliases: normalizePathAliases(root, path.dirname(absolutePath), parsed.options),
    hasOwnFileSelection: Boolean(
      rawConfig &&
      (Object.prototype.hasOwnProperty.call(rawConfig, "files") ||
        Object.prototype.hasOwnProperty.call(rawConfig, "include")),
    ),
    allowJs: parsed.options.allowJs === true,
    valid: optionSafety.valid,
  };
}

function sanitizeCompilerOptions(
  options: ts.CompilerOptions,
  root: string,
  unitDirectory: string,
): { valid: boolean } {
  let valid = true;
  const validatePath = (value: string | undefined): string | undefined => {
    if (!value) return value;
    const absolute = path.resolve(value);
    if (!isPathInside(root, absolute)) {
      valid = false;
      return undefined;
    }
    return absolute;
  };
  options.baseUrl = validatePath(options.baseUrl);
  options.rootDir = validatePath(options.rootDir);
  options.outDir = validatePath(options.outDir);
  options.declarationDir = validatePath(options.declarationDir);
  if (options.rootDirs) {
    const values = options.rootDirs
      .map((entry) => validatePath(entry))
      .filter((entry): entry is string => entry !== undefined);
    options.rootDirs = values;
  }
  if (options.typeRoots) {
    const values = options.typeRoots
      .map((entry) => validatePath(entry))
      .filter((entry): entry is string => entry !== undefined);
    options.typeRoots = values;
  } else {
    options.typeRoots = boundedTypeRoots(root, unitDirectory);
  }
  sanitizeCompilerPathAliases(options);
  options.configFilePath = options.configFilePath ?? path.join(unitDirectory, "tsconfig.json");
  return { valid };
}

export function sanitizeCompilerPathAliases(options: ts.CompilerOptions): void {
  if (!options.paths) return;
  const sanitized: Record<string, string[]> = {};
  for (const [alias, targets] of Object.entries(options.paths).sort(([a], [b]) =>
    compareText(a, b),
  )) {
    if (!isSafeRelativePathPattern(alias)) continue;
    const safeTargets = targets.filter(isSafeRelativePathPattern);
    if (safeTargets.length > 0) sanitized[alias] = safeTargets;
  }
  options.paths = sanitized;
}

function boundedTypeRoots(root: string, start: string): string[] {
  const values: string[] = [];
  let current = path.resolve(start);
  while (isPathInside(root, current)) {
    values.push(path.join(current, "node_modules", "@types"));
    if (current === path.resolve(root)) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [...new Set(values)];
}

function normalizePathAliases(
  root: string,
  configDirectory: string,
  options: ts.CompilerOptions,
): Record<string, string[]> {
  const base =
    options.baseUrl ??
    (options as ts.CompilerOptions & { pathsBasePath?: string }).pathsBasePath ??
    configDirectory;
  const output: Record<string, string[]> = {};
  const paths = (options.paths ?? {}) as Record<string, string[]>;
  for (const [alias, targets] of Object.entries(paths).sort(([a], [b]) => compareText(a, b))) {
    if (!isSafeRelativePathPattern(alias)) continue;
    const normalized: string[] = [];
    for (const target of targets) {
      if (!isSafeRelativePathPattern(target)) continue;
      const absolute = path.resolve(base, target);
      if (!isPathInside(root, absolute)) continue;
      normalized.push(relativePosix(root, absolute));
    }
    output[alias] = [...new Set(normalized)].sort(compareText);
  }
  return output;
}

function chooseOwner(
  eligible: ParsedConfigNode[],
  sourceFile: string,
  root: string,
  boundaries: string[],
): ParsedConfigNode | undefined {
  return [...eligible].sort((a, b) => {
    const packageDepthA = deepestSharedBoundaryDepth(a.absolutePath, sourceFile, root, boundaries);
    const packageDepthB = deepestSharedBoundaryDepth(b.absolutePath, sourceFile, root, boundaries);
    if (packageDepthA !== packageDepthB) return packageDepthB - packageDepthA;
    const directoryDepthA = ancestorDepth(path.dirname(a.absolutePath), sourceFile, root);
    const directoryDepthB = ancestorDepth(path.dirname(b.absolutePath), sourceFile, root);
    if (directoryDepthA !== directoryDepthB) return directoryDepthB - directoryDepthA;
    return compareText(a.relativePath, b.relativePath);
  })[0];
}

function deepestSharedBoundaryDepth(
  configPath: string,
  sourcePath: string,
  root: string,
  boundaries: string[],
): number {
  let depth = -1;
  for (const boundary of boundaries) {
    const absolute = path.resolve(root, boundary);
    if (isPathInside(absolute, configPath) && isPathInside(absolute, sourcePath)) {
      depth = Math.max(depth, pathDepth(relativePosix(root, absolute)));
    }
  }
  return depth;
}

function ancestorDepth(directory: string, sourcePath: string, root: string): number {
  return isPathInside(directory, sourcePath) ? pathDepth(relativePosix(root, directory)) : -1;
}

function pathDepth(value: string): number {
  return value === "." ? 0 : value.split("/").length;
}

function isJavaScriptSourceFile(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return (
    extension === ".js" || extension === ".jsx" || extension === ".mjs" || extension === ".cjs"
  );
}

function safeRegularFile(root: string, candidate: string): boolean {
  try {
    const absolute = path.resolve(candidate);
    if (!isPathInside(root, absolute)) return false;
    if (lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isFile()) return false;
    return isPathInside(realpathSync(root), realpathSync(absolute));
  } catch {
    return false;
  }
}

function canonicalPath(fileName: string): string {
  try {
    const real = realpathSync(fileName);
    return ts.sys.useCaseSensitiveFileNames ? real : real.toLowerCase();
  } catch {
    const absolute = path.resolve(fileName);
    return ts.sys.useCaseSensitiveFileNames ? absolute : absolute.toLowerCase();
  }
}

function graphDiagnostic(message: string, file?: string): DiagnosticRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    code: "compiler-config",
    severity: "warning",
    message,
    ...(file ? { file } : {}),
  };
}

function normalizeGraphDiagnostics(values: DiagnosticRecord[]): DiagnosticRecord[] {
  const byKey = new Map<string, DiagnosticRecord>();
  for (const value of values) byKey.set(`${value.file ?? ""}\u0000${value.message}`, value);
  return [...byKey.values()].sort((a, b) =>
    compareText(`${a.file ?? ""}\u0000${a.message}`, `${b.file ?? ""}\u0000${b.message}`),
  );
}

/** A synchronous, root-anchored host for TypeScript config parsing and Program construction. */
export class BoundedTypeScriptFileSystem {
  readonly extendedConfigCache = new Map<string, ts.ExtendedConfigCacheEntry>();
  private readonly root: string;
  private readonly typeScriptLib: string;
  private readonly observedInputs = new Map<string, SemanticInputObservation>();

  constructor(root: string) {
    this.root = realpathSync(root);
    this.typeScriptLib = realpathSync(path.dirname(ts.getDefaultLibFilePath({})));
  }

  readonly fileExists = (fileName: string): boolean => {
    const absolute = this.absolute(fileName);
    if (!this.isPermitted(absolute)) return false;
    try {
      const exists = statSync(absolute).isFile();
      this.recordProbe(absolute, "file", exists);
      return exists;
    } catch {
      this.recordProbe(absolute, "file", false);
      return false;
    }
  };

  readonly readFile = (fileName: string): string | undefined => {
    const absolute = this.absolute(fileName);
    if (!this.isPermitted(absolute)) return undefined;
    try {
      const contents = readFileSync(absolute);
      this.recordRead(absolute, contents);
      return contents.toString("utf8");
    } catch {
      let exists = false;
      try {
        exists = statSync(absolute).isFile();
      } catch {
        // The file is absent or cannot be inspected.
      }
      this.recordProbe(absolute, "file", exists);
      this.recordProbe(absolute, "readable-file", false);
      return undefined;
    }
  };

  readonly directoryExists = (directory: string): boolean => {
    const absolute = this.absolute(directory);
    if (!this.isPermitted(absolute)) return false;
    try {
      const exists = statSync(absolute).isDirectory();
      this.recordProbe(absolute, "directory", exists);
      return exists;
    } catch {
      this.recordProbe(absolute, "directory", false);
      return false;
    }
  };

  readonly getDirectories = (directory: string): string[] => {
    const absolute = this.absolute(directory);
    if (!this.isPermitted(absolute)) return [];
    if (!this.directoryExists(absolute)) return [];
    const directories = ts.sys
      .getDirectories(absolute)
      .filter((entry) => this.isPermitted(path.resolve(absolute, entry)))
      .sort(compareText);
    this.recordDirectoryListing(absolute, directories);
    return directories;
  };

  readonly readDirectory: ts.ParseConfigHost["readDirectory"] = (
    rootDir,
    extensions,
    excludes,
    includes,
    depth,
  ) => {
    const absolute = this.absolute(rootDir);
    if (!this.isPermitted(absolute)) return [];
    return ts.sys
      .readDirectory(absolute, extensions, excludes, includes, depth)
      .filter((entry) => this.isPermitted(path.resolve(absolute, entry)))
      .sort(compareText);
  };

  readonly realpath = (candidate: string): string => {
    const absolute = this.absolute(candidate);
    if (!this.isPermitted(absolute)) return absolute;
    try {
      const real = realpathSync(absolute);
      this.recordSymlink(absolute, real);
      return real;
    } catch {
      return absolute;
    }
  };

  parseHost(currentDirectory: string): ts.ParseConfigFileHost {
    return {
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      getCurrentDirectory: () => currentDirectory,
      fileExists: this.fileExists,
      readFile: this.readFile,
      readDirectory: this.readDirectory,
      directoryExists: this.directoryExists,
      getDirectories: this.getDirectories,
      realpath: this.realpath,
      onUnRecoverableConfigFileDiagnostic: () => undefined,
    };
  }

  semanticInputs(): SemanticInputObservation[] {
    return [...this.observedInputs.values()].sort((a, b) =>
      compareText(semanticObservationKey(a), semanticObservationKey(b)),
    );
  }

  private recordProbe(
    absolute: string,
    targetKind: "file" | "directory" | "readable-file",
    exists: boolean,
  ): void {
    const scoped = this.semanticScope(absolute);
    if (!scoped) return;
    const relative = relativePosix(scoped.root, absolute);
    const contentKey =
      targetKind === "directory"
        ? `directory-listing\u0000${scoped.scope}\u0000${relative}`
        : scoped.scope === "toolchain"
          ? `toolchain-file\u0000${relative}`
          : `file\u0000${relative}`;
    if (this.observedInputs.has(contentKey)) return;
    const observation: SemanticInputObservation = {
      path: relative,
      kind: "resolution-probe",
      scope: scoped.scope,
      targetKind,
      exists,
    };
    this.observedInputs.set(semanticObservationKey(observation), observation);
  }

  private recordRead(absolute: string, contents: Buffer): void {
    if (isPathInside(this.root, absolute)) {
      const relative = relativePosix(this.root, absolute);
      this.observedInputs.delete(`resolution-probe\u0000project\u0000file\u0000${relative}`);
      this.observedInputs.delete(
        `resolution-probe\u0000project\u0000readable-file\u0000${relative}`,
      );
      const observation: SemanticInputObservation = {
        path: relative,
        kind: "file",
        hash: hashText(contents),
      };
      this.observedInputs.set(semanticObservationKey(observation), observation);
      return;
    }
    if (isPathInside(this.typeScriptLib, absolute)) {
      const relative = relativePosix(this.typeScriptLib, absolute);
      this.observedInputs.delete(`resolution-probe\u0000toolchain\u0000file\u0000${relative}`);
      this.observedInputs.delete(
        `resolution-probe\u0000toolchain\u0000readable-file\u0000${relative}`,
      );
      const observation: SemanticInputObservation = {
        // Preserve the lexical file TypeScript opened. Hashing only a resolved target would miss
        // a same-version standard-library symlink being repointed to different bytes.
        path: relative,
        kind: "toolchain-file",
        hash: hashText(contents),
      };
      this.observedInputs.set(semanticObservationKey(observation), observation);
    }
  }

  private recordDirectoryListing(absolute: string, entries: string[]): void {
    const scoped = this.semanticScope(absolute);
    if (!scoped) return;
    const relative = relativePosix(scoped.root, absolute);
    this.observedInputs.delete(
      `resolution-probe\u0000${scoped.scope}\u0000directory\u0000${relative}`,
    );
    const observation: SemanticInputObservation = {
      path: relative,
      kind: "directory-listing",
      scope: scoped.scope,
      hash: semanticDirectoryListingHash(absolute, entries),
    };
    this.observedInputs.set(semanticObservationKey(observation), observation);
  }

  private recordSymlink(absolute: string, real: string): void {
    const scoped = this.semanticScope(absolute);
    if (!scoped) return;
    const relative = relativePosix(scoped.root, absolute);
    const target = isPathInside(scoped.root, real)
      ? relativePosix(scoped.root, real)
      : "<outside-root>";
    if (relative === target) return;
    const observation: SemanticInputObservation = {
      path: relative,
      kind: "symlink",
      scope: scoped.scope,
      target,
    };
    this.observedInputs.set(semanticObservationKey(observation), observation);
  }

  private semanticScope(
    absolute: string,
  ): { scope: "project" | "toolchain"; root: string } | undefined {
    if (isPathInside(this.root, absolute)) return { scope: "project", root: this.root };
    if (isPathInside(this.typeScriptLib, absolute)) {
      return { scope: "toolchain", root: this.typeScriptLib };
    }
    return undefined;
  }

  private isPermitted(candidate: string): boolean {
    const absolute = this.absolute(candidate);
    const lexicalInRoot = isPathInside(this.root, absolute);
    const lexicalInToolchain = isPathInside(this.typeScriptLib, absolute);
    const lexicalAllowed = lexicalInRoot || lexicalInToolchain;
    if (!lexicalAllowed) return false;
    if (!existsSync(absolute)) return true;
    try {
      const real = realpathSync(absolute);
      this.recordSymlink(absolute, real);
      return (
        (lexicalInRoot && isPathInside(this.root, real)) ||
        (lexicalInToolchain && isPathInside(this.typeScriptLib, real))
      );
    } catch {
      return false;
    }
  }

  private absolute(candidate: string): string {
    return path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(this.root, candidate);
  }
}

export function semanticDirectoryListingHash(directory: string, entries: string[]): string {
  const normalized = entries
    .map((entry) => normalizeStoredPath(path.relative(directory, path.resolve(directory, entry))))
    .sort(compareText);
  return hashText(Buffer.from(normalized.join("\u0000"), "utf8"));
}

function semanticObservationKey(observation: SemanticInputObservation): string {
  return observation.kind === "resolution-probe"
    ? `${observation.kind}\u0000${observation.scope ?? "project"}\u0000${observation.targetKind}\u0000${observation.path}`
    : observation.kind === "directory-listing" || observation.kind === "symlink"
      ? `${observation.kind}\u0000${observation.scope ?? "project"}\u0000${observation.path}`
      : `${observation.kind}\u0000${observation.path}`;
}

export function fallbackCompilerOptions(root: string): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    jsx: ts.JsxEmit.Preserve,
    experimentalDecorators: true,
    configFilePath: path.join(root, "tsconfig.fallback.json"),
    typeRoots: boundedTypeRoots(root, root),
  };
}
