import { normalizeStoredPath } from "./utils/path.js";
import { compareText } from "./utils/stable.js";

export function packageEntryPoints(raw: Record<string, unknown>): string[] {
  const entries = new Set<string>();
  for (const field of ["main", "module", "types", "typings", "bin"]) {
    const value = raw[field];
    if (typeof value === "string") addEntry(value, entries);
    else if (value && typeof value === "object") {
      for (const item of Object.values(value)) {
        if (typeof item === "string") addEntry(item, entries);
      }
    }
  }
  collectExportPaths(raw.exports, entries);
  return [...entries].sort(compareText);
}

function collectExportPaths(value: unknown, output: Set<string>): void {
  if (typeof value === "string" && !value.includes("*")) {
    addEntry(value, output);
  } else if (value && typeof value === "object") {
    for (const nested of Object.values(value)) collectExportPaths(nested, output);
  }
}

function addEntry(value: string, output: Set<string>): void {
  const normalized = normalizeStoredPath(value);
  if (isSafeStoredPath(normalized) && normalized !== ".") output.add(normalized);
}

function isSafeStoredPath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:\//.test(value) &&
    !value.split("/").includes("..")
  );
}
