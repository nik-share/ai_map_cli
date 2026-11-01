# Known limitations and backlog

## In-scope alpha

- CLI commands are limited to `init`, `scan`, `check`, `show`.
- `scan` output is static analysis only; no code execution.
- No remote service, account linking, or telemetry is part of the alpha.
- Framework analyzers included by default are TypeScript/Node and React only.

## Next.js and NestJS

- Analyzer classes for Next.js and NestJS are exported and callable through the programmatic API.
- These analyzers are considered **experimental** and are **not enabled by default** in CLI.
- They are intentionally not part of the minimal default analyzer contract.

## Parser extensibility

- TypeScript compiler parser is authoritative in this alpha.
- The parser adapter interface supports custom adapters and fallback wrappers.
- A bounded `@ast-grep/napi` spike and fixture microbenchmark are present, but the adapter is development-only and is not enabled in production scans.
- `TypeScript` compiler semantics are the authoritative source of truth for persisted facts.
- Evidence and confidence still require explicit provenance in output and freshness contracts.
- Freshness tracks indexed raw-byte hashes, the deterministic compiler-observed semantic closure, config/package inputs, producer identity, and tool identities.

## Not yet implemented

- No global search/context query language in CLI.
- No impact/risk scoring commands.
- No source snippet persistence in public artifacts.
- No runtime evidence importer layer.
- No watch/incremental compiler mode. Current default maps are validated and reused, but stale scans rebuild compiler state from scratch.
- No multi-process Program reuse between scans.

## Non-goals for this baseline

- No task-planner reasoning is provided by the map itself.
- No cloud CI/reporting extension is assumed from the local alpha artifacts.

## Milestone risks and limitations

- Package-manager dependency symlinks outside the selected root are not indexed or read by the bounded host.
- The fallback compiler unit mixes unowned files with conservative defaults.
- Every fallback-owned JavaScript/JSX-family file receives a portable reason diagnostic and is still
  analyzed exactly once.
- Direct in-root project-reference package imports are mapped from static package metadata back to referenced source when declaration outputs are absent. Complex conditional exports and references outside the selected root remain bounded and may be unresolved.
- Project/toolchain-scoped typed resolution probes, directory listings, symlink mappings, and consumed TypeScript library hashes make warm validation proportional to the compiler-observed semantic closure rather than only the indexed file count. Warm scans remain much faster than fresh scans, but are slower than Milestone 1's incomplete freshness check.
- Custom extensions are treated as untrusted persistence contributors: their textual symbol facts, names, signatures, documentation, diagnostics, and relation metadata are path-sanitized. Structural file/config paths still must satisfy the public relative-path schemas, and invalid custom records make the scan fail instead of being persisted.
- Portable alias persistence intentionally drops absolute, Windows-drive, UNC, and parent-traversing
  targets before host-native resolution. This stricter policy can omit an otherwise in-root
  parent-relative TypeScript alias; direct relative wildcard targets remain supported.
- Heuristic/unresolved forward relations retain derived `used-by` inverses for graph traversability.
  The unresolved endpoint remains machine-visible in either direction, and these relations are
  excluded from future default compact context unless explicitly requested.
- Schema v4 redundancy detects ordinary and one-sided coherent corruption, including false compiler
  ownership and line counts. It is not a cryptographic signature against rewriting every redundant
  ownership record and integrity hash.
- Default scans use a separate sequential worker for each compiler unit. Each worker exits before
  the next unit starts. A local V8 inspector session collects unreachable compiler objects before
  the result is cloned into the parent; it opens no network port. This releases compiler memory
  before normalization and persistence, but adds collection and
  startup overhead, particularly for small projects with many configs. A single large compiler unit
  can still use substantial memory; there is no fixed heap cap or partial-analysis fallback.
- Custom analyzers, parsers, and semantic resolvers run in-process to preserve extension behavior.
  Their memory use is not covered by the default-pipeline resource guarantee. Full JSDoc remains
  available to custom analyzers; default workers parse only the JSDoc needed for type information.
- The [alpha.2 release benchmark](../benchmarks/results/release-alpha-2-2026-11-01.md) records the
  current resource measurements. August source commits were restored with copied installed
  dependencies; those dependency trees are not claimed to reproduce the August installation.
- Next.js and NestJS analyzers remain experimental and default-off.
- Any future Tree-sitter production path is still explicitly off for this milestone.
