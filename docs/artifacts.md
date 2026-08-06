# Artifacts and output schema

All persisted artifacts are written as JSON or line-delimited JSON under the selected output directory (default `.ai/code-map`).

## `manifest.json`

Source inventory and analyzer provenance used for freshness:

- `schemaVersion`
- `analyzerVersion`
- `semanticResolver`
  - `name`
  - `version`
- `syntaxParser`
  - `name`
  - `version`
- `analyzers`: stable list of enabled analyzers and versions
- `configHash`: serialized analysis configuration and project metadata hash
- `sourceFiles`: `[{ path, hash }]` for all scanned files

## `project.json`

Project context:

- `schemaVersion`
- `name`
- `packageManager` (if present)
- `frameworks`: detected and selected frameworks
- `tsconfig` (if found)
- `pathAliases`
- `entryPoints`, `workspaces`
- `counts`: number of files/symbols/relations/diagnostics

## `files.jsonl`

One JSON object per scanned source file (`FileRecord`):

- `schemaVersion`
- `id` (`file:<path>`)
- `path`
- `language`
- `frameworks`
- `hash` (content hash)
- `lines`
- `imports` (`[{ source, specifiers, resolved, external, kind, line }]`)
- `exports` (`[{ name, local, source, default, typeOnly }]`)
- `symbolIds` (sorted)
- `env` (identifier names only)
- `operations` (filesystem/http/database/queue usage)
- `syntax` summary (`parser`, `factCount`, `hadErrors`, optional `fallbackFrom`)

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

## `diagnostics.json`

Validation and analysis issues:

- `schemaVersion`
- `code` (`parse-error`, `unresolved-import`, `invalid-config`, `unsupported-file`, `analysis-error`, `parser-fallback`)
- `severity` (`info`, `warning`, `error`)
- `message`
- `file`/`line`/`column` (optional)

## `overview.md`

Human-readable summary containing project names, frameworks, counts, entry points, and an indexed file listing.

## Ordering and determinism

Records are sorted deterministically before write:

- files by path
- symbols by ID
- relations by `(from,type,to,origin.file)` key order

Mtime stability is preserved by avoiding rewrites when the map is unchanged.
