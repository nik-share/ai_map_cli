import type { CodeMap, ShowResult, SymbolKind, SymbolRecord } from "./types.js";
import { compareText } from "./utils/stable.js";

const KIND_ALIASES: Record<string, SymbolKind> = {
  component: "react-component",
  hook: "react-hook",
  function: "function",
  class: "class",
  method: "method",
  interface: "interface",
  type: "type-alias",
  variable: "variable",
  page: "next-page",
  controller: "nest-controller",
  module: "nest-module",
};

export function showSymbol(map: CodeMap, selector: string): ShowResult {
  const normalized = selector.trim();
  const exactId = map.symbols.filter((symbol) => symbol.id === normalized);
  let symbols = exactId;
  if (symbols.length === 0) {
    const shorthand = /^([a-z-]+):([^/#]+)$/i.exec(normalized);
    if (!shorthand) {
      // no-op
    } else {
      const kindToken = shorthand[1];
      const name = shorthand[2];
      if (kindToken && name) {
        const kind = KIND_ALIASES[kindToken.toLowerCase()];
        if (kind) {
          symbols = map.symbols.filter((symbol) => symbol.kind === kind && symbol.name === name);
        }
      }
    }
  }
  if (symbols.length === 0) {
    const [fileSelector, nameSelector] = splitFileSelector(normalized);
    if (nameSelector) {
      symbols = map.symbols.filter(
        (symbol) => symbol.file === fileSelector && symbol.name === nameSelector,
      );
    } else {
      symbols = map.symbols.filter(
        (symbol) => symbol.name === normalized || symbol.file === normalized,
      );
    }
  }
  if (symbols.length === 0) {
    const lower = normalized.toLowerCase();
    symbols = map.symbols.filter((symbol) => symbol.name.toLowerCase() === lower);
  }

  return {
    selector: normalized,
    matches: symbols
      .sort((a, b) => compareText(a.id, b.id))
      .map((symbol) => {
        const file = map.files.find((item) => item.path === symbol.file);
        if (!file) return undefined;
        return {
          symbol,
          file,
          inbound: map.relations
            .filter((relation) => relation.to === symbol.id)
            .sort(compareRelations),
          outbound: map.relations
            .filter((relation) => relation.from === symbol.id)
            .sort(compareRelations),
        };
      })
      .filter((match): match is NonNullable<typeof match> => match !== undefined),
  };
}

export interface ShowFormatOptions {
  /** Preserve the verbose text view. JSON and showSymbol always retain full records. */
  full?: boolean;
  /** Total relation groups across the compact view; integer 1..50, default 12. */
  limit?: number;
}

export function formatShowResult(result: ShowResult, options: ShowFormatOptions = {}): string {
  const limit = options.limit ?? 12;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError("show limit must be an integer between 1 and 50");
  }
  if (options.full) return formatFullShowResult(result);
  let remaining = limit;
  const matches = result.matches.slice(0, 5);
  const blocks = matches.map(({ symbol, inbound, outbound }) => {
    const { startLine, startColumn, endLine, endColumn } = symbol.range;
    const lines = [
      `${symbol.name} [${symbol.kind}]`,
      `id: ${symbol.id}`,
      `path: ${symbol.file}:${startLine}:${startColumn}-${endLine}:${endColumn}`,
    ];
    if (symbol.signature) {
      const signature = symbol.signature.replace(/\s+/g, " ");
      lines.push(
        `signature: ${signature.length > 240 ? `${signature.slice(0, 240)}… [truncated]` : signature}`,
      );
    }
    const entries = [
      ...outbound.map((relation) => ({ relation, direction: "->", target: relation.to })),
      ...inbound.map((relation) => ({ relation, direction: "<-", target: relation.from })),
    ];
    const eligible = entries.filter(
      ({ relation, target }) =>
        !["heuristic", "derived"].includes(relation.origin.classification) &&
        !["contains", "exports", "used-by"].includes(relation.type) &&
        !target.startsWith("unresolved:"),
    );
    const actionable = new Set(
      eligible
        .filter(({ relation }) => relation.type !== "references")
        .map(({ direction, target }) => `${direction}:${target}`),
    );
    const groups = new Map<
      string,
      { direction: string; target: string; type: string; count: number }
    >();
    let filtered = entries.length - eligible.length;
    for (const { relation, direction, target } of eligible) {
      if (relation.type === "references" && actionable.has(`${direction}:${target}`)) {
        filtered++;
        continue;
      }
      const key = `${direction}:${relation.type}:${target}`;
      const group = groups.get(key);
      if (group) group.count++;
      else groups.set(key, { direction, target, type: relation.type, count: 1 });
    }
    const ranked = [...groups.values()].sort(
      (a, b) =>
        Number(a.target.startsWith("external:")) - Number(b.target.startsWith("external:")) ||
        Number(a.type === "references") - Number(b.type === "references") ||
        compareText(`${a.direction}:${a.type}:${a.target}`, `${b.direction}:${b.type}:${b.target}`),
    );
    const shown = ranked.slice(0, remaining);
    remaining -= shown.length;
    lines.push(
      `relations: ${shown.length}/${ranked.length} groups shown; ${ranked.length - shown.length} omitted; ${filtered} records filtered`,
    );
    lines.push(
      ...shown.map(
        ({ direction, type, target, count }) =>
          `  ${direction} ${type} ${direction} ${target}${count > 1 ? ` (${count} occurrences)` : ""}`,
      ),
    );
    return lines.join("\n");
  });
  if (matches.length < result.matches.length) {
    blocks.push(
      `Symbols: ${matches.length}/${result.matches.length} shown; ${result.matches.length - matches.length} omitted. Use an exact ID to narrow the selector.`,
    );
  }
  if (matches.length)
    blocks.push("Compact view; use --full or --json for all details and evidence.");
  return blocks.join("\n\n");
}

function formatFullShowResult(result: ShowResult): string {
  return result.matches
    .map(({ symbol, inbound, outbound }) => {
      const lines = [
        `${symbol.name} [${symbol.kind}]`,
        `id: ${symbol.id}`,
        `path: ${symbol.file}:${symbol.range.startLine}:${symbol.range.startColumn}`,
        `exported: ${String(symbol.exported)}`,
      ];
      if (symbol.signature) lines.push(`signature: ${symbol.signature}`);
      if (symbol.documentation) lines.push(`documentation: ${symbol.documentation}`);
      if (Object.keys(symbol.facts).length > 0) {
        lines.push("facts:", ...formatFacts(symbol.facts));
      }
      const relations = [
        ...outbound.map(
          (relation) => `  -> ${relation.type} -> ${relation.to} (${relation.confidence})`,
        ),
        ...inbound
          .filter((relation) => relation.type !== "used-by")
          .map((relation) => `  <- ${relation.type} <- ${relation.from} (${relation.confidence})`),
      ];
      if (relations.length > 0) lines.push("relations:", ...relations);
      return lines.join("\n");
    })
    .join("\n\n");
}

function splitFileSelector(selector: string): [string, string | undefined] {
  const hash = selector.lastIndexOf("#");
  return hash > 0 ? [selector.slice(0, hash), selector.slice(hash + 1)] : [selector, undefined];
}

function compareRelations(
  a: ShowResult["matches"][number]["inbound"][number],
  b: ShowResult["matches"][number]["inbound"][number],
): number {
  return compareText(`${a.type}:${a.from}:${a.to}`, `${b.type}:${b.from}:${b.to}`);
}

function formatFacts(facts: SymbolRecord["facts"]): string[] {
  return Object.entries(facts)
    .sort(([a], [b]) => compareText(a, b))
    .map(([key, value]) => `  ${key}: ${formatFactValue(value)}`);
}

function formatFactValue(value: SymbolRecord["facts"][string]): string {
  if (Array.isArray(value)) return value.map((entry) => formatFactValue(entry)).join(", ");
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
}
