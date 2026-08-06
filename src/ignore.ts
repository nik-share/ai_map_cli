import { promises as fs } from "node:fs";
import path from "node:path";

import fg from "fast-glob";
import createIgnore, { type Ignore } from "ignore";

import type { IgnoreAdapter } from "./types.js";
import { isPathInside, normalizeStoredPath } from "./utils/path.js";
import { compareText } from "./utils/stable.js";

interface IgnoreRuleSet {
  directory: string;
  matcher: Ignore;
}

export class GitIgnoreAdapter implements IgnoreAdapter {
  readonly name = "ignore";

  async filter(root: string, paths: readonly string[]): Promise<string[]> {
    const rules = await loadIgnoreRules(root);
    return paths
      .map(normalizeStoredPath)
      .filter(isSafeRelativePath)
      .filter((candidate) => !isIgnored(candidate, rules))
      .sort(compareText);
  }
}

export function createGitIgnoreAdapter(): IgnoreAdapter {
  return new GitIgnoreAdapter();
}

async function loadIgnoreRules(root: string): Promise<IgnoreRuleSet[]> {
  const ignoreFiles = await fg([".gitignore", "**/.gitignore"], {
    cwd: root,
    onlyFiles: true,
    unique: true,
    dot: true,
    followSymbolicLinks: false,
    ignore: ["**/.git/**", "**/node_modules/**"],
  });
  const rules: IgnoreRuleSet[] = [];
  for (const relative of ignoreFiles.sort(compareIgnoreFiles)) {
    const normalizedRelative = normalizeStoredPath(relative);
    const directory = normalizeStoredPath(path.posix.dirname(normalizedRelative));
    if (directory !== "." && isIgnoredDirectory(directory, rules)) continue;
    const absolute = path.resolve(root, relative);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    const real = await fs.realpath(absolute);
    if (!isPathInside(root, real)) continue;
    rules.push({
      directory,
      matcher: createIgnore().add(await fs.readFile(real, "utf8")),
    });
  }
  return rules;
}

function isIgnoredDirectory(directory: string, rules: IgnoreRuleSet[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    const relative = relativeToRule(`${directory}/`, rule.directory);
    if (!relative) continue;
    const result = rule.matcher.test(relative);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

function isIgnored(candidate: string, rules: IgnoreRuleSet[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    const relative = relativeToRule(candidate, rule.directory);
    if (!relative) continue;
    const result = rule.matcher.test(relative);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

function relativeToRule(candidate: string, directory: string): string | undefined {
  if (directory === ".") return candidate;
  const prefix = `${directory}/`;
  return candidate.startsWith(prefix) ? candidate.slice(prefix.length) : undefined;
}

function compareIgnoreFiles(a: string, b: string): number {
  const depth = (value: string) => normalizeStoredPath(value).split("/").length;
  return depth(a) - depth(b) || compareText(a, b);
}

function isSafeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:\//.test(value) &&
    !value.split("/").includes("..")
  );
}
