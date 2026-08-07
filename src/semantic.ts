import path from "node:path";

import ts from "typescript";

import { SCHEMA_VERSION } from "./constants.js";
import {
  BoundedTypeScriptFileSystem,
  fallbackCompilerOptions,
  sanitizeCompilerPathAliases,
} from "./compiler-units.js";
import type {
  DiagnosticRecord,
  SemanticResolution,
  SemanticResolveInput,
  SemanticResolver,
} from "./types.js";
import {
  isPathInside,
  isSafeRelativePathPattern,
  normalizeStoredPath,
  relativePosix,
  redactAbsolutePathsInText,
} from "./utils/path.js";
import { compareText } from "./utils/stable.js";

export const TYPESCRIPT_SEMANTIC_VERSION = `compiler-units-v3+typescript-${ts.version}`;

/** TypeScript remains authoritative for all TypeScript/JavaScript semantic facts. */
export class TypeScriptSemanticResolver implements SemanticResolver {
  readonly name = "typescript-program";
  readonly version = TYPESCRIPT_SEMANTIC_VERSION;

  resolve(input: SemanticResolveInput): SemanticResolution {
    const compiler = loadCompilerConfiguration(input.root, input.tsconfig);
    const currentDirectory = input.tsconfig
      ? path.dirname(path.resolve(input.root, input.tsconfig))
      : input.root;
    const fileSystem = compiler.fileSystem;
    const host = createBoundedCompilerHost(
      input.root,
      currentDirectory,
      compiler.options,
      fileSystem,
      compiler.parsedCommands,
    );
    const cache = ts.createModuleResolutionCache(
      currentDirectory,
      (fileName) => host.getCanonicalFileName(fileName),
      compiler.options,
    );
    const resolveProjectReferenceModule = createProjectReferenceModuleResolver(
      input.root,
      compiler.projectReferences ?? [],
      fileSystem,
      compiler.parsedCommands,
    );
    const resolveModule = (
      moduleName: string,
      containingFile: string,
    ): ts.ResolvedModuleFull | undefined => {
      const normal = ts.resolveModuleName(
        moduleName,
        containingFile,
        compiler.options,
        host,
        cache,
      ).resolvedModule;
      return resolveProjectReferenceModule(moduleName) ?? normal;
    };
    host.resolveModuleNameLiterals = (moduleLiterals, containingFile) =>
      moduleLiterals.map((literal) => {
        const resolvedModule = resolveModule(literal.text, containingFile);
        return { resolvedModule };
      });
    const rootNames = [...new Set(input.sourceFiles.map((file) => path.resolve(file)))].sort(
      compareText,
    );
    const program = ts.createProgram({
      rootNames,
      options: compiler.options,
      ...(compiler.projectReferences?.length
        ? { projectReferences: compiler.projectReferences }
        : {}),
      host,
      // Reference edges are parsed and fingerprinted by the compiler-unit graph. A read-only
      // scanner resolves their source imports directly so correctness never depends on prebuilt
      // declaration outputs being present beside a referenced project.
      configFileParsingDiagnostics: compiler.rawDiagnostics,
    });
    return {
      program,
      checker: program.getTypeChecker(),
      pathAliases: compiler.pathAliases,
      diagnostics: compiler.diagnostics,
      semanticInputs: () => fileSystem.semanticInputs(),
      resolveModule(moduleName, containingFile) {
        const resolved = resolveModule(moduleName, containingFile);
        return resolved
          ? {
              resolvedFileName: resolved.resolvedFileName,
              isExternalLibraryImport: Boolean(resolved.isExternalLibraryImport),
            }
          : undefined;
      },
    };
  }
}

interface ReferencedPackage {
  name: string;
  root: string;
  manifest: Record<string, unknown>;
  parsed: ts.ParsedCommandLine;
}

/**
 * TypeScript normally resolves a referenced package through its emitted declaration entrypoint.
 * A scanner cannot require users to build first, so map a missing referenced-package output back
 * to a source owned by that referenced project. This is deliberately limited to direct, in-root
 * references and static package metadata.
 */
