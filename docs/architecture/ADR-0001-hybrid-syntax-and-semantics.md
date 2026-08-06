# ADR-0001: Hybrid syntax candidates and TypeScript semantics

- Status: accepted for alpha
- Date: 2026-08-06
- Decision owners: project maintainers

## Context

The scanner needs error-tolerant syntax discovery without weakening facts that only the TypeScript compiler can prove. Parsing every TypeScript file twice in every one-shot scan would add installation, memory, and maintenance cost before it has demonstrated a repository-level benefit.

The public Code Map IR must not expose Tree-sitter nodes, ast-grep objects, TypeScript AST objects, or library-specific IDs.

## Decision

The target pipeline is:

```text
source files
  -> replaceable syntax-candidate adapter
  -> normalized syntax facts
  -> TypeScript Program / TypeChecker semantic confirmation
  -> versioned framework analyzers
  -> versioned Code Map IR
```

For the alpha production path, the TypeScript `Program` supplies both its reusable syntax tree and authoritative semantic layer. This avoids a second parse. A custom `SyntaxParserAdapter` is opt-in; failure or a fatal parse result falls back to the compiler without aborting the scan. Adapter error text is not persisted because third-party errors may contain source text, absolute paths, or environment-derived values.

`@ast-grep/napi@0.45.0` is the selected bounded Tree-sitter prototype. It is pinned as a development dependency, exercised only by the parser microbenchmark, and is not in the published runtime dependency set. It provides built-in TypeScript and TSX languages and substantially less visitor/rule boilerplate than a raw Tree-sitter binding.

Tree-sitter is therefore **deferred as a default production pass**. The public adapter and normalized IR are in place; the compiler-only path remains the safe fallback and default.

## Fact ownership

| Layer                                    | Responsibility                                                                                                                                          | Authority label                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Syntax adapter / future Tree-sitter pass | Error-tolerant candidates for calls, hooks, JSX, decorators, and file conventions                                                                       | candidate only; never semantic proof                         |
| TypeScript `Program` / `TypeChecker`     | Symbol identity, definitions, aliases, re-exports, module resolution, types, public signatures, overloads, references, calls, and JSX symbol resolution | exact when resolved                                          |
| React rule pack                          | Components, props, hooks, state/effects/dependencies, and rendered JSX derived from compiler nodes and imports                                          | `framework-derived`, or `heuristic` when not fully confirmed |
| Next.js / NestJS rule packs              | Convention and decorator facts after semantic confirmation                                                                                              | experimental and default-off in alpha                        |
| Relation normalizer                      | Inverse edges and canonical endpoint replacement                                                                                                        | `derived`                                                    |

Persisted relations carry `confidence` plus an `origin` containing repository-relative file, line, explanation, evidence classification, and analyzer version identity. The canonical format remains independent of parser implementation.

## Prototype comparison

### `@ast-grep/napi` (selected prototype)

- Version: exactly `0.45.0`.
- Grammars: built-in `Lang.TypeScript` and `Lang.Tsx`.
- Distribution: N-API native optional packages for macOS x64/arm64, Windows x64/arm64/ia32, and Linux x64/arm64 glibc plus x64/arm64 musl.
- Local darwin-arm64 install observation: approximately 392 KiB for the JavaScript/type package and 6.8 MiB for the platform binary package on disk.
- Benefit: concise query/traversal API and prebuilt binaries, without a local `node-gyp` build in the tested install.
- Risk: native optional-package coverage and corporate/supply-chain policies still require CI verification on every supported OS/architecture.

### Raw native `tree-sitter`

Evaluated versions were `tree-sitter@0.25.1` and `tree-sitter-typescript@0.23.2`. The grammar declares a peer range around the older `tree-sitter` line, while the native binding has install/build-tooling costs. This combination was not added to the alpha because it increases packaging risk without reducing the amount of rule code.

### `web-tree-sitter`

`web-tree-sitter@0.26.11` with vendored TypeScript/TSX WASM grammars avoids platform-native binaries and remains the portability fallback. It was not selected for the first prototype because the package must explicitly locate and ship loader/grammar WASM assets, initialize them, and keep ABI compatibility tested.

References:

- [ast-grep JavaScript API](https://ast-grep.github.io/guide/api-usage/js-api.html)
- [ast-grep performance guidance](https://ast-grep.github.io/guide/api-usage/performance-tip.html)
- [Tree-sitter web binding](https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/README.md)
- [Node Tree-sitter binding](https://github.com/tree-sitter/node-tree-sitter)
- [TypeScript grammar](https://github.com/tree-sitter/tree-sitter-typescript)

## Bounded microbenchmark

Command:

```bash
pnpm benchmark
```

Environment for the checkpoint below: Node `v22.16.0`, darwin-arm64, TypeScript `5.9.3`, `@ast-grep/napi@0.45.0`; 5 warmups and 30 measured in-process parse iterations. Candidate inspection is outside the timed samples. RSS is observed for the shared process, not an isolated parser peak.

| Fixture               | Normalized candidates agree | Error nodes agree | TypeScript warm median | ast-grep warm median |
| --------------------- | --------------------------: | ----------------: | ---------------------: | -------------------: |
| valid TS              |                         yes |             0 / 0 |               0.292 ms |             0.069 ms |
| valid TSX             |                         yes |             0 / 0 |               0.186 ms |             0.076 ms |
| partially invalid TSX |                         yes |             1 / 1 |               0.152 ms |             0.073 ms |
| syntax-error TSX      |                         yes |             1 / 1 |               0.013 ms |             0.010 ms |

This result demonstrates a promising parser-only candidate pass on four small fixtures. It does **not** demonstrate faster repository scans: a production hybrid would still pay TypeScript program construction and would add a second tree. It also does not establish representative peak memory, cold package-load cost, watch performance, or cross-platform installation success.

## Promotion gates

Tree-sitter or ast-grep may become an optional production observer only after all of the following are measured:

1. Representative React, Next.js, NestJS, malformed-source, monorepo, and project-reference repositories.
2. Cold one-shot scan time, warm/watch time, peak RSS in isolated processes, output/map diff, and precision/recall.
3. macOS, Linux glibc/musl, and Windows installation and package tests on supported architectures.
4. A demonstrated maintenance or performance improvement after including the still-required TypeScript semantic pass.
5. Byte-identical canonical output when the candidate layer contributes no new confirmed facts.
6. Compiler fallback coverage for missing binaries, unsupported languages, parse failures, and partial trees.

Until those gates pass, the default remains compiler-only and no Tree-sitter object enters the public IR.

## Reuse decisions in the alpha

- Commander, fast-glob, Node crypto, Vitest, tsup, and sorted JSONL remain in place.
- `@manypkg/get-packages` is behind `WorkspaceDiscovery`; selected-root and realpath containment are enforced before workspace metadata is persisted.
- `ignore` is behind `IgnoreAdapter`; discovery disables symlink following and verifies realpaths.
- Zod schemas own configuration and every persisted record type. TypeScript types are inferred from them, runtime reads/writes are validated, and checked-in Draft 2020-12 JSON Schemas are generated with `z.toJSONSchema`.
- The TypeScript semantic layer is behind `SemanticResolver`; its normalized public outputs remain Code Map records rather than compiler objects.

## Consequences

The alpha retains a reliable installation and one authoritative semantic model. It accepts that a syntax-only speedup has not yet been realized and that malformed-file recovery is currently limited by TypeScript's tolerant parser. The adapter boundary makes the experiment replaceable without rewriting framework analyzers or changing persisted artifacts.
