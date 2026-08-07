import { promises as fs } from "node:fs";
import path from "node:path";

import { CodeMapError } from "../errors.js";

export function isAbsolutePath(value: string): boolean {
  const normalized = toPosixPath(value);
  return (
    path.posix.isAbsolute(normalized) ||
    /^[a-zA-Z]:[\\/]/.test(normalized) ||
    normalized.startsWith("//")
  );
}

export function isFileSystemUri(value: string): boolean {
  return /^file:(?:\/\/|\/)/i.test(value.trim());
}

function hasEmbeddedDoubleSlashPath(value: string): boolean {
  const normalized = toPosixPath(value);
  let index = normalized.indexOf("//");
  while (index >= 0) {
    const previous = index > 0 ? normalized[index - 1] : undefined;
    if (previous !== ":") return true;
    index = normalized.indexOf("//", index + 1);
  }
  return false;
}

export function hasEmbeddedAbsolutePath(value: string): boolean {
  const normalized = toPosixPath(value);
  return (
    isAbsolutePath(normalized) ||
    isFileSystemUri(normalized) ||
    hasEmbeddedDoubleSlashPath(normalized) ||
    /(?:^|\/)[A-Za-z]:(?:\/|$)/.test(normalized) ||
    /(?:^|\/)file:(?:\/|$)/i.test(normalized)
  );
}

export function isSafeRelativePathPattern(value: string): boolean {
  const normalized = toPosixPath(value);
  return (
    normalized.length > 0 &&
    !hasEmbeddedAbsolutePath(normalized) &&
    !normalized.split("/").includes("..")
  );
}

/** Distinguish recognizable host paths from ordinary web-route syntax. */
export function looksLikeHostFilePath(value: string, root?: string): boolean {
  const trimmed = value.trim();
  if (
    /file:(?:\/\/|\/)/i.test(trimmed) ||
    /(?:^|[/])[A-Za-z]:[\\/]/.test(trimmed) ||
    /^\\\\/.test(trimmed) ||
    hasEmbeddedDoubleSlashPath(trimmed)
  ) {
    return true;
  }
  const normalized = toPosixPath(trimmed);
  if (root) {
    const normalizedRoot = toPosixPath(path.resolve(root));
    if (
      normalized === normalizedRoot ||
      normalized.startsWith(`${normalizedRoot}/`) ||
      normalized.includes(normalizedRoot)
    )
      return true;
  }
  return /^\/(?:Users|home|root|private|tmp|var|etc|usr|opt|Volumes|mnt|proc|dev)(?:\/|$)/.test(
    normalized,
  );
}

export function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

export function relativePosix(root: string, absolutePath: string): string {
  if (!isAbsolutePath(absolutePath)) {
    throw new CodeMapError(
      "PATH_OUTSIDE_ROOT",
      `Path ${absolutePath} is outside project root ${root}.`,
    );
  }
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
  if (isAbsolutePath(candidate) && !path.isAbsolute(candidate)) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || isRelativeInside(relative);
}

export async function isSafeRegularFile(root: string, candidate: string): Promise<boolean> {
  const absolute = path.resolve(candidate);
  if (!isPathInside(root, absolute)) return false;
  try {
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(absolute)]);
    return isPathInside(realRoot, realFile);
  } catch {
    return false;
  }
}

export async function readFileInsideRoot(root: string, candidate: string): Promise<Buffer> {
  const absolute = path.resolve(candidate);
  if (!(await isSafeRegularFile(root, absolute))) {
    throw new CodeMapError(
      "PATH_OUTSIDE_ROOT",
      `Refusing to read an unavailable, symbolic, or out-of-root file at ${absolute}.`,
    );
  }
  return fs.readFile(absolute);
}

function isRelativeInside(relative: string): boolean {
  const normalized = toPosixPath(relative);
  if (normalized === "" || normalized === ".") return true;
  if (isAbsolutePath(normalized)) return false;
  return normalized !== ".." && !normalized.startsWith("../") && !normalized.startsWith("..\\");
}

export function redactAbsolutePathsInText(message: string, root: string): string {
  const normalizedRoot = path.resolve(root);
  const redact = (candidate: string): string => {
    const trimmed = candidate.replace(/[)\].,;:]+$/, "");
    if (!isAbsolutePath(trimmed) && !isFileSystemUri(trimmed)) return candidate;
    if (isFileSystemUri(trimmed)) return "<outside-root>";
    const foreignWindowsPath = path.win32.isAbsolute(trimmed) && !path.posix.isAbsolute(trimmed);
    if (foreignWindowsPath && path.posix.isAbsolute(normalizedRoot)) return "<outside-root>";
    try {
      if (isPathInside(normalizedRoot, trimmed)) {
        return relativePosix(normalizedRoot, trimmed);
      }
    } catch {
      // Fall back to opaque marker.
    }
    return "<outside-root>";
  };

  // Handle quoted paths and known roots first so spaces cannot split a machine path into
  // separately persisted fragments.
  let redacted = message.replace(
    /(["'`])([^"'`\r\n]+)\1/g,
    (quoted: string, quote: string, contents: string) =>
      isAbsolutePath(contents) || isFileSystemUri(contents)
        ? `${quote}${redact(contents)}${quote}`
        : quoted,
  );
  for (const rootVariant of [normalizedRoot, toPosixPath(normalizedRoot)].sort(
    (a, b) => b.length - a.length,
  )) {
    if (rootVariant) redacted = redacted.replaceAll(rootVariant, ".");
  }

  const chunks = redacted.split(
    /(\s+(?:is|was|at|from|to|outside|inside|cannot|could|failed|for|and|or)\s+)/gi,
  );
  return chunks
    .map((chunk) =>
      chunk.replace(
        /(?<![A-Za-z0-9_.-])[A-Za-z]:[\\/](?:[^\\/\r\n'"`)\],;:]+[\\/])*[^\\/\s'"`)\],;:]+|(?<![A-Za-z0-9_.\\-])\\\\(?:[^\\\r\n'"`)\],;:]+\\)+[^\\\s'"`)\],;:]+|(?<![A-Za-z0-9_.:/-])\/\/(?:[^/\r\n'"`)\],;:]+\/)*[^/\s'"`)\],;:]+|(?<![A-Za-z0-9_.:/-])\/(?:[^/\r\n'"`)\],;:]+\/)*[^/\s'"`)\],;:]+/g,
        redact,
      ),
    )
    .join("");
}

export function normalizeStoredPath(value: string): string {
  const normalized = path.posix.normalize(toPosixPath(value));
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

/** Keep user-authored module text useful without persisting host-specific absolute paths. */
export function sanitizeModuleSpecifier(value: string): string {
  return isAbsolutePath(value) || isFileSystemUri(value) || hasEmbeddedAbsolutePath(value)
    ? "<absolute-import>"
    : value;
}