function createProjectReferenceModuleResolver(
  root: string,
  references: readonly ts.ProjectReference[],
  fileSystem: BoundedTypeScriptFileSystem,
  parsedCommands: Map<string, ts.ParsedCommandLine>,
): (moduleName: string) => ts.ResolvedModuleFull | undefined {
  const packages: ReferencedPackage[] = [];
  for (const reference of references) {
    const configPath = ts.resolveProjectReferencePath(reference);
    if (!isPathInside(root, configPath)) continue;
    const parsed = parseCommand(root, configPath, fileSystem, parsedCommands);
    if (!parsed) continue;
    const packageRoot = path.dirname(configPath);
    const packageJsonPath = path.join(packageRoot, "package.json");
    const raw = fileSystem.readFile(packageJsonPath);
    if (!raw) continue;
    try {
      const manifest = JSON.parse(raw) as Record<string, unknown>;
      if (typeof manifest.name !== "string" || manifest.name.length === 0) continue;
      packages.push({ name: manifest.name, root: packageRoot, manifest, parsed });
    } catch {
      // Invalid package metadata remains a normal unresolved import.
    }
  }
  packages.sort((a, b) => b.name.length - a.name.length || compareText(a.name, b.name));

  return (moduleName) => {
    const referenced = packages.find(
      (candidate) => moduleName === candidate.name || moduleName.startsWith(`${candidate.name}/`),
    );
    if (!referenced) return undefined;
    const subpath =
      moduleName === referenced.name ? "" : moduleName.slice(referenced.name.length + 1);
    const source = referencedPackageSource(referenced, subpath, fileSystem);
    if (!source) return undefined;
    return {
      resolvedFileName: source,
      extension: moduleExtension(source),
      isExternalLibraryImport: false,
    };
  };
}

function referencedPackageSource(
  referenced: ReferencedPackage,
  subpath: string,
  fileSystem: BoundedTypeScriptFileSystem,
): string | undefined {
  const { parsed, root: packageRoot, manifest } = referenced;
  // Composite project references default rootDir to the configuration directory. Assuming a
  // conventional src/ directory breaks valid root-level packages and declaration redirects.
  const rootDir = parsed.options.rootDir ?? packageRoot;
  if (!isPathInside(packageRoot, rootDir)) return undefined;
  const owned = new Set(parsed.fileNames.map((fileName) => path.resolve(fileName)));
  const requestedTargets = packageEntryTargets(manifest, subpath);
  const bases: string[] = [];

  for (const target of requestedTargets) {
    const absoluteTarget = path.resolve(packageRoot, target);
    if (!isPathInside(packageRoot, absoluteTarget)) continue;
    const outDir = parsed.options.outDir;
    if (outDir && isPathInside(outDir, absoluteTarget)) {
      bases.push(path.resolve(rootDir, path.relative(outDir, absoluteTarget)));
    }
    bases.push(absoluteTarget);
  }
  bases.push(path.resolve(rootDir, subpath || "index"));

  for (const base of bases) {
    for (const candidate of sourceModuleCandidates(base)) {
      const absolute = path.resolve(candidate);
      if (
        isPathInside(packageRoot, absolute) &&
        owned.has(absolute) &&
        fileSystem.fileExists(absolute)
      ) {
        return fileSystem.realpath(absolute);
      }
    }
  }

  const expectedStem = normalizeModuleStem(subpath || "index");
  const matching = [...owned]
    .filter((fileName) => isPathInside(rootDir, fileName))
    .filter((fileName) => {
      const relative = normalizeModuleStem(relativePosix(rootDir, fileName));
      return relative === expectedStem || relative === `${expectedStem}/index`;
    })
    .sort(compareText);
  return matching[0];
}

function packageEntryTargets(manifest: Record<string, unknown>, subpath: string): string[] {
  const output: string[] = [];
  const exportKey = subpath ? `./${subpath}` : ".";
  const exportsValue = manifest.exports;
  if (exportsValue && typeof exportsValue === "object" && !Array.isArray(exportsValue)) {
    const exportsRecord = exportsValue as Record<string, unknown>;
    const keyed = exportsRecord[exportKey];
    collectStaticPackageTargets(
      keyed ?? (!subpath && !("." in exportsRecord) ? exportsValue : undefined),
      output,
    );
  } else if (!subpath) {
    collectStaticPackageTargets(exportsValue, output);
  }
  if (!subpath) {
    for (const field of ["types", "typings", "source", "module", "main"] as const) {
      const value = manifest[field];
      if (typeof value === "string") output.push(value);
    }
  }
  return [...new Set(output)];
}

function collectStaticPackageTargets(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStaticPackageTargets(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of ["types", "import", "default", "require", "node"]) {
    if (key in record) collectStaticPackageTargets(record[key], output);
  }
}

function sourceModuleCandidates(value: string): string[] {
  const stem = value
    .replace(/\.d\.(?:ts|mts|cts)$/i, "")
    .replace(/\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/i, "");
  const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
  return [
    value,
    ...extensions.map((extension) => `${stem}${extension}`),
    ...extensions.map((extension) => path.join(stem, `index${extension}`)),
  ];
}

function normalizeModuleStem(value: string): string {
  return normalizeStoredPath(value)
    .replace(/\.d\.(?:ts|mts|cts)$/i, "")
    .replace(/\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/i, "");
}

