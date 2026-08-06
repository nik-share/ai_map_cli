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

export function formatShowResult(result: ShowResult): string {
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
