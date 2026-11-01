import path from "node:path";
import type { CodeMap, SymbolRecord } from "./types.js";
import { CodeMapError } from "./errors.js";
import { findSymbols, type SymbolSearchMatch } from "./search.js";
import { buildReadNavigation } from "./read-navigation.js";
import { readFileInsideRoot } from "./utils/path.js";
import { hashText } from "./utils/hash.js";
import { compareText } from "./utils/stable.js";

export interface ContextOptions {
  root: string;
  /** Shared source-line budget, 1..2000; default 800. */
  maxLines?: number;
  /** Shared source-character budget including line separators, 256..64000; default 32000. */
  maxChars?: number;
  /** Maximum search matches to expand, 1..5; default 3. */
  seeds?: number;
}
export interface ContextSnippet {
  file: string;
  startLine: number;
  endLine: number;
  source: string;
}
export interface ContextOmission {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
}
export interface ContextResult {
  query: string;
  matches: SymbolSearchMatch[];
  moreMatches: number;
  selected: { id: string; role: "match" | "neighbor" }[];
  snippets: ContextSnippet[];
  omitted: ContextOmission[];
  tests: { file: string; line: number }[];
  omittedNavigation: number;
  usedLines: number;
  usedChars: number;
  limits: { maxLines: number; maxChars: number; seeds: number };
}

const behavior = new Set(["function", "method", "react-hook", "react-component", "class"]);
function budget(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

/** Expand lexical matches by one direct graph hop and coalesce bounded current source. */
export async function buildSourceContext(
  map: CodeMap,
  query: string,
  options: ContextOptions,
): Promise<ContextResult> {
  const maxLines = budget(options.maxLines ?? 800, 1, 2000, "context maxLines");
  const maxChars = budget(options.maxChars ?? 32000, 256, 64000, "context maxChars");
  const seeds = budget(options.seeds ?? 3, 1, 5, "context seeds");
  const files = new Map<string, { lines: string[]; included: Set<number> }>();
  const indexedFiles = new Map(map.files.map((f) => [f.path, f]));
  const sourceFile = async (symbol: SymbolSearchMatch) => {
    let file = files.get(symbol.file);
    if (!file) {
      const indexed = indexedFiles.get(symbol.file);
      if (!indexed) throw new CodeMapError("SOURCE_NOT_FOUND", `No indexed file for ${symbol.id}`);
      const bytes = await readFileInsideRoot(options.root, path.resolve(options.root, symbol.file));
      if (hashText(bytes) !== indexed.hash)
        throw new CodeMapError(
          "STALE_SOURCE",
          `Source ${symbol.file} changed. Run ai-code-map scan.`,
        );
      const lines = bytes.toString("utf8").split(/\r\n|\n|\r/);
      if (lines.at(-1) === "") lines.pop();
      file = { lines, included: new Set() };
      files.set(symbol.file, file);
    }
    validateRange(symbol, file.lines.length);
    return file;
  };
  const found = findSymbols(map, query, { limit: 50 });
  const exact = found.matches.filter((s) => s.id === query.trim() || s.name === query.trim());
  let ranked = exact.length
    ? exact
    : [...found.matches].sort(
        (a, b) =>
          (a.unmatchedTerms?.length ?? 0) - (b.unmatchedTerms?.length ?? 0) ||
          Number(!behavior.has(a.kind)) - Number(!behavior.has(b.kind)),
      );
  // Resolve partial name/path matches using their current bodies. Repeated action
  // words distinguish an implementation from a list of allowed filter values.
  // Only inspect the existing bounded candidate set; this is not a repository scan.
  const missing = ranked[0]?.unmatchedTerms?.length ?? 0;
  if (!exact.length && missing > 0) {
    let best = 0;
    let promoted: SymbolSearchMatch[] = [];
    for (const match of ranked) {
      if (
        !behavior.has(match.kind) ||
        match.kind === "class" ||
        match.unmatchedTerms?.length !== missing
      )
        continue;
      const file = await sourceFile(match);
      const body = file.lines
        .slice(match.range.startLine - 1, match.range.endLine)
        .join("\n")
        .toLowerCase();
      let score = 0;
      for (const term of match.unmatchedTerms) {
        let hits = 0;
        for (
          let at = body.indexOf(term);
          at >= 0 && hits < 3;
          at = body.indexOf(term, at + term.length)
        )
          hits++;
        if (hits) score += 10 + hits;
      }
      if (score > best) {
        best = score;
        promoted = [];
      }
      if (score === best) promoted.push(match);
    }
    if (best > 0) ranked = promoted;
  }
  const matches = ranked.slice(0, seeds);
  const result: ContextResult = {
    query,
    matches,
    moreMatches: found.total - matches.length,
    selected: [],
    snippets: [],
    omitted: [],
    tests: [],
    omittedNavigation: 0,
    usedLines: 0,
    usedChars: 0,
    limits: { maxLines, maxChars, seeds },
  };
  const byId = new Map(map.symbols.map((s) => [s.id, s]));
  const selected = new Map<string, "match" | "neighbor">(matches.map((s) => [s.id, "match"]));
  const tests = new Map<string, { file: string; line: number }>();
  // Expand only the original matches. Following every new neighbor would recreate the whole graph.
  for (const match of matches) {
    const nav = buildReadNavigation(map, match.id);
    result.omittedNavigation += nav.omittedLinks + nav.omittedTests;
    for (const link of nav.links) {
      if (selected.has(link.id)) continue;
      // A reference to the class namespace is not a request for every method body.
      if (link.type === "references" && byId.get(link.id)?.kind === "class") {
        result.omittedNavigation++;
        continue;
      }
      selected.set(link.id, "neighbor");
    }
    for (const site of nav.tests) tests.set(`${site.file}:${site.line}`, site);
  }
  const testSites = [...tests.values()].sort(
    (a, b) => compareText(a.file, b.file) || a.line - b.line,
  );
  result.tests = testSites.slice(0, 8);
  result.omittedNavigation += Math.max(0, testSites.length - result.tests.length);
  result.selected = [...selected].map(([id, role]) => ({ id, role }));
  for (const [id] of selected) {
    const symbol = byId.get(id);
    if (!symbol) throw new CodeMapError("SYMBOL_NOT_FOUND", `Missing context symbol: ${id}`);
    const file = await sourceFile(symbol);
    const first = Math.max(1, symbol.range.startLine - 2);
    const last = Math.min(file.lines.length, symbol.range.endLine + 2);
    for (let line = first; line <= last; line++) {
      if (file.included.has(line)) continue;
      // Count a separator for every line, conservatively also for each snippet's final line.
      const chars = (file.lines[line - 1]?.length ?? 0) + 1;
      if (result.usedLines >= maxLines || result.usedChars + chars > maxChars) break;
      file.included.add(line);
      result.usedLines++;
      result.usedChars += chars;
    }
  }
  // Report unread intervals after all candidates have contributed their potentially shared lines.
  for (const [id] of selected) {
    const symbol = byId.get(id);
    if (!symbol) continue;
    const file = files.get(symbol.file);
    if (!file) continue;
    const last = Math.min(file.lines.length, symbol.range.endLine + 2);
    let missingStart: number | undefined;
    for (let line = Math.max(1, symbol.range.startLine - 2); line <= last + 1; line++) {
      const missing = line <= last && !file.included.has(line);
      if (missing && missingStart === undefined) missingStart = line;
      if (!missing && missingStart !== undefined) {
        result.omitted.push({ id, file: symbol.file, startLine: missingStart, endLine: line - 1 });
        missingStart = undefined;
      }
    }
  }
  for (const [name, file] of files) {
    const lines = [...file.included].sort((a, b) => a - b);
    let start: number | undefined,
      end = 0;
    const append = (): void => {
      if (start === undefined) return;
      result.snippets.push({
        file: name,
        startLine: start,
        endLine: end,
        source: file.lines.slice(start - 1, end).join("\n"),
      });
    };
    for (const line of lines) {
      if (start === undefined || line !== end + 1) {
        append();
        start = line;
      }
      end = line;
    }
    append();
  }
  return result;
}

function validateRange(symbol: Pick<SymbolRecord, "range" | "file">, length: number): void {
  const { startLine, endLine } = symbol.range;
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > length
  )
    throw new CodeMapError(
      "INVALID_SOURCE_RANGE",
      `Mapped range is outside ${symbol.file}. Run ai-code-map scan.`,
    );
}