function moduleExtension(fileName: string): ts.Extension {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.Extension.Tsx;
  if (lower.endsWith(".mts")) return ts.Extension.Mts;
  if (lower.endsWith(".cts")) return ts.Extension.Cts;
  if (lower.endsWith(".jsx")) return ts.Extension.Jsx;
  if (lower.endsWith(".mjs")) return ts.Extension.Mjs;
  if (lower.endsWith(".cjs")) return ts.Extension.Cjs;
  if (lower.endsWith(".js")) return ts.Extension.Js;
  return ts.Extension.Ts;
}

export function createTypeScriptSemanticResolver(): SemanticResolver {
  return new TypeScriptSemanticResolver();
}

export function createBoundedModuleResolver(
  root: string,
  currentDirectory: string,
  options: ts.CompilerOptions,
): NonNullable<SemanticResolution["resolveModule"]> {
  const fileSystem = new BoundedTypeScriptFileSystem(root);
  const cache = ts.createModuleResolutionCache(
    currentDirectory,
    (fileName) => (ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase()),
    options,
  );
  const host: ts.ModuleResolutionHost = {
    fileExists: fileSystem.fileExists,
    readFile: fileSystem.readFile,
    directoryExists: fileSystem.directoryExists,
    getDirectories: fileSystem.getDirectories,
    realpath: fileSystem.realpath,
    getCurrentDirectory: () => currentDirectory,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  };
  return (moduleName, containingFile) => {
    const resolved = ts.resolveModuleName(
      moduleName,
      containingFile,
      options,
      host,
      cache,
    ).resolvedModule;
    return resolved
      ? {
          resolvedFileName: resolved.resolvedFileName,
          isExternalLibraryImport: Boolean(resolved.isExternalLibraryImport),
        }
      : undefined;
  };
}

interface CompilerConfiguration {
  options: ts.CompilerOptions;
  projectReferences?: readonly ts.ProjectReference[];
  pathAliases: Record<string, string[]>;
  diagnostics: DiagnosticRecord[];
  rawDiagnostics: readonly ts.Diagnostic[];
  fileSystem: BoundedTypeScriptFileSystem;
  parsedCommands: Map<string, ts.ParsedCommandLine>;
}

function loadCompilerConfiguration(root: string, tsconfig?: string): CompilerConfiguration {
  const fileSystem = new BoundedTypeScriptFileSystem(root);
  if (!tsconfig) {
    return {
      options: fallbackCompilerOptions(root),
      pathAliases: {},
      diagnostics: [],
      rawDiagnostics: [],
      fileSystem,
      parsedCommands: new Map(),
    };
  }

  const absolute = path.resolve(root, tsconfig);
  if (!isPathInside(root, absolute) || !fileSystem.fileExists(absolute)) {
    const diagnostic: DiagnosticRecord = {
      schemaVersion: SCHEMA_VERSION,
      code: "compiler-config",
      severity: "warning",
      message:
        "The owning TypeScript configuration was unavailable or unsafe; fallback options were used.",
      ...(isPathInside(root, absolute) ? { file: relativePosix(root, absolute) } : {}),
    };
    return {
      options: fallbackCompilerOptions(root),
      pathAliases: {},
      diagnostics: [diagnostic],
      rawDiagnostics: [],
      fileSystem,
      parsedCommands: new Map(),
    };
  }

  const parsedCommands = new Map<string, ts.ParsedCommandLine>();
  const parsed = parseCommand(root, absolute, fileSystem, parsedCommands);
  if (!parsed) {
    return {
      options: fallbackCompilerOptions(root),
      pathAliases: {},
      diagnostics: [
        {
          schemaVersion: SCHEMA_VERSION,
          code: "compiler-config",
          severity: "warning",
          message:
            "The owning TypeScript configuration could not be parsed; fallback options were used.",
          file: relativePosix(root, absolute),
        },
      ],
      rawDiagnostics: [],
      fileSystem,
      parsedCommands,
    };
  }
  const projectReferences = (parsed.projectReferences ?? []).filter((reference) => {
    const target = ts.resolveProjectReferencePath(reference);
    return isPathInside(root, target) && fileSystem.fileExists(target);
  });
  const options = parsed.options;
  anchorCompilerOptions(root, path.dirname(absolute), options);
  return {
    options,
    ...(projectReferences.length > 0 ? { projectReferences } : {}),
    pathAliases: pathAliases(root, path.dirname(absolute), options),
    diagnostics: parsed.errors.map((diagnostic) => compilerDiagnostic(diagnostic, root)),
    rawDiagnostics: parsed.errors,
    fileSystem,
    parsedCommands,
  };
}

