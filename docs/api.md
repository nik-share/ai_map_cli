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
- `computeManifestIntegrityHash(manifest) -> string`
  - computes the canonical code-point-ordered manifest integrity hash used by persistence and tests
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