export function formatSourceContext(result: ContextResult): string {
  if (!result.matches.length)
    return "No indexed matches. Include action and subject words, or use find/targeted rg. No source was read.";
  const lines = [
    `Context: ${result.selected.length} selected symbols, ${result.usedLines}/${result.limits.maxLines} source lines; ${result.usedChars}/${result.limits.maxChars} source characters.`,
    `Matches: ${result.matches.map((m) => `${m.name}${m.unmatchedTerms?.length ? ` (unmatched: ${m.unmatchedTerms.join(", ")})` : ""}`).join(", ")}.`,
    "Scope: matches and direct exact/framework-derived neighbors; reference-only classes are not expanded. Source determines behavior.",
  ];
  for (const snippet of result.snippets) {
    lines.push(`\n${snippet.file}:${snippet.startLine}-${snippet.endLine}`);
    lines.push(...snippet.source.split("\n").map((line, i) => `${snippet.startLine + i}: ${line}`));
  }
  if (result.tests.length)
    lines.push(
      "\nTest call sites (navigation hints, not coverage):",
      ...result.tests.map((s) => `${s.file}:${s.line}`),
    );
  if (result.omitted.length)
    lines.push(
      "\nBudget omitted source; read only a needed missing range:",
      ...result.omitted.slice(0, 12).map((o) => `${o.file}:${o.startLine}-${o.endLine} (${o.id})`),
      ...(result.omitted.length > 12
        ? [`${result.omitted.length - 12} further omitted ranges; use --json for all.`]
        : []),
    );
  lines.push(
    `\nOther search matches: ${result.moreMatches}; navigation entries omitted: ${result.omittedNavigation}. Follow up only for a missing fact; reuse source already returned.`,
  );
  return lines.join("\n");
}
