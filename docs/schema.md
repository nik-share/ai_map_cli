# Data schema quick reference

This document summarizes public record shapes in plain terms.

Canonical persisted records use schema version `4`. Schema v4 requires a rescan because manifest
source entries now redundantly bind compiler ownership and line counts.

## Config schema (`config.schema.json`)

`init` writes a complete configuration with these fields. The runtime schema also supplies defaults when fields are omitted:

- `version: 1`
- `root: string`
- `include: string[]`
- `exclude: string[]`
- `frameworks: Array<"auto"|"typescript"|"node"|"react"|"nextjs"|"nestjs">`. `auto` selects Next.js when package dependencies include `next`. An explicit list containing `nextjs` enables it without detection; a list without `nextjs` disables it. NestJS still requires a programmatic analyzer.
- `output: string`
- `includePrivateSymbols: boolean`

Optional:

- `tsconfig: string`
- `concurrency: number` (1..64)

Defaults are provided by `initProject`/`createDefaultConfig`.

## FileRecord shape

```text
id, path, language, frameworks, compilerUnit, hash, lines
imports: [{ source, specifiers, resolved, external, kind, line }]
exports: [{ name, local, source, default, typeOnly }]
symbolIds: string[]
env: string[]
operations: [{ kind, api, line }]
syntax: { parser, factCount, hadErrors, fallbackFrom? }
```

## CompilerUnitRecord shape

```text
id, kind, root, config?
references, extends, pathAliases
```

`kind` is `configured` or `fallback`.

Exactly one `fallback` compiler unit must exist (it may own zero files).
Configured and generated IDs occupy different namespaces, so a real config named `fallback` cannot collide with the generated fallback unit.

## ProjectRecord shape

`ProjectRecord.compilerUnits[]` holds the full ownership config graph.
`ProjectRecord.tsconfig` and `ProjectRecord.pathAliases` remain compatibility projections.

## SymbolRecord shape

```text
id, name, kind, file, range, exported, defaultExport?
signature?, documentation?, facts, sourceHash
```

## RelationRecord shape

```text
from, type, to, confidence
origin{ file, line, range, explanation, classification, analyzer }
```

`confidence` is expected to stay in `[0, 1]`.

`origin` also contains a full `range`, required `explanation`, producing `analyzer`, and `classification` (`exact`, `framework-derived`, `heuristic`, or `derived`).

`from`/`to`/`type` are normalised before write and then merged globally across compiler units.
Semantic relation identity additionally includes the origin file and full start/end range. Two calls on one line remain distinct, while competing analyzer contributions for the same semantic evidence range collapse deterministically.

## ManifestRecord shape

```text
schemaVersion, analyzerVersion, producer
semanticResolver, syntaxParser, analyzers
configHash, sourceFiles, semanticInputs, artifacts, integrityHash
```

`sourceFiles` entries are `{ path, hash, compilerUnit, lines }`. `loadCodeMap` cross-checks all four
fields against `files.jsonl`; this catches one-sided coherent ownership or line-count rewrites. The
integrity model remains tamper-evident rather than authenticated: an actor rewriting every redundant
record and hash can still construct a different self-consistent map.

`semanticInputs` is a discriminated union:

```text
{ path, kind: "file", hash }
{ path, kind: "resolution-probe", scope, targetKind, exists }
{ path, kind: "directory-listing", scope, hash }
{ path, kind: "symlink", scope, target }
{ path, kind: "toolchain-file", hash }
```

File and toolchain hashes always cover raw bytes. Resolution probes distinguish file, directory, and readable-file observations; `scope` is `project` or `toolchain`, so an absent TypeScript-library candidate cannot collide with a project path or disappear from freshness. Directory listings cover only compiler-observed child-directory names, and symlink records store an in-scope logical target or the opaque `<outside-root>` boundary marker. `artifacts` exactly covers every non-manifest companion using raw-byte SHA-256; `integrityHash` binds the remaining manifest fields, including producer identity and the semantic closure.

## Freshness contract

Freshness eligibility combines these manifest fields:

- `configHash`: normalized scanner semantics, compiler-unit ownership, all config/`extends`/`references` inputs, and selected root/workspace manifests, dependency ranges, and lockfiles
- `semanticInputs`: compiler-observed in-root files; project/toolchain-scoped resolution probes, directory listings, and symlink mappings; and versioned TypeScript library bytes outside the persisted source inventory
- `producer`, component records, and version fields: built-in capability plus analyzer/parser/resolver/TypeScript/schema identity
- `artifacts` and `integrityHash`: every companion artifact's exact raw-byte hash plus integrity binding for manifest metadata

Paths in persisted facts and manifests are normalized as selected-root-relative. Stored paths reject
embedded drive/foreign-absolute forms as well as absolute and parent-traversing paths.
Runtime validation also cross-checks canonical compiler-unit identities and references, redundant
manifest/file ownership and line counts, file/symbol ownership, import records and import relations,
counts, endpoint existence, source hashes, ranges/lines, relation evidence, and containment/export
origin ownership.

Zod schemas in `src/schemas.ts` are the runtime/type source of truth. Checked-in Draft 2020-12 schemas under `schemas/` and `config.schema.json` are generated with `pnpm schema:generate` and verified with `pnpm schema:check`.

## DiagnosticRecord shape

```text
code, severity, message, file?, line?, column?
```

## CLI output reference

- `init` JSON: `{ root, configPath, created }`
- `scan` JSON: `{ root, outputDir, wrote, changes, elapsedMs, counts, criticalParseErrors }`
- `check` JSON: `{ status, current, root, outputDir, reasons, changes }`
- `show` JSON: `{ selector, matches }`

`show.matches[n] = { symbol, file, inbound, outbound }`.
