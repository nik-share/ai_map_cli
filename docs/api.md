# Programmatic API

Import path: `import { ... } from "ai-code-map"`.

## Runtime-safe API

The library API does not call `process.exit`; all failures throw `CodeMapError` or surfaced errors.

## Core functions

- `initProject(options?) -> Promise<InitResult>`
  - writes default config if missing
  - options: `{ root?, config?, output?, force? }`
- `scanProject(options?) -> Promise<ScanResult>`
  - scans and writes artifacts
  - auto-initializes config if absent
  - options: `{ root?, config?, output?, strict?, analyzers?, parser?, semanticResolver? }`
- `checkFreshness(options?) -> Promise<FreshnessResult>`
  - compares persisted manifest with current project state
- `loadCodeMap(options?) -> Promise<CodeMap>`
  - loads persisted map from resolved output directory
- `showSymbol(map, selector) -> ShowResult`
  - selectors: exact ID, `kind:name`, `path#name`, exact name/path

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
- Parser and semantic implementations never enter persisted Code Map records; only their names and versions are fingerprinted.

## Types exported

The package exports major record/contract types including:

- `CodeMap`, `CodeMapConfig`, `ManifestRecord`, `ProjectRecord`
- `FileRecord`, `SymbolRecord`, `RelationRecord`, `DiagnosticRecord`
- `ScanResult`, `FreshnessResult`, `ShowResult`
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
