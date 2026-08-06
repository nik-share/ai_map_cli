import path from "node:path";

import { CodeMapError } from "../errors.js";

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function relativePosix(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  if (relative === "" || isRelativeInside(relative)) {
    return toPosixPath(relative || ".");
  }
  throw new CodeMapError(
    "PATH_OUTSIDE_ROOT",
    `Path ${absolutePath} is outside project root ${root}.`,
  );
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || isRelativeInside(relative);
}

function isRelativeInside(relative: string): boolean {
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function normalizeStoredPath(value: string): string {
  const normalized = path.posix.normalize(toPosixPath(value));
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}
