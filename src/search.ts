import type { CodeMap, SourceRange, SymbolKind, SymbolRecord } from "./types.js";

import { compareText } from "./utils/stable.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export interface SymbolSearchOptions {
  limit?: number;
}

export interface SymbolSearchMatch {
  id: string;
  name: string;
  kind: SymbolKind;
  file: string;
  range: SourceRange;
}

export interface SymbolSearchResult {
  query: string;
  total: number;
  truncated: boolean;
  matches: SymbolSearchMatch[];
}

export function findSymbols(
  map: CodeMap,
  query: string,
  options: SymbolSearchOptions = {},
): SymbolSearchResult {
  const normalized = query.trim();
  if (!normalized) throw new Error("Symbol search query must not be empty.");

  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RangeError(`Symbol search limit must be an integer from 1 to ${MAX_LIMIT}.`);
  }

  const qualified = splitQualifiedSelector(normalized);
  const ranked = map.symbols
    .map((symbol) => ({ symbol, rank: matchRank(symbol, normalized, qualified) }))
    .filter(
      (candidate): candidate is { symbol: SymbolRecord; rank: number } =>
        candidate.rank !== undefined,
    )
    .sort((left, right) => left.rank - right.rank || compareText(left.symbol.id, right.symbol.id));

  const matches = ranked.slice(0, limit).map(({ symbol }) => toMatch(symbol));
  return {
    query: normalized,
    total: ranked.length,
    truncated: ranked.length > matches.length,
    matches,
  };
}

function matchRank(
  symbol: SymbolRecord,
  query: string,
  qualified: { file: string; member: string } | undefined,
): number | undefined {
  if (symbol.id === query) return 0;
  if (symbol.name === query) return 1;

  const lowerQuery = query.toLowerCase();
  if (qualified) {
    if (symbol.file !== qualified.file) return undefined;
    const terminalName = qualified.member.split(".").at(-1) ?? qualified.member;
    if (symbol.name === qualified.member || symbol.name === terminalName) return 2;
    if (
      symbol.name.toLowerCase() === qualified.member.toLowerCase() ||
      symbol.name.toLowerCase() === terminalName.toLowerCase()
    ) {
      return 3;
    }
    return undefined;
  }

  const lowerName = symbol.name.toLowerCase();
  const lowerFile = symbol.file.toLowerCase();
  if (lowerName === lowerQuery) return 3;
  if (lowerName.startsWith(lowerQuery)) return 4;
  if (lowerName.includes(lowerQuery)) return 5;
  if (lowerFile.includes(lowerQuery)) return 6;

  const queryWords = words(query);
  const symbolWords = new Set(words(`${symbol.name} ${symbol.file}`));
  if (queryWords.length > 0 && queryWords.every((word) => symbolWords.has(word))) return 7;

  if (/^[a-z0-9]+$/i.test(query)) {
    const compactQuery = compact(query);
    const compactName = compact(symbol.name);
    if (
      compactQuery.length >= 4 &&
      compactQuery.length <= 128 &&
      compactName.length >= 4 &&
      compactName.length <= 128 &&
      editDistance(compactQuery, compactName) <= (compactQuery.length >= 8 ? 2 : 1)
    ) {
      return 8;
    }
  }
  return undefined;
}

function splitQualifiedSelector(value: string): { file: string; member: string } | undefined {
  const index = value.indexOf("#");
  if (index <= 0 || index === value.length - 1) return undefined;
  return { file: value.slice(0, index), member: value.slice(index + 1) };
}

function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function compact(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function editDistance(left: string, right: string): number {
  if (Math.abs(left.length - right.length) > 2) return 3;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex] ?? 0;
      previous[rightIndex] = Math.min(
        (previous[rightIndex - 1] ?? 0) + 1,
        above + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length] ?? 0;
}

function toMatch(symbol: SymbolRecord): SymbolSearchMatch {
  return {
    id: symbol.id,
    name: symbol.name,
    kind: symbol.kind,
    file: symbol.file,
    range: symbol.range,
  };
}
