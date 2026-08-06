import { promises as fs } from "node:fs";
import path from "node:path";

import fg from "fast-glob";

import type { CodeMapConfig, Framework, Language, WorkspacePackage } from "./types.js";
import { packageEntryPoints } from "./package-metadata.js";
import { isPathInside, normalizeStoredPath, relativePosix } from "./utils/path.js";
import { compareText, mapLimit } from "./utils/stable.js";
import { createWorkspaceDiscovery } from "./workspaces.js";
import { createGitIgnoreAdapter } from "./ignore.js";

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i;

export interface PackageMetadata {
  name: string;
  packageManager?: string;
  dependencies: Set<string>;
  frameworks: Framework[];
  entryPoints: string[];
  workspaces: WorkspacePackage[];
  raw: Record<string, unknown>;
}

export interface DiscoveredSource {
  absolutePath: string;
  relativePath: string;
  language: Language;
}

export async function readPackageMetadata(root: string): Promise<PackageMetadata> {
  const raw = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const dependencies = new Set<string>();
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const values = raw[field];
    if (values && typeof values === "object") {
      for (const name of Object.keys(values)) dependencies.add(name);
    }
  }

  const frameworks: Framework[] = ["typescript", "node"];
  if (dependencies.has("react")) frameworks.push("react");
  if (dependencies.has("next")) frameworks.push("nextjs", "react");
  if (dependencies.has("@nestjs/core") || dependencies.has("@nestjs/common"))
    frameworks.push("nestjs");

  const workspaceDiscovery = await createWorkspaceDiscovery().discover(root);
  return {
    name: typeof raw.name === "string" ? raw.name : path.basename(root),
    ...(typeof raw.packageManager === "string" ? { packageManager: raw.packageManager } : {}),
    dependencies,
    frameworks: [...new Set(frameworks)].sort(),
    entryPoints: packageEntryPoints(raw),
    workspaces: workspaceDiscovery.packages,
    raw,
  };
}

export async function discoverSourceFiles(
  root: string,
  config: CodeMapConfig,
): Promise<DiscoveredSource[]> {
  const matches = await fg(config.include, {
    cwd: root,
    onlyFiles: true,
    unique: true,
    dot: false,
    followSymbolicLinks: false,
    ignore: config.exclude,
  });

  const permitted = new Set(await createGitIgnoreAdapter().filter(root, matches));
  const candidates = matches
    .filter((relative) => permitted.has(normalizeStoredPath(relative)))
    .filter((relative) => SOURCE_EXTENSION.test(relative))
    .map((relative) => ({
      absolutePath: path.resolve(root, relative),
      relativePath: normalizeStoredPath(relative),
      language: languageFromPath(relative),
    }))
    .sort((a, b) => compareText(a.relativePath, b.relativePath));

  const safe = await mapLimit(candidates, config.concurrency ?? 16, async (candidate) => {
    const stat = await fs.lstat(candidate.absolutePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
    const [realRoot, real] = await Promise.all([
      fs.realpath(root),
      fs.realpath(candidate.absolutePath),
    ]);
    return isPathInside(realRoot, real) ? candidate : undefined;
  });
  return safe.filter((candidate): candidate is DiscoveredSource => candidate !== undefined);
}

export async function locateTsconfig(
  root: string,
  configured?: string,
): Promise<string | undefined> {
  const candidates = configured ? [configured] : ["tsconfig.json", "jsconfig.json"];
  for (const candidate of candidates) {
    const absolute = path.resolve(root, candidate);
    if (!isPathInside(root, absolute)) continue;
    try {
      if ((await fs.stat(absolute)).isFile()) return relativePosix(root, absolute);
    } catch {
      // Missing candidates are expected during discovery.
    }
  }
  return undefined;
}

function languageFromPath(filePath: string): Language {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  return extension as Language;
}