function parseCommand(
  root: string,
  configPath: string,
  fileSystem: BoundedTypeScriptFileSystem,
  cache: Map<string, ts.ParsedCommandLine>,
): ts.ParsedCommandLine | undefined {
  const absolute = path.resolve(configPath);
  const cached = cache.get(absolute);
  if (cached) return cached;
  if (!isPathInside(root, absolute) || !fileSystem.fileExists(absolute)) return undefined;
  try {
    const source = ts.readJsonConfigFile(absolute, fileSystem.readFile);
    const parsed = ts.parseJsonSourceFileConfigFileContent(
      source,
      fileSystem.parseHost(path.dirname(absolute)),
      path.dirname(absolute),
      undefined,
      absolute,
      undefined,
      undefined,
      fileSystem.extendedConfigCache,
    );
    parsed.projectReferences = (parsed.projectReferences ?? []).filter((reference) => {
      const target = ts.resolveProjectReferencePath(reference);
      return isPathInside(root, target) && fileSystem.fileExists(target);
    });
    anchorCompilerOptions(root, path.dirname(absolute), parsed.options);
    cache.set(absolute, parsed);
    return parsed;
  } catch {
    return undefined;
  }
}

function createBoundedCompilerHost(
  root: string,
  currentDirectory: string,
  options: ts.CompilerOptions,
  fileSystem: BoundedTypeScriptFileSystem,
  parsedCommands: Map<string, ts.ParsedCommandLine>,
): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true) as ts.CompilerHost & {
    useSourceOfProjectReferenceRedirect?: () => boolean;
  };
  host.getCurrentDirectory = () => currentDirectory;
  host.fileExists = fileSystem.fileExists;
  host.readFile = fileSystem.readFile;
  host.directoryExists = fileSystem.directoryExists;
  host.getDirectories = fileSystem.getDirectories;
  host.readDirectory = (rootDir, extensions, excludes, includes, depth) => [
    ...fileSystem.readDirectory(rootDir, extensions, excludes, includes, depth),
  ];
  host.realpath = fileSystem.realpath;
  host.getEnvironmentVariable = () => "";
  host.writeFile = () => undefined;
  host.getParsedCommandLine = (configFileName) =>
    parseCommand(root, configFileName, fileSystem, parsedCommands);
  host.useSourceOfProjectReferenceRedirect = () => true;
  return host;
}

function anchorCompilerOptions(
  root: string,
  unitDirectory: string,
  options: ts.CompilerOptions,
): void {
  options.configFilePath = options.configFilePath ?? path.join(unitDirectory, "tsconfig.json");
  if (!options.typeRoots) options.typeRoots = boundedTypeRoots(root, unitDirectory);
  else options.typeRoots = options.typeRoots.filter((entry) => isPathInside(root, entry));
  if (options.baseUrl && !isPathInside(root, options.baseUrl)) options.baseUrl = undefined;
  if (options.rootDirs)
    options.rootDirs = options.rootDirs.filter((entry) => isPathInside(root, entry));
  sanitizeCompilerPathAliases(options);
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

function pathAliases(
  root: string,
  configDirectory: string,
  options: ts.CompilerOptions,
): Record<string, string[]> {
  const base =
    options.baseUrl ??
    (options as ts.CompilerOptions & { pathsBasePath?: string }).pathsBasePath ??
    configDirectory;
  const paths = (options.paths ?? {}) as Record<string, string[]>;
  return Object.fromEntries(
    Object.entries(paths)
      .filter(([alias]) => isSafeRelativePathPattern(alias))
      .sort(([a], [b]) => compareText(a, b))
      .map(([alias, values]) => [
        alias,
        values
          .filter(isSafeRelativePathPattern)
          .map((value) => path.resolve(base, value))
          .filter((value) => isPathInside(root, value))
          .map((value) => normalizeStoredPath(relativePosix(root, value)))
          .filter((value, index, entries) => entries.indexOf(value) === index)
          .sort(compareText),
      ]),
  );
}

export function compilerDiagnostic(diagnostic: ts.Diagnostic, root: string): DiagnosticRecord {
  const message = sanitizeCompilerMessage(
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    root,
  );
  const file = diagnostic.file;
  const start =
    file && diagnostic.start !== undefined
      ? file.getLineAndCharacterOfPosition(diagnostic.start)
      : undefined;
  let relativeFile: string | undefined;
  if (file) {
    try {
      relativeFile = relativePosix(root, file.fileName);
    } catch {
      // Never persist absolute or out-of-root compiler paths.
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    code: diagnostic.file ? "parse-error" : "compiler-config",
    severity:
      diagnostic.category === ts.DiagnosticCategory.Error
        ? "error"
        : diagnostic.category === ts.DiagnosticCategory.Warning
          ? "warning"
          : "info",
    message,
    ...(relativeFile ? { file: relativeFile } : {}),
    ...(start ? { line: start.line + 1, column: start.character + 1 } : {}),
  };
}

function sanitizeCompilerMessage(message: string, root: string): string {
  return redactAbsolutePathsInText(message, root) || "TypeScript reported a compiler diagnostic.";
}
