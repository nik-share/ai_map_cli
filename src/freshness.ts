import { promises as fs } from "node:fs";
import path from "node:path";

import ts from "typescript";

import {
  ANALYZER_VERSION,
  DEFAULT_ANALYZER_NAMES,
  DEFAULT_SEMANTIC_RESOLVER,
  DEFAULT_SYNTAX_PARSER,
} from "./constants.js";
import { effectiveFrameworks, resolveConfiguration } from "./config.js";
import { discoverSourceFiles, locateTsconfig, readPackageMetadata } from "./discovery.js";
import { CodeMapError } from "./errors.js";
import { loadCodeMapFrom } from "./storage.js";
import type {
  FreshnessResult,
  LoadCodeMapOptions,
  ManifestRecord,
  ScanChanges,
  WorkspacePackage,
} from "./types.js";
import { hashText } from "./utils/hash.js";
import { normalizeStoredPath } from "./utils/path.js";
import { compareText, mapLimit, stableJson } from "./utils/stable.js";

export async function checkFreshness(options: LoadCodeMapOptions = {}): Promise<FreshnessResult> {
  const resolved = await resolveConfiguration(options);
  let manifest: ManifestRecord;
  try {
    manifest = (await loadCodeMapFrom(resolved.outputDir)).manifest;
  } catch (error) {
    if (error instanceof CodeMapError && error.code === "MAP_NOT_FOUND") {
      return {
        status: "missing",
        current: false,
        root: resolved.root,
        outputDir: resolved.outputDir,
        reasons: ["No complete map exists; run ai-code-map scan."],
        changes: emptyChanges(),
      };
    }
    throw error;
  }

  const currentSources = await hashCurrentSources(resolved.root, resolved.config);
  const changes = compareSources(manifest.sourceFiles, currentSources);
  const packageMetadata = await readPackageMetadata(resolved.root);
  const frameworks = effectiveFrameworks(resolved.config.frameworks, packageMetadata.frameworks);
  const configHash = await computeAnalysisConfigHash(
    resolved.root,
    resolved.config,
    frameworks,
    packageMetadata.raw,
    packageMetadata.workspaces,
  );
  const reasons: string[] = [];
  if (manifest.analyzerVersion !== ANALYZER_VERSION) reasons.push("The analyzer version changed.");
  const expectedSemanticResolver = { name: DEFAULT_SEMANTIC_RESOLVER, version: ts.version };
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
  if (manifest.configHash !== configHash)
    reasons.push("Configuration or project metadata changed.");
  if (changes.added.length) reasons.push(`${changes.added.length} source file(s) were added.`);
  if (changes.modified.length)
    reasons.push(`${changes.modified.length} source file(s) were modified.`);
  if (changes.deleted.length)
    reasons.push(`${changes.deleted.length} source file(s) were deleted.`);
  if (changes.moved.length)
    reasons.push(`${changes.moved.length} source file(s) appear to have moved.`);
  const current = reasons.length === 0;
  return {
    status: current ? "current" : "stale",
    current,
    root: resolved.root,
    outputDir: resolved.outputDir,
    reasons: current ? ["Map is current."] : reasons,
    changes,
  };
}

export async function computeAnalysisConfigHash(
  root: string,
  config: Parameters<typeof discoverSourceFiles>[1],
  frameworks: string[],
  packageJson: Record<string, unknown>,
  workspaces: WorkspacePackage[] = [],
): Promise<string> {
  const tsconfig = await locateTsconfig(root, config.tsconfig);
  const inputFiles = [
    ...(tsconfig ? [tsconfig] : []),
    "pnpm-workspace.yaml",
    "pnpm-workspace.yml",
    "lerna.json",
    "rush.json",
    ...workspaces.map((workspace) => `${workspace.path}/package.json`),
  ];
  const analysisInputs = await hashExistingInputs(root, inputFiles);
  const relevantPackage = Object.fromEntries(
    ["name", "packageManager", "main", "module", "types", "typings", "bin", "exports", "workspaces"]
      .filter((key) => packageJson[key] !== undefined)
      .map((key) => [key, packageJson[key]]),
  );
  const dependencyNames = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ].flatMap((key) => {
    const value = packageJson[key];
    return value && typeof value === "object" ? Object.keys(value) : [];
  });
  return hashText(
    stableJson({
      config: {
        ...config,
        root: normalizeStoredPath(config.root),
        output: normalizeStoredPath(config.output),
      },
      frameworks,
      analysisInputs,
      package: relevantPackage,
      dependencyNames: [...new Set(dependencyNames)].sort(compareText),
    }),
  );
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

async function hashCurrentSources(
  root: string,
  config: Parameters<typeof discoverSourceFiles>[1],
): Promise<Array<{ path: string; hash: string }>> {
  const files = await discoverSourceFiles(root, config);
  return mapLimit(files, config.concurrency ?? 16, async (file) => ({
    path: file.relativePath,
    hash: hashText(await fs.readFile(file.absolutePath)),
  }));
}

function emptyChanges(): ScanChanges {
  return { added: [], modified: [], deleted: [], moved: [] };
}
