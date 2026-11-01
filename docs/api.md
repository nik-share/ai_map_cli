# Programmatic API

Import path: `import { ... } from "ai-code-map"`.

## Runtime-safe API

The library API does not call `process.exit`; all failures throw `CodeMapError` or surfaced errors.

Persisted artifacts are written in schema `v4`. Older maps return an actionable rescan error.
Schema v4 adds redundant source ownership and line-count fields so direct loads can reject
one-sided coherent corruption; a rescan is required.

## Core functions

- `initProject(options?) -> Promise<InitResult>`
  - writes default config if missing
  - options: `{ root?, config?, output?, force? }`
- `scanProject(options?) -> Promise<ScanResult>`
  - scans and writes artifacts
  - auto-initializes config if absent
  - options: `{ root?, config?, output?, strict?, analyzers?, parser?, semanticResolver? }`
  - discovers config candidates (`tsconfig*.json`, `jsconfig.json`) and resolves transitive `extends` and project `references`
  - computes exact ownership per normalized compiler unit and builds one deterministic TypeScript `Program` per unit
  - processes compiler units sequentially in stable compiler-unit order, then merges normalized owned facts globally
  - only owned files are persisted
  - reuses a complete validated current map for the default pipeline; stale inputs, invalid companion artifacts, or custom parser/analyzer/resolver components run full analysis
- `checkFreshness(options?) -> Promise<FreshnessResult>`
  - validates the complete persisted artifact set and its raw-byte integrity index
  - compares indexed sources, compiler-consumed files, project/toolchain-scoped typed resolution probes, observed directory listings and symlinks, consumed TypeScript libraries, configuration, and producer compatibility with current project state
- `loadCodeMap(options?) -> Promise<CodeMap>`
  - loads persisted map from resolved output directory
- `buildProjectMap(map) -> ProjectMapView`
  - projects a validated `CodeMap` into all indexed files, symbols, other endpoints, and grouped relations; does not mutate the input or check freshness
  - returns `{ project, counts, files, symbols, endpoints, relations }`; nodes carry output-local `ref` values and original stable IDs
  - symbol `file` points to a file ref; symbol `range` retains source coordinates
  - relation groups contain `{ from, type, classification, targets: [{ ref, count }] }`; counts preserve all occurrence records, including heuristic and derived relations
  - excludes source text, signatures, facts, and individual origin/confidence records; use the original map for that evidence
- `formatProjectMap(view) -> string`
  - deterministic complete text with short references, stable symbol IDs, source lines, evidence classifications, and occurrence counts; no pagination or row limit
  - the CLI `map` command checks freshness and reuses the validated map before calling these functions; missing/stale/invalid artifacts return exit code 2
- `computeManifestIntegrityHash(manifest) -> string`
  - computes the canonical code-point-ordered manifest integrity hash used by persistence and tests
- `buildSourceContext(map, query, { root, maxLines?, maxChars?, seeds? }) -> Promise<ContextResult>`
  - selects lexical matches (exact IDs/names take precedence), then expands one direct graph hop using the bounded `read` navigation rules
  - for partial queries, ranks callable candidates using missing query words in their current source bodies and expands the strongest ties; inspects at most the 50 lexical candidates, with per-term occurrence counts capped at three
  - skips reference-only class neighbors and counts them as omitted navigation; an explicitly selected class still expands normally
  - includes up to four exact/framework-derived incoming file-level calls/references outside test files; a file of at most 80 lines is included in full, otherwise the mapped site has eight context lines on either side, within the shared budgets
  - defaults: 3 matches (1..5), 800 source lines (1..2000), 32,000 source characters including separators (256..64000)
  - verifies paths, hashes and ranges for source-ranking candidates, selected symbols and file references; coalesces overlapping/adjacent source intervals
  - returns `{ query, matches, moreMatches, selected, snippets, omitted, fileReferences, tests, omittedNavigation, usedLines, usedChars, limits }`
  - `snippets` contain `{ file, startLine, endLine, source }`; `omitted` lists unread source ranges and symbol/file IDs excluded by the shared budget; file IDs are navigation targets, so read their printed source ranges directly
  - test call sites are bounded navigation hints; omitted-navigation counts sum entries excluded by each seed's navigation limits and the shared test-site limit
  - the API validates selected source files; the CLI `context` also checks full map freshness before calling it
- `formatSourceContext(result) -> string`
  - renders numbered source windows once per contiguous range, with bounded selection/test/omission metadata; metadata is additional to the source budgets
- `readSymbolSource(map, id, { root, limit?, offset? }) -> Promise<ReadSourceResult>`
  - requires an exact stable ID; reads current source with two context lines per side
  - `root` is the project root; `limit` defaults to 80 (integer 1..200); `offset` defaults to zero within that window
  - returns `{ id, file, symbolRange, startLine, endLine, source, truncated, nextOffset?, navigation? }`
  - at offset zero, `navigation` contains `{ links, tests, omittedLinks, omittedTests }`; continuation pages omit it
  - each link has `{ direction, type, id, file, startLine, endLine, classification }`; exact and framework-derived internal neighbors only, deduplicated by direction and ID
  - `tests` contains exact incoming call sites `{ file, line }` in `*.test.*`, `*.spec.*`, or `__tests__/` paths; this is a navigation hint, not a coverage claim
  - limits navigation to eight links, four test sites, and fewer than 4,000 compact JSON characters; omission counts refer to eligible unique neighbors/sites excluded by these limits
  - verifies source path containment and indexed file hash; rejects symbolic files, stale source, invalid offsets, and pages over 12,000 characters
  - does not validate all project dependencies; use `checkFreshness` before navigation
