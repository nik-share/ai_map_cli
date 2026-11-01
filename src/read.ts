import path from "node:path";
import { CodeMapError } from "./errors.js";
import type { CodeMap, SourceRange } from "./types.js";
import { hashText } from "./utils/hash.js";
import { readFileInsideRoot } from "./utils/path.js";
import { buildReadNavigation, type ReadNavigation } from "./read-navigation.js";

export interface ReadSourceOptions {
  root: string;
  /** Maximum source lines per page; integer 1..200, default 80. */
  limit?: number;
  /** Zero-based offset within the symbol's window, including two context lines. */
  offset?: number;
}
export interface ReadSourceResult {
  id: string;
  file: string;
  symbolRange: SourceRange;
  startLine: number;
  endLine: number;
  source: string;
  truncated: boolean;
  nextOffset?: number;
  /** Bounded direct links and test call sites, present only at offset zero. */
  navigation?: ReadNavigation;
}

/** Read current source using an exact map ID, never a fuzzy selector. */
export async function readSymbolSource(
  map: CodeMap,
  id: string,
  options: ReadSourceOptions,
): Promise<ReadSourceResult> {
  const limit = options.limit ?? 80;
  const offset = options.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new RangeError("read limit must be an integer between 1 and 200");
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new RangeError("read offset must be a nonnegative safe integer");
  const symbol = map.symbols.find((item) => item.id === id);
  if (!symbol)
    throw new CodeMapError(
      "SYMBOL_NOT_FOUND",
      "Use an exact symbol ID returned by ai-code-map find.",
    );
  const file = map.files.find((item) => item.path === symbol.file);
  const absolute = path.resolve(options.root, symbol.file);
  if (!file)
    throw new CodeMapError("SOURCE_NOT_FOUND", "Symbol has no indexed file. Run ai-code-map scan.");
  const bytes = await readFileInsideRoot(options.root, absolute);
  if (hashText(bytes) !== file.hash)
    throw new CodeMapError(
      "STALE_SOURCE",
      `Source ${symbol.file} changed. Run ai-code-map scan before reading its mapped range.`,
    );
  const lines = bytes.toString("utf8").split(/\r\n|\n|\r/);
  // Preserve the EOF line used by TypeScript ranges and persisted file line counts.
  const first = Math.max(1, symbol.range.startLine - 2);
  const last = Math.min(lines.length, symbol.range.endLine + 2);
  if (symbol.range.startLine < 1 || symbol.range.endLine > lines.length || first > last)
    throw new CodeMapError(
      "INVALID_SOURCE_RANGE",
      "Mapped range is outside the source. Run ai-code-map scan.",
    );
  if (offset >= last - first + 1) throw new RangeError("read offset is outside the symbol window");
  const startLine = first + offset;
  const endLine = Math.min(last, startLine + limit - 1);
  const source = lines.slice(startLine - 1, endLine).join("\n");
  if (source.length > 12000)
    throw new CodeMapError(
      "SOURCE_WINDOW_TOO_LARGE",
      "Source window exceeds 12000 characters. Reduce --limit; for a single oversized line use targeted source search.",
    );
  const truncated = endLine < last;
  return {
    id: symbol.id,
    file: symbol.file,
    symbolRange: symbol.range,
    startLine,
    endLine,
    source,
    truncated,
    ...(truncated ? { nextOffset: offset + endLine - startLine + 1 } : {}),
    ...(offset === 0 ? { navigation: buildReadNavigation(map, id) } : {}),
  };
}
