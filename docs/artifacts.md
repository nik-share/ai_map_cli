# Artifacts and output schema

All persisted artifacts are written as JSON or line-delimited JSON under the selected output directory (default `.ai/code-map`).

## `manifest.json`

Source inventory and analyzer provenance used for freshness:

- `schemaVersion`
- `analyzerVersion`
- `producer`
  - `id`: centrally assigned built-in/custom pipeline identity
  - `kind`: `built-in` or `custom`
  - `fingerprint`: stable capability/component fingerprint used by default-map reuse
- `semanticResolver`
  - `name`
  - `version`
- `syntaxParser`
  - `name`
  - `version`
- `analyzers`: stable list of enabled analyzers and versions
- `configHash`: serialized analysis configuration and project metadata hash
- `sourceFiles`: `[{ path, hash, compilerUnit, lines }]` for all persisted source files; ownership
  and line count redundantly cross-check `files.jsonl`
- `semanticInputs`: deterministic compiler-observed closure
  - consumed file: `{ path, kind: "file", hash }`, where `hash` is SHA-256 of the exact raw bytes
  - typed lookup: `{ path, kind: "resolution-probe", scope, targetKind, exists }`, where `scope` is `project` or `toolchain` and `targetKind` is `file`, `directory`, or `readable-file`
  - child-directory enumeration: `{ path, kind: "directory-listing", scope, hash }`
  - scoped lexical-to-realpath mapping: `{ path, kind: "symlink", scope, target }`; an out-of-scope target is the opaque `<outside-root>` marker
  - TypeScript standard-library input: `{ path, kind: "toolchain-file", hash }`, relative to the active TypeScript library directory
- `artifacts`: SHA-256 of the exact raw bytes of every companion artifact
- `integrityHash`: SHA-256 binding all other manifest fields, including producer identity, semantic inputs, and companion hashes

Freshness inputs now include:

- normalized scanner semantics, config graph structure, ownership resolution, and all `tsconfig`/`jsconfig` / `extends` / `references` inputs
- selected root/workspace manifests (including workspace dependency ranges), lockfiles, and tool/analyzer/parser/TypeScript/schema version identities
- additional in-root sources, declarations, nested package scopes, package metadata, readable/unreadable candidates, child-directory enumerations, symlink targets, and failed/present resolution candidates actually observed by TypeScript
- exact TypeScript library files plus failed/present toolchain probes observed by the active compiler, so same-version patched, restored, or replaced library inputs invalidate reuse

The minimum complete map is `manifest.json` plus `overview.md`, `project.json`, `files.jsonl`, `symbols.jsonl`, `relations.jsonl`, and `diagnostics.json`. An unchanged default scan opens, hashes, parses, schema-validates, and cross-validates the complete set before reuse. Missing, invalid, incompatible, inconsistent, or hash-mismatched companions force full analysis and repair rather than trusting `manifest.json` alone.

The manifest is the commit marker and is written last. Companion hashes and `integrityHash` are tamper-evident for ordinary corruption or partial edits; they are not authenticated signatures against an actor able to rewrite the whole map coherently. Source remains authoritative.

Loading and reuse additionally enforce cross-record invariants: canonical compiler-unit IDs/references,
manifest-to-file compiler ownership and line counts, exact symbol ownership, import-to-relation
agreement, internal import targets, record counts, local endpoints, range/line bounds, relation
evidence origin, and containment/export ownership. Schema v4 is intentionally incompatible with v3;
existing maps must be rescanned.

## `project.json`

Project context:

- `schemaVersion`
- `name`
- `packageManager` (if present)
- `frameworks`: detected and selected frameworks
- `tsconfig` (if found): compatibility projection of the primary configured unit
- `pathAliases`: compatibility projection from the default compatibility compiler unit
- `compilerUnits[]`:
  - `id` (`compiler-unit:configured:<config-path>` or structurally distinct `compiler-unit:generated:<name>`)
  - `kind` (`configured` | `fallback`)
  - `root`
  - `config?` (normalized selected config path)
  - `references` (compiler-unit-level `references` paths)
  - `extends` (compiler-unit-level `extends` values)
  - `pathAliases` (authoritative per-unit aliases)
- exactly one `fallback` compiler unit exists (it may own zero files)
- `entryPoints`, `workspaces`
- `counts`: number of files/symbols/relations/diagnostics

## `files.jsonl`

One JSON object per scanned source file (`FileRecord`):

- `schemaVersion`
- `id` (`file:<path>`)
- `path`
- `language`
- `frameworks`
- `compilerUnit` (required)
- `hash` (content hash)
- `lines`
- `imports` (`[{ source, specifiers, resolved, external, kind, line }]`)
- `exports` (`[{ name, local, source, default, typeOnly }]`)
- `symbolIds` (sorted)
- `env` (identifier names only)
- `operations` (filesystem/http/database/queue usage)
- `syntax` summary (`parser`, `factCount`, `hadErrors`, optional `fallbackFrom`)
- paths are repository-relative POSIX strings; unresolved absolute module specifiers are replaced by an opaque marker instead of being persisted
- alias targets with absolute, drive, UNC, or parent-traversal syntax are omitted before host-native
  path resolution; valid relative wildcard targets remain portable

## `symbols.jsonl`

One JSON object per symbol (`SymbolRecord`):

- `schemaVersion`
- `id` (stable)
- `name`
- `kind` (`function`, `react-component`, `next-page`, `nest-controller`, ...)
- `file`
- `range`
- `exported`
- `defaultExport` (optional)
- `signature` (source-derived)
- `documentation` (optional; not emitted by the base scanner)
- `facts` (framework-aware structured facts)
- `sourceHash`

## `relations.jsonl`

Directed edges between files and symbols:

- `schemaVersion`
- `from`
- `to`
- `type` (e.g. `calls`, `instantiates`, `renders`, `uses-hook`, `handles-route`, `injects`, ...)
- `confidence` (must be between `0` and `1`)
- `origin.file`
- `origin.line`
- `origin.range`
- `origin.explanation`
- `origin.classification` (`exact`, `framework-derived`, `heuristic`, `derived`)
- `origin.analyzer`

Unresolved heuristic edges continue to receive deterministic `used-by` inverses for graph
traversal. Their unresolved external endpoint remains present on the inverse, so audits can identify
the uncertainty from either direction. Future default compact context excludes heuristic/unresolved
edges unless explicitly requested.

## `diagnostics.json`

Validation and analysis issues:

- `schemaVersion`
- `code` (`parse-error`, `unresolved-import`, `invalid-config`, `unsupported-file`,
  `analysis-error`, `parser-fallback`, `compiler-config`)
- `severity` (`info`, `warning`, `error`)
- `message`
- `file`/`line`/`column` (optional)

## `overview.md`

Human-readable summary containing project names, frameworks, counts, entry points, and an indexed file listing.

## Ordering and determinism

Records are sorted deterministically before write:

- files by path
- symbols by ID
- relations by endpoint, type, evidence file, and full evidence range

Mtime stability is preserved by avoiding rewrites when the map is unchanged.