- `showSymbol(map, selector) -> ShowResult`
  - selectors: exact ID, `kind:name`, `path#name`, exact name/path
  - returns all matching symbols and full relation records; no display filtering
- `formatShowResult(result, options?) -> string`
  - compact by default: up to five symbols and 12 relation groups in total, with omission counts
  - options: `{ full?: boolean, limit?: number }`; `limit` is an integer 1..50
  - `{ full: true }` preserves the previous verbose text view
- `findSymbols(map, query, options?) -> SymbolSearchResult`
  - searches indexed names and paths; returns stable IDs and source ranges
  - options: `{ limit?: number }`, default 10, integer 1..50; invalid limits throw `RangeError`
  - empty/whitespace query throws; no matches returns an empty array
  - returns `{ query, total, truncated, matches: [{ id, name, kind, file, range, unmatchedTerms? }] }`
  - deterministic lexical ranking and bounded typo hints; does not resolve guessed names as exact symbols
  - word matching normalizes common English plurals and favors name matches over path matches
  - whitespace-separated queries with at least three distinct normalized words may return partial matches after full matches and typo hints; at least two words and half the query must match, including a word in the symbol name
  - only partial matches include `unmatchedTerms`, listing normalized query words absent from that symbol's name and path; this is lexical overlap, not semantic equivalence
  - qualified file selectors remain restricted to that file; partial matching does not broaden them

## Analyzer constructors

- `createAnalyzer({ analyzers?, parser?, semanticResolver? })`
  - returns `{ analyzers, parser, scan(...) }`
- `scanProject` uses analyzer defaults: `CoreAnalyzer`, `ReactAnalyzer`
- Optional analyzers are available:
  - `NextJsAnalyzer`
  - `NestJsAnalyzer`

## Parser adapters

- `TypeScriptParserAdapter` and `FallbackParserAdapter`
- Custom parser adapters implement `SyntaxParserAdapter` and can be passed into `scanProject`/`createAnalyzer`.

## Semantic resolver

- `TypeScriptSemanticResolver` is the compiler-backed default.
- TypeScript `Program`/`TypeChecker` facts remain authoritative even when a syntax adapter is supplied.
- Parser and semantic implementations never enter persisted Code Map records. Display names/versions are recorded, while a separate producer record and capability fingerprint determine default-pipeline reuse eligibility. Explicit built-in parser equivalence requires a directly registered, unmodified adapter instance; proxies, subclasses, and method overrides remain custom.
- Public `SemanticResolver` contracts are additive:
  - `SemanticResolveInput` has optional `compilerUnit`
  - `SemanticResolution` may return an optional unit-anchored `resolveModule` helper
  - `SemanticResolution` may return an optional `semanticInputs()` closure containing raw-byte file/toolchain hashes plus typed resolution probes, directory listings, and symlink mappings scoped to `project` or `toolchain`; omitted observation scope defaults to `project` for extension compatibility
- Coordinator may invoke resolver once per owning compiler unit; custom analyzers receive unit-scoped `Program` and `TypeChecker`.
- Rooted host/type/module resolution is used to avoid caller working-directory effects.
- Text contributed by custom parsers, resolvers, and analyzers is sanitized before persistence; unsafe structural paths supplied by an extension fail schema validation rather than escaping the selected-root boundary. Supplied analyzer trust is resolved through registered instance identity at each invocation, so proxies and overridden instances receive isolated persistence context.

## Types exported

The package exports major record/contract types including:

- `CodeMap`, `CodeMapConfig`, `ManifestRecord`, `ProjectRecord`
- `FileRecord`, `SymbolRecord`, `RelationRecord`, `DiagnosticRecord`
- `CompilerUnitRecord`, `ProducerRecord`, `SemanticInputRecord`, `ArtifactIntegrityRecord`
- `ScanResult`, `FreshnessResult`, `ShowResult`, `ShowFormatOptions`
- `SymbolSearchResult`, `SymbolSearchOptions`, `SymbolSearchMatch`
- `ScanOptions`, `LoadCodeMapOptions`, `AnalysisContext`

## Example

```ts
import {
  initProject,
  scanProject,
  checkFreshness,
  loadCodeMap,
  showSymbol,
  NextJsAnalyzer,
  createAnalyzer,
  TypeScriptParserAdapter,
} from "ai-code-map";

await initProject({ root: process.cwd() });
const scan = await scanProject({ root: process.cwd(), strict: false });
console.log(scan.counts);

const fresh = await checkFreshness({ root: process.cwd() });
console.log(fresh.current, fresh.reasons);

const map = await loadCodeMap({ root: process.cwd() });
console.log(showSymbol(map, "component:UserList").matches[0]?.symbol.kind);

const analyzer = createAnalyzer({
  analyzers: [new NextJsAnalyzer()],
  parser: new TypeScriptParserAdapter(),
});
await analyzer.scan({ root: process.cwd() });
```
