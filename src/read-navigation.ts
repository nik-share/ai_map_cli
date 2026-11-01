import type { CodeMap, RelationType } from "./types.js";
import { compareText } from "./utils/stable.js";

export interface ReadNavigationLink {
  direction: "outgoing" | "incoming";
  type: RelationType;
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  classification: "exact" | "framework-derived";
}

export interface ReadNavigation {
  links: ReadNavigationLink[];
  /** Exact incoming call sites in paths named *.test.*, *.spec.* or __tests__/. */
  tests: { file: string; line: number }[];
  /** Unique eligible neighbors/sites excluded by the row or character limits. */
  omittedLinks: number;
  omittedTests: number;
}

/** First-page navigation only; the source remains the authority on behavior. */
export function buildReadNavigation(map: CodeMap, id: string): ReadNavigation {
  const symbols = new Map(map.symbols.map((symbol) => [symbol.id, symbol]));
  const candidates: ReadNavigationLink[] = [];
  const tests = new Map<string, ReadNavigation["tests"][number]>();
  for (const relation of map.relations) {
    if (relation.from !== id && relation.to !== id) continue;
    const classification = relation.origin.classification;
    if (classification !== "exact" && classification !== "framework-derived") continue;
    if (["contains", "exports", "used-by"].includes(relation.type)) continue;
    const outgoing = relation.from === id;
    const target = outgoing ? relation.to : relation.from;
    if (target === id) continue;
    if (
      !outgoing &&
      relation.type === "calls" &&
      classification === "exact" &&
      /(?:^|\/)__tests__\/|\.(?:test|spec)\.[^/]+$/.test(relation.origin.file)
    ) {
      const site = { file: relation.origin.file, line: relation.origin.line };
      tests.set(`${site.file}:${site.line}`, site);
      continue;
    }
    const symbol = symbols.get(target);
    if (!symbol) continue;
    candidates.push({
      direction: outgoing ? "outgoing" : "incoming",
      type: relation.type,
      id: symbol.id,
      file: symbol.file,
      startLine: symbol.range.startLine,
      endLine: symbol.range.endLine,
      classification,
    });
  }
  candidates.sort(
    (a, b) =>
      Number(a.type === "references") - Number(b.type === "references") ||
      Number(a.direction === "incoming") - Number(b.direction === "incoming") ||
      Number(a.classification !== "exact") - Number(b.classification !== "exact") ||
      compareText(`${a.type}:${a.id}`, `${b.type}:${b.id}`),
  );
  // One reusable ID per direction, even when calls, references and uses-hook overlap.
  const links = new Map<string, ReadNavigationLink>();
  for (const link of candidates) {
    const key = `${link.direction}:${link.id}`;
    if (!links.has(key)) links.set(key, link);
  }
  const result: ReadNavigation = { links: [], tests: [], omittedLinks: 0, omittedTests: 0 };
  // Reserve room for keys, counters and punctuation within 4,000 compact JSON characters.
  let remaining = 3600;
  // Give test sites a small reserved opportunity before filling the symbol rows.
  for (const site of [...tests.values()].sort(
    (a, b) => compareText(a.file, b.file) || a.line - b.line,
  )) {
    const size = JSON.stringify(site).length;
    if (result.tests.length < 4 && size <= Math.min(remaining, 900)) {
      result.tests.push(site);
      remaining -= size;
    } else result.omittedTests++;
  }
  for (const link of links.values()) {
    const size = JSON.stringify(link).length;
    if (result.links.length < 8 && size <= remaining) {
      result.links.push(link);
      remaining -= size;
    } else result.omittedLinks++;
  }
  return result;
}

export function formatReadNavigation(navigation: ReadNavigation): string[] {
  return [
    `Map links: ${navigation.links.length} shown; ${navigation.omittedLinks} omitted. Read an ID only if needed.`,
    ...navigation.links.map(
      (link) =>
        `  ${link.direction === "outgoing" ? "->" : "<-"} ${link.type} ${link.id} [lines ${link.startLine}-${link.endLine}; ${link.classification}]`,
    ),
    `Test call sites: ${navigation.tests.length} shown; ${navigation.omittedTests} omitted (path-based; not a coverage claim).`,
    ...navigation.tests.map((site) => `  ${site.file}:${site.line}`),
  ];
}
