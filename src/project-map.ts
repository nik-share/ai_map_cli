import type {
  CodeMap,
  RelationEvidenceClassification,
  RelationType,
  SourceRange,
  SymbolKind,
} from "./types.js";
import { compareText } from "./utils/stable.js";

export interface ProjectMapView {
  project: string;
  counts: {
    files: number;
    symbols: number;
    endpoints: number;
    relationGroups: number;
    relationRecords: number;
  };
  files: { ref: string; id: string; path: string }[];
  symbols: {
    ref: string;
    id: string;
    name: string;
    kind: SymbolKind;
    file: string;
    range: SourceRange;
  }[];
  endpoints: { ref: string; id: string }[];
  relations: {
    from: string;
    type: RelationType;
    classification: RelationEvidenceClassification;
    targets: { ref: string; count: number }[];
  }[];
}

/** Complete structural projection; no source text or per-occurrence evidence. */
export function buildProjectMap(map: CodeMap): ProjectMapView {
  const refs = new Map<string, string>();
  const ref = (id: string): string => {
    const value = refs.get(id);
    if (!value) throw new Error(`Unknown map endpoint: ${id}`);
    return value;
  };
  const files = [...map.files]
    .sort((a, b) => compareText(a.path, b.path))
    .map((file, index) => {
      const key = `f${index + 1}`;
      refs.set(file.id, key);
      return { ref: key, id: file.id, path: file.path };
    });
  const symbols = [...map.symbols]
    .sort((a, b) => compareText(a.id, b.id))
    .map((symbol, index) => {
      const key = `s${index + 1}`;
      refs.set(symbol.id, key);
      return {
        ref: key,
        id: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        file: ref(`file:${symbol.file}`),
        range: { ...symbol.range },
      };
    });
  const otherIds = new Set<string>();
  for (const relation of map.relations) {
    if (!refs.has(relation.from)) otherIds.add(relation.from);
    if (!refs.has(relation.to)) otherIds.add(relation.to);
  }
  const endpoints = [...otherIds].sort(compareText).map((id, index) => {
    const key = `e${index + 1}`;
    refs.set(id, key);
    return { ref: key, id };
  });
  const groups = new Map<
    string,
    {
      from: string;
      type: RelationType;
      classification: RelationEvidenceClassification;
      targets: Map<string, number>;
    }
  >();
  for (const relation of map.relations) {
    const from = ref(relation.from);
    const to = ref(relation.to);
    const classification = relation.origin.classification;
    const key = JSON.stringify([from, relation.type, classification]);
    let group = groups.get(key);
    if (!group) {
      group = { from, type: relation.type, classification, targets: new Map() };
      groups.set(key, group);
    }
    group.targets.set(to, (group.targets.get(to) ?? 0) + 1);
  }
  const relations = [...groups.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([, group]) => ({
      ...group,
      targets: [...group.targets.entries()]
        .sort(([a], [b]) => compareText(a, b))
        .map(([ref, count]) => ({ ref, count })),
    }));
  return {
    project: map.project.name,
    counts: {
      files: files.length,
      symbols: symbols.length,
      endpoints: endpoints.length,
      relationGroups: relations.length,
      relationRecords: map.relations.length,
    },
    files,
    symbols,
    endpoints,
    relations,
  };
}

export function formatProjectMap(map: ProjectMapView): string {
  const { counts } = map;
  return [
    `Complete structural map: ${map.project}`,
    `${counts.files} files; ${counts.symbols} symbols; ${counts.endpoints} other endpoints; ${counts.relationRecords} relation records in ${counts.relationGroups} adjacency groups.`,
    "All indexed nodes and relations included. No source, signatures, facts or per-occurrence evidence.",
    "f/s/e refs are local to this output. Read source using a symbol's stable ID, not its short ref.",
    "Relations: FROM TYPE [evidence classification] -> TARGET[*occurrences]. Heuristic/derived links are not exact calls.",
    "",
    "Files (ref path)",
    ...map.files.map((file) => `${file.ref} ${file.path}`),
    "",
    "Symbols (ref file:start-end kind stable-ID)",
    ...map.symbols.map(
      (symbol) =>
        `${symbol.ref} ${symbol.file}:${symbol.range.startLine}-${symbol.range.endLine} ${symbol.kind} ${symbol.id}`,
    ),
    "",
    "Other endpoints (ref ID)",
    ...map.endpoints.map((endpoint) => `${endpoint.ref} ${endpoint.id}`),
    "",
    "Relations",
    ...map.relations.map(
      (group) =>
        `${group.from} ${group.type} [${group.classification}] -> ${group.targets.map((target) => `${target.ref}${target.count > 1 ? `*${target.count}` : ""}`).join(",")}`,
    ),
    "",
    "End of map. If this marker is missing, the calling tool may have truncated the output.",
  ].join("\n");
}
